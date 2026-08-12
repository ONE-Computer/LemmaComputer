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
    reviewedToolDefinitionHashes: Record<string, string>;
    connectionState: "connected" | "expired" | "disconnected";
    reviewMode: "product_owned" | "provider_definition_hash";
  };
  observedTools: Array<{ name: string; definitionHash: string }> | null;
};

export type EffectiveConnectorToolPolicy = {
  name: string;
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
    state: "excluded" | "connection_required" | "awaiting_review" | "partially_available" | "eligible";
    allowed: number;
    approvalRequired: number;
    denied: number;
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
    runtimeProjection: { state: runtimeState, ...counts },
  };
};
