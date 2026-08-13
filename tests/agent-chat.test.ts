import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import test from "node:test";
import {
  channelArtifactMaxBytes,
  channelArtifactMaxTotalBytes,
  channelAttachmentMaxBytes,
  channelAttachmentMaxTotalBytes,
  channelTurnResponseSchema,
  chatAttachmentMaxBytes,
  chatAttachmentMaxTotalBytes,
  chatTurnStateSchema,
  sendChatTurnSchema,
  type IdentityContext,
  type Launch,
  type RuntimePolicy,
  type Sandbox,
} from "@lemmacomputer/contracts";
import { MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import {
  AgentChatAuthority,
  AgentUiStreamMapper,
  HttpAgentChatClient,
  reconcileChatMessages,
  type AgentChatAccess,
} from "../apps/control-api/src/agent-chat.js";
import { WorkspaceService, type ControllerClient } from "../apps/control-api/src/service.js";

const execFileAsync = promisify(execFile);

const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "alex",
  audience: "lemmacomputer-control",
};

test("Hermes session titles stay in the LemmaComputer adapter so duplicate user titles cannot block a new chat", async () => {
  const adapter = await readFile(new URL("../docker/workspace/lemmacomputer-agent-chat.py", import.meta.url), "utf8");
  const sessionsStart = adapter.indexOf("async def sessions");
  const hermesCreation = adapter.indexOf('if AGENT == "hermes-claw":', sessionsStart);
  const creation = adapter.slice(hermesCreation, adapter.indexOf("async with state_lock:", hermesCreation));
  assert.match(creation, /json=\{\}/);
  assert.doesNotMatch(creation, /json=\{"title": item\["title"\]\}/);
  assert.match(adapter, /nextCursor/);
  assert.match(adapter, /NEEDS_INPUT_MARKER = "\[LEMMACOMPUTER_NEEDS_INPUT\]"/);
  assert.match(adapter, /terminal_state = "needs_input"/);
  assert.match(adapter, /"reasoningEffort": reasoning_effort/);
  assert.match(adapter, /item\.get\("reasoningEffort"\) != reasoning_effort/);
  assert.equal(chatTurnStateSchema.safeParse("needs_input").success, true);
});

