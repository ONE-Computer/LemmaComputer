import assert from "node:assert/strict";
import test from "node:test";
import {
  m365ToolCatalog,
  type AgentChatEvent,
  type ChannelTurnRequest,
  type IdentityContext,
} from "@onecomputer/contracts";
import {
  MemoryWorkspaceStore,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type SessionPrincipal,
} from "@onecomputer/workspace-store";
import type { AgentChatClient } from "../apps/control-api/src/agent-chat.js";
import type { ChannelBrokerManagementClient } from "../apps/control-api/src/channel-broker.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "channel-control-proxy-token-at-least-24-characters";
const channelToken = "channel-control-internal-token-at-least-32-characters";
const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "onecomputer-control" };
const principal: SessionPrincipal = {
  userId: "alpha",
  tenantId: "acme",
  email: "alpha@metech.dev",
  displayName: "Alpha User",
  tenantDisplayName: "ME TECH",
  roles: ["employee"],
  identity: alpha,
};
const headers = {
  "x-onecomputer-proxy-token": proxyToken,
  "x-onecomputer-test-tenant-id": alpha.tenantId,
  "x-onecomputer-test-user-id": alpha.subjectId,
};

const effectivePolicy = (workspaceId: string): EffectivePolicy => ({
  assignmentId: "assignment-channel",
  policyBundleId: "bundle-channel",
  policyVersionId: "policy-channel",
  version: 1,
  documentHash: "a".repeat(64),
  assignedBy: "administrator",
  assignedAt: new Date().toISOString(),
  agentId: "agent-channel",
  workspaceIdentityId: "workspace-identity-channel",
  workspaceId,
  vendorUserId: "vendor-alpha",
  document: {
    schemaVersion: 1,
    workspaceProfile: "kasm-persistent-standard",
    workspaceProfiles: ["kasm-persistent-standard"],
    agentProfile: "hermes-claw-managed-v1",
    agents: ["hermes-claw", "claude-cli", "codex-cli"],
    defaultAgents: ["hermes-claw", "claude-cli", "codex-cli"],
    applications: ["firefox"],
    defaultApplications: ["firefox"],
    modelAliases: ["onecomputer-assistant"],
    networkProfile: "controlled-egress-v1",
    mcp: {
      servers: {
        onecomputer_ms365: {
          tools: ["list-mail-folders"],
          toolPolicies: { "list-mail-folders": m365ToolCatalog["list-mail-folders"].decision },
        },
      },
    },
  },
});

const policyStore = (policy: EffectivePolicy) => ({
  getPrincipal: async (userId: string) => userId === principal.userId ? principal : null,
  getEffectivePolicy: async (userId: string) => userId === principal.userId ? policy : null,
}) as unknown as IdentityPolicyStore;

class FakeBroker implements ChannelBrokerManagementClient {
  savedCredentialId = "";
  savedToken = "";
  deletedCredentialId = "";
  connection: Awaited<ReturnType<FakeBroker["save"]>> | null = null;

  async listCredentials() {
    return { credentials: [] };
  }

  async saveCredential(_identity: IdentityContext, raw: unknown, credentialId?: string) {
    const input = raw as { botToken: string };
    this.savedToken = input.botToken;
    return {
      id: credentialId ?? "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
      kind: "telegram_bot_token" as const,
      displayName: "@onecomputer_test_bot",
      botUsername: "onecomputer_test_bot",
      version: credentialId ? 2 : 1,
      workspaceId: null,
      connectionId: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async deleteCredential(_identity: IdentityContext, credentialId: string) {
    this.deletedCredentialId = credentialId;
  }

  async status() {
    return this.connection;
  }

  async save(_identity: IdentityContext, raw: unknown) {
    const input = raw as { workspaceId: string; credentialId: string; allowedUserIds: string[]; defaultAgentId: "hermes-claw" };
    this.savedCredentialId = input.credentialId;
    this.connection = {
      state: "connected" as const,
      connectionId: "92b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
      workspaceId: input.workspaceId,
      credentialId: input.credentialId,
      allowedUserIds: input.allowedUserIds,
      allowedUserCount: input.allowedUserIds.length,
      defaultAgentId: input.defaultAgentId,
      allowAgentSwitch: true,
      botUsername: "onecomputer_test_bot",
      tokenVersion: 1,
      updatedAt: new Date().toISOString(),
    };
    return this.connection;
  }

  async disconnect() { this.connection = null; }
}

test("credential APIs keep Telegram tokens write-only across create, rotate, list, and delete", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(alpha, "personal", "credential-control-workspace");
  const broker = new FakeBroker();
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(effectivePolicy(workspace.id)),
    channelBrokerClient: broker,
  });
  const credentialId = "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24";
  const botToken = "123456789:telegram-token-never-returned";
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/credentials/telegram",
      headers: { ...headers, "content-type": "application/json" },
      payload: { botToken },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(broker.savedToken, botToken);
    assert.ok(!JSON.stringify(created.json()).includes(botToken));

