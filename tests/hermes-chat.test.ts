import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { IdentityContext, Launch, RuntimePolicy, Sandbox } from "@onecomputer/contracts";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import {
  HermesApiAuthority,
  HttpHermesChatClient,
  type HermesApiAccess,
} from "../apps/control-api/src/hermes-chat.js";
import { WorkspaceService, type ControllerClient } from "../apps/control-api/src/service.js";

const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "alex",
  audience: "onecomputer-control",
};

const hermesPolicy: RuntimePolicy = {
  schemaVersion: 1,
  policyVersionId: "policy-version-1",
  policyVersion: 1,
  policyHash: "a".repeat(64),
  workspaceProfile: "kasm-persistent-standard",
  agentId: "agent-alex:hermes-claw",
  agentProfile: "hermes-claw-managed-v1",
  networkProfile: "controlled-egress-v1",
  modelAlias: "onecomputer-assistant",
  mcpServer: "onecomputer_ms365",
  allowedTools: ["list-mail-folders"],
  toolPolicies: { "list-mail-folders": "allow" },
  agents: [{
    catalogId: "hermes-claw",
    agentId: "agent-alex:hermes-claw",
    agentProfile: "hermes-claw-managed-v1",
    displayName: "Hermes",
    clientVersion: "v2026.7.20",
    modelAlias: "onecomputer-assistant",
    mcpServer: "onecomputer_ms365",
    allowedTools: ["list-mail-folders"],
    toolPolicies: { "list-mail-folders": "allow" },
  }],
};

class FakeController implements ControllerClient {
  lastHermesApi: { key: string } | undefined;
  async create(input: Parameters<ControllerClient["create"]>[0]): Promise<Sandbox> {
    this.lastHermesApi = input.hermesApi;
    return { providerId: `sandbox-${input.workspaceId}`, state: "ready", failureCode: null };
  }
  async status(providerId: string): Promise<Sandbox> { return { providerId, state: "ready", failureCode: null }; }
  async open(_providerId: string): Promise<Launch> { return { launchUrl: "https://kasm.example", expiresAt: new Date().toISOString() }; }
  async destroy() {}
  async purgeWorkspace() {}
}

test("Hermes API grants are deterministic, workspace-bound, and only issued for selected Hermes runtimes", () => {
  const authority = new HermesApiAuthority("test-hermes-root-secret-at-least-32-characters");
  const first = authority.issue(identity, "11111111-1111-4111-8111-111111111111", hermesPolicy);
  const same = authority.issue(identity, "11111111-1111-4111-8111-111111111111", hermesPolicy);
  const other = authority.issue(identity, "22222222-2222-4222-8222-222222222222", hermesPolicy);
  assert.deepEqual(first, same);
  assert.notEqual(first?.key, other?.key);
  assert.equal(first?.baseUrl, "http://onecomputer-sandbox-11111111-1111-4111-8111-111111111111:8642");

  const claudePolicy = { ...hermesPolicy, agentProfile: "claude-desktop-managed-v1" as const, agents: undefined };
  assert.equal(authority.issue(identity, "11111111-1111-4111-8111-111111111111", claudePolicy), undefined);
});

test("workspace provisioning projects a dedicated Hermes API grant and stopped workspaces cannot authorize chat", async () => {
  const controller = new FakeController();
  const authority = new HermesApiAuthority("test-hermes-root-secret-at-least-32-characters");
  const service = new WorkspaceService(
    new MemoryWorkspaceStore(),
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    authority,
  );
  const workspace = await service.create(identity, hermesPolicy, "personal", "hermes-chat-create", "correlation-1");
  assert.ok(controller.lastHermesApi?.key);
  assert.equal((await service.hermesChatAccess(identity, hermesPolicy, workspace.id)).workspaceId, workspace.id);
  await service.stop(identity, hermesPolicy, workspace.id);
  await assert.rejects(
    service.hermesChatAccess(identity, hermesPolicy, workspace.id),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "WORKSPACE_NOT_READY"),
  );
});

test("the owned Hermes client uses only the fixed API routes and returns sanitized messages", async () => {
  const requests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/chat")) {
      response.end(JSON.stringify({
        object: "hermes.session.chat.completion",
        session_id: "session-1",
        message: { role: "assistant", content: "The sandbox agent replied.", internal_trace: "must-not-leak" },
        usage: { secret: "must-not-leak" },
      }));
      return;
    }
    response.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const access: HermesApiAccess = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    key: "workspace-specific-hermes-api-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
  try {
    const client = new HttpHermesChatClient();
    const message = await client.sendMessage(access, "session-1", "Hello");
    assert.deepEqual(message, { role: "assistant", content: "The sandbox agent replied." });
    assert.deepEqual(requests, [{
      url: "/api/sessions/session-1/chat",
      authorization: "Bearer workspace-specific-hermes-api-key",
      body: { message: "Hello" },
    }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
