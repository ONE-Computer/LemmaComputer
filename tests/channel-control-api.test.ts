import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  m365ToolCatalog,
  TelegramTokenIntakeGrantIssuer,
  TelegramTokenIntakeGrantVerifier,
  type AgentChatEvent,
  type ChannelTurnRequest,
  type IdentityContext,
} from "@lemmacomputer/contracts";
import {
  MemoryChatStore,
  MemoryWorkspaceStore,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type RoutingStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { MemoryArtifactStore } from "@lemmacomputer/artifact-store";
import type { AgentChatClient } from "../apps/control-api/src/agent-chat.js";
import type { ChannelBrokerManagementClient } from "../apps/control-api/src/channel-broker.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "channel-control-proxy-token-at-least-24-characters";
const channelToken = "channel-control-internal-token-at-least-32-characters";
const alpha: IdentityContext = { tenantId: "acme", subjectId: "alpha", audience: "lemmacomputer-control" };
const principal: SessionPrincipal = {
  userId: "alpha",
  tenantId: "acme",
  email: "alpha@example.test",
  displayName: "Alpha User",
  tenantDisplayName: "Example Organization",
  roles: ["employee"],
  identity: alpha,
};
const generatedDeck = Buffer.from("control-generated-deck");
const generatedArtifact = {
  artifactId: "artifact-33333333333333333333333333333333",
  filename: "Executive-Summary.pptx",
  mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const,
  byteLength: generatedDeck.length,
  sha256: createHash("sha256").update(generatedDeck).digest("hex"),
};

const headers = {
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": alpha.tenantId,
  "x-lemmacomputer-test-user-id": alpha.subjectId,
};

const effectivePolicy = (): EffectivePolicy => ({
  assignmentId: "assignment-channel",
  policyBundleId: "bundle-channel",
  policyVersionId: "policy-channel",
  version: 1,
  documentHash: "a".repeat(64),
  assignedBy: "administrator",
  assignedAt: new Date().toISOString(),
  agentId: "agent-channel",
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
    modelAliases: ["lemmacomputer-assistant"],
    networkProfile: "controlled-egress-v1",
    mcp: {
      servers: {
        lemmacomputer_ms365: {
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
      displayName: "@lemmacomputer_test_bot",
      botUsername: "lemmacomputer_test_bot",
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
      botUsername: "lemmacomputer_test_bot",
      tokenVersion: 1,
      updatedAt: new Date().toISOString(),
    };
    return this.connection;
  }

  async disconnect() { this.connection = null; }
}

const tokenIntake = () => {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const privateKey = signing.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  return {
    grantIssuer: new TelegramTokenIntakeGrantIssuer(privateKey),
    verifier: new TelegramTokenIntakeGrantVerifier(signing.publicKey.export({ format: "der", type: "spki" }).toString("base64")),
    encryptionPublicKeySpkiBase64: encryption.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    intakeUrl: "/api/channel-intake/v1/telegram",
    ttlSeconds: 300,
  };
};

test("Control issues a bound Telegram intake grant without receiving a bot token", async () => {
  const store = new MemoryWorkspaceStore();
  const broker = new FakeBroker();
  const intake = tokenIntake();
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(effectivePolicy()),
    channelBrokerClient: broker,
    telegramTokenIntake: intake,
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/v1/credentials/telegram/intake-grants",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "telegram-intake-create-idempotency-key" },
      payload: {},
    });
    assert.equal(created.statusCode, 201);
    assert.equal(broker.savedToken, "");
    assert.ok(!JSON.stringify(created.json()).includes("telegram-token"));
    const grant = intake.verifier.verify(created.json().grant);
    assert.deepEqual(
      { tenantId: grant.tenantId, subjectId: grant.subjectId, action: grant.action, credentialId: grant.credentialId },
      { tenantId: alpha.tenantId, subjectId: alpha.subjectId, action: "create", credentialId: created.json().credentialId },
    );
    assert.equal(created.json().intakeUrl, "/api/channel-intake/v1/telegram");

    const invalidIdempotency = await app.inject({
      method: "POST",
      url: "/v1/credentials/telegram/intake-grants",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "too-short" },
      payload: {},
    });
    assert.equal(invalidIdempotency.statusCode, 400);
    assert.equal(invalidIdempotency.json().error.code, "IDEMPOTENCY_KEY_REQUIRED");

    const rotation = await app.inject({
      method: "POST",
      url: "/v1/credentials/72b8576c-83f1-4c7b-bbcb-6d4d50fbab24/telegram/intake-grants",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "telegram-intake-rotate-idempotency-key" },
      payload: {},
    });
    assert.equal(rotation.statusCode, 201);
    assert.equal(intake.verifier.verify(rotation.json().grant).action, "rotate");
    assert.equal(intake.verifier.verify(rotation.json().grant).credentialId, "72b8576c-83f1-4c7b-bbcb-6d4d50fbab24");
  } finally {
    await app.close();
  }
});