    const rotated = await app.inject({
      method: "PUT",
      url: `/v1/credentials/${credentialId}/telegram`,
      headers: { ...headers, "content-type": "application/json" },
      payload: { botToken },
    });
    assert.equal(rotated.statusCode, 200);
    assert.equal(rotated.json().version, 2);
    assert.ok(!JSON.stringify(rotated.json()).includes(botToken));

    const listed = await app.inject({ method: "GET", url: "/v1/credentials", headers });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), { credentials: [] });

    const deleted = await app.inject({ method: "DELETE", url: `/v1/credentials/${credentialId}`, headers });
    assert.equal(deleted.statusCode, 204);
    assert.equal(broker.deletedCredentialId, credentialId);
  } finally {
    await app.close();
  }
});

class FakeAgentChat implements AgentChatClient {
  turns: ChannelTurnRequest[] = [];
  async health() {}
  async listSessions() { return []; }
  async createSession() {
    return { id: "telegram-session-hermes", title: "Telegram", createdAt: null, updatedAt: null };
  }
  async listMessages() { return []; }
  async *streamTurn(access: { catalogId: string }, sessionId: string, message: { parts: Array<{ type: string; text?: string }> }): AsyncIterable<AgentChatEvent> {
    this.turns.push({
      connectionId: "92b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
      identity: alpha,
      workspaceId: "00000000-0000-4000-8000-000000000000",
      agentCatalogId: access.catalogId as "hermes-claw",
      externalSenderId: "10001",
      updateId: "1",
      sessionId,
      text: message.parts.find((part) => part.type === "text")?.text ?? "",
    });
    yield {
      version: 1,
      sequence: 0,
      sessionId,
      turnId: "turn-channel",
      type: "turn-start",
      messageId: "message-channel",
      createdAt: new Date().toISOString(),
    };
    yield {
      version: 1,
      sequence: 1,
      sessionId,
      turnId: "turn-channel",
      type: "text-delta",
      textId: "text-channel",
      delta: "Hello from Hermes",
    };
    yield {
      version: 1,
      sequence: 2,
      sessionId,
      turnId: "turn-channel",
      type: "turn-finish",
      state: "completed",
      completedAt: new Date().toISOString(),
    };
  }
}

