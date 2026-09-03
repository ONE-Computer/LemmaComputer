import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { m365ToolCatalog } from "@lemmacomputer/contracts";

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
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  const baselineDeadline = Date.now() + 2_000;
  while ((signatureReads < 2 || !responses.some((response) => response.id === 2)) && Date.now() < baselineDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(signatureReads >= 2, "the connector monitor must establish and poll a projection signature");
  assert.equal(listReads, 1, "only Hermes tool discovery may probe provider tool lists");
  const baselineNotifications = responses.filter((response) => response.method === "notifications/tools/list_changed").length;
  connected = true;

  const notificationDeadline = Date.now() + 2_000;
  while (responses.filter((response) => response.method === "notifications/tools/list_changed").length <= baselineNotifications
      && Date.now() < notificationDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    responses.filter((response) => response.method === "notifications/tools/list_changed").length > baselineNotifications,
    "Hermes must be told to refresh when Exa becomes available",
  );

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
  const listDeadline = Date.now() + 2_000;
  while (!responses.some((response) => response.id === 3) && Date.now() < listDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const listed = responses.find((response) => response.id === 3)?.result as { tools: Array<{ name: string }> };
  assert.ok(listed.tools.some((tool) => tool.name === "exa__web_search_exa"));
  assert.equal(listReads, 2, "tool discovery runs only when Hermes explicitly refreshes its tool surface");
});

test("the workspace MCP bridge recovers when Hermes lists tools before the broker is ready", async (context) => {
  let brokerReady = false;
  let listReads = 0;
  let signatureFailures = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      listReads += 1;
      if (!brokerReady) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "broker starting" }));
        return;
      }
      response.end(JSON.stringify({ tools: [{
        name: "get-calendar-view",
        description: "Read calendar events",
        inputSchema: { type: "object" },
        mcp_info: { server_id: "m365-1", server_name: "lemmacomputer_ms365" },
      }] }));
      return;
    }
    if (request.method === "GET" && request.url === "/mcp-rest/tools/signature") {
      if (!brokerReady) {
        signatureFailures += 1;
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "broker starting" }));
        return;
      }
      response.end(JSON.stringify({ signature: "a".repeat(64) }));
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
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  const failureDeadline = Date.now() + 2_000;
  while ((!responses.some((response) => response.id === 2) || signatureFailures < 1) && Date.now() < failureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(responses.find((response) => response.id === 2)?.error, "the premature discovery must fail visibly");
  assert.ok(signatureFailures >= 1, "the monitor must observe the broker startup race");

  brokerReady = true;
  const notificationDeadline = Date.now() + 2_000;
  while (!responses.some((response) => response.method === "notifications/tools/list_changed") && Date.now() < notificationDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    responses.some((response) => response.method === "notifications/tools/list_changed"),
    "Hermes must be prompted to recover its empty startup snapshot",
  );

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
  const recoveryDeadline = Date.now() + 2_000;
  while (!responses.some((response) => response.id === 3) && Date.now() < recoveryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const listed = responses.find((response) => response.id === 3)?.result as { tools: Array<{ name: string }> };
  assert.ok(listed.tools.some((tool) => tool.name === "microsoft365__get-calendar-view"));
  const recoveredNotificationCount = responses.filter((response) => response.method === "notifications/tools/list_changed").length;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    responses.filter((response) => response.method === "notifications/tools/list_changed").length,
    recoveredNotificationCount,
    "successful discovery must stop recovery notifications",
  );
  assert.equal(listReads, 2, "recovery must add one bounded provider discovery request");
});