test("hosted Control rejects raw Telegram token payloads before the broker receives them", async () => {
  const broker = new FakeBroker();
  const app = createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(effectivePolicy()),
    channelBrokerClient: broker,
    telegramRawTokenInputMode: "reject",
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/credentials/telegram",
      headers: { ...headers, "content-type": "application/json" },
      // Deliberately malformed JSON proves the hosted rejection happens in
      // onRequest, before Fastify parses a raw token body.
      payload: '{"botToken":"123456789:telegram-token-that-control-must-not-forward"',
    });
    assert.equal(response.statusCode, 410);
    assert.equal(response.json().error.code, "TELEGRAM_RAW_TOKEN_INPUT_REJECTED");
    assert.equal(broker.savedToken, "");
  } finally {
    await app.close();
  }
});

test("credential APIs keep Telegram tokens write-only across create, rotate, list, and delete", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(alpha, "personal", "credential-control-workspace");
  const broker = new FakeBroker();
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(effectivePolicy()),
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
  messages: Array<{ parts: Array<{ type: string; text?: string; filename?: string; mediaType?: string; url?: string }> }> = [];
  approvalSummary: string | undefined;
  async health() {}
  async cancelTurn() {}
  async downloadArtifact(_access: unknown, artifactId: string) {
    if (artifactId !== generatedArtifact.artifactId) throw new Error("missing artifact");
    return generatedDeck;
  }
  async *streamTurn(access: { catalogId: string }, sessionId: string, message: { parts: Array<{ type: string; text?: string; filename?: string; mediaType?: string; url?: string }> }): AsyncIterable<AgentChatEvent> {
    this.messages.push(message);
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
    let sequence = 0;
    yield {
      version: 1,
      sequence: sequence++,
      sessionId,
      turnId: "turn-channel",
      type: "turn-start",
      messageId: "message-channel",
      createdAt: new Date().toISOString(),
    };
    if (this.approvalSummary) {
      yield {
        version: 1,
        sequence: sequence++,
        sessionId,
        turnId: "turn-channel",
        type: "approval",
        approvalId: "approval-channel",
        toolCallId: "tool-channel",
        operationId: "11111111-1111-4111-8111-111111111111",
        state: "approval_required",
        summary: this.approvalSummary,
      };
    }
    yield {
      version: 1, sequence: sequence++, sessionId, turnId: "turn-channel", type: "text-delta",
      textId: "text-channel", delta: "Hello from Hermes",
    };
    yield {
      version: 1, sequence: sequence++, sessionId, turnId: "turn-channel", type: "artifact",
      ...generatedArtifact,
    };
    yield {
      version: 1,
      sequence,
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
    identityPolicyStore: policyStore(effectivePolicy()),
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

test("workspace settings expose only explicit tiers and reject new Auto selections", async () => {
  const store = Object.assign(new MemoryWorkspaceStore(), {
    saveSandboxSettings: async () => {
      throw new Error("A rejected Auto selection must not reach persistence");
    },
  });
  const routingStore = {
    latestMappingVersion: async () => ({
      deployments: ["lite", "balanced", "pro"].map((serviceClass) => ({ serviceClass })),
    }),
  } as unknown as RoutingStore;
  const legacyPolicy = effectivePolicy();
  legacyPolicy.document.serviceClasses = ["auto", "lite", "pro"];
  legacyPolicy.document.defaultServiceClass = "auto";
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(legacyPolicy),
    routingStore,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/sandbox-settings?grantId=personal", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().modelAlias, "lemmacomputer-auto");
    assert.equal(response.json().requestedServiceClass, "balanced");
    assert.deepEqual(response.json().availableServiceClasses.map((entry: { value: string }) => entry.value), ["lite", "balanced", "pro"]);

    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/sandbox-settings",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        grantId: "personal",
        profileId: response.json().profileId,
        applicationIds: response.json().applicationIds,
        modelAlias: response.json().modelAlias,
        requestedServiceClass: "auto",
        agentIds: response.json().agentIds,
      },
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.json().error.code, "SERVICE_CLASS_NOT_ASSIGNED");
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
    identityPolicyStore: policyStore(effectivePolicy()),
    channelBrokerClient: broker,
  });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/sandbox-settings?grantId=personal", headers });
    assert.equal(response.statusCode, 200);
    const manifest = response.json().manifest;
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.sandbox.agentIds, ["hermes-agent", "claude-cli"]);
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
    displayName: "@lemmacomputer_test_bot",
    botUsername: "lemmacomputer_test_bot",
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
  chat.approvalSummary = "Approval needed: Send Teams chat message.";
  const chatStore = new MemoryChatStore((_identity, targetWorkspaceId) => {
    assert.equal(targetWorkspaceId, workspace.id);
    return { workspaceNodeId: workspace.workspaceNodeId ?? null, accessGeneration: workspace.accessGeneration };
  });
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: policyStore(effectivePolicy()),
    agentChatSecret: "channel-agent-chat-secret-at-least-32-characters",
    agentChatClient: chat,
    chatStore,
    artifactStore: new MemoryArtifactStore(),
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
    attachments: [{
      type: "file",
      filename: "telegram-photo.jpg",
      mediaType: "image/jpeg",
      url: "data:image/jpeg;base64,/9j/2Q==",
    }],
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
      headers: { "x-lemmacomputer-channel-token": channelToken, "content-type": "application/json" },
      payload,
    });
    assert.equal(accepted.statusCode, 200);
    assert.match(accepted.headers["content-type"] ?? "", /^application\/x-ndjson/);
    assert.deepEqual(chat.messages[0]?.parts, [
      { type: "text", text: "hello" },
      {
        type: "file",
        filename: "telegram-photo.jpg",
        mediaType: "image/jpeg",
        url: "data:image/jpeg;base64,/9j/2Q==",
      },
    ]);
    assert.equal(chat.messages[0]?.metadata.source, "telegram");
    const acceptedFrames = accepted.body.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(acceptedFrames.slice(0, 2), [
        {
          type: "notice",
          notice: "Approval needed: Send Teams chat message. Open LemmaComputer to review this protected action.",
        },
        {
          type: "text-delta",
          delta: "Hello from Hermes",
        },
      ]);
    const response = acceptedFrames[2]?.response;
    assert.equal(acceptedFrames[2]?.type, "result");
    assert.match(response.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(response.text, "Hello from Hermes");
    assert.deepEqual(response.notices, ["Approval needed: Send Teams chat message. Open LemmaComputer to review this protected action."]);
    assert.equal(response.state, "completed");
    assert.equal(response.artifacts.length, 1);
    const [canonicalArtifact] = response.artifacts;
    assert.match(canonicalArtifact.artifactId, /^artifact-[a-f0-9]{32}$/);
    assert.match(canonicalArtifact.revisionId, /^revision-[a-f0-9]{32}$/);
    assert.equal(canonicalArtifact.filename, generatedArtifact.filename);
    assert.equal(canonicalArtifact.sha256, generatedArtifact.sha256);

    const artifactRequest = { connectionId, identity: alpha, workspaceId: workspace.id, agentCatalogId: "hermes-claw",
      externalSenderId: "10001", artifact: canonicalArtifact };
    const unauthenticatedArtifact = await app.inject({ method: "POST", url: "/internal/v1/channels/artifacts", payload: artifactRequest });
    assert.equal(unauthenticatedArtifact.statusCode, 401);
    const deliveredArtifact = await app.inject({ method: "POST", url: "/internal/v1/channels/artifacts",
      headers: { "x-lemmacomputer-channel-token": channelToken, "content-type": "application/json" }, payload: artifactRequest });
    assert.equal(deliveredArtifact.statusCode, 200);
    assert.equal(deliveredArtifact.headers["content-type"], generatedArtifact.mediaType);
    assert.deepEqual(deliveredArtifact.rawPayload, generatedDeck);

    const replayed = await app.inject({
      method: "POST",
      url: "/internal/v1/channels/turns",
      headers: { "x-lemmacomputer-channel-token": channelToken, "content-type": "application/json" },
      payload,
    });
    assert.equal(replayed.statusCode, 409);

    const foreignSender = await app.inject({
      method: "POST",
      url: "/internal/v1/channels/turns",
      headers: { "x-lemmacomputer-channel-token": channelToken, "content-type": "application/json" },
      payload: { ...payload, externalSenderId: "99999", updateId: "2" },
    });
    assert.equal(foreignSender.statusCode, 403);

    const wrongAgent = await app.inject({
      method: "POST",
      url: "/internal/v1/channels/turns",
      headers: { "x-lemmacomputer-channel-token": channelToken, "content-type": "application/json" },
      payload: { ...payload, agentCatalogId: "claude-cli", updateId: "3" },
    });
    assert.equal(wrongAgent.statusCode, 409);
  } finally {
    await app.close();
  }
});
