import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const envSchema = z.object({
  FIXTURE_HOST: z.string().default("127.0.0.1"),
  FIXTURE_PORT: z.coerce.number().int().positive().default(4200),
  FIXTURE_OAUTH_REFRESH_EXPIRES_IN: z.coerce.number().int().nonnegative().default(3600),
});

export type FixtureCounters = {
  model: number;
  bedrockModel: number;
  toolsList: number;
  searchFiles: number;
  deleteFile: number;
  oauthToolsList: number;
  oauthToolCall: number;
  oauthTokenRefresh: number;
  oauthCredentialFingerprints: string[];
};

export function createGatewayFixture() {
  const env = envSchema.parse(process.env);
  const counters: FixtureCounters = {
    model: 0,
    bedrockModel: 0,
    toolsList: 0,
    searchFiles: 0,
    deleteFile: 0,
    oauthToolsList: 0,
    oauthToolCall: 0,
    oauthTokenRefresh: 0,
    oauthCredentialFingerprints: [],
  };
  const revokedOAuthCredentialSuffixes = new Set<string>();
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/counters", async () => ({ ...counters }));
  app.post("/counters/reset", async () => {
    counters.model = 0;
    counters.bedrockModel = 0;
    counters.toolsList = 0;
    counters.searchFiles = 0;
    counters.deleteFile = 0;
    counters.oauthToolsList = 0;
    counters.oauthToolCall = 0;
    counters.oauthTokenRefresh = 0;
    counters.oauthCredentialFingerprints = [];
    revokedOAuthCredentialSuffixes.clear();
    return { ...counters };
  });

  const rejectedProviderCredential = (request: { headers: { authorization?: unknown; "x-amzn-bedrock-api-key"?: unknown; "x-api-key"?: unknown } }) => [
    request.headers.authorization,
    request.headers["x-amzn-bedrock-api-key"],
    request.headers["x-api-key"],
  ].some((value) => String(value ?? "").includes("provider-qualification-rejected"));

  app.post("/v1/chat/completions", async (request, reply) => {
    counters.model += 1;
    // The Provider Settings qualification submits a generated replacement key
    // with this marker. Reject it locally so the real pinned LiteLLM image
    // exercises candidate validation and rollback without contacting OpenAI.
    if (rejectedProviderCredential(request)) {
      return reply.code(401).send({ error: { message: "fixture rejected the submitted provider credential" } });
    }
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    if (body.stream === true) {
      const id = `chatcmpl-${randomUUID()}`;
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      reply.raw.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1_000),
        model: String(body.model ?? "onecomputer-fixture"),
        choices: [{ index: 0, delta: { role: "assistant", content: "LemmaComputer’s scoped model route is ready through LiteLLM." }, finish_reason: null }],
      })}\n\n`);
      reply.raw.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1_000),
        model: String(body.model ?? "onecomputer-fixture"),
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model: String(body.model ?? "onecomputer-fixture"),
      choices: [{
        index: 0,
        message: { role: "assistant", content: "LemmaComputer’s scoped model route is ready through LiteLLM." },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
  });

  app.post("/model/:modelId/invoke", async (request, reply) => {
    counters.model += 1;
    counters.bedrockModel += 1;
    if (rejectedProviderCredential(request)) {
      return reply.code(401).send({ error: { message: "fixture rejected the submitted Bedrock API key" } });
    }
    return reply
      .header("x-amzn-bedrock-input-token-count", "10")
      .header("x-amzn-bedrock-output-token-count", "1")
      .send({
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1 },
      });
  });

  app.post("/model/:modelId/converse", async (request, reply) => {
    counters.model += 1;
    counters.bedrockModel += 1;
    if (rejectedProviderCredential(request)) {
      return reply.code(401).send({ error: { message: "fixture rejected the submitted Bedrock API key" } });
    }
    return {
      output: { message: { role: "assistant", content: [{ text: "OK" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      metrics: { latencyMs: 1 },
    };
  });

  app.post("/v1/responses", async (request, reply) => {
    counters.model += 1;
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    const responseId = `resp-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const text = "LemmaComputer’s scoped model route is ready through LiteLLM.";
    const completed = {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1_000),
      status: "completed",
      model: String(body.model ?? "onecomputer-fixture"),
      output: [{
        type: "message",
        id: messageId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      }],
      parallel_tool_calls: true,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } },
      text: { format: { type: "text" } },
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: {},
      temperature: 1,
      tool_choice: "auto",
      tools: [],
    };
    if (body.stream === true) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: Record<string, unknown>) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", sequence_number: 0, response: { ...completed, status: "in_progress", output: [] } });
      send({ type: "response.output_text.delta", sequence_number: 1, response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, delta: text });
      send({ type: "response.output_text.done", sequence_number: 2, response_id: responseId, item_id: messageId, output_index: 0, content_index: 0, text });
      send({ type: "response.completed", sequence_number: 3, response: completed });
      reply.raw.end("data: [DONE]\n\n");
      return;
    }
    return completed;
  });

  app.all("/mcp", async (request, reply) => {
    const server = new McpServer({ name: "onecomputer-fixture", version: "0.1.0" });
    server.registerTool("search_files", {
      description: "Search the approved fixture file catalog.",
      inputSchema: { query: z.string().min(1) },
    }, async ({ query }) => {
      counters.searchFiles += 1;
      return { content: [{ type: "text", text: `Fixture results for ${query}` }] };
    });
    server.registerTool("delete_file", {
      description: "Delete a fixture file. This destructive tool is deliberately not assigned.",
      inputSchema: { path: z.string().min(1) },
    }, async ({ path }) => {
      counters.deleteFile += 1;
      return { content: [{ type: "text", text: `Deleted fixture ${path}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const body = request.body as Record<string, unknown> | undefined;
    if (body?.method === "tools/list") counters.toolsList += 1;
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    reply.hijack();
  });

  app.get("/oauth/authorize", async (_request, reply) => {
    return reply.code(400).send({ error: "qualification_fixture_has_no_browser_flow" });
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));

  app.post("/oauth/qualification/revoke/:credentialSuffix", async (request, reply) => {
    const credentialSuffix = (request.params as { credentialSuffix?: string }).credentialSuffix;
    if (!credentialSuffix || !/^[a-f0-9]{24}$/.test(credentialSuffix)) {
      return reply.code(400).send({ error: "invalid_qualification_credential" });
    }
    revokedOAuthCredentialSuffixes.add(credentialSuffix);
    return { revoked: true };
  });

  app.post("/oauth/token", async (request, reply) => {
    const form = new URLSearchParams(typeof request.body === "string" ? request.body : "");
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = form.get("code");
      if (!code) {
        return reply.code(400).send({ error: "missing_fixture_code" });
      }
      const tokenSuffix = createHash("sha256").update(code).digest("hex").slice(0, 24);
      const revoked = code.startsWith("revoked-");
      return {
        access_token: `ocq-expired-${tokenSuffix}`,
        refresh_token: `${revoked ? "ocq-revoked" : "ocq-refresh"}-${tokenSuffix}`,
        token_type: "Bearer",
        // Qualifiers must exercise the LiteLLM stored-token refresh path,
        // rather than rely on a local timer or an upstream MCP tool call.
        expires_in: 0,
        scope: "fixture.read",
      };
    }

    const refreshToken = form.get("refresh_token");
    if (grantType !== "refresh_token" || !refreshToken) {
      return reply.code(400).send({ error: "unsupported_fixture_grant" });
    }
    counters.oauthTokenRefresh += 1;
    const credentialSuffix = refreshToken.slice(refreshToken.lastIndexOf("-") + 1);
    if (refreshToken.startsWith("ocq-revoked-") || revokedOAuthCredentialSuffixes.has(credentialSuffix)) {
      return reply.code(400).send({ error: "invalid_grant" });
    }
    const accessToken = `ocq-refreshed-${createHash("sha256").update(refreshToken).digest("hex").slice(0, 24)}`;
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: env.FIXTURE_OAUTH_REFRESH_EXPIRES_IN,
      scope: "fixture.read",
    };
  });

  app.all("/oauth-mcp", async (request, reply) => {
    const authorization = String(request.headers.authorization ?? "");
    if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
      return reply.code(401).header("www-authenticate", "Bearer").send({ error: "missing_bearer" });
    }
    const credentialFingerprint = createHash("sha256")
      .update(authorization.slice("Bearer ".length))
      .digest("hex")
      .slice(0, 16);
    counters.oauthCredentialFingerprints.push(credentialFingerprint);

    const server = new McpServer({ name: "onecomputer-oauth-fixture", version: "0.1.0" });
    const credentialResult = () => {
      counters.oauthToolCall += 1;
      return { content: [{ type: "text" as const, text: JSON.stringify({ credentialFingerprint }) }] };
    };
    server.registerTool("credential_identity", {
      description: "Return a safe fingerprint of the resolved per-user fixture credential.",
      inputSchema: {},
    }, credentialResult);
    server.registerTool("credential_secondary", {
      description: "A separately assignable tool using the same per-user fixture credential.",
      inputSchema: {},
    }, credentialResult);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const body = request.body as Record<string, unknown> | undefined;
    if (body?.method === "tools/list") counters.oauthToolsList += 1;
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    reply.hijack();
  });

  return { app, counters };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = envSchema.parse(process.env);
  const { app } = createGatewayFixture();
  await app.listen({ host: env.FIXTURE_HOST, port: env.FIXTURE_PORT });
}
