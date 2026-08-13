import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

export const productServiceClasses = ["lite", "balanced", "pro"] as const;
export const requestedServiceClasses = [
  "auto",
  ...productServiceClasses,
] as const;
export const internalTaskClasses = [
  "simple",
  "medium",
  "complex",
  "reasoning",
] as const;
export const routingModes = ["disabled", "shadow", "enabled"] as const;
export type ProductServiceClass = (typeof productServiceClasses)[number];
export type RequestedServiceClass = (typeof requestedServiceClasses)[number];
export type InternalTaskClass = (typeof internalTaskClasses)[number];
export type RoutingMode = (typeof routingModes)[number];
export type ManagedRoutingProvider =
  "foundry" | "openai" | "anthropic" | "glm" | "bedrock";
export const productReasoningEfforts = ["auto", "low", "medium", "high"] as const;
export const resolvedReasoningEfforts = ["low", "medium", "high"] as const;
export type ProductReasoningEffort = (typeof productReasoningEfforts)[number];
export type ResolvedReasoningEffort = (typeof resolvedReasoningEfforts)[number];
export type QualifiedReasoningCapabilities = {
  qualificationId: string;
  providerMechanism: string;
  thinkingMode: "adaptive" | "budgeted" | "opaque";
  effortLevels: ResolvedReasoningEffort[];
  defaultEffort: ResolvedReasoningEffort;
  interleavedThinking: boolean;
  reasoningTokenTelemetry: boolean;
};

type ReasoningRouteReviewBase = {
  provider: ManagedRoutingProvider;
  providerModels: readonly string[];
  providerMechanism: string;
  effortLevels: readonly ResolvedReasoningEffort[];
};

export type ReasoningRouteQualificationRegistration = ReasoningRouteReviewBase & {
  reviewStatus: "qualified";
  qualificationId: string;
  thinkingMode: QualifiedReasoningCapabilities["thinkingMode"];
  defaultEffort: ResolvedReasoningEffort;
  interleavedThinking: boolean;
  reasoningTokenTelemetry: boolean;
};

export type ReasoningRouteDiscovery = ReasoningRouteReviewBase & {
  reviewStatus: "discovery";
  discoveryId: string;
  blockingEvidence: readonly string[];
};

export type ReasoningRouteReview =
  | ReasoningRouteQualificationRegistration
  | ReasoningRouteDiscovery;

export type AgentReasoningAdapterQualification = {
  qualificationId: string;
  agentCatalogId: string;
  clientVersion: string;
  effortLevels: ResolvedReasoningEffort[];
  conversationPinned: true;
  signedTaskBinding: true;
  providerEffortAuthority: "governed-route";
};

type AgentReasoningAdapterReviewBase = {
  agentCatalogId: string;
  clientVersion: string;
  effortLevels: readonly ResolvedReasoningEffort[];
  conversationPinned: true;
  signedTaskBinding: true;
  providerEffortAuthority: "governed-route";
};

export type AgentReasoningAdapterRegistration = AgentReasoningAdapterReviewBase & {
  reviewStatus: "qualified";
  qualificationId: string;
};

export type AgentReasoningAdapterDiscovery = AgentReasoningAdapterReviewBase & {
  reviewStatus: "discovery";
  discoveryId: string;
  blockingEvidence: readonly string[];
};

export type AgentReasoningAdapterReview =
  | AgentReasoningAdapterRegistration
  | AgentReasoningAdapterDiscovery;

export const anthropicReasoningRouteQualificationId = "anthropic-claude-4.6-4.8-effort-route-2026-08-13";
export const openAiReasoningRouteDiscoveryId = "openai-gpt-5.6-managed-effort-route-discovery-2026-08-13";
export const openAiReasoningRouteQualificationId = "openai-gpt-5.6-responses-effort-route-2026-08-13";
export const claudeReasoningAdapterQualificationId = "claude-cli-2.1.215-governed-effort-adapter-2026-08-13";
export const hermesReasoningAdapterDiscoveryId = "hermes-claw-0.19.0-governed-effort-discovery-2026-08-13";
export const hermesReasoningAdapterQualificationId = "hermes-claw-0.19.0-governed-effort-adapter-2026-08-13";
export const hermesDesktopReasoningAdapterQualificationId = "hermes-desktop-0.17.0-governed-effort-adapter-2026-08-13";
export const codexReasoningAdapterDiscoveryId = "codex-cli-0.144.4-governed-effort-discovery-2026-08-13";

