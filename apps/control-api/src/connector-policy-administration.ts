import { createHash } from "node:crypto";
import { canonicalJson, type McpToolPolicyDecision } from "@lemmacomputer/contracts";

type PolicySourceKind = "protected_baseline" | "organization_policy" | "connector_policy";

export type ConnectorPolicySource = {
  kind: PolicySourceKind;
  sourceId: string;
  version: number;
  documentHash: string;
};

export type EffectiveConnectorPolicyInput = {
  baseline: {
    templateVersionId: string;
    version: number;
    documentHash: string;
    connectors: {
      allow: string[];
      deny: string[];
      toolPolicies: Record<string, Record<string, McpToolPolicyDecision>>;
    };
  };
  organizationPolicy?: {
    policyVersionId: string;
    version: number;
    documentHash: string;
    connectors?: {
      allow?: string[];
      deny: string[];
      toolPolicies: Record<string, Record<string, McpToolPolicyDecision>>;
    };
  } | null;
  connector: {
    id: string;
    name: string;
    enabled: boolean;
    membersCanManage: boolean;
    accessPolicyVersion: number;
    accessPolicyUpdatedAt: string;
    configuredToolPolicies: Record<string, McpToolPolicyDecision>;
    toolDisplayNames: Record<string, string>;
    reviewedToolDefinitionHashes: Record<string, string>;
    connectionState: "connected" | "expired" | "disconnected";
    reviewMode: "product_owned" | "provider_definition_hash";
  };
  observedTools: Array<{ name: string; definitionHash: string }> | null;
  policyApplication?: ConnectorPolicyApplicationView;
};

export type ConnectorPolicyMemberVersionInput = {
  userId: string;
  status: "active" | "disabled";
  policy: {
    policyVersionId: string;
    version: number;
    documentHash: string;
  } | null;
};

export type ConnectorPolicyApplicationView = {
  state: "not_applicable" | "empty" | "current" | "mixed" | "conflict" | "unassigned";
  currentVersion: {
    version: number;
    documentHash: string;
  } | null;
  activeMembers: number;
  currentMembers: number;
  remediationRequiredMembers: number;
  unassignedMembers: number;
  versions: Array<{
    version: number;
    documentHash: string;
    memberCount: number;
  }>;
};

export type EffectiveConnectorToolPolicy = {
  name: string;
  displayName: string;
  configuredDecision: McpToolPolicyDecision;
  effectiveDecision: McpToolPolicyDecision;
  reviewState: "product_owned" | "current" | "awaiting_review" | "not_checked" | "removed";
  observedDefinitionHash: string | null;
  reviewedDefinitionHash: string | null;
  sources: Array<ConnectorPolicySource & { decision: McpToolPolicyDecision }>;
};

export type EffectiveConnectorPolicyView = {
  connector: {
    id: string;
    name: string;
  };
  access: {
    configuredEnabled: boolean;
    effectiveDecision: "allow" | "deny";
    membersCanManage: boolean;
    accessPolicyVersion: number;
    updatedAt: string;
    reason: "allowed" | "protected_baseline_denied" | "organization_policy_denied" | "connector_disabled";
    controllingSource: ConnectorPolicySource;
  };
  sources: ConnectorPolicySource[];
  tools: EffectiveConnectorToolPolicy[];
  runtimeProjection: {
    scope: "requesting_administrator";
    state: "excluded" | "connection_required" | "awaiting_review" | "partially_available" | "eligible";
    allowed: number;
    approvalRequired: number;
    denied: number;
  };
  policyApplication: ConnectorPolicyApplicationView;
  remediation: {
    required: boolean;
    reasons: Array<
      | "policy_change_required"
      | "tool_review_required"
      | "requesting_administrator_connection_required"
    >;
    workspaceGrantRefresh: {
      status: "not_observed";
      trigger: "automatic_after_policy_save";
    };
    restartRequired: false;
  };
};

const notApplicablePolicyApplication = (): ConnectorPolicyApplicationView => ({
  state: "not_applicable",
  currentVersion: null,
  activeMembers: 0,
  currentMembers: 0,
  remediationRequiredMembers: 0,
  unassignedMembers: 0,
  versions: [],
});

