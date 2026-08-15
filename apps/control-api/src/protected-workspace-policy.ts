import {
  isWorkspaceSelectableAgentCatalogId,
  LemmaComputerError,
  m365ToolCatalog,
  organizationWorkspacePolicyConstraintsSchema,
  productReleaseVerificationKeySetSchema,
  sandboxApplicationIds,
  sandboxModelAliases,
  signedProtectedBaselineTemplateSchema,
  workspaceSelectableAgentCatalogIds,
  workspaceCapabilityIds,
  type OrganizationWorkspacePolicyConstraints,
  type ProductReleaseVerificationKeySet,
  type SignedProtectedBaselineTemplate,
} from "@lemmacomputer/contracts";
import {
  resolveProtectedBaselinePolicy,
  verifyProtectedBaselineTemplate,
  type VerifiedProtectedBaselineTemplate,
} from "@lemmacomputer/policy-integrity";
import type {
  OrganizationWorkspacePolicyVersionRecord,
  ProtectedWorkspacePolicyStore,
} from "@lemmacomputer/workspace-store";

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

const microsoft365ToolPolicies = Object.fromEntries(Object.entries(m365ToolCatalog).map(([name, tool]) => [name, tool.decision]));

export const organizationWorkspacePolicyCatalog = {
  constraints: {
    workspaceProfiles: { allow: ["claude-desktop-standard-v1", "disposable-open-v1"] as const, deny: [] },
    agents: { allow: [...workspaceSelectableAgentCatalogIds], deny: [] },
    applications: { allow: [...sandboxApplicationIds], deny: [] },
    modelAliases: { allow: [...sandboxModelAliases], deny: [] },
    serviceClasses: { allow: ["lite", "balanced", "pro"] as const, deny: [] },
    maximumReasoningEffort: "max" as const,
    maximumEgressMode: "full-web" as const,
    clipboard: { localToWorkspace: true, workspaceToLocal: true, maxBytes: 1_048_576 },
    connectors: {
      allow: ["microsoft-365"],
      deny: [],
      toolPolicies: { "microsoft-365": microsoft365ToolPolicies },
    },
    capabilities: { allow: [...workspaceCapabilityIds], deny: [] },
  },
};

export interface ProtectedWorkspacePolicyAdministrationBoundary {
  overview(tenantId: string): Promise<{
    catalog: typeof organizationWorkspacePolicyCatalog;
    organizationPolicyVersions: OrganizationWorkspacePolicyVersionRecord[];
  }>;
  createOrganizationPolicyVersion(input: {
    tenantId: string;
    constraints: OrganizationWorkspacePolicyConstraints;
    revisionNote: string;
    createdBy: string;
  }): Promise<OrganizationWorkspacePolicyVersionRecord>;
  listOrganizationPolicyVersions(tenantId: string): Promise<OrganizationWorkspacePolicyVersionRecord[]>;
  currentOrganizationPolicy(tenantId: string): Promise<OrganizationWorkspacePolicyVersionRecord | null>;
}

export class ProtectedWorkspacePolicyAdministrationService implements ProtectedWorkspacePolicyAdministrationBoundary {
  constructor(private readonly store: ProtectedWorkspacePolicyStore) {}

  async overview(tenantId: string) {
    return {
      catalog: organizationWorkspacePolicyCatalog,
      organizationPolicyVersions: await this.store.listOrganizationPolicyVersions(tenantId),
    };
  }

  async createOrganizationPolicyVersion(input: {
    tenantId: string;
    constraints: OrganizationWorkspacePolicyConstraints;
    revisionNote: string;
    createdBy: string;
  }): Promise<OrganizationWorkspacePolicyVersionRecord> {
    const constraints = organizationWorkspacePolicyConstraintsSchema.parse(input.constraints);
    const configuredAgentIds = [
      ...(constraints.agents?.allow ?? []),
      ...(constraints.agents?.deny ?? []),
    ];
    if (configuredAgentIds.some((agentId) => !isWorkspaceSelectableAgentCatalogId(agentId))) {
      throw new LemmaComputerError(
        "WORKSPACE_AGENT_NOT_SELECTABLE",
        "Organization workspace guardrails may include only release-qualified agents",
        400,
      );
    }
    const created = await this.store.createOrganizationPolicyVersion({ ...input, constraints });
    const versions = await this.store.listOrganizationPolicyVersions(input.tenantId);
    const persisted = versions.find((version) => version.policyVersionId === created.policyVersionId);
    if (!persisted) throw new Error("The appended organization policy version could not be read back");
    return persisted;
  }

  async listOrganizationPolicyVersions(tenantId: string) {
    return this.store.listOrganizationPolicyVersions(tenantId);
  }

  async currentOrganizationPolicy(tenantId: string) {
    return (await this.store.listOrganizationPolicyVersions(tenantId))[0] ?? null;
  }
}
