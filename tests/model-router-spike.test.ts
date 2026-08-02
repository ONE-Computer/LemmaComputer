import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicModelRouter,
  ModelRoutingError,
  RoutingDecisionBindingAuthority,
  compareExactMoney,
  validateGovernedTransportRequest,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type RoutingAffinityStore,
  type RoutingDeployment,
  type SessionAffinity,
} from "@onecomputer/model-router";

class MemoryAffinity implements RoutingAffinityStore {
  values = new Map<string, SessionAffinity>();
  async get(tenantId: string, key: string, now: Date) {
    const found = this.values.get(`${tenantId}:${key}`);
    return found && found.expiresAt > now ? found : null;
  }
  async put(value: SessionAffinity) {
    this.values.set(`${value.tenantId}:${value.affinityKey}`, value);
  }
}
const capabilities = {
  vision: true,
  tools: true,
  streaming: true,
  contextTokens: 200_000,
  outputTokens: 16_000,
  residency: ["sg"],
};
const deployment = (
  id: string,
  serviceClass: "lite" | "balanced" | "pro",
  amount: string,
  overrides: Partial<RoutingDeployment> = {},
): RoutingDeployment => ({
  id,
  provider: "bedrock",
  model: `private/${id}`,
  deployment: `deployment/${id}`,
  serviceClass,
  mappingVersionId: "mapping-v1",
  rateCardId: `rate-${id}`,
  expectedCost: { amount, currency: "USD" },
  capabilities,
  approved: true,
  healthy: true,
  evaluationPassed: true,
  ...overrides,
});
const deployments = [
  deployment("lite-a", "lite", "0.010000000002"),
  deployment("lite-b", "lite", "0.010000000001"),
  deployment("balanced", "balanced", "0.03"),
  deployment("pro", "pro", "0.05"),
];
const scope = {
  allowedServiceClasses: ["lite", "balanced", "pro"] as const,
  allowedDeploymentIds: deployments.map(({ id }) => id),
  explicitSelectionAllowed: true,
  forceServiceClass: null,
  safeDefault: "balanced" as const,
};
const classPolicy = (eligibleDeploymentIds: string[]) => ({
  capabilityFloor: {
    vision: false,
    tools: false,
    streaming: true,
    contextTokens: 8_000,
    outputTokens: 1_000,
  },
  evaluationThreshold: "0.800000",
  qualityPosture: "standard" as const,
  costPosture: "balanced" as const,
  latencyPosture: "balanced" as const,
  requiredModalities: ["text" as const],
  requiredResidency: ["sg"],
  eligibleDeploymentIds,
  safeDefault: false,
});
const policy = (
  overrides: Partial<ModelRoutingPolicy> = {},
): ModelRoutingPolicy => ({
  tenantId: "tenant-a",
  teamId: "team-a",
  policyVersionId: "policy-v1",
  mappingVersionId: "mapping-v1",
  mode: "shadow",
  fixedDeploymentId: "balanced",
  billingCurrency: "USD",
  serviceClassPolicies: {
    lite: classPolicy(["lite-a", "lite-b"]),
    balanced: classPolicy(["balanced"]),
    pro: classPolicy(["pro"]),
  },
  identity: {
    ...scope,
    allowedServiceClasses: [...scope.allowedServiceClasses],
  },
  team: null,
  deployments,
  budgetEligibleDeploymentIds: deployments.map(({ id }) => id),
  approvedProviders: ["bedrock"],
  requiredResidency: "sg",
  ...overrides,
});
const request = (
  overrides: Partial<ModelRoutingRequest> = {},
): ModelRoutingRequest => ({
  requestId: "req-1",
  tenantId: "tenant-a",
  userId: "user-a",
  teamId: "team-a",
  taskId: "task-a",
  requestedServiceClass: "auto",
  boundedSignals: ["short_request"],
  estimatedInputTokens: 10,
  requiredCapabilities: { streaming: true, contextTokens: 8_000 },
  ...overrides,
});
const errorCode = (code: ModelRoutingError["code"]) => (error: unknown) =>
  error instanceof ModelRoutingError && error.code === code;

