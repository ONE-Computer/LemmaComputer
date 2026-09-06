import { z } from "zod";
import {
  DeterministicModelRouter,
  RoutingDecisionBindingAuthority,
  qualifiedReasoningRouteCapabilities,
  resolvedReasoningEfforts,
  type AgentReasoningAdapterQualification,
  type ModelRoutingPolicy,
  type ProductReasoningEffort,
  type ResolvedReasoningEffort,
  type SignedRoutingBinding,
} from "@lemmacomputer/model-router";
import type {
  RoutingStore,
  ProviderSettingsStore,
  TeamBudgetStore,
  TeamStore,
  UsageAmount,
} from "@lemmacomputer/workspace-store";
import { UsageTaskBindingAuthority } from "./usage-ledger.js";
const serviceClass = z.enum(["lite", "balanced", "pro"]);
const managedProvider = z.enum([
  "foundry",
  "vertex",
  "openai",
  "anthropic",
  "glm",
  "bedrock",
]);
const routingCapabilities = z.strictObject({
  vision: z.boolean(),
  tools: z.boolean(),
  streaming: z.boolean(),
  contextTokens: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
  residency: z.array(z.string().trim().min(2).max(64)).max(16),
});
export const createRoutingMappingSchema = z
  .strictObject({
    revisionNote: z.string().trim().min(8).max(500),
    billingCurrency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
    deployments: z
      .array(
        z.strictObject({
          serviceClass,
          provider: managedProvider,
          providerAccountId: z.string().trim().min(1).max(200).optional(),
          providerModel: z.string().trim().min(1).max(300),
          providerDeployment: z.string().trim().min(1).max(300),
          region: z.string().trim().min(1).max(100).optional(),
          providerServiceTier: z.string().trim().min(1).max(100).optional(),
          rateCardId: z.uuid().optional(),
          capabilities: routingCapabilities,
          approved: z.boolean(),
          evaluationPassed: z.boolean(),
        }),
      )
      .max(100),
  });
const money = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/);
const rate = z.string().regex(/^(?:0|1)(?:\.\d{1,6})?$/);
const scope = z.strictObject({
  allowedServiceClasses: z.array(serviceClass).min(1).max(3),
  allowedDeploymentIds: z.array(z.uuid()).min(1).max(100),
  explicitSelectionAllowed: z.boolean(),
  forceServiceClass: serviceClass.nullable(),
  safeDefault: serviceClass,
});
const classContract = z.strictObject({
  capabilityFloor: z.strictObject({
    vision: z.boolean(),
    tools: z.boolean(),
    streaming: z.boolean(),
    contextTokens: z.number().int().positive(),
    outputTokens: z.number().int().positive(),
  }),
  evaluationThreshold: rate,
  qualityPosture: z.enum(["economy", "standard", "premium"]),
  costPosture: z.enum(["lowest", "balanced", "quality_first"]),
  latencyPosture: z.enum(["fast", "balanced", "quality_first"]),
  requiredModalities: z
    .array(z.enum(["text", "vision", "audio"]))
    .min(1)
    .max(3),
  requiredResidency: z.array(z.string().min(2).max(64)).max(16),
  eligibleDeploymentIds: z.array(z.uuid()).min(1).max(100),
  safeDefault: z.boolean(),
});
const classContracts = z.strictObject({
  lite: classContract,
  balanced: classContract,
  pro: classContract,
});
export const saveRoutingPolicySchema = z
  .strictObject({
    mappingVersionId: z.uuid(),
    billingCurrency: z.string().regex(/^[A-Z]{3}$/),
    serviceClassPolicies: classContracts,
    identity: scope,
    team: scope.nullable(),
    requiredResidency: z.string().trim().min(2).max(64).optional(),
  })
  .superRefine((value, context) => {
    if (value.identity.safeDefault !== "balanced")
      context.addIssue({
        code: "custom",
        path: ["identity", "safeDefault"],
        message: "Balanced is the Phase 0.5 fixed safe default",
      });
    if (!value.serviceClassPolicies.balanced.safeDefault)
      context.addIssue({
        code: "custom",
        path: ["serviceClassPolicies", "balanced", "safeDefault"],
        message: "Balanced must be marked as the fixed safe default",
      });
    for (const name of ["lite", "pro"] as const)
      if (value.serviceClassPolicies[name].safeDefault)
        context.addIssue({
          code: "custom",
          path: ["serviceClassPolicies", name, "safeDefault"],
          message: "Only Balanced may be marked as the fixed safe default",
        });
    if (value.team) {
      for (const item of value.team.allowedServiceClasses)
        if (!value.identity.allowedServiceClasses.includes(item))
          context.addIssue({
            code: "custom",
            path: ["team", "allowedServiceClasses"],
            message: "Team policy may only narrow identity policy",
          });
      for (const item of value.team.allowedDeploymentIds)
        if (!value.identity.allowedDeploymentIds.includes(item))
          context.addIssue({
            code: "custom",
            path: ["team", "allowedDeploymentIds"],
            message: "Team policy may only narrow identity policy",
          });
    }
  });
