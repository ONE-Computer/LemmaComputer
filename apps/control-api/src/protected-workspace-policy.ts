import { readFile } from "node:fs/promises";
import {
  organizationWorkspacePolicyConstraintsSchema,
  productReleaseVerificationKeySetSchema,
  protectedPolicySelectionSchema,
  signedProtectedBaselineTemplateSchema,
  type OrganizationWorkspacePolicyConstraints,
  type EffectiveProtectedWorkspacePolicy,
  type ProductReleaseVerificationKeySet,
  type ProtectedPolicySelection,
  type SignedProtectedBaselineTemplate,
} from "@lemmacomputer/contracts";
import {
  resolveProtectedBaselinePolicy,
  verifyProtectedBaselineTemplate,
  type VerifiedProtectedBaselineTemplate,
} from "@lemmacomputer/policy-integrity";
import type {
  MemberWorkspacePolicyAssignment,
  OrganizationWorkspacePolicyVersionRecord,
  ProtectedTemplateVersionRecord,
  ProtectedWorkspacePolicyStore,
} from "@lemmacomputer/workspace-store";

const trustRootUrl = new URL("../../../config/product-policy/product-release-trust.json", import.meta.url);
const baselineArtifactUrl = new URL(
  "../../../config/product-policy/protected-baselines/office-worker-claude-v1.json",
  import.meta.url,
);

export type ProductPolicyRelease = {
  trustRoot: ProductReleaseVerificationKeySet;
  signedEnvelope: SignedProtectedBaselineTemplate;
  verified: VerifiedProtectedBaselineTemplate;
};

export const parseProductPolicyRelease = (
  trustRootInput: unknown,
  signedEnvelopeInput: unknown,
  now = new Date(),
): ProductPolicyRelease => {
  const trustRoot = productReleaseVerificationKeySetSchema.parse(trustRootInput);
  const signedEnvelope = signedProtectedBaselineTemplateSchema.parse(signedEnvelopeInput);
  const verified = verifyProtectedBaselineTemplate(signedEnvelope, trustRoot, { now });
  return { trustRoot, signedEnvelope, verified };
};

export const loadProductPolicyRelease = async (now = new Date()): Promise<ProductPolicyRelease> => parseProductPolicyRelease(
  JSON.parse(await readFile(trustRootUrl, "utf8")) as unknown,
  JSON.parse(await readFile(baselineArtifactUrl, "utf8")) as unknown,
  now,
);

export type ProtectedBaselineAdministrationView = {
  immutable: true;
  editableByOrganization: false;
  authority: "lemmacomputer_product_release";
  templateId: string;
  templateVersionId: string;
  version: number;
  supersedesTemplateVersionId: string | null;
  documentHash: string;
  envelopeDigest: string;
  keyId: string;
  release: {
    releaseId: string;
    sourceCommit: string;
    publishedAt: string;
  };
  constraints: VerifiedProtectedBaselineTemplate["payload"]["document"]["constraints"];
  installedAt: string;
};

export type ResolvedMemberProtectedWorkspacePolicy =
  | { state: "unassigned" }
  | { state: "revoked" }
  | { state: "assigned"; policy: EffectiveProtectedWorkspacePolicy };

export interface ProtectedWorkspacePolicyAdministrationBoundary {
  overview(tenantId: string): Promise<{
    baseline: ProtectedBaselineAdministrationView;
    organizationPolicyVersions: OrganizationWorkspacePolicyVersionRecord[];
  }>;
  createOrganizationPolicyVersion(input: {
    tenantId: string;
    constraints: OrganizationWorkspacePolicyConstraints;
    revisionNote: string;
    createdBy: string;
  }): Promise<OrganizationWorkspacePolicyVersionRecord>;
  listOrganizationPolicyVersions(tenantId: string): Promise<OrganizationWorkspacePolicyVersionRecord[]>;
  assignMember(input: {
    tenantId: string;
    subjectId: string;
    selection: ProtectedPolicySelection;
    assignedBy: string;
  }): Promise<MemberWorkspacePolicyAssignment>;
  listMemberAssignmentVersions(tenantId: string, subjectId: string): Promise<MemberWorkspacePolicyAssignment[]>;
  revokeMember?(input: { tenantId: string; subjectId: string; revokedBy: string }): Promise<boolean>;
  effectiveMemberPolicy?(tenantId: string, subjectId: string): Promise<ResolvedMemberProtectedWorkspacePolicy>;
}

const baselineView = (
  installed: ProtectedTemplateVersionRecord,
): ProtectedBaselineAdministrationView => ({
  immutable: true,
  editableByOrganization: false,
  authority: "lemmacomputer_product_release",
  templateId: installed.templateId,
  templateVersionId: installed.templateVersionId,
  version: installed.version,
  supersedesTemplateVersionId: installed.supersedesTemplateVersionId,
  documentHash: installed.documentHash,
  envelopeDigest: installed.envelopeDigest,
  keyId: installed.keyId,
  release: {
    releaseId: installed.releaseId,
    sourceCommit: installed.sourceCommit,
    publishedAt: installed.publishedAt.toISOString(),
  },
  constraints: installed.payload.document.constraints,
  installedAt: installed.installedAt.toISOString(),
});

export class ProtectedWorkspacePolicyAdministrationService implements ProtectedWorkspacePolicyAdministrationBoundary {
  constructor(
    private readonly store: ProtectedWorkspacePolicyStore,
    private readonly release: ProductPolicyRelease,
  ) {}