const reviewedReasoningRoutes: readonly ReasoningRouteReview[] = Object.freeze([
  Object.freeze({
    reviewStatus: "qualified",
    qualificationId: anthropicReasoningRouteQualificationId,
    provider: "anthropic",
    providerModels: Object.freeze(["claude-sonnet-4-6", "claude-opus-4-8"]),
    providerMechanism: "anthropic-adaptive-effort",
    thinkingMode: "adaptive",
    effortLevels: resolvedReasoningEfforts,
    defaultEffort: "high",
    interleavedThinking: true,
    reasoningTokenTelemetry: true,
  }),
  Object.freeze({
    reviewStatus: "qualified",
    qualificationId: openAiReasoningRouteQualificationId,
    provider: "openai",
    providerModels: Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    providerMechanism: "openai-responses-reasoning-effort",
    thinkingMode: "opaque",
    effortLevels: resolvedReasoningEfforts,
    defaultEffort: "medium",
    interleavedThinking: false,
    reasoningTokenTelemetry: false,
  }),
]);

const reviewedAgentReasoningAdapters: readonly AgentReasoningAdapterReview[] = Object.freeze([
  Object.freeze({
    reviewStatus: "qualified",
    qualificationId: claudeReasoningAdapterQualificationId,
    agentCatalogId: "claude-cli",
    clientVersion: "2.1.215",
    effortLevels: resolvedReasoningEfforts,
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
  }),
  Object.freeze({
    reviewStatus: "qualified",
    qualificationId: hermesReasoningAdapterQualificationId,
    agentCatalogId: "hermes-claw",
    clientVersion: "0.19.0",
    effortLevels: resolvedReasoningEfforts,
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
  }),
  Object.freeze({
    reviewStatus: "qualified",
    qualificationId: hermesDesktopReasoningAdapterQualificationId,
    agentCatalogId: "hermes-desktop",
    clientVersion: "0.17.0",
    effortLevels: resolvedReasoningEfforts,
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
  }),
  Object.freeze({
    reviewStatus: "discovery",
    discoveryId: codexReasoningAdapterDiscoveryId,
    agentCatalogId: "codex-cli",
    clientVersion: "0.144.4",
    effortLevels: resolvedReasoningEfforts,
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
    blockingEvidence: Object.freeze([
      "live_reasoning_with_mcp_tools",
      "live_streaming_and_hidden_reasoning_suppression",
      "live_usage_cost_latency_and_cache_evidence",
    ]),
  }),
]);

/**
 * Return the code-owned review record for an exact runtime pin.
 *
 * Discovery records are deliberately visible to qualification tooling while
 * remaining ineligible for product controls. This lets an inspected adapter
 * land without silently claiming that a credentialed provider run occurred.
 */
export const agentReasoningAdapterReview = (
  input: { agentCatalogId: string; clientVersion: string },
  reviews: readonly AgentReasoningAdapterReview[] = reviewedAgentReasoningAdapters,
): AgentReasoningAdapterReview | null => {
  const review = reviews.find((candidate) => (
    candidate.agentCatalogId === input.agentCatalogId
    && candidate.clientVersion === input.clientVersion
  ));
  if (!review) return null;
  return {
    ...review,
    effortLevels: [...review.effortLevels],
    ...(review.reviewStatus === "discovery"
      ? { blockingEvidence: [...review.blockingEvidence] }
      : {}),
  } as AgentReasoningAdapterReview;
};

/**
 * Resolve a code-owned agent adapter qualification.
 *
 * Agent runtimes are registered independently from provider/model routes. A
 * future adapter can join this registry without adding agent-specific branches
 * to Control or Web. Unknown catalog IDs and client versions fail closed.
 */
export const qualifiedAgentReasoningAdapter = (
  input: { agentCatalogId: string; clientVersion: string },
  reviews: readonly AgentReasoningAdapterReview[] = reviewedAgentReasoningAdapters,
): AgentReasoningAdapterQualification | null => {
  const registration = agentReasoningAdapterReview(input, reviews);
  if (!registration || registration.reviewStatus !== "qualified") return null;
  return {
    qualificationId: registration.qualificationId,
    agentCatalogId: registration.agentCatalogId,
    clientVersion: registration.clientVersion,
    effortLevels: [...registration.effortLevels],
    conversationPinned: true,
    signedTaskBinding: true,
    providerEffortAuthority: "governed-route",
  };
};

/**
 * Return the code-owned review for an exact provider/model route.
 *
 * Discovery routes are available to qualification tooling but remain absent
 * from persisted route capabilities and Web Chat until promoted by review.
 */
