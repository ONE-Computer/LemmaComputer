import assert from "node:assert/strict";
import test from "node:test";
import type { AgentChatEvent, ChatUiMessage, IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import {
  MemoryWorkspaceStore,
  agentInstanceIdentityState,
  type AgentInstanceLocator,
  type AgentInstanceRecord,
  type AgentInstanceStore,
  type RegisterAgentInstanceInput,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type WorkspaceRecord,
} from "@lemmacomputer/workspace-store";
import type { AgentChatAccess, AgentChatClient, AgentChatSessionPage } from "../apps/control-api/src/agent-chat.js";
import {
  AgentProcessLifecycleService,
  callerSuppliedAgentInstanceId,
} from "../apps/control-api/src/agent-process-lifecycle.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const identity: IdentityContext = {
  tenantId: "tenant-1",
  subjectId: "user-1",
  audience: "lemmacomputer-control",
};
const workspace: WorkspaceRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: identity.tenantId,
  subjectId: identity.subjectId,
  grantId: "personal",
  state: "ready",
  providerId: "sandbox-1",
  failureCode: null,
  operationToken: null,
  accessGeneration: 3,
  createdAt: new Date("2026-08-12T00:00:00Z"),
  updatedAt: new Date("2026-08-12T00:00:00Z"),
};
const policy: RuntimePolicy = {
  schemaVersion: 1,
  policyVersionId: "policy-version-7",
  policyVersion: 7,
  policyHash: "a".repeat(64),
  workspaceProfile: "kasm-persistent-standard",
  executionMode: "managed",
  egressMode: "restricted",
  agentId: "agent-1:claude-cli",
  agentProfile: "claude-cli-managed-v1",
  applications: ["firefox"],
  networkProfile: "controlled-egress-v1",
  modelAlias: "lemmacomputer-claude",
  requestedServiceClass: "auto",
  mcpServer: "lemmacomputer_fixture",
  allowedTools: ["search_files"],
  toolPolicies: { search_files: "allow" },
};

const record = (registration: RegisterAgentInstanceInput): AgentInstanceRecord => ({
  id: "22222222-2222-4222-8222-222222222222",
  tenantId: registration.tenantId,
  ownerSubjectId: registration.ownerSubjectId,
  workspaceId: registration.workspaceId,
  agentCatalogId: registration.agentCatalogId,
  logicalAgentId: registration.logicalAgentId,
  accessGeneration: registration.accessGeneration,
  providerRuntimeId: null,
  imageDigest: null,
  imageVersion: null,
  policyVersionId: registration.policyVersionId,
  policyVersion: registration.policyVersion,
  policyHash: registration.policyHash,
  launchIdempotencyKey: registration.launchIdempotencyKey,
  status: "starting",
  launchRequestedAt: new Date("2026-08-12T00:00:01Z"),
  startedAt: null,
  endedAt: null,
  endReason: null,
  cleanupStatus: "not_required",
  cleanupFailureCode: null,
  cleanupFailureAt: null,
  cleanupConfirmedAt: null,
  cleanupUpdatedAt: new Date("2026-08-12T00:00:01Z"),
  createdAt: new Date("2026-08-12T00:00:01Z"),
  updatedAt: new Date("2026-08-12T00:00:01Z"),
});

class RecordingAgentInstanceStore implements AgentInstanceStore {
  registration?: RegisterAgentInstanceInput;
  running?: AgentInstanceLocator & { providerRuntimeId: string; imageDigest?: string | null; imageVersion?: string | null };
  ended?: AgentInstanceLocator & { reason: "process_exited" | "launch_failed" | "provider_failed" };
  disposition: "created" | "existing" = "created";

  async registerLaunch(input: RegisterAgentInstanceInput) {
    this.registration = input;
    return { disposition: this.disposition, instance: record(input) };
  }
  async get() { return null; }
  async listForWorkspace() { return []; }
  async markRunning(input: AgentInstanceLocator & { providerRuntimeId: string }) {
    this.running = input;
    return { ...record(this.registration!), status: "running" as const, providerRuntimeId: input.providerRuntimeId };
  }
  async end(input: AgentInstanceLocator & { reason: "process_exited" | "launch_failed" | "provider_failed" }) {
    this.ended = input;
    return { ...record(this.registration!), status: "ended" as const, endReason: input.reason };
  }
  async recordCleanupOutcome() { return null; }
}

