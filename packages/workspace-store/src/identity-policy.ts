import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { defaultClipboardPolicy, egressSecurityGroupVersionSchema, LemmaComputerError, m365ToolCatalog, ownedAgentCatalog, runtimePolicySchema, sandboxApplicationIds, type AgentCatalogId, type AgentProfile, type EgressSecurityGroupVersion, type EgressSecurityGroupRule, type IdentityContext, type McpToolPolicyDecision, type OwnedJson, type RuntimePolicy, type SandboxApplicationId } from "@lemmacomputer/contracts";
import { compileEgressSecurityGroup } from "@lemmacomputer/egress-policy";
import { permissionsForOrganizationRoles, type LemmaComputerRole, type OrganizationMembershipStatus, type OrganizationPermission, type OrganizationRole } from "./rbac.js";

export type LemmaComputerUserStatus = "active" | "disabled";
export type MembershipAdmissionMode = "directory-jit" | "existing-membership-only";
export type { LemmaComputerRole, OrganizationMembershipStatus, OrganizationPermission, OrganizationRole } from "./rbac.js";

export const shouldAssignDefaultPolicyOnAuthentication = (
  hasExistingIdentityMapping: boolean,
  shouldBootstrapAdministrator: boolean,
) => !hasExistingIdentityMapping || shouldBootstrapAdministrator;

export type SessionPrincipal = {
  userId: string;
  accountUserId?: string;
  tenantId: string;
  organizationId?: string;
  membershipId?: string;
  membershipStatus?: OrganizationMembershipStatus;
  role?: OrganizationRole;
  permissions?: OrganizationPermission[];
  email: string;
  displayName: string;
  tenantDisplayName: string;
  roles: LemmaComputerRole[];
  identity: IdentityContext;
};

export type OidcLoginAttempt = {
  verifierCiphertext: string;
  nonce: string;
  returnPath: string;
};

export type EffectivePolicy = {
  assignmentId: string;
  policyBundleId: string;
  policyVersionId: string;
  version: number;
  documentHash: string;
  assignedBy: string;
  assignedAt: string;
  agentId: string;
  vendorUserId: string;
  document: OwnedJson;
  egressSecurityGroup?: EgressSecurityGroupVersion | null;
};

const agentProfileFor = (catalogId: AgentCatalogId): AgentProfile => ({
  "claude-desktop": "claude-desktop-managed-v1",
  "claude-cli": "claude-cli-managed-v1",
  "codex-cli": "codex-cli-managed-v1",
  "hermes-desktop": "hermes-desktop-managed-v1",
  "hermes-claw": "hermes-claw-managed-v1",
})[catalogId] as AgentProfile;

const agentCatalogIdFor = (profile: unknown): AgentCatalogId => ({
  "claude-desktop-managed-v1": "claude-desktop",
  "claude-cli-managed-v1": "claude-cli",
  "codex-cli-managed-v1": "codex-cli",
  "hermes-desktop-managed-v1": "hermes-desktop",
  "hermes-claw-managed-v1": "hermes-claw",
})[String(profile)] as AgentCatalogId | undefined ?? "claude-desktop";

export const runtimePolicyFor = (
  policy: EffectivePolicy,
  selectedModelAlias?: string,
  selectedWorkspaceProfile?: string,
  selectedAgentIds?: AgentCatalogId[],
  selectedApplicationIds?: SandboxApplicationId[],
  workspaceEgressSecurityGroup?: EgressSecurityGroupVersion | null,
  additionalAllowedModelAliases: readonly string[] = [],
): RuntimePolicy => {
  const document = policy.document as Record<string, unknown>;
  const mcp = document.mcp as Record<string, unknown> | undefined;
  const servers = mcp?.servers as Record<string, unknown> | undefined;
  const entries = Object.entries(servers ?? {});
  if (entries.length !== 1) throw new LemmaComputerError("POLICY_INVALID", "The active workspace policy must assign exactly one MCP server", 500);
  const [mcpServer, serverPolicy] = entries[0]!;
  const tools = (serverPolicy as Record<string, unknown>)?.tools;
  const configuredToolPolicies = (serverPolicy as Record<string, unknown>)?.toolPolicies as Record<string, unknown> | undefined;
  const toolPolicies = Object.fromEntries((Array.isArray(tools) ? tools : []).map((tool) => {
    const name = String(tool) as keyof typeof m365ToolCatalog;
    return [name, configuredToolPolicies?.[name] ?? m365ToolCatalog[name]?.decision ?? "deny"];
  }));
  const modelAliases = document.modelAliases;
  const policyModelAliases = Array.isArray(modelAliases) ? modelAliases.filter((value): value is string => typeof value === "string") : [];
  const allowedModelAliases = [...new Set([...policyModelAliases, ...additionalAllowedModelAliases])];
  const workspaceProfiles = Array.isArray(document.workspaceProfiles)
    ? document.workspaceProfiles.filter((value): value is string => typeof value === "string")
    : typeof document.workspaceProfile === "string" ? [document.workspaceProfile] : [];
  const modelAlias = selectedModelAlias ?? allowedModelAliases[0];
  const workspaceProfile = selectedWorkspaceProfile ?? workspaceProfiles[0];
  const clipboard = document.clipboard && typeof document.clipboard === "object" && !Array.isArray(document.clipboard)
    ? document.clipboard as Record<string, unknown>
    : defaultClipboardPolicy;
  if (!modelAlias || !allowedModelAliases.includes(modelAlias)) throw new LemmaComputerError("MODEL_NOT_ASSIGNED", "The selected model route is not assigned by the active policy", 403);
  if (!workspaceProfile || !workspaceProfiles.includes(workspaceProfile)) throw new LemmaComputerError("PROFILE_NOT_ASSIGNED", "The selected sandbox profile is not assigned by the active policy", 403);
  const hasAgentCatalog = Array.isArray(document.agents) || selectedAgentIds !== undefined;
  const configuredAgentIds = Array.isArray(document.agents)
    ? document.agents.filter((value): value is AgentCatalogId => typeof value === "string" && ownedAgentCatalog.some((agent) => agent.id === value))
    : hasAgentCatalog
      ? ownedAgentCatalog.map((agent) => agent.id)
      : [agentCatalogIdFor(document.agentProfile)];
  const defaultAgentIds = Array.isArray(document.defaultAgents)
    ? document.defaultAgents.filter((value): value is AgentCatalogId => typeof value === "string" && configuredAgentIds.includes(value as AgentCatalogId))
    : configuredAgentIds;
  const agentIds = hasAgentCatalog ? selectedAgentIds ?? defaultAgentIds : configuredAgentIds;
  if (!agentIds.length || new Set(agentIds).size !== agentIds.length) {
    throw new LemmaComputerError("AGENT_SELECTION_INVALID", "At least one unique workspace agent must be selected", 400);
  }
  if (agentIds.some((id) => !configuredAgentIds.includes(id))) {
    throw new LemmaComputerError("AGENT_NOT_ASSIGNED", "A selected agent is not assigned by the active policy", 403);
  }
  const configuredApplicationIds = Array.isArray(document.applications)
    ? document.applications.filter((value): value is SandboxApplicationId => typeof value === "string" && sandboxApplicationIds.includes(value as SandboxApplicationId))
    : ["firefox"] as SandboxApplicationId[];
  const defaultApplicationIds = Array.isArray(document.defaultApplications)
    ? document.defaultApplications.filter((value): value is SandboxApplicationId => typeof value === "string" && configuredApplicationIds.includes(value as SandboxApplicationId))
    : configuredApplicationIds;
  const applicationIds = selectedApplicationIds ?? defaultApplicationIds;
  if (!applicationIds.length || new Set(applicationIds).size !== applicationIds.length) {
    throw new LemmaComputerError("APPLICATION_SELECTION_INVALID", "At least one unique sandbox application must be selected", 400);
  }
  if (applicationIds.some((id) => !configuredApplicationIds.includes(id))) {
    throw new LemmaComputerError("APPLICATION_NOT_ASSIGNED", "A selected application is not assigned by the active policy", 403);
  }
  const agents = hasAgentCatalog ? agentIds.map((catalogId) => {
    const catalog = ownedAgentCatalog.find((entry) => entry.id === catalogId);
    if (!catalog) throw new LemmaComputerError("AGENT_UNAVAILABLE", "A selected agent is unavailable in the owned catalog", 500);
    return {
      catalogId,
      agentId: `${policy.agentId}:${catalogId}`,
      agentProfile: agentProfileFor(catalogId),
      displayName: catalog.displayName,
      clientVersion: catalog.clientVersion,
      modelAlias,
      mcpServer,
      allowedTools: tools as string[],
      toolPolicies,
    };
  }) : undefined;
  const primaryAgent = agents?.[0];
  const executionMode = workspaceProfile === "disposable-open-v1" ? "disposable-open" as const : "managed" as const;
  const attachedEgress = workspaceEgressSecurityGroup === undefined
    ? policy.egressSecurityGroup
    : workspaceEgressSecurityGroup;
  const fullWebEgress = attachedEgress
    ? attachedEgress.defaultAction === "allow-public-http-https"
    : executionMode === "disposable-open";
  const egressMode = fullWebEgress ? "full-web" as const : "restricted" as const;
  const egress = fullWebEgress
    ? {
        schemaVersion: 2 as const,
        mode: "full-web" as const,
        id: attachedEgress?.id ?? `egv_full_web_${policy.documentHash.slice(0, 24)}`,
        securityGroupId: attachedEgress?.securityGroupId ?? "esg_disposable_open",
        version: attachedEgress?.version ?? policy.version,
        name: attachedEgress?.name ?? "Disposable open public web",
        description: attachedEgress?.description ?? "Public HTTP and HTTPS through the workspace egress proxy; private and reserved destinations remain blocked.",
        defaultAction: "allow-public-http-https" as const,
        rules: attachedEgress?.rules.filter((rule) => rule.action === "deny") ?? [],
        documentHash: createHash("sha256")
          .update(`lemmacomputer-full-web-v2\0${policy.documentHash}\0${attachedEgress?.documentHash ?? "no-explicit-rules"}`)
          .digest("hex"),
      }
    : attachedEgress ? {
        schemaVersion: 2 as const,
        mode: "restricted" as const,
        id: attachedEgress.id,
        securityGroupId: attachedEgress.securityGroupId,
        version: attachedEgress.version,
        name: attachedEgress.name,
        description: attachedEgress.description,
        defaultAction: attachedEgress.defaultAction,
        rules: attachedEgress.rules,
        documentHash: attachedEgress.documentHash,
      } : undefined;
  return runtimePolicySchema.parse({
    schemaVersion: 1,
    policyVersionId: policy.policyVersionId,
    policyVersion: policy.version,
    policyHash: policy.documentHash,
    workspaceProfile,
    executionMode,
    egressMode,
    agentId: primaryAgent?.agentId ?? policy.agentId,
    agentProfile: primaryAgent?.agentProfile ?? document.agentProfile,
    ...(agents ? { agents } : {}),
    applications: applicationIds,
    networkProfile: document.networkProfile,
    ...(egress ? { egress } : {}),
    clipboard: {
      enabled: clipboard.enabled ?? defaultClipboardPolicy.enabled,
      localToWorkspace: clipboard.localToWorkspace ?? defaultClipboardPolicy.localToWorkspace,
      workspaceToLocal: clipboard.workspaceToLocal ?? defaultClipboardPolicy.workspaceToLocal,
      maxBytes: clipboard.maxBytes ?? defaultClipboardPolicy.maxBytes,
    },
    modelAlias,
    mcpServer,
    allowedTools: tools,
    toolPolicies,
  });
};