  async ensureTenantBaseline(tenantId: string): Promise<ProtectedTemplateVersionRecord> {
    return this.store.installReleaseOwnedBaseline({
      tenantId,
      signedEnvelope: this.release.signedEnvelope,
    });
  }

  async overview(tenantId: string) {
    const [installed, organizationPolicyVersions] = await Promise.all([
      this.ensureTenantBaseline(tenantId),
      this.store.listOrganizationPolicyVersions(tenantId),
    ]);
    return { baseline: baselineView(installed), organizationPolicyVersions };
  }

  async createOrganizationPolicyVersion(input: {
    tenantId: string;
    constraints: OrganizationWorkspacePolicyConstraints;
    revisionNote: string;
    createdBy: string;
  }): Promise<OrganizationWorkspacePolicyVersionRecord> {
    await this.ensureTenantBaseline(input.tenantId);
    const constraints = organizationWorkspacePolicyConstraintsSchema.parse(input.constraints);
    const created = await this.store.createOrganizationPolicyVersion({ ...input, constraints });
    const versions = await this.store.listOrganizationPolicyVersions(input.tenantId);
    const persisted = versions.find((version) => version.policyVersionId === created.policyVersionId);
    if (!persisted) throw new Error("The appended organization policy version could not be read back");
    return persisted;
  }

  async listOrganizationPolicyVersions(tenantId: string) {
    await this.ensureTenantBaseline(tenantId);
    return this.store.listOrganizationPolicyVersions(tenantId);
  }

  async assignMember(input: {
    tenantId: string;
    subjectId: string;
    selection: ProtectedPolicySelection;
    assignedBy: string;
  }): Promise<MemberWorkspacePolicyAssignment> {
    const [installed, organizationPolicyVersions] = await Promise.all([
      this.ensureTenantBaseline(input.tenantId),
      this.store.listOrganizationPolicyVersions(input.tenantId),
    ]);
    const selection = protectedPolicySelectionSchema.parse(input.selection);
    const organizationPolicyVersion = organizationPolicyVersions[0] ?? null;
    const organizationPolicy = organizationPolicyVersion ? {
      policyVersionId: organizationPolicyVersion.policyVersionId,
      version: organizationPolicyVersion.version,
      documentHash: organizationPolicyVersion.documentHash,
      constraints: organizationPolicyVersion.constraints,
    } : null;
    resolveProtectedBaselinePolicy({
      baseline: this.release.verified,
      organizationPolicy,
      connectorPolicies: selection.connectorIds.map((connectorId) => ({
        connectorId,
        version: 1,
        documentHash: installed.documentHash,
        enabled: true,
        toolPolicies: installed.payload.document.constraints.connectors.toolPolicies[connectorId] ?? {},
      })),
      selection,
    });
    return this.store.assignMemberSelection({
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      protectedTemplateVersionId: installed.templateVersionId,
      organizationPolicyVersionId: organizationPolicyVersion?.policyVersionId ?? null,
      selection,
      assignedBy: input.assignedBy,
    });
  }

  async listMemberAssignmentVersions(tenantId: string, subjectId: string) {
    await this.ensureTenantBaseline(tenantId);
    return this.store.listMemberAssignmentVersions(tenantId, subjectId);
  }

  async revokeMember(input: { tenantId: string; subjectId: string; revokedBy: string }) {
    await this.ensureTenantBaseline(input.tenantId);
    return this.store.revokeMemberAssignment({
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      assignedBy: input.revokedBy,
    });
  }

  async effectiveMemberPolicy(tenantId: string, subjectId: string): Promise<ResolvedMemberProtectedWorkspacePolicy> {
    const [installed, assignment, assignmentVersions, organizationPolicyVersions] = await Promise.all([
      this.ensureTenantBaseline(tenantId),
      this.store.getCurrentMemberAssignment(tenantId, subjectId),
      this.store.listMemberAssignmentVersions(tenantId, subjectId),
      this.store.listOrganizationPolicyVersions(tenantId),
    ]);
    if (!assignment) return { state: assignmentVersions[0]?.state === "revoked" ? "revoked" : "unassigned" };
    if (assignment.protectedTemplateVersionId !== installed.templateVersionId) {
      throw new Error("The member assignment references a protected baseline that is not installed by this release");
    }
    const organizationPolicyVersion = assignment.organizationPolicyVersionId
      ? organizationPolicyVersions.find((version) => version.policyVersionId === assignment.organizationPolicyVersionId)
      : null;
    if (assignment.organizationPolicyVersionId && !organizationPolicyVersion) {
      throw new Error("The member assignment references an unavailable organization policy version");
    }
    return { state: "assigned", policy: resolveProtectedBaselinePolicy({
      baseline: this.release.verified,
      organizationPolicy: organizationPolicyVersion ? {
        policyVersionId: organizationPolicyVersion.policyVersionId,
        version: organizationPolicyVersion.version,
        documentHash: organizationPolicyVersion.documentHash,
        constraints: organizationPolicyVersion.constraints,
      } : null,
      connectorPolicies: assignment.selection.connectorIds.map((connectorId) => ({
        connectorId,
        version: 1,
        documentHash: installed.documentHash,
        enabled: true,
        toolPolicies: installed.payload.document.constraints.connectors.toolPolicies[connectorId] ?? {},
      })),
      selection: assignment.selection,
    }) };
  }
}
