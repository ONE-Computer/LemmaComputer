import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import type { ClaimedPlatformSecurityAlert, PlatformSecurityAlert } from "@lemmacomputer/workspace-store";
import {
  PlatformSecurityAlertDispatcher,
  SignedWebhookPlatformSecurityAlertAdapter,
  type PlatformSecurityAlertDeliveryStore,
} from "../apps/control-api/src/platform-security-alert-dispatcher.js";

const alert = (attemptCount = 1, leaseToken = "11111111-1111-4111-8111-111111111111"): ClaimedPlatformSecurityAlert => ({
  id: "22222222-2222-4222-8222-222222222222",
  operatorId: "33333333-3333-4333-8333-333333333333",
  targetOrganizationId: "example",
  elevationId: "44444444-4444-4444-8444-444444444444",
  correlationId: "break-glass-test",
  alertType: "break-glass",
  payload: { reason: "Emergency incident response" },
  status: "delivering",
  attemptCount,
  maxAttempts: 3,
  leaseGeneration: attemptCount,
  leaseToken,
  availableAt: "2026-08-09T04:00:00.000Z",
  claimedAt: "2026-08-09T04:00:00.000Z",
  deliveredAt: null,
  lastError: null,
  createdAt: "2026-08-09T04:00:00.000Z",
  updatedAt: "2026-08-09T04:00:00.000Z",
});

test("dispatcher completes successful deliveries and retries bounded failures with the exact lease", async () => {
  const claims = [alert(1), alert(2, "55555555-5555-4555-8555-555555555555")];
  const completed: unknown[] = [];
  const failed: unknown[] = [];
  let delivery = 0;
  const store = {
    claimSecurityAlerts: async () => claims.splice(0, 1),
    completeSecurityAlert: async (...input: unknown[]) => { completed.push(input); return alert(); },
    failSecurityAlert: async (...input: unknown[]) => { failed.push(input); return { ...alert(), status: "retry" as const }; },
    listSecurityAlerts: async () => [],
  } satisfies PlatformSecurityAlertDeliveryStore;
  const now = new Date("2026-08-09T04:00:00.000Z");
  const dispatcher = new PlatformSecurityAlertDispatcher(store, {
    deliver: async () => { delivery += 1; if (delivery === 1) throw new Error("destination unavailable"); },
  }, { now: () => now, baseRetryMs: 1_000, maxRetryMs: 10_000 });

  await dispatcher.flush(now);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.[1], "11111111-1111-4111-8111-111111111111");
  assert.equal((failed[0]?.[2] as { retryAt: Date }).retryAt.toISOString(), "2026-08-09T04:00:01.000Z");
  assert.equal(dispatcher.status().state, "degraded");
  await dispatcher.flush(now);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.[1], "55555555-5555-4555-8555-555555555555");
  assert.equal(dispatcher.status().state, "healthy");
});

test("dispatcher exposes escalation and stop waits for in-flight delivery", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let claims = 0;
  const store = {
    claimSecurityAlerts: async () => claims++ === 0 ? [alert(3)] : [],
    completeSecurityAlert: async () => alert(3),
    failSecurityAlert: async () => ({ ...alert(3), status: "escalated" as const }),
    listSecurityAlerts: async () => [{ ...alert(3), status: "escalated" as const } as PlatformSecurityAlert],
  } satisfies PlatformSecurityAlertDeliveryStore;
  const dispatcher = new PlatformSecurityAlertDispatcher(store, { deliver: async () => blocked }, { pollIntervalMs: 5 });
  dispatcher.start();
  while (claims === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  let stopped = false;
  const stopping = dispatcher.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(dispatcher.status().state, "stopped");
});

test("dispatcher never mutates a replacement delivery after losing its lease", async () => {
  let failed = 0;
  const store = {
    claimSecurityAlerts: async () => [alert()],
    completeSecurityAlert: async () => {
      throw new LemmaComputerError(
        "PLATFORM_SECURITY_ALERT_LEASE_LOST",
        "Security alert delivery lease was replaced",
        409,
      );
    },
    failSecurityAlert: async () => { failed += 1; return { ...alert(), status: "retry" as const }; },
    listSecurityAlerts: async () => [],
  } satisfies PlatformSecurityAlertDeliveryStore;
  const dispatcher = new PlatformSecurityAlertDispatcher(store, { deliver: async () => undefined });

  await dispatcher.flush();

  assert.equal(failed, 0);
  assert.equal(dispatcher.status().state, "degraded");
  assert.match(dispatcher.status().lastError ?? "", /lease was replaced/);
});

test("signed webhook adapter emits a bounded signed payload without a real external call", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const adapter = new SignedWebhookPlatformSecurityAlertAdapter(
    "https://alerts.example.test/platform",
    "webhook-secret-at-least-thirty-two-characters",
    async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(null, { status: 204 });
    },
  );
  await adapter.deliver(alert(), new AbortController().signal);
  assert.equal(captured?.url, "https://alerts.example.test/platform");
  assert.equal(captured?.init.redirect, "error");
  assert.match(String((captured?.init.headers as Record<string, string>)["x-lemmacomputer-alert-signature"]), /^sha256=[0-9a-f]{64}$/);
  assert.doesNotMatch(String(captured?.init.body), /leaseToken|webhook-secret/);
});

test("signed webhook adapter rejects redirects without replaying the alert", async () => {
  let calls = 0;
  const adapter = new SignedWebhookPlatformSecurityAlertAdapter(
    "https://alerts.example.test/platform",
    "webhook-secret-at-least-thirty-two-characters",
    async (_url, init) => {
      calls += 1;
      assert.equal(init?.redirect, "error");
      throw new TypeError("fetch failed: redirect mode is set to error");
    },
  );

  await assert.rejects(
    adapter.deliver(alert(), new AbortController().signal),
    /redirect mode is set to error/,
  );
  assert.equal(calls, 1);
});