test("the workspace MCP bridge stops polling and records visible failure after its recovery deadline", async (context) => {
  let signatureReads = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/signature") {
      signatureReads += 1;
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "shared broker outage" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const temporary = await mkdtemp(join(tmpdir(), "lemmacomputer-connector-recovery-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const stateFile = join(temporary, "state.json");
  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LEMMACOMPUTER_CONNECTOR_REFRESH_SECONDS: "0.1",
      LEMMACOMPUTER_CONNECTOR_RECOVERY_DEADLINE_SECONDS: "0.3",
      LEMMACOMPUTER_CONNECTOR_RECOVERY_STATE_FILE: stateFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  const deadline = Date.now() + 2_000;
  let state: { state?: string; code?: string | null } = {};
  while (state.state !== "exhausted" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}"));
  }
  assert.deepEqual(state, {
    state: "exhausted",
    code: "connector_tool_refresh_exhausted",
  });
  assert.ok(signatureReads >= 2, "the bridge should attempt bounded recovery before failing");
  const readsAfterDeadline = signatureReads;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(signatureReads, readsAfterDeadline, "the exhausted bridge must stop polling indefinitely");
  assert.equal(
    responses.filter((response) => response.method === "notifications/tools/list_changed").length,
    0,
    "an unreachable broker must not cause refresh notification traffic",
  );

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  const pingDeadline = Date.now() + 1_000;
  while (!responses.some((response) => response.id === 2) && Date.now() < pingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(responses.some((response) => response.id === 2), "the MCP transport must remain alive for visible diagnosis");
});

test("the workspace MCP bridge stops unacknowledged refresh notifications after its recovery deadline", async (context) => {
  let signatureReads = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/signature") {
      signatureReads += 1;
      response.end(JSON.stringify({ signature: "a".repeat(64) }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(4312, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const temporary = await mkdtemp(join(tmpdir(), "lemmacomputer-connector-notifications-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const stateFile = join(temporary, "state.json");
  const child = spawn("python3", ["docker/workspace/lemmacomputer-connectors-stdio.py"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LEMMACOMPUTER_CONNECTOR_REFRESH_SECONDS: "0.1",
      LEMMACOMPUTER_CONNECTOR_RECOVERY_DEADLINE_SECONDS: "0.35",
      LEMMACOMPUTER_CONNECTOR_RECOVERY_STATE_FILE: stateFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const responses: Array<Record<string, unknown>> = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  const deadline = Date.now() + 2_000;
  let state: { state?: string } = {};
  while (state.state !== "exhausted" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}"));
  }
  assert.equal(state.state, "exhausted");
  const notificationCount = responses.filter((response) => response.method === "notifications/tools/list_changed").length;
  assert.ok(notificationCount >= 2, "the bridge should make more than one bounded refresh attempt");
  const readsAfterDeadline = signatureReads;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    responses.filter((response) => response.method === "notifications/tools/list_changed").length,
    notificationCount,
    "the bridge must not notify Hermes after the finite recovery budget",
  );
  assert.equal(signatureReads, readsAfterDeadline, "the bridge must also stop signature polling after exhaustion");
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
  const result = responses[1]?.result as {
    isError: boolean;
    content: Array<{ text: string }>;
    _meta: { lemmacomputer: { failure: { message: string; retryable: boolean } } };
  };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Call get-drive-item/);
  assert.match(result.content[0]?.text ?? "", /Do not use Cowork or local-filesystem deletion permission/);
  assert.ok(result._meta.lemmacomputer.failure.message.length <= 320);
  assert.equal(result._meta.lemmacomputer.failure.retryable, false);
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

test("Microsoft 365 downloads write binary files into the workspace without putting base64 in model text", async (context) => {
  const downloadDirectory = await mkdtemp(join(homedir(), ".lemmacomputer-download-test-"));
  const downloadPath = join(downloadDirectory, "finance-deck.pptx");
  const fileBytes = Buffer.from("PK\u0003\u0004test-presentation");
  context.after(() => rm(downloadDirectory, { recursive: true, force: true }));
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{
        name: "download-bytes",
        description: "Return a base64 file body.",
        inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
        mcp_info: { server_id: "microsoft365-id", server_name: "lemmacomputer_ms365" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.end(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({
          message: "OK!",
          contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          encoding: "base64",
          contentLength: fileBytes.length,
          contentBytes: fileBytes.toString("base64"),
        }) }],
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
  const responses: Array<Record<string, unknown>> = [];
  createInterface({ input: child.stdout }).on("line", (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "microsoft365__download-bytes",
      arguments: {
        target: "/drives/finance/items/deck/content",
        localFilePath: downloadPath,
      },
    },
  })}\n`);

  const deadline = Date.now() + 5_000;
  while (responses.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const advertised = (responses.find((response) => response.id === 1)?.result as {
    tools: Array<{ name: string; description: string; inputSchema: { required: string[] } }>;
  }).tools.find((tool) => tool.name === "microsoft365__download-bytes")!;
  assert.deepEqual(advertised.inputSchema.required, ["target", "localFilePath"]);
  assert.match(advertised.description, /corresponding document skill/);
  assert.deepEqual(calls, [{
    server_id: "microsoft365-id",
    name: "download-bytes",
    arguments: { target: "/drives/finance/items/deck/content" },
  }]);
  assert.deepEqual(await readFile(downloadPath), fileBytes);
  const result = responses.find((response) => response.id === 2)?.result as {
    isError: boolean; content: Array<{ text: string }>;
  };
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    message: "File downloaded into the workspace.",
    localFilePath: downloadPath,
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    contentLength: fileBytes.length,
  });
  assert.doesNotMatch(result.content[0]!.text, new RegExp(fileBytes.toString("base64")));
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

test("every product-enabled Microsoft 365 tool has one strict effective contract and unknown tools fail closed", async (context) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({
        tools: [...Object.keys(m365ToolCatalog), "new-unreviewed-graph-tool"].map((name) => ({
          name,
          description: "Broad upstream schema",
          inputSchema: { type: "object", additionalProperties: true },
          mcp_info: { server_id: "microsoft365-id", server_name: "lemmacomputer_ms365" },
        })),
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
  const responses: Array<Record<string, unknown>> = [];
  createInterface({ input: child.stdout }).on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const deadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 1) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const tools = (responses.find((response) => response.id === 1)?.result as {
    tools: Array<{ name: string; description: string; inputSchema: { additionalProperties?: boolean }; _meta?: Record<string, unknown> }>;
  }).tools.filter((tool) => tool.name !== "wait-for-governed-operation");
  assert.equal(tools.length, Object.keys(m365ToolCatalog).length);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    Object.keys(m365ToolCatalog).map((name) => `microsoft365__${name}`).sort(),
  );
  assert.equal(tools.some((tool) => tool.name.includes("new-unreviewed")), false);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must be strict`);
    assert.doesNotMatch(tool.description, /Broad upstream schema/);
    assert.deepEqual(tool._meta, { lemmacomputer: { contractVersion: 1 } });
  }
});

test("calendar today uses one canonical call and raw Graph expressions never reach the provider", async (context) => {
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{
        name: "get-calendar-view",
        description: "Use filter/search/orderby",
        inputSchema: {
          type: "object",
          properties: { filter: { type: "string" }, search: { type: "string" }, orderby: { type: "string" } },
          additionalProperties: true,
        },
        mcp_info: { server_id: "microsoft365-id", server_name: "lemmacomputer_ms365" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(payload);
      if (payload.arguments?.top === 2) {
        response.end(JSON.stringify({
          content: [{ type: "text", text: "raw provider token=must-not-cross" }],
          isError: true,
        }));
        return;
      }
      if (payload.arguments?.top === 3) {
        response.statusCode = 400;
        response.end(JSON.stringify({ problem: {
          category: "invalid_argument",
          field: "top",
          message: "The requested result limit is outside the reviewed contract.",
          retryable: false,
        } }));
        return;
      }
      const graphErrors: Record<number, string> = {
        8: "Error in tool get-calendar-view: Microsoft Graph API error: 401 Unauthorized - raw token detail must not cross",
        9: "Error in tool get-calendar-view: Microsoft Graph API error: 429 Too Many Requests - raw throttle detail must not cross",
        10: "Error in tool get-calendar-view: Microsoft Graph API error: 400 Bad Request - raw OData detail must not cross",
        11: "Error in tool get-calendar-view: No access token available",
      };
      if (graphErrors[payload.arguments?.top]) {
        response.end(JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ error: graphErrors[payload.arguments.top] }) }],
          isError: true,
        }));
        return;
      }
      response.end(JSON.stringify({ content: [{ type: "text", text: "one event" }], isError: false }));
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
  const responses: Array<Record<string, unknown>> = [];
  createInterface({ input: child.stdout }).on("line", (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const listDeadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 1) && Date.now() < listDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const advertised = (responses.find((response) => response.id === 1)?.result as {
    tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  }).tools.find((tool) => tool.name === "microsoft365__get-calendar-view")!;
  assert.deepEqual(Object.keys(advertised.inputSchema.properties).sort(), ["endDateTime", "startDateTime", "timezone", "top"]);
  assert.equal("filter" in advertised.inputSchema.properties, false);
  assert.equal("search" in advertised.inputSchema.properties, false);
  assert.equal("orderby" in advertised.inputSchema.properties, false);

  const baseArguments = {
    startDateTime: "2026-08-14T00:00:00+08:00",
    endDateTime: "2026-08-15T00:00:00+08:00",
    timezone: "Asia/Singapore",
  };
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "microsoft365__get-calendar-view", arguments: { ...baseArguments, filter: "subject eq 'x'" } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "microsoft365__get-calendar-view", arguments: { ...baseArguments, search: " " } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "microsoft365__get-calendar-view", arguments: baseArguments },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "microsoft365__get-calendar-view", arguments: { ...baseArguments, top: 2 } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "microsoft365__get-calendar-view", arguments: { ...baseArguments, top: 3 } },
  })}\n`);
  const unsafeField = `secret!${"x".repeat(200)}`;
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "microsoft365__get-calendar-view", arguments: { ...baseArguments, [unsafeField]: "sensitive" } },
  })}\n`);
  for (const [id, top] of [[8, 8], [9, 9], [10, 10], [11, 11]] as const) {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "microsoft365__get-calendar-view", arguments: { ...baseArguments, top } },
    })}\n`);
  }
  const callDeadline = Date.now() + 5_000;
  while (responses.filter((response) => [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(response.id as number)).length < 10 && Date.now() < callDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const id of [2, 3]) {
    const result = responses.find((response) => response.id === id)?.result as {
      isError: boolean; _meta: { lemmacomputer: { failure: {
        category: string; field: string; message: string; retryable: boolean;
      } } };
    };
    assert.equal(result.isError, true);
    assert.equal(result._meta.lemmacomputer.failure.category, "unsupported_option");
    assert.equal(result._meta.lemmacomputer.failure.retryable, false);
    assert.match(result._meta.lemmacomputer.failure.message, /Unsupported field/);
  }
  assert.equal((responses.find((response) => response.id === 4)?.result as { isError: boolean }).isError, false);
  const upstreamFailure = (responses.find((response) => response.id === 5)?.result as {
    isError: boolean; content: Array<{ text: string }>; _meta: { lemmacomputer: { failure: {
      category: string; field: string | null; message: string; retryable: boolean;
    } } };
  });
  assert.equal(upstreamFailure.isError, true);
  assert.deepEqual(upstreamFailure._meta.lemmacomputer.failure, {
    category: "unknown_failure",
    field: null,
    message: "Microsoft 365 could not complete the request. Retry once; if it fails again, reconnect the Microsoft 365 account or verify the resolved resource IDs.",
    retryable: true,
  });
  assert.doesNotMatch(upstreamFailure.content[0]?.text ?? "", /must-not-cross/);
  const controlledFailure = (responses.find((response) => response.id === 6)?.result as {
    _meta: { lemmacomputer: { failure: Record<string, unknown> } };
  })._meta.lemmacomputer.failure;
  assert.deepEqual(controlledFailure, {
    category: "invalid_argument",
    field: "top",
    message: "The requested result limit is outside the reviewed contract.",
    retryable: false,
  });
  const boundedFailure = (responses.find((response) => response.id === 7)?.result as {
    content: Array<{ text: string }>;
    _meta: { lemmacomputer: { failure: { field: string | null; message: string } } };
  });
  assert.equal(boundedFailure._meta.lemmacomputer.failure.field, null);
  assert.ok(boundedFailure._meta.lemmacomputer.failure.message.length <= 320);
  assert.doesNotMatch(boundedFailure.content[0]?.text ?? "", /secret!/);
  const classifiedFailures = Object.fromEntries([8, 9, 10, 11].map((id) => [id, (
    responses.find((response) => response.id === id)?.result as {
      content: Array<{ text: string }>;
      _meta: { lemmacomputer: { failure: Record<string, unknown> } };
    }
  )]));
  assert.deepEqual(classifiedFailures[8]._meta.lemmacomputer.failure, {
    category: "authentication_failure",
    field: null,
    message: "Microsoft 365 authentication or consent is no longer sufficient. Reconnect the account and review its granted permissions.",
    retryable: false,
  });
  assert.deepEqual(classifiedFailures[9]._meta.lemmacomputer.failure, {
    category: "provider_rejection",
    field: null,
    message: "Microsoft 365 is temporarily unable to complete the request. Retry once after a short delay.",
    retryable: true,
  });
  assert.deepEqual(classifiedFailures[10]._meta.lemmacomputer.failure, {
    category: "provider_rejection",
    field: null,
    message: "Microsoft 365 rejected the request. Check the published tool fields and resolved resource IDs before retrying.",
    retryable: false,
  });
  assert.deepEqual(classifiedFailures[11]._meta.lemmacomputer.failure, {
    category: "authentication_failure",
    field: null,
    message: "The Microsoft 365 sign-in is no longer usable. Reconnect the Microsoft 365 account, then retry the request.",
    retryable: false,
  });
  for (const result of Object.values(classifiedFailures)) {
    assert.doesNotMatch(result.content[0]?.text ?? "", /raw .* detail/);
  }
  const callsByTop = [...calls].sort((left, right) => {
    const leftTop = Number((left.arguments as Record<string, unknown>).top ?? 0);
    const rightTop = Number((right.arguments as Record<string, unknown>).top ?? 0);
    return leftTop - rightTop;
  });
  assert.deepEqual(callsByTop, [
    { server_id: "microsoft365-id", name: "get-calendar-view", arguments: baseArguments },
    { server_id: "microsoft365-id", name: "get-calendar-view", arguments: { ...baseArguments, top: 2 } },
    { server_id: "microsoft365-id", name: "get-calendar-view", arguments: { ...baseArguments, top: 3 } },
    { server_id: "microsoft365-id", name: "get-calendar-view", arguments: { ...baseArguments, top: 8 } },
    { server_id: "microsoft365-id", name: "get-calendar-view", arguments: { ...baseArguments, top: 9 } },
    { server_id: "microsoft365-id", name: "get-calendar-view", arguments: { ...baseArguments, top: 10 } },
    { server_id: "microsoft365-id", name: "get-calendar-view", arguments: { ...baseArguments, top: 11 } },
  ]);
});

test("request-local agent identities are validated and cannot leak between concurrent connector calls", async (context) => {
  const calls: Array<{ arguments: Record<string, unknown>; agentInstanceId?: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/mcp-rest/tools/list") {
      response.end(JSON.stringify({ tools: [{
        name: "list-calendars",
        inputSchema: { type: "object" },
        mcp_info: { server_id: "microsoft365-id", server_name: "lemmacomputer_ms365" },
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp-rest/tools/call") {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push({
        arguments: payload.arguments,
        agentInstanceId: request.headers["x-lemmacomputer-agent-instance-id"] as string | undefined,
      });
      await new Promise((resolve) => setTimeout(resolve,
        request.headers["x-lemmacomputer-agent-instance-id"] === "11111111-1111-4111-8111-111111111111" ? 40 : 5));
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
  const responses: Array<Record<string, unknown>> = [];
  createInterface({ input: child.stdout }).on("line", (line) => responses.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const listDeadline = Date.now() + 5_000;
  while (!responses.some((response) => response.id === 1) && Date.now() < listDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  for (const [id, agentInstanceId] of [[2, first], [3, second]] as const) {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: {
        name: "microsoft365__list-calendars",
        arguments: {},
        _meta: { lemmacomputer: { agentInstanceId } },
      },
    })}\n`);
  }
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: {
      name: "microsoft365__list-calendars",
      arguments: {},
      _meta: { lemmacomputer: { agentInstanceId: "NOT-A-UUID" } },
    },
  })}\n`);
  const deadline = Date.now() + 5_000;
  while (responses.filter((response) => [2, 3, 4].includes(response.id as number)).length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(calls.map((call) => call.agentInstanceId).sort(), [first, second].sort());
  assert.equal(calls.length, 2, "malformed identity metadata must fail before the broker");
  const invalid = responses.find((response) => response.id === 4)?.result as {
    isError: boolean; _meta: { lemmacomputer: { failure: {
      category: string; field: string; message: string; retryable: boolean;
    } } };
  };
  assert.equal(invalid.isError, true);
  assert.deepEqual(invalid._meta.lemmacomputer.failure, {
    category: "authentication_failure",
    field: "_meta.lemmacomputer.agentInstanceId",
    message: "The connector call was rejected: agent process identity must be a canonical UUIDv4.",
    retryable: false,
  });
});