export const saveRoutingReviewSchema = z.strictObject({
  evaluationPassed: z.boolean(),
  reviewNote: z.string().trim().min(8).max(2000),
});
export const changeRoutingRolloutSchema = z
  .strictObject({
    policyVersionId: z.uuid(),
    mappingVersionId: z.uuid(),
    mode: z.enum(["disabled", "shadow", "enabled"]),
    fixedDeploymentId: z.uuid(),
    evidenceReviewId: z.uuid().optional(),
    reason: z.string().trim().min(8).max(1000),
    confirmation: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.mode !== "disabled")
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "The deferred Auto routing lifecycle is unavailable in the Phase 0.5 release posture",
      });
    if (
      value.mode === "enabled" &&
      value.confirmation !== "ENABLE AUTO ROUTING"
    )
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Explicit production enable confirmation is required",
      });
    if (value.mode === "enabled" && !value.evidenceReviewId)
      context.addIssue({
        code: "custom",
        path: ["evidenceReviewId"],
        message: "A reviewed evidence record is required",
      });
  });
type Actor = { tenantId: string; userId: string };
const usageUnit = z.enum([
  "input_uncached_token",
  "cache_read_token",
  "cache_write_token",
  "output_token",
  "reasoning_token",
  "request",
  "provider:total_tokens",
]);
export const internalRoutingDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1).max(256),
  subjectId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  taskBinding: z.string().min(32).max(4096),
  requestId: z.string().min(1).max(256),
  requestedServiceClass: z.enum(["auto", "lite", "balanced", "pro"]),
  requestedReasoningEffort: z.enum(["auto", "low", "medium", "high"]).optional(),
  boundedSignals: z
    .array(
      z.enum([
        "short_request",
        "code_request",
        "technical_request",
        "reasoning_request",
        "multi_step_request",
        "long_request",
        "vision_required",
        "tools_required",
        "long_context_required",
        "low_confidence_default",
      ]),
    )
    .max(16),
  estimatedInputTokens: z.number().int().nonnegative().max(10_000_000),
  requiredCapabilities: z.strictObject({
    vision: z.boolean().optional(),
    tools: z.boolean().optional(),
    streaming: z.boolean().optional(),
    contextTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  }),
  expectedUsage: z
    .array(z.strictObject({ unit: usageUnit, quantity: money }))
    .min(1)
    .max(16),
  unavailableDeploymentIds: z.array(z.uuid()).max(100).optional(),
});
export const internalRoutingObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    tenantId: z.string().min(1).max(256),
    decisionId: z.uuid(),
    usageEventId: z.uuid(),
    outcome: z.enum(["success", "error", "regret", "override"]),
    actualCost: money.optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    deploymentHealth: z.enum(["healthy", "unavailable"]).optional(),
  })
  .superRefine((value, context) => {
    if (Boolean(value.actualCost) !== Boolean(value.currency))
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Actual cost and currency must be supplied together",
      });
    if (value.deploymentHealth === "unavailable" && value.outcome !== "error")
      context.addIssue({
        code: "custom",
        path: ["deploymentHealth"],
        message: "Only an execution error may mark a deployment unavailable",
      });
  });
