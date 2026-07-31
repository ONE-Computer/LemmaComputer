import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicModelRouter,
  ModelRoutingError,
  classifyRoutingTask,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type RoutingDeployment,
} from "@onecomputer/model-router";

const capabilities = { vision: true, tools: true, streaming: true, contextTokens: 200_000 };
const deployments: RoutingDeployment[] = [
  { id: "lite-expensive", provider: "openai", model: "openai/luna", serviceClass: "Lite", mappingVersion: "v1", rateCardKey: "openai:luna:v1", expectedCostUsd: 0.02, capabilities: { ...capabilities, vision: false }, healthy: true },
  { id: "lite-cheap", provider: "foundry", model: "foundry/luna", serviceClass: "Lite", mappingVersion: "v1", rateCardKey: "foundry:luna:v1", expectedCostUsd: 0.01, capabilities: { ...capabilities, vision: false }, healthy: true },
  { id: "balanced-vision", provider: "glm", model: "zai/glm-5.2", serviceClass: "Balanced", mappingVersion: "v1", rateCardKey: "zai:glm:v1", expectedCostUsd: 0.03, capabilities, healthy: true },
  { id: "pro-primary", provider: "bedrock", model: "bedrock/opus", serviceClass: "Pro", mappingVersion: "v1", rateCardKey: "bedrock:opus:v1", expectedCostUsd: 0.05, capabilities, healthy: true },
  { id: "pro-secondary", provider: "anthropic", model: "anthropic/opus", serviceClass: "Pro", mappingVersion: "v1", rateCardKey: "anthropic:opus:v1", expectedCostUsd: 0.08, capabilities, healthy: true },
];
const policy: ModelRoutingPolicy = {
  tenantId: "tenant-alpha",
  teamId: "team-research",
  allowedServiceClasses: ["Lite", "Balanced", "Pro"],
  allowedDeploymentIds: deployments.map(({ id }) => id),
  deployments,
};
const request = (overrides: Partial<ModelRoutingRequest> = {}): ModelRoutingRequest => ({
  tenantId: "tenant-alpha",
  userId: "user-alex",
  teamId: "team-research",
  requestedServiceClass: "Auto",
  prompt: "Hello",
  requiredCapabilities: { streaming: true, contextTokens: 8_000 },
  ...overrides,
});
const errorCode = (code: ModelRoutingError["code"]) => (error: unknown) =>
  error instanceof ModelRoutingError && error.code === code;

test("classifier covers all internal tiers and low-confidence Balanced default", async () => {
  assert.equal(classifyRoutingTask("Hello").taskClass, "SIMPLE");
  assert.equal(classifyRoutingTask("Explain how an API endpoint works.").taskClass, "MEDIUM");
  assert.equal(classifyRoutingTask("Design a distributed architecture with encryption and concurrency.").taskClass, "COMPLEX");
  assert.equal(classifyRoutingTask("Think through the pros and cons step by step and evaluate them.").taskClass, "REASONING");
  const ambiguous = await new DeterministicModelRouter().route(request({
    prompt: "Summarize the material in a useful response for the intended audience without changing its meaning.",
  }), policy);
  assert.equal(ambiguous.selectedServiceClass, "Balanced");
  assert.equal(ambiguous.cause, "low_confidence_default");
});

test("explicit class is never overridden by stale Auto affinity and arbitrary model names fail", async () => {
  const router = new DeterministicModelRouter();
  await router.route(request({ sessionId: "session-1" }), policy);
  const explicit = await router.route(request({ sessionId: "session-1", requestedServiceClass: "Pro" }), policy);
  assert.equal(explicit.selectedServiceClass, "Pro");
  assert.equal(explicit.cause, "explicit_service_class");
  await assert.rejects(router.route(request({ requestedServiceClass: "bedrock/arbitrary" }), policy), errorCode("SERVICE_CLASS_INVALID"));
});

test("stronger Auto task safely escalates affinity and records why", async () => {
  const router = new DeterministicModelRouter();
  await router.route(request({ sessionId: "session-2" }), policy);
  const escalated = await router.route(request({
    sessionId: "session-2",
    prompt: "Think through the pros and cons step by step, compare and contrast, then evaluate every option.",
  }), policy);
  assert.equal(escalated.selectedServiceClass, "Pro");
  assert.equal(escalated.cause, "session_affinity_escalation");
  assert.equal(escalated.escalationReason, "stronger_task");
});