export type AdminUserSummary = {
  userId: string;
  membershipId?: string;
  organizationId?: string;
  membershipStatus?: OrganizationMembershipStatus;
  role?: OrganizationRole;
  email: string;
  displayName: string;
  status: LemmaComputerUserStatus;
  roles: LemmaComputerRole[];
  effectivePolicy: EffectivePolicy | null;
};

export type AuthenticatedIdentity = {
  provider: string;
  issuer: string;
  subject: string;
  providerObjectId?: string;
  externalTenantId: string;
  email: string;
  displayName: string;
  organizationId: string;
  organizationDisplayName: string;
  userId: string;
  bootstrapOwner: boolean;
  membershipAdmissionMode: MembershipAdmissionMode;
  gatewayUserId: string;
};

export type OrganizationMembershipSummary = {
  membershipId: string;
  organizationId: string;
  accountUserId: string;
  userId: string;
  email: string;
  displayName: string;
  status: OrganizationMembershipStatus;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
};

export interface IdentityPolicyStore {
  createLoginAttempt(input: { stateHash: string; verifierCiphertext: string; nonce: string; returnPath: string; expiresAt: Date }): Promise<void>;
  consumeLoginAttempt(stateHash: string, now: Date): Promise<OidcLoginAttempt | null>;
  resolveAuthenticatedIdentity(input: AuthenticatedIdentity): Promise<SessionPrincipal>;
  createSession(input: { tokenHash: string; userId: string; membershipId?: string; expiresAt: Date }): Promise<void>;
  getSession(tokenHash: string, now: Date): Promise<SessionPrincipal | null>;
  revokeSession(tokenHash: string): Promise<void>;
  getPrincipal(userId: string): Promise<SessionPrincipal | null>;
  getEffectivePolicy(userId: string): Promise<EffectivePolicy | null>;
  listUsers(tenantId: string): Promise<AdminUserSummary[]>;
  listOrganizationMemberships?(organizationId: string): Promise<OrganizationMembershipSummary[]>;
  changeOrganizationMembership?(input: {
    organizationId: string;
    targetUserId: string;
    role?: OrganizationRole;
    status?: OrganizationMembershipStatus;
    updatedBy: string;
  }): Promise<{ membership: OrganizationMembershipSummary; revokedSessions: number }>;
  setUserStatus(input: { tenantId: string; targetUserId: string; status: LemmaComputerUserStatus; updatedBy: string }): Promise<{ status: LemmaComputerUserStatus; revokedSessions: number }>;
  revokeUserSessions(input: { tenantId: string; targetUserId: string; revokedBy: string }): Promise<number>;
  assignMvpPolicy(input: { tenantId: string; targetUserId: string; assignedBy: string }): Promise<EffectivePolicy>;
  revokeMvpPolicy(input: { tenantId: string; targetUserId: string; revokedBy: string }): Promise<boolean>;
  createMvpPolicyVersion(input: { tenantId: string; createdBy: string; revisionNote: string }): Promise<{ id: string; version: number; documentHash: string }>;
  updateMvpToolPolicy(input: { tenantId: string; updatedBy: string; tools: Record<string, McpToolPolicyDecision> }): Promise<{ id: string; version: number; documentHash: string }>;
  listEgressSecurityGroups(tenantId: string, createdBy?: string): Promise<EgressSecurityGroupVersion[]>;
  saveEgressSecurityGroup(input: { tenantId: string; updatedBy: string; securityGroupId?: string; name: string; description: string; defaultAction: "deny" | "allow-public-http-https"; rules: EgressSecurityGroupRule[] }): Promise<EgressSecurityGroupVersion>;
  assignEgressSecurityGroup(input: { tenantId: string; targetUserId: string; assignedBy: string; securityGroupVersionId: string }): Promise<EffectivePolicy>;
  getWorkspaceEgressSecurityGroup?(input: { tenantId: string; subjectId: string; grantId: string }): Promise<EgressSecurityGroupVersion | null>;
  listWorkspaceEgressSecurityGroupAssignments?(input: { tenantId: string; securityGroupId: string }): Promise<Array<{ subjectId: string; grantId: string }>>;
  assignWorkspaceEgressSecurityGroup?(input: { tenantId: string; subjectId: string; grantId: string; assignedBy: string; securityGroupVersionId: string }): Promise<EgressSecurityGroupVersion>;
}

const mvpAgentIds = ["claude-desktop", "claude-cli", "codex-cli", "hermes-desktop", "hermes-claw"] as const;
const mvpDefaultAgentIds = ["claude-desktop", "hermes-claw"] as const;
const mvpApplicationIds = ["firefox", "google-chrome"] as const;
const mvpDefaultApplicationIds = ["firefox"] as const;
const mvpDefaultModelAliases = ["lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-glm", "lemmacomputer-bedrock"] as const;
const historicMvpDefaultModelAliasSets = [
  ["lemmacomputer-claude", "lemmacomputer-openai"],
  ["lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-glm"],
  ["lemmacomputer-claude", "lemmacomputer-openai", "lemmacomputer-bedrock"],
] as const;