export class RoutingAdministrationService {
  constructor(
    private readonly store: RoutingStore,
    // Kept as an optional compatibility argument while callers roll forward;
    // Teams no longer participate in organization route activation.
    _teams?: Pick<TeamStore, "listTeams">,
    private readonly providers?: Pick<ProviderSettingsStore, "listProviderSettings">,
  ) {}
  latestMapping(actor: Actor) {
    return this.store.latestMappingVersion(actor.tenantId);
  }
  async createMapping(
    actor: Actor,
    input: z.input<typeof createRoutingMappingSchema>,
  ) {
    const settings = await this.providers?.listProviderSettings(actor.tenantId) ?? [];
    const limitsFor = (deployment: (typeof input.deployments)[number]) => settings
      .find((setting) => setting.provider === deployment.provider && setting.state === "active")
      ?.configuration.modelLimits?.[deployment.providerDeployment];
    const mapping = await this.store.createMappingVersion({
      tenantId: actor.tenantId,
      revisionNote: input.revisionNote,
      createdBy: actor.userId,
      deployments: input.deployments.map((deployment) => ({
        ...deployment,
        capabilities: {
          ...deployment.capabilities,
          ...limitsFor(deployment),
          reasoning: qualifiedReasoningRouteCapabilities({
            provider: deployment.provider,
            providerModel: deployment.providerModel,
          }),
        },
        ...(deployment.providerAccountId
          ? { providerAccountId: deployment.providerAccountId }
          : {}),
        ...(deployment.region ? { region: deployment.region } : {}),
        ...(deployment.providerServiceTier
          ? { providerServiceTier: deployment.providerServiceTier }
          : {}),
        ...(deployment.rateCardId ? { rateCardId: deployment.rateCardId } : {}),
      })),
    });
    await this.activateOrganizationDefault(actor, mapping, input.billingCurrency ?? "USD");
    return mapping;
  }
  private async activateOrganizationDefault(
    actor: Actor,
    mapping: Awaited<ReturnType<RoutingStore["createMappingVersion"]>>,
    billingCurrency: string,
  ) {
    const available = (mapping.deployments ?? []).filter((deployment) => (
      deployment.rateCardId
      && deployment.approved
      && deployment.evaluationPassed
    ));
    if (!available.length) return;
    const availableClasses = [...new Set(available.map(({ serviceClass }) => serviceClass))];
    const deploymentByClass = new Map(available.map((deployment) => [deployment.serviceClass, deployment]));
    const organizationDefault = availableClasses.includes("balanced") ? "balanced" : availableClasses[0]!;
    const fallbackDeployment = deploymentByClass.get(organizationDefault)!;
    const contractFor = (serviceClass: "lite" | "balanced" | "pro") => {
      const deployment = deploymentByClass.get(serviceClass) ?? fallbackDeployment;
      return {
        capabilityFloor: {
          vision: deployment.capabilities.vision,
          tools: deployment.capabilities.tools,
          streaming: deployment.capabilities.streaming,
          contextTokens: deployment.capabilities.contextTokens,
          outputTokens: deployment.capabilities.outputTokens,
        },
        evaluationThreshold: "0.800000",
        qualityPosture: serviceClass === "pro" ? "premium" as const : "standard" as const,
        costPosture: serviceClass === "lite" ? "lowest" as const : "balanced" as const,
        latencyPosture: "balanced" as const,
        requiredModalities: ["text" as const],
        requiredResidency: deployment.capabilities.residency,
        eligibleDeploymentIds: [deployment.id],
        safeDefault: serviceClass === organizationDefault,
      };
    };
    const organizationScope = {
      allowedServiceClasses: availableClasses,
      allowedDeploymentIds: available.map(({ id }) => id),
      explicitSelectionAllowed: true,
      forceServiceClass: null,
      safeDefault: organizationDefault,
    };
    const policyVersionId = await this.store.createPolicy({
      tenantId: actor.tenantId,
      teamId: null,
      mappingVersionId: mapping.id,
      billingCurrency,
      serviceClassPolicies: {
        lite: contractFor("lite"),
        balanced: contractFor("balanced"),
        pro: contractFor("pro"),
      },
      identity: organizationScope,
      team: null,
      createdBy: actor.userId,
    });
    await this.store.createRollout({
      tenantId: actor.tenantId,
      teamId: null,
      policyVersionId,
      mappingVersionId: mapping.id,
      mode: "disabled",
      fixedDeploymentId: fallbackDeployment.id,
      reason: "Organization routes saved and activated",
      createdBy: actor.userId,
    });
  }
  settings(actor: Actor, teamId: string) {
    return this.store.adminReadModel(actor.tenantId, teamId);
  }
  report(actor: Actor, teamId: string) {
    return this.store.shadowReport(actor.tenantId, teamId);
  }
  decision(actor: Actor, id: string) {
    return this.store.decision(actor.tenantId, id);
  }
  async savePolicy(
    actor: Actor,
    teamId: string,
    input: z.infer<typeof saveRoutingPolicySchema>,
  ) {
    const id = await this.store.createPolicy({
      tenantId: actor.tenantId,
      teamId,
      mappingVersionId: input.mappingVersionId,
      billingCurrency: input.billingCurrency,
      serviceClassPolicies: input.serviceClassPolicies,
      identity: input.identity,
      team: input.team,
      ...(input.requiredResidency
        ? { requiredResidency: input.requiredResidency }
        : {}),
      createdBy: actor.userId,
      initializeFixedRollout: true,
    });
    return { id };
  }
  review(
    actor: Actor,
    teamId: string,
    input: z.infer<typeof saveRoutingReviewSchema>,
  ) {
    return this.store.createReview({
      tenantId: actor.tenantId,
      teamId,
      ...input,
      reviewerUserId: actor.userId,
      reviewedAt: new Date(),
    });
  }
  rollout(
    actor: Actor,
    teamId: string,
    input: z.infer<typeof changeRoutingRolloutSchema>,
  ) {
    return this.store.createRollout({
      tenantId: actor.tenantId,
      teamId,
      policyVersionId: input.policyVersionId,
      mappingVersionId: input.mappingVersionId,
      mode: input.mode,
      fixedDeploymentId: input.fixedDeploymentId,
      ...(input.evidenceReviewId
        ? { evidenceReviewId: input.evidenceReviewId }
        : {}),
      reason: input.reason,
      createdBy: actor.userId,
    });
  }
  async killSwitch(actor: Actor, teamId: string, reason: string) {
    const current = await this.store.adminReadModel(actor.tenantId, teamId);
    if (!current.rollout)
      throw new Error("Routing is not configured for this Team");
    return this.store.createRollout({
      tenantId: actor.tenantId,
      teamId,
      policyVersionId: current.rollout.policyVersionId,
      mappingVersionId: current.rollout.mappingVersionId,
      mode: "disabled",
      fixedDeploymentId: current.rollout.fixedDeploymentId,
      reason,
      createdBy: actor.userId,
    });
  }
}
/**
 * Older immutable mappings predate the reasoning-capability projection.
 * Enrich only missing capabilities from the code-owned exact route registry;
 * persisted qualifications remain authoritative and unknown routes stay
 * unavailable.
 */
