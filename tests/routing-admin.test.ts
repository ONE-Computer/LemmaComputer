import assert from "node:assert/strict";
import test from "node:test";
import {
  RoutingAdministrationService,
  changeRoutingRolloutSchema,
  internalRoutingObservationSchema,
  saveRoutingPolicySchema,
  saveRoutingReviewSchema,
} from "../apps/control-api/src/routing.js";
import type { RoutingStore } from "@onecomputer/workspace-store";
const uuid = {
  team: "11111111-1111-4111-8111-111111111111",
  mapping: "22222222-2222-4222-8222-222222222222",
  policy: "33333333-3333-4333-8333-333333333333",
  deployment: "44444444-4444-4444-8444-444444444444",
  review: "55555555-5555-4555-8555-555555555555",
};
const identity = {
  allowedServiceClasses: ["lite", "balanced", "pro"] as const,
  allowedDeploymentIds: [uuid.deployment],
  explicitSelectionAllowed: true,
  forceServiceClass: null,
  safeDefault: "balanced" as const,
};
const classContract = {
  capabilityFloor: {
    vision: false,
    tools: false,
    streaming: true,
    contextTokens: 8000,
    outputTokens: 1000,
  },
  evaluationThreshold: "0.800000",
  qualityPosture: "standard",
  costPosture: "balanced",
  latencyPosture: "balanced",
  requiredModalities: ["text"],
  requiredResidency: ["sg"],
  eligibleDeploymentIds: [uuid.deployment],
  safeDefault: false,
};
const serviceClassPolicies = {
  lite: classContract,
  balanced: { ...classContract, safeDefault: true },
  pro: classContract,
};
test("Team routing schema can narrow but never widen identity policy", () => {
  const base = {
    mappingVersionId: uuid.mapping,
    billingCurrency: "USD",
    serviceClassPolicies,
    identity,
  };
  assert.ok(
    saveRoutingPolicySchema.safeParse({
      ...base,
      team: { ...identity, allowedServiceClasses: ["lite"] },
    }).success,
  );
  assert.equal(
    saveRoutingPolicySchema.safeParse({
      ...base,
      identity: { ...identity, allowedServiceClasses: ["lite"] },
      team: { ...identity, allowedServiceClasses: ["lite", "pro"] },
    }).success,
    false,
  );
});
test("production enablement requires both evidence and an explicit typed confirmation", () => {
  const base = {
    policyVersionId: uuid.policy,
    mappingVersionId: uuid.mapping,
    mode: "enabled",
    fixedDeploymentId: uuid.deployment,
    evidenceReviewId: uuid.review,
    reason: "Representative evidence passed review",
  };
  assert.equal(changeRoutingRolloutSchema.safeParse(base).success, false);
  assert.ok(
    changeRoutingRolloutSchema.safeParse({
      ...base,
      confirmation: "ENABLE AUTO ROUTING",
    }).success,
  );
  assert.equal(
    changeRoutingRolloutSchema.safeParse({
      ...base,
      evidenceReviewId: undefined,
      confirmation: "ENABLE AUTO ROUTING",
    }).success,
    false,
  );
});
test("evidence review metrics are derived by the server", () => {
  assert.ok(
    saveRoutingReviewSchema.safeParse({
      evaluationPassed: true,
      reviewNote: "Representative shadow evidence passed review",
    }).success,
  );
  assert.equal(
    saveRoutingReviewSchema.safeParse({
      evaluationPassed: true,
      reviewNote: "Representative shadow evidence passed review",
      sampleSize: 1000,
      actualCost: "1.00",
      hypotheticalCost: "0.50",
      currency: "USD",
    }).success,
    false,
  );
});
test("kill switch disables the exact current rollout", async () => {
  let captured: Parameters<RoutingStore["createRollout"]>[0] | undefined;
  const store = {
    adminReadModel: async () => ({
      teamId: uuid.team,
      policy: { id: "newer-draft", mappingVersionId: "newer-mapping" },
      rollout: {
        policyVersionId: uuid.policy,
        mappingVersionId: uuid.mapping,
        fixedDeploymentId: uuid.deployment,
      },
      review: null,
      deployments: [],
    }),
    createRollout: async (
      input: Parameters<RoutingStore["createRollout"]>[0],
    ) => {
      captured = input;
      return {};
    },
  } as unknown as RoutingStore;
  await new RoutingAdministrationService(store).killSwitch(
    { tenantId: "tenant-a", userId: "admin" },
    uuid.team,
    "Emergency fixed-route fallback",
  );
  assert.deepEqual(captured, {
    tenantId: "tenant-a",
    teamId: uuid.team,
    policyVersionId: uuid.policy,
    mappingVersionId: uuid.mapping,
    mode: "disabled",
    fixedDeploymentId: uuid.deployment,
    reason: "Emergency fixed-route fallback",
    createdBy: "admin",
  });
});
test("deployment health accepts concrete success or provider failure evidence without treating every error as unavailable", () => {
  const base = {
    schemaVersion: 1 as const,
    tenantId: "tenant-a",
    decisionId: uuid.policy,
    usageEventId: uuid.review,
  };
  assert.ok(
    internalRoutingObservationSchema.safeParse({
      ...base,
      outcome: "success",
      deploymentHealth: "healthy",
    }).success,
  );
  assert.ok(
    internalRoutingObservationSchema.safeParse({ ...base, outcome: "error" })
      .success,
  );
  assert.ok(
    internalRoutingObservationSchema.safeParse({
      ...base,
      outcome: "error",
      deploymentHealth: "unavailable",
    }).success,
  );
  assert.equal(
    internalRoutingObservationSchema.safeParse({
      ...base,
      outcome: "success",
      deploymentHealth: "unavailable",
    }).success,
    false,
  );
});
test("administration service always projects the authenticated tenant into store calls", async () => {
  const calls: string[] = [];
  const store = {
    adminReadModel: async (tenantId: string) => {
      calls.push(tenantId);
      return {
        teamId: uuid.team,
        policy: null,
        rollout: null,
        review: null,
        deployments: [],
      };
    },
    shadowReport: async (tenantId: string) => {
      calls.push(tenantId);
      return {};
    },
    decision: async (tenantId: string) => {
      calls.push(tenantId);
      return null;
    },
  } as unknown as RoutingStore;
  const service = new RoutingAdministrationService(store);
  await service.settings({ tenantId: "tenant-a", userId: "admin" }, uuid.team);
  await service.report({ tenantId: "tenant-a", userId: "admin" }, uuid.team);
  await service.decision(
    { tenantId: "tenant-a", userId: "admin" },
    uuid.policy,
  );
  assert.deepEqual(calls, ["tenant-a", "tenant-a", "tenant-a"]);
});