export const reasoningRouteReview = (
  input: { provider: ManagedRoutingProvider; providerModel: string },
  reviews: readonly ReasoningRouteReview[] = reviewedReasoningRoutes,
): ReasoningRouteReview | null => {
  // Managed-provider inventory uses LiteLLM's canonical `provider/model`
  // spelling, while qualification registrations intentionally store the
  // provider-neutral upstream model ID. Strip only the already-validated
  // provider's exact prefix; other prefixes and arbitrary model aliases must
  // continue to fail closed.
  const providerModel = input.providerModel.startsWith(`${input.provider}/`)
    ? input.providerModel.slice(input.provider.length + 1)
    : input.providerModel;
  const review = reviews.find((candidate) => (
    candidate.provider === input.provider
    && candidate.providerModels.includes(providerModel)
  ));
  if (!review) return null;
  return {
    ...review,
    providerModels: [...review.providerModels],
    effortLevels: [...review.effortLevels],
    ...(review.reviewStatus === "discovery"
      ? { blockingEvidence: [...review.blockingEvidence] }
      : {}),
  } as ReasoningRouteReview;
};

/**
 * Product-owned qualification, not provider-name inference.
 *
 * Exact provider/model routes join through reviewed registrations without
 * adding provider branches to Control, Web, or an agent adapter. Unknown
 * routes deliberately return null. Agent runtime qualification is resolved
 * independently by `qualifiedAgentReasoningAdapter`.
 */
export const qualifiedReasoningRouteCapabilities = (input: {
  provider: ManagedRoutingProvider;
  providerModel: string;
}, reviews: readonly ReasoningRouteReview[] = reviewedReasoningRoutes): QualifiedReasoningCapabilities | null => {
  const registration = reasoningRouteReview(input, reviews);
  if (!registration || registration.reviewStatus !== "qualified") return null;
  return {
    qualificationId: registration.qualificationId,
    providerMechanism: registration.providerMechanism,
    thinkingMode: registration.thinkingMode,
    effortLevels: [...registration.effortLevels],
    defaultEffort: registration.defaultEffort,
    interleavedThinking: registration.interleavedThinking,
    reasoningTokenTelemetry: registration.reasoningTokenTelemetry,
  };
};
export type RoutingSignal =
  | "short_request"
  | "code_request"
  | "technical_request"
  | "reasoning_request"
  | "multi_step_request"
  | "long_request"
  | "vision_required"
  | "tools_required"
  | "long_context_required"
  | "low_confidence_default";
export type RoutingReasonCode =
  | "explicit_service_class"
  | "complexity_classifier"
  | "low_confidence_default"
  | "session_affinity"
  | "session_affinity_escalation"
  | "capability_escalation"
  | "availability_escalation"
  | "forced_safe_default"
  | "shadow_fixed_route"
  | "no_hypothetical_candidate"
  | "fixed_route";
