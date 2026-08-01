#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
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
const sessionRoot = join(home, ".onecomputer", "acp-sessions");
const persistedSessionVersion = 1;
const maxPersistedSessionBytes = 32 * 1024 * 1024;
if (!(agent === "codex-cli" || agent === "opencode-cli") || apiKey.length < 32 || !model || !gateway || gatewayCredential.length < 32 || ![8644, 8645].includes(port)) {
  throw new Error("invalid ACP chat configuration");
}

const command = agent === "opencode-cli" ? "opencode" : "codex-acp";
const args = agent === "opencode-cli" ? ["acp"] : [];
const sessions = new Map();

const sessionFile = (id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("invalid session id");
  return join(sessionRoot, `${id}.json`);
};

const persistableSession = (id, item) => ({
  version: persistedSessionVersion,
  id,
  vendorSessionId: item.vendorSessionId,
  title: item.title ?? null,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  messages: item.messages,
});

const persistSession = async (id, item) => {
  const payload = persistableSession(id, item);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > maxPersistedSessionBytes) throw new Error("ACP session history exceeded its bounded storage limit");
  const integrity = createHmac("sha256", apiKey).update(body).digest("hex");
  const target = sessionFile(id);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify({ ...payload, integrity }), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
};

const parsePersistedSession = (value) => {
  if (!value || typeof value !== "object") return null;
  const item = value;
  if (item.version !== persistedSessionVersion || typeof item.id !== "string" || typeof item.vendorSessionId !== "string" || typeof item.integrity !== "string") return null;
  if (!Array.isArray(item.messages) || typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") return null;
  const payload = {
    version: item.version,
    id: item.id,
    vendorSessionId: item.vendorSessionId,
    title: item.title ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    messages: item.messages,
  };
  const expected = Buffer.from(createHmac("sha256", apiKey).update(JSON.stringify(payload)).digest("hex"));
  const actual = Buffer.from(item.integrity);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    sessionFile(item.id);
  } catch {
    return null;
  }
  return {
    id: item.id,
    vendorSessionId: item.vendorSessionId,
    title: typeof item.title === "string" ? item.title : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    messages: item.messages,
  };
};

const recoverInterruptedMessages = (messages) => {
  let changed = false;
  const recovered = messages.map((message) => {
    if (message?.role !== "assistant" || message?.metadata?.state !== "streaming") return message;
    changed = true;
    const turnId = typeof message.metadata.turnId === "string" ? message.metadata.turnId : `recovered-${randomUUID()}`;
    const parts = Array.isArray(message.parts)
      ? message.parts.map((part) => ({ ...part, ...(part && typeof part === "object" && "state" in part ? { state: "done" } : {}) }))
      : [];
    parts.push({ type: "data-terminal", id: `terminal-${turnId}`, data: { turnId, state: "failed", message: "The ACP process restarted before this turn completed" } });
    return { ...message, metadata: { ...message.metadata, state: "failed" }, parts };
  });
  return { messages: recovered, changed };
};

const loadPersistedSessions = async () => {
  await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
  await chmod(sessionRoot, 0o700);
  let names = [];
  try {
    names = await readdir(sessionRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = parsePersistedSession(JSON.parse(await readFile(join(sessionRoot, name), "utf8")));
      if (!record) continue;
      const recovered = recoverInterruptedMessages(record.messages);
      const item = { ...record, messages: recovered.messages, child: null, connection: null, session: null, active: false, diagnostics: [] };
      sessions.set(record.id, item);
      if (recovered.changed) await persistSession(record.id, item);
    } catch {
      // Corrupt history is not exposed as an empty or fabricated conversation.
    }
  }
};

class UpdateQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.failure = null;
  }

  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  fail(error) {
    this.failure = error;
    while (this.waiters.length) this.waiters.shift().reject(error);
  }

  next() {
    if (this.values.length) return Promise.resolve(this.values.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

const updateQueues = new Map();
const sessionHandle = (connection, vendorSessionId) => {
  const queue = new UpdateQueue();
  updateQueues.set(vendorSessionId, queue);
  return {
    sessionId: vendorSessionId,
    prompt: async (text) => {
      try {
        const response = await connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId: vendorSessionId,
          prompt: [{ type: "text", text }],
        });
        queue.push({ kind: "stop", stopReason: response.stopReason });
        return response;
      } catch (error) {
        queue.fail(error);
        throw error;
      }
    },
    nextUpdate: () => queue.next(),
    dispose: () => {
      updateQueues.delete(vendorSessionId);
      queue.fail(new Error("ACP session disposed"));
    },
  };
};

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

