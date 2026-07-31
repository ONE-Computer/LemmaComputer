import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export const productServiceClasses = ["Lite", "Balanced", "Pro"] as const;
export const requestedServiceClasses = ["Auto", ...productServiceClasses] as const;
export const internalTaskClasses = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const;

export type ProductServiceClass = typeof productServiceClasses[number];
export type RequestedServiceClass = typeof requestedServiceClasses[number];
export type InternalTaskClass = typeof internalTaskClasses[number];
export type ManagedRoutingProvider = "foundry" | "openai" | "anthropic" | "glm" | "bedrock";
export type RoutingSignal =
  | "short_request"
  | "code_request"
  | "technical_request"
  | "reasoning_request"
  | "multi_step_request"
  | "long_request"
  | "low_confidence_default";

export type RoutingCapabilities = {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
  contextTokens: number;
};

export type RoutingDeployment = {
  id: string;
  provider: ManagedRoutingProvider;
  model: string;
  serviceClass: ProductServiceClass;
  mappingVersion: string;
  rateCardKey: string;
  expectedCostUsd: number;
  capabilities: RoutingCapabilities;
  healthy: boolean;
};

export type ModelRoutingPolicy = {
  tenantId: string;
  teamId: string | null;
  allowedServiceClasses: ProductServiceClass[];
  allowedDeploymentIds: string[];
  deployments: RoutingDeployment[];
};

export type ModelRoutingRequest = {
  tenantId: string;
  userId: string;
  teamId: string | null;
  requestedServiceClass: RequestedServiceClass | string;
  prompt: string;
  sessionId?: string;
  requiredCapabilities: Partial<RoutingCapabilities> & { contextTokens?: number };
  unavailableDeploymentIds?: string[];
};

export type ModelRoutingDecision = {
  requestedAlias: "onecomputer-auto";
  requestedServiceClass: RequestedServiceClass;
  selectedServiceClass: ProductServiceClass;
  taskClass: InternalTaskClass;
  confidence: number;
  signals: RoutingSignal[];
  cause:
    | "explicit_service_class"
    | "complexity_classifier"
    | "low_confidence_default"
    | "session_affinity"
    | "session_affinity_escalation"
    | "capability_escalation"
    | "availability_escalation";
  escalationReason: "stronger_task" | "capability_floor" | "availability" | null;
  mappingVersion: string;
  selectedDeployment: {
    id: string;
    provider: ManagedRoutingProvider;
    model: string;
    rateCardKey: string;
    expectedCostUsd: number;
  };
  routingCandidateIds: string[];
  skippedCandidateIds: string[];
  billedFallbackAttemptIds: [];
  routerOverheadMs: number;
};

export class ModelRoutingError extends Error {
  constructor(
    readonly code:
      | "ROUTING_SCOPE_DENIED"
      | "SERVICE_CLASS_DENIED"
      | "SERVICE_CLASS_INVALID"
      | "RATE_CARD_INVALID"
      | "NO_ELIGIBLE_DEPLOYMENT",
    message: string,
  ) {
    super(message);
  }
}

export interface ModelRouter {
  route(request: ModelRoutingRequest, policy: ModelRoutingPolicy): Promise<ModelRoutingDecision>;
}

type Classification = {
  taskClass: InternalTaskClass;
  confidence: number;
  signals: RoutingSignal[];
};

const phrases = {
  code: ["function", "class", "debug", "api", "database", "sql", "typescript", "python", "docker", "kubernetes"],
  technical: ["architecture", "distributed", "scalable", "encryption", "latency", "throughput", "concurrency", "protocol"],
  reasoning: ["step by step", "think through", "reason through", "pros and cons", "compare and contrast", "evaluate"],
};

const occurrences = (text: string, terms: string[]) => terms.filter((term) => text.includes(term)).length;

