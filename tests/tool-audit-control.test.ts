import assert from "node:assert/strict";
import test from "node:test";
import type { McpPolicyDecision, McpPolicyRequest, ToolAuditAdmissionInput } from "@lemmacomputer/contracts";
import { InMemoryToolAuditStore, MemoryWorkspaceStore, type SessionPrincipal, type ToolAuditStoreQuery } from "@lemmacomputer/workspace-store";
import { ToolAuditService, mcpToolAuditTarget } from "../apps/control-api/src/tool-audit.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const request: McpPolicyRequest = {
  schemaVersion: 1,
  tenantId: "tenant-a",
  subjectId: "member-a",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  agentId: "claude-cli",
  agentInstanceId: "22222222-2222-4222-8222-222222222222",
  sourceInvocationId: "33333333-3333-4333-8333-333333333333",
  policyVersionId: "policy-v1",
  policyHash: "a".repeat(64),
  operationId: null,
  operationDigest: null,
  leaseId: null,
  serverId: "m365-server",
  serverName: "lemmacomputer_ms365",
  toolName: "get-mail-message",
  arguments: { messageId: "message-42 password=hunter2" },
};

const allowed: McpPolicyDecision = {
  schemaVersion: 1,
  decision: "allow",
  code: "MCP_POLICY_ALLOWED",
  capabilityId: null,
  schemaId: null,
  schemaHash: null,
  operationId: null,
};

test("MCP audit admission binds broker identity and stores only a derived managed target", async () => {
  const store = new InMemoryToolAuditStore(() => new Date("2026-08-13T04:00:00.000Z"));
  const service = new ToolAuditService(store, async () => ({ id: "microsoft-365", name: "Microsoft 365" }));
  const admitted = await service.admitMcp(request, allowed, "request-correlation");
  assert.equal(admitted.admission.sourceSystem, "workspace_broker");
  assert.equal(admitted.admission.sourceInvocationId, request.sourceInvocationId);
  assert.equal(admitted.admission.targetSummary.targetType, "message");
  assert.equal(admitted.admission.targetSummary.redacted, true);
  assert.doesNotMatch(JSON.stringify(admitted), /hunter2/u);

  const terminal = await service.finalizeMcp({
    tenantId: request.tenantId,
    subjectId: request.subjectId,
    workspaceId: request.workspaceId,
    agentInstanceId: request.agentInstanceId!,
    sourceInvocationId: request.sourceInvocationId!,
    outcome: "succeeded",
    latencyMs: 9,
    failureClass: null,
  });
  assert.equal(terminal.record.outcome, "succeeded");
});

test("generic connector arguments never become audit target text", () => {
  assert.deepEqual(mcpToolAuditTarget({
    ...request,
    serverName: "customer_custom",
    arguments: { destination: "https://secret.example/path?token=secret", password: "hunter2" },
  }, "customer-custom"), { provenance: "generic_template" });
});

test("tool audit pagination keeps one as-of boundary and rejects cursor reuse with other filters", async () => {
  const now = new Date("2026-08-13T05:00:00.000Z");
  const store = new InMemoryToolAuditStore(() => now);
  const admission: ToolAuditAdmissionInput = {
    tenantId: request.tenantId,
    subjectId: request.subjectId,
    workspaceId: request.workspaceId,
    agentId: request.agentId,
    agentInstanceId: request.agentInstanceId!,
    context: { kind: "workspace_native", taskId: null, sessionId: null, turnId: null },
    sourceSystem: "workspace_broker",
    sourceInvocationId: request.sourceInvocationId!,
    correlationId: "request-correlation",
    connectorId: "microsoft-365",
    serverId: request.serverId,
    serverName: request.serverName,
    toolName: request.toolName,
    policyDecision: "deny",
    policyCode: "MCP_TOOL_BLOCKED_BY_POLICY",
    policyVersionId: request.policyVersionId,
    policyHash: request.policyHash,
    governedOperationId: null,
    target: { provenance: "generic_template" },
  };
  const event = store.admit(admission).terminal!;
  const calls: ToolAuditStoreQuery[] = [];
  Object.assign(store, {
    queryTerminal: async (input: ToolAuditStoreQuery) => {
      calls.push(input);
      return {
        events: [event],
        hasMore: true,
        total: 1,
        summary: [{ outcome: "denied", count: 1 }],
        retainedDetailFrom: now,
        detailState: "complete",
      };
    },
  });
  const service = new ToolAuditService(store, async () => null);
  const raw = {
    from: "2026-08-12T05:00:00.000Z",
    to: "2026-08-14T05:00:00.000Z",
    pageSize: "1",
  };
  const first = await service.query(request.tenantId, raw, now);
  assert.ok(first.nextCursor);
  await service.query(request.tenantId, { ...raw, cursor: first.nextCursor }, new Date("2026-08-13T06:00:00.000Z"));
  assert.equal(calls[1]?.asOf.toISOString(), now.toISOString());
  assert.equal(calls[1]?.after?.invocationId, event.invocationId);
  await assert.rejects(
    service.query(request.tenantId, { ...raw, toolName: "other-tool", cursor: first.nextCursor }),
    (error: { code?: string }) => error.code === "TOOL_AUDIT_CURSOR_INVALID",
  );
});

test("the HTTP audit view is organization-scoped and requires audit.read", async () => {
  const queriedTenants: string[] = [];
  const store = new InMemoryToolAuditStore();
  Object.assign(store, {
    queryTerminal: async (input: ToolAuditStoreQuery) => {
      queriedTenants.push(input.tenantId);
      return { events: [], hasMore: false, total: 0, summary: [], retainedDetailFrom: null, detailState: "complete" };
    },
  });
  const actor: SessionPrincipal = {
    userId: "admin-a",
    tenantId: "tenant-a",
    email: "admin@example.test",
    displayName: "Admin A",
    tenantDisplayName: "Tenant A",
    roles: ["admin"],
    identity: { tenantId: "tenant-a", subjectId: "admin-a", audience: "lemmacomputer-control" },
  };
  let currentRoles: SessionPrincipal["roles"] = actor.roles;
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    "tool-audit-proxy-token-at-least-24-characters",
    undefined,
    undefined,
    {},
    {
      customerProductAuthentication: {
        resolve: async (headers: Headers) => headers.get("cookie") === "session=valid"
          ? { status: "authorized" as const, principal: { ...actor, roles: currentRoles } }
          : { status: "anonymous" as const },
      },
      toolAuditStore: store,
      agentBridgeSecret: "tool-audit-agent-bridge-secret-at-least-32-characters",
    },
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/tool-audit?from=2026-08-12T00%3A00%3A00.000Z&to=2026-08-14T00%3A00%3A00.000Z",
      headers: { "x-lemmacomputer-proxy-token": "tool-audit-proxy-token-at-least-24-characters", cookie: "session=valid" },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(queriedTenants, ["tenant-a"]);

    currentRoles = ["member"];
    const forbidden = await app.inject({
      method: "GET",
      url: "/v1/admin/tool-audit?from=2026-08-12T00%3A00%3A00.000Z&to=2026-08-14T00%3A00%3A00.000Z",
      headers: { "x-lemmacomputer-proxy-token": "tool-audit-proxy-token-at-least-24-characters", cookie: "session=valid" },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.deepEqual(queriedTenants, ["tenant-a"]);
  } finally {
    await app.close();
  }
});
