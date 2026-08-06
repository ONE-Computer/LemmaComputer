import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

test("the workspace MCP bridge notifies Hermes when a connector changes its tool surface", async (context) => {
  let listReads = 0;
  let signatureReads = 0;
  let connected = false;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      listReads += 1;
      response.end(JSON.stringify({ tools: connected ? [{
        name: "web_search_exa",
        description: "Search the web",
        inputSchema: { type: "object" },
        mcp_info: { server_id: "exa-1", server_name: "lemmacomputer_exa" },
      }] : [] }));
      return;
    }
    if (request.method === "GET" && request.url === "/mcp-rest/tools/signature") {
      signatureReads += 1;
      response.end(JSON.stringify({ signature: connected ? "b".repeat(64) : "a".repeat(64) }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
    cwd: process.cwd(),
    env: { ...process.env, LEMMACOMPUTER_CONNECTOR_REFRESH_SECONDS: "0.1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  const baselineDeadline = Date.now() + 2_000;
  while (signatureReads < 2 && Date.now() < baselineDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(signatureReads >= 2, "the connector monitor must establish and poll a projection signature");
  assert.equal(listReads, 0, "idle connector monitoring must not probe provider tool lists");
  connected = true;

  const notificationDeadline = Date.now() + 2_000;
  while (!responses.some((response) => response.method === "notifications/tools/list_changed") && Date.now() < notificationDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    responses.some((response) => response.method === "notifications/tools/list_changed"),
    "Hermes must be told to refresh when Exa becomes available",
  );

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  const listDeadline = Date.now() + 2_000;
  while (!responses.some((response) => response.id === 2) && Date.now() < listDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const listed = responses.find((response) => response.id === 2)?.result as { tools: Array<{ name: string }> };
  assert.ok(listed.tools.some((tool) => tool.name === "exa__web_search_exa"));
  assert.equal(listReads, 1, "tool discovery runs only when Hermes explicitly refreshes its tool surface");
});

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
        mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/lemmacomputer/deletions") {
      response.statusCode = 201;
      response.end(JSON.stringify({
        operation: {
          id: operationId,
          state: "approval_required",
          safeSummary: "Delete planning-draft.docx from OneDrive",
        },
      }));
      return;
    }
    if (request.method === "GET" && request.url === `/lemmacomputer/operations/${operationId}`) {
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

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
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
      name: "microsoft365__delete-onedrive-file",
      arguments: {
        driveId: "drive",
        driveItemId: "item",
        resourceName: "planning-draft.docx",
        "If-Match": "etag",
      },
    },
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
          mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
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
          mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
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

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "microsoft365__list-drives", arguments: {} } })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(responses.length, 2);
  const advertised = (responses[0]?.result as {
    tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, { maximum?: number; const?: string }>; additionalProperties?: boolean } }>;
  }).tools;
  const listDrives = advertised.find((tool) => tool.name === "microsoft365__list-drives")!;
  const searchFiles = advertised.find((tool) => tool.name === "microsoft365__search-onedrive-files")!;
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