export const classifyRoutingTask = (prompt: string): Classification => {
  const normalized = prompt.toLowerCase();
  const estimatedTokens = Math.ceil(prompt.length / 4);
  const code = occurrences(normalized, phrases.code);
  const technical = occurrences(normalized, phrases.technical);
  const reasoning = occurrences(normalized, phrases.reasoning);
  const multiStep = /first.+then|(?:^|\s)\d+\.\s/s.test(normalized);
  const signals: RoutingSignal[] = [];
  if (estimatedTokens < 20) signals.push("short_request");
  if (code > 0) signals.push("code_request");
  if (technical > 0) signals.push("technical_request");
  if (reasoning > 0) signals.push("reasoning_request");
  if (multiStep) signals.push("multi_step_request");
  if (estimatedTokens > 400) signals.push("long_request");

  if (reasoning >= 2) return { taskClass: "REASONING", confidence: 0.95, signals };
  if (code >= 2 || technical >= 2 || estimatedTokens > 400) {
    return { taskClass: "COMPLEX", confidence: 0.85, signals };
  }
  if (code + technical + reasoning > 0 || multiStep || estimatedTokens >= 80) {
    return { taskClass: "MEDIUM", confidence: 0.75, signals };
  }
  if (estimatedTokens < 20) return { taskClass: "SIMPLE", confidence: 0.9, signals };
  return { taskClass: "MEDIUM", confidence: 0.4, signals: [...signals, "low_confidence_default"] };
};

const autoServiceClass = (classification: Classification): ProductServiceClass => {
  if (classification.confidence < 0.55) return "Balanced";
  if (classification.taskClass === "SIMPLE") return "Lite";
  if (classification.taskClass === "MEDIUM") return "Balanced";
  return "Pro";
};

const satisfiesCapabilities = (
  deployment: RoutingDeployment,
  required: ModelRoutingRequest["requiredCapabilities"],
) => {
  if (required.vision && !deployment.capabilities.vision) return false;
  if (required.tools && !deployment.capabilities.tools) return false;
  if (required.streaming && !deployment.capabilities.streaming) return false;
  if ((required.contextTokens ?? 0) > deployment.capabilities.contextTokens) return false;
  return true;
};

const isRequestedServiceClass = (value: string): value is RequestedServiceClass =>
  requestedServiceClasses.some((candidate) => candidate === value);

const serviceClassIndex = (value: ProductServiceClass) => productServiceClasses.indexOf(value);

type AffinityEntry = { serviceClass: ProductServiceClass; expiresAt: number };

export class DeterministicModelRouter implements ModelRouter {
  private readonly sessionClasses = new Map<string, AffinityEntry>();
  private readonly affinityTtlMs: number;
  private readonly maxAffinityEntries: number;
  private readonly now: () => number;

  constructor(options: { affinityTtlMs?: number; maxAffinityEntries?: number; now?: () => number } = {}) {
    this.affinityTtlMs = Math.max(1, options.affinityTtlMs ?? 60 * 60 * 1_000);
    this.maxAffinityEntries = Math.max(1, options.maxAffinityEntries ?? 10_000);
    this.now = options.now ?? Date.now;
  }

  private affinityKey(request: ModelRoutingRequest) {
    if (!request.sessionId) return null;
    return createHash("sha256")
      .update(`${request.tenantId}\u0000${request.teamId ?? ""}\u0000${request.userId}\u0000${request.sessionId}`)
      .digest("base64url");
  }

