import { z } from "zod";
import {
  DeterministicModelRouter,
  RoutingDecisionBindingAuthority,
  type SignedRoutingBinding,
} from "@onecomputer/model-router";
import type {
  RoutingStore,
  TeamBudgetStore,
  TeamStore,
  UsageAmount,
} from "@onecomputer/workspace-store";
import { UsageTaskBindingAuthority } from "./usage-ledger.js";
const serviceClass = z.enum(["lite", "balanced", "pro"]);
const managedProvider = z.enum([
  "foundry",
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
      .min(3)
      .max(100),
  })
  .superRefine((value, context) => {
    for (const name of serviceClass.options)
      if (!value.deployments.some((deployment) => deployment.serviceClass === name))
        context.addIssue({
          code: "custom",
          path: ["deployments"],
          message: `A ${name} deployment is required`,
        });
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
  constructor(private readonly store: RoutingStore) {}
  latestMapping(actor: Actor) {
    return this.store.latestMappingVersion(actor.tenantId);
  }
  createMapping(
    actor: Actor,
    input: z.infer<typeof createRoutingMappingSchema>,
  ) {
    return this.store.createMappingVersion({
      tenantId: actor.tenantId,
      revisionNote: input.revisionNote,
      createdBy: actor.userId,
      deployments: input.deployments.map((deployment) => ({
        ...deployment,
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
const scaled = (value: string) => {
  const match = /^(-?)(\d+)(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) throw new Error("Invalid exact decimal");
  const amount =
    BigInt(match[2]!) * 10n ** 12n + BigInt((match[3] ?? "").padEnd(12, "0"));
  return match[1] ? -amount : amount;
};
export class RoutingExecutionService {
  private readonly router: DeterministicModelRouter;
  constructor(
    private readonly store: RoutingStore,
    private readonly teams: Pick<TeamStore, "getCurrentDefaultSpendingTeam">,
    private readonly bindings: RoutingDecisionBindingAuthority,
    private readonly taskBindings: UsageTaskBindingAuthority,
    private readonly budgets?: Pick<TeamBudgetStore, "getBudgetStatus">,
  ) {
    this.router = new DeterministicModelRouter(store);
  }
  private persisted(
    prior: Record<string, unknown>,
    status: "created" | "duplicate",
  ) {
    const decisionId = String(prior.id);
    const tenantId = String(prior.tenant_id);
    const requestId = String(prior.request_id);
    const deploymentId = String(prior.executed_deployment_id);
    return {
      schemaVersion: 1,
      status,
      decisionId,
      requestedServiceClass: String(prior.requested_service_class),
      selectedServiceClass: String(prior.selected_service_class),
      reasonCode: String(prior.reason_code),
      executedDeploymentId: deploymentId,
      executedModelGroup: String(prior.executed_provider_deployment),
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
    const prior = await this.store.decisionByRequest(
      input.tenantId,
      input.requestId,
    );
    if (prior) return this.persisted(prior, "duplicate");
    const task = this.taskBindings.verify(input.taskBinding);
    if (
      task.tenantId !== input.tenantId ||
      task.subjectId !== input.subjectId ||
      task.workspaceId !== input.workspaceId ||
      task.agentId !== input.agentId ||
      task.requestedServiceClass !== input.requestedServiceClass
    )
      throw new Error(
        "AI task binding does not match the authenticated routing identity",
      );
    const team = await this.teams.getCurrentDefaultSpendingTeam(
      input.tenantId,
      input.subjectId,
    );
    if (!team)
      throw new Error(
        "A default spending Team is required for governed routing",
      );
    const resolved = await this.store.resolveEffectivePolicy(
      input.tenantId,
      team.id,
      input.expectedUsage as UsageAmount[],
    );
    if (!resolved)
      throw new Error("Governed routing is not configured for this Team");
    if (this.budgets && resolved.rollout.mode !== "disabled") {
      const status = await this.budgets.getBudgetStatus(
        input.tenantId,
        team.id,
      );
      if (status.budget?.mode === "hard" && status.enforcement !== "override") {
        if (status.priceStatus !== "priced" || status.remainingAmount === null)
          resolved.policy.budgetEligibleDeploymentIds = [];
        else
          resolved.policy.budgetEligibleDeploymentIds =
            resolved.policy.deployments
              .filter(
                (deployment) =>
                  deployment.expectedCost?.currency ===
                    status.budget!.currency &&
                  scaled(deployment.expectedCost.amount) <=
                    scaled(status.remainingAmount!),
              )
              .map(({ id }) => id);
      }
    }
    const decision = await this.router.route(
      {
        requestId: input.requestId,
        tenantId: input.tenantId,
        userId: input.subjectId,
        teamId: team.id,
        taskId: task.taskId,
        requestedServiceClass: input.requestedServiceClass,
        boundedSignals: input.boundedSignals,
        estimatedInputTokens: input.estimatedInputTokens,
        ...(task.sessionId ? { sessionId: task.sessionId } : {}),
        requiredCapabilities: input.requiredCapabilities,
        ...(input.unavailableDeploymentIds
          ? { unavailableDeploymentIds: input.unavailableDeploymentIds }
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
      return this.persisted(concurrent, "duplicate");
    }
    return {
      schemaVersion: 1,
      status: "created",
      decisionId: recorded.id,
      requestedServiceClass: decision.requestedServiceClass,
      selectedServiceClass: decision.selectedServiceClass,
      reasonCode: decision.reasonCode,
      executedDeploymentId: decision.executedDeployment.id,
      executedModelGroup: decision.executedDeployment.deployment,
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
