import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  activityEventSchema,
  type ActivityEventDraft,
  type AgentChatEvent,
  type IdentityContext,
} from "@onecomputer/contracts";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import {
  ActivityEventMapper,
  ActivityEventService,
  redactActivityValue,
  sanitizeActivityUrl,
} from "../apps/control-api/src/activity.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const turnId = "turn-11111111-1111-4111-8111-111111111111";
const sessionId = "session-1";
const timestamp = "2026-07-29T00:00:00.000Z";
const eventId = "11111111-1111-4111-8111-111111111111";
const base = {
  version: 1 as const,
  eventId,
  turnId,
  sequence: 0,
  timestamp,
  state: "completed" as const,
  provenance: "deterministic_system" as const,
  visibility: "user" as const,
};

const fixtures = [
  { ...base, kind: "plan", state: "running", payload: { title: "Work plan" } },
  { ...base, kind: "progress", state: "running", payload: { activityId: "progress-1", label: "Working" } },
  { ...base, kind: "provider_summary", provenance: "provider_generated", payload: { summary: "Provider update", provider: "Codex" } },
  { ...base, kind: "tool", provenance: "tool", payload: { toolCallId: "tool-1", name: "web.search", summary: "Tool completed" } },
  { ...base, kind: "web_action", provenance: "tool", payload: { action: "search", label: "Searched the web", url: "https://example.com/search?q=activity" } },
  { ...base, kind: "source", provenance: "provider_generated", payload: { title: "Example", url: "https://example.com/source", citation: "[1]" } },
  {
    ...base,
    kind: "approval",
    state: "requires_action",
    provenance: "tool",
    payload: {
      approvalId: "approval-1",
      toolCallId: "tool-1",
      operationId: "22222222-2222-4222-8222-222222222222",
      summary: "Approval required",
    },
  },
  { ...base, kind: "computer_action", state: "running", provenance: "tool", payload: { actionId: "computer-1", label: "Opened browser", viewerRef: "viewer-1" } },
  { ...base, kind: "notice", payload: { message: "Still working" } },
  { ...base, kind: "error", state: "failed", payload: { code: "TOOL_FAILED", message: "Tool failed", retryable: true } },
  { ...base, kind: "terminal", payload: { turnState: "completed" } },
] as const;

test("ActivityEventV1 accepts every supported event kind and rejects unsafe or malformed fixtures", () => {
  for (const fixture of fixtures) assert.equal(activityEventSchema.safeParse(fixture).success, true, fixture.kind);
  assert.equal(activityEventSchema.safeParse({ ...fixtures[5], payload: { title: "Unsafe", url: "javascript:alert(1)" } }).success, false);
  assert.equal(activityEventSchema.safeParse({ ...fixtures[5], payload: { title: "Unsafe", url: "https://user:password@example.com" } }).success, false);
  assert.equal(activityEventSchema.safeParse({ ...fixtures[5], payload: { title: "Unsafe", url: "https://example.com/file?X-Goog-Signature=secret" } }).success, false);
  assert.equal(activityEventSchema.safeParse({ ...fixtures[5], payload: { title: "Unsafe", url: "https://example.com/file#private-state" } }).success, false);
  const { sequence: _sequence, ...missingSequence } = fixtures[0];
  assert.equal(activityEventSchema.safeParse(missingSequence).success, false);
  assert.equal(activityEventSchema.safeParse({ ...fixtures[3], payload: { ...fixtures[3].payload, arguments: { apiKey: "must-not-persist" } } }).success, false);
  assert.equal(activityEventSchema.safeParse({ ...fixtures[7], payload: { ...fixtures[7].payload, screenshot: "data:image/png;base64,must-not-persist" } }).success, false);
  assert.equal(activityEventSchema.safeParse({ ...fixtures[10], version: 2 }).success, false);
});

