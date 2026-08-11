import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import type { ClaimedPlatformTenantCleanupJob, PlatformTenantCleanupJob } from "@lemmacomputer/workspace-store";
import {
  ControlPlaneTenantCleanupAdapter,
  PlatformTenantCleanupDispatcher,
  type PlatformTenantCleanupAdapter,
  type PlatformTenantCleanupStore,
} from "../apps/control-api/src/platform-tenant-cleanup-dispatcher.js";

const job = (overrides: Partial<ClaimedPlatformTenantCleanupJob> = {}): ClaimedPlatformTenantCleanupJob => ({
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "tenant",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "user",
  accessGeneration: 2,
  providerId: "sandbox",
  action: "suspend",
  status: "delivering",
  attemptCount: 1,
  maxAttempts: 8,
  leaseGeneration: 1,
  leaseToken: "33333333-3333-4333-8333-333333333333",
  controllerDestroyedAt: null,
  gatewayRevokedAt: null,
  storagePurgedAt: null,
  completedAt: null,
  lastError: null,
  availableAt: "2026-08-09T08:00:00.000Z",
  claimedAt: "2026-08-09T08:00:00.000Z",
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z",
  ...overrides,
});

test("tenant cleanup preserves suspend storage and resumes completed stages after a retry", async () => {
  const first = job();
  const second = job({
    attemptCount: 2,
    leaseGeneration: 2,
    leaseToken: "44444444-4444-4444-8444-444444444444",
    controllerDestroyedAt: "2026-08-09T08:00:01.000Z",
  });
  const claims = [[first], [second]];
  const calls: string[] = [];
  let gatewayAttempts = 0;
  const adapter: PlatformTenantCleanupAdapter = {
    destroyWorkspace: async () => { calls.push("destroy"); },
    revokeGateway: async () => {
      calls.push("revoke");
      gatewayAttempts += 1;
      if (gatewayAttempts === 1) throw new Error("gateway unavailable");
    },
    purgeWorkspace: async () => { calls.push("purge"); },
  };
  const failed: unknown[] = [];
  const completed: unknown[] = [];
  const store: PlatformTenantCleanupStore = {
    claimTenantCleanupJobs: async () => claims.shift() ?? [],
    renewTenantCleanupLease: async (_id, _lease, _generation, renewedAt) => ({
      ...job(),
      claimedAt: renewedAt.toISOString(),
    }),
    recordTenantCleanupProgress: async (_id, _lease, stage) => job({
      ...(stage === "controller" ? { controllerDestroyedAt: "2026-08-09T08:00:01.000Z" } : {}),
      ...(stage === "gateway" ? { controllerDestroyedAt: "2026-08-09T08:00:01.000Z", gatewayRevokedAt: "2026-08-09T08:00:02.000Z" } : {}),
    }),
    completeTenantCleanupJob: async (...input: unknown[]) => { completed.push(input); return job({ status: "completed" }); },
    failTenantCleanupJob: async (...input: unknown[]) => { failed.push(input); return job({ status: "retry" }); },
    listTenantCleanupJobs: async () => [],
  };
  const now = new Date("2026-08-09T08:00:00.000Z");
  const dispatcher = new PlatformTenantCleanupDispatcher(store, adapter, { now: () => now, baseRetryMs: 1_000 });

  await dispatcher.flush(now);
  assert.deepEqual(calls, ["destroy", "revoke"]);
  assert.equal((failed[0]?.[2] as { retryAt: Date }).retryAt.toISOString(), "2026-08-09T08:00:01.000Z");
  await dispatcher.flush(now);
  assert.deepEqual(calls, ["destroy", "revoke", "revoke"], "completed controller stage is not repeated and suspend does not purge storage");
  assert.equal(completed[0]?.[1], second.leaseToken);
});

test("closed tenant cleanup purges storage only after sandbox destruction and gateway revocation", async () => {
  const calls: string[] = [];
  let current: PlatformTenantCleanupJob = job({ action: "close" });
  const store: PlatformTenantCleanupStore = {
    claimTenantCleanupJobs: async () => [job({ action: "close" })],
    renewTenantCleanupLease: async (_id, _lease, _generation, renewedAt) => ({
      ...current,
      claimedAt: renewedAt.toISOString(),
    }),
    recordTenantCleanupProgress: async (_id, _lease, stage) => {
      calls.push(`record:${stage}`);
      current = {
        ...current,
        ...(stage === "controller" ? { controllerDestroyedAt: new Date().toISOString() } : {}),
        ...(stage === "gateway" ? { gatewayRevokedAt: new Date().toISOString() } : {}),
        ...(stage === "storage" ? { storagePurgedAt: new Date().toISOString() } : {}),
      };
      return current;
    },
    completeTenantCleanupJob: async () => { calls.push("complete"); return { ...current, status: "completed" }; },
    failTenantCleanupJob: async () => { throw new Error("unexpected failure"); },
    listTenantCleanupJobs: async () => [],
  };
  await new PlatformTenantCleanupDispatcher(store, {
    destroyWorkspace: async () => { calls.push("destroy"); },
    revokeGateway: async () => { calls.push("revoke"); },
    purgeWorkspace: async () => { calls.push("purge"); },
  }).flush();
  assert.deepEqual(calls, ["destroy", "record:controller", "revoke", "record:gateway", "purge", "record:storage", "complete"]);
});

test("a cleanup worker that lost its exact generation lease performs no destructive side effect", async () => {
  const calls: string[] = [];
  const stale = job({ action: "close" });
  const store: PlatformTenantCleanupStore = {
    claimTenantCleanupJobs: async () => [stale],
    renewTenantCleanupLease: async () => {
      throw new LemmaComputerError("PLATFORM_TENANT_CLEANUP_LEASE_LOST", "Replacement worker owns cleanup", 409);
    },
    recordTenantCleanupProgress: async () => { throw new Error("unexpected progress"); },
    completeTenantCleanupJob: async () => { throw new Error("unexpected completion"); },
    failTenantCleanupJob: async () => { throw new Error("unexpected failure mutation"); },
    listTenantCleanupJobs: async () => [],
  };
  const dispatcher = new PlatformTenantCleanupDispatcher(store, {
    destroyWorkspace: async () => { calls.push("destroy"); },
    revokeGateway: async () => { calls.push("revoke"); },
    purgeWorkspace: async () => { calls.push("purge"); },
  });

  await dispatcher.flush();

  assert.deepEqual(calls, []);
  assert.equal(dispatcher.status().state, "degraded");
});

test("controller 404 is an idempotent successful destroy", async () => {
  let gatewayRevocations = 0;
  const adapter = new ControlPlaneTenantCleanupAdapter({
    create: async () => { throw new Error("not used"); },
    status: async () => { throw new Error("not used"); },
    destroyWorkspace: async () => {
      throw new LemmaComputerError("WORKSPACE_NOT_FOUND", "Already absent", 404);
    },
    stop: async () => { throw new Error("not used"); },
    purgeWorkspace: async () => { throw new Error("not used"); },
  }, {
    ensureGrant: async () => { throw new Error("not used"); },
    revokeWorkspace: async (_workspaceId, accessGeneration) => {
      assert.equal(accessGeneration, job().accessGeneration);
      gatewayRevocations += 1;
    },
    listModels: async () => [],
  });

  await adapter.destroyWorkspace(job().workspaceId, job().providerId);
  await adapter.revokeGateway(job().workspaceId, job().accessGeneration);
  assert.equal(gatewayRevocations, 1);
});
