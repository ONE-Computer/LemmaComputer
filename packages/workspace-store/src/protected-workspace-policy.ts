import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  canonicalJson,
  organizationWorkspacePolicyConstraintsSchema,
  protectedPolicySelectionSchema,
  type OrganizationWorkspacePolicy,
  type OrganizationWorkspacePolicyConstraints,
  type ProductReleaseVerificationKeySet,
  type ProtectedBaselineTemplatePayload,
  type ProtectedPolicySelection,
  type SignedProtectedBaselineTemplate,
} from "@lemmacomputer/contracts";
import { verifyProtectedBaselineTemplate } from "@lemmacomputer/policy-integrity";

export type ProtectedTemplateVersionRecord = {
  tenantId: string;
  templateId: string;
  templateVersionId: string;
  version: number;
  supersedesTemplateVersionId: string | null;
  releaseId: string;
  sourceCommit: string;
  publishedAt: Date;
  keyId: string;
  documentHash: string;
  envelopeDigest: string;
  payload: ProtectedBaselineTemplatePayload;
  signedEnvelope: SignedProtectedBaselineTemplate;
  installedAt: Date;
};

export type MemberWorkspacePolicyAssignment = {
  id: string;
  tenantId: string;
  subjectId: string;
  assignmentVersion: number;
  previousAssignmentId: string | null;
  state: "selected" | "revoked";
  protectedTemplateVersionId: string;
  organizationPolicyVersionId: string | null;
  selection: ProtectedPolicySelection;
  selectionHash: string;
  assignedBy: string;
  createdAt: Date;
};

export type OrganizationWorkspacePolicyVersionRecord = OrganizationWorkspacePolicy & {
  tenantId: string;
  previousPolicyVersionId: string | null;
  revisionNote: string;
  createdBy: string;
  createdAt: Date;
};

export interface ProtectedWorkspacePolicyStore {
  installReleaseOwnedBaseline(input: {
    tenantId: string;
    signedEnvelope: unknown;
    now?: Date;
  }): Promise<ProtectedTemplateVersionRecord>;
  getLatestReleaseOwnedBaseline(tenantId: string): Promise<ProtectedTemplateVersionRecord | null>;
  createOrganizationPolicyVersion(input: {
    tenantId: string;
    constraints: OrganizationWorkspacePolicyConstraints;
    revisionNote: string;
    createdBy: string;
  }): Promise<OrganizationWorkspacePolicy>;
  listOrganizationPolicyVersions(tenantId: string): Promise<OrganizationWorkspacePolicyVersionRecord[]>;
  assignMemberSelection(input: {
    tenantId: string;
    subjectId: string;
    protectedTemplateVersionId: string;
    organizationPolicyVersionId?: string | null;
    selection: ProtectedPolicySelection;
    assignedBy: string;
  }): Promise<MemberWorkspacePolicyAssignment>;
  getCurrentMemberAssignment(tenantId: string, subjectId: string): Promise<MemberWorkspacePolicyAssignment | null>;
  listMemberAssignmentVersions(tenantId: string, subjectId: string): Promise<MemberWorkspacePolicyAssignment[]>;
  revokeMemberAssignment(input: { tenantId: string; subjectId: string; assignedBy: string }): Promise<boolean>;
}

const hashDocument = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

const templateRecord = (row: Record<string, unknown>): ProtectedTemplateVersionRecord => ({
  tenantId: String(row.tenant_id),
  templateId: String(row.template_id),
  templateVersionId: String(row.template_version_id),
  version: Number(row.version),
  supersedesTemplateVersionId: row.supersedes_template_version_id ? String(row.supersedes_template_version_id) : null,
  releaseId: String(row.release_id),
  sourceCommit: String(row.source_commit),
  publishedAt: new Date(String(row.published_at)),
  keyId: String(row.key_id),
  documentHash: String(row.document_hash),
  envelopeDigest: String(row.envelope_digest),
  payload: row.payload as ProtectedBaselineTemplatePayload,
  signedEnvelope: row.signed_envelope as SignedProtectedBaselineTemplate,
  installedAt: new Date(String(row.installed_at)),
});

const assignmentRecord = (row: Record<string, unknown>): MemberWorkspacePolicyAssignment => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  subjectId: String(row.subject_id),
  assignmentVersion: Number(row.assignment_version),
  previousAssignmentId: row.previous_assignment_id ? String(row.previous_assignment_id) : null,
  state: row.state as "selected" | "revoked",
  protectedTemplateVersionId: String(row.protected_template_version_id),
  organizationPolicyVersionId: row.organization_policy_version_id ? String(row.organization_policy_version_id) : null,
  selection: protectedPolicySelectionSchema.parse(row.selection),
  selectionHash: String(row.selection_hash),
  assignedBy: String(row.assigned_by),
  createdAt: new Date(String(row.created_at)),
});

