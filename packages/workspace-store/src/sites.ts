import { randomBytes, randomUUID } from "node:crypto";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import pg from "pg";

export type SiteVisibility = "private" | "organization" | "restricted";
export type SiteVersionState = "staging" | "ready" | "failed";
export type SiteStorageBackend = "filesystem" | "s3";

export type SiteAccessActor = {
  tenantId: string;
  subjectId: string;
  accountUserId?: string;
  isOrganizationAdministrator?: boolean;
};

export type SiteRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  handle: string;
  slug: string;
  name: string;
  state: "draft" | "ready" | "failed";
  visibility: SiteVisibility;
  currentRevision: number;
  publishedVersionId: string | null;
  creatorAccountUserId: string | null;
  sourceWorkspaceId: string;
  sourceAgentId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SiteVersionRecord = {
  id: string;
  siteId: string;
  tenantId: string;
  subjectId: string;
  version: number;
  state: SiteVersionState;
  storageBackend: SiteStorageBackend;
  storageLocator: string | null;
  stagingLocator: string | null;
  archiveSha256: string;
  archiveSizeBytes: number;
  manifestSha256: string;
  manifest: Record<string, unknown>;
  extractedSizeBytes: number;
  fileCount: number;
  sourceWorkspaceId: string;
  sourceWorkspaceGeneration: number;
  sourceAgentId: string;
  sourceProjectPath: string;
  createdByAccountUserId: string | null;
  idempotencyKeyHash: string;
  failureCode: string | null;
  createdAt: Date;
  readyAt: Date | null;
  failedAt: Date | null;
};

export type SiteGrantRecord = {
  id: string;
  siteId: string;
  granteeAccountUserId: string;
  permission: "viewer";
  grantedBy: string;
  createdAt: Date;
  revokedAt: Date | null;
};

export type SiteInvitationStatus = "pending" | "accepted" | "expired" | "revoked";
export type SiteInvitationRecord = {
  id: string;
  siteId: string;
  email: string;
  status: SiteInvitationStatus;
  deliveryGeneration: number;
  expiresAt: Date;
  acceptedAccountUserId: string | null;
  acceptedAt: Date | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

export type SitePublicationRecord = {
  site: SiteRecord;
  version: SiteVersionRecord | null;
};

export type PrepareSiteVersionInput = {
  siteId?: string;
  slug: string;
  name: string;
  sourceWorkspaceId: string;
  sourceWorkspaceGeneration: number;
  sourceAgentId: string;
  sourceProjectPath: string;
  storageBackend: SiteStorageBackend;
  archiveSha256: string;
  archiveSizeBytes: number;
  manifestSha256: string;
  manifest: Record<string, unknown>;
  extractedSizeBytes: number;
  fileCount: number;
  idempotencyKeyHash: string;
};

export interface SiteStore {
  listSites(actor: SiteAccessActor): Promise<SiteRecord[]>;
  listOwnedSites(identity: IdentityContext): Promise<SiteRecord[]>;
  prepareSiteVersion(identity: IdentityContext, input: PrepareSiteVersionInput): Promise<{ site: SiteRecord; version: SiteVersionRecord; created: boolean }>;
  setSiteVersionStagingLocator(identity: IdentityContext, siteId: string, versionId: string, locator: string): Promise<SiteVersionRecord | null>;
  finalizeSiteVersion(identity: IdentityContext, siteId: string, versionId: string, locator: string): Promise<{ site: SiteRecord; version: SiteVersionRecord } | null>;
  failSiteVersion(identity: IdentityContext, siteId: string, versionId: string, failureCode: string): Promise<void>;
  getOwnedPublication(identity: IdentityContext, siteId: string): Promise<SitePublicationRecord | null>;
  getAccessiblePublicationByHandle(actor: SiteAccessActor, handle: string, version?: number): Promise<SitePublicationRecord | null>;
  getManageableSite(actor: SiteAccessActor, siteId: string): Promise<SiteRecord | null>;
  listSiteVersions(actor: SiteAccessActor, siteId: string): Promise<SiteVersionRecord[] | null>;
  restoreSiteVersion(actor: SiteAccessActor, siteId: string, version: number): Promise<SiteRecord | null>;
  updateSiteVisibility(actor: SiteAccessActor, siteId: string, visibility: SiteVisibility): Promise<SiteRecord | null>;
  listSiteGrants(actor: SiteAccessActor, siteId: string): Promise<SiteGrantRecord[] | null>;
  grantSiteAccess(actor: SiteAccessActor, siteId: string, accountUserId: string): Promise<SiteGrantRecord | null>;
  revokeSiteAccess(actor: SiteAccessActor, siteId: string, grantId: string): Promise<boolean>;
  listSiteInvitations(actor: SiteAccessActor, siteId: string, now: Date): Promise<SiteInvitationRecord[] | null>;
  createSiteInvitation(actor: SiteAccessActor, input: { siteId: string; email: string; tokenHash: string; idempotencyKeyHash: string; expiresAt: Date; now: Date }): Promise<{ invitation: SiteInvitationRecord; replayed: boolean } | null>;
  resendSiteInvitation(actor: SiteAccessActor, input: { siteId: string; invitationId: string; tokenHash: string; expiresAt: Date; now: Date }): Promise<SiteInvitationRecord | null>;
  revokeSiteInvitation(actor: SiteAccessActor, siteId: string, invitationId: string, now: Date): Promise<SiteInvitationRecord | null>;
  acceptSiteInvitation(input: { tokenHash: string; accountUserId: string; email: string; now: Date }): Promise<{ siteId: string; handle: string } | null>;
  deleteSite(actor: SiteAccessActor, siteId: string): Promise<{ deleted: boolean; storageLocators: string[]; stagingLocators: string[] }>;
}

const mapSite = (row: Record<string, unknown>): SiteRecord => ({
  id: String(row.id), tenantId: String(row.tenant_id), subjectId: String(row.subject_id),
  handle: String(row.handle), slug: String(row.slug), name: String(row.name),
  state: String(row.state) as SiteRecord["state"],
  visibility: String(row.visibility ?? "private") as SiteVisibility, currentRevision: Number(row.current_revision),
  publishedVersionId: row.published_version_id == null ? null : String(row.published_version_id),
  creatorAccountUserId: row.creator_account_user_id == null ? null : String(row.creator_account_user_id),
  sourceWorkspaceId: String(row.source_workspace_id), sourceAgentId: String(row.source_agent_id),
  createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)),
});