const launch = {
  identity,
  workspace,
  policy,
  catalogId: "claude-cli" as const,
  logicalAgentId: "agent-1:claude-cli",
  sessionId: "session-1",
  idempotencyKey: "browser-request-key-123456",
};

test("browser Claude chat receives a server-generated instance and records immutable launch, running, and exit evidence", async () => {
  const store = new RecordingAgentInstanceStore();
  const lifecycle = await new AgentProcessLifecycleService(store).beginBrowserChat(launch);

  assert.deepEqual(lifecycle.identity, agentInstanceIdentityState("22222222-2222-4222-8222-222222222222"));
  assert.deepEqual(store.registration, {
    tenantId: identity.tenantId,
    ownerSubjectId: identity.subjectId,
    workspaceId: workspace.id,
    agentCatalogId: "claude-cli",
    logicalAgentId: "agent-1:claude-cli",
    accessGeneration: 3,
    policyVersionId: "policy-version-7",
    policyVersion: 7,
    policyHash: "a".repeat(64),
    launchIdempotencyKey: store.registration?.launchIdempotencyKey,
  });
  assert.match(store.registration!.launchIdempotencyKey, /^browser-chat:v1:[a-f0-9]{64}$/);
  assert.equal(store.registration!.launchIdempotencyKey.includes(launch.idempotencyKey), false);

  await lifecycle.markRunning("turn-33333333-3333-4333-8333-333333333333");
  assert.equal(store.running?.agentInstanceId, lifecycle.identity.agentInstanceId);
  assert.equal(store.running?.providerRuntimeId, "chat-turn:turn-33333333-3333-4333-8333-333333333333");
  await lifecycle.end("process_exited");
  assert.equal(store.ended?.reason, "process_exited");
});

test("pre-start failures are recorded while existing registrations cannot launch a second process", async () => {
  const store = new RecordingAgentInstanceStore();
  const service = new AgentProcessLifecycleService(store);
  const lifecycle = await service.beginBrowserChat(launch);
  await lifecycle.end("launch_failed");
  assert.equal(store.ended?.reason, "launch_failed");

  store.disposition = "existing";
  await assert.rejects(service.beginBrowserChat(launch), { code: "AGENT_INSTANCE_LAUNCH_REPLAYED" });
});

test("unwired launch types remain explicit legacy identities without touching the authority", async () => {
  const store = new RecordingAgentInstanceStore();
  const service = new AgentProcessLifecycleService(store);
  const codex = await service.beginBrowserChat({ ...launch, catalogId: "codex-cli", logicalAgentId: "agent-1:codex-cli" });
  const absent = await new AgentProcessLifecycleService().beginBrowserChat(launch);
  assert.deepEqual(codex.identity, agentInstanceIdentityState(null));
  assert.deepEqual(absent.identity, agentInstanceIdentityState(null));
  assert.equal(store.registration, undefined);
});

test("caller-supplied agent instance identifiers fail closed at any request-body depth", () => {
  assert.equal(callerSuppliedAgentInstanceId({ message: { metadata: { agentInstanceId: crypto.randomUUID() } } }), true);
  assert.equal(callerSuppliedAgentInstanceId({ agent_instance_id: crypto.randomUUID() }), true);
  assert.equal(callerSuppliedAgentInstanceId({ message: { parts: [{ type: "text", text: "agent_instance_id is a compliance field" }] } }), false);
});