export const projectQualifiedReasoningRoutes = (
  policy: ModelRoutingPolicy,
): ModelRoutingPolicy => {
  let changed = false;
  const deployments = policy.deployments.map((deployment) => {
    if (deployment.capabilities.reasoning || !deployment.model) return deployment;
    const reasoning = qualifiedReasoningRouteCapabilities({
      provider: deployment.provider,
      providerModel: deployment.model,
    });
    if (!reasoning) return deployment;
    changed = true;
    return {
      ...deployment,
      capabilities: {
        ...deployment.capabilities,
        reasoning,
      },
    };
  });
  return changed ? { ...policy, deployments } : policy;
};

const scaled = (value: string) => {
  const match = /^(-?)(\d+)(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) throw new Error("Invalid exact decimal");
  const amount =
    BigInt(match[2]!) * 10n ** 12n + BigInt((match[3] ?? "").padEnd(12, "0"));
  return match[1] ? -amount : amount;
};

const reasoningEffortRank: Readonly<Record<ResolvedReasoningEffort, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

const phase05ReasoningCeiling = (value: "disabled" | "low" | "medium" | "high" | "max") => (
  value === "disabled" ? null : value === "max" ? "high" as const : value
);

const resolveTaskReasoningEffort = (
  requested: ProductReasoningEffort | undefined,
  maximum: "disabled" | "low" | "medium" | "high" | "max" | undefined,
): ResolvedReasoningEffort | undefined => {
  if (requested === undefined) return undefined;
  if (maximum === undefined) throw new Error("AI task reasoning policy is missing");
  const ceiling = phase05ReasoningCeiling(maximum);
  if (ceiling === null) throw new Error("Reasoning effort is disabled by protected policy");
  if (requested === "auto") return ceiling;
  if (reasoningEffortRank[requested] > reasoningEffortRank[ceiling]) {
    throw new Error("The requested reasoning effort exceeds protected policy");
  }
  return requested;
};

