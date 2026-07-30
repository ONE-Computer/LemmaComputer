import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  AcpHarnessSession,
  processEnvironment,
  redactAcpDiagnostic,
  resolveConfinedPath,
} from "@onecomputer/acp-adapter";
import type { AgentChatEvent } from "@onecomputer/contracts";

const fixture = fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url));
const sessionId = "session-acp-1";
const turnId = "turn-11111111-1111-4111-8111-111111111111";
const messageId = "message-11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const start = async (options: {
  environment?: Record<string, string>;
  permission?: Parameters<typeof AcpHarnessSession.start>[0]["permission"];
  readTextFile?: Parameters<typeof AcpHarnessSession.start>[0]["readTextFile"];
  writeTextFile?: Parameters<typeof AcpHarnessSession.start>[0]["writeTextFile"];
  stderr?: Parameters<typeof AcpHarnessSession.start>[0]["stderr"];
  setup?: (cwd: string) => Promise<void>;
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
} = {}) => {
  const cwd = await mkdtemp(join(tmpdir(), "onecomputer-acp-"));
  temporaryDirectories.push(cwd);
  await options.setup?.(cwd);
  return AcpHarnessSession.start({
    command: process.execPath,
    args: [fixture],
    cwd,
    agentCatalogId: "codex-cli",
    environment: options.environment,
    permission: options.permission,
    readTextFile: options.readTextFile,
    writeTextFile: options.writeTextFile,
    stderr: options.stderr,
    startupTimeoutMs: options.startupTimeoutMs,
    turnTimeoutMs: options.turnTimeoutMs,
  });
};

const collect = async (session: AcpHarnessSession, prompt: string, signal?: AbortSignal) => {
  const events: AgentChatEvent[] = [];
  for await (const event of session.streamTurn({ sessionId, turnId, messageId, prompt, signal })) {
    events.push(event);
  }
  return events;
};

test("ACP v1 negotiates capabilities and produces one canonical ordered stream", async () => {
  const session = await start();
  try {
    assert.equal(session.runtime.transport, "acp");
    assert.equal(session.runtime.protocolVersion, "1");
    assert.equal(session.runtime.capabilities.loadSession, true);
    assert.equal(session.runtime.capabilities.resumeSession, true);
    assert.equal(session.runtime.capabilities.cancelTurn, true);
    assert.equal(session.runtime.capabilities.mcp, true);

    const events = await collect(session, "run the conformance turn");
    assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index));
    assert.equal(events[0]?.type, "turn-start");
    assert.equal(events.at(-1)?.type, "turn-finish");
    assert.equal(events.at(-1)?.type === "turn-finish" && events.at(-1)?.state, "completed");
    assert.ok(events.some((event) => event.type === "plan"));
    assert.ok(events.some((event) => event.type === "tool" && event.state === "completed"));
    assert.ok(events.some((event) => event.type === "notice" && event.message.includes("denied")));
    assert.equal(events.filter((event) => event.type === "text-delta").map((event) => (
      event.type === "text-delta" ? event.delta : ""
    )).join(""), "The ACP turn completed. Permission denied.");
    assert.equal(JSON.stringify(events).includes("hidden-reasoning"), false);
    assert.equal(JSON.stringify(events).includes("fixture-secret"), false);
  } finally {
    session.close();
  }
});

test("ACP permission selection requires and emits a governed operation", async () => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const session = await start({
    permission: async () => ({
      outcome: "selected",
      optionId: "allow-once",
      operationId,
      approvalId: "fixture-approval",
      summary: "Approved through the exact ONEComputer operation",
    }),
  });
  try {
    const events = await collect(session, "run with governed approval");
    const approval = events.find((event) => event.type === "approval");
    assert.ok(approval && approval.type === "approval");
    assert.equal(approval.operationId, operationId);
    assert.equal(approval.state, "approved");
    assert.equal(JSON.stringify(events).includes("Permission governed."), true);
  } finally {
    session.close();
  }
});

test("ACP cancellation sends session/cancel and terminates the canonical turn", async () => {
  const session = await start();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  try {
    const events = await collect(session, "wait-for-cancel", controller.signal);
    const terminal = events.at(-1);
    assert.ok(terminal?.type === "turn-finish");
    assert.equal(terminal.state, "cancelled");
  } finally {
    session.close();
  }
});