test("exact decimal ranking never converts money to Number", async () => {
  assert.equal(
    compareExactMoney(
      { amount: "0.010000000001", currency: "USD" },
      { amount: "0.010000000002", currency: "USD" },
    ),
    -1,
  );
  const decision = await new DeterministicModelRouter().route(
    request(),
    policy(),
  );
  assert.equal(decision.selectedDeployment.id, "lite-b");
  assert.deepEqual(decision.selectedDeployment.expectedCost, {
    amount: "0.010000000001",
    currency: "USD",
  });
});
test("governed transport exposes one alias and cannot directly name provider models", () => {
  const authority = new RoutingDecisionBindingAuthority(
    "routing-test-secret-at-least-32-characters",
  );
  const routingBinding = authority.issue({
    tenantId: "tenant-a",
    requestId: "req-1",
    decisionId: "decision-1",
    deploymentId: "balanced",
    mappingVersionId: "mapping-v1",
    policyVersionId: "policy-v1",
  });
  assert.equal(
    validateGovernedTransportRequest({
      model: "onecomputer-auto",
      metadata: { requestedServiceClass: "auto", routingBinding },
      messages: [],
    }).model,
    "onecomputer-auto",
  );
  assert.throws(
    () =>
      validateGovernedTransportRequest({
        model: "bedrock/opus",
        metadata: { requestedServiceClass: "pro", routingBinding },
        messages: [],
      }),
    errorCode("SERVICE_CLASS_INVALID"),
  );
});
test("stable aliases reject provider names and Team policy can only narrow identity policy", async () => {
  const router = new DeterministicModelRouter();
  await assert.rejects(
    router.route(request({ requestedServiceClass: "bedrock/opus" }), policy()),
    errorCode("SERVICE_CLASS_INVALID"),
  );
  await assert.rejects(
    router.route(
      request({ requestedServiceClass: "pro" }),
      policy({
        mode: "enabled",
        team: {
          ...scope,
          allowedServiceClasses: ["lite"],
          allowedDeploymentIds: ["lite-a", "lite-b"],
          safeDefault: "lite",
        },
      }),
    ),
    errorCode("SERVICE_CLASS_DENIED"),
  );
});
test("Auto covers simple, complex, reasoning, vision, tools, long context, and low confidence", async () => {
  const router = new DeterministicModelRouter();
  assert.equal(
    (await router.route(request(), policy())).selectedServiceClass,
    "lite",
  );
  assert.equal(
    (
      await router.route(
        request({ boundedSignals: ["technical_request"] }),
        policy(),
      )
    ).selectedServiceClass,
    "pro",
  );
  assert.equal(
    (
      await router.route(
        request({ boundedSignals: ["reasoning_request"] }),
        policy(),
      )
    ).selectedServiceClass,
    "pro",
  );
  assert.equal(
    (
      await router.route(
        request({
          boundedSignals: ["vision_required"],
          requiredCapabilities: { vision: true },
        }),
        policy(),
      )
    ).selectedServiceClass,
    "lite",
  );
  assert.equal(
    (
      await router.route(
        request({
          boundedSignals: ["tools_required"],
          requiredCapabilities: { tools: true },
        }),
        policy(),
      )
    ).selectedServiceClass,
    "lite",
  );
  assert.equal(
    (
      await router.route(
        request({ boundedSignals: [], estimatedInputTokens: 120_000 }),
        policy(),
      )
    ).selectedServiceClass,
    "pro",
  );
  assert.equal(
    (
      await router.route(
        request({ boundedSignals: [], estimatedInputTokens: 30 }),
        policy(),
      )
    ).selectedServiceClass,
    "balanced",
  );
});
test("shadow records an Auto hypothetical route while executing the fixed route", async () => {
  const decision = await new DeterministicModelRouter().route(
    request(),
    policy(),
  );
  assert.equal(decision.selectedDeployment.id, "lite-b");
  assert.equal(decision.executedDeployment.id, "balanced");
  assert.equal(decision.selectionStatus, "selected");
  assert.equal(decision.reasonCode, "shadow_fixed_route");
  assert.equal(decision.shadow, true);
});
test("explicit service classes execute their mapped deployment while Auto remains in shadow", async () => {
  const router = new DeterministicModelRouter();
  const lite = await router.route(
    request({ requestedServiceClass: "lite" }),
    policy(),
  );
  assert.equal(lite.selectedServiceClass, "lite");
  assert.equal(lite.executedDeployment.id, "lite-b");
  assert.equal(lite.reasonCode, "explicit_service_class");
  assert.equal(lite.shadow, false);

  const pro = await router.route(
    request({ requestedServiceClass: "pro" }),
    policy(),
  );
  assert.equal(pro.selectedServiceClass, "pro");
  assert.equal(pro.executedDeployment.id, "pro");
  assert.equal(pro.reasonCode, "explicit_service_class");
  assert.equal(pro.shadow, false);
});
test("enabled executes selection and disabled keeps the emergency fixed route", async () => {
  assert.equal(
    (
      await new DeterministicModelRouter().route(
        request(),
        policy({ mode: "enabled" }),
      )
    ).executedDeployment.id,
    "lite-b",
  );
  assert.equal(
    (
      await new DeterministicModelRouter().route(
        request({ requestedServiceClass: "pro" }),
        policy({ mode: "disabled" }),
      )
    ).executedDeployment.id,
    "balanced",
  );
});
test("shadow and disabled preserve the fixed route without an eligible hypothetical candidate", async () => {
  const router = new DeterministicModelRouter();
  const shadow = await router.route(
    request(),
    policy({ budgetEligibleDeploymentIds: [] }),
  );
  assert.equal(shadow.executedDeployment.id, "balanced");
  assert.equal(shadow.selectedDeployment.id, "balanced");
  assert.equal(shadow.selectionStatus, "no_candidate");
  assert.equal(shadow.reasonCode, "no_hypothetical_candidate");
  assert.equal(shadow.selectedDeployment.expectedCost, null);

  await assert.rejects(
    router.route(
      request({ requestedServiceClass: "pro" }),
      policy({
        team: {
          ...scope,
          allowedServiceClasses: ["lite", "balanced"],
          explicitSelectionAllowed: false,
        },
      }),
    ),
    errorCode("SERVICE_CLASS_DENIED"),
  );

  await assert.rejects(
    router.route(
      request({ requestedServiceClass: "pro" }),
      policy({ budgetEligibleDeploymentIds: [] }),
    ),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );

  const disabled = await router.route(
    request(),
    policy({
      mode: "disabled",
      budgetEligibleDeploymentIds: [],
      deployments: deployments.map((item) => ({
        ...item,
        rateCardId: null,
        expectedCost: null,
      })),
    }),
  );
  assert.equal(disabled.executedDeployment.id, "balanced");
  assert.equal(disabled.selectionStatus, "fixed");
  assert.equal(disabled.reasonCode, "fixed_route");
});
test("unknown and mixed-currency prices, exhausted budgets, provider down, and incapable routes fail closed", async () => {
  const base = policy({ mode: "enabled" });
  await assert.rejects(
    new DeterministicModelRouter().route(
      request(),
      policy({
        mode: "enabled",
        deployments: [
          deployment("unknown", "lite", "0", {
            rateCardId: null,
            expectedCost: null,
          }),
        ],
        fixedDeploymentId: "unknown",
        budgetEligibleDeploymentIds: ["unknown"],
      }),
    ),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );
  await assert.rejects(
    new DeterministicModelRouter().route(
      request(),
      policy({
        mode: "enabled",
        deployments: [
          deployment("eur", "lite", "0.01", {
            expectedCost: { amount: "0.01", currency: "EUR" },
          }),
          deployment("usd", "lite", "0.02"),
        ],
        fixedDeploymentId: "usd",
        budgetEligibleDeploymentIds: ["eur"],
      }),
    ),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );
  await assert.rejects(
    new DeterministicModelRouter().route(
      request(),
      policy({ ...base, budgetEligibleDeploymentIds: [] }),
    ),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );
  await assert.rejects(
    new DeterministicModelRouter().route(
      request({ unavailableDeploymentIds: deployments.map(({ id }) => id) }),
      base,
    ),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );
  await assert.rejects(
    new DeterministicModelRouter().route(
      request({ requiredCapabilities: { contextTokens: 999_999 } }),
      base,
    ),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );
});
test("health evidence selects a safe peer and records same-class availability escalation", async () => {
  const decision = await new DeterministicModelRouter().route(
    request({ unavailableDeploymentIds: ["lite-b"] }),
    policy({ mode: "enabled" }),
  );
  assert.equal(decision.selectedDeployment.id, "lite-a");
  assert.equal(decision.reasonCode, "availability_escalation");
  assert.equal(decision.escalationReason, "availability");
  assert.deepEqual(
    decision.ineligible.filter(({ reasonCode }) => reasonCode === "health"),
    [{ deploymentId: "lite-b", reasonCode: "health" }],
  );
});
test("health evidence escalates service class and preserves availability as the cause", async () => {
  const decision = await new DeterministicModelRouter().route(
    request({ unavailableDeploymentIds: ["lite-a", "lite-b"] }),
    policy({ mode: "enabled" }),
  );
  assert.equal(decision.selectedDeployment.id, "balanced");
  assert.equal(decision.reasonCode, "availability_escalation");
  assert.equal(decision.escalationReason, "availability");
});
test("an unavailable fixed route fails closed instead of bypassing its signed binding", async () => {
  await assert.rejects(
    new DeterministicModelRouter().route(
      request({ unavailableDeploymentIds: ["balanced"] }),
      policy({ mode: "shadow" }),
    ),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );
});
test("durable tenant-scoped affinity preserves follow-ups and escalates stronger tasks", async () => {
  const affinities = new MemoryAffinity();
  const router = new DeterministicModelRouter(affinities);
  const first = await router.route(
    request({ sessionId: "secret-session" }),
    policy(),
  );
  const follow = await router.route(
    request({
      requestId: "req-2",
      sessionId: "secret-session",
      boundedSignals: [],
      estimatedInputTokens: 30,
    }),
    policy(),
  );
  assert.equal(first.selectedServiceClass, "lite");
  assert.equal(follow.selectedServiceClass, "lite");
  const stronger = await router.route(
    request({
      requestId: "req-3",
      sessionId: "secret-session",
      boundedSignals: ["reasoning_request"],
    }),
    policy(),
  );
  assert.equal(stronger.selectedServiceClass, "pro");
  assert.equal(stronger.affinityMovedReason, "stronger_task");
  assert.doesNotMatch(
    JSON.stringify(stronger),
    /secret-session|prompt|response|tool.arguments/i,
  );
  await assert.rejects(
    router.route(request({ tenantId: "tenant-b" }), policy()),
    errorCode("ROUTING_SCOPE_DENIED"),
  );
});
test("affinity pins the exact deployment while eligible and records provider-down movement", async () => {
  const affinities = new MemoryAffinity();
  const router = new DeterministicModelRouter(affinities);
  const onlyExpensive = policy({
    mode: "enabled",
    deployments: [deployments[0]!, deployments[2]!, deployments[3]!],
    identity: {
      ...scope,
      allowedDeploymentIds: ["lite-a", "balanced", "pro"],
      allowedServiceClasses: ["lite", "balanced", "pro"],
    },
    budgetEligibleDeploymentIds: ["lite-a", "balanced", "pro"],
  });
  assert.equal(
    (await router.route(request({ sessionId: "sticky" }), onlyExpensive))
      .selectedDeployment.id,
    "lite-a",
  );
  assert.equal(
    (
      await router.route(
        request({ requestId: "sticky-2", sessionId: "sticky" }),
        policy({ mode: "enabled" }),
      )
    ).selectedDeployment.id,
    "lite-a",
  );
  const moved = await router.route(
    request({
      requestId: "sticky-3",
      sessionId: "sticky",
      unavailableDeploymentIds: ["lite-a"],
    }),
    policy({ mode: "enabled" }),
  );
  assert.equal(moved.selectedDeployment.id, "lite-b");
  assert.equal(moved.affinityMovedReason, "deployment_unavailable");
  assert.equal(moved.reasonCode, "availability_escalation");
});
test("signed decision binding authorizes exactly the executed concrete deployment", () => {
  const authority = new RoutingDecisionBindingAuthority(
    "routing-test-secret-at-least-32-characters",
  );
  const binding = authority.issue({
    tenantId: "tenant-a",
    requestId: "req-1",
    decisionId: "decision-1",
    deploymentId: "balanced",
    mappingVersionId: "mapping-v1",
    policyVersionId: "policy-v1",
  });
  assert.equal(
    authority.verify(binding, {
      tenantId: "tenant-a",
      requestId: "req-1",
      deploymentId: "balanced",
    }).decisionId,
    "decision-1",
  );
  assert.throws(
    () =>
      authority.verify(binding, {
        tenantId: "tenant-a",
        requestId: "req-1",
        deploymentId: "lite-b",
      }),
    errorCode("DECISION_BINDING_MISMATCH"),
  );
});
test("mapping replacement preserves the service-class alias and historical decision evidence", async () => {
  const before = await new DeterministicModelRouter().route(
    request(),
    policy({ mode: "enabled" }),
  );
  const replacement = deployment("foundry-lite", "lite", "0.009", {
    provider: "foundry",
    mappingVersionId: "mapping-v2",
    model: "private/replacement",
    deployment: "managed/replacement",
  });
  const after = await new DeterministicModelRouter().route(
    request(),
    policy({
      mode: "enabled",
      mappingVersionId: "mapping-v2",
      deployments: [replacement],
      fixedDeploymentId: replacement.id,
      budgetEligibleDeploymentIds: [replacement.id],
      approvedProviders: ["foundry"],
      serviceClassPolicies: {
        lite: classPolicy([replacement.id]),
        balanced: classPolicy([replacement.id]),
        pro: classPolicy([replacement.id]),
      },
      identity: {
        ...scope,
        allowedDeploymentIds: [replacement.id],
        allowedServiceClasses: ["lite", "balanced", "pro"],
      },
    }),
  );
  assert.equal(before.selectedServiceClass, after.selectedServiceClass);
  assert.equal(before.mappingVersionId, "mapping-v1");
  assert.equal(after.mappingVersionId, "mapping-v2");
  assert.notEqual(before.selectedDeployment.id, after.selectedDeployment.id);
});