test("capability floor escalates safely while Team and tenant policy fail closed", async () => {
  const router = new DeterministicModelRouter();
  const decision = await router.route(request({ requiredCapabilities: { vision: true, tools: true, streaming: true } }), policy);
  assert.equal(decision.selectedServiceClass, "Balanced");
  assert.equal(decision.cause, "capability_escalation");
  assert.equal(decision.escalationReason, "capability_floor");
  await assert.rejects(router.route(request({ tenantId: "tenant-beta" }), policy), errorCode("ROUTING_SCOPE_DENIED"));
  await assert.rejects(router.route(request(), { ...policy, allowedDeploymentIds: [] }), errorCode("NO_ELIGIBLE_DEPLOYMENT"));
});

test("candidate ranking uses rate-card expected cost, not configuration order", async () => {
  const decision = await new DeterministicModelRouter().route(request(), policy);
  assert.equal(decision.selectedDeployment.id, "lite-cheap");
  assert.equal(decision.selectedDeployment.expectedCostUsd, 0.01);
  assert.deepEqual(decision.routingCandidateIds, ["lite-cheap", "lite-expensive"]);
  await assert.rejects(
    new DeterministicModelRouter().route(request(), {
      ...policy,
      deployments: [{ ...deployments[0]!, expectedCostUsd: Number.NaN }],
      allowedDeploymentIds: ["lite-expensive"],
    }),
    errorCode("RATE_CARD_INVALID"),
  );
});

test("unavailable candidates are routing skips, never fabricated billed fallback attempts", async () => {
  const decision = await new DeterministicModelRouter().route(request({
    requestedServiceClass: "Pro",
    unavailableDeploymentIds: ["pro-primary"],
  }), policy);
  assert.equal(decision.selectedDeployment.id, "pro-secondary");
  assert.deepEqual(decision.skippedCandidateIds, ["pro-primary"]);
  assert.deepEqual(decision.billedFallbackAttemptIds, []);
});

test("an unavailable lower class safely escalates while retaining every unbilled routing skip", async () => {
  const decision = await new DeterministicModelRouter().route(request({
    unavailableDeploymentIds: ["lite-cheap", "lite-expensive"],
  }), policy);
  assert.equal(decision.selectedServiceClass, "Balanced");
  assert.equal(decision.cause, "availability_escalation");
  assert.equal(decision.escalationReason, "availability");
  assert.deepEqual(decision.routingCandidateIds, ["lite-cheap", "lite-expensive", "balanced-vision"]);
  assert.deepEqual(decision.skippedCandidateIds, ["lite-cheap", "lite-expensive"]);
  assert.deepEqual(decision.billedFallbackAttemptIds, []);
});

test("affinity is hashed, bounded, expires, and rechecks policy", async () => {
  let now = 1_000;
  const router = new DeterministicModelRouter({ affinityTtlMs: 100, maxAffinityEntries: 1, now: () => now });
  await router.route(request({ sessionId: "private-session", prompt: "Hello" }), policy);
  now += 101;
  const afterExpiry = await router.route(request({
    sessionId: "private-session",
    prompt: "Think through the pros and cons step by step, compare and contrast, then evaluate every option.",
  }), policy);
  assert.equal(afterExpiry.cause, "complexity_classifier");
  assert.equal(afterExpiry.selectedServiceClass, "Pro");
  const evidence = JSON.stringify(afterExpiry);
  assert.doesNotMatch(evidence, /private-session|prompt|payload|api[_-]?key|chain.of.thought/i);
});

test("deployment replacement preserves class while version/rate evidence changes immutably", async () => {
  const router = new DeterministicModelRouter();
  const before = await router.route(request(), policy);
  const replacement: RoutingDeployment = {
    ...deployments[1]!,
    id: "lite-bedrock-v2",
    provider: "bedrock",
    model: "bedrock/nova-lite",
    mappingVersion: "v2",
    rateCardKey: "bedrock:nova-lite:v2",
    expectedCostUsd: 0.009,
  };
  const after = await router.route(request(), { ...policy, deployments: [replacement], allowedDeploymentIds: [replacement.id] });
  assert.equal(before.selectedServiceClass, after.selectedServiceClass);
  assert.equal(before.mappingVersion, "v1");
  assert.equal(after.mappingVersion, "v2");
  assert.equal(after.selectedDeployment.rateCardKey, "bedrock:nova-lite:v2");
});

test("router overhead is separate and local", async () => {
  const router = new DeterministicModelRouter();
  const values: number[] = [];
  for (let index = 0; index < 1_000; index += 1) values.push((await router.route(request(), policy)).routerOverheadMs);
  values.sort((left, right) => left - right);
  assert.ok(values[950]! < 10);
});