const mapVersion = (row: Record<string, unknown>): SiteVersionRecord => ({
  id: String(row.version_id ?? row.id), siteId: String(row.site_id), tenantId: String(row.tenant_id), subjectId: String(row.subject_id),
  version: Number(row.version), state: String(row.version_state ?? row.state) as SiteVersionState,
  storageBackend: String(row.storage_backend) as SiteStorageBackend,
  storageLocator: row.storage_locator == null ? null : String(row.storage_locator),
  stagingLocator: row.staging_locator == null ? null : String(row.staging_locator),
  archiveSha256: String(row.archive_sha256), archiveSizeBytes: Number(row.archive_size_bytes),
  manifestSha256: String(row.manifest_sha256), manifest: (row.manifest ?? {}) as Record<string, unknown>,
  extractedSizeBytes: Number(row.extracted_size_bytes), fileCount: Number(row.file_count),
  sourceWorkspaceId: String(row.version_source_workspace_id ?? row.source_workspace_id),
  sourceWorkspaceGeneration: Number(row.source_workspace_generation),
  sourceAgentId: String(row.version_source_agent_id ?? row.source_agent_id), sourceProjectPath: String(row.source_project_path),
  createdByAccountUserId: row.created_by_account_user_id == null ? null : String(row.created_by_account_user_id),
  idempotencyKeyHash: String(row.idempotency_key_hash), failureCode: row.failure_code == null ? null : String(row.failure_code),
  createdAt: new Date(String(row.version_created_at ?? row.created_at)), readyAt: row.ready_at ? new Date(String(row.ready_at)) : null,
  failedAt: row.failed_at ? new Date(String(row.failed_at)) : null,
});

const mapGrant = (row: Record<string, unknown>): SiteGrantRecord => ({
  id: String(row.id), siteId: String(row.site_id), granteeAccountUserId: String(row.grantee_account_user_id), permission: "viewer",
  grantedBy: String(row.granted_by), createdAt: new Date(String(row.created_at)), revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
});

const mapInvitation = (row: Record<string, unknown>): SiteInvitationRecord => ({
  id: String(row.id), siteId: String(row.site_id), email: String(row.email), status: String(row.status) as SiteInvitationStatus,
  deliveryGeneration: Number(row.delivery_generation), expiresAt: new Date(String(row.expires_at)),
  acceptedAccountUserId: row.accepted_account_user_id ? String(row.accepted_account_user_id) : null,
  acceptedAt: row.accepted_at ? new Date(String(row.accepted_at)) : null, createdBy: String(row.created_by), updatedBy: String(row.updated_by),
  createdAt: new Date(String(row.created_at)), updatedAt: new Date(String(row.updated_at)), revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
});

const siteSelect = `SELECT id,tenant_id,subject_id,handle,slug,name,state,visibility,current_revision,
  published_version_id,creator_account_user_id,source_workspace_id,source_agent_id,created_at,updated_at FROM sites`;
const versionSelect = `SELECT id AS version_id,tenant_id,subject_id,site_id,version,state AS version_state,
  storage_backend,storage_locator,staging_locator,archive_sha256,archive_size_bytes,manifest_sha256,manifest,
  extracted_size_bytes,file_count,source_workspace_id AS version_source_workspace_id,source_workspace_generation,
  source_agent_id AS version_source_agent_id,source_project_path,created_by_account_user_id,idempotency_key_hash,
  failure_code,created_at AS version_created_at,ready_at,failed_at FROM site_versions`;
const manageableSql = (alias = "s") => `(${alias}.tenant_id=$1 AND (${alias}.subject_id=$2 OR $3::boolean))`;
const accessibleSql = (alias = "s") => `(
  (${alias}.tenant_id=$1 AND ${alias}.subject_id=$2)
  OR (${alias}.tenant_id=$1 AND ${alias}.visibility='organization')
  OR (${alias}.tenant_id=$1 AND $4::boolean)
  OR ($3::uuid IS NOT NULL AND EXISTS (
    SELECT 1 FROM site_grants g WHERE g.tenant_id=${alias}.tenant_id AND g.subject_id=${alias}.subject_id
      AND g.site_id=${alias}.id AND g.grantee_account_user_id=$3::uuid AND g.revoked_at IS NULL
  )))`;
const actorValues = (actor: SiteAccessActor) => [actor.tenantId, actor.subjectId, actor.accountUserId ?? null, actor.isOrganizationAdministrator === true];
const siteHandle = () => randomBytes(18).toString("base64url");

export class PostgresSiteStore implements SiteStore {
  constructor(private readonly pool: pg.Pool) {}
  static fromConnectionString(connectionString: string) { return new PostgresSiteStore(new pg.Pool({ connectionString, max: 5 })); }
  async close() { await this.pool.end(); }

  async listSites(actor: SiteAccessActor) {
    const result = await this.pool.query(`${siteSelect} s WHERE s.deleted_at IS NULL AND ${accessibleSql("s")} ORDER BY s.updated_at DESC,s.id`, actorValues(actor));
    return result.rows.map(mapSite);
  }

  async listOwnedSites(identity: IdentityContext) {
    const result = await this.pool.query(`${siteSelect} WHERE tenant_id=$1 AND subject_id=$2 AND deleted_at IS NULL ORDER BY updated_at DESC,id`, [identity.tenantId, identity.subjectId]);
    return result.rows.map(mapSite);
  }

