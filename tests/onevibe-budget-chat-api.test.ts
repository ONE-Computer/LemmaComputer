import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentChatEvent,
  type ChatUiMessage,
  type IdentityContext,
} from "@onecomputer/contracts";
import { MemoryWorkspaceStore, runtimePolicyFor, type EffectivePolicy, type IdentityPolicyStore } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { AgentChatClient } from "../apps/control-api/src/agent-chat.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "onevibe-budget-chat-proxy-token-at-least-24-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "alex-morgan", audience: "onecomputer-control" };
const headers = {
  "x-onecomputer-proxy-token": proxyToken,
  "x-onecomputer-test-tenant-id": identity.tenantId,
  "x-onecomputer-test-user-id": identity.subjectId,
};

const effectivePolicy: EffectivePolicy = {
  assignmentId: "budget-assignment",
  policyBundleId: "budget-bundle",
  policyVersionId: "budget-policy",
  version: 1,
  documentHash: "b".repeat(64),
  assignedBy: "test",
  assignedAt: new Date().toISOString(),
  agentId: "budget-agent",
  vendorUserId: "budget-user",
  document: {
    schemaVersion: 1,
    workspaceProfile: "kasm-persistent-standard",
    workspaceProfiles: ["kasm-persistent-standard"],
    agentProfile: "opencode-cli-managed-v1",
    agents: ["opencode-cli"],
    defaultAgents: ["opencode-cli"],
    applications: ["firefox"],
    defaultApplications: ["firefox"],
    modelAliases: ["onecomputer-assistant"],
    networkProfile: "controlled-egress-v1",
    mcp: { servers: { onecomputer_ms365: { tools: ["search_files"], toolPolicies: { search_files: "allow" } } } },
  },
};

const message = (): ChatUiMessage => ({
  id: "budget-user-message",
  role: "user",
  metadata: { agentCatalogId: "opencode-cli", state: "completed", createdAt: new Date().toISOString() },
  parts: [{ type: "text", text: "hello", state: "done" }],
});

class BudgetChatClient implements AgentChatClient {
  async health() {}
  async listSessions() { return { sessions: [], nextCursor: null }; }
  async createSession() { return { id: "budget-session", title: null, createdAt: null, updatedAt: null }; }
  async listMessages() { return []; }
  async downloadArtifact() { return Buffer.from("artifact"); }
  async *streamTurn(_access: unknown, sessionId: string): AsyncIterable<AgentChatEvent> {
    const now = new Date().toISOString();
    yield { version: 1, sequence: 0, sessionId, turnId: "budget-turn", type: "turn-start", messageId: "budget-assistant", createdAt: now };
    yield { version: 1, sequence: 1, sessionId, turnId: "budget-turn", type: "text-delta", textId: "budget-text", delta: "ok" };
    yield { version: 1, sequence: 2, sessionId, turnId: "budget-turn", type: "turn-finish", state: "completed", completedAt: now };
  }
}

test("Cowork chat reserves a task turn before ACP and rejects the next turn at the API budget boundary", async () => {
  assert.equal(runtimePolicyFor(effectivePolicy).agents?.[0]?.catalogId, "opencode-cli");
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", "budget-chat-workspace");
  await store.update(workspace.id, { state: "ready", providerId: "budget-provider" });
  const policyStore = {
    getPrincipal: async (userId: string) => userId === identity.subjectId ? null : null,
    getEffectivePolicy: async (userId: string) => userId === identity.subjectId ? effectivePolicy : null,
  } as unknown as IdentityPolicyStore;
  const controller = {
    async status(providerId: string) {
      return { providerId, state: "ready" as const, failureCode: null, chatEndpoints: [{ catalogId: "opencode-cli" as const, url: "https://chat.example.test" }] };
    },
  } as unknown as ControllerClient;
  const app = createControlServer(store, controller, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore,
    agentChatSecret: "budget-chat-agent-secret-at-least-32-characters",
    agentChatClient: new BudgetChatClient(),
    oneVibeTurnLimit: 1,
  });
  try {
    const created = await app.inject({ method: "POST", url: `/v1/workspaces/${workspace.id}/onevibe/tasks`, headers });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().task.id as string;
    const first = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/chat/agents/opencode-cli/sessions/budget-session/messages`,
      headers: { ...headers, "x-onecomputer-onevibe-task-id": taskId, "idempotency-key": "budget-chat-turn-1" },
      payload: { message: message() },
    });
    assert.equal(first.statusCode, 200);
    assert.match(first.headers["content-type"] ?? "", /text\/event-stream/);

    const second = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/chat/agents/opencode-cli/sessions/budget-session/messages`,
      headers: { ...headers, "x-onecomputer-onevibe-task-id": taskId, "idempotency-key": "budget-chat-turn-2" },
      payload: { message: message() },
    });
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, "ONEVIBE_BUDGET_EXHAUSTED");
    const events = await store.listOwnedOneVibeTaskEvents(identity, workspace.id, taskId);
    assert.deepEqual(events?.map((event) => event.kind).slice(0, 2), ["system", "system"]);
    assert.equal(events?.length, 5, "one completed turn should retain reservation plus canonical ACP evidence");
  } finally {
    await app.close();
  }
});
