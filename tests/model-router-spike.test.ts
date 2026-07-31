import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicModelRouter,
  ModelRoutingError,
  classifyRoutingTask,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type RoutingDeployment,
} from "@onecomputer/litellm-adapter";

const fullCapabilities = {
  vision: true,
  tools: true,
  streaming: true,
  contextTokens: 200_000,
};

const deployments: RoutingDeployment[] = [
  {
    id: "lite-foundry-luna-v1",
    provider: "foundry",
    model: "foundry/gpt-5.6-luna",
    serviceClass: "Lite",
    mappingVersion: "classes-2026-07-31.1",
    rateCardKey: "foundry:gpt-5.6-luna:global:2026-07-01",
    capabilities: { ...fullCapabilities, vision: false, contextTokens: 128_000 },
    healthy: true,
  },
  {
    id: "lite-openai-luna-vision-v1",
    provider: "openai",
    model: "openai/gpt-5.6-luna",
    serviceClass: "Lite",
    mappingVersion: "classes-2026-07-31.1",
    rateCardKey: "openai:gpt-5.6-luna:global:2026-07-01",
    capabilities: { ...fullCapabilities, contextTokens: 128_000 },
    healthy: true,
  },
  {
    id: "balanced-openai-terra-v1",
    provider: "openai",
    model: "openai/gpt-5.6-terra",
    serviceClass: "Balanced",
    mappingVersion: "classes-2026-07-31.1",
    rateCardKey: "openai:gpt-5.6-terra:global:2026-07-01",
    capabilities: fullCapabilities,
    healthy: true,
  },
  {
    id: "balanced-glm-v1",
    provider: "glm",
    model: "zai/glm-5.2",
    serviceClass: "Balanced",
    mappingVersion: "classes-2026-07-31.1",
    rateCardKey: "zai:glm-5.2:global:2026-07-01",
    capabilities: { ...fullCapabilities, vision: false },
    healthy: true,
  },
  {
    id: "pro-bedrock-opus-v1",
    provider: "bedrock",
    model: "bedrock/converse/global.anthropic.claude-opus-4-8-v1:0",
    serviceClass: "Pro",
    mappingVersion: "classes-2026-07-31.1",
    rateCardKey: "bedrock:claude-opus-4-8:ap-southeast-1:2026-07-01",
    capabilities: fullCapabilities,
    healthy: true,
  },
  {
    id: "pro-anthropic-opus-v1",
    provider: "anthropic",
    model: "anthropic/claude-opus-4-8",
    serviceClass: "Pro",
    mappingVersion: "classes-2026-07-31.1",
    rateCardKey: "anthropic:claude-opus-4-8:global:2026-07-01",
    capabilities: fullCapabilities,
    healthy: true,
  },
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

test("bounded classifier deterministically covers all internal tiers and low-confidence default", () => {
  assert.equal(classifyRoutingTask("Hello").taskClass, "SIMPLE");
  assert.equal(classifyRoutingTask("Explain how an API endpoint works.").taskClass, "MEDIUM");
  assert.equal(
    classifyRoutingTask("Design a distributed architecture with encryption, concurrency, database and API requirements.").taskClass,
    "COMPLEX",
  );
  assert.equal(
    classifyRoutingTask("Think through the pros and cons step by step, then compare and contrast every option.").taskClass,
    "REASONING",
  );
  const lowConfidence = classifyRoutingTask("Summarize the material in a useful response for the intended audience without changing its meaning.");
  assert.equal(lowConfidence.taskClass, "MEDIUM");
  assert.equal(lowConfidence.confidence, 0.4);
  assert.deepEqual(lowConfidence.signals, ["low_confidence_default"]);
});

test("Auto maps internal classifications to stable product service classes", async () => {
  const router = new DeterministicModelRouter();
  const fixtures = [
    ["Hello", "Lite"],
    ["Explain how an API endpoint works.", "Balanced"],
    ["Design a distributed architecture with encryption, concurrency, database and API requirements.", "Pro"],
    ["Think through the pros and cons step by step, then compare and contrast every option.", "Pro"],
  ] as const;
  for (const [prompt, expected] of fixtures) {
    const decision = await router.route(request({ prompt }), policy);
    assert.equal(decision.requestedAlias, "onecomputer-auto");
    assert.equal(decision.selectedServiceClass, expected);
    assert.ok(decision.routerOverheadMs >= 0);
  }
});

test("explicit service classes are bounded and cannot name arbitrary provider models", async () => {
  const router = new DeterministicModelRouter();
  const explicit = await router.route(request({ requestedServiceClass: "Pro" }), policy);
  assert.equal(explicit.cause, "explicit_service_class");
  assert.equal(explicit.selectedServiceClass, "Pro");
  await assert.rejects(
    router.route(request({ requestedServiceClass: "bedrock/converse/arbitrary-model" }), policy),
    errorCode("SERVICE_CLASS_INVALID"),
  );
  await assert.rejects(
    router.route(request({ requestedServiceClass: "Pro" }), { ...policy, allowedServiceClasses: ["Lite", "Balanced"] }),
    errorCode("SERVICE_CLASS_DENIED"),
  );
});

test("session affinity pins the service class without bypassing current capability policy", async () => {
  const router = new DeterministicModelRouter();
  const first = await router.route(request({ sessionId: "conversation-1" }), policy);
  assert.equal(first.selectedServiceClass, "Lite");
  const next = await router.route(request({
    sessionId: "conversation-1",
    prompt: "Think through the pros and cons step by step, then compare and contrast every option.",
    requiredCapabilities: { vision: true, tools: true, streaming: true, contextTokens: 32_000 },
  }), policy);
  assert.equal(next.cause, "session_affinity");
  assert.equal(next.selectedServiceClass, "Lite");
  assert.equal(next.selectedDeployment.id, "lite-openai-luna-vision-v1");
});

test("provider outage falls back only inside the approved service class and records each skipped attempt", async () => {
  const decision = await new DeterministicModelRouter().route(request({
    requestedServiceClass: "Pro",
    unavailableDeploymentIds: ["pro-bedrock-opus-v1"],
  }), policy);
  assert.equal(decision.selectedDeployment.id, "pro-anthropic-opus-v1");
  assert.deepEqual(decision.fallbackDeploymentIds, ["pro-bedrock-opus-v1"]);
});

test("vision, tools, streaming, context floors, and tenant/model allowlists fail closed", async () => {
  const router = new DeterministicModelRouter();
  const vision = await router.route(request({
    requestedServiceClass: "Lite",
    requiredCapabilities: { vision: true, tools: true, streaming: true, contextTokens: 32_000 },
  }), policy);
  assert.equal(vision.selectedDeployment.id, "lite-openai-luna-vision-v1");
  await assert.rejects(
    router.route(request({
      requestedServiceClass: "Lite",
      requiredCapabilities: { contextTokens: 300_000 },
    }), policy),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );
  await assert.rejects(
    router.route(request(), { ...policy, allowedDeploymentIds: [] }),
    errorCode("NO_ELIGIBLE_DEPLOYMENT"),
  );
  await assert.rejects(
    router.route(request({ tenantId: "tenant-beta" }), policy),
    errorCode("ROUTING_SCOPE_DENIED"),
  );
});

test("service-class deployment replacement preserves the contract and immutable historical evidence", async () => {
  const router = new DeterministicModelRouter();
  const before = await router.route(request(), policy);
  const replacement: RoutingDeployment = {
    ...deployments[0]!,
    id: "lite-bedrock-luna-v2",
    provider: "bedrock",
    model: "bedrock/converse/amazon.nova-lite-v2",
    mappingVersion: "classes-2026-08-15.1",
    rateCardKey: "bedrock:nova-lite-v2:ap-southeast-1:2026-08-15",
  };
  const after = await router.route(request(), {
    ...policy,
    allowedDeploymentIds: [replacement.id],
    deployments: [replacement],
  });
  assert.equal(before.requestedAlias, after.requestedAlias);
  assert.equal(before.selectedServiceClass, after.selectedServiceClass);
  assert.equal(before.selectedDeployment.id, "lite-foundry-luna-v1");
  assert.equal(before.mappingVersion, "classes-2026-07-31.1");
  assert.equal(after.selectedDeployment.id, "lite-bedrock-luna-v2");
  assert.equal(after.mappingVersion, "classes-2026-08-15.1");
});

test("persistable decision evidence excludes prompts, responses, reasoning, keys, payloads, and session ids", async () => {
  const secret = "RAW-PROMPT-SECRET-7f3e";
  const decision = await new DeterministicModelRouter().route(request({
    prompt: `Hello ${secret}`,
    sessionId: "PRIVATE-SESSION-123",
  }), policy);
  const evidence = JSON.stringify(decision);
  assert.doesNotMatch(evidence, /RAW-PROMPT|PRIVATE-SESSION|api[_-]?key|response|payload|chain.of.thought/i);
  assert.match(evidence, /short_request/);
  assert.match(evidence, /rateCardKey/);
});

test("fallback router overhead is measured separately and needs no classifier provider spend", async () => {
  const router = new DeterministicModelRouter();
  const overhead: number[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    overhead.push((await router.route(request(), policy)).routerOverheadMs);
  }
  overhead.sort((left, right) => left - right);
  assert.ok(overhead[950]! < 10, `expected local p95 below 10ms, got ${overhead[950]}ms`);
});
