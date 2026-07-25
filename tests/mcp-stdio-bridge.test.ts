import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

test("Claude Desktop MCP call returns a governed handle while the bridge remains responsive during the wait", async (context) => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  let statusReads = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{
        name: "delete-onedrive-file",
        description: "Delete a file",
        inputSchema: { type: "object" },
        mcp_info: { server_id: "server-1" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      response.statusCode = 409;
      response.end(JSON.stringify({ detail: { error: "MCP_APPROVAL_REQUIRED", operation_id: operationId } }));
      return;
    }
    if (request.method === "GET" && request.url === `/onecomputer/operations/${operationId}`) {
      statusReads += 1;
      response.end(JSON.stringify(statusReads === 1
        ? { id: operationId, state: "approval_required" }
        : { id: operationId, state: "succeeded", receipt: { resultSummary: "Deleted after signed approval" } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["infra/issue-010/onecomputer-mcp-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "delete-onedrive-file", arguments: { driveId: "drive", driveItemId: "item", "If-Match": "etag" } },
  })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(responses.length, 2);
  const governedResponse = responses.find((response) => response.id === 2);
  assert.match((governedResponse?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "", /wait-for-governed-operation/);
  const pingStartedAt = Date.now();
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "wait-for-governed-operation", arguments: { operationId } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" })}\n`);
  const pingDeadline = pingStartedAt + 750;
  while (!responses.some((response) => response.id === 4) && Date.now() < pingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    responses.some((response) => response.id === 4),
    "the stdio bridge must answer keepalive pings while a governed wait is active",
  );

  const waitDeadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 3) && Date.now() < waitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const waitResponse = responses.find((response) => response.id === 3);
  assert.equal((waitResponse?.result as { isError: boolean }).isError, false);
  assert.equal((waitResponse?.result as { content: Array<{ text: string }> }).content[0]?.text, "Deleted after signed approval");
  assert.equal(statusReads, 2);
});

test("Claude Desktop MCP bridge removes nullable LiteLLM result fields", async (context) => {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [
        {
          name: "list-drives",
          description: "List drives",
          inputSchema: { type: "object" },
          mcp_info: { server_id: "server-1" },
        },
        {
          name: "search-onedrive-files",
          description: "Search files",
          inputSchema: {
            type: "object",
            properties: {
              driveId: { type: "string" },
              q: { type: "string" },
              top: { type: "number" },
              fetchAllPages: { type: "boolean" },
            },
          },
          mcp_info: { server_id: "server-1" },
        },
      ] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      response.end(JSON.stringify({
        _meta: null,
        content: [{ type: "text", text: '{"value":[]}', annotations: null, _meta: null }],
        structuredContent: null,
        isError: false,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["infra/issue-010/onecomputer-mcp-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list-drives", arguments: {} } })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(responses.length, 2);
  const advertised = (responses[0]?.result as {
    tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, { maximum?: number; const?: string }>; additionalProperties?: boolean } }>;
  }).tools;
  const listDrives = advertised.find((tool) => tool.name === "list-drives")!;
  const searchFiles = advertised.find((tool) => tool.name === "search-onedrive-files")!;
  assert.equal(listDrives.inputSchema.properties.top?.maximum, 25);
  assert.equal(listDrives.inputSchema.additionalProperties, false);
  assert.equal(searchFiles.inputSchema.properties.top?.maximum, 10);
  assert.equal(searchFiles.inputSchema.properties.select?.const, "id,name,eTag,parentReference");
  assert.equal("fetchAllPages" in searchFiles.inputSchema.properties, false);
  assert.equal(searchFiles.inputSchema.additionalProperties, false);
  assert.match(searchFiles.description, /Do not request all pages/);
  assert.deepEqual(responses[1]?.result, {
    content: [{ type: "text", text: '{"value":[]}' }],
    isError: false,
  });
});

test("Claude Desktop cannot choose connector flags and the managed bridge confirms governed writes", async (context) => {
  let forwardedArguments: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{
        name: "delete-onedrive-file",
        description: "Delete a file",
        inputSchema: {
          type: "object",
          properties: {
            driveId: { type: "string" },
            driveItemId: { type: "string" },
            "If-Match": { type: "string" },
            confirm: { type: "boolean" },
            excludeResponse: { type: "boolean" },
          },
          required: ["driveId", "driveItemId", "confirm"],
        },
        mcp_info: { server_id: "server-1" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      forwardedArguments = body.arguments;
      response.end(JSON.stringify({ content: [{ type: "text", text: "held" }], isError: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["infra/issue-010/onecomputer-mcp-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "delete-onedrive-file",
      arguments: { driveId: "drive", driveItemId: "item", "If-Match": "{E1CFF1EF-69D6-4F68-A75F-29D6C6DB2670},3", confirm: true, excludeResponse: false },
    },
  })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const tools = ((responses[0]?.result as { tools: Array<{ inputSchema: { properties: Record<string, unknown> } }> }).tools);
  assert.equal("confirm" in tools[0]!.inputSchema.properties, false);
  assert.equal("excludeResponse" in tools[0]!.inputSchema.properties, false);
  assert.deepEqual(
    (tools[0]!.inputSchema as unknown as { required: string[] }).required,
    ["driveId", "driveItemId", "If-Match"],
  );
  assert.match(
    ((responses[0]?.result as { tools: Array<{ description: string }> }).tools[0]?.description ?? ""),
    /remote Microsoft 365 action, not a local filesystem action/,
  );
  assert.match(
    ((responses[0]?.result as { tools: Array<{ description: string }> }).tools[0]?.description ?? ""),
    /list-drives to resolve driveId, then search-onedrive-files or list-folder-files/,
  );
  assert.deepEqual(forwardedArguments, {
    driveId: "drive",
    driveItemId: "item",
    "If-Match": '"{E1CFF1EF-69D6-4F68-A75F-29D6C6DB2670},3"',
    confirm: true,
  });
});

test("Claude Desktop bridge supplies Softeria confirmation for an allowed calendar write", async (context) => {
  let forwardedArguments: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{
        name: "create-calendar-event",
        description: "Create an event",
        inputSchema: {
          type: "object",
          properties: { body: { type: "object" }, confirm: { type: "boolean" } },
          required: ["body"],
        },
        mcp_info: { server_id: "server-1" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      forwardedArguments = JSON.parse(Buffer.concat(chunks).toString("utf8")).arguments;
      response.end(JSON.stringify({ content: [{ type: "text", text: "created" }], isError: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["infra/issue-010/onecomputer-mcp-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "create-calendar-event",
      arguments: { body: { subject: "OC-MVP-ALLOW" }, confirm: false },
    },
  })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const tools = ((responses[0]?.result as { tools: Array<{ inputSchema: { properties: Record<string, unknown> } }> }).tools);
  assert.equal("confirm" in tools[0]!.inputSchema.properties, false);
  assert.deepEqual(forwardedArguments, { body: { subject: "OC-MVP-ALLOW" }, confirm: true });
  assert.equal((responses[1]?.result as { isError: boolean }).isError, false);
});

test("Claude Desktop receives an actionable retry when a protected delete omits the eTag", async (context) => {
  let toolCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{
        name: "delete-onedrive-file",
        description: "Delete a file",
        inputSchema: {
          type: "object",
          properties: {
            driveId: { type: "string" },
            driveItemId: { type: "string" },
            "If-Match": { type: "string" },
          },
          required: ["driveId", "driveItemId"],
        },
        mcp_info: { server_id: "server-1" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") toolCalls += 1;
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["infra/issue-010/onecomputer-mcp-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "delete-onedrive-file", arguments: { driveId: "drive", driveItemId: "item" } },
  })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const result = responses[1]?.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Call get-drive-item/);
  assert.match(result.content[0]?.text ?? "", /Do not use Cowork or local-filesystem deletion permission/);
  assert.equal(toolCalls, 0);
});