test("Claude Desktop cannot choose connector flags and governed deletion carries only human-safe metadata", async (context) => {
  let deletionRequest: Record<string, unknown> | undefined;
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
        mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/lemmacomputer/deletions") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      deletionRequest = body;
      response.statusCode = 201;
      response.end(JSON.stringify({
        operation: {
          id: "11111111-1111-4111-8111-111111111111",
          state: "approval_required",
          safeSummary: "Delete planning-draft.docx from OneDrive",
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
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
      name: "microsoft365__delete-onedrive-file",
      arguments: {
        driveId: "drive",
        driveItemId: "item",
        resourceName: "planning-draft.docx",
        "If-Match": "{E1CFF1EF-69D6-4F68-A75F-29D6C6DB2670},3",
        lemmacomputerAudit: { target: "planning-draft.docx", targetType: "file" },
        confirm: true,
        excludeResponse: false,
      },
    },
  })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const tools = ((responses[0]?.result as { tools: Array<{ inputSchema: { properties: Record<string, unknown> } }> }).tools);
  assert.equal("confirm" in tools[0]!.inputSchema.properties, false);
  assert.equal("excludeResponse" in tools[0]!.inputSchema.properties, false);
  assert.deepEqual(
    (tools[0]!.inputSchema as unknown as { required: string[] }).required,
    ["driveId", "driveItemId", "resourceName", "If-Match", "lemmacomputerAudit"],
  );
  assert.match(
    ((responses[0]?.result as { tools: Array<{ description: string }> }).tools[0]?.description ?? ""),
    /remote Microsoft 365 action, not a local filesystem action/,
  );
  assert.match(
    ((responses[0]?.result as { tools: Array<{ description: string }> }).tools[0]?.description ?? ""),
    /list-drives to resolve driveId, then search-onedrive-files or list-folder-files/,
  );
  assert.deepEqual(deletionRequest, {
    driveId: "drive",
    driveItemId: "item",
    resourceName: "planning-draft.docx",
    "If-Match": '"{E1CFF1EF-69D6-4F68-A75F-29D6C6DB2670},3"',
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
        mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
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

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
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
      name: "microsoft365__create-calendar-event",
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
        mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
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

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
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
    params: { name: "microsoft365__delete-onedrive-file", arguments: { driveId: "drive", driveItemId: "item" } },
  })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const result = responses[1]?.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Call get-drive-item/);
  assert.match(result.content[0]?.text ?? "", /Do not use Cowork or local-filesystem deletion permission/);
  assert.equal(toolCalls, 0);
});