const outputTokenLimit = (
  policy: ModelRoutingPolicy,
  requestedServiceClass: z.infer<
    typeof internalRoutingDecisionSchema
  >["requestedServiceClass"],
  inputTokens: number,
) => {
  const identityClasses = new Set(policy.identity.allowedServiceClasses);
  const identityDeployments = new Set(policy.identity.allowedDeploymentIds);
  const teamClasses = new Set(policy.team?.allowedServiceClasses ?? policy.identity.allowedServiceClasses);
  const teamDeployments = new Set(policy.team?.allowedDeploymentIds ?? policy.identity.allowedDeploymentIds);
  const fixedOnly = requestedServiceClass === "auto" && policy.mode !== "enabled";
  const limits = policy.deployments
    .filter((deployment) =>
      (!fixedOnly || deployment.id === policy.fixedDeploymentId)
      && (requestedServiceClass === "auto" || deployment.serviceClass === requestedServiceClass)
      && identityClasses.has(deployment.serviceClass)
      && teamClasses.has(deployment.serviceClass)
      && identityDeployments.has(deployment.id)
      && teamDeployments.has(deployment.id)
      && deployment.approved
      && deployment.healthy
      && deployment.evaluationPassed
      && policy.approvedProviders.includes(deployment.provider)
      && policy.budgetEligibleDeploymentIds.includes(deployment.id)
      && deployment.rateCardId !== null
      && deployment.expectedCost !== null
    )
    .map((deployment) => Math.max(1, Math.min(deployment.capabilities.outputTokens, deployment.capabilities.contextTokens - inputTokens)));
  return limits.length ? Math.max(...limits) : null;
};

const constrainOutputToPolicy = (
  input: z.infer<typeof internalRoutingDecisionSchema>,
  policy: ModelRoutingPolicy,
) => {
  const limit = outputTokenLimit(policy, input.requestedServiceClass, Math.max(input.estimatedInputTokens, input.requiredCapabilities.contextTokens ?? 0));
  const requested = input.requiredCapabilities.outputTokens;
  if (limit === null || requested === undefined || requested <= limit)
    return { input, outputTokenLimit: limit };
  return {
    outputTokenLimit: limit,
    input: {
      ...input,
      requiredCapabilities: {
        ...input.requiredCapabilities,
        outputTokens: limit,
      },
      expectedUsage: input.expectedUsage.map((amount) =>
        amount.unit === "output_token" && scaled(amount.quantity) > scaled(String(limit))
          ? { ...amount, quantity: String(limit) }
          : amount,
      ),
    },
  };
};

// The chat selector only needs to prove that a route has the base token prices
// required for a text turn. Real routing resolves the policy again with the
// request's bounded usage estimate before enforcing price and budget limits.
const chatTierReadinessUsage: UsageAmount[] = [
  { unit: "input_uncached_token", quantity: "1" },
  { unit: "output_token", quantity: "1" },
];