export const resolveConnectorPolicyApplication = (
  members: ConnectorPolicyMemberVersionInput[],
  authority?: {
    currentVersion: ConnectorPolicyApplicationView["currentVersion"];
    conflict: boolean;
  },
): ConnectorPolicyApplicationView => {
  const active = members.filter((member) => member.status === "active");
  if (!active.length) return { ...notApplicablePolicyApplication(), state: "empty" };
  const assigned = active.filter((member): member is ConnectorPolicyMemberVersionInput & {
    policy: NonNullable<ConnectorPolicyMemberVersionInput["policy"]>;
  } => Boolean(member.policy));
  const unassignedMembers = active.length - assigned.length;
  if (!assigned.length) {
    return {
      state: "unassigned",
      currentVersion: null,
      activeMembers: active.length,
      currentMembers: 0,
      remediationRequiredMembers: active.length,
      unassignedMembers,
      versions: [],
    };
  }
  const grouped = new Map<string, ConnectorPolicyApplicationView["versions"][number]>();
  for (const member of assigned) {
    const key = `${member.policy.version}\0${member.policy.documentHash}`;
    const current = grouped.get(key);
    grouped.set(key, current
      ? { ...current, memberCount: current.memberCount + 1 }
      : { version: member.policy.version, documentHash: member.policy.documentHash, memberCount: 1 });
  }
  const versions = [...grouped.values()].sort((left, right) => (
    right.version - left.version || left.documentHash.localeCompare(right.documentHash)
  ));
  const newest = versions.filter((version) => version.version === versions[0]!.version);
  const conflict = authority?.conflict ?? newest.length > 1;
  const derivedCurrentVersion = newest.length > 1 ? null : newest[0]!;
  const currentVersion = conflict ? null : authority?.currentVersion ?? derivedCurrentVersion;
  const currentMembers = currentVersion
    ? versions.find((version) => version.version === currentVersion.version && version.documentHash === currentVersion.documentHash)?.memberCount ?? 0
    : 0;
  const remediationRequiredMembers = active.length - currentMembers;
  return {
    state: conflict
      ? "conflict"
      : remediationRequiredMembers || versions.length > 1
        ? "mixed"
        : "current",
    currentVersion: currentVersion ? {
      version: currentVersion.version,
      documentHash: currentVersion.documentHash,
    } : null,
    activeMembers: active.length,
    currentMembers,
    remediationRequiredMembers,
    unassignedMembers,
    versions,
  };
};

const decisionRank = (decision: McpToolPolicyDecision) => ({ allow: 0, approval_required: 1, deny: 2 })[decision];

const strictestDecision = (decisions: McpToolPolicyDecision[]) => decisions.reduce(
  (strictest, decision) => decisionRank(decision) > decisionRank(strictest) ? decision : strictest,
);

const connectorSource = (input: EffectiveConnectorPolicyInput): ConnectorPolicySource => {
  const document = {
    connectorId: input.connector.id,
    enabled: input.connector.enabled,
    membersCanManage: input.connector.membersCanManage,
    toolPolicies: input.connector.configuredToolPolicies,
    toolDefinitionHashes: input.connector.reviewedToolDefinitionHashes,
  };
  return {
    kind: "connector_policy",
    sourceId: input.connector.id,
    version: input.connector.accessPolicyVersion,
    documentHash: createHash("sha256").update(canonicalJson(document), "utf8").digest("hex"),
  };
};

const baselineSource = (input: EffectiveConnectorPolicyInput): ConnectorPolicySource => ({
  kind: "protected_baseline",
  sourceId: input.baseline.templateVersionId,
  version: input.baseline.version,
  documentHash: input.baseline.documentHash,
});

const organizationSource = (input: EffectiveConnectorPolicyInput): ConnectorPolicySource | null => input.organizationPolicy ? ({
  kind: "organization_policy",
  sourceId: input.organizationPolicy.policyVersionId,
  version: input.organizationPolicy.version,
  documentHash: input.organizationPolicy.documentHash,
}) : null;