test("workspace-local uploads use the approval-bound resumable broker without putting bytes in model text", async (context) => {
  const uploadDirectory = await mkdtemp(join(homedir(), ".lemmacomputer-upload-test-"));
  const uploadPath = join(uploadDirectory, "happy.txt");
  await writeFile(uploadPath, "happy from a workspace file");
  context.after(() => rm(uploadDirectory, { recursive: true, force: true }));
  let localUploadArguments: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{
        name: "upload-file-content",
        description: "For new files use path format: /items/root:/path/to/file.txt:/content.",
        inputSchema: {
          type: "object",
          properties: {
            driveId: { type: "string" },
            driveItemId: { type: "string" },
            body: { type: "string" },
            confirm: { type: "boolean" },
          },
          required: ["driveId", "driveItemId", "body", "confirm"],
        },
        mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/lemmacomputer/uploads") {
      localUploadArguments = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.statusCode = 201;
      response.end(JSON.stringify({
        operation: {
          id: "11111111-1111-4111-8111-111111111111",
          state: "approval_required",
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
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
      name: "microsoft365__upload-file-content",
      arguments: {
        driveId: "drive",
        driveItemId: "/items/root:/happy.txt:/content",
        localFilePath: uploadPath,
        lemmacomputerAudit: { target: "happy.txt", targetType: "file" },
      },
    },
  })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const advertised = (responses.find((response) => response.id === 1)?.result as {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: {
        properties: Record<string, { description?: string; pattern?: string }>;
        required: string[];
        oneOf: Array<{ required: string[] }>;
      };
    }>;
  }).tools.find((tool) => tool.name === "microsoft365__upload-file-content")!;
  assert.match(advertised.description, /Never include `\/items\/`, `\/content`/);
  assert.match(advertised.description, /localFilePath/);
  assert.match(advertised.inputSchema.properties.driveItemId?.description ?? "", /root:\/happy\.txt:/);
  assert.match(advertised.inputSchema.properties.driveItemId?.pattern ?? "", /items/);
  assert.match(advertised.inputSchema.properties.localFilePath?.description ?? "", /do not read or base64-encode/i);
  assert.deepEqual(advertised.inputSchema.required, ["driveId", "driveItemId", "lemmacomputerAudit"]);
  assert.deepEqual(advertised.inputSchema.oneOf, [
    { required: ["body"] },
    { required: ["localFilePath"] },
  ]);
  assert.deepEqual(localUploadArguments, {
    driveId: "drive",
    driveItemId: "root:/happy.txt:",
    localFilePath: uploadPath,
  });
  const called = responses.find((response) => response.id === 2)?.result as { content: Array<{ text: string }> };
  assert.match(called.content[0]?.text ?? "", /Signed approval is required for resumable upload operation/);
});

test("managed Microsoft schemas hide unsupported OData and read-only Graph fields", async (context) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [
        {
          name: "list-joined-teams",
          description: "Generated generic list description",
          inputSchema: {
            type: "object",
            properties: { top: { type: "number" }, filter: { type: "string" } },
          },
          mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
        },
        {
          name: "send-channel-message",
          description: "Generated chatMessage resource description",
          inputSchema: {
            type: "object",
            properties: {
              teamId: { type: "string" },
              channelId: { type: "string" },
              body: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  createdDateTime: { type: "string" },
                  body: { type: "object" },
                  replies: { type: "array" },
                },
              },
              confirm: { type: "boolean" },
            },
            required: ["teamId", "channelId", "body", "confirm"],
          },
          mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
        },
        {
          name: "create-draft-email",
          description: "Create an open extension and add custom properties.",
          inputSchema: {
            type: "object",
            properties: {
              body: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  createdDateTime: { type: "string" },
                  subject: { type: "string" },
                  body: { type: "object" },
                  conversationId: { type: "string" },
                },
              },
              confirm: { type: "boolean" },
            },
            required: ["body", "confirm"],
          },
          mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
        },
        {
          name: "create-calendar-event",
          description: "Create event",
          inputSchema: {
            type: "object",
            properties: {
              body: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  subject: { type: "string" },
                  start: { type: "object" },
                  end: { type: "object" },
                  changeKey: { type: "string" },
                },
              },
              confirm: { type: "boolean" },
            },
            required: ["body", "confirm"],
          },
          mcp_info: { server_id: "server-1", server_name: "lemmacomputer_ms365" },
        },
      ] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const deadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 1) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const tools = (responses.find((response) => response.id === 1)?.result as {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: {
        properties: Record<string, {
          properties?: Record<string, {
            properties?: Record<string, unknown>;
            required?: string[];
          }>;
          required?: string[];
        }>;
        required?: string[];
        additionalProperties?: boolean;
      };
    }>;
  }).tools;
  const joined = tools.find((tool) => tool.name === "microsoft365__list-joined-teams")!;
  assert.deepEqual(joined.inputSchema.properties, {});
  assert.equal(joined.inputSchema.additionalProperties, false);
  assert.match(joined.description, /does not accept generic OData/);

  const send = tools.find((tool) => tool.name === "microsoft365__send-channel-message")!;
  assert.deepEqual(Object.keys(send.inputSchema.properties), ["teamId", "channelId", "body", "lemmacomputerAudit"]);
  assert.deepEqual(send.inputSchema.required, ["teamId", "channelId", "body", "lemmacomputerAudit"]);
  assert.deepEqual(Object.keys(send.inputSchema.properties.body?.properties ?? {}), ["body"]);
  assert.deepEqual(
    Object.keys(send.inputSchema.properties.body?.properties?.body?.properties ?? {}),
    ["contentType", "content"],
  );
  assert.deepEqual(send.inputSchema.properties.body?.properties?.body?.required, ["contentType", "content"]);
  assert.match(send.description, /Get teamId from list-joined-teams/);

  const draft = tools.find((tool) => tool.name === "microsoft365__create-draft-email")!;
  assert.doesNotMatch(draft.description, /open extension/);
  assert.match(draft.description, /without sending/);
  assert.deepEqual(
    Object.keys(draft.inputSchema.properties.body?.properties ?? {}),
    ["subject", "body", "toRecipients", "ccRecipients", "bccRecipients", "importance"],
  );
  assert.deepEqual(draft.inputSchema.properties.body?.required, ["subject", "body"]);
  assert.ok(draft.inputSchema.required?.includes("lemmacomputerAudit"));

  const event = tools.find((tool) => tool.name === "microsoft365__create-calendar-event")!;
  assert.deepEqual(event.inputSchema.properties.body?.required, ["subject", "start", "end"]);
  assert.ok(event.inputSchema.required?.includes("lemmacomputerAudit"));
  assert.equal("id" in (event.inputSchema.properties.body?.properties ?? {}), false);
  assert.equal("changeKey" in (event.inputSchema.properties.body?.properties ?? {}), false);
});

