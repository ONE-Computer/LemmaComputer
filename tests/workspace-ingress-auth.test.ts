import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceIngressAuthority } from "@onecomputer/workspace-ingress-auth";

const secret = "workspace-ingress-test-secret-at-least-32-characters";
const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
const otherWorkspaceId = "c5b2ea8c-cc94-46e3-b6c8-59ae4ebee509";
const now = new Date("2026-07-25T12:00:00.000Z");

test("workspace launch tokens exchange into scoped, longer-lived sessions", () => {
  const authority = new WorkspaceIngressAuthority(secret, 300, 3_600);
  const launch = authority.issueLaunch({
    identity: { tenantId: "acme", subjectId: "alex", audience: "onecomputer-control" },
    workspaceId,
    target: {
      protocol: "https",
      host: `onecomputer-sandbox-${workspaceId}-relay`,
      port: 16_920,
    },
  }, now);

  const exchanged = authority.exchangeLaunch(launch.token, workspaceId, new Date(now.getTime() + 60_000));
  assert.ok(exchanged);
  assert.equal(exchanged.claims.kind, "session");
  assert.equal(exchanged.claims.tenantId, "acme");
  assert.equal(exchanged.claims.subjectId, "alex");
  assert.equal(exchanged.claims.workspaceId, workspaceId);
  assert.equal(exchanged.claims.host, `onecomputer-sandbox-${workspaceId}-relay`);
  assert.equal(exchanged.claims.port, 16_920);
  assert.ok(authority.verifySession(exchanged.token, workspaceId, new Date(now.getTime() + 120_000)));
  assert.equal(authority.verifySession(exchanged.token, otherWorkspaceId, new Date(now.getTime() + 120_000)), null);
});

test("workspace ingress rejects tampered and expired bearer tokens", () => {
  const authority = new WorkspaceIngressAuthority(secret, 300, 3_600);
  const launch = authority.issueLaunch({
    identity: { tenantId: "acme", subjectId: "alex", audience: "onecomputer-control" },
    workspaceId,
    target: { protocol: "https", host: "workspace.internal", port: 6901 },
  }, now);

  assert.equal(authority.exchangeLaunch(`${launch.token}tampered`, workspaceId, now), null);
  assert.equal(authority.exchangeLaunch(launch.token, workspaceId, new Date(now.getTime() + 301_000)), null);
});
