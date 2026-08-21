import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext } from "@lemmacomputer/contracts";
import type { GatewayClient, GovernedToolExecutionInput, GovernedToolExecutor } from "@lemmacomputer/litellm-adapter";
import {
  MemoryWorkspaceStore,
  mvpPolicyDocument,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type RoutingStore,
} from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "proxy-test-token-at-least-24-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "alex-morgan", audience: "lemmacomputer-control" };
const authHeaders = {
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": identity.tenantId,
  "x-lemmacomputer-test-user-id": identity.subjectId,
};

test("Control API exposes a durable approval-required operation and fixture decision", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", randomUUID());
  await store.update(workspace.id, { state: "ready" });
  const executions: GovernedToolExecutionInput[] = [];
  const gateway: GatewayClient & GovernedToolExecutor = {
    ensureGrant: async () => ({ baseUrl: "http://gateway", credential: "scoped-test-credential-000001", modelAlias: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    readiness: async () => ({ models: "ready", tools: "ready" }),
    test: async () => ({
      model: "test",
      availability: "ready",
      modelRoute: { alias: "test", status: "ready", fallback: "none", capabilities: { vision: true }, limits: { requestsPerMinute: 30, tokensPerMinute: 50_000, maxParallelRequests: 4 } },
      tools: [],
      apiBaseUrl: "http://gateway/v1",
      mcpUrl: "http://gateway/mcp",
    }),
    revoke: async () => undefined,
    executeGovernedTool: async (input) => {
      executions.push(input);
      return { upstreamReference: `fixture:${input.operationId}`, resultSummary: "Deleted fixture Q3-draft.docx", result: { deleted: true } };
    },
  };
  const controller = {} as ControllerClient;
  const effectivePolicy: EffectivePolicy = {
    assignmentId: "operation-policy-assignment",
    policyBundleId: "operation-policy-bundle",
    policyVersionId: "operation-policy-version",
    version: 1,
    documentHash: "a".repeat(64),
    assignedBy: "administrator",
    assignedAt: "2026-08-19T00:00:00.000Z",
    agentId: "operation-agent",
    vendorUserId: identity.subjectId,
    document: mvpPolicyDocument(),
  };
  const identityPolicyStore = {
    getEffectivePolicy: async () => effectivePolicy,
  } as unknown as IdentityPolicyStore;
  const routingStore = {
    latestMappingVersion: async () => null,
  } as unknown as RoutingStore;
  const app = createControlServer(store, controller, proxyToken, gateway, "api-fixture-approval-secret-at-least-32-characters", {}, {
    testIdentityMode: true,
    identityPolicyStore,
    routingStore,
  });

  const empty = await app.inject({ method: "GET", url: "/v1/operations/recent", headers: authHeaders });
  assert.equal(empty.statusCode, 204);

  const created = await app.inject({
    method: "POST",
    url: "/v1/operations/delete-file",
    headers: { ...authHeaders, "idempotency-key": "api-delete-request-001" },
    payload: { workspaceId: workspace.id, path: "/Finance/2026/Q3-draft.docx" },
  });
  assert.equal(created.statusCode, 201);
  const operation = created.json();
  assert.equal(operation.state, "approval_required");
  assert.equal(executions.length, 0);

  const invalid = await app.inject({
    method: "POST",
    url: `/v1/operations/${operation.id}/fixture-decision`,
    headers: { ...authHeaders, "idempotency-key": "api-invalid-decision-001" },
    payload: { decision: "approve", state: "succeeded" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(executions.length, 0);

  const approved = await app.inject({
    method: "POST",
    url: `/v1/operations/${operation.id}/fixture-decision`,
    headers: { ...authHeaders, "idempotency-key": "api-approval-request-001" },
    payload: { decision: "approve" },
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().state, "succeeded");
  assert.equal(executions.length, 1);

  const recent = await app.inject({ method: "GET", url: "/v1/operations/recent", headers: authHeaders });
  assert.equal(recent.statusCode, 200);
  assert.equal(recent.json().receipt.resultSummary, "Deleted fixture Q3-draft.docx");
  await app.close();
});