test("agent turns durably upsert submitted and streaming messages before terminal completion", async () => {
  const adapter = await readFile(new URL("../docker/workspace/lemmacomputer-agent-chat.py", import.meta.url), "utf8");
  const persistence = adapter.slice(
    adapter.indexOf("def upsert_session_message"),
    adapter.indexOf("async def health"),
  );
  const eventApplication = adapter.slice(
    adapter.indexOf("def apply_event"),
    adapter.indexOf("async def claude_vendor_events"),
  );
  const home = await mkdtemp(path.join(tmpdir(), "lemmacomputer-chat-persistence-"));
  const program = `
import asyncio, json, sys
from pathlib import Path
from typing import Any
STATE_FILE = Path(sys.argv[1]) / "structured-sessions.json"
state_lock = asyncio.Lock()
def read_state(): return json.loads(STATE_FILE.read_text())
def write_state(document): STATE_FILE.write_text(json.dumps(document))
def find_session(document, session_id): return next((item for item in document["sessions"] if item.get("id") == session_id), None)
MAX_TEXT = 128000
${eventApplication}
${persistence}
session_id = "session-1"
user = {"id":"user-1","role":"user","metadata":{"agentCatalogId":"claude-cli","state":"completed","createdAt":"2026-07-30T00:00:00Z"},"parts":[{"type":"text","text":"Build the site","state":"done"}]}
streaming = {"id":"assistant-1","role":"assistant","metadata":{"agentCatalogId":"claude-cli","turnId":"turn-1","state":"streaming","createdAt":"2026-07-30T00:00:01Z"},"parts":[{"type":"text","text":"Building","state":"streaming","_id":"text-1"},{"type":"data-progress","id":"progress-1","data":{"activityId":"progress-1","label":"Still working…","state":"running"}}]}
completed = {"id":"assistant-1","role":"assistant","metadata":{"agentCatalogId":"claude-cli","turnId":"turn-1","state":"completed","createdAt":"2026-07-30T00:00:01Z"},"parts":[{"type":"data-terminal","id":"terminal-1","data":{"turnId":"turn-1","state":"completed"}}]}
STATE_FILE.write_text(json.dumps({"version":2,"sessions":[{"id":session_id,"vendorSessionId":None,"title":"Build","createdAt":"2026-07-30T00:00:00Z","updatedAt":"2026-07-30T00:00:00Z","messages":[]}]}))
async def run():
    await persist_turn_messages(session_id, [user], None, "2026-07-30T00:00:01Z")
    started = read_state()["sessions"][0]
    await persist_turn_messages(session_id, [streaming], None, "2026-07-30T00:00:02Z")
    checkpointed = read_state()["sessions"][0]
    await persist_turn_messages(session_id, [user, completed], "vendor-1", "2026-07-30T00:00:03Z")
    await persist_turn_messages(session_id, [user, completed], "vendor-1", "2026-07-30T00:00:03Z")
    finished = read_state()["sessions"][0]
    repeated_terminal = {"id":"assistant-terminal","role":"assistant","metadata":{"agentCatalogId":"claude-cli","turnId":"turn-terminal","state":"streaming","createdAt":"2026-07-30T00:00:01Z"},"parts":[]}
    apply_event(repeated_terminal, {"type":"turn-finish","turnId":"turn-terminal","state":"completed"})
    apply_event(repeated_terminal, {"type":"turn-finish","turnId":"turn-terminal","state":"cancelled","message":"Disconnected"})
    print(json.dumps({
      "startedRoles":[message["role"] for message in started["messages"]],
      "checkpointedStates":[message["metadata"]["state"] for message in checkpointed["messages"]],
      "checkpointHasPrivateIds":any("_id" in part for message in checkpointed["messages"] for part in message["parts"]),
      "finishedStates":[message["metadata"]["state"] for message in finished["messages"]],
      "finishedIds":[message["id"] for message in finished["messages"]],
      "vendorSessionId":finished["vendorSessionId"],
      "terminalCount":len([part for part in repeated_terminal["parts"] if part["type"] == "data-terminal"]),
      "terminalState":repeated_terminal["metadata"]["state"],
    }))
asyncio.run(run())
`;
  try {
    const { stdout } = await execFileAsync("python3", ["-c", program, home]);
    const result = JSON.parse(stdout);
    assert.deepEqual(result.startedRoles, ["user"]);
    assert.deepEqual(result.checkpointedStates, ["completed", "streaming"]);
    assert.equal(result.checkpointHasPrivateIds, false);
    assert.deepEqual(result.finishedStates, ["completed", "completed"]);
    assert.deepEqual(result.finishedIds, ["user-1", "assistant-1"]);
    assert.equal(result.vendorSessionId, "vendor-1");
    assert.equal(result.terminalCount, 1);
    assert.equal(result.terminalState, "cancelled");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("detached turn production survives subscriber disconnect and remains replayable", async () => {
  const adapter = await readFile(new URL("../docker/workspace/lemmacomputer-agent-chat.py", import.meta.url), "utf8");
  const detachedTurn = adapter.slice(
    adapter.indexOf("class DetachedTurn"),
    adapter.indexOf("def now"),
  );
  const program = `
import asyncio, json
from typing import AsyncIterator
${detachedTurn}
async def run():
    turn = DetachedTurn("session-1", "turn-1")
    async def produce():
        await turn.publish(b'{"type":"turn-start"}\\n')
        await asyncio.sleep(0.02)
        await turn.publish(b'{"type":"turn-finish","state":"completed"}\\n')
        await turn.close()
    turn.task = asyncio.create_task(produce())
    first_subscriber = turn.subscribe()
    first = await anext(first_subscriber)
    await first_subscriber.aclose()
    await turn.task
    replay = [chunk async for chunk in turn.subscribe()]
    print(json.dumps({
      "first": first.decode().strip(),
      "replay": [chunk.decode().strip() for chunk in replay],
      "terminal": turn.terminal,
      "done": turn.done,
    }))
asyncio.run(run())
`;
  const { stdout } = await execFileAsync("python3", ["-c", program]);
  const result = JSON.parse(stdout);
  assert.equal(JSON.parse(result.first).type, "turn-start");
  assert.deepEqual(result.replay.map((frame: string) => JSON.parse(frame).type), ["turn-start", "turn-finish"]);
  assert.equal(result.terminal, true);
  assert.equal(result.done, true);
  assert.match(adapter, /asyncio\.create_task\(produce\(\), name=f"chat-\{turn_id\}"\)/);
  assert.match(adapter, /StreamingResponse\(\s*detached\.subscribe\(\)/s);
  assert.match(adapter, /Route\("\/api\/sessions\/\{session_id:uuid\}\/turns\/active", cancel_active_turn, methods=\["DELETE"\]\)/);
});

test("agent runtime permits independent active turns for separate chat sessions", async () => {
  const adapter = await readFile(new URL("../docker/workspace/lemmacomputer-agent-chat.py", import.meta.url), "utf8");
  const turnHandler = adapter.slice(adapter.indexOf("async def turns"), adapter.indexOf("async def cancel_active_turn"));

  // The claim intentionally uses the session identifier. A second request in
  // one conversation is rejected, but a different conversation is allowed to
  // run in the same workspace agent process.
  assert.match(turnHandler, /if session_id in active_sessions:/);
  assert.match(turnHandler, /active_sessions\.add\(session_id\)/);
  assert.doesNotMatch(turnHandler, /if active_sessions:/);
  assert.match(turnHandler, /active_turns\[session_id\] = detached/);
  assert.match(turnHandler, /active_sessions\.discard\(session_id\)/);
  assert.match(turnHandler, /active_turns\.pop\(session_id, None\)/);
});

test("Control pumps workspace events independently of the browser response", async () => {
  const control = await readFile(new URL("../apps/control-api/src/server.ts", import.meta.url), "utf8");
  const path = '"/v1/workspaces/:workspaceId/chat/agents/:catalogId/sessions/:sessionId/messages"';
  const pathIndex = control.lastIndexOf(path);
  const route = control.slice(control.lastIndexOf("app.post", pathIndex), control.indexOf("app.delete", pathIndex));
  assert.match(route, /const pump = async \(\) =>/);
  assert.match(route, /agentProcesses\.beginBrowserChat\(/);
  assert.match(route, /agentChat\.streamTurn\([\s\S]*usageTaskBinding, agentInstanceId,/);
  assert.match(route, /processLifecycle\.markRunning\(event\.turnId\)/);
  assert.match(route, /processLifecycle\.end\(event\.state === "failed" \? "provider_failed" : "process_exited"\)/);
  assert.match(route, /issueUsageTaskBinding\(/);
  assert.match(route, /void pump\(\)/);
  assert.match(route, /chunks\.push\(\.\.\.mapper\.chunks\(projected\)\)/);
  assert.doesNotMatch(route, /browser-disconnected|abort\.signal/);
  assert.match(control, /sessions\/:sessionId\/turns\/active/);
  assert.match(control, /await agentChat\.cancelTurn\(access, sessionId\)/);
  assert.match(control, /callerSuppliedAgentInstanceId\(request\.body\)/);
});

test("trusted browser chat identities reach each vendor's per-turn execution boundary", async () => {
  const adapter = await readFile(new URL("../docker/workspace/lemmacomputer-agent-chat.py", import.meta.url), "utf8");
  const turns = adapter.slice(adapter.indexOf("async def turns"), adapter.indexOf("async def cancel_active_turn"));
  const claude = adapter.slice(adapter.indexOf("async def claude_vendor_events"), adapter.indexOf("async def codex_vendor_events"));
  const codex = adapter.slice(adapter.indexOf("def codex_config"), adapter.indexOf("async def hermes_vendor_events"));
  const hermes = adapter.slice(adapter.indexOf("async def hermes_vendor_events"), adapter.indexOf("def vendor_events"));
  assert.match(turns, /agent_instance_id = value\.get\("agentInstanceId"\)/);
  assert.match(turns, /parsed_agent_instance_id\.version != 4/);
  assert.match(claude, /"LEMMACOMPUTER_AGENT_INSTANCE_ID": agent_instance_id/);
  assert.match(codex, /if agent_instance_id is None:[\s\S]*_codex_vendor_events_with_client\(\s*codex,/);
  assert.match(codex, /async with AsyncCodex\(codex_config\(agent_instance_id\)\) as process/);
  assert.match(codex, /"LEMMACOMPUTER_AGENT_INSTANCE_ID": agent_instance_id/);
  assert.match(hermes, /"x-lemmacomputer-agent-instance-id": agent_instance_id,[\s\S]*if agent_instance_id else \{\}/);
  assert.match(adapter, /codex = AsyncCodex\(codex_config\(\)\)/);
});

test("agent turns receive a fresh trusted timezone context and require clarification without one", async () => {
  const adapter = await readFile(new URL("../docker/workspace/lemmacomputer-agent-chat.py", import.meta.url), "utf8");
  assert.match(adapter, /CONFIGURED_TIME_ZONE = os\.environ\.get\("LEMMACOMPUTER_TIME_ZONE", ""\)\.strip\(\)/);
  assert.match(adapter, /datetime\.now\(LOCAL_TIME_ZONE\)/);
  assert.match(adapter, /current local date and time/);
  assert.match(adapter, /explicit timezone in the employee's latest request overrides/);
  assert.match(adapter, /Before a calendar write.*ask/s);
  assert.match(adapter, /never silently substitute a different timezone/);
  assert.match(adapter, /"instructions": system_prompt\(\)/);
});

test("chat accepts bounded inline image and document parts but rejects media mismatches", () => {
  const message = {
    id: "user-message-with-files",
    role: "user",
    metadata: {
      agentCatalogId: "claude-cli",
      state: "completed",
      createdAt: "2026-07-25T00:00:00Z",
    },
    parts: [
      {
        type: "file",
        filename: "pixel.png",
        mediaType: "image/png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      },
      {
        type: "file",
        filename: "notes.md",
        mediaType: "text/markdown",
        url: "data:text/markdown;base64,IyBOb3Rlcw==",
      },
      { type: "text", text: "Compare these attachments." },
    ],
  };
  assert.equal(sendChatTurnSchema.safeParse({ message }).success, true);
  assert.equal(sendChatTurnSchema.safeParse({
    message: {
      ...message,
      parts: [{ ...message.parts[0], mediaType: "image/jpeg" }],
    },
  }).success, false);
  assert.equal(sendChatTurnSchema.safeParse({
    message: { ...message, parts: Array.from({ length: 5 }, () => message.parts[0]) },
  }).success, false);
});

test("Telegram and browser attachment contracts keep separate transport limits", () => {
  assert.equal(chatAttachmentMaxBytes, 8 * 1024 * 1024);
  assert.equal(chatAttachmentMaxTotalBytes, 16 * 1024 * 1024);
  assert.equal(channelAttachmentMaxBytes, 20 * 1024 * 1024);
  assert.equal(channelAttachmentMaxTotalBytes, 80 * 1024 * 1024);

  const url = `data:application/pdf;base64,${Buffer.alloc(chatAttachmentMaxBytes + 1).toString("base64")}`;
  const message = {
    id: "user-message-over-browser-limit",
    role: "user",
    metadata: { agentCatalogId: "claude-cli", state: "completed", createdAt: "2026-07-30T00:00:00Z" },
    parts: [{ type: "file", filename: "report.pdf", mediaType: "application/pdf", url }],
  };
  assert.equal(sendChatTurnSchema.safeParse({ message }).success, false);
  assert.equal(sendChatTurnSchema.safeParse({ message: { ...message, metadata: { ...message.metadata, source: "telegram" } } }).success, true);
});

test("channel response artifacts are bounded, hashed, and typed", () => {
  assert.equal(channelArtifactMaxBytes, 50 * 1024 * 1024);
  assert.equal(channelArtifactMaxTotalBytes, 100 * 1024 * 1024);
  const artifact = { artifactId: "artifact-44444444444444444444444444444444", filename: "Deck.pptx",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", byteLength: channelArtifactMaxBytes, sha256: "a".repeat(64) };
  assert.equal(channelTurnResponseSchema.safeParse({ sessionId: "session-1", text: "Done", notices: [], artifacts: [artifact], state: "completed" }).success, true);
  assert.equal(channelTurnResponseSchema.safeParse({ sessionId: "session-1", text: "Done", notices: [], artifacts: [{ ...artifact, byteLength: channelArtifactMaxBytes + 1 }], state: "completed" }).success, false);
  assert.equal(channelTurnResponseSchema.safeParse({ sessionId: "session-1", text: "Done", notices: [], artifacts: [{ ...artifact }, { ...artifact, artifactId: "artifact-55555555555555555555555555555555" }], state: "completed" }).success, true);
  assert.equal(channelTurnResponseSchema.safeParse({ sessionId: "session-1", text: "Done", notices: [], artifacts: [{ ...artifact }, { ...artifact, artifactId: "artifact-55555555555555555555555555555555" }, { ...artifact, artifactId: "artifact-66666666666666666666666666666666" }], state: "completed" }).success, false);
  assert.equal(channelTurnResponseSchema.safeParse({ sessionId: "session-1", text: "Done", notices: [], artifacts: [{ ...artifact, sha256: "bad" }], state: "completed" }).success, false);
  assert.equal(channelTurnResponseSchema.safeParse({ sessionId: "session-1", text: "Done", notices: [], artifacts: Array.from({ length: 5 }, () => artifact), state: "completed" }).success, false);
});

const hermesPolicy: RuntimePolicy = {
  schemaVersion: 1,
  policyVersionId: "policy-version-1",
  policyVersion: 1,
  policyHash: "a".repeat(64),
  workspaceProfile: "kasm-persistent-standard",
  agentId: "agent-alex:hermes-claw",
  agentProfile: "hermes-claw-managed-v1",
  networkProfile: "controlled-egress-v1",
  modelAlias: "lemmacomputer-assistant",
  mcpServer: "lemmacomputer_ms365",
  allowedTools: ["list-mail-folders"],
  toolPolicies: { "list-mail-folders": "allow" },
  agents: [{
    catalogId: "hermes-claw",
    agentId: "agent-alex:hermes-claw",
    agentProfile: "hermes-claw-managed-v1",
    displayName: "Hermes",
    clientVersion: "v2026.7.20",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_ms365",
    allowedTools: ["list-mail-folders"],
    toolPolicies: { "list-mail-folders": "allow" },
  }],
};

class FakeController implements ControllerClient {
  lastChatRuntimes: Array<{ catalogId: "claude-cli" | "codex-cli" | "hermes-claw"; key: string }> | undefined;
  async create(input: Parameters<ControllerClient["create"]>[0]): Promise<Sandbox> {
    this.lastChatRuntimes = input.chatRuntimes;
    return { providerId: `sandbox-${input.workspaceId}`, state: "ready", failureCode: null };
  }
  async status(providerId: string): Promise<Sandbox> { return { providerId, state: "ready", failureCode: null }; }
  async open(_providerId: string): Promise<Launch> { return { launchUrl: "https://kasm.example", expiresAt: new Date().toISOString() }; }
  async destroy() {}
  async destroyWorkspace() {}
  async purgeWorkspace() {}
}

test("agent chat grants are deterministic, workspace-and-runtime-bound, and only issued for selected runtimes", () => {
  const authority = new AgentChatAuthority("test-agent-chat-root-secret-at-least-32-characters");
  const first = authority.issue(identity, "11111111-1111-4111-8111-111111111111", hermesPolicy, "hermes-claw");
  const same = authority.issue(identity, "11111111-1111-4111-8111-111111111111", hermesPolicy, "hermes-claw");
  const other = authority.issue(identity, "22222222-2222-4222-8222-222222222222", hermesPolicy, "hermes-claw");
  assert.deepEqual(first, same);
  assert.notEqual(first?.key, other?.key);
  assert.equal(first?.baseUrl, "http://lemmacomputer-sandbox-11111111-1111-4111-8111-111111111111:8642");

  const claudePolicy = { ...hermesPolicy, agentProfile: "claude-desktop-managed-v1" as const, agents: undefined };
  assert.equal(authority.issue(identity, "11111111-1111-4111-8111-111111111111", claudePolicy, "hermes-claw"), undefined);
});

test("workspace provisioning projects dedicated chat runtime grants and stopped workspaces cannot authorize chat", async () => {
  const controller = new FakeController();
  const authority = new AgentChatAuthority("test-agent-chat-root-secret-at-least-32-characters");
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
  assert.equal(controller.lastChatRuntimes?.[0]?.catalogId, "hermes-claw");
  assert.ok(controller.lastChatRuntimes?.[0]?.key);
  assert.equal((await service.agentChatAccess(identity, hermesPolicy, workspace.id, "hermes-claw")).workspaceId, workspace.id);
  await service.stop(identity, hermesPolicy, workspace.id);
  await assert.rejects(
    service.agentChatAccess(identity, hermesPolicy, workspace.id, "hermes-claw"),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "WORKSPACE_NOT_READY"),
  );
});

test("Hermes, Claude, and Codex satisfy the same ordered owned stream contract", async () => {
  const requests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
    });
    response.setHeader("content-type", "application/x-ndjson");
    const turnId = "turn-11111111-1111-4111-8111-111111111111";
    const frames = [
      { version: 1, sequence: 0, sessionId: "session-1", turnId, type: "turn-start", messageId: "message-1", createdAt: "2026-07-25T00:00:00Z" },
      { version: 1, sequence: 1, sessionId: "session-1", turnId, type: "tool", toolCallId: "tool-1", name: "get-drive-item", state: "running", progressLabel: "Reviewing the requested item…" },
      { version: 1, sequence: 2, sessionId: "session-1", turnId, type: "tool", toolCallId: "tool-1", name: "get-drive-item", state: "completed", summary: "Tool completed", progressLabel: "Reviewed the requested item." },
      { version: 1, sequence: 3, sessionId: "session-1", turnId, type: "text-delta", textId: "text-1", delta: "The sandbox agent replied." },
      { version: 1, sequence: 4, sessionId: "session-1", turnId, type: "turn-finish", state: "completed", completedAt: "2026-07-25T00:00:01Z" },
    ];
    response.end(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const message = {
    id: "user-message-1",
    role: "user" as const,
    metadata: {
      agentCatalogId: "hermes-claw" as const,
      state: "completed" as const,
      createdAt: "2026-07-25T00:00:00Z",
    },
    parts: [{ type: "text" as const, text: "Hello", state: "done" as const }],
  };
  try {
    for (const catalogId of ["hermes-claw", "claude-cli", "codex-cli"] as const) {
      const access: AgentChatAccess = {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        catalogId,
        displayName: catalogId,
        key: `workspace-specific-${catalogId}-api-key`,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
      const client = new HttpAgentChatClient();
      const events = [];
      for await (const event of client.streamTurn(
        access,
        "session-1",
        { ...message, metadata: { ...message.metadata, agentCatalogId: catalogId } },
        undefined,
        undefined,
        "22222222-2222-4222-8222-222222222222",
        catalogId === "claude-cli" ? "medium" : undefined,
      )) events.push(event);
      assert.deepEqual(events.map((event) => event.type), [
        "turn-start", "tool", "tool", "text-delta", "turn-finish",
      ]);
      assert.equal(JSON.stringify(events).includes("must-not-leak"), false);
      const mapper = new AgentUiStreamMapper(catalogId);
      const chunks = events.flatMap((event) => mapper.chunks(event));
      assert.equal(chunks.filter((chunk) => chunk.type === "start").length, 1);
      assert.equal(chunks.filter((chunk) => chunk.type === "text-delta").length, 1);
      assert.equal(chunks.filter((chunk) => chunk.type === "data-tool").length, 0);
      assert.deepEqual(
        chunks.filter((chunk) => chunk.type === "data-progress").map((chunk) => chunk.data.label),
        ["Reviewing the requested item…", "Reviewed the requested item."],
      );
      assert.equal(chunks.filter((chunk) => chunk.type === "finish").length, 1);
    }
    assert.deepEqual(requests.map(({ url, body }) => ({ url, body })), [
      {
        url: "/api/sessions/session-1/turns",
        body: { message, agentInstanceId: "22222222-2222-4222-8222-222222222222" },
      },
      {
        url: "/api/sessions/session-1/turns",
        body: {
          message: { ...message, metadata: { ...message.metadata, agentCatalogId: "claude-cli" } },
          agentInstanceId: "22222222-2222-4222-8222-222222222222",
          reasoningEffort: "medium",
        },
      },
      {
        url: "/api/sessions/session-1/turns",
        body: {
          message: { ...message, metadata: { ...message.metadata, agentCatalogId: "codex-cli" } },
          agentInstanceId: "22222222-2222-4222-8222-222222222222",
        },
      },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("agent chat cancellation targets the active detached workspace turn", async () => {
  let method = "";
  let url = "";
  let authorization = "";
  const server = createServer((request, response) => {
    method = request.method ?? "";
    url = request.url ?? "";
    authorization = String(request.headers.authorization ?? "");
    response.statusCode = 204;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const access: AgentChatAccess = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    catalogId: "claude-cli",
    displayName: "Claude CLI",
    key: "workspace-specific-claude-api-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
  try {
    await new HttpAgentChatClient().cancelTurn(access, "session-1");
    assert.equal(method, "DELETE");
    assert.equal(url, "/api/sessions/session-1/turns/active");
    assert.equal(authorization, `Bearer ${access.key}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("agent streams reject malformed ordering, cross-session events, and abrupt disconnects", async () => {
  const turnId = "turn-11111111-1111-4111-8111-111111111111";
  const started = {
    version: 1,
    sequence: 0,
    sessionId: "session-1",
    turnId,
    type: "turn-start",
    messageId: "message-1",
    createdAt: "2026-07-25T00:00:00Z",
  };
  const cases: Array<{ name: string; frames: unknown[] }> = [
    {
      name: "out-of-order",
      frames: [
        started,
        { version: 1, sequence: 2, sessionId: "session-1", turnId, type: "turn-finish", state: "completed", completedAt: "2026-07-25T00:00:01Z" },
      ],
    },
    {
      name: "cross-session",
      frames: [
        started,
        { version: 1, sequence: 1, sessionId: "session-2", turnId, type: "turn-finish", state: "completed", completedAt: "2026-07-25T00:00:01Z" },
      ],
    },
    {
      name: "abrupt",
      frames: [started],
    },
    {
      name: "malformed",
      frames: [started, "not-json"],
    },
  ];
  const message = {
    id: "user-message-1",
    role: "user" as const,
    metadata: {
      agentCatalogId: "claude-cli" as const,
      state: "completed" as const,
      createdAt: "2026-07-25T00:00:00Z",
    },
    parts: [{ type: "text" as const, text: "Hello", state: "done" as const }],
  };

  for (const scenario of cases) {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/x-ndjson");
      response.end(`${scenario.frames.map((frame) => typeof frame === "string" ? frame : JSON.stringify(frame)).join("\n")}\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new HttpAgentChatClient();
    const access: AgentChatAccess = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      catalogId: "claude-cli",
      displayName: "Claude CLI",
      key: "workspace-specific-claude-api-key",
      baseUrl: `http://127.0.0.1:${address.port}`,
    };
    try {
      await assert.rejects(async () => {
        for await (const _event of client.streamTurn(access, "session-1", message)) {
          // Exhaust the stream so terminal validation runs.
        }
      }, (error: unknown) => Boolean(
        error
        && typeof error === "object"
        && "code" in error
        && error.code === "CHAT_INVALID_RESPONSE",
      ), scenario.name);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("terminal and repeated-tool updates keep stable owned UI part identifiers for every agent", () => {
  for (const catalogId of ["hermes-claw", "claude-cli", "codex-cli"] as const) {
    const mapper = new AgentUiStreamMapper(catalogId);
    const base = {
      version: 1 as const,
      sessionId: "session-1",
      turnId: "turn-11111111-1111-4111-8111-111111111111",
    };
    mapper.chunks({
      ...base,
      sequence: 0,
      type: "turn-start",
      messageId: "message-1",
      createdAt: "2026-07-25T00:00:00Z",
    });
    const running = mapper.chunks({
      ...base,
      sequence: 1,
      type: "tool",
      toolCallId: "tool-1",
      name: "get-drive-item",
      state: "running",
      progressLabel: "Reviewing planning-draft.docx…",
    });
    const completed = mapper.chunks({
      ...base,
      sequence: 2,
      type: "tool",
      toolCallId: "tool-1",
      name: "get-drive-item",
      state: "completed",
      summary: "Tool completed",
      progressLabel: "Reviewed planning-draft.docx.",
    });
    assert.equal(running[0]?.type, "data-progress");
    assert.equal(completed[0]?.type, "data-progress");
    assert.equal("id" in running[0]! ? running[0].id : undefined, `progress-${base.turnId}`);
    assert.equal("id" in completed[0]! ? completed[0].id : undefined, `progress-${base.turnId}`);
    assert.equal(running[0]?.type === "data-progress" ? running[0].data.label : "", "Reviewing planning-draft.docx…");
    assert.equal(completed[0]?.type === "data-progress" ? completed[0].data.label : "", "Reviewed planning-draft.docx.");

    for (const [state, finishReason] of [
      ["needs_input", "stop"],
      ["cancelled", "other"],
      ["failed", "error"],
    ] as const) {
      const terminal = mapper.chunks({
        ...base,
        sequence: 3,
        type: "turn-finish",
        state,
        message: `Turn ${state}`,
        completedAt: "2026-07-25T00:00:01Z",
      });
      assert.equal(terminal.find((chunk) => chunk.type === "data-terminal")?.data.state, state);
      assert.equal(terminal.find((chunk) => chunk.type === "finish")?.finishReason, finishReason);
    }
  }
});

test("legacy tool events stay in Activity without adding transcript parts", () => {
  const mapper = new AgentUiStreamMapper();
  assert.deepEqual(mapper.chunks({
    version: 1,
    sequence: 1,
    sessionId: "session-1",
    turnId: "turn-11111111-1111-4111-8111-111111111111",
    type: "tool",
    toolCallId: "tool-1",
    name: "get-drive-item",
    state: "running",
  }), []);
});

test("terminal history closes stale activity and reconciles approval that completed after stop", async () => {
  const messages = [{
    id: "message-1",
    role: "assistant" as const,
    metadata: {
      agentCatalogId: "claude-cli" as const,
      turnId: "turn-1",
      state: "cancelled" as const,
      createdAt: "2026-07-25T00:00:00Z",
    },
    parts: [
      {
        type: "data-progress" as const,
        id: "progress-1",
        data: { activityId: "progress-1", label: "Claude is working", state: "running" as const },
      },
      {
        type: "data-tool" as const,
        id: "tool-1",
        data: { toolCallId: "tool-1", name: "wait-for-governed-operation", state: "running" as const },
      },
      {
        type: "data-approval" as const,
        id: "approval-1",
        data: {
          approvalId: "approval-1",
          toolCallId: "tool-1",
          operationId: "11111111-1111-4111-8111-111111111111",
          state: "approval_required" as const,
          summary: "Waiting for signed approval",
        },
      },
      {
        type: "data-terminal" as const,
        id: "terminal-1",
        data: { turnId: "turn-1", state: "cancelled" as const, message: "Stopped by the employee" },
      },
    ],
  }];

  const reconciled = await reconcileChatMessages(messages, async () => ({
    state: "succeeded",
    safeSummary: "Delete Q3-draft.docx from OneDrive",
  }));
  assert.deepEqual(reconciled[0]?.parts.map((part) => (
    part.type === "data-progress"
      ? [part.type, part.data.state, part.data.label]
      : part.type === "data-tool"
        ? [part.type, part.data.state, part.data.summary]
        : part.type === "data-approval"
          ? [part.type, part.data.state, part.data.summary]
          : [part.type, part.data.state, part.data.message]
  )), [
    ["data-progress", "completed", "Work stopped"],
    ["data-tool", "failed", "Stopped before the tool returned"],
    ["data-approval", "succeeded", "Completed: Delete Q3-draft.docx from OneDrive"],
    ["data-terminal", "cancelled", "Stopped by the employee"],
  ]);
});