  private readAffinity(key: string | null) {
    if (!key) return undefined;
    const entry = this.sessionClasses.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.sessionClasses.delete(key);
      return undefined;
    }
    return entry.serviceClass;
  }

  private writeAffinity(key: string | null, serviceClass: ProductServiceClass) {
    if (!key) return;
    this.sessionClasses.delete(key);
    while (this.sessionClasses.size >= this.maxAffinityEntries) {
      const oldest = this.sessionClasses.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessionClasses.delete(oldest);
    }
    this.sessionClasses.set(key, { serviceClass, expiresAt: this.now() + this.affinityTtlMs });
  }

  async route(request: ModelRoutingRequest, policy: ModelRoutingPolicy): Promise<ModelRoutingDecision> {
    const startedAt = performance.now();
    if (request.tenantId !== policy.tenantId || request.teamId !== policy.teamId) {
      throw new ModelRoutingError("ROUTING_SCOPE_DENIED", "The routing policy does not belong to this caller");
    }
    if (!isRequestedServiceClass(request.requestedServiceClass)) {
      throw new ModelRoutingError("SERVICE_CLASS_INVALID", "Only Auto, Lite, Balanced, or Pro may be requested");
    }
    for (const deployment of policy.deployments) {
      if (!Number.isFinite(deployment.expectedCostUsd) || deployment.expectedCostUsd < 0) {
        throw new ModelRoutingError("RATE_CARD_INVALID", "Every deployment requires a non-negative expected cost");
      }
    }

    const classification = classifyRoutingTask(request.prompt);
    const desiredClass = autoServiceClass(classification);
    const affinityKey = this.affinityKey(request);
    const pinnedClass = request.requestedServiceClass === "Auto" ? this.readAffinity(affinityKey) : undefined;
    let selectedServiceClass: ProductServiceClass;
    let cause: ModelRoutingDecision["cause"];
    let escalationReason: ModelRoutingDecision["escalationReason"] = null;
    if (request.requestedServiceClass !== "Auto") {
      selectedServiceClass = request.requestedServiceClass;
      cause = "explicit_service_class";
    } else if (pinnedClass && serviceClassIndex(desiredClass) > serviceClassIndex(pinnedClass)) {
      selectedServiceClass = desiredClass;
      cause = "session_affinity_escalation";
      escalationReason = "stronger_task";
    } else if (pinnedClass) {
      selectedServiceClass = pinnedClass;
      cause = "session_affinity";
    } else {
      selectedServiceClass = desiredClass;
      cause = classification.confidence < 0.55 ? "low_confidence_default" : "complexity_classifier";
    }

    const allowedClasses = new Set(policy.allowedServiceClasses);
    if (!allowedClasses.has(selectedServiceClass)) {
      throw new ModelRoutingError("SERVICE_CLASS_DENIED", "The selected service class is not allowed by Team policy");
    }
    const allowedIds = new Set(policy.allowedDeploymentIds);
    const unavailableIds = new Set(request.unavailableDeploymentIds ?? []);
    let ranked: RoutingDeployment[] = [];
    let selected: RoutingDeployment | undefined;
    const routingCandidateIds: string[] = [];
    const skippedCandidateIds: string[] = [];
    let availabilityFailure = false;
    for (const candidateClass of productServiceClasses.slice(serviceClassIndex(selectedServiceClass))) {
      if (!allowedClasses.has(candidateClass)) continue;
      ranked = policy.deployments
        .filter((deployment) =>
          deployment.serviceClass === candidateClass
          && allowedIds.has(deployment.id)
          && satisfiesCapabilities(deployment, request.requiredCapabilities))
        .sort((left, right) => left.expectedCostUsd - right.expectedCostUsd || left.id.localeCompare(right.id));
      if (ranked.length === 0) continue;
      routingCandidateIds.push(...ranked.map(({ id }) => id));
      selected = ranked.find((deployment) => deployment.healthy && !unavailableIds.has(deployment.id));
      if (selected) {
        const selectedIndex = ranked.findIndex((deployment) => deployment.id === selected!.id);
        skippedCandidateIds.push(...ranked.slice(0, selectedIndex).map(({ id }) => id));
        if (candidateClass !== selectedServiceClass) {
          selectedServiceClass = candidateClass;
          cause = availabilityFailure ? "availability_escalation" : "capability_escalation";
          escalationReason = availabilityFailure ? "availability" : "capability_floor";
        }
        break;
      }
      availabilityFailure = true;
      skippedCandidateIds.push(...ranked.map(({ id }) => id));
    }
    if (!selected) {
      throw new ModelRoutingError("NO_ELIGIBLE_DEPLOYMENT", "No policy-approved deployment satisfies the request");
    }
    if (request.requestedServiceClass === "Auto") this.writeAffinity(affinityKey, selectedServiceClass);

    return {
      requestedAlias: "onecomputer-auto",
      requestedServiceClass: request.requestedServiceClass,
      selectedServiceClass,
      taskClass: classification.taskClass,
      confidence: classification.confidence,
      signals: classification.signals,
      cause,
      escalationReason,
      mappingVersion: selected.mappingVersion,
      selectedDeployment: {
        id: selected.id,
        provider: selected.provider,
        model: selected.model,
        rateCardKey: selected.rateCardKey,
        expectedCostUsd: selected.expectedCostUsd,
      },
      routingCandidateIds,
      skippedCandidateIds,
      billedFallbackAttemptIds: [],
      routerOverheadMs: performance.now() - startedAt,
    };
  }
}