test("Activity mapper labels provenance, maps explicit web actions, and redacts secrets and signed URLs", () => {
  const mapper = new ActivityEventMapper("Codex CLI");
  const event: AgentChatEvent = {
    version: 1,
    sequence: 4,
    sessionId,
    turnId,
    type: "tool",
    toolCallId: "tool-web-1",
    name: "web.search",
    state: "completed",
    summary: "Bearer secret-bearer-token https://example.com/result?q=ok&X-Amz-Signature=must-not-leak",
    progressLabel: "Reviewed the search results.",
  };
  const drafts = mapper.drafts(event);
  assert.deepEqual(drafts.map((draft) => [draft.kind, draft.provenance, draft.state]), [
    ["tool", "tool", "completed"],
  ]);
  const webAction = mapper.drafts({
    version: 1,
    sequence: 5,
    sessionId,
    turnId,
    type: "web-action",
    action: "search",
    label: "Searched for traditional rösti recipes",
  });
  assert.deepEqual(webAction.map((draft) => [draft.kind, draft.provenance, draft.state]), [["web_action", "tool", "completed"]]);
  assert.equal(JSON.stringify(drafts).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(drafts).includes("secret-bearer-token"), false);
  assert.equal(sanitizeActivityUrl("https://user:password@example.com/a?q=ok&token=secret#fragment"), "https://example.com/a?q=ok");

  const source = mapper.drafts({
    version: 1,
    sequence: 5,
    sessionId,
    turnId,
    type: "source",
    title: "Signed result",
    url: "https://example.com/file?safe=yes&X-Goog-Signature=must-not-persist#private-state",
  });
  assert.equal(source[0]?.kind, "source");
  assert.equal(source[0]?.kind === "source" ? source[0].payload.url : undefined, "https://example.com/file?safe=yes");

  const redacted = redactActivityValue({
    arguments: { nested: { apiKey: "sk-secret-value", cookie: "session=secret" } },
    systemPrompt: "hidden prompt",
    providerPayload: { reasoning: "hidden reasoning" },
    sourceUrl: "https://example.com/file?X-Amz-Credential=secret&safe=yes",
    kasmUrl: "https://kasm.example/session?token=signed-kasm-secret&safe=yes",
    screenshot: "data:image/png;base64,private-screen",
    pageContent: "private page contents",
  });
  const serialized = JSON.stringify(redacted);
  for (const secret of [
    "sk-secret-value",
    "session=secret",
    "hidden prompt",
    "hidden reasoning",
    "X-Amz-Credential=secret",
    "signed-kasm-secret",
    "private-screen",
    "private page contents",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("golden mapper output is stable for existing progress, tool, and approval events", () => {
  const mapper = new ActivityEventMapper("Claude CLI");
  const events: AgentChatEvent[] = [
    { version: 1, sequence: 1, sessionId, turnId, type: "progress", activityId: "progress-1", label: "Working", state: "running" },
    { version: 1, sequence: 2, sessionId, turnId, type: "tool", toolCallId: "tool-1", name: "get-drive-item", state: "completed", summary: "Read the item", progressLabel: "Reviewed the requested item." },
    {
      version: 1,
      sequence: 3,
      sessionId,
      turnId,
      type: "approval",
      approvalId: "approval-1",
      toolCallId: "tool-1",
      operationId: "22222222-2222-4222-8222-222222222222",
      state: "approval_required",
      summary: "Approve deletion",
    },
  ];
  assert.deepEqual(events.flatMap((event) => mapper.drafts(event)), [
    {
      turnId,
      visibility: "user",
      kind: "progress",
      state: "running",
      provenance: "deterministic_system",
      payload: { activityId: "progress-1", label: "Working" },
    },
    {
      turnId,
      visibility: "user",
      kind: "tool",
      state: "completed",
      provenance: "tool",
      payload: { toolCallId: "tool-1", name: "get-drive-item", summary: "Read the item" },
    },
    {
      turnId,
      visibility: "user",
      kind: "approval",
      state: "requires_action",
      provenance: "tool",
      payload: {
        approvalId: "approval-1",
        toolCallId: "tool-1",
        operationId: "22222222-2222-4222-8222-222222222222",
        summary: "Approve deletion",
      },
    },
  ]);
});

const owner: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "onecomputer-control" };
const outsider: IdentityContext = { tenantId: "other-tenant", subjectId: "alex", audience: "onecomputer-control" };

async function seededActivity() {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(owner, "personal", randomUUID());
  await store.update(workspace.id, { state: "ready" });
  const service = new ActivityEventService(store, 1, 10);
  const common = {
    identity: owner,
    workspaceId: workspace.id,
    agentCatalogId: "codex-cli" as const,
    sessionId,
    displayName: "Codex CLI",
    receivedAt: new Date(timestamp),
  };
  const events: AgentChatEvent[] = [
    { version: 1, sequence: 0, sessionId, turnId, type: "turn-start", messageId: "message-1", createdAt: timestamp },
    { version: 1, sequence: 1, sessionId, turnId, type: "tool", toolCallId: "tool-1", name: "web.search", state: "completed", summary: "Search complete", progressLabel: "Reviewed the search results." },
    { version: 1, sequence: 2, sessionId, turnId, type: "web-action", action: "search", label: "Searched for traditional rösti recipes" },
    { version: 1, sequence: 3, sessionId, turnId, type: "turn-finish", state: "completed", completedAt: "2026-07-29T00:00:01.000Z" },
  ];
  for (const event of events) await service.recordAgentEvent({ ...common, event });
  await service.recordAgentEvent({ ...common, event: events[1]! });
  return { store, workspace, service };
}

test("append-only replay assigns monotonic sequences and suppresses duplicate adapter events", async () => {
  const { store, workspace, service } = await seededActivity();
  const scope = { workspaceId: workspace.id, agentCatalogId: "codex-cli" as const, sessionId, turnId };
  const replay = await service.replay(owner, scope, -1);
  assert.deepEqual(replay.events.map((event) => [event.sequence, event.kind]), [
    [0, "plan"],
    [1, "tool"],
    [2, "web_action"],
    [3, "terminal"],
  ]);
  assert.equal(replay.terminal, true);
  assert.deepEqual((await service.replay(owner, scope, 1)).events.map((event) => event.sequence), [2, 3]);
  assert.equal((await store.replayActivityEvents(outsider, scope, -1, 100)).found, false);
  await assert.rejects(service.replay(outsider, scope, -1), (error: unknown) => Boolean(
    error && typeof error === "object" && "code" in error && error.code === "ACTIVITY_TURN_NOT_FOUND",
  ));
});

test("a live subscriber receives events appended after connection and closes on terminal", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(owner, "live", randomUUID());
  const service = new ActivityEventService(store, 1, 50);
  const common = {
    identity: owner,
    workspaceId: workspace.id,
    agentCatalogId: "codex-cli" as const,
    sessionId,
    displayName: "Codex CLI",
    receivedAt: new Date(timestamp),
  };
  await service.recordAgentEvent({
    ...common,
    event: { version: 1, sequence: 0, sessionId, turnId, type: "turn-start", messageId: "message-live", createdAt: timestamp },
  });
  const scope = { workspaceId: workspace.id, agentCatalogId: "codex-cli" as const, sessionId, turnId };
  const stream = service.subscribe(owner, scope, 0);
  const progressPromise = stream.next();
  await service.recordAgentEvent({
    ...common,
    event: { version: 1, sequence: 1, sessionId, turnId, type: "progress", activityId: "progress-live", label: "Working", state: "running" },
  });
  const progress = await progressPromise;
  assert.equal(progress.value?.kind, "progress");
  await service.recordAgentEvent({
    ...common,
    event: { version: 1, sequence: 2, sessionId, turnId, type: "turn-finish", state: "completed", completedAt: "2026-07-29T00:00:01.000Z" },
  });
  const terminal = await stream.next();
  assert.equal(terminal.value?.kind, "terminal");
  assert.equal((await stream.next()).done, true);
});

test("replay and live-stream requests reconnect after a sequence without cross-tenant leakage", async () => {
  const { store, workspace } = await seededActivity();
  const proxyToken = "activity-proxy-token-at-least-24-characters";
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, { testIdentityMode: true });
  const path = `/v1/workspaces/${workspace.id}/chat/agents/codex-cli/sessions/${sessionId}/turns/${turnId}/activity`;
  const headers = {
    "x-onecomputer-proxy-token": proxyToken,
    "x-onecomputer-test-tenant-id": owner.tenantId,
    "x-onecomputer-test-user-id": owner.subjectId,
  };
  const outsiderHeaders = {
    ...headers,
    "x-onecomputer-test-tenant-id": outsider.tenantId,
  };
  try {
    const replay = await app.inject({ method: "GET", url: `${path}?after=1`, headers });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json().events.map((event: { sequence: number }) => event.sequence), [2, 3]);

    const stream = await app.inject({ method: "GET", url: `${path}/stream`, headers: { ...headers, "last-event-id": "1" } });
    assert.equal(stream.statusCode, 200);
    assert.match(stream.headers["content-type"] ?? "", /^text\/event-stream/);
    assert.deepEqual([...stream.body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])), [2, 3]);
    const alreadyComplete = await app.inject({ method: "GET", url: `${path}/stream?after=3`, headers });
    assert.equal(alreadyComplete.statusCode, 200);
    assert.equal(alreadyComplete.body, "");

    const crossTenantReplay = await app.inject({ method: "GET", url: path, headers: outsiderHeaders });
    const crossTenantStream = await app.inject({ method: "GET", url: `${path}/stream`, headers: outsiderHeaders });
    assert.equal(crossTenantReplay.statusCode, 404);
    assert.equal(crossTenantStream.statusCode, 404);
    assert.equal(crossTenantReplay.body.includes(turnId), false);
    assert.equal(crossTenantStream.body.includes(turnId), false);

    const guessed = await app.inject({
      method: "GET",
      url: path.replace(turnId, "turn-22222222-2222-4222-8222-222222222222"),
      headers,
    });
    assert.equal(guessed.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("Activity drafts never accept raw prompts or provider payload fields", async () => {
  const { store, workspace } = await seededActivity();
  const draft = {
    turnId,
    kind: "notice",
    state: "completed",
    provenance: "deterministic_system",
    visibility: "user",
    payload: { message: "Safe", systemPrompt: "must-not-persist" },
  } as unknown as ActivityEventDraft;
  await assert.rejects(store.appendActivityEvent({
    identity: owner,
    workspaceId: workspace.id,
    agentCatalogId: "codex-cli",
    sessionId,
    turnId,
    dedupeKey: "invalid-raw-payload",
    occurredAt: new Date(timestamp),
    draft,
  }));
});
