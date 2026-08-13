import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
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
    "LEMMACOMPUTER_TRANSPORT_MODEL_ALIAS": sys.argv[2],
    "LEMMACOMPUTER_REQUESTED_SERVICE_CLASS": sys.argv[5] if len(sys.argv) > 5 else "balanced",
    "LEMMACOMPUTER_CONTROL_UPSTREAM": "http://127.0.0.1:4173",
    "LEMMACOMPUTER_AGENT_BRIDGE_TOKEN": f"ocab2_{bridge_payload}.{'s' * 43}",
    "LEMMACOMPUTER_GATEWAY_LISTEN_PORT": "4312",
})
spec = importlib.util.spec_from_file_location("lemmacomputer_gateway_proxy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
task_binding = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "-" else None
body, requested = module.normalize_inference_body(sys.argv[3].encode(), task_binding)
print(json.dumps({"requested": requested, "body": json.loads(body), "serviceClass": module.native_service_class_for_model(requested)}))
`;

const proxyPath = "docker/workspace/lemmacomputer-gateway-proxy.py";

test("the packaged workspace gateway proxy compiles", () => {
  execFileSync("python3", ["-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(), filename=sys.argv[1], feature_version=(3, 10))", proxyPath]);
});

const normalize = (assigned: string, payload: Record<string, unknown>, taskBinding?: string, serviceClass = "balanced") => JSON.parse(execFileSync(
  "python3",
  ["-c", program, proxyPath, assigned, JSON.stringify(payload), taskBinding ?? "-", serviceClass],
  { encoding: "utf8" },
)) as { requested: string; body: Record<string, unknown>; serviceClass: string };

const taskBinding = (
  requestedServiceClass: "auto"|"lite"|"balanced"|"pro" = "auto",
  requestedReasoningEffort?: "auto"|"low"|"medium"|"high",
) => `${Buffer.from(JSON.stringify({
  schemaVersion: 1,
  requestedServiceClass,
  ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}),
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

test("the workspace broker makes Claude Desktop's one-token gateway health probe portable across governed routes", () => {
  const normalized = normalize("lemmacomputer-auto", {
    model: "claude-sonnet-4-6",
    max_tokens: 1,
    messages: [{ role: "user", content: "." }],
  });

  assert.equal(normalized.body.model, "lemmacomputer-auto");
  assert.equal(normalized.body.max_tokens, 16);

  const ordinaryRequest = normalize("lemmacomputer-auto", {
    model: "claude-sonnet-4-6",
    max_tokens: 1,
    messages: [{ role: "user", content: "Reply with one character." }],
  });
  assert.equal(ordinaryRequest.body.max_tokens, 1);
});

test("native product model aliases select only explicit governed service classes", () => {
  for (const serviceClass of ["lite", "balanced", "pro"] as const) {
    const normalized = normalize("lemmacomputer-auto", {
      model: `lemmacomputer-${serviceClass}`,
      messages: [{ role: "user", content: "Use this mode." }],
    });
    assert.equal(normalized.serviceClass, serviceClass);
    assert.equal(normalized.body.model, "lemmacomputer-auto");
  }

  for (const [model, serviceClass] of [
    ["claude-sonnet-4-6-20260101", "lite"],
    ["claude-sonnet-4-6-20260102", "balanced"],
    ["claude-sonnet-4-6-20260103", "pro"],
  ] as const) {
    assert.equal(normalize("lemmacomputer-auto", {
      model,
      messages: [{ role: "user", content: "Use this Claude mode." }],
    }).serviceClass, serviceClass);
  }

  const rejected = spawnSync(
    "python3",
    ["-c", program, proxyPath, "lemmacomputer-auto", JSON.stringify({ model: "lemmacomputer-ultimate", messages: [] })],
    { encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /model mode is not assigned/);

  assert.equal(normalize("lemmacomputer-auto", {
    model: "claude-sonnet-4-6",
    messages: [],
  }, undefined, "auto").serviceClass, "balanced", "legacy Auto workspace defaults migrate safely to Balanced");
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

test("the broker strips forged thinking controls and projects only the signed effort request", () => {
  const binding = taskBinding("balanced", "medium");
  const normalized = normalize("lemmacomputer-auto", {
    model: "claude-sonnet-4-6",
    think: true,
    thinking: { type: "enabled", budget_tokens: 999999 },
    output_config: { effort: "max" },
    reasoning_effort: "max",
    reasoning: { effort: "xhigh" },
    messages: [{ role: "user", content: "Review this plan." }],
  }, binding);
  assert.equal("think" in normalized.body, false);
  assert.equal("thinking" in normalized.body, false);
  assert.equal("output_config" in normalized.body, false);
  assert.equal("reasoning_effort" in normalized.body, false);
  assert.equal("reasoning" in normalized.body, false);
  assert.deepEqual(normalized.body.metadata, {
    lemmacomputer_task_binding: binding,
    lemmacomputer_requested_service_class: "balanced",
    lemmacomputer_requested_reasoning_effort: "medium",
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
  const agentInstanceId = "11111111-1111-4111-8111-111111111111";
  const initialBridgeGrant = bridgeGrant(Math.floor(Date.now() / 1_000) + 1);
  const renewedBridgeGrant = bridgeGrant(Math.floor(Date.now() / 1_000) + 900);
  const received: Array<{
    url?: string;
    authorization?: string;
    apiKey?: string;
    taskBindingHeader?: string;
    litellmCallId?: string;
    body?: Record<string, unknown>;
  }> = [];
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
    if (request.url === "/internal/v1/agent/instances") {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
        launchNonce: "22222222-2222-4222-8222-222222222222",
      });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ agentInstanceId }));
      return;
    }
    if (request.url === `/internal/v1/agent/instances/${agentInstanceId}/running`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agentInstanceId, status: "running" }));
      return;
    }
    if (request.url === `/internal/v1/agent/instances/${agentInstanceId}/end`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agentInstanceId, status: "completed" }));
      return;
    }
    if (request.url === "/internal/v1/agent/usage-bindings") {
      if (request.headers["x-lemmacomputer-agent-instance-id"] !== agentInstanceId) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "AGENT_INSTANCE_INVALID" } }));
        return;
      }
      bindingRequests += 1;
      assert.equal(request.headers.authorization, `Bearer ${renewedBridgeGrant}`);
      assert.equal(request.headers["x-lemmacomputer-agent-instance-id"], agentInstanceId);
      const bindingRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(["lite", "balanced", "pro"].includes(bindingRequest.requestedServiceClass));
      assert.match(bindingRequest.taskId, /^workspace-native:/);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ binding: taskBinding(bindingRequest.requestedServiceClass) }));
      return;
    }
    received.push({
      url: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"] as string | undefined,
      taskBindingHeader: request.headers["x-lemmacomputer-ai-task-binding"] as string | undefined,
      litellmCallId: request.headers["x-litellm-call-id"] as string | undefined,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
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
      LEMMACOMPUTER_INFER_SINGLE_ACTIVE_AGENT_INSTANCE: "1",
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
    const modelsResponse = await fetch(`http://127.0.0.1:${brokerPort}/v1/models`);
    const modelsDocument = await modelsResponse.json();
    assert.equal(modelsResponse.status, 200, JSON.stringify(modelsDocument));
    assert.deepEqual(modelsDocument.data.map((model: { id: string }) => model.id), [
      "lemmacomputer-lite",
      "lemmacomputer-balanced",
      "lemmacomputer-pro",
    ]);
    for (let attempt = 0; attempt < 100 && renewalRequests === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(renewalRequests, 1, "the broker renews a near-expiry grant without waiting for agent traffic");
    const created = await fetch(`http://127.0.0.1:${brokerPort}/lemmacomputer/agent-instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ launchNonce: "22222222-2222-4222-8222-222222222222" }),
    });
    assert.equal(created.status, 201, await created.text());
    const running = await fetch(`http://127.0.0.1:${brokerPort}/lemmacomputer/agent-instances/${agentInstanceId}/running`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerRuntimeId: "workspace-pid:123" }),
    });
    assert.equal(running.status, 200, await running.text());
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
    assert.equal(renewalRequests, 1, "the proactive renewal is reused for the Control request");
    assert.equal(bindingRequests, 1);
    assert.equal(received[0]?.url, "/v1/messages");
    assert.equal(received[0]?.authorization, "Bearer scoped-credential-at-least-24-characters");
    assert.equal(received[0]?.apiKey, undefined);
    assert.equal(received[0]?.taskBindingHeader, undefined);
    assert.equal(received[0]?.litellmCallId, undefined);
    assert.equal(received[0]?.body?.model, "lemmacomputer-auto");
    assert.deepEqual(received[0]?.body?.metadata, {
      customer_tag: "preserved",
      lemmacomputer_task_binding: taskBinding("lite"),
      lemmacomputer_requested_service_class: "lite",
    });
    const proResponse = await fetch(`http://127.0.0.1:${brokerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "lemmacomputer-pro",
        messages: [{ role: "user", content: "Use the selected product mode." }],
      }),
    });
    assert.equal(proResponse.status, 200, await proResponse.text());
    assert.equal(bindingRequests, 2);
    assert.equal(received[1]?.body?.model, "lemmacomputer-auto");
    assert.deepEqual(received[1]?.body?.metadata, {
      lemmacomputer_task_binding: taskBinding("pro"),
      lemmacomputer_requested_service_class: "pro",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(stderr, /normalized model "<nonstandard>"/);
    assert.doesNotMatch(stderr, /secret-value/);
    const ended = await fetch(`http://127.0.0.1:${brokerPort}/lemmacomputer/agent-instances/${agentInstanceId}/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "process_exited" }),
    });
    assert.equal(ended.status, 200, await ended.text());
    const afterEnd = await fetch(`http://127.0.0.1:${brokerPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "client-default", max_tokens: 1, messages: [] }),
    });
    assert.equal(afterEnd.status, 400, "headerless inference fails closed after the process identity ends");
    assert.equal(bindingRequests, 2);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("the workspace broker isolates failed and slow connector discovery and represents zero connected servers safely", async () => {
  const agentInstanceId = "33333333-3333-4333-8333-333333333333";
  let activeServers = ["lemmacomputer_ms365", "lemmacomputer_slow", "lemmacomputer_exa"];
  let projectionHash = "a".repeat(64);
  const discoveryRequests: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolInvocationIds: string[] = [];
  const toolTerminals: Array<Record<string, unknown>> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.url === "/internal/v1/agent/tool-audit/terminal") {
      assert.equal(request.headers["x-lemmacomputer-agent-instance-id"], agentInstanceId);
      toolTerminals.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.statusCode = 201;
      response.end(JSON.stringify({ status: "created" }));
      return;
    }
    if (request.url === "/internal/v1/agent/mcp-discovery-plan") {
      response.end(JSON.stringify({ servers: activeServers, projectionHash }));
      return;
    }
    if (request.url?.startsWith("/mcp-rest/tools/list?")) {
      discoveryRequests.push(request.url);
      const serverName = new URL(request.url, "http://fixture").searchParams.get("mcp_server_name");
      if (serverName === "lemmacomputer_ms365") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "secret-oauth-token-must-not-be-logged" }));
        return;
      }
      if (serverName === "lemmacomputer_slow") {
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        response.end(JSON.stringify({ tools: [] }));
        return;
      }
      response.end(JSON.stringify({
        tools: [{
          name: "web_search",
          description: "Search with Exa",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          mcp_info: { server_id: "exa-server-id", server_name: "lemmacomputer_exa" },
        }],
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      toolCalls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      toolInvocationIds.push(String(request.headers["x-lemmacomputer-tool-invocation-id"]));
      response.end(JSON.stringify({ content: [{ type: "text", text: "Exa result" }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const brokerPort = await availableBrokerPort();
  const child = spawn("python3", [proxyPath], {
    env: {
      ...process.env,
      LEMMACOMPUTER_GATEWAY_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      LEMMACOMPUTER_GATEWAY_CREDENTIAL: "scoped-credential-at-least-24-characters",
      LEMMACOMPUTER_MODEL_ALIAS: "lemmacomputer-assistant",
      LEMMACOMPUTER_CONTROL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      LEMMACOMPUTER_AGENT_BRIDGE_TOKEN: bridgeGrant(Math.floor(Date.now() / 1_000) + 900),
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

    const signature = await fetch(`http://127.0.0.1:${brokerPort}/mcp-rest/tools/signature`);
    assert.equal(signature.status, 200);
    assert.deepEqual(await signature.json(), { signature: projectionHash, servers: activeServers });
    assert.deepEqual(discoveryRequests, [], "projection polling must not contact connector providers");

    const partiallyAvailable = await fetch(`http://127.0.0.1:${brokerPort}/mcp-rest/tools/list`);
    assert.equal(partiallyAvailable.status, 200);
    const partialBody = await partiallyAvailable.json() as {
      tools: Array<{ name: string }>;
      error: string | null;
      failedServers: Array<{ serverName: string; code: string }>;
    };
    assert.deepEqual(partialBody.tools.map((tool) => tool.name), ["web_search"]);
    assert.equal(partialBody.error, "partial_failure");
    assert.deepEqual(partialBody.failedServers, [
      { serverName: "lemmacomputer_ms365", code: "http_401" },
      { serverName: "lemmacomputer_slow", code: "unavailable" },
    ]);
    assert.deepEqual(
      discoveryRequests.map((url) => new URL(url, "http://fixture").searchParams.get("mcp_server_name")).sort(),
      ["lemmacomputer_exa", "lemmacomputer_ms365", "lemmacomputer_slow"],
    );

    const stdio = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LEMMACOMPUTER_CONNECTORS_BROKER: `http://127.0.0.1:${brokerPort}`,
        LEMMACOMPUTER_CONNECTOR_REFRESH_SECONDS: "60",
        LEMMACOMPUTER_AGENT_INSTANCE_ID: agentInstanceId,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: stdio.stdout });
    const stdioResponses: Array<Record<string, unknown>> = [];
    lines.on("line", (line) => stdioResponses.push(JSON.parse(line)));
    try {
      stdio.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      for (let attempt = 0; attempt < 700 && !stdioResponses.some((response) => response.id === 1); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const listed = stdioResponses.find((response) => response.id === 1)?.result as { tools: Array<{ name: string }> };
      const listedNames = listed.tools.map((tool) => tool.name);
      assert.ok(listedNames.includes("exa__web_search"));
      assert.equal(listedNames.some((name) => name.startsWith("microsoft365__")), false);
      stdio.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "exa__web_search", arguments: { query: "stable MCP bridges" } },
      })}\n`);
      for (let attempt = 0; attempt < 100 && !stdioResponses.some((response) => response.id === 2); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const called = stdioResponses.find((response) => response.id === 2)?.result as { content: Array<{ text: string }> };
      assert.equal(called.content[0]?.text, "Exa result");
      assert.deepEqual(toolCalls, [{
        server_id: "exa-server-id",
        name: "web_search",
        arguments: { query: "stable MCP bridges" },
      }]);
      assert.match(toolInvocationIds[0]!, /^[0-9a-f-]{36}$/);
      assert.equal(toolTerminals.length, 1);
      assert.equal(toolTerminals[0]?.sourceInvocationId, toolInvocationIds[0]);
      assert.equal((toolTerminals[0]?.terminal as Record<string, unknown>).outcome, "succeeded");
      assert.equal((toolTerminals[0]?.terminal as Record<string, unknown>).failureClass, null);
      assert.equal(typeof (toolTerminals[0]?.terminal as Record<string, unknown>).latencyMs, "number");
    } finally {
      stdio.kill("SIGTERM");
      await once(stdio, "exit");
    }

    activeServers = [];
    const beforeEmpty = discoveryRequests.length;
    const empty = await fetch(`http://127.0.0.1:${brokerPort}/mcp-rest/tools/list`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { tools: [], error: null, message: "No connected MCP servers" });
    assert.equal(discoveryRequests.length, beforeEmpty, "zero connectors does not widen discovery to a global gateway list");
    assert.match(stderr, /server=lemmacomputer_ms365 code=http_401/);
    assert.doesNotMatch(stderr, /secret-oauth-token/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("a revoked bridge grant is terminal and makes workspace broker health fail visibly", async () => {
  let renewalRequests = 0;
  const initialBridgeGrant = bridgeGrant(Math.floor(Date.now() / 1_000) + 1);
  const control = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain fixture request bodies.
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/internal/v1/agent/grants/renew") {
      renewalRequests += 1;
      response.statusCode = 403;
      response.end(JSON.stringify({
        error: {
          code: "AGENT_BRIDGE_GRANT_REVOKED",
          message: "Agent bridge authentication is no longer active",
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const controlPort = (control.address() as AddressInfo).port;
  const brokerPort = await availableBrokerPort();
  const child = spawn("python3", [proxyPath], {
    env: {
      ...process.env,
      LEMMACOMPUTER_GATEWAY_UPSTREAM: `http://127.0.0.1:${controlPort}`,
      LEMMACOMPUTER_GATEWAY_CREDENTIAL: "scoped-credential-at-least-24-characters",
      LEMMACOMPUTER_MODEL_ALIAS: "lemmacomputer-assistant",
      LEMMACOMPUTER_CONTROL_UPSTREAM: `http://127.0.0.1:${controlPort}`,
      LEMMACOMPUTER_AGENT_BRIDGE_TOKEN: initialBridgeGrant,
      LEMMACOMPUTER_GATEWAY_LISTEN_PORT: String(brokerPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    let failedHealth: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${brokerPort}/healthz`);
        if (response.status === 503) {
          failedHealth = response;
          break;
        }
      } catch { /* broker is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(failedHealth, stderr);
    assert.deepEqual(await failedHealth.json(), { status: "failed", code: "AGENT_BRIDGE_GRANT_REVOKED" });
    assert.equal(renewalRequests, 1, "the revoked grant is not retried forever");
    assert.match(stderr, /terminal agent bridge failure/);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise<void>((resolve, reject) => control.close((error) => error ? reject(error) : resolve()));
  }
});