const startSession = async (persisted) => {
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
  let connection;
  try {
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const diagnostics = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostics.push(String(chunk).replace(/(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]").slice(-500)); });
  const application = acp.client({ name: "ONEComputer", version: "0.1.0" })
    .onRequest(acp.methods.client.session.requestPermission, async () => ({ outcome: { outcome: "cancelled" } }));
  application.onNotification(acp.methods.client.session.update, ({ params }) => {
    updateQueues.get(params.sessionId)?.push({ kind: "update", update: params.update });
  });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  connection = application.connect(stream);
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
  let vendorSessionId;
  if (persisted) {
    if (initialized.agentCapabilities?.loadSession !== true) throw new Error("ACP runtime cannot restore the persisted session");
    vendorSessionId = persisted.vendorSessionId;
    await connection.agent.loadSession({ cwd, mcpServers: [], sessionId: vendorSessionId });
  } else {
    const created = await connection.agent.newSession({ cwd, mcpServers: [] });
    vendorSessionId = created.sessionId;
  }
  return {
    child,
    connection,
    session: sessionHandle(connection, vendorSessionId),
    vendorSessionId,
    diagnostics,
    exited,
    messages: persisted?.messages ?? [],
    title: persisted?.title ?? null,
    active: false,
    createdAt: persisted?.createdAt ?? null,
    updatedAt: persisted?.updatedAt ?? null,
  };
  } catch (error) {
    connection?.close(error);
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
};

const closeSession = (item) => {
  item.session?.dispose();
  item.connection?.close();
  if (item.child && item.child.exitCode === null) item.child.kill("SIGTERM");
};

const ensureRuntime = async (item) => {
  if (item.session && item.connection && item.child && item.child.exitCode === null) return item;
  closeSession(item);
  const runtime = await startSession(item);
  Object.assign(item, runtime);
  return item;
};

const streamTurn = async (res, item, sessionId, message) => {
  if (item.active) return json(res, 409, { error: "turn already active" });
  if (!message || message.role !== "user" || !Array.isArray(message.parts)) return json(res, 400, { error: "invalid user message" });
  const text = message.parts.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("\n").trim();
  if (!text) return json(res, 400, { error: "ACP prompt is empty" });
  item.active = true;
  const turnId = `turn-${randomUUID()}`;
  let sequence = 0;
  let responseTextSize = 0;
  const emit = (type, values) => ({ version: 1, sequence: sequence++, sessionId, turnId, type, ...values });
  const createdAt = now();
  const assistant = { id: `msg-${randomUUID()}`, role: "assistant", metadata: { agentCatalogId: agent, turnId, state: "streaming", createdAt }, parts: [] };
  const terminalPart = (state, message) => ({ type: "data-terminal", id: `terminal-${turnId}`, data: { turnId, state, ...(message ? { message } : {}) } });
  item.messages.push(message);
  item.updatedAt = createdAt;
  try {
    await persistSession(sessionId, item);
  } catch (error) {
    item.messages.pop();
    throw error;
  }
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-onecomputer-chat-protocol": "1" });
  res.write(`${JSON.stringify(emit("turn-start", { messageId: assistant.id, createdAt }))}\n`);
  try {
    const prompt = item.session.prompt(text);
    for (;;) {
      const next = await Promise.race([item.session.nextUpdate(), item.exited.then(() => { throw new Error("ACP process exited during turn"); })]);
      if (next.kind === "stop") {
        await prompt;
        const state = next.stopReason === "end_turn" ? "completed" : next.stopReason === "cancelled" ? "cancelled" : "failed";
        assistant.metadata.state = state;
        assistant.parts = assistant.parts.map((part) => ({ ...part, state: "done" }));
        assistant.parts.push(terminalPart(state, state === "failed" ? "ACP turn stopped before completion" : undefined));
        item.messages.push(assistant);
        item.updatedAt = now();
        await persistSession(sessionId, item);
        res.write(`${JSON.stringify(emit("turn-finish", { state, completedAt: item.updatedAt }))}\n`);
        return;
      }
      const update = next.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        const delta = String(update.content.text).slice(0, 16_000);
        if (delta) {
          responseTextSize += delta.length;
          if (responseTextSize > 128_000) throw new Error("ACP response exceeded the canonical text limit");
          const textPart = assistant.parts.find((part) => part.type === "text");
          if (textPart) textPart.text += delta;
          else assistant.parts.push({ type: "text", text: delta, state: "streaming" });
          item.updatedAt = now();
          res.write(`${JSON.stringify(emit("text-delta", { textId: identifier("text", turnId), delta }))}\n`);
          await persistSession(sessionId, item);
        }
      } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const toolCallId = identifier("tool", update.toolCallId ?? "tool");
        const name = String(update.title ?? update.name ?? "ACP tool").replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 160) || "acp-tool";
        const state = update.status === "completed" ? "completed" : update.status === "failed" ? "failed" : "running";
        const summary = String(update.title ?? update.name ?? "ACP tool").slice(0, 500);
        const toolPart = assistant.parts.find((part) => part.type === "data-tool" && part.id === toolCallId);
        if (toolPart) toolPart.data = { ...toolPart.data, name, state, summary };
        else assistant.parts.push({ type: "data-tool", id: toolCallId, data: { toolCallId, name, state, summary } });
        item.updatedAt = now();
        res.write(`${JSON.stringify(emit("tool", { toolCallId, name, state, summary }))}\n`);
        await persistSession(sessionId, item);
      }
    }
  } catch (error) {
    assistant.metadata.state = "failed";
    assistant.parts = assistant.parts.map((part) => ({ ...part, state: "done" }));
    assistant.parts.push(terminalPart("failed", "The ACP harness could not complete the turn"));
    if (!item.messages.includes(assistant)) item.messages.push(assistant);
    item.updatedAt = now();
    await persistSession(sessionId, item);
    res.write(`${JSON.stringify(emit("error", { code: "ACP_TURN_FAILED", message: "The ACP harness could not complete the turn", retryable: true }))}\n`);
    res.write(`${JSON.stringify(emit("turn-finish", { state: "failed", completedAt: item.updatedAt }))}\n`);
  } finally {
    item.active = false;
    res.end();
  }
};

