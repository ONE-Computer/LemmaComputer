import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { AcpHarnessSession, officialAcpHarnessConfiguration } from "@onecomputer/acp-adapter";

const gatewayKey = process.env.LITELLM_MASTER_KEY?.trim();
if (!gatewayKey) throw new Error("LITELLM_MASTER_KEY is required");
const home = await mkdtemp(resolve(tmpdir(), "onecomputer-opencode-acp-"));
const cwd = resolve(home, "workspace");
let session: AcpHarnessSession | undefined;
try {
  await mkdir(cwd, { recursive: true });
  session = await AcpHarnessSession.start({
    ...officialAcpHarnessConfiguration({
      agentCatalogId: "opencode-cli",
      cwd,
      home,
      runtimeRoot: resolve("docker/workspace/acp-runtime"),
      gateway: {
        baseUrl: process.env.ONECOMPUTER_ACP_QUALIFICATION_GATEWAY ?? "http://127.0.0.1:4100/v1",
        headers: { authorization: `Bearer ${gatewayKey}` },
      },
    }),
    startupTimeoutMs: 30_000,
    turnTimeoutMs: 180_000,
  });
  const events = [];
  for await (const event of session.streamTurn({
    sessionId: "session-opencode-acp-qualification",
    turnId: "turn-22222222-2222-4222-8222-222222222222",
    messageId: "message-22222222-2222-4222-8222-222222222222",
    prompt: "Reply with ACP_OPENCODE_REAL_ROUTE_OK and no tool calls.",
  })) events.push(event);
  const text = events.flatMap((event) => event.type === "text-delta" ? [event.delta] : []).join("");
  if (!text.includes("ACP_OPENCODE_REAL_ROUTE_OK")) throw new Error(`OpenCode ACP qualification marker missing: ${text.slice(0, 500)}`);
  assert.equal(events.at(-1)?.type === "turn-finish" && events.at(-1)?.state, "completed");
  assert.equal(JSON.stringify(events).includes(gatewayKey), false);
  console.log(JSON.stringify({ runtime: session.runtime.implementation, protocolVersion: session.runtime.protocolVersion, eventCount: events.length, terminalState: "completed", markerObserved: true }));
} finally {
  session?.close();
  await rm(home, { recursive: true, force: true });
}