  async prepareSiteVersion(identity: IdentityContext, input: PrepareSiteVersionInput) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let siteRow: Record<string, unknown> | undefined;
      let replay: Record<string, unknown> | undefined;
      if (input.siteId) {
        const selected = await client.query(`${siteSelect} WHERE id=$3 AND tenant_id=$1 AND subject_id=$2 AND deleted_at IS NULL FOR UPDATE`, [identity.tenantId, identity.subjectId, input.siteId]);
        siteRow = selected.rows[0];
        if (!siteRow) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
        if (String(siteRow.source_workspace_id) !== input.sourceWorkspaceId) throw new LemmaComputerError("SITE_SOURCE_WORKSPACE_MISMATCH", "This site must be edited from its recorded source workspace", 409);
        const latestSource = await client.query(`SELECT source_project_path FROM site_versions WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND state='ready' ORDER BY version DESC LIMIT 1`, [identity.tenantId, identity.subjectId, input.siteId]);
        if (latestSource.rowCount && String(latestSource.rows[0].source_project_path) !== input.sourceProjectPath) throw new LemmaComputerError("SITE_SOURCE_PROJECT_MISMATCH", "This site must be edited from its recorded source project", 409);
        const replayed = await client.query(`${versionSelect} WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND idempotency_key_hash=$4`, [identity.tenantId, identity.subjectId, input.siteId, input.idempotencyKeyHash]);
        replay = replayed.rows[0];
      } else {
        const existing = await client.query(`${siteSelect} WHERE tenant_id=$1 AND subject_id=$2 AND slug=$3 AND deleted_at IS NULL FOR UPDATE`, [identity.tenantId, identity.subjectId, input.slug]);
        if (existing.rowCount) {
          siteRow = existing.rows[0];
          const replayed = await client.query(`${versionSelect} WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND idempotency_key_hash=$4`, [identity.tenantId, identity.subjectId, String(siteRow!.id), input.idempotencyKeyHash]);
          replay = replayed.rows[0];
          if (!replay) throw new LemmaComputerError("SITE_SLUG_EXISTS", "A site with this slug already exists; use its project binding to republish", 409);
        }
      }
      if (siteRow && replay) { await client.query("COMMIT"); return { site: mapSite(siteRow), version: mapVersion(replay), created: false }; }
      const account = await client.query("SELECT account_user_id FROM users WHERE tenant_id=$1 AND id=$2", [identity.tenantId, identity.subjectId]);
      const creatorAccountUserId = account.rows[0]?.account_user_id ?? null;
      if (!siteRow) {
        for (let attempt = 0; attempt < 4 && !siteRow; attempt += 1) {
          const created = await client.query(
            `INSERT INTO sites (id,tenant_id,subject_id,handle,slug,name,state,visibility,current_revision,published_version_id,creator_account_user_id,source_workspace_id,source_agent_id,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,'draft','private',0,NULL,$7,$8,$9,now(),now())
             ON CONFLICT (handle) DO NOTHING RETURNING *`,
            [randomUUID(), identity.tenantId, identity.subjectId, siteHandle(), input.slug, input.name, creatorAccountUserId, input.sourceWorkspaceId, input.sourceAgentId],
          );
          siteRow = created.rows[0];
        }
        if (!siteRow) throw new Error("Could not allocate an opaque site handle");
      } else {
        const updated = await client.query(`UPDATE sites SET name=$4,slug=$5,source_workspace_id=$6,source_agent_id=$7,updated_at=now() WHERE id=$3 AND tenant_id=$1 AND subject_id=$2 RETURNING *`, [identity.tenantId, identity.subjectId, siteRow.id, input.name, input.slug, input.sourceWorkspaceId, input.sourceAgentId]);
        siteRow = updated.rows[0];
      }
      if (!siteRow) throw new Error("Site allocation failed");
      const readySiteRow = siteRow;
      const next = await client.query<{ version: number }>("SELECT COALESCE(MAX(version),0)+1 AS version FROM site_versions WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3", [identity.tenantId, identity.subjectId, readySiteRow.id]);
      const inserted = await client.query(
        `INSERT INTO site_versions (id,tenant_id,subject_id,site_id,version,state,storage_backend,archive_sha256,archive_size_bytes,manifest_sha256,manifest,extracted_size_bytes,file_count,source_workspace_id,source_workspace_generation,source_agent_id,source_project_path,created_by_account_user_id,idempotency_key_hash,created_at)
         VALUES ($1,$2,$3,$4,$5,'staging',$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,now())
         RETURNING *,id AS version_id,state AS version_state,source_workspace_id AS version_source_workspace_id,source_agent_id AS version_source_agent_id,created_at AS version_created_at`,
        [randomUUID(), identity.tenantId, identity.subjectId, readySiteRow.id, Number(next.rows[0]?.version ?? 1), input.storageBackend, input.archiveSha256, input.archiveSizeBytes, input.manifestSha256, JSON.stringify(input.manifest), input.extractedSizeBytes, input.fileCount, input.sourceWorkspaceId, input.sourceWorkspaceGeneration, input.sourceAgentId, input.sourceProjectPath, creatorAccountUserId, input.idempotencyKeyHash],
      );
      await client.query("COMMIT");
      if (!inserted.rows[0]) throw new Error("Site version allocation failed");
      return { site: mapSite(readySiteRow), version: mapVersion(inserted.rows[0]), created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new LemmaComputerError("SITE_SLUG_EXISTS", "A site with this slug already exists; use its project binding to republish", 409);
      throw error;
    } finally { client.release(); }
  }

  async setSiteVersionStagingLocator(identity: IdentityContext, siteId: string, versionId: string, locator: string) {
    const result = await this.pool.query(`UPDATE site_versions SET staging_locator=$5 WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND id=$4 AND state='staging' RETURNING *,id AS version_id,state AS version_state,source_workspace_id AS version_source_workspace_id,source_agent_id AS version_source_agent_id,created_at AS version_created_at`, [identity.tenantId, identity.subjectId, siteId, versionId, locator]);
    return result.rowCount ? mapVersion(result.rows[0]) : null;
  }

  async finalizeSiteVersion(identity: IdentityContext, siteId: string, versionId: string, locator: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ready = await client.query(`UPDATE site_versions SET state='ready',storage_locator=$5,staging_locator=NULL,ready_at=now(),failure_code=NULL,failed_at=NULL WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND id=$4 AND state='staging' RETURNING *,id AS version_id,state AS version_state,source_workspace_id AS version_source_workspace_id,source_agent_id AS version_source_agent_id,created_at AS version_created_at`, [identity.tenantId, identity.subjectId, siteId, versionId, locator]);
      if (!ready.rowCount) { await client.query("ROLLBACK"); return null; }
      const version = mapVersion(ready.rows[0]);
      const updated = await client.query(`UPDATE sites SET published_version_id=$4,current_revision=$5,state='ready',source_workspace_id=$6,source_agent_id=$7,updated_at=now() WHERE tenant_id=$1 AND subject_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING *`, [identity.tenantId, identity.subjectId, siteId, versionId, version.version, version.sourceWorkspaceId, version.sourceAgentId]);
      if (!updated.rowCount) throw new Error("Site disappeared while finalizing a publication");
      await client.query("COMMIT");
      return { site: mapSite(updated.rows[0]), version };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async failSiteVersion(identity: IdentityContext, siteId: string, versionId: string, failureCode: string) {
    await this.pool.query(`UPDATE site_versions SET state='failed',failure_code=$5,failed_at=now() WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND id=$4 AND state='staging'`, [identity.tenantId, identity.subjectId, siteId, versionId, failureCode]);
    await this.pool.query(`UPDATE sites SET state='failed',updated_at=now() WHERE tenant_id=$1 AND subject_id=$2 AND id=$3 AND published_version_id IS NULL`, [identity.tenantId, identity.subjectId, siteId]);
  }

  private async publicationFromSiteRow(siteRow: Record<string, unknown>): Promise<SitePublicationRecord> {
    const site = mapSite(siteRow);
    if (!site.publishedVersionId) return { site, version: null };
    const version = await this.pool.query(`${versionSelect} WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND id=$4 AND state='ready'`, [site.tenantId, site.subjectId, site.id, site.publishedVersionId]);
    return { site, version: version.rowCount ? mapVersion(version.rows[0]) : null };
  }

  async getOwnedPublication(identity: IdentityContext, siteId: string) {
    const result = await this.pool.query(`${siteSelect} WHERE tenant_id=$1 AND subject_id=$2 AND id=$3 AND deleted_at IS NULL`, [identity.tenantId, identity.subjectId, siteId]);
    return result.rowCount ? this.publicationFromSiteRow(result.rows[0]) : null;
  }

  async getAccessiblePublicationByHandle(actor: SiteAccessActor, handle: string, version?: number) {
    const selected = await this.pool.query(`${siteSelect} s WHERE s.handle=$5 AND s.deleted_at IS NULL AND ${accessibleSql("s")}`, [...actorValues(actor), handle]);
    if (!selected.rowCount) return null;
    const site = mapSite(selected.rows[0]);
    if (version === undefined) return this.publicationFromSiteRow(selected.rows[0]);
    const result = await this.pool.query(`${versionSelect} WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND version=$4 AND state='ready'`, [site.tenantId, site.subjectId, site.id, version]);
    return result.rowCount ? { site, version: mapVersion(result.rows[0]) } : null;
  }

  async getManageableSite(actor: SiteAccessActor, siteId: string) {
    const result = await this.pool.query(`${siteSelect} s WHERE s.id=$4 AND s.deleted_at IS NULL AND ${manageableSql("s")}`, [actor.tenantId, actor.subjectId, actor.isOrganizationAdministrator === true, siteId]);
    return result.rowCount ? mapSite(result.rows[0]) : null;
  }

  async listSiteVersions(actor: SiteAccessActor, siteId: string) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return null;
    const result = await this.pool.query(`${versionSelect} WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 ORDER BY version DESC`, [site.tenantId, site.subjectId, siteId]);
    return result.rows.map(mapVersion);
  }

  async restoreSiteVersion(actor: SiteAccessActor, siteId: string, versionNumber: number) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return null;
    const result = await this.pool.query(
      `UPDATE sites s SET published_version_id=v.id,current_revision=v.version,source_workspace_id=v.source_workspace_id,source_agent_id=v.source_agent_id,updated_at=now()
       FROM site_versions v WHERE s.id=$3 AND s.tenant_id=$1 AND s.subject_id=$2 AND s.deleted_at IS NULL
         AND v.tenant_id=s.tenant_id AND v.subject_id=s.subject_id AND v.site_id=s.id AND v.version=$4 AND v.state='ready' RETURNING s.*`,
      [site.tenantId, site.subjectId, siteId, versionNumber],
    );
    return result.rowCount ? mapSite(result.rows[0]) : null;
  }

  async updateSiteVisibility(actor: SiteAccessActor, siteId: string, visibility: SiteVisibility) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return null;
    const result = await this.pool.query("UPDATE sites SET visibility=$4,updated_at=now() WHERE tenant_id=$1 AND subject_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING *", [site.tenantId, site.subjectId, siteId, visibility]);
    return result.rowCount ? mapSite(result.rows[0]) : null;
  }

  async listSiteGrants(actor: SiteAccessActor, siteId: string) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return null;
    const result = await this.pool.query("SELECT * FROM site_grants WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 ORDER BY created_at,id", [site.tenantId, site.subjectId, siteId]);
    return result.rows.map(mapGrant);
  }

  async grantSiteAccess(actor: SiteAccessActor, siteId: string, accountUserId: string) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return null;
    const result = await this.pool.query(
      `INSERT INTO site_grants (id,tenant_id,subject_id,site_id,grantee_account_user_id,permission,granted_by,created_at)
       SELECT $4,$1,$2,$3,account.id,'viewer',$6,now() FROM account_users account WHERE account.id=$5 AND account.status='active'
       ON CONFLICT (tenant_id,subject_id,site_id,grantee_account_user_id) DO UPDATE SET permission='viewer',granted_by=EXCLUDED.granted_by,created_at=now(),revoked_at=NULL,revoked_by=NULL RETURNING *`,
      [site.tenantId, site.subjectId, siteId, randomUUID(), accountUserId, actor.subjectId],
    );
    return result.rowCount ? mapGrant(result.rows[0]) : null;
  }

  async revokeSiteAccess(actor: SiteAccessActor, siteId: string, grantId: string) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return false;
    const result = await this.pool.query(`UPDATE site_grants SET revoked_at=now(),revoked_by=$5 WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND id=$4 AND revoked_at IS NULL RETURNING id`, [site.tenantId, site.subjectId, siteId, grantId, actor.subjectId]);
    return Boolean(result.rowCount);
  }

  async listSiteInvitations(actor: SiteAccessActor, siteId: string, now: Date) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query(
        `UPDATE site_invitations SET status='expired',updated_at=$4,updated_by='system'
         WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND status='pending' AND expires_at<=$4 RETURNING *`,
        [site.tenantId, site.subjectId, siteId, now],
      );
      for (const row of expired.rows) {
        await client.query(
          `INSERT INTO site_invitation_audit_events (id,tenant_id,subject_id,site_id,invitation_id,event_type,actor_user_id,delivery_generation,occurred_at)
           VALUES ($1,$2,$3,$4,$5,'invitation.expired',NULL,$6,$7)`,
          [randomUUID(), site.tenantId, site.subjectId, siteId, row.id, row.delivery_generation, now],
        );
      }
      const result = await client.query("SELECT * FROM site_invitations WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 ORDER BY created_at DESC,id", [site.tenantId, site.subjectId, siteId]);
      await client.query("COMMIT");
      return result.rows.map(mapInvitation);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async createSiteInvitation(actor: SiteAccessActor, input: { siteId: string; email: string; tokenHash: string; idempotencyKeyHash: string; expiresAt: Date; now: Date }) {
    const site = await this.getManageableSite(actor, input.siteId);
    if (!site) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await client.query("SELECT * FROM site_invitations WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND idempotency_key_hash=$4 FOR UPDATE", [site.tenantId, site.subjectId, site.id, input.idempotencyKeyHash]);
      if (replay.rowCount) { await client.query("COMMIT"); return { invitation: mapInvitation(replay.rows[0]), replayed: true }; }
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO site_invitations (id,tenant_id,subject_id,site_id,email,token_hash,idempotency_key_hash,status,delivery_generation,expires_at,created_by,updated_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',1,$8,$9,$9,$10,$10) RETURNING *`,
        [id, site.tenantId, site.subjectId, site.id, input.email, input.tokenHash, input.idempotencyKeyHash, input.expiresAt, actor.subjectId, input.now],
      );
      await client.query(`INSERT INTO site_invitation_audit_events (id,tenant_id,subject_id,site_id,invitation_id,event_type,actor_user_id,delivery_generation,occurred_at) VALUES ($1,$2,$3,$4,$5,'invitation.created',$6,1,$7)`, [randomUUID(), site.tenantId, site.subjectId, site.id, id, actor.subjectId, input.now]);
      await client.query("COMMIT");
      return { invitation: mapInvitation(inserted.rows[0]), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new LemmaComputerError("SITE_INVITATION_EXISTS", "A pending invitation already exists for this email", 409);
      throw error;
    } finally { client.release(); }
  }

  async resendSiteInvitation(actor: SiteAccessActor, input: { siteId: string; invitationId: string; tokenHash: string; expiresAt: Date; now: Date }) {
    const site = await this.getManageableSite(actor, input.siteId);
    if (!site) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE site_invitations SET token_hash=$5,delivery_generation=delivery_generation+1,expires_at=$6,status='pending',accepted_account_user_id=NULL,accepted_at=NULL,revoked_at=NULL,updated_by=$7,updated_at=$8
         WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND id=$4 AND status='pending' RETURNING *`,
        [site.tenantId, site.subjectId, site.id, input.invitationId, input.tokenHash, input.expiresAt, actor.subjectId, input.now],
      );
      if (!updated.rowCount) { await client.query("ROLLBACK"); return null; }
      await client.query(`INSERT INTO site_invitation_audit_events (id,tenant_id,subject_id,site_id,invitation_id,event_type,actor_user_id,delivery_generation,occurred_at) VALUES ($1,$2,$3,$4,$5,'invitation.resent',$6,$7,$8)`, [randomUUID(), site.tenantId, site.subjectId, site.id, input.invitationId, actor.subjectId, updated.rows[0].delivery_generation, input.now]);
      await client.query("COMMIT");
      return mapInvitation(updated.rows[0]);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async revokeSiteInvitation(actor: SiteAccessActor, siteId: string, invitationId: string, now: Date) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(`UPDATE site_invitations SET status='revoked',revoked_at=$5,updated_at=$5,updated_by=$6 WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3 AND id=$4 AND status='pending' RETURNING *`, [site.tenantId, site.subjectId, siteId, invitationId, now, actor.subjectId]);
      if (!updated.rowCount) { await client.query("ROLLBACK"); return null; }
      await client.query(`INSERT INTO site_invitation_audit_events (id,tenant_id,subject_id,site_id,invitation_id,event_type,actor_user_id,delivery_generation,occurred_at) VALUES ($1,$2,$3,$4,$5,'invitation.revoked',$6,$7,$8)`, [randomUUID(), site.tenantId, site.subjectId, siteId, invitationId, actor.subjectId, updated.rows[0].delivery_generation, now]);
      await client.query("COMMIT");
      return mapInvitation(updated.rows[0]);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async acceptSiteInvitation(input: { tokenHash: string; accountUserId: string; email: string; now: Date }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT invitation.*,site.handle FROM site_invitations invitation
         JOIN sites site ON site.id=invitation.site_id AND site.tenant_id=invitation.tenant_id AND site.subject_id=invitation.subject_id
         JOIN account_users account ON account.id=$2 AND account.status='active'
         WHERE invitation.token_hash=$1 AND site.deleted_at IS NULL FOR UPDATE OF invitation`,
        [input.tokenHash, input.accountUserId],
      );
      const row = selected.rows[0];
      if (!row || row.status !== "pending" || new Date(String(row.expires_at)) <= input.now || String(row.email) !== input.email) {
        if (row?.status === "pending" && new Date(String(row.expires_at)) <= input.now) {
          await client.query("UPDATE site_invitations SET status='expired',updated_at=$2,updated_by='system' WHERE id=$1", [row.id, input.now]);
          await client.query(
            `INSERT INTO site_invitation_audit_events (id,tenant_id,subject_id,site_id,invitation_id,event_type,actor_user_id,delivery_generation,occurred_at)
             VALUES ($1,$2,$3,$4,$5,'invitation.expired',NULL,$6,$7)`,
            [randomUUID(), row.tenant_id, row.subject_id, row.site_id, row.id, row.delivery_generation, input.now],
          );
        }
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `INSERT INTO site_grants (id,tenant_id,subject_id,site_id,grantee_account_user_id,permission,granted_by,created_at)
         VALUES ($1,$2,$3,$4,$5,'viewer',$6,$7)
         ON CONFLICT (tenant_id,subject_id,site_id,grantee_account_user_id) DO UPDATE SET permission='viewer',granted_by=EXCLUDED.granted_by,created_at=EXCLUDED.created_at,revoked_at=NULL,revoked_by=NULL`,
        [randomUUID(), row.tenant_id, row.subject_id, row.site_id, input.accountUserId, row.created_by, input.now],
      );
      await client.query(`UPDATE site_invitations SET status='accepted',accepted_account_user_id=$2::uuid,accepted_at=$3,updated_at=$3,updated_by=($2::uuid)::text WHERE id=$1`, [row.id, input.accountUserId, input.now]);
      await client.query(`INSERT INTO site_invitation_audit_events (id,tenant_id,subject_id,site_id,invitation_id,event_type,actor_user_id,delivery_generation,occurred_at) VALUES ($1,$2,$3,$4,$5,'invitation.accepted',$6,$7,$8)`, [randomUUID(), row.tenant_id, row.subject_id, row.site_id, row.id, input.accountUserId, row.delivery_generation, input.now]);
      await client.query("COMMIT");
      return { siteId: String(row.site_id), handle: String(row.handle) };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async deleteSite(actor: SiteAccessActor, siteId: string) {
    const site = await this.getManageableSite(actor, siteId);
    if (!site) return { deleted: false, storageLocators: [], stagingLocators: [] };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locators = await client.query("SELECT storage_locator,staging_locator FROM site_versions WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3", [site.tenantId, site.subjectId, siteId]);
      const removed = await client.query("DELETE FROM sites WHERE tenant_id=$1 AND subject_id=$2 AND id=$3 RETURNING id", [site.tenantId, site.subjectId, siteId]);
      await client.query("COMMIT");
      return {
        deleted: Boolean(removed.rowCount),
        storageLocators: locators.rows.flatMap((row) => row.storage_locator ? [String(row.storage_locator)] : []),
        stagingLocators: locators.rows.flatMap((row) => row.staging_locator ? [String(row.staging_locator)] : []),
      };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

}

