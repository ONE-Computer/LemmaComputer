import { m365ToolCatalog, type AgentChatEvent, type ChatUiMessage, type IdentityContext } from "@onecomputer/contracts";
import { MemoryWorkspaceStore, type EffectivePolicy, type IdentityPolicyStore, type SessionPrincipal } from "@onecomputer/workspace-store";
import type { AgentChatClient } from "../apps/control-api/src/agent-chat.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const identity = { tenantId: "onevibe-browser", subjectId: "qa-user", audience: "onecomputer-control" as const };
const proxyToken = "onevibe-browser-fixture-proxy-token-at-least-24-characters";
const store = new MemoryWorkspaceStore();
const workspace = await store.createOrGet(identity, "personal", "onevibe-browser-fixture");
await store.update(workspace.id, { state: "ready" });
const principal: SessionPrincipal = {
  userId: identity.subjectId, tenantId: identity.tenantId, email: "qa@example.test", displayName: "QA User",
  tenantDisplayName: "ONEVibe fixture", roles: ["employee"], identity,
};
const policy: EffectivePolicy = {
  assignmentId: "fixture-assignment", policyBundleId: "fixture-bundle", policyVersionId: "fixture-policy", version: 1,
  documentHash: "f".repeat(64), assignedBy: "fixture", assignedAt: new Date().toISOString(), agentId: "fixture-agent", vendorUserId: "fixture-user",
  document: { schemaVersion: 1, workspaceProfile: "kasm-persistent-standard", workspaceProfiles: ["kasm-persistent-standard"], agentProfile: "hermes-claw-managed-v1", agents: ["hermes-claw", "claude-cli", "codex-cli"], defaultAgents: ["hermes-claw", "claude-cli", "codex-cli"], applications: ["firefox"], defaultApplications: ["firefox"], modelAliases: ["onecomputer-assistant"], networkProfile: "controlled-egress-v1", mcp: { servers: { onecomputer_ms365: { tools: ["list-mail-folders"], toolPolicies: { "list-mail-folders": m365ToolCatalog["list-mail-folders"].decision } } } } },
};
const policyStore = {
  getPrincipal: async (userId: string) => userId === identity.subjectId ? principal : null,
  getEffectivePolicy: async (userId: string) => userId === identity.subjectId ? policy : null,
} as unknown as IdentityPolicyStore;
class FixtureAgentChat implements AgentChatClient {
  private readonly messages = new Map<string, ChatUiMessage[]>();

  async health() {}
  async listSessions() { return { sessions: [], nextCursor: null }; }
  async createSession() { return { id: "cowork-fixture-session", title: "Cowork", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
  async listMessages(_access: unknown, sessionId: string) { return this.messages.get(sessionId) ?? []; }
  async *streamTurn(_access: unknown, sessionId: string, message: ChatUiMessage): AsyncIterable<AgentChatEvent> {
    const turnId = "cowork-fixture-turn";
    const createdAt = new Date().toISOString();
    const response = "The executive update slide is ready for generation.";
    this.messages.set(sessionId, [
      message,
      { id: "cowork-fixture-assistant", role: "assistant", parts: [{ type: "text", text: response }], metadata: { createdAt, agentCatalogId: "hermes-claw", turnId, state: "completed" } },
    ]);
    yield { version: 1, sequence: 0, sessionId, turnId, type: "turn-start", messageId: "cowork-fixture-message", createdAt: new Date().toISOString() };
    yield { version: 1, sequence: 1, sessionId, turnId, type: "progress", activityId: "cowork-fixture-progress", label: "Drafting slide", state: "running" };
    yield { version: 1, sequence: 2, sessionId, turnId, type: "text-delta", textId: "cowork-fixture-text", delta: response };
    yield { version: 1, sequence: 3, sessionId, turnId, type: "progress", activityId: "cowork-fixture-progress", label: "Drafting slide", state: "completed" };
    yield { version: 1, sequence: 4, sessionId, turnId, type: "turn-finish", state: "completed", completedAt: new Date().toISOString() };
  }
}
const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
  testIdentityMode: true,
  oneVibeCaptureSecret: "onevibe-browser-capture-secret-at-least-32-characters",
  identityPolicyStore: policyStore,
  agentChatSecret: "onevibe-browser-agent-chat-secret-at-least-32-characters",
  agentChatClient: new FixtureAgentChat(),
});
const port = Number(process.env.ONEVIBE_BROWSER_FIXTURE_PORT ?? 4310);
await app.listen({ host: "127.0.0.1", port });
process.stdout.write(`ONEVibe browser fixture ready for workspace ${workspace.id}\n`);