export type RoutingCapabilities = {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
  contextTokens: number;
  outputTokens: number;
  residency: string[];
  reasoning?: QualifiedReasoningCapabilities | null;
};
export type ExactMoney = { amount: string; currency: string };
export type RoutingDeployment = {
  id: string;
  provider: ManagedRoutingProvider;
  model: string;
  deployment: string;
  serviceClass: ProductServiceClass;
  mappingVersionId: string;
  rateCardId: string | null;
  expectedCost: ExactMoney | null;
  capabilities: RoutingCapabilities;
  approved: boolean;
  healthy: boolean;
  evaluationPassed: boolean;
};
export type RoutingPolicyScope = {
  allowedServiceClasses: ProductServiceClass[];
  allowedDeploymentIds: string[];
  explicitSelectionAllowed: boolean;
  forceServiceClass: ProductServiceClass | null;
  safeDefault: ProductServiceClass;
};
export type ServiceClassPolicy = {
  capabilityFloor: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    contextTokens: number;
    outputTokens: number;
  };
  evaluationThreshold: string;
  qualityPosture: "economy" | "standard" | "premium";
  costPosture: "lowest" | "balanced" | "quality_first";
  latencyPosture: "fast" | "balanced" | "quality_first";
  requiredModalities: Array<"text" | "vision" | "audio">;
  requiredResidency: string[];
  eligibleDeploymentIds: string[];
  safeDefault: boolean;
};
export type ModelRoutingPolicy = {
  tenantId: string;
  teamId: string | null;
  policyVersionId: string;
  mappingVersionId: string;
  mode: RoutingMode;
  fixedDeploymentId: string;
  billingCurrency: string;
  serviceClassPolicies: Record<ProductServiceClass, ServiceClassPolicy>;
  identity: RoutingPolicyScope;
  team: RoutingPolicyScope | null;
  deployments: RoutingDeployment[];
  budgetEligibleDeploymentIds: string[];
  approvedProviders: ManagedRoutingProvider[];
  requiredResidency?: string;
};
export type ModelRoutingRequest = {
  requestId: string;
  tenantId: string;
  userId: string;
  teamId: string | null;
  taskId: string;
  requestedServiceClass: RequestedServiceClass | string;
  boundedSignals: RoutingSignal[];
  estimatedInputTokens: number;
  sessionId?: string;
  requiredCapabilities: Partial<
    Pick<
      RoutingCapabilities,
      "vision" | "tools" | "streaming" | "contextTokens" | "outputTokens"
    >
  > & { reasoningEffort?: ResolvedReasoningEffort };
  unavailableDeploymentIds?: string[];
};
export type SessionAffinity = {
  tenantId: string;
  affinityKey: string;
  serviceClass: ProductServiceClass;
  deploymentId: string;
  expiresAt: Date;
};
export interface RoutingAffinityStore {
  get(
    tenantId: string,
    affinityKey: string,
    now: Date,
  ): Promise<SessionAffinity | null>;
  put(value: SessionAffinity): Promise<void>;
}
export class NoopRoutingAffinityStore implements RoutingAffinityStore {
  async get() {
    return null;
  }
  async put() {}
}
export type RoutingSelectionStatus = "selected" | "no_candidate" | "fixed";
export type ModelRoutingDecision = {
  requestId: string;
  requestedAlias: "lemmacomputer-auto";
  requestedServiceClass: RequestedServiceClass;
  selectedServiceClass: ProductServiceClass;
  selectionStatus: RoutingSelectionStatus;
  taskClass: InternalTaskClass;
  confidence: string;
  signals: RoutingSignal[];
  reasonCode: RoutingReasonCode;
  escalationReason:
    "stronger_task" | "capability_floor" | "availability" | "policy" | null;
  policyVersionId: string;
  mappingVersionId: string;
  selectedDeployment: {
    id: string;
    provider: ManagedRoutingProvider;
    model: string;
    deployment: string;
    rateCardId: string | null;
    expectedCost: ExactMoney | null;
  };
  executedDeployment: {
    id: string;
    provider: ManagedRoutingProvider;
    model: string;
    deployment: string;
  };
  candidateIds: string[];
  ineligible: Array<{
    deploymentId: string;
    reasonCode:
      | "policy"
      | "capability"
      | "health"
      | "budget"
      | "rate_card"
      | "currency"
      | "residency";
  }>;
  affinityKey: string | null;
  affinityMovedReason: "stronger_task" | "deployment_unavailable" | null;
  routerOverheadMs: string;
  mode: RoutingMode;
  shadow: boolean;
};
export type SignedRoutingBinding = {
  schemaVersion: 1;
  tenantId: string;
  requestId: string;
  decisionId: string;
  deploymentId: string;
  mappingVersionId: string;
  policyVersionId: string;
  expiresAt: string;
  signature: string;
};
export type GovernedTransportRequest = {
  model: "lemmacomputer-auto";
  metadata: {
    requestedServiceClass: RequestedServiceClass;
    routingBinding: SignedRoutingBinding;
  };
  messages: unknown[];
};
export const validateGovernedTransportRequest = (
  input: Record<string, unknown>,
): GovernedTransportRequest => {
  if (
    input.model !== "lemmacomputer-auto" ||
    typeof input.metadata !== "object" ||
    !input.metadata ||
    !requestedServiceClasses.includes(
      (input.metadata as { requestedServiceClass?: RequestedServiceClass })
        .requestedServiceClass!,
    )
  )
    throw new ModelRoutingError(
      "SERVICE_CLASS_INVALID",
      "The workspace grant may use only the governed Auto transport alias and stable service classes",
    );
  return input as GovernedTransportRequest;
};