export const resolveEffectiveConnectorPolicy = (
  input: EffectiveConnectorPolicyInput,
): EffectiveConnectorPolicyView => {
  const baseline = baselineSource(input);
  const organization = organizationSource(input);
  const configured = connectorSource(input);
  const sources = [baseline, ...(organization ? [organization] : []), configured];
  const baselineAllowed = input.baseline.connectors.allow.includes(input.connector.id)
    && !input.baseline.connectors.deny.includes(input.connector.id);
  const organizationConnectors = input.organizationPolicy?.connectors;
  const organizationAllowed = !organizationConnectors?.deny.includes(input.connector.id)
    && (!organizationConnectors?.allow || organizationConnectors.allow.includes(input.connector.id));
  const access = !baselineAllowed
    ? { effectiveDecision: "deny" as const, reason: "protected_baseline_denied" as const, controllingSource: baseline }
    : !organizationAllowed
      ? { effectiveDecision: "deny" as const, reason: "organization_policy_denied" as const, controllingSource: organization! }
      : !input.connector.enabled
        ? { effectiveDecision: "deny" as const, reason: "connector_disabled" as const, controllingSource: configured }
        : { effectiveDecision: "allow" as const, reason: "allowed" as const, controllingSource: configured };

  const baselineTools = input.baseline.connectors.toolPolicies[input.connector.id] ?? {};
  const organizationTools = organizationConnectors?.toolPolicies[input.connector.id] ?? {};
  const observedByName = input.observedTools === null
    ? null
    : new Map(input.observedTools.map((tool) => [tool.name, tool]));
  const toolNames = [...new Set([
    ...Object.keys(baselineTools),
    ...Object.keys(organizationTools),
    ...Object.keys(input.connector.configuredToolPolicies),
    ...Object.keys(input.connector.reviewedToolDefinitionHashes),
    ...(input.observedTools?.map((tool) => tool.name) ?? []),
  ])].sort();

  const tools = toolNames.map((name): EffectiveConnectorToolPolicy => {
    const configuredDecision = input.connector.configuredToolPolicies[name] ?? "deny";
    const baselineDecision = baselineTools[name] ?? "deny";
    const organizationDecision = organizationTools[name];
    const policyDecision = strictestDecision([
      baselineDecision,
      ...(organizationDecision ? [organizationDecision] : []),
      configuredDecision,
    ]);
    const observed = observedByName?.get(name) ?? null;
    const reviewedDefinitionHash = input.connector.reviewedToolDefinitionHashes[name] ?? null;
    const reviewState = input.connector.reviewMode === "product_owned"
      ? "product_owned" as const
      : observedByName === null
        ? "not_checked" as const
        : !observed
          ? "removed" as const
          : reviewedDefinitionHash === observed.definitionHash
            && Object.hasOwn(input.connector.configuredToolPolicies, name)
            ? "current" as const
            : "awaiting_review" as const;
    const reviewAllowsProjection = reviewState === "product_owned" || reviewState === "current";
    const effectiveDecision = access.effectiveDecision === "allow" && reviewAllowsProjection
      ? policyDecision
      : "deny";
    return {
      name,
      displayName: input.connector.toolDisplayNames[name]
        ?? name.split(/[-_]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "),
      configuredDecision,
      effectiveDecision,
      reviewState,
      observedDefinitionHash: observed?.definitionHash ?? null,
      reviewedDefinitionHash,
      sources: [
        { ...baseline, decision: baselineDecision },
        ...(organization && organizationDecision ? [{ ...organization, decision: organizationDecision }] : []),
        { ...configured, decision: configuredDecision },
      ],
    };
  });

  const counts = tools.reduce((summary, tool) => ({
    allowed: summary.allowed + Number(tool.effectiveDecision === "allow"),
    approvalRequired: summary.approvalRequired + Number(tool.effectiveDecision === "approval_required"),
    denied: summary.denied + Number(tool.effectiveDecision === "deny"),
  }), { allowed: 0, approvalRequired: 0, denied: 0 });
  const reviewBlocked = tools.filter((tool) => ["awaiting_review", "not_checked"].includes(tool.reviewState)).length;
  const usable = counts.allowed + counts.approvalRequired;
  const runtimeState = access.effectiveDecision === "deny"
    ? "excluded" as const
    : input.connector.connectionState !== "connected"
      ? "connection_required" as const
      : reviewBlocked && usable
        ? "partially_available" as const
        : reviewBlocked
          ? "awaiting_review" as const
          : "eligible" as const;
  const policyApplication = input.policyApplication ?? notApplicablePolicyApplication();
  const remediationReasons: EffectiveConnectorPolicyView["remediation"]["reasons"] = [];
  if (access.effectiveDecision === "deny") remediationReasons.push("policy_change_required");
  if (reviewBlocked) remediationReasons.push("tool_review_required");
  if (access.effectiveDecision === "allow" && input.connector.connectionState !== "connected") {
    remediationReasons.push("requesting_administrator_connection_required");
  }

  return {
    connector: { id: input.connector.id, name: input.connector.name },
    access: {
      configuredEnabled: input.connector.enabled,
      effectiveDecision: access.effectiveDecision,
      membersCanManage: access.effectiveDecision === "allow" && input.connector.membersCanManage,
      accessPolicyVersion: input.connector.accessPolicyVersion,
      updatedAt: input.connector.accessPolicyUpdatedAt,
      reason: access.reason,
      controllingSource: access.controllingSource,
    },
    sources,
    tools,
    runtimeProjection: { scope: "requesting_administrator", state: runtimeState, ...counts },
    policyApplication,
    remediation: {
      required: remediationReasons.length > 0,
      reasons: remediationReasons,
      workspaceGrantRefresh: {
        status: "not_observed",
        trigger: "automatic_after_policy_save",
      },
      restartRequired: false,
    },
  };
};
