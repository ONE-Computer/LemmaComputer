import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import {
  approvedBedrockApiKeyModelProfiles,
  bedrockApiKeyModelProfileSchema,
  bedrockApiKeyRouteAlias,
  bedrockApiKeyRouteConfigurationSchema,
  OneComputerError,
} from "@onecomputer/contracts";
import { LiteLLMGatewayAdapter } from "@onecomputer/litellm-adapter";

const root = path.resolve(import.meta.dirname, "..");
const source = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");
const testApiKey = "bedrock-api-key-for-contract-test-00000001";

const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => (
  server.close((error) => error ? reject(error) : resolve())
));

const adapterFor = (port: number) => new LiteLLMGatewayAdapter({
  adminUrl: `http://127.0.0.1:${port}`,
  workspaceUrl: `http://127.0.0.1:${port}`,
  masterKey: "sk-master-test-not-used-00001",
  credentialSecret: "credential-secret-for-tests-00000001",
});

test("the approved Bedrock API-key contract rejects unknown selections and incomplete capability metadata", () => {
  assert.deepEqual(approvedBedrockApiKeyModelProfiles.map((profile) => profile.id), ["claude-sonnet-4-5-global"]);
  const profile = approvedBedrockApiKeyModelProfiles[0]!;
  assert.deepEqual(profile.capabilities, {
    vision: true,
    streaming: true,
    toolCalls: true,
    structuredOutput: true,
    computerUse: true,
  });
  assert.equal(profile.limits.contextWindowTokens, 200_000);
  assert.equal(profile.limits.maxOutputTokens, 64_000);
  assert.equal(profile.pricing.inputUsdPerMillionTokens, 3);
  assert.equal(profile.pricing.outputUsdPerMillionTokens, 15);

  assert.throws(() => bedrockApiKeyRouteConfigurationSchema.parse({
    apiKey: testApiKey,
    region: "ap-northeast-1",
    modelProfileId: "claude-sonnet-4-5-global",
  }));
  assert.throws(() => bedrockApiKeyRouteConfigurationSchema.parse({
    apiKey: testApiKey,
    region: "us-east-1",
    modelProfileId: "unreviewed-model",
  }));
  assert.equal(bedrockApiKeyModelProfileSchema.safeParse({
    id: "claude-sonnet-4-5-global",
    litellmModel: "bedrock/converse/global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    regions: ["us-east-1"],
    capabilities: { vision: true },
    limits: { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
    pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
  }).success, false);
});

test("the pinned LiteLLM API-key route uses encrypted credentials and a dynamic approved model without restart", async () => {
  const requests: Array<{
    method: string;
    url: string;
    authorization: string;
    body: Record<string, unknown>;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: String(request.headers.authorization ?? ""),
      body,
    });
    response.setHeader("content-type", "application/json");

    if (request.method === "PATCH" && request.url?.startsWith("/credentials/")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: { error: "Credential not found" } }));
      return;
    }
    if (request.url === "/credentials" || request.url === "/model/new" || request.url === "/key/generate" || request.url === "/key/delete") {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (request.method === "PATCH" && request.url === "/model/onecomputer-bedrock-api-key-v1/update") {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: { error: "Model not found" } }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      response.end(JSON.stringify({
        model: bedrockApiKeyRouteAlias,
        choices: [{ message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: "Unexpected route" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const adapter = adapterFor(address.port);
  try {
    const route = await adapter.configureBedrockApiKeyRoute({
      credentialName: "onecomputer-bedrock-integration-v1",
      apiKey: testApiKey,
      region: "ap-southeast-1",
      modelProfileId: "claude-sonnet-4-5-global",
    });
    const result = await adapter.testBedrockApiKeyRoute({
      region: "ap-southeast-1",
      modelProfileId: "claude-sonnet-4-5-global",
    });

    assert.equal(route.alias, bedrockApiKeyRouteAlias);
    assert.equal(route.region, "ap-southeast-1");
    assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 1, totalTokens: 8 });

    const credential = requests.find((item) => item.url === "/credentials")!;
    assert.equal(credential.authorization, "Bearer sk-master-test-not-used-00001");
    assert.deepEqual(credential.body.credential_values, { api_key: testApiKey });
    assert.deepEqual(credential.body.credential_info, {
      provider: "bedrock",
      route_alias: bedrockApiKeyRouteAlias,
      region: "ap-southeast-1",
      model_profile_id: "claude-sonnet-4-5-global",
    });

    const model = requests.find((item) => item.url === "/model/new")!;
    const modelParams = model.body.litellm_params as Record<string, unknown>;
    const modelInfo = model.body.model_info as Record<string, unknown>;
    assert.equal(model.body.model_name, bedrockApiKeyRouteAlias);
    assert.equal(modelParams.model, "bedrock/converse/global.anthropic.claude-sonnet-4-5-20250929-v1:0");
    assert.equal(modelParams.litellm_credential_name, "onecomputer-bedrock-integration-v1");
    assert.equal(modelParams.aws_region_name, "ap-southeast-1");
    assert.equal(modelParams.timeout, 60);
    assert.equal(modelParams.max_retries, 2);
    assert.equal("api_key" in modelParams, false);
    for (const key of ["aws_access_key_id", "aws_secret_access_key", "aws_session_token", "aws_role_name"]) {
      assert.equal(key in modelParams, false);
    }
    assert.equal(modelInfo.supports_vision, true);
    assert.equal(modelInfo.supports_function_calling, true);
    assert.equal(modelInfo.supports_response_schema, true);
    assert.equal(modelInfo.supports_streaming, true);
    assert.equal(modelInfo.max_input_tokens, 200_000);
    assert.equal(modelInfo.max_output_tokens, 64_000);
    assert.equal(modelInfo.input_cost_per_token, 0.000003);
    assert.equal(modelInfo.output_cost_per_token, 0.000015);

    const grant = requests.find((item) => item.url === "/key/generate")!;
    const probe = requests.find((item) => item.url === "/v1/chat/completions")!;
    assert.deepEqual(grant.body.models, [bedrockApiKeyRouteAlias]);
    assert.equal(probe.authorization, `Bearer ${String(grant.body.key)}`);
    assert.notEqual(probe.authorization, "Bearer sk-master-test-not-used-00001");
    assert.equal(probe.body.model, bedrockApiKeyRouteAlias);
    assert.ok(requests.some((item) => item.url === "/key/delete"));
    for (const request of requests.filter((item) => !item.url.startsWith("/credentials"))) {
      assert.doesNotMatch(JSON.stringify(request.body), new RegExp(testApiKey));
    }
  } finally {
    await close(server);
  }
});

test("Bedrock API-key diagnostics distinguish safe remediation without reflecting the key", async () => {
  const scenarios = [
    { status: 401, payload: { error: { message: `Authentication failed for ${testApiKey}` } }, code: "BEDROCK_API_KEY_INVALID", retryable: false },
    { status: 403, payload: { error: { message: "AccessDeniedException: model access must be enabled and EULA accepted" } }, code: "BEDROCK_MODEL_ACCESS_REQUIRED", retryable: false },
    { status: 400, payload: { error: { message: "Unsupported region for this inference profile" } }, code: "BEDROCK_REGION_UNSUPPORTED", retryable: false },
    { status: 429, payload: { error: { message: "ThrottlingException" } }, code: "BEDROCK_THROTTLED", retryable: true },
    { status: 504, payload: { error: { message: "request timed out" } }, code: "BEDROCK_TIMEOUT", retryable: true },
    { status: 403, payload: { error: { message: "AccessDeniedException: caller is not authorized" } }, code: "BEDROCK_ACCESS_DENIED", retryable: false },
  ] as const;

  for (const scenario of scenarios) {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the body before replying, so the fixture mirrors an HTTP gateway.
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/key/generate") {
        response.end(JSON.stringify({ success: true }));
        return;
      }
      if (request.url === "/v1/chat/completions") {
        response.statusCode = scenario.status;
        response.end(JSON.stringify(scenario.payload));
        return;
      }
      if (request.url === "/key/delete") {
        response.end(JSON.stringify({ success: true }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: "Unexpected route" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      await assert.rejects(
        adapterFor(address.port).testBedrockApiKeyRoute({
          region: "us-east-1",
          modelProfileId: "claude-sonnet-4-5-global",
        }),
        (error: unknown) => {
          assert.ok(error instanceof OneComputerError);
          assert.equal(error.code, scenario.code);
          assert.equal(error.retryable, scenario.retryable);
          assert.doesNotMatch(error.message, new RegExp(testApiKey));
          return true;
        },
      );
    } finally {
      await close(server);
    }
  }
});

test("Bedrock stays out of static configuration and uses the pinned database-managed LiteLLM image", async () => {
  const [compose, config, dockerfile] = await Promise.all([
    source("compose.yaml"),
    source("config/litellm/config.yaml"),
    source("docker/Dockerfile.litellm"),
  ]);
  assert.match(compose, /image: onecomputer\/litellm:v1\.93\.0-onecomputer-egress/);
  assert.match(dockerfile, /FROM ghcr\.io\/berriai\/litellm:v1\.93\.0@sha256:/);
  assert.match(config, /store_model_in_db: true/);
  assert.doesNotMatch(compose, /(?:AWS_BEARER_TOKEN_BEDROCK|ONECOMPUTER_BEDROCK_API_KEY)/);
  assert.doesNotMatch(config, /model_name: onecomputer-bedrock/);
  assert.doesNotMatch(config, /AWS_BEARER_TOKEN_BEDROCK/);
});


test("the dynamically stored Bedrock route supports streaming, tool calls, and structured output without exposing the API key", async () => {
  let credentialValues: Record<string, unknown> | undefined;
  let deployment: Record<string, unknown> | undefined;
  let streamRequest: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};

    if (request.method === "PATCH" && request.url?.startsWith("/credentials/")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: { error: "Credential not found" } }));
      return;
    }
    if (request.method === "POST" && request.url === "/credentials") {
      credentialValues = body.credential_values as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (request.method === "PATCH" && request.url === "/model/onecomputer-bedrock-api-key-v1/update") {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: { error: "Model not found" } }));
      return;
    }
    if (request.method === "POST" && request.url === "/model/new") {
      deployment = body;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      streamRequest = body;
      const modelParams = deployment?.litellm_params as Record<string, unknown> | undefined;
      const modelInfo = deployment?.model_info as Record<string, unknown> | undefined;
      const tools = body.tools;
      const responseFormat = body.response_format as Record<string, unknown> | undefined;
      const validRoute = (
        request.headers.authorization === "Bearer sk-workspace-bedrock-contract"
        && body.model === bedrockApiKeyRouteAlias
        && body.stream === true
        && Array.isArray(tools)
        && (tools[0] as Record<string, unknown> | undefined)?.type === "function"
        && responseFormat?.type === "json_schema"
        && modelParams?.litellm_credential_name === "onecomputer-bedrock-streaming-v1"
        && modelParams?.aws_region_name === "us-east-1"
        && modelInfo?.supports_streaming === true
        && modelInfo?.supports_function_calling === true
        && modelInfo?.supports_response_schema === true
        && JSON.stringify(modelParams).includes(testApiKey) === false
        && JSON.stringify(body).includes(testApiKey) === false
        && JSON.stringify(credentialValues) === JSON.stringify({ api_key: testApiKey })
      );
      if (!validRoute) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: { message: "route contract failed" } }));
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-cache");
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ id: "42" }) } }] } }] })}\n\n`);
      response.end("data: [DONE]\\n\\n");
      return;
    }
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: { message: "Unexpected route" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await adapterFor(address.port).configureBedrockApiKeyRoute({
      credentialName: "onecomputer-bedrock-streaming-v1",
      apiKey: testApiKey,
      region: "us-east-1",
      modelProfileId: "claude-sonnet-4-5-global",
    });

    const streamed = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-workspace-bedrock-contract",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: bedrockApiKeyRouteAlias,
        stream: true,
        messages: [{ role: "user", content: "Look up document 42 and return the result as JSON." }],
        tools: [{
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a document by id",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
          },
        }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "lookup_result",
            schema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/);
    const eventStream = await streamed.text();
    assert.match(eventStream, /\"tool_calls\"/);
    assert.match(eventStream, /\"lookup\"/);
    assert.match(eventStream, /data: \[DONE\]/);
    assert.ok(streamRequest);
    assert.doesNotMatch(JSON.stringify(streamRequest), new RegExp(testApiKey));
  } finally {
    await close(server);
  }
});