export class RoutingExecutionService {
  private readonly router: DeterministicModelRouter;
  constructor(
    private readonly store: RoutingStore,
    private readonly teams: Pick<TeamStore, "getCurrentDefaultSpendingTeam">,
    private readonly bindings: RoutingDecisionBindingAuthority,
    private readonly taskBindings: UsageTaskBindingAuthority,
    // Budget admission is enforced by the usage ledger after routing. Keep the
    // compatibility argument while callers roll forward, but never turn a Team
    // budget into route availability.
    _budgets?: Pick<TeamBudgetStore, "getBudgetStatus">,
  ) {
    this.router = new DeterministicModelRouter(store);
  }
  private async resolveEffectivePolicy(
    tenantId: string,
    teamId: string | null,
    expectedUsage: UsageAmount[],
  ) {
    const resolved = await this.store.resolveEffectivePolicy(
      tenantId,
      teamId,
      expectedUsage,
    );
    return resolved
      ? { ...resolved, policy: projectQualifiedReasoningRoutes(resolved.policy) }
      : null;
  }
  async serviceClassOptions(
    tenantId: string,
    _subjectId?: string,
  ): Promise<Array<{
    value: "lite" | "balanced" | "pro";
    available: boolean;
    reasonCode: "ready" | "policy_denied" | "pricing_unavailable" | "provider_unavailable" | "route_unavailable";
  }>> {
    const values = ["lite", "balanced", "pro"] as const;
    const unavailable = (reasonCode: "policy_denied" | "pricing_unavailable" | "provider_unavailable" | "route_unavailable") => (
      values.map((value) => ({ value, available: false as const, reasonCode }))
    );
    const resolved = await this.resolveEffectivePolicy(
      tenantId,
      null,
      chatTierReadinessUsage,
    );
    if (!resolved) return unavailable("route_unavailable");
    const policy = resolved.policy;
    const identityClasses = new Set(policy.identity.allowedServiceClasses);
    const identityDeployments = new Set(policy.identity.allowedDeploymentIds);
    const explicitSelectionAllowed = policy.identity.explicitSelectionAllowed
      && policy.identity.forceServiceClass === null;
    const approvedProviders = new Set(policy.approvedProviders);

    return values.map((value) => {
      if (!explicitSelectionAllowed || !identityClasses.has(value)) {
        return { value, available: false, reasonCode: "policy_denied" as const };
      }
      const contract = policy.serviceClassPolicies[value];
      const policyEligible = policy.deployments.filter((deployment) => (
        deployment.serviceClass === value
        && identityDeployments.has(deployment.id)
        && contract.eligibleDeploymentIds.includes(deployment.id)
        && deployment.approved
        && deployment.evaluationPassed
        && approvedProviders.has(deployment.provider)
        && (!contract.capabilityFloor.vision || deployment.capabilities.vision)
        && (!contract.capabilityFloor.tools || deployment.capabilities.tools)
        && (!contract.capabilityFloor.streaming || deployment.capabilities.streaming)
        && deployment.capabilities.contextTokens >= contract.capabilityFloor.contextTokens
        && deployment.capabilities.outputTokens >= contract.capabilityFloor.outputTokens
        && (!policy.requiredResidency || deployment.capabilities.residency.includes(policy.requiredResidency))
      ));
      if (!policyEligible.length) return { value, available: false, reasonCode: "route_unavailable" as const };
      const priced = policyEligible.filter((deployment) => (
        deployment.rateCardId
        && deployment.expectedCost?.currency === policy.billingCurrency
      ));
      if (!priced.length) return { value, available: false, reasonCode: "pricing_unavailable" as const };
      const healthy = priced.filter((deployment) => deployment.healthy);
      if (!healthy.length) return { value, available: false, reasonCode: "provider_unavailable" as const };
      return { value, available: true, reasonCode: "ready" as const };
    });
  }
  async reasoningOptions(
    tenantId: string,
    _subjectId: string,
    adapter: AgentReasoningAdapterQualification,
  ): Promise<Record<
    "auto" | "lite" | "balanced" | "pro",
    ResolvedReasoningEffort[]
  >> {
    const empty = { auto: [], lite: [], balanced: [], pro: [] } as Record<
      "auto" | "lite" | "balanced" | "pro",
      ResolvedReasoningEffort[]
    >;
    const resolved = await this.resolveEffectivePolicy(tenantId, null, [
      { unit: "request", quantity: "1" },
    ]);
    if (!resolved) return empty;
    const policy = resolved.policy;
    const identityClasses = new Set(policy.identity.allowedServiceClasses);
    const identityDeployments = new Set(policy.identity.allowedDeploymentIds);
    const eligible = policy.deployments.filter((deployment) => (
      identityClasses.has(deployment.serviceClass)
      && identityDeployments.has(deployment.id)
      && policy.approvedProviders.includes(deployment.provider)
      && deployment.approved
      && deployment.healthy
      && deployment.evaluationPassed
      && deployment.capabilities.reasoning !== null
      && deployment.capabilities.reasoning !== undefined
    ));
    const intersection = (deployments: typeof eligible) => deployments.length
      ? resolvedReasoningEfforts.filter((effort) => (
          adapter.effortLevels.includes(effort)
          && deployments.every(
            (deployment) => deployment.capabilities.reasoning?.effortLevels.includes(effort),
          )
        ))
      : [];
    const fixed = eligible.filter((deployment) => deployment.id === policy.fixedDeploymentId);
    return {
      auto: intersection(fixed),
      ...Object.fromEntries(["lite", "balanced", "pro"].map((serviceClass) => [
        serviceClass,
        intersection(eligible.filter((deployment) => deployment.serviceClass === serviceClass)),
      ])),
    } as Record<"auto" | "lite" | "balanced" | "pro", ResolvedReasoningEffort[]>;
  }
  private persisted(
    prior: Record<string, unknown>,
    status: "created" | "duplicate",
    requestedReasoningEffort?: ProductReasoningEffort,
    resolvedReasoningEffort?: ResolvedReasoningEffort,
    inputTokens = 0,
  ) {
    const decisionId = String(prior.id);
    const tenantId = String(prior.tenant_id);
    const requestId = String(prior.request_id);
    const deploymentId = String(prior.executed_deployment_id);
    const capabilities = prior.executed_capabilities as {
      outputTokens?: unknown;
      contextTokens?: unknown;
      reasoning?: { effortLevels?: unknown } | null;
    } | null;
    if (
      resolvedReasoningEffort
      && (
        !Array.isArray(capabilities?.reasoning?.effortLevels)
        || !capabilities.reasoning.effortLevels.includes(resolvedReasoningEffort)
      )
    ) {
      throw new Error("Persisted routing decision does not satisfy the requested reasoning effort");
    }
    return {
      schemaVersion: 1,
      status,
      decisionId,
      requestedServiceClass: String(prior.requested_service_class),
      selectedServiceClass: String(prior.selected_service_class),
      ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
      ...(resolvedReasoningEffort ? { resolvedReasoningEffort } : {}),
      reasonCode: String(prior.reason_code),
      executedDeploymentId: deploymentId,
      executedProviderDeployment: String(prior.executed_provider_deployment),
      executedModelGroup: String(prior.executed_provider_deployment),
      executedOutputTokenLimit: Math.min(Number(capabilities?.outputTokens), Number(capabilities?.contextTokens ?? Infinity) - inputTokens),
      binding: this.bindings.issue({
        tenantId,
        requestId,
        decisionId,
        deploymentId,
        mappingVersionId: String(prior.mapping_version_id),
        policyVersionId: String(prior.policy_version_id),
      }),
    };
  }
  async decide(input: z.infer<typeof internalRoutingDecisionSchema>) {
    const task = this.taskBindings.verify(input.taskBinding);
    const resolvedReasoningEffort = resolveTaskReasoningEffort(
      task.requestedReasoningEffort,
      task.maximumReasoningEffort,
    );
    if (
      task.tenantId !== input.tenantId ||
      task.subjectId !== input.subjectId ||
      task.workspaceId !== input.workspaceId ||
      task.agentId !== input.agentId ||
      task.requestedServiceClass !== input.requestedServiceClass ||
      task.requestedReasoningEffort !== input.requestedReasoningEffort ||
      (
        input.requiredCapabilities.reasoningEffort !== undefined
        && input.requiredCapabilities.reasoningEffort !== resolvedReasoningEffort
      )
    )
      throw new Error(
        "AI task binding does not match the authenticated routing identity",
      );
    const prior = await this.store.decisionByRequest(
      input.tenantId,
      input.requestId,
    );
    if (prior) return this.persisted(
      prior,
      "duplicate",
      task.requestedReasoningEffort,
      resolvedReasoningEffort,
      Math.max(input.estimatedInputTokens, input.requiredCapabilities.contextTokens ?? 0),
    );
    const reasoningConstrainedInput = resolvedReasoningEffort
      ? {
          ...input,
          requiredCapabilities: {
            ...input.requiredCapabilities,
            reasoningEffort: resolvedReasoningEffort,
          },
        }
      : input;
    const team = await this.teams.getCurrentDefaultSpendingTeam(
      input.tenantId,
      input.subjectId,
    );
    if (!team)
      throw new Error(
        "A default spending Team is required for governed routing",
      );
    let resolved = await this.resolveEffectivePolicy(
      input.tenantId,
      null,
      input.expectedUsage as UsageAmount[],
    );
    if (!resolved)
      throw new Error("Governed routing is not configured for this organization");
    // Phase 0.5 never executes Auto, including for a previously-persisted
    // rollout that predates this release posture. Explicit Lite/Balanced/Pro
    // requests still use the pinned policy and immutable route map below.
    if (input.requestedServiceClass === "auto") {
      resolved = { ...resolved, policy: { ...resolved.policy, mode: "disabled" } };
    }
    let constrained = constrainOutputToPolicy(reasoningConstrainedInput, resolved.policy);
    if (constrained.input !== reasoningConstrainedInput) {
      resolved = await this.resolveEffectivePolicy(
        input.tenantId,
        null,
        constrained.input.expectedUsage as UsageAmount[],
      );
      if (!resolved)
        throw new Error("Governed routing is not configured for this organization");
      if (input.requestedServiceClass === "auto") {
        resolved = { ...resolved, policy: { ...resolved.policy, mode: "disabled" } };
      }
      constrained = constrainOutputToPolicy(constrained.input, resolved.policy);
    }
    const decision = await this.router.route(
      {
        requestId: constrained.input.requestId,
        tenantId: constrained.input.tenantId,
        userId: constrained.input.subjectId,
        // Organization routing is scoped independently of the Team used for
        // cost attribution. The real spending Team is persisted below, but it
        // must not turn an organization policy into a Team-scoped policy.
        teamId: resolved.policy.teamId,
        taskId: task.taskId,
        requestedServiceClass: constrained.input.requestedServiceClass,
        boundedSignals: constrained.input.boundedSignals,
        estimatedInputTokens: constrained.input.estimatedInputTokens,
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
        requiredCapabilities: constrained.input.requiredCapabilities,
        ...(constrained.input.unavailableDeploymentIds
          ? { unavailableDeploymentIds: constrained.input.unavailableDeploymentIds }
          : {}),
      },
      resolved.policy,
    );
    const recorded = await this.store.recordDecision({
      tenantId: input.tenantId,
      teamId: team.id,
      userId: input.subjectId,
      taskId: task.taskId,
      rolloutVersionId: resolved.rollout.id,
      decision,
    });
    if (recorded.status === "duplicate") {
      const concurrent = await this.store.decision(input.tenantId, recorded.id);
      if (!concurrent)
        throw new Error("Persisted routing decision is unavailable");
      return this.persisted(
        concurrent,
        "duplicate",
        task.requestedReasoningEffort,
        resolvedReasoningEffort,
        Math.max(input.estimatedInputTokens, input.requiredCapabilities.contextTokens ?? 0),
      );
    }
    const executedCapabilities = resolved.policy.deployments.find((deployment) => deployment.id === decision.executedDeployment.id)!.capabilities;
    return {
      schemaVersion: 1,
      status: "created",
      decisionId: recorded.id,
      requestedServiceClass: decision.requestedServiceClass,
      selectedServiceClass: decision.selectedServiceClass,
      ...(task.requestedReasoningEffort ? { requestedReasoningEffort: task.requestedReasoningEffort } : {}),
      ...(resolvedReasoningEffort ? { resolvedReasoningEffort } : {}),
      reasonCode: decision.reasonCode,
      executedDeploymentId: decision.executedDeployment.id,
      executedProviderDeployment: decision.executedDeployment.deployment,
      executedModelGroup: decision.executedDeployment.deployment,
      executedOutputTokenLimit: Math.min(
        executedCapabilities.outputTokens,
        executedCapabilities.contextTokens - Math.max(input.estimatedInputTokens, input.requiredCapabilities.contextTokens ?? 0),
      ),
      binding: this.bindings.issue({
        tenantId: input.tenantId,
        requestId: input.requestId,
        decisionId: recorded.id,
        deploymentId: decision.executedDeployment.id,
        mappingVersionId: decision.mappingVersionId,
        policyVersionId: decision.policyVersionId,
      }),
    };
  }
  verify(
    binding: SignedRoutingBinding,
    actual: { tenantId: string; requestId: string; deploymentId: string },
  ) {
    this.bindings.verify(binding, actual);
    return { schemaVersion: 1, valid: true, decisionId: binding.decisionId };
  }
  async observe(input: z.infer<typeof internalRoutingObservationSchema>) {
    const result = await this.store.appendObservation(input);
    return { schemaVersion: 1, ...result };
  }
}