const applyMvpSandboxCatalog = (document: Record<string, OwnedJson>) => {
  document.workspaceProfile = "claude-desktop-standard-v1";
  document.workspaceProfiles = ["claude-desktop-standard-v1", "disposable-open-v1"];
  document.agents = [...mvpAgentIds];
  document.defaultAgents = [...mvpDefaultAgentIds];
  document.applications = [...mvpApplicationIds];
  document.defaultApplications = [...mvpDefaultApplicationIds];
  return document;
};

export const withOpenWorkspaceProfile = (document: OwnedJson): OwnedJson | null => {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const source = document as Record<string, OwnedJson>;
  const profiles = Array.isArray(source.workspaceProfiles)
    ? source.workspaceProfiles.filter((value): value is string => typeof value === "string")
    : typeof source.workspaceProfile === "string"
      ? [source.workspaceProfile]
      : [];
  if (!profiles.includes("claude-desktop-standard-v1") || profiles.includes("disposable-open-v1")) return null;
  return {
    ...structuredClone(source),
    workspaceProfiles: [...profiles, "disposable-open-v1"],
  };
};

export const mvpPolicyDocument = (
  revisionNote = "Initial MVP policy",
  modelAliases: readonly string[] = mvpDefaultModelAliases,
) => ({
  schemaVersion: 1,
  revisionNote,
  workspaceProfile: "claude-desktop-standard-v1",
  workspaceProfiles: ["claude-desktop-standard-v1", "disposable-open-v1"],
  agentProfile: "claude-desktop-managed-v1",
  agents: [...mvpAgentIds],
  defaultAgents: [...mvpDefaultAgentIds],
  applications: [...mvpApplicationIds],
  defaultApplications: [...mvpDefaultApplicationIds],
  // The demo bootstrap uses only routes managed by Provider settings.
  modelAliases: [...modelAliases],
  networkProfile: "controlled-egress-v1",
  clipboard: defaultClipboardPolicy,
  mcp: {
    servers: {
      lemmacomputer_ms365: {
        tools: Object.keys(m365ToolCatalog),
        toolPolicies: Object.fromEntries(Object.entries(m365ToolCatalog).map(([name, tool]) => [name, tool.decision])),
      },
    },
  },
  capabilities: ["ai-assistant", "coding-tools", "m365-read", "m365-write-protected"],
  protectedOperations: {
    "m365-write-protected": "approval_required",
    defaultWrite: "deny",
  },
}) satisfies OwnedJson;

// Only exact historic defaults are upgraded. Customer-created policy versions
// remain opt-in and are never broadened by the demo adoption path.
const historicMvpPolicyDocuments = () => [
  ...historicMvpDefaultModelAliasSets.map((aliases) => mvpPolicyDocument("Initial MVP policy", aliases)),
  mvpPolicyDocument("Enabled Bedrock for the historic default MVP policy", historicMvpDefaultModelAliasSets[2]),
];

const stableJson = (value: OwnedJson): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
};

const policyHash = (document: OwnedJson) => createHash("sha256").update(stableJson(document)).digest("hex");
export const upgradeHistoricMvpPolicyDocument = (document: OwnedJson): OwnedJson | null => {
  const documentHash = policyHash(document);
  if (!historicMvpPolicyDocuments().some((historic) => policyHash(historic) === documentHash)) return null;
  return mvpPolicyDocument("Enabled managed GLM and Bedrock for the demo default policy");
};
const mvpPolicyBundleId = (tenantId: string) => `mvp-standard:${tenantId}`;
const defaultEgressSecurityGroupId = (tenantId: string) => `esg_${createHash("sha256").update(`egress:${tenantId}`).digest("hex").slice(0, 24)}`;
const defaultEgressSecurityGroupVersionId = (tenantId: string) => `egv_${createHash("sha256").update(`egress:${tenantId}`).digest("hex").slice(0, 24)}_v1`;
const defaultEgressDocument = () => ({
  schemaVersion: 1,
  name: "Default security group",
  description: "The built-in network policy attached to new workspaces.",
  defaultAction: "allow-public-http-https",
  rules: [],
}) satisfies OwnedJson;

const mapPrincipal = (row: Record<string, unknown>): SessionPrincipal => ({
  userId: String(row.user_id),
  accountUserId: String(row.account_user_id),
  tenantId: String(row.organization_id),
  organizationId: String(row.organization_id),
  membershipId: String(row.membership_id),
  membershipStatus: String(row.membership_status) as OrganizationMembershipStatus,
  role: String(row.membership_role) as OrganizationRole,
  permissions: permissionsForOrganizationRoles([String(row.membership_role) as OrganizationRole]),
  email: String(row.email),
  displayName: String(row.display_name),
  tenantDisplayName: String(row.tenant_display_name),
  roles: [
    String(row.membership_role) as OrganizationRole,
    row.membership_role === "owner" || row.membership_role === "admin" ? "administrator" : "employee",
  ],
  identity: { tenantId: String(row.organization_id), subjectId: String(row.user_id), audience: "lemmacomputer-control" },
});

const principalColumns = `
  SELECT u.id AS user_id, m.account_user_id, m.organization_id, m.id AS membership_id,
    m.status AS membership_status, m.role AS membership_role,
    u.email, u.display_name, t.display_name AS tenant_display_name`;

const homePrincipalSelect = `${principalColumns}
  FROM users u
  JOIN organization_memberships m ON m.subject_user_id=u.id AND m.organization_id=u.tenant_id
  JOIN account_users account_user ON account_user.id=m.account_user_id
  JOIN organizations organization ON organization.id=m.organization_id
  JOIN tenants t ON t.id=m.organization_id`;

const effectivePolicySelect = `
  SELECT pa.id AS assignment_id, pb.id AS policy_bundle_id, pv.id AS policy_version_id, pv.version,
    pv.document_hash, pv.document, pa.assigned_by, pa.assigned_at, pa.agent_id,
    vim.vendor_user_id, pa.tenant_id,
    esgv.id AS egress_version_id, esgv.security_group_id, esgv.version AS egress_version,
    esgv.document AS egress_document, esgv.document_hash AS egress_document_hash,
    esgv.created_by AS egress_created_by, esgv.created_at AS egress_created_at
  FROM policy_assignments pa
  JOIN policy_versions pv ON pv.id=pa.policy_version_id
  JOIN policy_bundles pb ON pb.id=pv.policy_bundle_id
  JOIN vendor_identity_mappings vim ON vim.user_id=pa.user_id AND vim.vendor='litellm' AND vim.mapping_kind='user'
  LEFT JOIN egress_security_group_versions esgv ON esgv.id=pa.egress_security_group_version_id
  WHERE pa.user_id=$1 AND pa.revoked_at IS NULL
  ORDER BY pa.assigned_at DESC LIMIT 1`;

const mapEgressVersion = (row: Record<string, unknown>): EgressSecurityGroupVersion => {
  const document = row.egress_document as Record<string, unknown>;
  const isDefault = String(row.security_group_id) === defaultEgressSecurityGroupId(String(row.tenant_id));
  return egressSecurityGroupVersionSchema.parse({
    schemaVersion: 1,
    id: String(row.egress_version_id),
    securityGroupId: String(row.security_group_id),
    tenantId: String(row.tenant_id),
    version: Number(row.egress_version),
    name: isDefault ? "Default security group" : document.name,
    description: isDefault ? "The built-in network policy attached to new workspaces." : document.description,
    defaultAction: isDefault ? "allow-public-http-https" : document.defaultAction ?? "deny",
    rules: document.rules,
    documentHash: String(row.egress_document_hash),
    createdBy: String(row.egress_created_by),
    createdAt: new Date(String(row.egress_created_at)).toISOString(),
    isDefault,
  });
};

const mapPolicy = (row: Record<string, unknown>): EffectivePolicy => {
  const egressDocument = row.egress_document as Record<string, unknown> | null;
  return {
    assignmentId: String(row.assignment_id),
    policyBundleId: String(row.policy_bundle_id),
    policyVersionId: String(row.policy_version_id),
    version: Number(row.version),
    documentHash: String(row.document_hash),
    assignedBy: String(row.assigned_by),
    assignedAt: new Date(String(row.assigned_at)).toISOString(),
    agentId: String(row.agent_id),
    vendorUserId: String(row.vendor_user_id),
    document: row.document as OwnedJson,
    egressSecurityGroup: row.egress_version_id && egressDocument ? mapEgressVersion(row) : null,
  };
};