const server = createServer(async (req, res) => {
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
  try {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ready", agent, protocol: "onecomputer-chat-events/v1", transport: "acp" });
    if (req.method === "GET" && req.url === "/api/sessions") return json(res, 200, { sessions: [...sessions.entries()].map(([id, item]) => ({ id, title: item.title ?? null, created_at: item.createdAt, updated_at: item.updatedAt })), nextCursor: null });
    if (req.method === "POST" && req.url === "/api/sessions") {
      const id = randomUUID();
      const item = await startSession();
      item.createdAt = item.updatedAt = now();
      try {
        await persistSession(id, item);
      } catch (error) {
        closeSession(item);
        throw error;
      }
      sessions.set(id, item);
      return json(res, 201, { id, title: null, created_at: item.createdAt, updated_at: item.updatedAt });
    }
    const turnMatch = req.url?.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (req.method === "POST" && turnMatch) {
      const item = sessions.get(turnMatch[1]);
      if (!item) return json(res, 404, { error: "session not found" });
      await ensureRuntime(item);
      const value = await readBody(req);
      return await streamTurn(res, item, turnMatch[1], value.message);
    }
    const messagesMatch = req.url?.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (req.method === "GET" && messagesMatch) {
      const item = sessions.get(messagesMatch[1]);
      if (!item) return json(res, 404, { error: "session not found" });
      return json(res, 200, { messages: item.messages });
    }
    return json(res, 404, { error: "not found" });
  } catch (error) {
    if (!res.headersSent) json(res, 503, { error: "ACP runtime unavailable" }); else res.end();
  }
});
await loadPersistedSessions();
server.listen(port, "0.0.0.0");
process.on("SIGTERM", () => { for (const item of sessions.values()) closeSession(item); server.close(() => process.exit(0)); });