const organizationPolicyRecord = (row: Record<string, unknown>): OrganizationWorkspacePolicyVersionRecord => ({
  tenantId: String(row.tenant_id),
  policyVersionId: String(row.id),
  version: Number(row.version),
  previousPolicyVersionId: row.previous_policy_version_id ? String(row.previous_policy_version_id) : null,
  documentHash: String(row.document_hash),
  constraints: organizationWorkspacePolicyConstraintsSchema.parse(row.constraints),
  revisionNote: String(row.revision_note),
  createdBy: String(row.created_by),
  createdAt: new Date(String(row.created_at)),
});

export class PostgresProtectedWorkspacePolicyStore implements ProtectedWorkspacePolicyStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly productTrustRoot?: ProductReleaseVerificationKeySet,
  ) {}

  static fromConnectionString(connectionString: string, productTrustRoot?: ProductReleaseVerificationKeySet) {
    return new PostgresProtectedWorkspacePolicyStore(new pg.Pool({ connectionString, max: 8 }), productTrustRoot);
  }

  async close() { await this.pool.end(); }

  async installReleaseOwnedBaseline(input: {
    tenantId: string;
    signedEnvelope: unknown;
    now?: Date;
  }): Promise<ProtectedTemplateVersionRecord> {
    if (!this.productTrustRoot) throw new Error("Legacy protected baseline verification is not configured");
    // The verified product key, not an organization administrator identity,
    // owns this write path. No caller-supplied document is accepted separately
    // from the signed release envelope.
    const verified = verifyProtectedBaselineTemplate(input.signedEnvelope, this.productTrustRoot, {
      ...(input.now ? { now: input.now } : {}),
    });
    const { payload } = verified;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `protected-baseline:${input.tenantId}:${payload.templateId}`,
      ]);
      const existing = await client.query(
        "SELECT * FROM protected_policy_template_versions WHERE tenant_id=$1 AND template_version_id=$2",
        [input.tenantId, payload.templateVersionId],
      );
      if (existing.rowCount) {
        if (existing.rows[0].envelope_digest !== verified.envelopeDigest) {
          throw new Error("A protected template version cannot be replaced by different release content");
        }
        await client.query("COMMIT");
        return templateRecord(existing.rows[0]);
      }
      const predecessor = await client.query(
        "SELECT template_version_id,version FROM protected_policy_template_versions WHERE tenant_id=$1 AND template_id=$2 ORDER BY version DESC LIMIT 1",
        [input.tenantId, payload.templateId],
      );
      if (payload.version === 1 && predecessor.rowCount) {
        throw new Error("Protected template version 1 is already installed");
      }
      if (payload.version > 1 && (
        !predecessor.rowCount
        || Number(predecessor.rows[0].version) !== payload.version - 1
        || predecessor.rows[0].template_version_id !== payload.supersedesTemplateVersionId
      )) {
        throw new Error("Protected template release history is missing its exact predecessor");
      }
      await client.query(
        "INSERT INTO protected_policy_templates(tenant_id,template_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [input.tenantId, payload.templateId],
      );
      const inserted = await client.query(
        `INSERT INTO protected_policy_template_versions (
           tenant_id,template_id,template_version_id,version,supersedes_template_version_id,
           release_id,source_commit,published_at,key_id,document_hash,envelope_digest,payload,signed_envelope
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          input.tenantId,
          payload.templateId,
          payload.templateVersionId,
          payload.version,
          payload.supersedesTemplateVersionId,
          payload.release.releaseId,
          payload.release.sourceCommit,
          payload.release.publishedAt,
          verified.keyId,
          payload.documentHash,
          verified.envelopeDigest,
          payload,
          verified.envelope,
        ],
      );
      await client.query("COMMIT");
      return templateRecord(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getLatestReleaseOwnedBaseline(tenantId: string): Promise<ProtectedTemplateVersionRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM protected_policy_template_versions
       WHERE tenant_id=$1 ORDER BY published_at DESC,template_id,version DESC LIMIT 1`,
      [tenantId],
    );
    return result.rowCount ? templateRecord(result.rows[0]) : null;
  }

  async createOrganizationPolicyVersion(input: {
    tenantId: string;
    constraints: OrganizationWorkspacePolicyConstraints;
    revisionNote: string;
    createdBy: string;
  }): Promise<OrganizationWorkspacePolicy> {
    const constraints = organizationWorkspacePolicyConstraintsSchema.parse(input.constraints);
    const revisionNote = input.revisionNote.trim();
    if (revisionNote.length < 3 || revisionNote.length > 240) throw new Error("Policy revision note must contain 3 to 240 characters");
    const documentHash = hashDocument(constraints);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`organization-policy:${input.tenantId}`]);
      const latest = await client.query(
        `SELECT id,version FROM organization_workspace_policy_versions
         WHERE tenant_id=$1 AND enforcement_scope='organization'
         ORDER BY version DESC LIMIT 1`,
        [input.tenantId],
      );
      const id = randomUUID();
      const version = latest.rowCount ? Number(latest.rows[0].version) + 1 : 1;
      const result = await client.query(
        `INSERT INTO organization_workspace_policy_versions (
           tenant_id,id,version,previous_policy_version_id,document_hash,constraints,revision_note,created_by,enforcement_scope
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'organization') RETURNING id,version,document_hash,constraints`,
        [input.tenantId, id, version, latest.rows[0]?.id ?? null, documentHash, constraints, revisionNote, input.createdBy],
      );
      await client.query("COMMIT");
      return {
        policyVersionId: String(result.rows[0].id),
        version: Number(result.rows[0].version),
        documentHash: String(result.rows[0].document_hash),
        constraints: organizationWorkspacePolicyConstraintsSchema.parse(result.rows[0].constraints),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listOrganizationPolicyVersions(tenantId: string): Promise<OrganizationWorkspacePolicyVersionRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM organization_workspace_policy_versions
       WHERE tenant_id=$1 AND enforcement_scope='organization'
       ORDER BY version DESC,id DESC`,
      [tenantId],
    );
    return result.rows.map(organizationPolicyRecord);
  }

  async assignMemberSelection(input: {
    tenantId: string;
    subjectId: string;
    protectedTemplateVersionId: string;
    organizationPolicyVersionId?: string | null;
    selection: ProtectedPolicySelection;
    assignedBy: string;
  }): Promise<MemberWorkspacePolicyAssignment> {
    const selection = protectedPolicySelectionSchema.parse(input.selection);
    const appended = await this.appendAssignment({
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      protectedTemplateVersionId: input.protectedTemplateVersionId,
      organizationPolicyVersionId: input.organizationPolicyVersionId ?? null,
      selection,
      state: "selected",
      assignedBy: input.assignedBy,
    });
    if (!appended) throw new Error("A selected member policy assignment could not be appended");
    return appended;
  }

  async getCurrentMemberAssignment(tenantId: string, subjectId: string): Promise<MemberWorkspacePolicyAssignment | null> {
    const result = await this.pool.query(
      `SELECT * FROM member_workspace_policy_assignment_versions
       WHERE tenant_id=$1 AND subject_id=$2 ORDER BY assignment_version DESC LIMIT 1`,
      [tenantId, subjectId],
    );
    if (!result.rowCount || result.rows[0].state === "revoked") return null;
    return assignmentRecord(result.rows[0]);
  }

  async listMemberAssignmentVersions(tenantId: string, subjectId: string): Promise<MemberWorkspacePolicyAssignment[]> {
    const result = await this.pool.query(
      `SELECT * FROM member_workspace_policy_assignment_versions
       WHERE tenant_id=$1 AND subject_id=$2 ORDER BY assignment_version DESC,id DESC`,
      [tenantId, subjectId],
    );
    return result.rows.map(assignmentRecord);
  }

  async revokeMemberAssignment(input: { tenantId: string; subjectId: string; assignedBy: string }): Promise<boolean> {
    const revoked = await this.appendAssignment({
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      state: "revoked",
      assignedBy: input.assignedBy,
    });
    return revoked !== null;
  }

  private async appendAssignment(input: {
    tenantId: string;
    subjectId: string;
    protectedTemplateVersionId?: string;
    organizationPolicyVersionId?: string | null;
    selection?: ProtectedPolicySelection;
    state: "selected" | "revoked";
    assignedBy: string;
  }): Promise<MemberWorkspacePolicyAssignment | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `member-policy:${input.tenantId}:${input.subjectId}`,
      ]);
      const latest = await client.query(
        `SELECT * FROM member_workspace_policy_assignment_versions
         WHERE tenant_id=$1 AND subject_id=$2 ORDER BY assignment_version DESC LIMIT 1`,
        [input.tenantId, input.subjectId],
      );
      if (input.state === "revoked" && (!latest.rowCount || latest.rows[0].state === "revoked")) {
        await client.query("COMMIT");
        return null;
      }
      const prior = latest.rowCount ? assignmentRecord(latest.rows[0]) : null;
      const protectedTemplateVersionId = input.state === "revoked"
        ? prior!.protectedTemplateVersionId
        : input.protectedTemplateVersionId;
      const organizationPolicyVersionId = input.state === "revoked"
        ? prior!.organizationPolicyVersionId
        : input.organizationPolicyVersionId ?? null;
      const selection = input.state === "revoked" ? prior!.selection : input.selection;
      if (!protectedTemplateVersionId || !selection) throw new Error("A selected member assignment requires a protected template and selection");
      const id = randomUUID();
      const assignmentVersion = latest.rowCount ? Number(latest.rows[0].assignment_version) + 1 : 1;
      const result = await client.query(
        `INSERT INTO member_workspace_policy_assignment_versions (
           tenant_id,id,subject_id,assignment_version,previous_assignment_id,state,
           protected_template_version_id,organization_policy_version_id,selection,selection_hash,assigned_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          input.tenantId,
          id,
          input.subjectId,
          assignmentVersion,
          latest.rows[0]?.id ?? null,
          input.state,
          protectedTemplateVersionId,
          organizationPolicyVersionId,
          selection,
          hashDocument(selection),
          input.assignedBy,
        ],
      );
      await client.query("COMMIT");
      return assignmentRecord(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
