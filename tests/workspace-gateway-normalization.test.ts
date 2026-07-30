import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

const program = String.raw`
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True
os.environ.update({
    "ONECOMPUTER_GATEWAY_UPSTREAM": "http://127.0.0.1:4000",
    "ONECOMPUTER_GATEWAY_CREDENTIAL": "scoped-credential-at-least-24-characters",
    "ONECOMPUTER_MODEL_ALIAS": sys.argv[2],
    "ONECOMPUTER_CONTROL_UPSTREAM": "http://127.0.0.1:4173",
    "ONECOMPUTER_AGENT_BRIDGE_TOKEN": "bridge-token-at-least-24-characters",
    "ONECOMPUTER_GATEWAY_LISTEN_PORT": "4312",
})
spec = importlib.util.spec_from_file_location("onecomputer_gateway_proxy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
body, requested = module.normalize_inference_body(sys.argv[3].encode())
print(json.dumps({"requested": requested, "body": json.loads(body)}))
`;

const proxyPath = "docker/workspace/onecomputer-gateway-proxy.py";

const normalize = (assigned: string, payload: Record<string, unknown>) => JSON.parse(execFileSync(
  "python3",
  ["-c", program, proxyPath, assigned, JSON.stringify(payload)],
  { encoding: "utf8" },
)) as { requested: string; body: Record<string, unknown> };

test("the workspace broker binds Claude background model names to the assigned provider route", () => {
  const normalized = normalize("claude-sonnet-4-6", {
    model: "claude-sonnet-4-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "title" }],
    stream: true,
  });

  assert.equal(normalized.requested, "claude-sonnet-4-5");
  assert.equal(normalized.body.model, "claude-sonnet-4-6");
  assert.equal(normalized.body.max_tokens, 16);
  assert.equal(normalized.body.stream, true);
  assert.deepEqual(normalized.body.messages, [{ role: "user", content: "title" }]);
});

test("the same client request can be rebound to a non-Anthropic organization route", () => {
  assert.equal(
    normalize("claude-sonnet-4-5", { model: "claude-opus-4-8", messages: [] }).body.model,
    "claude-sonnet-4-5",
  );
  assert.equal(
    normalize("claude-opus-4-6", { model: "future-claude-client-name", messages: [] }).body.model,
    "claude-opus-4-6",
  );
});

test("the workspace broker rejects inference without a client model", () => {
  const result = spawnSync(
    "python3",
    ["-c", program, proxyPath, "claude-sonnet-4-6", JSON.stringify({ messages: [] })],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inference model is required/);
});

const availableBrokerPort = async () => {
  for (const port of [4312, 4314, 4315, 4316, 4317]) {
    const probe = createServer();
    const listening = new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!await listening) continue;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    return port;
  }
  throw new Error("no workspace broker test port is available");
};

test("the loopback broker forwards only the assigned model and scoped credential", async () => {
  let received: { url?: string; authorization?: string; apiKey?: string; body?: Record<string, unknown> } = {};
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"] as string | undefined,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const brokerPort = await availableBrokerPort();
  const child = spawn("python3", [proxyPath], {
    env: {
      ...process.env,
      ONECOMPUTER_GATEWAY_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      ONECOMPUTER_GATEWAY_CREDENTIAL: "scoped-credential-at-least-24-characters",
      ONECOMPUTER_MODEL_ALIAS: "claude-opus-4-6",
      ONECOMPUTER_CONTROL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      ONECOMPUTER_AGENT_BRIDGE_TOKEN: "bridge-token-at-least-24-characters",
      ONECOMPUTER_GATEWAY_LISTEN_PORT: String(brokerPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        ready = (await fetch(`http://127.0.0.1:${brokerPort}/healthz`)).ok;
        if (ready) break;
      } catch { /* broker is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ready, true, stderr);
    const response = await fetch(`http://127.0.0.1:${brokerPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-supplied-key" },
      body: JSON.stringify({ model: "do-not-log\nsecret-value", max_tokens: 1, messages: [] }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(received.url, "/v1/messages");
    assert.equal(received.authorization, "Bearer scoped-credential-at-least-24-characters");
    assert.equal(received.apiKey, undefined);
    assert.equal(received.body?.model, "claude-opus-4-6");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(stderr, /normalized model "<nonstandard>"/);
    assert.doesNotMatch(stderr, /secret-value/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
