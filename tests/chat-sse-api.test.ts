import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HttpAgentChatClient, type AgentChatAccess } from "../apps/control-api/src/agent-chat.js";

const access: AgentChatAccess = {
  workspaceId: "workspace-e2b",
  catalogId: "opencode-cli",
  displayName: "OpenCode CLI",
  key: "scoped-chat-key",
  baseUrl: "http://127.0.0.1:0",
};

test("chat API consumes ordered ACP-derived NDJSON/SSE-equivalent turns for OpenCode", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/sessions/session-1/turns" && request.method === "POST") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      const now = new Date().toISOString();
      const events = [
        { version: 1, sessionId: "session-1", turnId: "turn-1", sequence: 0, type: "turn-start", messageId: "message-1", createdAt: now, runtime: { transport: "acp", protocolVersion: "1", implementation: "OpenCode", implementationVersion: "1.18.10", capabilities: { loadSession: true, resumeSession: true, cancelTurn: true, permissions: true, fsReadTextFile: false, fsWriteTextFile: false, terminal: false, mcp: true } } },
        { version: 1, sessionId: "session-1", turnId: "turn-1", sequence: 1, type: "text-delta", textId: "text-1", delta: "E2B OpenCode" },
        { version: 1, sessionId: "session-1", turnId: "turn-1", sequence: 2, type: "turn-finish", state: "completed", completedAt: now },
      ];
      events.forEach((event, index) => setTimeout(() => response.write(`${JSON.stringify(event)}\n`), index * 15));
      setTimeout(() => response.end(), events.length * 15 + 5);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new HttpAgentChatClient();
    const events = [];
    const message = { id: "user-1", role: "user", metadata: { agentCatalogId: "opencode-cli", state: "completed", createdAt: new Date().toISOString() }, parts: [{ type: "text", text: "hello", state: "done" }] } as const;
    for await (const event of client.streamTurn({ ...access, baseUrl: `http://127.0.0.1:${address.port}` }, "session-1", message)) events.push(event);
    assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2]);
    assert.equal(events.at(1)?.type === "text-delta" && events.at(1)?.delta, "E2B OpenCode");
    assert.equal(events.at(-1)?.type === "turn-finish" && events.at(-1)?.state, "completed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