export class ModelRoutingError extends Error {
  constructor(
    readonly code:
      | "ROUTING_SCOPE_DENIED"
      | "SERVICE_CLASS_DENIED"
      | "SERVICE_CLASS_INVALID"
      | "NO_ELIGIBLE_DEPLOYMENT"
      | "FIXED_ROUTE_INVALID"
      | "DECISION_BINDING_MISMATCH"
      | "DECISION_BINDING_EXPIRED"
      | "DECISION_BINDING_INVALID",
    message: string,
  ) {
    super(message);
  }
}
export class RoutingDecisionBindingAuthority {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds = 300,
  ) {
    if (secret.length < 32)
      throw new Error(
        "Routing decision signing secret must contain at least 32 characters",
      );
  }
  private body(input: Omit<SignedRoutingBinding, "signature">) {
    return [
      input.schemaVersion,
      input.tenantId,
      input.requestId,
      input.decisionId,
      input.deploymentId,
      input.mappingVersionId,
      input.policyVersionId,
      input.expiresAt,
    ].join("\0");
  }
  issue(
    input: Omit<
      SignedRoutingBinding,
      "schemaVersion" | "expiresAt" | "signature"
    >,
    now = new Date(),
  ): SignedRoutingBinding {
    const unsigned = {
      schemaVersion: 1 as const,
      ...input,
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    return {
      ...unsigned,
      signature: createHmac("sha256", this.secret)
        .update(this.body(unsigned))
        .digest("base64url"),
    };
  }
  verify(
    binding: SignedRoutingBinding,
    actual: { tenantId: string; requestId: string; deploymentId: string },
    now = new Date(),
  ) {
    if (
      binding.tenantId !== actual.tenantId ||
      binding.requestId !== actual.requestId ||
      binding.deploymentId !== actual.deploymentId
    )
      throw new ModelRoutingError(
        "DECISION_BINDING_MISMATCH",
        "The signed routing decision does not authorize this deployment",
      );
    if (new Date(binding.expiresAt).getTime() <= now.getTime())
      throw new ModelRoutingError(
        "DECISION_BINDING_EXPIRED",
        "The signed routing decision has expired",
      );
    const unsigned = {
      schemaVersion: binding.schemaVersion,
      tenantId: binding.tenantId,
      requestId: binding.requestId,
      decisionId: binding.decisionId,
      deploymentId: binding.deploymentId,
      mappingVersionId: binding.mappingVersionId,
      policyVersionId: binding.policyVersionId,
      expiresAt: binding.expiresAt,
    };
    const expected = createHmac("sha256", this.secret)
      .update(this.body(unsigned))
      .digest();
    const received = Buffer.from(binding.signature, "base64url");
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      throw new ModelRoutingError(
        "DECISION_BINDING_INVALID",
        "The signed routing decision is invalid",
      );
    return binding;
  }
}
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.(\d{1,12}))?$/;
const scale = 12;
const decimal = (value: string) => {
  const match = decimalPattern.exec(value);
  if (!match)
    throw new ModelRoutingError(
      "NO_ELIGIBLE_DEPLOYMENT",
      "Deployment cost is not an exact non-negative decimal",
    );
  const [whole] = value.split(".");
  return (
    BigInt(whole!) * 10n ** BigInt(scale) +
    BigInt((match[1] ?? "").padEnd(scale, "0"))
  );
};
export const compareExactMoney = (left: ExactMoney, right: ExactMoney) => {
  if (left.currency !== right.currency)
    return left.currency.localeCompare(right.currency);
  const difference = decimal(left.amount) - decimal(right.amount);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};
export const displayServiceClass = (
  value: RequestedServiceClass | ProductServiceClass,
) => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
type Classification = {
  taskClass: InternalTaskClass;
  confidence: string;
  signals: RoutingSignal[];
};
export const classifyRoutingSignals = (
  request: Pick<ModelRoutingRequest, "boundedSignals" | "estimatedInputTokens">,
): Classification => {
  const signals = [...new Set(request.boundedSignals)];
  if (
    request.estimatedInputTokens > 100_000 &&
    !signals.includes("long_context_required")
  )
    signals.push("long_context_required");
  if (signals.includes("reasoning_request"))
    return { taskClass: "reasoning", confidence: "0.950000", signals };
  if (
    signals.includes("code_request") ||
    signals.includes("technical_request") ||
    signals.includes("long_context_required")
  )
    return { taskClass: "complex", confidence: "0.850000", signals };
  if (
    signals.includes("multi_step_request") ||
    request.estimatedInputTokens >= 80
  )
    return { taskClass: "medium", confidence: "0.750000", signals };
  if (signals.includes("short_request") || request.estimatedInputTokens < 20)
    return { taskClass: "simple", confidence: "0.900000", signals };
  return {
    taskClass: "medium",
    confidence: "0.400000",
    signals: [...signals, "low_confidence_default"],
  };
};
const autoClass = (classification: Classification): ProductServiceClass =>
  classification.confidence < "0.550000"
    ? "balanced"
    : classification.taskClass === "simple"
      ? "lite"
      : classification.taskClass === "medium"
        ? "balanced"
        : "pro";
const classIndex = (value: ProductServiceClass) =>
  productServiceClasses.indexOf(value);
const intersection = <T>(left: T[], right: T[]) =>
  left.filter((value) => right.includes(value));
