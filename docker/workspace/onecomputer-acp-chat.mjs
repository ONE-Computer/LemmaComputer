#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import * as acp from "/opt/onecomputer/acp-runtime/node_modules/@agentclientprotocol/sdk/dist/acp.js";

const agent = process.env.ONECOMPUTER_ACP_AGENT;
const apiKey = process.env.ONECOMPUTER_ACP_API_KEY ?? "";
const model = process.env.ONECOMPUTER_ACP_MODEL_ALIAS ?? "";
const gateway = process.env.ONECOMPUTER_ACP_GATEWAY_UPSTREAM ?? "";
const gatewayCredential = process.env.ONECOMPUTER_ACP_GATEWAY_CREDENTIAL ?? "";
const port = Number(process.env.ONECOMPUTER_ACP_PORT ?? "8645");
const home = "/home/kasm-user";
const cwd = home;
if (!(agent === "codex-cli" || agent === "opencode-cli") || apiKey.length < 32 || !model || !gateway || gatewayCredential.length < 32 || ![8644, 8645].includes(port)) {
  throw new Error("invalid ACP chat configuration");
}

const command = agent === "opencode-cli" ? "opencode" : "codex-acp";
const args = agent === "opencode-cli" ? ["acp"] : [];
const sessions = new Map();

const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(body);
};
const authorized = (req) => req.headers.authorization === `Bearer ${apiKey}`;
const readBody = async (req, limit = 24 * 1024 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const now = () => new Date().toISOString();
const identifier = (prefix, value) => `${prefix}-${Buffer.from(String(value)).toString("hex").slice(0, 32)}`;

const startSession = async () => {
  const child = spawn(command, args, {
    cwd,
    env: {
      HOME: home,
      PATH: "/opt/onecomputer/acp-runtime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
      NO_BROWSER: "1",
      ...(agent === "opencode-cli" ? { OPENCODE_CONFIG_DIR: `${home}/.config/opencode`, OPENCODE_DISABLE_TUI: "1", OPENCODE_MODEL: model } : { CODEX_HOME: `${home}/.codex-cli`, CODEX_CONFIG: JSON.stringify({ model }) }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const diagnostics = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics.push(String(chunk).replace(/(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]").slice(-500)); });
  const application = acp.client({ name: "ONEComputer", version: "0.1.0" })
    .onRequest(acp.methods.client.session.requestPermission, async () => ({ outcome: { outcome: "cancelled" } }));
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = application.connect(stream);
  const initialized = await Promise.race([
    connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "ONEComputer", version: "0.1.0" },
      clientCapabilities: { terminal: false },
    }),
    exited.then(() => { throw new Error("ACP process exited during initialization"); }),
  ]);
  if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`unsupported ACP protocol version ${initialized.protocolVersion}`);
  if (initialized.agentCapabilities?.providers == null) throw new Error("ACP runtime does not support governed provider configuration");
  await connection.agent.request(acp.methods.agent.providers.set, {
    providerId: "custom-gateway",
    apiType: "openai",
    baseUrl: gateway,
    headers: { Authorization: `Bearer ${gatewayCredential}` },
  });
  const session = await connection.agent.buildSession({ cwd, mcpServers: [] }).start();
  return { child, connection, session, vendorSessionId: session.sessionId, diagnostics, exited };
};

const closeSession = (item) => {
  item.connection.close();
  if (item.child.exitCode === null) item.child.kill("SIGTERM");
};

const streamTurn = async (res, item, sessionId, message) => {
  const turnId = `turn-${randomUUID()}`;
  let sequence = 0;
  const emit = (type, values) => ({ version: 1, sequence: sequence++, sessionId, turnId, type, ...values });
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-onecomputer-chat-protocol": "1" });
  res.write(`${JSON.stringify(emit("turn-start", { messageId: message.id, createdAt: now() }))}\n`);
  const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  if (!text) throw new Error("ACP prompt is empty");
  const prompt = item.session.prompt(text);
  try {
    for (;;) {
      const next = await Promise.race([item.session.nextUpdate(), item.exited.then(() => { throw new Error("ACP process exited during turn"); })]);
      if (next.kind === "stop") {
        await prompt;
        res.write(`${JSON.stringify(emit("turn-finish", { state: next.stopReason === "end_turn" ? "completed" : next.stopReason === "cancelled" ? "cancelled" : "failed", completedAt: now() }))}\n`);
        return;
      }
      const update = next.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        const delta = String(update.content.text).slice(0, 16_000);
        if (delta) res.write(`${JSON.stringify(emit("text-delta", { textId: identifier("text", turnId), delta }))}\n`);
      } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        res.write(`${JSON.stringify(emit("tool", { toolCallId: identifier("tool", update.toolCallId ?? "tool"), name: String(update.title ?? update.name ?? "ACP tool").replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 160) || "acp-tool", state: update.status === "completed" ? "completed" : update.status === "failed" ? "failed" : "running", summary: String(update.title ?? update.name ?? "ACP tool").slice(0, 500) }))}\n`);
      }
    }
  } catch (error) {
    res.write(`${JSON.stringify(emit("error", { code: "ACP_TURN_FAILED", message: "The ACP harness could not complete the turn", retryable: true }))}\n`);
    res.write(`${JSON.stringify(emit("turn-finish", { state: "failed", completedAt: now() }))}\n`);
  } finally {
    res.end();
  }
};

const server = createServer(async (req, res) => {
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
  try {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ready", agent, protocol: "onecomputer-chat-events/v1", transport: "acp" });
    if (req.method === "GET" && req.url === "/api/sessions") return json(res, 200, { sessions: [...sessions.entries()].map(([id, item]) => ({ id, title: null, created_at: item.createdAt, updated_at: item.updatedAt })), nextCursor: null });
    if (req.method === "POST" && req.url === "/api/sessions") {
      const id = randomUUID();
      const item = await startSession();
      item.createdAt = item.updatedAt = now();
      sessions.set(id, item);
      return json(res, 201, { id, title: null, created_at: item.createdAt, updated_at: item.updatedAt });
    }
    const turnMatch = req.url?.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (req.method === "POST" && turnMatch) {
      const item = sessions.get(turnMatch[1]);
      if (!item) return json(res, 404, { error: "session not found" });
      const value = await readBody(req);
      return await streamTurn(res, item, turnMatch[1], value.message);
    }
    const messagesMatch = req.url?.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (req.method === "GET" && messagesMatch) return json(res, 200, { messages: [] });
    return json(res, 404, { error: "not found" });
  } catch (error) {
    if (!res.headersSent) json(res, 503, { error: "ACP runtime unavailable" }); else res.end();
  }
});
server.listen(port, "0.0.0.0");
process.on("SIGTERM", () => { for (const item of sessions.values()) closeSession(item); server.close(() => process.exit(0)); });