const manageable = (actor: SiteAccessActor, site: SiteRecord) => site.tenantId === actor.tenantId
  && (site.subjectId === actor.subjectId || actor.isOrganizationAdministrator === true);
const accessible = (actor: SiteAccessActor, site: SiteRecord, grants: SiteGrantRecord[]) => manageable(actor, site)
  || (site.tenantId === actor.tenantId && site.visibility === "organization")
  || Boolean(actor.accountUserId && grants.some((grant) => grant.granteeAccountUserId === actor.accountUserId && !grant.revokedAt));

type MemoryInvitation = SiteInvitationRecord & { tokenHash: string; idempotencyKeyHash: string };

export class MemorySiteStore implements SiteStore {
  private readonly sites = new Map<string, SiteRecord>();
  private readonly versions = new Map<string, SiteVersionRecord[]>();
  private readonly grants = new Map<string, SiteGrantRecord[]>();
  private readonly invitations = new Map<string, MemoryInvitation[]>();

  async listSites(actor: SiteAccessActor) {
    return [...this.sites.values()].filter((site) => accessible(actor, site, this.grants.get(site.id) ?? []))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }
  async listOwnedSites(identity: IdentityContext) {
    return [...this.sites.values()].filter((site) => site.tenantId === identity.tenantId && site.subjectId === identity.subjectId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  async prepareSiteVersion(identity: IdentityContext, input: PrepareSiteVersionInput) {
    let site = input.siteId ? this.sites.get(input.siteId) : [...this.sites.values()].find((candidate) => candidate.tenantId === identity.tenantId && candidate.subjectId === identity.subjectId && candidate.slug === input.slug);
    if (site && (site.tenantId !== identity.tenantId || site.subjectId !== identity.subjectId)) site = undefined;
    if (input.siteId && !site) throw new LemmaComputerError("SITE_NOT_FOUND", "Site not found", 404);
    if (site) {
      const replay = this.versions.get(site.id)?.find((version) => version.idempotencyKeyHash === input.idempotencyKeyHash);
      if (replay) return { site, version: replay, created: false };
      if (!input.siteId) throw new LemmaComputerError("SITE_SLUG_EXISTS", "A site with this slug already exists; use its project binding to republish", 409);
      if (site.sourceWorkspaceId !== input.sourceWorkspaceId) throw new LemmaComputerError("SITE_SOURCE_WORKSPACE_MISMATCH", "This site must be edited from its recorded source workspace", 409);
      const latestSource = this.versions.get(site.id)?.filter((version) => version.state === "ready").at(-1);
      if (latestSource && latestSource.sourceProjectPath !== input.sourceProjectPath) throw new LemmaComputerError("SITE_SOURCE_PROJECT_MISMATCH", "This site must be edited from its recorded source project", 409);
    }
    const now = new Date();
    site = {
      id: site?.id ?? randomUUID(), tenantId: identity.tenantId, subjectId: identity.subjectId,
      handle: site?.handle ?? siteHandle(), slug: input.slug, name: input.name, state: site?.state ?? "draft",
      visibility: site?.visibility ?? "private", currentRevision: site?.currentRevision ?? 0,
      publishedVersionId: site?.publishedVersionId ?? null, creatorAccountUserId: site?.creatorAccountUserId ?? null,
      sourceWorkspaceId: input.sourceWorkspaceId, sourceAgentId: input.sourceAgentId,
      createdAt: site?.createdAt ?? now, updatedAt: site?.updatedAt ?? now,
    };
    const currentVersions = this.versions.get(site.id) ?? [];
    const version: SiteVersionRecord = {
      id: randomUUID(), siteId: site.id, tenantId: site.tenantId, subjectId: site.subjectId,
      version: Math.max(0, ...currentVersions.map((item) => item.version)) + 1, state: "staging",
      storageBackend: input.storageBackend, storageLocator: null, stagingLocator: null,
      archiveSha256: input.archiveSha256, archiveSizeBytes: input.archiveSizeBytes,
      manifestSha256: input.manifestSha256, manifest: structuredClone(input.manifest),
      extractedSizeBytes: input.extractedSizeBytes, fileCount: input.fileCount,
      sourceWorkspaceId: input.sourceWorkspaceId, sourceWorkspaceGeneration: input.sourceWorkspaceGeneration,
      sourceAgentId: input.sourceAgentId, sourceProjectPath: input.sourceProjectPath,
      createdByAccountUserId: null, idempotencyKeyHash: input.idempotencyKeyHash,
      failureCode: null, createdAt: now, readyAt: null, failedAt: null,
    };
    this.sites.set(site.id, site); this.versions.set(site.id, [...currentVersions, version]);
    return { site, version, created: true };
  }

  private ownedVersion(identity: IdentityContext, siteId: string, versionId: string) {
    const site = this.sites.get(siteId);
    if (!site || site.tenantId !== identity.tenantId || site.subjectId !== identity.subjectId) return null;
    return this.versions.get(siteId)?.find((version) => version.id === versionId) ?? null;
  }
  async setSiteVersionStagingLocator(identity: IdentityContext, siteId: string, versionId: string, locator: string) {
    const version = this.ownedVersion(identity, siteId, versionId);
    if (!version || version.state !== "staging") return null;
    version.stagingLocator = locator; return version;
  }
  async finalizeSiteVersion(identity: IdentityContext, siteId: string, versionId: string, locator: string) {
    const version = this.ownedVersion(identity, siteId, versionId);
    const site = this.sites.get(siteId);
    if (!version || !site || version.state !== "staging") return null;
    version.state = "ready"; version.storageLocator = locator; version.stagingLocator = null; version.readyAt = new Date();
    site.state = "ready"; site.publishedVersionId = version.id; site.currentRevision = version.version;
    site.sourceWorkspaceId = version.sourceWorkspaceId; site.sourceAgentId = version.sourceAgentId; site.updatedAt = new Date();
    return { site, version };
  }
  async failSiteVersion(identity: IdentityContext, siteId: string, versionId: string, failureCode: string) {
    const version = this.ownedVersion(identity, siteId, versionId);
    if (version?.state === "staging") { version.state = "failed"; version.failureCode = failureCode; version.failedAt = new Date(); }
    const site = this.sites.get(siteId);
    if (site && !site.publishedVersionId) site.state = "failed";
  }

  private publication(site: SiteRecord): SitePublicationRecord {
    const version = this.versions.get(site.id)?.find((item) => item.id === site.publishedVersionId) ?? null;
    return { site, version };
  }
  async getOwnedPublication(identity: IdentityContext, siteId: string) {
    const site = this.sites.get(siteId);
    return site && site.tenantId === identity.tenantId && site.subjectId === identity.subjectId ? this.publication(site) : null;
  }
  async getAccessiblePublicationByHandle(actor: SiteAccessActor, handle: string, versionNumber?: number) {
    const site = [...this.sites.values()].find((candidate) => candidate.handle === handle);
    if (!site || !accessible(actor, site, this.grants.get(site.id) ?? [])) return null;
    if (versionNumber === undefined) return this.publication(site);
    const version = this.versions.get(site.id)?.find((item) => item.version === versionNumber && item.state === "ready") ?? null;
    return version ? { site, version } : null;
  }
  async getManageableSite(actor: SiteAccessActor, siteId: string) {
    const site = this.sites.get(siteId); return site && manageable(actor, site) ? site : null;
  }
  async listSiteVersions(actor: SiteAccessActor, siteId: string) {
    return await this.getManageableSite(actor, siteId) ? [...(this.versions.get(siteId) ?? [])].sort((left, right) => right.version - left.version) : null;
  }
  async restoreSiteVersion(actor: SiteAccessActor, siteId: string, versionNumber: number) {
    const site = await this.getManageableSite(actor, siteId);
    const version = this.versions.get(siteId)?.find((item) => item.version === versionNumber && item.state === "ready");
    if (!site || !version) return null;
    site.publishedVersionId = version.id; site.currentRevision = version.version;
    site.sourceWorkspaceId = version.sourceWorkspaceId; site.sourceAgentId = version.sourceAgentId; site.updatedAt = new Date(); return site;
  }
  async updateSiteVisibility(actor: SiteAccessActor, siteId: string, visibility: SiteVisibility) {
    const site = await this.getManageableSite(actor, siteId); if (!site) return null;
    site.visibility = visibility; site.updatedAt = new Date(); return site;
  }

  async listSiteGrants(actor: SiteAccessActor, siteId: string) {
    return await this.getManageableSite(actor, siteId) ? [...(this.grants.get(siteId) ?? [])] : null;
  }
  async grantSiteAccess(actor: SiteAccessActor, siteId: string, accountUserId: string) {
    if (!await this.getManageableSite(actor, siteId)) return null;
    const current = this.grants.get(siteId) ?? [];
    let grant = current.find((item) => item.granteeAccountUserId === accountUserId);
    if (grant) { grant.revokedAt = null; grant.grantedBy = actor.subjectId; grant.createdAt = new Date(); }
    else { grant = { id: randomUUID(), siteId, granteeAccountUserId: accountUserId, permission: "viewer", grantedBy: actor.subjectId, createdAt: new Date(), revokedAt: null }; current.push(grant); this.grants.set(siteId, current); }
    return grant;
  }
  async revokeSiteAccess(actor: SiteAccessActor, siteId: string, grantId: string) {
    if (!await this.getManageableSite(actor, siteId)) return false;
    const grant = this.grants.get(siteId)?.find((item) => item.id === grantId && !item.revokedAt);
    if (!grant) return false; grant.revokedAt = new Date(); return true;
  }

  async listSiteInvitations(actor: SiteAccessActor, siteId: string, now: Date) {
    if (!await this.getManageableSite(actor, siteId)) return null;
    for (const invitation of this.invitations.get(siteId) ?? []) if (invitation.status === "pending" && invitation.expiresAt <= now) { invitation.status = "expired"; invitation.updatedAt = now; }
    return [...(this.invitations.get(siteId) ?? [])];
  }
  async createSiteInvitation(actor: SiteAccessActor, input: { siteId: string; email: string; tokenHash: string; idempotencyKeyHash: string; expiresAt: Date; now: Date }) {
    if (!await this.getManageableSite(actor, input.siteId)) return null;
    const current = this.invitations.get(input.siteId) ?? [];
    const replay = current.find((item) => item.idempotencyKeyHash === input.idempotencyKeyHash);
    if (replay) return { invitation: replay, replayed: true };
    if (current.some((item) => item.email === input.email && item.status === "pending")) throw new LemmaComputerError("SITE_INVITATION_EXISTS", "A pending invitation already exists for this email", 409);
    const invitation: MemoryInvitation = {
      id: randomUUID(), siteId: input.siteId, email: input.email, tokenHash: input.tokenHash, idempotencyKeyHash: input.idempotencyKeyHash,
      status: "pending", deliveryGeneration: 1, expiresAt: input.expiresAt, acceptedAccountUserId: null, acceptedAt: null,
      createdBy: actor.subjectId, updatedBy: actor.subjectId, createdAt: input.now, updatedAt: input.now, revokedAt: null,
    };
    current.push(invitation); this.invitations.set(input.siteId, current); return { invitation, replayed: false };
  }
  async resendSiteInvitation(actor: SiteAccessActor, input: { siteId: string; invitationId: string; tokenHash: string; expiresAt: Date; now: Date }) {
    if (!await this.getManageableSite(actor, input.siteId)) return null;
    const invitation = this.invitations.get(input.siteId)?.find((item) => item.id === input.invitationId && item.status === "pending");
    if (!invitation) return null;
    invitation.tokenHash = input.tokenHash; invitation.deliveryGeneration += 1; invitation.expiresAt = input.expiresAt;
      invitation.status = "pending"; invitation.acceptedAccountUserId = null; invitation.acceptedAt = null; invitation.revokedAt = null;
      invitation.updatedAt = input.now; invitation.updatedBy = actor.subjectId; return invitation;
  }
  async revokeSiteInvitation(actor: SiteAccessActor, siteId: string, invitationId: string, now: Date) {
    if (!await this.getManageableSite(actor, siteId)) return null;
    const invitation = this.invitations.get(siteId)?.find((item) => item.id === invitationId && item.status === "pending");
    if (!invitation) return null;
    invitation.status = "revoked"; invitation.revokedAt = now; invitation.updatedAt = now; invitation.updatedBy = actor.subjectId; return invitation;
  }
  async acceptSiteInvitation(input: { tokenHash: string; accountUserId: string; email: string; now: Date }) {
    for (const [siteId, invitations] of this.invitations) {
      const invitation = invitations.find((item) => item.tokenHash === input.tokenHash);
      const site = this.sites.get(siteId);
      if (!invitation || !site || invitation.status !== "pending" || invitation.expiresAt <= input.now || invitation.email !== input.email) continue;
      await this.grantSiteAccess({ tenantId: site.tenantId, subjectId: site.subjectId }, siteId, input.accountUserId);
      invitation.status = "accepted"; invitation.acceptedAccountUserId = input.accountUserId; invitation.acceptedAt = input.now;
      invitation.updatedAt = input.now; invitation.updatedBy = input.accountUserId; return { siteId, handle: site.handle! };
    }
    return null;
  }

  async deleteSite(actor: SiteAccessActor, siteId: string) {
    if (!await this.getManageableSite(actor, siteId)) return { deleted: false, storageLocators: [], stagingLocators: [] };
    const storageLocators = (this.versions.get(siteId) ?? []).flatMap((version) => version.storageLocator ? [version.storageLocator] : []);
    const stagingLocators = (this.versions.get(siteId) ?? []).flatMap((version) => version.stagingLocator ? [version.stagingLocator] : []);
    this.sites.delete(siteId); this.versions.delete(siteId); this.grants.delete(siteId); this.invitations.delete(siteId);
    return { deleted: true, storageLocators, stagingLocators };
  }
}
