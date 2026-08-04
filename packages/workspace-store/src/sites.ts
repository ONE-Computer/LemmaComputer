import { randomUUID } from "node:crypto";
import type { IdentityContext } from "@lemmacomputer/contracts";
import pg from "pg";

export type SiteRecord = {
  id: string;
  tenantId: string;
  subjectId: string;
  slug: string;
  name: string;
  state: "ready";
  currentRevision: number;
  sourceWorkspaceId: string;
  sourceAgentId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SiteRevisionRecord = {
  id: string;
  siteId: string;
  tenantId: string;
  subjectId: string;
  revision: number;
  artifactSha256: string;
  contentHtml: string;
  sizeBytes: number;
  createdAt: Date;
};

export interface SiteStore {
  listOwnedSites(identity: IdentityContext): Promise<SiteRecord[]>;
  publishSite(identity: IdentityContext, input: {
    slug: string;
    name: string;
    sourceWorkspaceId: string;
    sourceAgentId: string;
    artifactSha256: string;
    contentHtml: string;
    sizeBytes: number;
  }): Promise<SiteRecord>;
  getOwnedSiteRevision(identity: IdentityContext, siteId: string): Promise<{
    site: SiteRecord;
    revision: SiteRevisionRecord;
  } | null>;
  deleteOwnedSite(identity: IdentityContext, siteId: string): Promise<boolean>;
}

const mapSite = (row: Record<string, unknown>): SiteRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  slug: String(row.slug),
  name: String(row.name),
  state: "ready",
  currentRevision: Number(row.current_revision),
  sourceWorkspaceId: String(row.source_workspace_id),
  sourceAgentId: String(row.source_agent_id),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const mapRevision = (row: Record<string, unknown>): SiteRevisionRecord => ({
  id: String(row.revision_id),
  siteId: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  revision: Number(row.current_revision),
  artifactSha256: String(row.artifact_sha256),
  contentHtml: String(row.content_html),
  sizeBytes: Number(row.size_bytes),
  createdAt: new Date(String(row.revision_created_at)),
});

const siteSelect = `SELECT
  id,tenant_id,subject_id,slug,name,state,current_revision,source_workspace_id,source_agent_id,created_at,updated_at
  FROM sites`;

export class PostgresSiteStore implements SiteStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresSiteStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() {
    await this.pool.end();
  }

  async listOwnedSites(identity: IdentityContext) {
    const result = await this.pool.query(
      `${siteSelect} WHERE tenant_id=$1 AND subject_id=$2 ORDER BY updated_at DESC,id`,
      [identity.tenantId, identity.subjectId],
    );
    return result.rows.map(mapSite);
  }

  async publishSite(identity: IdentityContext, input: {
    slug: string;
    name: string;
    sourceWorkspaceId: string;
    sourceAgentId: string;
    artifactSha256: string;
    contentHtml: string;
    sizeBytes: number;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const siteResult = await client.query(
        `INSERT INTO sites (
           id,tenant_id,subject_id,slug,name,state,current_revision,source_workspace_id,source_agent_id,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,'ready',0,$6,$7,now(),now())
         ON CONFLICT (tenant_id,subject_id,slug) DO UPDATE SET
           name=EXCLUDED.name,
           state='ready',
           source_workspace_id=EXCLUDED.source_workspace_id,
           source_agent_id=EXCLUDED.source_agent_id,
           updated_at=now()
         RETURNING *`,
        [
          randomUUID(),
          identity.tenantId,
          identity.subjectId,
          input.slug,
          input.name,
          input.sourceWorkspaceId,
          input.sourceAgentId,
        ],
      );
      const site = mapSite(siteResult.rows[0]);
      const nextResult = await client.query<{ revision: number }>(
        `SELECT COALESCE(MAX(revision),0)+1 AS revision
           FROM site_revisions
          WHERE tenant_id=$1 AND subject_id=$2 AND site_id=$3`,
        [identity.tenantId, identity.subjectId, site.id],
      );
      const revision = Number(nextResult.rows[0]?.revision ?? 1);
      await client.query(
        `INSERT INTO site_revisions (
           id,tenant_id,subject_id,site_id,revision,artifact_sha256,content_html,size_bytes,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
        [
          randomUUID(),
          identity.tenantId,
          identity.subjectId,
          site.id,
          revision,
          input.artifactSha256,
          input.contentHtml,
          input.sizeBytes,
        ],
      );
      const updated = await client.query(
        `UPDATE sites
            SET current_revision=$4,state='ready',updated_at=now()
          WHERE id=$3 AND tenant_id=$1 AND subject_id=$2
          RETURNING *`,
        [identity.tenantId, identity.subjectId, site.id, revision],
      );
      await client.query("COMMIT");
      return mapSite(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getOwnedSiteRevision(identity: IdentityContext, siteId: string) {
    const result = await this.pool.query(
      `SELECT
         s.id,s.tenant_id,s.subject_id,s.slug,s.name,s.state,s.current_revision,
         s.source_workspace_id,s.source_agent_id,s.created_at,s.updated_at,
         r.id AS revision_id,r.artifact_sha256,r.content_html,r.size_bytes,r.created_at AS revision_created_at
       FROM sites s
       JOIN site_revisions r
         ON r.site_id=s.id
        AND r.tenant_id=s.tenant_id
        AND r.subject_id=s.subject_id
        AND r.revision=s.current_revision
       WHERE s.id=$3 AND s.tenant_id=$1 AND s.subject_id=$2`,
      [identity.tenantId, identity.subjectId, siteId],
    );
    if (!result.rowCount) return null;
    return { site: mapSite(result.rows[0]), revision: mapRevision(result.rows[0]) };
  }

  async deleteOwnedSite(identity: IdentityContext, siteId: string) {
    const result = await this.pool.query(
      "DELETE FROM sites WHERE id=$3 AND tenant_id=$1 AND subject_id=$2 RETURNING id",
      [identity.tenantId, identity.subjectId, siteId],
    );
    return Boolean(result.rowCount);
  }
}

export class MemorySiteStore implements SiteStore {
  private readonly sites = new Map<string, SiteRecord>();
  private readonly revisions = new Map<string, SiteRevisionRecord[]>();

  async listOwnedSites(identity: IdentityContext) {
    return [...this.sites.values()]
      .filter((site) => site.tenantId === identity.tenantId && site.subjectId === identity.subjectId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  async publishSite(identity: IdentityContext, input: {
    slug: string;
    name: string;
    sourceWorkspaceId: string;
    sourceAgentId: string;
    artifactSha256: string;
    contentHtml: string;
    sizeBytes: number;
  }) {
    const now = new Date();
    const existing = [...this.sites.values()].find((site) => (
      site.tenantId === identity.tenantId
      && site.subjectId === identity.subjectId
      && site.slug === input.slug
    ));
    const revision = (existing?.currentRevision ?? 0) + 1;
    const site: SiteRecord = {
      id: existing?.id ?? randomUUID(),
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      slug: input.slug,
      name: input.name,
      state: "ready",
      currentRevision: revision,
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceAgentId: input.sourceAgentId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const nextRevision: SiteRevisionRecord = {
      id: randomUUID(),
      siteId: site.id,
      tenantId: identity.tenantId,
      subjectId: identity.subjectId,
      revision,
      artifactSha256: input.artifactSha256,
      contentHtml: input.contentHtml,
      sizeBytes: input.sizeBytes,
      createdAt: now,
    };
    this.sites.set(site.id, site);
    this.revisions.set(site.id, [...(this.revisions.get(site.id) ?? []), nextRevision]);
    return site;
  }

  async getOwnedSiteRevision(identity: IdentityContext, siteId: string) {
    const site = this.sites.get(siteId);
    if (!site || site.tenantId !== identity.tenantId || site.subjectId !== identity.subjectId) return null;
    const revision = this.revisions.get(siteId)?.find((item) => item.revision === site.currentRevision);
    return revision ? { site, revision } : null;
  }

  async deleteOwnedSite(identity: IdentityContext, siteId: string) {
    if (!await this.getOwnedSiteRevision(identity, siteId)) return false;
    this.revisions.delete(siteId);
    return this.sites.delete(siteId);
  }
}