test("the browser chat route binds the trusted instance before one real Claude stream and records its exit", async () => {
  const workspaces = new MemoryWorkspaceStore();
  const owned = await workspaces.createOrGet(identity, "personal", "seed-workspace");
  await workspaces.update(owned.id, { state: "ready" });
  const instances = new RecordingAgentInstanceStore();
  const effective: EffectivePolicy = {
    assignmentId: "assignment-1",
    policyBundleId: "bundle-1",
    policyVersionId: policy.policyVersionId,
    version: policy.policyVersion,
    documentHash: policy.policyHash,
    assignedBy: "administrator",
    assignedAt: "2026-08-12T00:00:00Z",
    agentId: "agent-1",
    vendorUserId: "vendor-user-1",
    document: {
      schemaVersion: 1,
      workspaceProfile: "kasm-persistent-standard",
      workspaceProfiles: ["kasm-persistent-standard"],
      agentProfile: "claude-cli-managed-v1",
      agents: ["claude-cli"],
      defaultAgents: ["claude-cli"],
      applications: ["firefox"],
      defaultApplications: ["firefox"],
      modelAliases: ["lemmacomputer-claude"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { lemmacomputer_fixture: { tools: ["search_files"] } } },
    },
  };
  const identityPolicies = {
    getEffectivePolicy: async (userId: string) => userId === identity.subjectId ? effective : null,
  } as unknown as IdentityPolicyStore;
  let receivedInstanceId: string | undefined;
  const agentChat: AgentChatClient = {
    health: async () => undefined,
    listSessions: async (): Promise<AgentChatSessionPage> => ({ sessions: [], nextCursor: null }),
    createSession: async () => ({ id: "session-1", title: null, createdAt: null, updatedAt: null }),
    listMessages: async () => [],
    cancelTurn: async () => undefined,
    downloadArtifact: async () => Buffer.alloc(0),
    async *streamTurn(
      _access: AgentChatAccess,
      sessionId: string,
      _message: ChatUiMessage,
      _signal?: AbortSignal,
      _usageTaskBinding?: string,
      agentInstanceId?: string,
    ): AsyncIterable<AgentChatEvent> {
      receivedInstanceId = agentInstanceId;
      yield {
        version: 1, sequence: 0, sessionId,
        turnId: "turn-33333333-3333-4333-8333-333333333333",
        type: "turn-start", messageId: "assistant-1", createdAt: "2026-08-12T00:00:01Z",
      };
      yield {
        version: 1, sequence: 1, sessionId,
        turnId: "turn-33333333-3333-4333-8333-333333333333",
        type: "turn-finish", state: "completed", completedAt: "2026-08-12T00:00:02Z",
      };
    },
  };
  const proxyToken = "agent-instance-proxy-token-at-least-24-characters";
  const app = createControlServer(
    workspaces,
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    {},
    {
      testIdentityMode: true,
      identityPolicyStore: identityPolicies,
      agentChatSecret: "agent-instance-chat-secret-at-least-32-characters",
      agentChatClient: agentChat,
      agentInstanceStore: instances,
    },
  );
  const headers = {
    "x-lemmacomputer-proxy-token": proxyToken,
    "x-lemmacomputer-test-tenant-id": identity.tenantId,
    "x-lemmacomputer-test-user-id": identity.subjectId,
    "idempotency-key": "browser-chat-launch-0001",
  };
  const payload = {
    message: {
      id: "user-message-1",
      role: "user",
      metadata: {
        agentCatalogId: "claude-cli",
        state: "completed",
        createdAt: "2026-08-12T00:00:00Z",
      },
      parts: [{ type: "text", text: "Prepare the report." }],
    },
  };
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${owned.id}/chat/agents/claude-cli/sessions/session-1/messages`,
      headers,
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(receivedInstanceId, "22222222-2222-4222-8222-222222222222");
    assert.equal(instances.registration?.accessGeneration, owned.accessGeneration);
    assert.equal(instances.registration?.logicalAgentId, "agent-1:claude-cli");
    assert.equal(instances.running?.providerRuntimeId, "chat-turn:turn-33333333-3333-4333-8333-333333333333");
    assert.equal(instances.ended?.reason, "process_exited");

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${owned.id}/chat/agents/claude-cli/sessions/session-1/messages`,
      headers: { ...headers, "idempotency-key": "browser-chat-launch-0002" },
      payload: { ...payload, agentInstanceId: crypto.randomUUID() },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().error.code, "AGENT_INSTANCE_ID_FORBIDDEN");
  } finally {
    await app.close();
  }
});