test("workspace channel APIs bind an owned credential and policy-check the default agent", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(alpha, "personal", "channel-control-workspace");
  await store.update(workspace.id, { state: "ready" });
  const broker = new FakeBroker();
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(effectivePolicy(workspace.id)),
    channelBrokerClient: broker,
  });
  const credentialId = "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24";
  try {
    const missing = await app.inject({ method: "GET", url: `/v1/workspaces/${workspace.id}/channels/telegram`, headers });
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.json().state, "not_configured");

    const saved = await app.inject({
      method: "PUT",
      url: `/v1/workspaces/${workspace.id}/channels/telegram`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        credentialId,
        allowedUserIds: ["10001"],
        defaultAgentId: "hermes-claw",
        allowAgentSwitch: true,
      },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(broker.savedCredentialId, credentialId);

    const unavailable = await app.inject({
      method: "PUT",
      url: `/v1/workspaces/${workspace.id}/channels/telegram`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        credentialId,
        allowedUserIds: ["10001"],
        defaultAgentId: "not-an-agent",
        allowAgentSwitch: true,
      },
    });
    assert.equal(unavailable.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("workspace settings expose one manifest with a non-secret Telegram binding", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(alpha, "personal", "workspace-manifest");
  const broker = new FakeBroker();
  await broker.save(alpha, {
    workspaceId: workspace.id,
    credentialId: "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: true,
  });
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(effectivePolicy(workspace.id)),
    channelBrokerClient: broker,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/sandbox-settings?grantId=personal", headers });
    assert.equal(response.statusCode, 200);
    const manifest = response.json().manifest;
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.sandbox.agentIds, ["hermes-agent", "claude-cli", "codex-cli"]);
    assert.deepEqual(manifest.channels, [{
      adapter: "telegram",
      credentialRef: "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24",
      credentialVersion: 1,
      allowedSenderIds: ["10001"],
      defaultAgentId: "hermes-agent",
      allowAgentSwitch: true,
      inboundPolicy: "private-dm-only",
    }]);
    assert.ok(!JSON.stringify(manifest).includes("botToken"));
  } finally {
    await app.close();
  }
});

test("internal channel turns re-check connection, sender, workspace, route, and agent policy", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(alpha, "personal", "channel-turn-workspace");
  await store.update(workspace.id, { state: "ready" });
  const connectionId = "92b8576c-83f1-4c7b-bbcb-6d4d50fbab24";
  const credentialId = "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24";
  await store.saveChannelCredential(alpha, {
    id: credentialId,
    kind: "telegram_bot_token",
    credentialCiphertext: "k1.redacted",
    credentialKeyVersion: 1,
    version: 1,
    fingerprint: "test-fingerprint",
    displayName: "@onecomputer_test_bot",
    botUsername: "onecomputer_test_bot",
  });
  await store.saveChannelConnection(alpha, {
    id: connectionId,
    workspaceId: workspace.id,
    adapter: "telegram",
    credentialId,
    allowedUserIds: ["10001"],
    defaultAgentId: "hermes-claw",
    allowAgentSwitch: true,
    telegramUpdateOffset: "0",
  });
  const chat = new FakeAgentChat();
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(effectivePolicy(workspace.id)),
    agentChatSecret: "channel-agent-chat-secret-at-least-32-characters",
    agentChatClient: chat,
    channelBrokerInternalToken: channelToken,
  });
  const payload = {
    connectionId,
    identity: alpha,
    workspaceId: workspace.id,
    agentCatalogId: "hermes-claw",
    externalSenderId: "10001",
    updateId: "1",
    text: "hello",
  };
  await store.reserveChannelUpdate(connectionId, "1", "10001");
  try {
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/internal/v1/channels/turns",
      payload,
    });
    assert.equal(unauthenticated.statusCode, 401);

    const accepted = await app.inject({
      method: "POST",
      url: "/internal/v1/channels/turns",
      headers: { "x-onecomputer-channel-token": channelToken, "content-type": "application/json" },
      payload,
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), {
      sessionId: "telegram-session-hermes",
      text: "Hello from Hermes",
      notices: [],
    });

    const replayed = await app.inject({
      method: "POST",
      url: "/internal/v1/channels/turns",
      headers: { "x-onecomputer-channel-token": channelToken, "content-type": "application/json" },
      payload,
    });
    assert.equal(replayed.statusCode, 409);

    const foreignSender = await app.inject({
      method: "POST",
      url: "/internal/v1/channels/turns",
      headers: { "x-onecomputer-channel-token": channelToken, "content-type": "application/json" },
      payload: { ...payload, externalSenderId: "99999", updateId: "2" },
    });
    assert.equal(foreignSender.statusCode, 403);

    const wrongAgent = await app.inject({
      method: "POST",
      url: "/internal/v1/channels/turns",
      headers: { "x-onecomputer-channel-token": channelToken, "content-type": "application/json" },
      payload: { ...payload, agentCatalogId: "claude-cli", updateId: "3" },
    });
    assert.equal(wrongAgent.statusCode, 409);
  } finally {
    await app.close();
  }
});
