import assert from "node:assert/strict";
import test from "node:test";
import { BudgetUsageAttemptAdmission, budgetPeriodFor, quoteBudgetAttempt, type AttemptAdmissionInput, type TeamBudgetStore } from "@onecomputer/workspace-store";

test("calendar budget boundaries use local midnight through DST", () => {
  const march = budgetPeriodFor(new Date("2026-03-15T12:00:00Z"), "calendar_month", "America/New_York");
  assert.equal(march.start.toISOString(), "2026-03-01T05:00:00.000Z");
  assert.equal(march.end.toISOString(), "2026-04-01T04:00:00.000Z");
  assert.equal((march.end.getTime() - march.start.getTime()) / 3_600_000, 743);

  const dstWeek = budgetPeriodFor(new Date("2026-03-05T12:00:00Z"), "calendar_week", "America/New_York");
  assert.equal(dstWeek.start.toISOString(), "2026-03-02T05:00:00.000Z");
  assert.equal(dstWeek.end.toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal((dstWeek.end.getTime() - dstWeek.start.getTime()) / 3_600_000, 167);

  const singapore = budgetPeriodFor(new Date("2026-01-31T20:00:00Z"), "calendar_month", "Asia/Singapore");
  assert.equal(singapore.start.toISOString(), "2026-01-31T16:00:00.000Z");
  assert.equal(singapore.end.toISOString(), "2026-02-28T16:00:00.000Z");
});

test("quotes assume a miss when cache state is unknown and bound retries, fallbacks, steps, and routing overhead", () => {
  const rates = [
    { unit: "input_uncached_token" as const, amountPerUnit: "1", unitScale: "1" },
    { unit: "cache_read_token" as const, amountPerUnit: "0.1", unitScale: "1" },
    { unit: "output_token" as const, amountPerUnit: "1", unitScale: "1" },
    { unit: "request" as const, amountPerUnit: "1", unitScale: "1" },
  ];
  const unknown = quoteBudgetAttempt({
    inputTokens: "10", cacheReadTokens: "10", maximumOutputTokens: "5",
    requestUnits: "1", cacheStatus: "unknown", maxRetries: 1, maxFallbacks: 1,
    maxAgentSteps: 2, routingOverhead: [{ unit: "request", quantity: "2" }],
  }, rates);
  assert.equal(unknown.cacheAssumption, "unknown_assume_miss");
  assert.equal(unknown.maxAttempts, 3);
  assert.deepEqual(unknown.usage, [
    { unit: "input_uncached_token", quantity: "60.000000000000" },
    { unit: "output_token", quantity: "30.000000000000" },
    { unit: "request", quantity: "10.000000000000" },
  ]);
  assert.equal(unknown.providerCost, "100.000000000000");

  const hit = quoteBudgetAttempt({
    inputTokens: "10", cacheReadTokens: "10", maximumOutputTokens: "5",
    cacheStatus: "known_hit", maxRetries: 0, maxFallbacks: 0, maxAgentSteps: 1,
  }, rates);
  assert.equal(hit.providerCost, "6.000000000000");
  assert.equal(hit.cacheAssumption, "known_hit");

  const incomplete = quoteBudgetAttempt({
    inputTokens: "10", maximumOutputTokens: "5", cacheStatus: "known_miss",
    maxRetries: 0, maxFallbacks: 0, maxAgentSteps: 1,
  }, rates.slice(0, 1));
  assert.equal(incomplete.priceStatus, "incomplete");
  assert.equal(incomplete.providerCost, null);
});

const attempt: AttemptAdmissionInput = {
  tenantId:"tenant",sourceSystem:"litellm",sourceAttemptId:"attempt",subjectId:"user",
  team:{id:"00000000-0000-4000-8000-000000000001",displayName:"Team",costCenterCode:null},
  taskId:"task",taskBindingProvenance:"explicit_signed",contextKind:"chat",requestedAlias:"Auto",
  attemptKind:"inference",resolvedProvider:"openai",providerAccountId:"account",
  resolvedModel:"model",resolvedDeploymentId:"deployment",admittedAt:new Date("2026-01-01T00:00:00Z"),
};

test("admission performs fail-closed eligibility before reserving capacity", async () => {
  let reservations=0;
  const budgets={reserveAttemptInTransaction:async()=>{reservations+=1;return {decision:"allow" as const};}} as Pick<TeamBudgetStore,"reserveAttemptInTransaction">;
  const denied=new BudgetUsageAttemptAdmission(budgets,{admit:async()=>({decision:"deny" as const,code:"POLICY_DENIED"})});
  assert.deepEqual(await denied.admit(attempt,{} as never),{decision:"deny",code:"POLICY_DENIED"});
  assert.equal(reservations,0);
  const allowed=new BudgetUsageAttemptAdmission(budgets,{admit:async()=>({decision:"allow" as const})});
  assert.deepEqual(await allowed.admit(attempt,{} as never),{decision:"allow"});
  assert.equal(reservations,1);
});
