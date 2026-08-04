import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

const program = String.raw`
import base64
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True
bridge_payload = base64.urlsafe_b64encode(json.dumps({"exp": 4102444800}).encode()).decode().rstrip("=")
os.environ.update({
    "LEMMACOMPUTER_GATEWAY_UPSTREAM": "http://127.0.0.1:4000",
    "LEMMACOMPUTER_GATEWAY_CREDENTIAL": "scoped-credential-at-least-24-characters",
    "LEMMACOMPUTER_MODEL_ALIAS": sys.argv[2],
    "LEMMACOMPUTER_CONTROL_UPSTREAM": "http://127.0.0.1:4173",
    "LEMMACOMPUTER_AGENT_BRIDGE_TOKEN": f"ocab2_{bridge_payload}.{'s' * 43}",
    "LEMMACOMPUTER_GATEWAY_LISTEN_PORT": "4312",
})
spec = importlib.util.spec_from_file_location("lemmacomputer_gateway_proxy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
task_binding = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "-" else None
body, requested = module.normalize_inference_body(sys.argv[3].encode(), task_binding)
print(json.dumps({"requested": requested, "body": json.loads(body)}))
`;

const proxyPath = "docker/workspace/lemmacomputer-gateway-proxy.py";

test("the packaged workspace gateway proxy compiles", () => {
  execFileSync("python3", ["-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(), filename=sys.argv[1], feature_version=(3, 10))", proxyPath]);
});

const normalize = (assigned: string, payload: Record<string, unknown>, taskBinding?: string) => JSON.parse(execFileSync(
  "python3",
  ["-c", program, proxyPath, assigned, JSON.stringify(payload), taskBinding ?? "-"],
  { encoding: "utf8" },
)) as { requested: string; body: Record<string, unknown> };

const taskBinding = (requestedServiceClass: "auto"|"lite"|"balanced"|"pro" = "auto") => `${Buffer.from(JSON.stringify({
  schemaVersion: 1,
  requestedServiceClass,
})).toString("base64url")}.${"s".repeat(43)}`;

const bridgeGrant = (expiresAt: number) => `ocab2_${Buffer.from(JSON.stringify({ exp: expiresAt })).toString("base64url")}.${"s".repeat(43)}`;

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

test("only the broker-owned task binding crosses the workspace trust boundary", () => {
  const binding = taskBinding("pro");
  const normalized = normalize("balanced", {
    model: "client-default",
    user_api_key_dict: { metadata: { lemmacomputer_tenant_id: "foreign-tenant" } },
    litellm_model_info: { lemmacomputer_deployment_id: "foreign-deployment" },
    lemmacomputer_usage_chain: "client-forged-chain",
    metadata: {
      customer_tag: "preserved",
      lemmacomputer_task_binding: "client-forged-binding",
      lemmacomputer_usage_state: { admissionId: "client-forged-admission" },
      user_api_key_metadata: { lemmacomputer_tenant_id: "foreign-tenant" },
      model_info: { lemmacomputer_deployment_id: "foreign-deployment" },
      requester_metadata: { lemmacomputer_task_binding: "client-forged-binding" },
    },
  }, binding);

  assert.equal(normalized.body.model, "balanced");
  assert.equal("user_api_key_dict" in normalized.body, false);
  assert.equal("litellm_model_info" in normalized.body, false);
  assert.equal("lemmacomputer_usage_chain" in normalized.body, false);
  assert.deepEqual(normalized.body.metadata, {
    customer_tag: "preserved",
    lemmacomputer_task_binding: binding,
    lemmacomputer_requested_service_class: "pro",
  });
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

test("the loopback broker forwards only the assigned model, scoped credential, and broker-owned task binding", async () => {
  let bindingRequests = 0;
  let renewalRequests = 0;
  const initialBridgeGrant = bridgeGrant(Math.floor(Date.now() / 1_000) + 1);
  const renewedBridgeGrant = bridgeGrant(Math.floor(Date.now() / 1_000) + 900);
  let received: {
    url?: string;
    authorization?: string;
    apiKey?: string;
    taskBindingHeader?: string;
    litellmCallId?: string;
    body?: Record<string, unknown>;
  } = {};
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === "/internal/v1/agent/grants/renew") {
      renewalRequests += 1;
      assert.equal(request.headers.authorization, `Bearer ${initialBridgeGrant}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ token: renewedBridgeGrant }));
      return;
    }
    if (request.url === "/internal/v1/agent/usage-bindings") {
      bindingRequests += 1;
      assert.equal(request.headers.authorization, `Bearer ${renewedBridgeGrant}`);
      const bindingRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(bindingRequest.requestedServiceClass, "lite");
      assert.match(bindingRequest.taskId, /^workspace-native:/);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ binding: taskBinding("lite") }));
      return;
    }
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"] as string | undefined,
      taskBindingHeader: request.headers["x-lemmacomputer-ai-task-binding"] as string | undefined,
      litellmCallId: request.headers["x-litellm-call-id"] as string | undefined,
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
      LEMMACOMPUTER_GATEWAY_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      LEMMACOMPUTER_GATEWAY_CREDENTIAL: "scoped-credential-at-least-24-characters",
      LEMMACOMPUTER_MODEL_ALIAS: "claude-sonnet-4-6",
      LEMMACOMPUTER_TRANSPORT_MODEL_ALIAS: "lemmacomputer-auto",
      LEMMACOMPUTER_REQUESTED_SERVICE_CLASS: "lite",
      LEMMACOMPUTER_CONTROL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      LEMMACOMPUTER_AGENT_BRIDGE_TOKEN: initialBridgeGrant,
      LEMMACOMPUTER_GATEWAY_LISTEN_PORT: String(brokerPort),
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
      headers: {
        "content-type": "application/json",
        "x-api-key": "client-supplied-key",
        "x-litellm-call-id": "client-supplied-call-id",
      },
      body: JSON.stringify({
        model: "do-not-log\nsecret-value",
        max_tokens: 1,
        messages: [],
        metadata: {
          customer_tag: "preserved",
          lemmacomputer_task_binding: "client-forged-binding",
          user_api_key_metadata: { lemmacomputer_tenant_id: "foreign-tenant" },
        },
      }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(renewalRequests, 1, "a near-expiry bridge grant is renewed before a Control request");
    assert.equal(bindingRequests, 1);
    assert.equal(received.url, "/v1/messages");
    assert.equal(received.authorization, "Bearer scoped-credential-at-least-24-characters");
    assert.equal(received.apiKey, undefined);
    assert.equal(received.taskBindingHeader, undefined);
    assert.equal(received.litellmCallId, undefined);
    assert.equal(received.body?.model, "lemmacomputer-auto");
    assert.deepEqual(received.body?.metadata, {
      customer_tag: "preserved",
      lemmacomputer_task_binding: taskBinding("lite"),
      lemmacomputer_requested_service_class: "lite",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(stderr, /normalized model "<nonstandard>"/);
    assert.doesNotMatch(stderr, /secret-value/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