export class PostgresIdentityPolicyStore implements IdentityPolicyStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresIdentityPolicyStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() { await this.pool.end(); }

  async upgradeLegacyWorkspaceProfiles() {
    const candidates = await this.pool.query(
      `SELECT DISTINCT pv.id AS policy_version_id,pv.policy_bundle_id,pv.document,pv.created_by
       FROM policy_assignments pa
       JOIN policy_versions pv ON pv.id=pa.policy_version_id
       WHERE pa.revoked_at IS NULL
       AND pv.policy_bundle_id='mvp-standard:' || pa.tenant_id
       AND (
         pv.document->>'workspaceProfile'='claude-desktop-standard-v1'
         OR pv.document->'workspaceProfiles' @> '["claude-desktop-standard-v1"]'::jsonb
       )
       AND (
         NOT COALESCE(pv.document->'workspaceProfiles', '[]'::jsonb) @> '["disposable-open-v1"]'::jsonb
         OR pv.document_hash = ANY($1::text[])
       )`,
      [historicMvpPolicyDocuments().map(policyHash)],
    );
    let upgradedAssignments = 0;
    for (const candidate of candidates.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-version:${candidate.policy_bundle_id}`]);
        const assignments = await client.query(
          `SELECT id,tenant_id,user_id,agent_id,egress_security_group_version_id,assigned_by
           FROM policy_assignments
           WHERE policy_version_id=$1 AND revoked_at IS NULL
           FOR UPDATE`,
          [candidate.policy_version_id],
        );
        if (!assignments.rowCount) {
          await client.query("COMMIT");
          continue;
        }
        const profileDocument = withOpenWorkspaceProfile(candidate.document as OwnedJson);
        const document = profileDocument
          ? upgradeHistoricMvpPolicyDocument(profileDocument) ?? profileDocument
          : upgradeHistoricMvpPolicyDocument(candidate.document as OwnedJson);
        if (!document) {
          await client.query("COMMIT");
          continue;
        }
        const documentHash = policyHash(document);
        const existing = await client.query(
          "SELECT id FROM policy_versions WHERE policy_bundle_id=$1 AND document_hash=$2",
          [candidate.policy_bundle_id, documentHash],
        );
        let policyVersionId = existing.rowCount ? String(existing.rows[0].id) : "";
        if (!policyVersionId) {
          const latest = await client.query(
            "SELECT COALESCE(max(version),0) AS version FROM policy_versions WHERE policy_bundle_id=$1",
            [candidate.policy_bundle_id],
          );
          policyVersionId = randomUUID();
          await client.query(
            `INSERT INTO policy_versions (id,policy_bundle_id,version,document,document_hash,created_by)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
            [
              policyVersionId,
              candidate.policy_bundle_id,
              Number(latest.rows[0].version) + 1,
              JSON.stringify(document),
              documentHash,
              candidate.created_by,
            ],
          );
        }
        for (const assignment of assignments.rows) {
          await client.query(
            "UPDATE policy_assignments SET revoked_at=now(),revoked_by=$2 WHERE id=$1",
            [assignment.id, assignment.assigned_by],
          );
          const replacementId = randomUUID();
          await client.query(
            `INSERT INTO policy_assignments (
               id,tenant_id,user_id,agent_id,policy_version_id,
               egress_security_group_version_id,assigned_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              replacementId,
              assignment.tenant_id,
              assignment.user_id,
              assignment.agent_id,
              policyVersionId,
              assignment.egress_security_group_version_id,
              assignment.assigned_by,
            ],
          );
          await client.query(
            `INSERT INTO capability_assignments (policy_assignment_id,capability_id)
             SELECT $1,capability_id FROM capability_assignments WHERE policy_assignment_id=$2`,
            [replacementId, assignment.id],
          );
          upgradedAssignments += 1;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return upgradedAssignments;
  }

  async createLoginAttempt(input: { stateHash: string; verifierCiphertext: string; nonce: string; returnPath: string; expiresAt: Date }) {
    await this.pool.query("DELETE FROM oidc_login_attempts WHERE expires_at<=now()");
    await this.pool.query(
      "INSERT INTO oidc_login_attempts (state_hash,verifier_ciphertext,nonce,return_path,expires_at) VALUES ($1,$2,$3,$4,$5)",
      [input.stateHash, input.verifierCiphertext, input.nonce, input.returnPath, input.expiresAt],
    );
  }

  async consumeLoginAttempt(stateHash: string, now: Date) {
    const result = await this.pool.query(
      "DELETE FROM oidc_login_attempts WHERE state_hash=$1 AND expires_at>$2 RETURNING verifier_ciphertext,nonce,return_path",
      [stateHash, now],
    );
    return result.rowCount ? {
      verifierCiphertext: String(result.rows[0].verifier_ciphertext),
      nonce: String(result.rows[0].nonce),
      returnPath: String(result.rows[0].return_path),
    } : null;
  }

  async resolveAuthenticatedIdentity(input: AuthenticatedIdentity) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`identity:${input.provider}:${input.issuer}:${input.subject}`]);
      const mapped = await client.query(
        `SELECT account_user_id,user_id AS legacy_user_id,
           external_tenant_id,provider_object_id
         FROM external_identities
         WHERE provider=$1 AND issuer=$2 AND external_subject=$3`,
        [input.provider, input.issuer, input.subject],
      );
      if (mapped.rowCount && input.providerObjectId) {
        const existingObjectId = mapped.rows[0].provider_object_id
          ? String(mapped.rows[0].provider_object_id)
          : null;
        if (String(mapped.rows[0].external_tenant_id) !== input.externalTenantId
          || (existingObjectId && existingObjectId !== input.providerObjectId)) {
          throw new LemmaComputerError("IDENTITY_IDENTIFIER_MISMATCH", "The immutable identity identifiers do not match", 403);
        }
      }
      const tenantId = input.organizationId;
      let organization = await client.query(
        `SELECT tenant.administrator_bootstrapped_at
         FROM tenants tenant
         JOIN organizations organization ON organization.id=tenant.id
         WHERE tenant.id=$1
         FOR UPDATE OF tenant,organization`,
        [tenantId],
      );
      if (!organization.rowCount) {
        if (input.membershipAdmissionMode === "existing-membership-only") {
          throw new LemmaComputerError("ORGANIZATION_NOT_ADMITTED", "The organization is not available for this sign-in", 403);
        }
        await client.query(
          `INSERT INTO tenants (id,external_tenant_id,display_name)
           VALUES ($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`,
          [tenantId, input.externalTenantId, input.organizationDisplayName],
        );
        await client.query(
          `INSERT INTO organizations (id,display_name)
           VALUES ($1,$2)
           ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=now()`,
          [tenantId, input.organizationDisplayName],
        );
        organization = await client.query(
          "SELECT administrator_bootstrapped_at FROM tenants WHERE id=$1 FOR UPDATE",
          [tenantId],
        );
      }
      let accountUserId = mapped.rowCount && mapped.rows[0].account_user_id
        ? String(mapped.rows[0].account_user_id)
        : "";
      if (mapped.rowCount && !accountUserId) {
        throw new LemmaComputerError("IDENTITY_BACKFILL_REQUIRED", "The identity migration backfill must complete before sign-in", 503);
      }
      if (!accountUserId) {
        if (input.membershipAdmissionMode === "existing-membership-only") {
          throw new LemmaComputerError("MEMBERSHIP_REQUIRED", "An organization invitation is required", 403);
        }
        const account = await client.query("INSERT INTO account_users (status) VALUES ('active') RETURNING id");
        accountUserId = String(account.rows[0].id);
      }
      let membership = await client.query(
        `SELECT id,subject_user_id,status,role
         FROM organization_memberships
         WHERE organization_id=$1 AND account_user_id=$2
         FOR UPDATE`,
        [tenantId, accountUserId],
      );
      const membershipCreated = !membership.rowCount;
      if (membershipCreated && input.membershipAdmissionMode === "existing-membership-only") {
        throw new LemmaComputerError("MEMBERSHIP_REQUIRED", "An organization invitation is required", 403);
      }
      const userId = membership.rowCount
        ? String(membership.rows[0].subject_user_id)
        : mapped.rowCount
          ? `user-${createHash("sha256").update(`${tenantId}:${accountUserId}`).digest("hex").slice(0, 24)}`
          : input.userId;
      const shouldBootstrapOwner = membershipCreated
        && input.bootstrapOwner
        && !organization.rows[0]?.administrator_bootstrapped_at;
      await client.query(
        `INSERT INTO users (id,tenant_id,account_user_id,email,display_name)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET
           account_user_id=COALESCE(users.account_user_id,EXCLUDED.account_user_id),
           email=EXCLUDED.email,display_name=EXCLUDED.display_name,updated_at=now()`,
        [userId, tenantId, accountUserId, input.email.toLowerCase(), input.displayName],
      );
      if (membershipCreated) {
        membership = await client.query(
          `INSERT INTO organization_memberships (
             organization_id,account_user_id,subject_user_id,status,role,created_by,updated_by
           ) VALUES ($1,$2,$3,'active',$4,$3,$3)
           RETURNING id,subject_user_id,status,role`,
          [tenantId, accountUserId, userId, shouldBootstrapOwner ? "owner" : "member"],
        );
      }
      if (membership.rows[0].status !== "active") {
        throw new LemmaComputerError("MEMBERSHIP_NOT_ACTIVE", "The organization membership is not active", 403);
      }
      await client.query(
        `INSERT INTO external_identities (
           id,user_id,account_user_id,provider,issuer,external_subject,
           external_tenant_id,provider_object_id,email,last_authenticated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (provider,issuer,external_subject) DO UPDATE SET
           account_user_id=COALESCE(external_identities.account_user_id,EXCLUDED.account_user_id),
           provider_object_id=COALESCE(external_identities.provider_object_id,EXCLUDED.provider_object_id),
           email=EXCLUDED.email,last_authenticated_at=now()`,
        [randomUUID(), userId, accountUserId, input.provider, input.issuer, input.subject, input.externalTenantId, input.providerObjectId ?? null, input.email.toLowerCase()],
      );
      await client.query(
        "INSERT INTO user_roles (user_id,role,assigned_by) VALUES ($1,'employee',$1) ON CONFLICT DO NOTHING",
        [userId],
      );
      if (shouldBootstrapOwner) {
        await client.query("INSERT INTO user_roles (user_id,role,assigned_by) VALUES ($1,'administrator',$1) ON CONFLICT DO NOTHING", [userId]);
        await client.query("UPDATE tenants SET administrator_bootstrapped_at=now() WHERE id=$1", [tenantId]);
      }
      const agentId = randomUUID();
      await client.query(
        "INSERT INTO agent_identities (id,tenant_id,owner_user_id,name) VALUES ($1,$2,$3,'Default agent') ON CONFLICT (owner_user_id,name) DO NOTHING",
        [agentId, tenantId, userId],
      );
      await client.query(
        `INSERT INTO vendor_identity_mappings (id,tenant_id,user_id,vendor,vendor_user_id,mapping_kind,verified_at)
         VALUES ($1,$2,$3,'litellm',$4,'user',now())
         ON CONFLICT (user_id,vendor,mapping_kind) DO UPDATE SET vendor_user_id=EXCLUDED.vendor_user_id,verified_at=now()`,
        [randomUUID(), tenantId, userId, input.gatewayUserId],
      );
      if (shouldAssignDefaultPolicyOnAuthentication(!membershipCreated, shouldBootstrapOwner)) {
        await this.ensurePolicyFoundation(client, tenantId, userId);
        await this.assignMvpPolicyWithClient(client, tenantId, userId, userId);
      }
      await client.query("COMMIT");
      const principal = await this.getPrincipalForOrganization(userId, tenantId);
      if (!principal) throw new LemmaComputerError("MEMBERSHIP_NOT_ACTIVE", "The organization membership is not active", 403);
      return principal;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async getPrincipalForOrganization(userId: string, organizationId: string) {
    const result = await this.pool.query(
      `${principalColumns}
       FROM users u
       JOIN organization_memberships m ON m.subject_user_id=u.id AND m.organization_id=$2
       JOIN account_users account_user ON account_user.id=m.account_user_id
       JOIN organizations organization ON organization.id=m.organization_id
       JOIN tenants t ON t.id=m.organization_id
       WHERE u.id=$1 AND u.status='active' AND m.status='active'
         AND account_user.status='active' AND organization.status='active'`,
      [userId, organizationId],
    );
    return result.rowCount ? mapPrincipal(result.rows[0]) : null;
  }

  async createSession(input: { tokenHash: string; userId: string; membershipId?: string; expiresAt: Date }) {
    await this.pool.query("DELETE FROM browser_sessions WHERE expires_at<=now() OR revoked_at IS NOT NULL");
    const membership = await this.pool.query(
      `SELECT m.id
       FROM organization_memberships m
       JOIN users u ON u.id=m.subject_user_id
       JOIN account_users account_user ON account_user.id=m.account_user_id
       JOIN organizations organization ON organization.id=m.organization_id
       WHERE m.subject_user_id=$1 AND m.status='active' AND u.status='active'
         AND account_user.status='active' AND organization.status='active'
         AND (($2::uuid IS NOT NULL AND m.id=$2::uuid)
           OR ($2::uuid IS NULL AND m.organization_id=u.tenant_id))`,
      [input.userId, input.membershipId ?? null],
    );
    if (!membership.rowCount) throw new LemmaComputerError("MEMBERSHIP_NOT_ACTIVE", "The organization membership is not active", 403);
    await this.pool.query(
      "INSERT INTO browser_sessions (id,token_hash,user_id,membership_id,expires_at) VALUES ($1,$2,$3,$4,$5)",
      [randomUUID(), input.tokenHash, input.userId, membership.rows[0].id, input.expiresAt],
    );
  }

  async getSession(tokenHash: string, now: Date) {
    const result = await this.pool.query(
      `${principalColumns}
       FROM browser_sessions s
       JOIN users u ON u.id=s.user_id
       JOIN organization_memberships m ON m.subject_user_id=u.id
         AND (m.id=s.membership_id OR s.membership_id IS NULL AND m.organization_id=u.tenant_id)
       JOIN account_users account_user ON account_user.id=m.account_user_id
       JOIN organizations organization ON organization.id=m.organization_id
       JOIN tenants t ON t.id=m.organization_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2
         AND u.status='active' AND m.status='active'
         AND account_user.status='active' AND organization.status='active'`,
      [tokenHash, now],
    );
    if (!result.rowCount) return null;
    await this.pool.query("UPDATE browser_sessions SET last_seen_at=$2 WHERE token_hash=$1", [tokenHash, now]);
    return mapPrincipal(result.rows[0]);
  }

  async revokeSession(tokenHash: string) {
    await this.pool.query("UPDATE browser_sessions SET revoked_at=now() WHERE token_hash=$1", [tokenHash]);
  }

  async getPrincipal(userId: string) {
    const result = await this.pool.query(
      `${homePrincipalSelect} WHERE u.id=$1 AND u.status='active' AND m.status='active'
        AND account_user.status='active' AND organization.status='active'`,
      [userId],
    );
    return result.rowCount ? mapPrincipal(result.rows[0]) : null;
  }

  async getEffectivePolicy(userId: string) {
    const result = await this.pool.query(effectivePolicySelect, [userId]);
    return result.rowCount ? mapPolicy(result.rows[0]) : null;
  }

  async listUsers(tenantId: string) {
    const result = await this.pool.query(
      `SELECT u.id AS user_id,u.email,u.display_name,m.id AS membership_id,
       m.account_user_id,m.organization_id,m.status AS membership_status,m.role AS membership_role
       FROM organization_memberships m
       JOIN users u ON u.id=m.subject_user_id
       WHERE m.organization_id=$1
       ORDER BY u.email`,
      [tenantId],
    );
    return Promise.all(result.rows.map(async (row) => ({
      userId: String(row.user_id),
      membershipId: String(row.membership_id),
      organizationId: String(row.organization_id),
      accountUserId: String(row.account_user_id),
      membershipStatus: String(row.membership_status) as OrganizationMembershipStatus,
      role: String(row.membership_role) as OrganizationRole,
      email: String(row.email),
      displayName: String(row.display_name),
      status: row.membership_status === "active" ? "active" as const : "disabled" as const,
      roles: [
        String(row.membership_role) as OrganizationRole,
        row.membership_role === "owner" || row.membership_role === "admin" ? "administrator" as const : "employee" as const,
      ],
      effectivePolicy: await this.getEffectivePolicy(String(row.user_id)),
    })));
  }

  async listOrganizationMemberships(organizationId: string) {
    const result = await this.pool.query(
      `SELECT m.id AS membership_id,m.organization_id,m.account_user_id,m.subject_user_id AS user_id,m.status,m.role,
        m.created_at,m.updated_at,u.email,u.display_name
       FROM organization_memberships m
       JOIN users u ON u.id=m.subject_user_id
       WHERE m.organization_id=$1
       ORDER BY u.email,m.id`,
      [organizationId],
    );
    return result.rows.map((row) => this.mapMembership(row));
  }

  private mapMembership(row: Record<string, unknown>): OrganizationMembershipSummary {
    return {
      membershipId: String(row.membership_id),
      organizationId: String(row.organization_id),
      accountUserId: String(row.account_user_id),
      userId: String(row.user_id),
      email: String(row.email),
      displayName: String(row.display_name),
      status: String(row.status) as OrganizationMembershipStatus,
      role: String(row.role) as OrganizationRole,
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    };
  }

  async changeOrganizationMembership(input: {
    organizationId: string;
    targetUserId: string;
    role?: OrganizationRole;
    status?: OrganizationMembershipStatus;
    updatedBy: string;
  }) {
    if (!input.role && !input.status) throw new LemmaComputerError("MEMBERSHIP_CHANGE_EMPTY", "No membership change was requested", 400);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`organization-membership:${input.organizationId}`]);
      const actor = await client.query(
        `SELECT role FROM organization_memberships
         WHERE organization_id=$1 AND subject_user_id=$2 AND status='active'`,
        [input.organizationId, input.updatedBy],
      );
      if (!actor.rowCount || actor.rows[0].role === "member") {
        throw new LemmaComputerError("MEMBERSHIP_ACTOR_INVALID", "The membership actor cannot manage organization access", 403);
      }
      const targetBefore = await client.query(
        "SELECT role FROM organization_memberships WHERE organization_id=$1 AND subject_user_id=$2",
        [input.organizationId, input.targetUserId],
      );
      if (!targetBefore.rowCount) throw new LemmaComputerError("MEMBERSHIP_NOT_FOUND", "Membership not found", 404);
      if (actor.rows[0].role !== "owner" && (input.role === "owner" || targetBefore.rows[0].role === "owner")) {
        throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an organization owner can change ownership", 403);
      }
      const changed = await client.query(
        `UPDATE organization_memberships membership
         SET role=COALESCE($3,membership.role),
           status=COALESCE($4,membership.status),updated_by=$5,updated_at=now()
         FROM users user_record
         WHERE membership.organization_id=$1 AND membership.subject_user_id=$2
           AND user_record.id=membership.subject_user_id
         RETURNING membership.id AS membership_id,membership.organization_id,membership.account_user_id,
           membership.subject_user_id AS user_id,
           membership.status,membership.role,membership.created_at,membership.updated_at,
           user_record.email,user_record.display_name`,
        [input.organizationId, input.targetUserId, input.role ?? null, input.status ?? null, input.updatedBy],
      );
      if (!changed.rowCount) throw new LemmaComputerError("MEMBERSHIP_NOT_FOUND", "Membership not found", 404);
      let revokedSessions = 0;
      if (input.status === "suspended" || input.status === "revoked") {
        const revoked = await client.query(
          `UPDATE browser_sessions SET revoked_at=now()
           WHERE membership_id=$1 AND revoked_at IS NULL RETURNING id`,
          [changed.rows[0].membership_id],
        );
        revokedSessions = revoked.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { membership: this.mapMembership(changed.rows[0]), revokedSessions };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setUserStatus(input: { tenantId: string; targetUserId: string; status: LemmaComputerUserStatus; updatedBy: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`organization-membership:${input.tenantId}`]);
      const target = await client.query(
        `SELECT u.id,m.id AS membership_id,m.role
         FROM users u
         JOIN organization_memberships m ON m.subject_user_id=u.id AND m.organization_id=$2
         WHERE u.id=$1
         FOR UPDATE OF u,m`,
        [input.targetUserId, input.tenantId],
      );
      if (!target.rowCount) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
      const actor = await client.query(
        `SELECT role FROM organization_memberships
         WHERE organization_id=$1 AND subject_user_id=$2 AND status='active'`,
        [input.tenantId, input.updatedBy],
      );
      if (!actor.rowCount || actor.rows[0].role === "member") {
        throw new LemmaComputerError("MEMBERSHIP_ACTOR_INVALID", "The membership actor cannot manage organization access", 403);
      }
      if (actor.rows[0].role !== "owner" && target.rows[0].role === "owner") {
        throw new LemmaComputerError("OWNER_CHANGE_FORBIDDEN", "Only an organization owner can change ownership", 403);
      }
      const membershipStatus = input.status === "active" ? "active" : "suspended";
      await client.query(
        `UPDATE organization_memberships
         SET status=$3,updated_by=$4,updated_at=now()
         WHERE subject_user_id=$1 AND organization_id=$2`, [
        input.targetUserId,
        input.tenantId,
        membershipStatus,
        input.updatedBy,
      ]);
      const activeMemberships = await client.query(
        "SELECT 1 FROM organization_memberships WHERE subject_user_id=$1 AND status='active' LIMIT 1",
        [input.targetUserId],
      );
      await client.query("UPDATE users SET status=$2,updated_at=now() WHERE id=$1", [
        input.targetUserId,
        activeMemberships.rowCount ? "active" : "disabled",
      ]);
      let revokedSessions = 0;
      if (input.status === "disabled") {
        const revoked = await client.query(
          "UPDATE browser_sessions SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL RETURNING id",
          [target.rows[0].membership_id],
        );
        revokedSessions = revoked.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { status: input.status, revokedSessions };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeUserSessions(input: { tenantId: string; targetUserId: string; revokedBy: string }) {
    const target = await this.pool.query(
      `SELECT m.id AS membership_id
       FROM organization_memberships m
       WHERE m.subject_user_id=$1 AND m.organization_id=$2`,
      [input.targetUserId, input.tenantId],
    );
    if (!target.rowCount) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
    const revoked = await this.pool.query(
      "UPDATE browser_sessions SET revoked_at=now() WHERE membership_id=$1 AND revoked_at IS NULL RETURNING id",
      [target.rows[0].membership_id],
    );
    return revoked.rowCount ?? 0;
  }

  async assignMvpPolicy(input: { tenantId: string; targetUserId: string; assignedBy: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const policy = await this.assignMvpPolicyWithClient(client, input.tenantId, input.targetUserId, input.assignedBy);
      await client.query("COMMIT");
      return policy;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async revokeMvpPolicy(input: { tenantId: string; targetUserId: string; revokedBy: string }) {
    const result = await this.pool.query(
      `UPDATE policy_assignments SET revoked_at=now(),revoked_by=$3
       WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`,
      [input.tenantId, input.targetUserId, input.revokedBy],
    );
    return Boolean(result.rowCount);
  }

  async createMvpPolicyVersion(input: { tenantId: string; createdBy: string; revisionNote: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [input.createdBy, input.tenantId]);
      if (!user.rowCount) throw new Error("Policy creator is outside the tenant");
      const bundleId = mvpPolicyBundleId(input.tenantId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-version:${bundleId}`]);
      await this.ensurePolicyFoundation(client, input.tenantId, input.createdBy);
      const latest = await client.query("SELECT COALESCE(max(version),0) AS version FROM policy_versions WHERE policy_bundle_id=$1", [bundleId]);
      const version = Number(latest.rows[0].version) + 1;
      const document = mvpPolicyDocument(input.revisionNote);
      const documentHash = policyHash(document);
      const id = randomUUID();
      await client.query(
        "INSERT INTO policy_versions (id,policy_bundle_id,version,document,document_hash,created_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6)",
        [id, bundleId, version, JSON.stringify(document), documentHash, input.createdBy],
      );
      await client.query("COMMIT");
      return { id, version, documentHash };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async updateMvpToolPolicy(input: { tenantId: string; updatedBy: string; tools: Record<string, McpToolPolicyDecision> }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const bundleId = mvpPolicyBundleId(input.tenantId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-version:${bundleId}`]);
      await this.ensurePolicyFoundation(client, input.tenantId, input.updatedBy);
      const latest = await client.query(
        "SELECT id,version,document FROM policy_versions WHERE policy_bundle_id=$1 ORDER BY version DESC LIMIT 1",
        [bundleId],
      );
      const document = structuredClone((latest.rows[0]?.document ?? mvpPolicyDocument()) as OwnedJson) as Record<string, OwnedJson>;
      applyMvpSandboxCatalog(document);
      document.revisionNote = "Updated Microsoft 365 tool approval rules";
      const mcp = document.mcp as Record<string, OwnedJson>;
      const servers = mcp.servers as Record<string, OwnedJson>;
      const server = servers.lemmacomputer_ms365 as Record<string, OwnedJson>;
      server.tools = Object.keys(input.tools);
      server.toolPolicies = input.tools;
      const documentHash = policyHash(document);
      const existing = await client.query(
        "SELECT id,version FROM policy_versions WHERE policy_bundle_id=$1 AND document_hash=$2",
        [bundleId, documentHash],
      );
      let id: string;
      let version: number;
      if (existing.rowCount) {
        id = String(existing.rows[0].id);
        version = Number(existing.rows[0].version);
      } else {
        version = Number(latest.rows[0]?.version ?? 0) + 1;
        id = randomUUID();
        await client.query(
          "INSERT INTO policy_versions (id,policy_bundle_id,version,document,document_hash,created_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6)",
          [id, bundleId, version, JSON.stringify(document), documentHash, input.updatedBy],
        );
      }
      const assignments = await client.query(
        `SELECT pa.id,pa.tenant_id,pa.user_id,pa.agent_id,pa.egress_security_group_version_id
         FROM policy_assignments pa JOIN policy_versions pv ON pv.id=pa.policy_version_id
         WHERE pa.tenant_id=$1 AND pv.policy_bundle_id=$2 AND pa.revoked_at IS NULL FOR UPDATE`,
        [input.tenantId, bundleId],
      );
      for (const assignment of assignments.rows) {
        await client.query("UPDATE policy_assignments SET revoked_at=now(),revoked_by=$2 WHERE id=$1", [assignment.id, input.updatedBy]);
        const replacementId = randomUUID();
        await client.query(
          `INSERT INTO policy_assignments (id,tenant_id,user_id,agent_id,policy_version_id,egress_security_group_version_id,assigned_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [replacementId, assignment.tenant_id, assignment.user_id, assignment.agent_id, id, assignment.egress_security_group_version_id, input.updatedBy],
        );
        await client.query(
          "INSERT INTO capability_assignments (policy_assignment_id,capability_id) SELECT $1,capability_id FROM capability_assignments WHERE policy_assignment_id=$2",
          [replacementId, assignment.id],
        );
      }
      await client.query("COMMIT");
      return { id, version, documentHash };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async listEgressSecurityGroups(tenantId: string, createdBy?: string) {
    if (createdBy) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await this.ensurePolicyFoundation(client, tenantId, createdBy);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }
    const result = await this.pool.query(
      `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
       esgv.version AS egress_version,esgv.document AS egress_document,
       esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
       esgv.created_at AS egress_created_at
       FROM egress_security_group_versions esgv
       JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
       WHERE esg.tenant_id=$1
       ORDER BY esg.name,esgv.version DESC`,
      [tenantId],
    );
    return result.rows.map(mapEgressVersion);
  }

  async saveEgressSecurityGroup(input: { tenantId: string; updatedBy: string; securityGroupId?: string; name: string; description: string; defaultAction: "deny" | "allow-public-http-https"; rules: EgressSecurityGroupRule[] }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [input.updatedBy, input.tenantId]);
      if (!actor.rowCount) throw new LemmaComputerError("EGRESS_TENANT_MISMATCH", "Firewall editor is outside the tenant", 403);
      const securityGroupId = input.securityGroupId ?? `esg_${randomUUID().replaceAll("-", "")}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`egress-security-group:${securityGroupId}`]);
      const existingGroup = await client.query(
        "SELECT id FROM egress_security_groups WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [securityGroupId, input.tenantId],
      );
      if (input.securityGroupId && !existingGroup.rowCount) throw new LemmaComputerError("EGRESS_SECURITY_GROUP_NOT_FOUND", "Network security group not found", 404);
      if (!existingGroup.rowCount) {
        await client.query(
          `INSERT INTO egress_security_groups (id,tenant_id,name,description,created_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [securityGroupId, input.tenantId, input.name, input.description, input.updatedBy],
        );
      }
      const latest = await client.query(
        "SELECT COALESCE(max(version),0) AS version FROM egress_security_group_versions WHERE security_group_id=$1",
        [securityGroupId],
      );
      const version = Number(latest.rows[0].version) + 1;
      const id = `egv_${randomUUID().replaceAll("-", "")}`;
      const provisional = egressSecurityGroupVersionSchema.parse({
        schemaVersion: 1,
        id,
        securityGroupId,
        tenantId: input.tenantId,
        version,
        name: input.name,
        description: input.description,
        defaultAction: input.defaultAction,
        rules: input.rules,
        documentHash: "0".repeat(64),
        createdBy: input.updatedBy,
        createdAt: new Date().toISOString(),
      });
      const compiled = compileEgressSecurityGroup(provisional);
      const document = {
        schemaVersion: 1,
        name: input.name,
        description: input.description,
        defaultAction: input.defaultAction,
        rules: compiled.rules,
      } satisfies OwnedJson;
      const documentHash = policyHash(document);
      const unchanged = await client.query(
        `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
         esgv.version AS egress_version,esgv.document AS egress_document,
         esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
         esgv.created_at AS egress_created_at
         FROM egress_security_group_versions esgv
         JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
         WHERE esgv.security_group_id=$1 AND esgv.document_hash=$2`,
        [securityGroupId, documentHash],
      );
      if (unchanged.rowCount) {
        await client.query("COMMIT");
        return mapEgressVersion(unchanged.rows[0]);
      }
      const inserted = await client.query(
        `INSERT INTO egress_security_group_versions (id,security_group_id,version,document,document_hash,created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING created_at`,
        [id, securityGroupId, version, JSON.stringify(document), documentHash, input.updatedBy],
      );
      await client.query(
        "UPDATE egress_security_groups SET name=$2,description=$3,updated_at=now() WHERE id=$1",
        [securityGroupId, input.name, input.description],
      );
      await client.query("COMMIT");
      return egressSecurityGroupVersionSchema.parse({
        ...provisional,
        rules: compiled.rules,
        documentHash,
        createdAt: new Date(String(inserted.rows[0].created_at)).toISOString(),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async getWorkspaceEgressSecurityGroup(input: { tenantId: string; subjectId: string; grantId: string }) {
    const result = await this.pool.query(
      `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
       esgv.version AS egress_version,esgv.document AS egress_document,
       esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
       esgv.created_at AS egress_created_at
       FROM workspace_egress_security_group_assignments assignment
       JOIN egress_security_groups esg ON esg.id=assignment.security_group_id
       JOIN LATERAL (
         SELECT *
         FROM egress_security_group_versions candidate
         WHERE candidate.security_group_id=assignment.security_group_id
         ORDER BY candidate.version DESC
         LIMIT 1
       ) esgv ON true
       WHERE assignment.tenant_id=$1 AND assignment.subject_id=$2 AND assignment.grant_id=$3`,
      [input.tenantId, input.subjectId, input.grantId],
    );
    if (result.rowCount) return mapEgressVersion(result.rows[0]);
    const fallback = await this.pool.query(
      `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
       esgv.version AS egress_version,esgv.document AS egress_document,
       esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
       esgv.created_at AS egress_created_at
       FROM egress_security_group_versions esgv
       JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
       WHERE esgv.security_group_id=$1 AND esg.tenant_id=$2
       ORDER BY esgv.version DESC
       LIMIT 1`,
      [defaultEgressSecurityGroupId(input.tenantId), input.tenantId],
    );
    return fallback.rowCount ? mapEgressVersion(fallback.rows[0]) : null;
  }

  async listWorkspaceEgressSecurityGroupAssignments(input: { tenantId: string; securityGroupId: string }) {
    const result = await this.pool.query(
      `SELECT workspace.subject_id,workspace.grant_id
       FROM workspaces workspace
       LEFT JOIN workspace_egress_security_group_assignments assignment
         ON assignment.tenant_id=workspace.tenant_id
        AND assignment.subject_id=workspace.subject_id
        AND assignment.grant_id=workspace.grant_id
       WHERE workspace.tenant_id=$1
         AND (
           assignment.security_group_id=$2
           OR (
             assignment.security_group_id IS NULL
             AND $2=$3
           )
         )
       ORDER BY workspace.subject_id,workspace.grant_id`,
      [input.tenantId, input.securityGroupId, defaultEgressSecurityGroupId(input.tenantId)],
    );
    return result.rows.map((row) => ({
      subjectId: String(row.subject_id),
      grantId: String(row.grant_id),
    }));
  }

  async assignWorkspaceEgressSecurityGroup(input: { tenantId: string; subjectId: string; grantId: string; assignedBy: string; securityGroupVersionId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query(
        "SELECT id FROM users WHERE id=$1 AND tenant_id=$2",
        [input.subjectId, input.tenantId],
      );
      if (!target.rowCount) throw new LemmaComputerError("USER_NOT_FOUND", "Workspace owner not found", 404);
      const version = await client.query(
        `SELECT esg.tenant_id,esgv.id AS egress_version_id,esgv.security_group_id,
         esgv.version AS egress_version,esgv.document AS egress_document,
         esgv.document_hash AS egress_document_hash,esgv.created_by AS egress_created_by,
         esgv.created_at AS egress_created_at
         FROM egress_security_group_versions esgv
         JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
         WHERE esgv.id=$1 AND esg.tenant_id=$2`,
        [input.securityGroupVersionId, input.tenantId],
      );
      if (!version.rowCount) throw new LemmaComputerError("EGRESS_SECURITY_GROUP_NOT_FOUND", "Security group version not found", 404);
      await client.query(
        `INSERT INTO workspace_egress_security_group_assignments
         (tenant_id,subject_id,grant_id,security_group_id,assigned_by,assigned_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (tenant_id,subject_id,grant_id) DO UPDATE
         SET security_group_id=EXCLUDED.security_group_id,
             assigned_by=EXCLUDED.assigned_by,
             assigned_at=now()`,
        [input.tenantId, input.subjectId, input.grantId, version.rows[0].security_group_id, input.assignedBy],
      );
      await client.query("COMMIT");
      return mapEgressVersion(version.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async assignEgressSecurityGroup(input: { tenantId: string; targetUserId: string; assignedBy: string; securityGroupVersionId: string }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-assignment:${input.tenantId}:${input.targetUserId}`]);
      const target = await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [input.targetUserId, input.tenantId]);
      if (!target.rowCount) throw new LemmaComputerError("USER_NOT_FOUND", "User not found", 404);
      const groupVersion = await client.query(
        `SELECT esgv.id FROM egress_security_group_versions esgv
         JOIN egress_security_groups esg ON esg.id=esgv.security_group_id
         WHERE esgv.id=$1 AND esg.tenant_id=$2`,
        [input.securityGroupVersionId, input.tenantId],
      );
      if (!groupVersion.rowCount) throw new LemmaComputerError("EGRESS_SECURITY_GROUP_NOT_FOUND", "Network security group version not found", 404);
      const current = await client.query(
        `SELECT id,tenant_id,user_id,agent_id,policy_version_id
         FROM policy_assignments WHERE user_id=$1 AND tenant_id=$2 AND revoked_at IS NULL
         ORDER BY assigned_at DESC LIMIT 1 FOR UPDATE`,
        [input.targetUserId, input.tenantId],
      );
      if (!current.rowCount) throw new LemmaComputerError("POLICY_ASSIGNMENT_NOT_FOUND", "Assign a workspace policy before attaching a network security group", 409);
      const assignment = current.rows[0];
      await client.query("UPDATE policy_assignments SET revoked_at=now(),revoked_by=$2 WHERE id=$1", [assignment.id, input.assignedBy]);
      const replacementId = randomUUID();
      await client.query(
        `INSERT INTO policy_assignments (id,tenant_id,user_id,agent_id,policy_version_id,egress_security_group_version_id,assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [replacementId, assignment.tenant_id, assignment.user_id, assignment.agent_id, assignment.policy_version_id, input.securityGroupVersionId, input.assignedBy],
      );
      await client.query(
        "INSERT INTO capability_assignments (policy_assignment_id,capability_id) SELECT $1,capability_id FROM capability_assignments WHERE policy_assignment_id=$2",
        [replacementId, assignment.id],
      );
      const result = await client.query(effectivePolicySelect, [input.targetUserId]);
      await client.query("COMMIT");
      return mapPolicy(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async ensurePolicyFoundation(client: pg.PoolClient, tenantId: string, createdBy: string) {
    const bundleId = mvpPolicyBundleId(tenantId);
    await client.query("INSERT INTO policy_bundles (id,tenant_id,display_name) VALUES ($1,$2,'MVP standard workspace') ON CONFLICT DO NOTHING", [bundleId, tenantId]);
    for (const capability of [
      ["ai-assistant", "AI assistant", "standard"],
      ["coding-tools", "Coding tools", "standard"],
      ["m365-read", "Microsoft 365 read", "standard"],
      ["m365-write-protected", "Microsoft 365 protected writes", "protected"],
    ]) {
      await client.query("INSERT INTO capabilities (id,display_name,risk) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", capability);
    }
    const document = mvpPolicyDocument();
    await client.query(
      `INSERT INTO policy_versions (id,policy_bundle_id,version,document,document_hash,created_by)
       VALUES ($1,$2,1,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(), bundleId, JSON.stringify(document), policyHash(document), createdBy],
    );
    const egressDocument = defaultEgressDocument();
    const securityGroupId = defaultEgressSecurityGroupId(tenantId);
    const securityGroupVersionId = defaultEgressSecurityGroupVersionId(tenantId);
    await client.query(
      `INSERT INTO egress_security_groups (id,tenant_id,name,description,created_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [securityGroupId, tenantId, egressDocument.name, egressDocument.description, createdBy],
    );
    await client.query(
      `INSERT INTO egress_security_group_versions (id,security_group_id,version,document,document_hash,created_by)
       VALUES ($1,$2,1,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING`,
      [securityGroupVersionId, securityGroupId, JSON.stringify(egressDocument), policyHash(egressDocument), createdBy],
    );
    await client.query(
      `UPDATE policy_assignments pa SET egress_security_group_version_id=$2
       WHERE pa.tenant_id=$1
       AND pa.revoked_at IS NULL AND pa.egress_security_group_version_id IS NULL`,
      [tenantId, securityGroupVersionId],
    );
  }

  private async assignMvpPolicyWithClient(client: pg.PoolClient, tenantId: string, targetUserId: string, assignedBy: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`policy-assignment:${tenantId}:${targetUserId}`]);
    const owned = await client.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2", [targetUserId, tenantId]);
    if (!owned.rowCount) throw new Error("Policy target is outside the tenant");
    await this.ensurePolicyFoundation(client, tenantId, assignedBy);
    // The per-user advisory lock above serializes assignment changes. Do not
    // append FOR UPDATE here: effectivePolicySelect contains nullable outer
    // joins, which PostgreSQL correctly refuses to lock as a single rowset.
    const existing = await client.query(effectivePolicySelect, [targetUserId]);
    if (existing.rowCount) return mapPolicy(existing.rows[0]);
    const resources = await client.query(
      `SELECT a.id AS agent_id,pv.id AS policy_version_id
       FROM agent_identities a
       CROSS JOIN LATERAL (SELECT id FROM policy_versions WHERE policy_bundle_id=$2 ORDER BY version DESC LIMIT 1) pv
       WHERE a.owner_user_id=$1 AND a.status='active' LIMIT 1`,
      [targetUserId, mvpPolicyBundleId(tenantId)],
    );
    if (!resources.rowCount) throw new Error("Policy target agent identity is missing");
    const assignmentId = randomUUID();
    await client.query(
      `INSERT INTO policy_assignments (id,tenant_id,user_id,agent_id,policy_version_id,egress_security_group_version_id,assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [assignmentId, tenantId, targetUserId, resources.rows[0].agent_id, resources.rows[0].policy_version_id, defaultEgressSecurityGroupVersionId(tenantId), assignedBy],
    );
    await client.query(
      "INSERT INTO capability_assignments (policy_assignment_id,capability_id) SELECT $1,id FROM capabilities ON CONFLICT DO NOTHING",
      [assignmentId],
    );
    const result = await client.query(effectivePolicySelect, [targetUserId]);
    return mapPolicy(result.rows[0]);
  }
}