test("ACP rejects an unsupported negotiated protocol version", async () => {
  await assert.rejects(
    start({ environment: { ONECOMPUTER_ACP_FIXTURE_PROTOCOL: "999" } }),
    /Unsupported ACP protocol version/,
  );
});

test("ACP does not inherit host secrets but accepts explicit harness environment", async () => {
  process.env.ONECOMPUTER_ACP_HOST_SECRET = "must-not-cross-boundary";
  try {
    assert.equal(processEnvironment().ONECOMPUTER_ACP_HOST_SECRET, undefined);
    const session = await start({ environment: { ONECOMPUTER_ACP_EXPLICIT: "governed-value" } });
    try {
      const events = await collect(session, "environment-check");
      const text = events.flatMap((event) => event.type === "text-delta" ? [event.delta] : []).join("");
      assert.equal(text, "host-secret-missing:governed-value");
    } finally {
      session.close();
    }
  } finally {
    delete process.env.ONECOMPUTER_ACP_HOST_SECRET;
  }
});

test("ACP fails boundedly when the harness exits before initialization", async () => {
  await assert.rejects(
    start({ environment: { ONECOMPUTER_ACP_FIXTURE_MODE: "exit-before-initialize" } }),
    /ACP (?:connection closed|harness exited before the protocol session closed)/,
  );
});

test("ACP startup and turn timeouts fail boundedly", async () => {
  await assert.rejects(
    start({
      environment: { ONECOMPUTER_ACP_FIXTURE_MODE: "hang-initialize" },
      startupTimeoutMs: 50,
    }),
    /initialization timed out/,
  );

  const session = await start({ turnTimeoutMs: 50 });
  try {
    const events = await collect(session, "wait-for-cancel");
    assert.ok(events.some((event) => event.type === "error" && event.code === "ACP_TURN_TIMEOUT"));
    assert.equal(events.at(-1)?.type === "turn-finish" && events.at(-1)?.state, "cancelled");
  } finally {
    session.close();
  }
});

test("ACP converts an abrupt harness exit into a canonical failed turn", async () => {
  const session = await start();
  try {
    const events = await collect(session, "exit-during-turn");
    assert.ok(events.some((event) => event.type === "error" && event.code === "ACP_TURN_FAILED"));
    assert.equal(events.at(-1)?.type === "turn-finish" && events.at(-1)?.state, "failed");
  } finally {
    session.close();
  }
});

test("ACP rejects concurrent turns on one protocol session", async () => {
  const session = await start();
  const controller = new AbortController();
  try {
    const first = session.streamTurn({
      sessionId,
      turnId,
      messageId,
      prompt: "wait-for-cancel",
      signal: controller.signal,
    });
    await first.next();
    const second = session.streamTurn({
      sessionId,
      turnId: "turn-22222222-2222-4222-8222-222222222222",
      messageId: "message-22222222-2222-4222-8222-222222222222",
      prompt: "must not run concurrently",
    });
    await assert.rejects(second.next(), /already has an active turn/);
    controller.abort();
    for await (const _event of first) {
      // Drain the cancellation terminal events.
    }
  } finally {
    session.close();
  }
});

test("ACP keeps long streaming turns ordered without accumulating abort listeners", async () => {
  const session = await start();
  const warnings: Error[] = [];
  const receiveWarning = (warning: Error) => {
    if (warning.name === "MaxListenersExceededWarning" && warning.message.includes("AbortSignal")) {
      warnings.push(warning);
    }
  };
  process.on("warning", receiveWarning);
  try {
    const events = await collect(session, "many-updates");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.filter((event) => event.type === "text-delta").length, 32);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index));
    assert.deepEqual(warnings, []);
  } finally {
    process.off("warning", receiveWarning);
    session.close();
  }
});

test("ACP filesystem callbacks are capability-advertised, delegated, and path-confined", async () => {
  const reads: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const session = await start({
    readTextFile: async (request) => {
      reads.push(request.path);
      return "governed-content";
    },
    writeTextFile: async (request) => {
      writes.push({ path: request.path, content: request.content });
    },
  });
  try {
    assert.equal(session.runtime.capabilities.fsReadTextFile, true);
    assert.equal(session.runtime.capabilities.fsWriteTextFile, true);
    const events = await collect(session, "filesystem-check");
    assert.equal(reads.length, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.path, reads[0]);
    assert.equal(writes[0]?.content, "governed-content:updated");
    assert.equal(events.filter((event) => event.type === "text-delta").map((event) => (
      event.type === "text-delta" ? event.delta : ""
    )).join(""), "governed-content");

    const escaped = await collect(session, "filesystem-escape");
    assert.equal(reads.length, 1);
    assert.equal(escaped.some((event) => event.type === "text-delta" && event.delta === "escape-denied"), true);
  } finally {
    session.close();
  }
});

