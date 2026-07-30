import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  AcpHarnessSession,
  officialAcpHarnessConfiguration,
} from "@onecomputer/acp-adapter";
import type { AgentChatEvent } from "@onecomputer/contracts";

const gatewayKey = process.env.LITELLM_MASTER_KEY?.trim();
if (!gatewayKey) throw new Error("LITELLM_MASTER_KEY is required");

const home = await mkdtemp(resolve(tmpdir(), "onecomputer-codex-acp-"));
const cwd = resolve(home, "workspace");
const diagnostics: string[] = [];
let session: AcpHarnessSession | undefined;

try {
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(resolve(home, ".codex-cli"), { recursive: true }),
  ]);
  session = await AcpHarnessSession.start({
    ...officialAcpHarnessConfiguration({
      agentCatalogId: "codex-cli",
      cwd,
      home,
      runtimeRoot: resolve("docker/workspace/acp-runtime"),
      model: process.env.ONECOMPUTER_ACP_QUALIFICATION_MODEL ?? "kimi-for-coding",
      gateway: {
        baseUrl: process.env.ONECOMPUTER_ACP_QUALIFICATION_GATEWAY ?? "http://127.0.0.1:4100/v1",
        headers: { authorization: `Bearer ${gatewayKey}` },
      },
    }),
    startupTimeoutMs: 30_000,
    turnTimeoutMs: 180_000,
    stderr: (diagnostic) => diagnostics.push(diagnostic),
  });

  const events: AgentChatEvent[] = [];
  for await (const event of session.streamTurn({
    sessionId: "session-codex-acp-qualification",
    turnId: "turn-11111111-1111-4111-8111-111111111111",
    messageId: "message-11111111-1111-4111-8111-111111111111",
    prompt: "Reply with ACP_REAL_ROUTE_OK and no tool calls.",
  })) {
    events.push(event);
  }

  const text = events.flatMap((event) => event.type === "text-delta" ? [event.delta] : []).join("");
  if (!text.includes("ACP_REAL_ROUTE_OK")) {
    throw new Error(`Codex ACP qualification marker missing: ${text.slice(0, 500)}`);
  }
  assert.equal(events.at(-1)?.type === "turn-finish" && events.at(-1)?.state, "completed");
  assert.equal(JSON.stringify(events).includes(gatewayKey), false);
  assert.equal(JSON.stringify(diagnostics).includes(gatewayKey), false);
  console.log(JSON.stringify({
    runtime: session.runtime.implementation,
    protocolVersion: session.runtime.protocolVersion,
    eventCount: events.length,
    terminalState: events.at(-1)?.type === "turn-finish" ? events.at(-1).state : null,
    markerObserved: text.includes("ACP_REAL_ROUTE_OK"),
    diagnosticCount: diagnostics.length,
  }));
} finally {
  session?.close();
  await rm(home, { recursive: true, force: true });
}