const effectiveScope = (policy: ModelRoutingPolicy): RoutingPolicyScope =>
  !policy.team
    ? policy.identity
    : {
        allowedServiceClasses: intersection(
          policy.identity.allowedServiceClasses,
          policy.team.allowedServiceClasses,
        ),
        allowedDeploymentIds: intersection(
          policy.identity.allowedDeploymentIds,
          policy.team.allowedDeploymentIds,
        ),
        explicitSelectionAllowed:
          policy.identity.explicitSelectionAllowed &&
          policy.team.explicitSelectionAllowed,
        forceServiceClass:
          policy.team.forceServiceClass ?? policy.identity.forceServiceClass,
        safeDefault: policy.team.allowedServiceClasses.includes(
          policy.team.safeDefault,
        )
          ? policy.team.safeDefault
          : policy.identity.safeDefault,
      };
const affinityKey = (request: ModelRoutingRequest) =>
  request.sessionId
    ? createHash("sha256")
        .update(
          `${request.tenantId}\0${request.teamId ?? ""}\0${request.userId}\0${request.sessionId}`,
        )
        .digest("base64url")
    : null;
const satisfies = (
  deployment: RoutingDeployment,
  request: ModelRoutingRequest,
  residency?: string,
) =>
  (!request.requiredCapabilities.vision || deployment.capabilities.vision) &&
  (!request.requiredCapabilities.tools || deployment.capabilities.tools) &&
  (!request.requiredCapabilities.streaming ||
    deployment.capabilities.streaming) &&
  (request.requiredCapabilities.contextTokens ?? 0) <=
    deployment.capabilities.contextTokens &&
  (request.requiredCapabilities.outputTokens ?? 0) <=
    deployment.capabilities.outputTokens &&
  (!request.requiredCapabilities.reasoningEffort
    || deployment.capabilities.reasoning?.effortLevels.includes(
      request.requiredCapabilities.reasoningEffort,
    ) === true) &&
  (!residency || deployment.capabilities.residency.includes(residency));