test("ACP filesystem confinement rejects symbolic-link escapes before delegation", async () => {
  const outside = await mkdtemp(join(tmpdir(), "onecomputer-acp-outside-"));
  temporaryDirectories.push(outside);
  let callbackCalls = 0;
  let symlinkPath = "";
  const session = await start({
    environment: {
      get ONECOMPUTER_ACP_FIXTURE_SYMLINK_PATH() {
        return `${symlinkPath}/secret.txt`;
      },
    },
    setup: async (cwd) => {
      symlinkPath = join(cwd, "outside-link");
      await symlink(outside, symlinkPath);
    },
    readTextFile: async () => {
      callbackCalls += 1;
      return "must-not-be-read";
    },
  });
  try {
    const events = await collect(session, "filesystem-symlink");
    assert.equal(callbackCalls, 0);
    assert.equal(events.some((event) => (
      event.type === "text-delta" && event.delta === "symlink-escape-denied"
    )), true);
  } finally {
    session.close();
  }
});

test("ACP rejects invalid permission selections and oversized canonical text boundedly", async () => {
  const invalidPermission = await start({
    permission: async () => ({
      outcome: "selected",
      optionId: "not-offered",
      operationId: "11111111-1111-4111-8111-111111111111",
      approvalId: "invalid-selection",
      summary: "must fail closed",
    }),
  });
  try {
    const events = await collect(invalidPermission, "permission option validation");
    assert.ok(events.some((event) => event.type === "error" && event.code === "ACP_TURN_FAILED"));
    assert.equal(events.at(-1)?.type === "turn-finish" && events.at(-1)?.state, "failed");
  } finally {
    invalidPermission.close();
  }

  const oversized = await start();
  try {
    const events = await collect(oversized, "oversized-text");
    assert.ok(events.some((event) => event.type === "error" && event.code === "ACP_TURN_FAILED"));
    assert.equal(events.at(-1)?.type === "turn-finish" && events.at(-1)?.state, "failed");
  } finally {
    oversized.close();
  }
});

test("ACP rejects malformed transport, empty prompts, and turns after close", async () => {
  await assert.rejects(
    start({ environment: { ONECOMPUTER_ACP_FIXTURE_MODE: "invalid-ndjson" } }),
    /ACP (?:connection closed|harness exited before the protocol session closed)|JSON/,
  );

  const session = await start();
  try {
    await assert.rejects(collect(session, "   "), /prompt is empty/);
    const emptyBlocks = session.streamTurn({ sessionId, turnId, messageId, prompt: [] });
    await assert.rejects(emptyBlocks.next(), /prompt is empty/);
    session.close();
    await assert.rejects(collect(session, "after close"), /session is closed/);
  } finally {
    session.close();
  }
});

test("ACP stderr diagnostics are delivered only after secret redaction", async () => {
  const diagnostics: string[] = [];
  const session = await start({ stderr: (diagnostic) => diagnostics.push(diagnostic) });
  try {
    await collect(session, "stderr-check");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(diagnostics, [
      "Authorization [REDACTED_AUTH]",
      "callback?access_token=[REDACTED]",
    ]);
    assert.equal(JSON.stringify(diagnostics).includes("fixture-secret-token"), false);
    assert.equal(JSON.stringify(diagnostics).includes("fixture-access-token"), false);
  } finally {
    session.close();
  }
});

test("ACP path confinement and diagnostic redaction fail closed", () => {
  assert.equal(resolveConfinedPath("/workspace/project", "src/index.ts"), "/workspace/project/src/index.ts");
  assert.throws(() => resolveConfinedPath("/workspace/project", "../secret.txt"), /escapes/);
  assert.equal(redactAcpDiagnostic("Authorization Bearer abc.def.secret"), "Authorization [REDACTED_AUTH]");
  assert.equal(
    redactAcpDiagnostic("failed https://example.test/callback?access_token=secret-value"),
    "failed https://example.test/callback?access_token=[REDACTED]",
  );
});