test("an approved execution failure cannot be reported as an approval rejection", async (context) => {
  const operationId = "22222222-2222-4222-8222-222222222222";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [] }));
      return;
    }
    if (request.method === "GET" && request.url === `/lemmacomputer/operations/${operationId}`) {
      response.end(JSON.stringify({
        id: operationId,
        state: "failed",
        approval: { decision: "approve" },
        failureCode: "UPSTREAM_TOOL_FAILED",
        failureSummary: "Microsoft Graph rejected the target path.",
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const listDeadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 1) && Date.now() < listDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "wait-for-governed-operation", arguments: { operationId } },
  })}\n`);
  const deadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 2) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const result = responses.find((response) => response.id === 2)?.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /signed approval .* succeeded/i);
  assert.match(result.content[0]?.text ?? "", /Microsoft Graph rejected the target path/);
  assert.match(result.content[0]?.text ?? "", /Do not describe this result as rejected, denied, or not approved/);
});

test("tools with the same upstream name remain advertised and route to the selected connector", async (context) => {
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [
        {
          name: "search",
          description: "Search Notion",
          inputSchema: { type: "object" },
          mcp_info: { server_id: "notion-id", server_name: "lemmacomputer_notion" },
        },
        {
          name: "search",
          description: "Search Linear",
          inputSchema: { type: "object" },
          mcp_info: { server_id: "linear-id", server_name: "lemmacomputer_linear" },
        },
      ] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], isError: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const listDeadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 1) && Date.now() < listDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const tools = (responses.find((response) => response.id === 1)?.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(tools.slice(0, 2).map((tool) => tool.name), [
    "notion__search",
    "linear__search",
  ]);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "linear__search", arguments: { query: "roadmap" } },
  })}\n`);
  const callDeadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 2) && Date.now() < callDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(calls, [{
    server_id: "linear-id",
    name: "search",
    arguments: { query: "roadmap" },
  }]);
});

test("Microsoft 365 and Linear tools are always connector-prefixed and retain upstream routing", async (context) => {
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [
        {
          name: "list-calendars",
          description: "List Microsoft 365 calendars",
          inputSchema: { type: "object" },
          mcp_info: { server_id: "microsoft365-id", server_name: "lemmacomputer_ms365" },
        },
        {
          name: "list_issues",
          description: "List Linear issues",
          inputSchema: { type: "object" },
          mcp_info: { server_id: "linear-id", server_name: "lemmacomputer_linear" },
        },
      ] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], isError: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const listDeadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 1) && Date.now() < listDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const tools = (responses.find((response) => response.id === 1)?.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(tools.slice(0, 2).map((tool) => tool.name), [
    "microsoft365__list-calendars",
    "linear__list_issues",
  ]);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "microsoft365__list-calendars", arguments: {} },
  })}\n`);
  const microsoftDeadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 2) && Date.now() < microsoftDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "linear__list_issues", arguments: { limit: 10 } },
  })}\n`);
  const callDeadline = Date.now() + 5_000;
  while (responses.filter((response) => response.id === 2 || response.id === 3).length < 2 && Date.now() < callDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(calls, [
    { server_id: "microsoft365-id", name: "list-calendars", arguments: {} },
    { server_id: "linear-id", name: "list_issues", arguments: { limit: 10 } },
  ]);
});