export class DeterministicModelRouter {
  constructor(
    private readonly affinities: RoutingAffinityStore = new NoopRoutingAffinityStore(),
    private readonly options: { affinityTtlMs?: number; now?: () => Date } = {},
  ) {}
  async route(
    request: ModelRoutingRequest,
    policy: ModelRoutingPolicy,
  ): Promise<ModelRoutingDecision> {
    const startedAt = performance.now();
    const now = this.options.now?.() ?? new Date();
    if (
      request.tenantId !== policy.tenantId ||
      request.teamId !== policy.teamId
    )
      throw new ModelRoutingError(
        "ROUTING_SCOPE_DENIED",
        "The routing policy does not belong to this caller",
      );
    if (
      !requestedServiceClasses.includes(
        request.requestedServiceClass as RequestedServiceClass,
      )
    )
      throw new ModelRoutingError(
        "SERVICE_CLASS_INVALID",
        "Only Auto, Lite, Balanced, or Pro may be requested",
      );
    const requested = request.requestedServiceClass as RequestedServiceClass;
    const classification = classifyRoutingSignals(request);
    const unavailable = new Set(request.unavailableDeploymentIds ?? []);
    const fixed = policy.deployments.find(
      (deployment) => deployment.id === policy.fixedDeploymentId,
    );
    if (!fixed)
      throw new ModelRoutingError(
        "FIXED_ROUTE_INVALID",
        "The rollout fixed route is not in this mapping",
      );
    if (
      requested === "auto" &&
      policy.mode !== "enabled" &&
      (
        !fixed.healthy
        || unavailable.has(fixed.id)
        || !satisfies(fixed, request, policy.requiredResidency)
      )
    )
      throw new ModelRoutingError(
        "NO_ELIGIBLE_DEPLOYMENT",
        "The fixed rollout deployment is unavailable or lacks a required capability; governed routing will not bypass its binding",
      );
    if (requested === "auto" && policy.mode === "disabled")
      return {
        requestId: request.requestId,
        requestedAlias: "lemmacomputer-auto",
        requestedServiceClass: requested,
        selectedServiceClass: fixed.serviceClass,
        selectionStatus: "fixed",
        taskClass: classification.taskClass,
        confidence: classification.confidence,
        signals: classification.signals,
        reasonCode: "fixed_route",
        escalationReason: null,
        policyVersionId: policy.policyVersionId,
        mappingVersionId: policy.mappingVersionId,
        selectedDeployment: {
          id: fixed.id,
          provider: fixed.provider,
          model: fixed.model,
          deployment: fixed.deployment,
          rateCardId: fixed.rateCardId,
          expectedCost: fixed.expectedCost,
        },
        executedDeployment: {
          id: fixed.id,
          provider: fixed.provider,
          model: fixed.model,
          deployment: fixed.deployment,
        },
        candidateIds: [],
        ineligible: [],
        affinityKey: null,
        affinityMovedReason: null,
        routerOverheadMs: (performance.now() - startedAt).toFixed(6),
        mode: policy.mode,
        shadow: false,
      };
    const scope = effectiveScope(policy);
    const key = affinityKey(request);
    const prior = key
      ? await this.affinities.get(request.tenantId, key, now)
      : null;
    let selectedClass = autoClass(classification);
    let reasonCode: RoutingReasonCode =
      classification.confidence < "0.550000"
        ? "low_confidence_default"
        : "complexity_classifier";
    let escalationReason: ModelRoutingDecision["escalationReason"] = null;
    let affinityMovedReason: ModelRoutingDecision["affinityMovedReason"] = null;
    let selectionDenied = false;
    if (scope.forceServiceClass) {
      selectedClass = scope.forceServiceClass;
      reasonCode = "forced_safe_default";
      escalationReason = "policy";
    } else if (requested !== "auto") {
      if (
        !scope.explicitSelectionAllowed ||
        !scope.allowedServiceClasses.includes(requested)
      ) {
        throw new ModelRoutingError(
          "SERVICE_CLASS_DENIED",
          "The explicit service class is not allowed by policy",
        );
      } else {
        selectedClass = requested;
        reasonCode = "explicit_service_class";
      }
    } else if (
      prior &&
      classification.confidence >= "0.550000" &&
      classIndex(selectedClass) > classIndex(prior.serviceClass)
    ) {
      reasonCode = "session_affinity_escalation";
      escalationReason = "stronger_task";
      affinityMovedReason = "stronger_task";
    } else if (prior) {
      selectedClass = prior.serviceClass;
      reasonCode = "session_affinity";
    }
    if (!scope.allowedServiceClasses.includes(selectedClass)) {
      if (!scope.allowedServiceClasses.includes(scope.safeDefault)) {
        if (policy.mode !== "shadow")
          throw new ModelRoutingError(
            "SERVICE_CLASS_DENIED",
            "No allowed safe default is configured",
          );
        selectionDenied = true;
        reasonCode = "no_hypothetical_candidate";
        escalationReason = "policy";
      } else {
        selectedClass = scope.safeDefault;
        reasonCode = "forced_safe_default";
        escalationReason = "policy";
      }
    }
    const allowedIds = new Set(scope.allowedDeploymentIds);
    const budgetIds = new Set(policy.budgetEligibleDeploymentIds);
    const providers = new Set(policy.approvedProviders);
    const ineligible: ModelRoutingDecision["ineligible"] = [];
    const candidateIds: string[] = [];
    let selected: RoutingDeployment | undefined;
    const targetCurrency = policy.billingCurrency;
    let availabilityBlocked = false;
    const candidateClasses = selectionDenied
      ? []
      : requested === "auto"
        ? productServiceClasses.slice(classIndex(selectedClass))
        : [selectedClass];
    for (const candidateClass of candidateClasses) {
      if (!scope.allowedServiceClasses.includes(candidateClass)) continue;
      const contract = policy.serviceClassPolicies[candidateClass];
      let classHealthBlocked = false;
      const ranked = policy.deployments
        .filter((deployment) => {
          let reason:
            ModelRoutingDecision["ineligible"][number]["reasonCode"] | null =
            null;
          if (deployment.serviceClass !== candidateClass) return false;
          if (
            !deployment.approved ||
            !deployment.evaluationPassed ||
            !providers.has(deployment.provider) ||
            !allowedIds.has(deployment.id) ||
            !contract.eligibleDeploymentIds.includes(deployment.id)
          )
            reason = "policy";
          else if (
            (contract.capabilityFloor.vision &&
              !deployment.capabilities.vision) ||
            (contract.capabilityFloor.tools &&
              !deployment.capabilities.tools) ||
            (contract.capabilityFloor.streaming &&
              !deployment.capabilities.streaming) ||
            deployment.capabilities.contextTokens <
              contract.capabilityFloor.contextTokens ||
            deployment.capabilities.outputTokens <
              contract.capabilityFloor.outputTokens ||
            !satisfies(deployment, request, policy.requiredResidency)
          )
            reason =
              policy.requiredResidency &&
              !deployment.capabilities.residency.includes(
                policy.requiredResidency,
              )
                ? "residency"
                : "capability";
          else if (!budgetIds.has(deployment.id)) reason = "budget";
          else if (!deployment.rateCardId || !deployment.expectedCost)
            reason = "rate_card";
          else if (deployment.expectedCost.currency !== targetCurrency)
            reason = "currency";
          else if (!deployment.healthy || unavailable.has(deployment.id)) {
            reason = "health";
            classHealthBlocked = true;
          }
          if (reason)
            ineligible.push({
              deploymentId: deployment.id,
              reasonCode: reason,
            });
          return !reason;
        })
        .sort(
          (left, right) =>
            compareExactMoney(left.expectedCost!, right.expectedCost!) ||
            left.id.localeCompare(right.id),
        );
      candidateIds.push(...ranked.map(({ id }) => id));
      const pinned =
        prior && candidateClass === selectedClass
          ? ranked.find((item) => item.id === prior.deploymentId)
          : undefined;
      selected = pinned ?? ranked[0];
      if (selected) {
        if (candidateClass !== selectedClass) {
          selectedClass = candidateClass;
          reasonCode = availabilityBlocked
            ? "availability_escalation"
            : "capability_escalation";
          escalationReason = availabilityBlocked
            ? "availability"
            : "capability_floor";
        } else if (
          (prior && !pinned && affinityMovedReason !== "stronger_task") ||
          classHealthBlocked
        ) {
          reasonCode = "availability_escalation";
          escalationReason = "availability";
          if (prior && !pinned) affinityMovedReason = "deployment_unavailable";
        }
        break;
      }
      availabilityBlocked = availabilityBlocked || classHealthBlocked;
    }
    if (!selected?.expectedCost || !selected.rateCardId) {
      if (policy.mode !== "shadow" || requested !== "auto")
        throw new ModelRoutingError(
          "NO_ELIGIBLE_DEPLOYMENT",
          "No policy-approved, priced deployment satisfies the request",
        );
      return {
        requestId: request.requestId,
        requestedAlias: "lemmacomputer-auto",
        requestedServiceClass: requested,
        selectedServiceClass: selectedClass,
        selectionStatus: "no_candidate",
        taskClass: classification.taskClass,
        confidence: classification.confidence,
        signals: classification.signals,
        reasonCode: "no_hypothetical_candidate",
        escalationReason: null,
        policyVersionId: policy.policyVersionId,
        mappingVersionId: policy.mappingVersionId,
        selectedDeployment: {
          id: fixed.id,
          provider: fixed.provider,
          model: fixed.model,
          deployment: fixed.deployment,
          rateCardId: null,
          expectedCost: null,
        },
        executedDeployment: {
          id: fixed.id,
          provider: fixed.provider,
          model: fixed.model,
          deployment: fixed.deployment,
        },
        candidateIds,
        ineligible,
        affinityKey: key,
        affinityMovedReason: null,
        routerOverheadMs: (performance.now() - startedAt).toFixed(6),
        mode: policy.mode,
        shadow: true,
      };
    }
    const autoIsShadowed = policy.mode === "shadow" && requested === "auto";
    const executed = autoIsShadowed ? fixed : selected;
    if (autoIsShadowed) reasonCode = "shadow_fixed_route";
    if (key && requested === "auto")
      await this.affinities.put({
        tenantId: request.tenantId,
        affinityKey: key,
        serviceClass: selectedClass,
        deploymentId: selected.id,
        expiresAt: new Date(
          now.getTime() + (this.options.affinityTtlMs ?? 3_600_000),
        ),
      });
    return {
      requestId: request.requestId,
      requestedAlias: "lemmacomputer-auto",
      requestedServiceClass: requested,
      selectedServiceClass: selectedClass,
      selectionStatus: "selected",
      taskClass: classification.taskClass,
      confidence: classification.confidence,
      signals: classification.signals,
      reasonCode,
      escalationReason,
      policyVersionId: policy.policyVersionId,
      mappingVersionId: policy.mappingVersionId,
      selectedDeployment: {
        id: selected.id,
        provider: selected.provider,
        model: selected.model,
        deployment: selected.deployment,
        rateCardId: selected.rateCardId,
        expectedCost: selected.expectedCost,
      },
      executedDeployment: {
        id: executed.id,
        provider: executed.provider,
        model: executed.model,
        deployment: executed.deployment,
      },
      candidateIds,
      ineligible,
      affinityKey: key,
      affinityMovedReason,
      routerOverheadMs: (performance.now() - startedAt).toFixed(6),
      mode: policy.mode,
      shadow: autoIsShadowed,
    };
  }
}
