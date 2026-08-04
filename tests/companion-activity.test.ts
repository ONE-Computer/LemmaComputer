import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityContext } from "@lemmacomputer/contracts";
import { MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "companion-activity-proxy-token-at-least-24-characters";
const identity: IdentityContext = { tenantId: "activity-tenant", subjectId: "activity-owner", audience: "lemmacomputer-control" };
const otherIdentity: IdentityContext = { ...identity, subjectId: "other-owner" };
const headersFor = (value: IdentityContext) => ({
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": value.tenantId,
  "x-lemmacomputer-test-user-id": value.subjectId,
});

test("companion activity is owned, redacted, stable across pages, and read-only", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", "activity-workspace");
  const otherWorkspace = await store.createOrGet(otherIdentity, "personal", "other-workspace");
  const base = Date.now() + 60_000;

  const createOperation = async (input: {
    id: string;
    owner: IdentityContext;
    workspaceId: string;
    createdAt: Date;
    secret: string;
  }) => {
    const operation = await store.createGovernedOperation({
      id: input.id,
      identity: input.owner,
      workspaceId: input.workspaceId,
      agentId: "private-agent-identifier",
      capabilityId: "m365-write-protected",
      serverName: "lemmacomputer_ms365",
      toolName: "send-mail",
      schemaId: "lemmacomputer.m365.send-mail.v1",
      arguments: { privateBody: input.secret },
      operationDigest: "d".repeat(64),
      nonce: `private-nonce-${input.id}`,
      safeSummary: "Send a prepared email",
      resourceName: "Prepared email",
      resourceLocation: "Outlook Mail",
      correlationId: `private-correlation-${input.id}`,
      idempotencyKey: `activity-${input.id}`,
      createdAt: input.createdAt,
      expiresAt: new Date(input.createdAt.getTime() + 10 * 60_000),
    });
    assert.ok(operation);
  };

  const ownedIds = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ];
  await createOperation({ id: ownedIds[0]!, owner: identity, workspaceId: workspace.id, createdAt: new Date(base), secret: "first-private-body" });
  await createOperation({ id: ownedIds[1]!, owner: identity, workspaceId: workspace.id, createdAt: new Date(base), secret: "second-private-body" });
  await createOperation({ id: ownedIds[2]!, owner: identity, workspaceId: workspace.id, createdAt: new Date(base + 1_000), secret: "third-private-body" });
  await createOperation({
    id: "00000000-0000-4000-8000-000000000004",
    owner: otherIdentity,
    workspaceId: otherWorkspace.id,
    createdAt: new Date(base + 2_000),
    secret: "cross-owner-private-body",
  });

  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, { testIdentityMode: true });
  const first = await app.inject({
    method: "GET",
    url: "/v1/openvtc/companion/activity?limit=2",
    headers: headersFor(identity),
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().activities.map((item: { id: string }) => item.id), [ownedIds[2], ownedIds[1]]);
  assert.equal(typeof first.json().nextCursor, "string");

  const second = await app.inject({
    method: "GET",
    url: `/v1/openvtc/companion/activity?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    headers: headersFor(identity),
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json().activities.map((item: { id: string }) => item.id), [ownedIds[0]]);
  assert.equal(second.json().nextCursor, null);

  const serialized = JSON.stringify([first.json(), second.json()]);
  for (const prohibited of [
    "first-private-body",
    "second-private-body",
    "third-private-body",
    "cross-owner-private-body",
    "private-agent-identifier",
    "private-correlation",
    "private-nonce",
    "operationDigest",
    "arguments",
    "policyHash",
    workspace.id,
  ]) {
    assert.ok(!serialized.includes(prohibited), `activity projection exposed ${prohibited}`);
  }

  const detail = await app.inject({
    method: "GET",
    url: `/v1/openvtc/companion/activity/${ownedIds[2]}`,
    headers: headersFor(identity),
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().activity.request.action, "Send email");
  assert.equal(detail.json().activity.request.summary, "Send a prepared email");
  assert.deepEqual(detail.json().timeline.map((event: { label: string }) => event.label), ["Approval requested"]);
  assert.ok(!JSON.stringify(detail.json()).includes("third-private-body"));

  const crossOwner = await app.inject({
    method: "GET",
    url: `/v1/openvtc/companion/activity/${ownedIds[2]}`,
    headers: headersFor(otherIdentity),
  });
  assert.equal(crossOwner.statusCode, 404);

  const invalidCursor = await app.inject({
    method: "GET",
    url: "/v1/openvtc/companion/activity?cursor=not-a-cursor",
    headers: headersFor(identity),
  });
  assert.equal(invalidCursor.statusCode, 400);
  assert.equal(invalidCursor.json().error.code, "INVALID_ACTIVITY_CURSOR");
  await app.close();
});

test("companion activity exposes a whitelisted human-readable request audit", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", "activity-workspace");
  const createdAt = new Date(Date.now() + 60_000);
  const operation = await store.createGovernedOperation({
    id: "00000000-0000-4000-8000-000000000010",
    identity,
    workspaceId: workspace.id,
    agentId: "workspace-agent:codex-cli",
    capabilityId: "m365.send-chat-message",
    serverName: "lemmacomputer_ms365",
    toolName: "send-chat-message",
    schemaId: "lemmacomputer.m365.send-chat-message.v1",
    arguments: {
      chatId: "opaque-chat-id-that-must-not-be-projected",
      lemmacomputerAudit: { target: "Alex Morgan", targetType: "chat" },
      body: { body: { contentType: "html", content: "<p>Hello <strong>Alex</strong>,</p><p>The report is ready.</p>" } },
      confirm: true,
    },
    operationDigest: "d".repeat(64),
    nonce: "private-nonce",
    safeSummary: "Send Teams chat message to Alex Morgan",
    resourceName: "Alex Morgan",
    resourceLocation: "Microsoft Teams",
    correlationId: "private-correlation",
    idempotencyKey: "activity-audit-details",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
  });
  assert.ok(operation);

  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, { testIdentityMode: true });
  const list = await app.inject({
    method: "GET",
    url: "/v1/openvtc/companion/activity",
    headers: headersFor(identity),
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().activities[0].request.details, []);
  assert.ok(!JSON.stringify(list.json()).includes("The report is ready"));

  const detail = await app.inject({
    method: "GET",
    url: `/v1/openvtc/companion/activity/${operation.id}`,
    headers: headersFor(identity),
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().activity.request.action, "Send Teams message");
  assert.deepEqual(detail.json().activity.request.target, { label: "Chat", name: "Alex Morgan", context: "Microsoft Teams" });
  assert.equal(detail.json().activity.audit.requestedBy, "Codex CLI");
  assert.deepEqual(detail.json().activity.request.details, [
    { label: "Message", value: "Hello Alex,\n\nThe report is ready.", format: "long-text" },
  ]);
  assert.ok(!JSON.stringify(detail.json()).includes("opaque-chat-id-that-must-not-be-projected"));
  await app.close();
});

test("the normalized request and audit model applies across mail, calendar, and OneDrive", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", "activity-workspace");
  const createdAt = new Date(Date.now() + 60_000);
  const fixtures = [
    {
      id: "00000000-0000-4000-8000-000000000020",
      toolName: "send-mail",
      safeSummary: "Send email: Finance team",
      resourceName: "Finance team",
      resourceLocation: "Outlook Mail",
      arguments: {
        lemmacomputerAudit: { target: "Finance team", targetType: "recipient" },
        body: { Message: {
          subject: "Quarterly close",
          body: { contentType: "text", content: "The close is complete." },
          toRecipients: [{ emailAddress: { name: "Finance", address: "finance@example.test" } }],
        } },
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000021",
      toolName: "create-calendar-event",
      safeSummary: "Create calendar event: Quarterly review",
      resourceName: "Quarterly review",
      resourceLocation: "Outlook Calendar",
      arguments: {
        lemmacomputerAudit: { target: "Quarterly review", targetType: "event" },
        body: {
          subject: "Quarterly review",
          start: { dateTime: "2026-07-30T10:00:00", timeZone: "Singapore Standard Time" },
          end: { dateTime: "2026-07-30T10:30:00", timeZone: "Singapore Standard Time" },
        },
      },
    },
    {
      id: "00000000-0000-4000-8000-000000000022",
      toolName: "create-onedrive-folder",
      safeSummary: "Create OneDrive folder: Board reports",
      resourceName: "Board reports",
      resourceLocation: "OneDrive",
      arguments: {
        lemmacomputerAudit: { target: "Board reports", targetType: "folder" },
        driveId: "opaque-drive",
        driveItemId: "opaque-parent",
        body: { name: "Board reports", folder: {} },
      },
    },
  ];
  for (const fixture of fixtures) {
    const operation = await store.createGovernedOperation({
      ...fixture,
      identity,
      workspaceId: workspace.id,
      agentId: "workspace-agent:codex-cli",
      capabilityId: `m365.${fixture.toolName}`,
      serverName: "lemmacomputer_ms365",
      schemaId: `lemmacomputer.m365.${fixture.toolName}.v1`,
      operationDigest: "d".repeat(64),
      nonce: `private-nonce-${fixture.id}`,
      correlationId: `private-correlation-${fixture.id}`,
      idempotencyKey: `activity-${fixture.id}`,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
    });
    assert.ok(operation);
  }

  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, { testIdentityMode: true });
  const details = await Promise.all(fixtures.map(async (fixture) => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/openvtc/companion/activity/${fixture.id}`,
      headers: headersFor(identity),
    });
    assert.equal(response.statusCode, 200);
    return response.json().activity;
  }));
  assert.deepEqual(details[0].request.target, { label: "To", name: "Finance <finance@example.test>", context: "Outlook Mail" });
  assert.deepEqual(details[0].request.details, [
    { label: "Subject", value: "Quarterly close" },
    { label: "Message", value: "The close is complete.", format: "long-text" },
  ]);
  assert.deepEqual(details[1].request.target, { label: "Event", name: "Quarterly review", context: "Outlook Calendar" });
  assert.ok(details[1].request.details.some((field: { label: string }) => field.label === "Starts"));
  assert.deepEqual(details[2].request.target, { label: "Folder", name: "Board reports", context: "OneDrive" });
  assert.deepEqual(details[2].request.details, [{ label: "Name", value: "Board reports" }]);
  for (const activity of details) {
    assert.deepEqual(Object.keys(activity).sort(), ["audit", "id", "request", "state"]);
    assert.equal(activity.audit.requestedBy, "Codex CLI");
  }
  await app.close();
});
