import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { m365ToolCatalog, type IdentityContext, type McpPolicyRequest } from "@onecomputer/contracts";
import type { GovernedToolExecutor } from "@onecomputer/litellm-adapter";
import { MemoryWorkspaceStore, type EffectivePolicy, type IdentityPolicyStore, type SessionPrincipal } from "@onecomputer/workspace-store";
import { McpPolicyService, m365CapabilityDefinitions, type HostedToolPolicy } from "../apps/control-api/src/mcp-policy.js";
import { FixtureApprovalAuthority, GovernedOperationService } from "../apps/control-api/src/operations.js";

const identity: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "onecomputer-control" };
const agentId = randomUUID();
const policyVersionId = randomUUID();
const policyHash = "a".repeat(64);

const setup = async (hostedToolPolicy?: (identity: IdentityContext, serverName: string, toolName: string) => Promise<HostedToolPolicy | null>) => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", randomUUID());
  await store.update(workspace.id, { state: "ready" });
  const principal: SessionPrincipal = {
    userId: identity.subjectId,
    tenantId: identity.tenantId,
    email: "alex@metech.dev",
    displayName: "Alex",
    tenantDisplayName: "ME TECH",
    roles: ["employee"],
    identity,
  };
  const effective: EffectivePolicy = {
    assignmentId: randomUUID(),
    policyBundleId: "mvp-standard:acme",
    policyVersionId,
    version: 2,
    documentHash: policyHash,
    assignedBy: "admin",
    assignedAt: new Date().toISOString(),
    agentId,
    vendorUserId: "oc-user-alex",
    document: {
      schemaVersion: 1,
      workspaceProfile: "kasm-persistent-standard",
      agentProfile: "onecomputer-default-agent",
      modelAliases: ["onecomputer-assistant"],
      networkProfile: "controlled-egress-v1",
      mcp: { servers: { onecomputer_ms365: { tools: ["list-mail-folders", "list-calendars", "get-calendar-view", "list-drives", "search-onedrive-files", "get-drive-item", "delete-onedrive-file", "list-chats", "list-joined-teams", "send-chat-message"] } } },
      capabilities: ["m365-read", "onedrive-delete-protected"],
      protectedOperations: { "onedrive-delete-protected": "approval_required", defaultWrite: "deny" },
    },
  };
  const identityPolicies = {
    getPrincipal: async (userId) => userId === principal.userId ? principal : null,
    getEffectivePolicy: async (userId) => userId === principal.userId ? effective : null,
  } as unknown as IdentityPolicyStore;
  const executor = { executeGovernedTool: async () => ({ upstreamReference: "unused", resultSummary: "unused", result: {} }) } as GovernedToolExecutor;
  const operations = new GovernedOperationService(store, executor, new FixtureApprovalAuthority("mcp-policy-fixture-secret-at-least-32-characters"));
  const policy = new McpPolicyService(identityPolicies, store, operations, hostedToolPolicy);
  const base: McpPolicyRequest = {
    schemaVersion: 1,
    tenantId: identity.tenantId,
    subjectId: identity.subjectId,
    workspaceId: workspace.id,
    agentId,
    policyVersionId,
    policyHash,
    operationId: null,
    operationDigest: null,
    leaseId: null,
    serverId: "9885e7f76089931fc5365104183af8ea",
    serverName: "onecomputer_ms365",
    toolName: "list-mail-folders",
    arguments: {},
  };
  return { store, workspace, policy, base, effective, operations };
};

test("hosted connector policy defaults can allow, block, or hold an exact tool for approval", async () => {
  let decision: HostedToolPolicy["decision"] = "allow";
  const hosted = async (_identity: IdentityContext, serverName: string, toolName: string): Promise<HostedToolPolicy | null> => (
    serverName === "onecomputer_linear" ? {
      connectorId: "linear",
      connectorName: "Linear",
      serverId: "onecomputer_linear",
      serverName,
      toolName,
      displayName: "Create Issue",
      decision,
    } : null
  );
  const { policy, base, store } = await setup(hosted);
  const request: McpPolicyRequest = {
    ...base,
    serverId: "onecomputer_linear",
    serverName: "onecomputer_linear",
    toolName: "create_issue",
    arguments: { title: "Investigate connector policy" },
  };
  assert.equal((await policy.authorize(request, "hosted-allow")).decision, "allow");
  const second = await store.createOrGet(identity, "workspace-hosted", randomUUID());
  await store.update(second.id, { state: "ready" });
  assert.equal((await policy.authorize({
    ...request,
    workspaceId: second.id,
  }, "hosted-second-owned-workspace")).decision, "allow");
  decision = "deny";
  assert.equal((await policy.authorize(request, "hosted-deny")).code, "MCP_TOOL_BLOCKED_BY_POLICY");
  decision = "approval_required";
  const held = await policy.authorize(request, "hosted-approval");
  assert.equal(held.decision, "approval_required");
  const operation = await store.getOwnedOperation(identity, held.operationId!);
  assert.equal(operation?.serverName, "onecomputer_linear");
  assert.equal(operation?.toolName, "create_issue");
  assert.equal(operation?.resourceLocation, "Linear");
  assert.equal((await policy.authorize({ ...request, serverId: "another_server" }, "hosted-server-mutation")).code, "MCP_TOOL_NOT_GOVERNED");
});

test("the curated Microsoft 365 surface is complete and defaults every write to approval", () => {
  assert.equal(Object.keys(m365ToolCatalog).length, 38);
  assert.deepEqual(Object.keys(m365CapabilityDefinitions).sort(), Object.keys(m365ToolCatalog).sort());
  assert.equal(Object.values(m365ToolCatalog).filter((tool) => tool.risk === "read" && tool.decision === "allow").length, 17);
  assert.equal(Object.values(m365ToolCatalog).filter((tool) => tool.risk === "write" && tool.decision === "approval_required").length, 21);
});

test("upload-file-content rejects Graph endpoint wrappers before approval", () => {
  const upload = m365CapabilityDefinitions["upload-file-content"];
  assert.throws(
    () => upload.parse({
      driveId: "drive",
      driveItemId: "/items/root:/happy.txt:/content",
      body: "aGFwcHk=",
      onecomputerAudit: { target: "happy.txt", targetType: "file" },
    }),
    /driveItemId must be an item ID or drive-relative path selector/,
  );
  assert.deepEqual(upload.parse({
    driveId: "drive",
    driveItemId: "root:/happy.txt:",
    body: "aGFwcHk=",
    onecomputerAudit: { target: "happy.txt", targetType: "file" },
  }), {
    driveId: "drive",
    driveItemId: "root:/happy.txt:",
    body: "aGFwcHk=",
    onecomputerAudit: { target: "happy.txt", targetType: "file" },
  });
});

test("Control permits only a bounded explicit Calendar view", async () => {
  const { policy, base } = await setup();
  const request = {
    ...base,
    toolName: "get-calendar-view",
    arguments: {
      startDateTime: "2026-07-22T09:00:00+08:00",
      endDateTime: "2026-07-29T09:00:00+08:00",
      top: 3,
      timezone: "Asia/Singapore",
    },
  };
  assert.equal((await policy.authorize(request, "calendar-upcoming")).decision, "allow");
  assert.equal((await policy.authorize({ ...request, arguments: { ...request.arguments, endDateTime: "2026-07-22T08:00:00+08:00" } }, "calendar-reversed")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  assert.equal((await policy.authorize({ ...request, arguments: { ...request.arguments, endDateTime: "2027-01-22T09:00:00+08:00" } }, "calendar-over-broad")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  assert.equal((await policy.authorize({ ...request, arguments: { ...request.arguments, fetchAllPages: true } }, "calendar-fetch-all")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
});

test("Control auto-allows only an exact assigned bounded Microsoft 365 read", async () => {
  const { policy, base } = await setup();
  assert.equal((await policy.authorize(base, "read-allow")).decision, "allow");
  assert.equal((await policy.authorize({ ...base, arguments: { top: 25 } }, "read-limit")).decision, "allow");
  assert.equal((await policy.authorize({ ...base, arguments: { top: 26 } }, "read-over-limit")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  assert.equal((await policy.authorize({ ...base, arguments: { fetchAllPages: true } }, "read-over-broad")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  assert.equal((await policy.authorize({ ...base, policyHash: "b".repeat(64) }, "read-policy-mutation")).code, "MCP_POLICY_BINDING_MISMATCH");
  assert.equal((await policy.authorize({ ...base, serverName: "attacker" }, "read-server-mutation")).code, "MCP_TOOL_NOT_GOVERNED");
});

test("one user-scoped connector policy serves every owned workspace but no foreign workspace", async () => {
  const { store, policy, base } = await setup();
  const second = await store.createOrGet(identity, "workspace-research", randomUUID());
  await store.update(second.id, { state: "ready" });

  assert.equal((await policy.authorize({
    ...base,
    workspaceId: second.id,
    toolName: "list-drives",
    arguments: { top: 2 },
  }, "second-owned-workspace")).decision, "allow");
  assert.equal((await policy.authorize({
    ...base,
    toolName: "list-drives",
    arguments: { top: 2 },
  }, "first-owned-workspace")).decision, "allow");

  const foreignIdentity: IdentityContext = {
    tenantId: identity.tenantId,
    subjectId: "mallory",
    audience: "onecomputer-control",
  };
  const foreign = await store.createOrGet(foreignIdentity, "workspace-research", randomUUID());
  await store.update(foreign.id, { state: "ready" });
  assert.equal((await policy.authorize({
    ...base,
    workspaceId: foreign.id,
    toolName: "list-drives",
    arguments: { top: 2 },
  }, "foreign-workspace")).code, "MCP_POLICY_NOT_ASSIGNED");
});

test("Control permits bounded OneDrive discovery but rejects broad search", async () => {
  const { policy, base } = await setup();
  assert.equal((await policy.authorize({
    ...base,
    toolName: "list-drives",
    arguments: { top: 2 },
  }, "drive-list")).decision, "allow");
  assert.equal((await policy.authorize({
    ...base,
    toolName: "list-drives",
    arguments: { top: 1 },
  }, "drive-list-empty-page")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  const request = { ...base, toolName: "search-onedrive-files", arguments: { driveId: "drive-1", q: "disposable", select: "id,name,eTag,parentReference", top: 10 } };
  assert.equal((await policy.authorize(request, "drive-search")).decision, "allow");
  assert.equal((await policy.authorize({ ...request, arguments: { ...request.arguments, top: 11 } }, "drive-search-over-limit")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  assert.equal((await policy.authorize({ ...request, arguments: { ...request.arguments, select: "*" } }, "drive-search-over-broad-select")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  assert.equal((await policy.authorize({ ...request, arguments: { ...request.arguments, skip: 10 } }, "drive-search-extra-argument")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
});

test("Control permits only the exact version metadata projection for a drive item", async () => {
  const { policy, base } = await setup();
  const request = {
    ...base,
    toolName: "get-drive-item",
    arguments: {
      driveId: "drive-1",
      driveItemId: "item-1",
      includeHeaders: true,
      select: "id,name,eTag,parentReference",
    },
  };
  assert.equal((await policy.authorize(request, "drive-item-metadata")).decision, "allow");
  assert.equal((await policy.authorize({ ...request, arguments: { ...request.arguments, includeHeaders: false } }, "drive-item-no-headers")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  assert.equal((await policy.authorize({ ...request, arguments: { ...request.arguments, select: "*" } }, "drive-item-broad-select")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
});

test("Teams reads are bounded and Teams sends are held for approval", async () => {
  const { store, policy, base } = await setup();
  assert.equal((await policy.authorize({ ...base, toolName: "list-chats", arguments: { top: 10 } }, "teams-list")).decision, "allow");
  assert.equal((await policy.authorize({ ...base, toolName: "list-chats", arguments: { fetchAllPages: true } }, "teams-list-broad")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
  assert.equal((await policy.authorize({ ...base, toolName: "list-joined-teams", arguments: {} }, "teams-joined")).decision, "allow");
  assert.equal(
    (await policy.authorize({ ...base, toolName: "list-joined-teams", arguments: { top: 10 } }, "teams-joined-top")).code,
    "MCP_ARGUMENTS_OUT_OF_POLICY",
  );

  const held = await policy.authorize({
    ...base,
    toolName: "send-chat-message",
    arguments: { chatId: "chat-1", onecomputerAudit: { target: "Alex Morgan", targetType: "recipient" }, body: { body: { contentType: "html", content: "Hello" } }, confirm: true },
  }, "teams-send");
  assert.equal(held.decision, "approval_required");
  const operation = await store.getOwnedOperation(identity, held.operationId!);
  assert.equal(operation?.toolName, "send-chat-message");
  assert.equal((operation?.arguments as Record<string, unknown>).confirm, true);
  assert.equal((await policy.authorize({
    ...base,
    toolName: "send-chat-message",
    arguments: { chatId: "chat-1", onecomputerAudit: { target: "Alex Morgan", targetType: "recipient" }, body: { body: { contentType: "text", content: "Hello" } }, confirm: true },
  }, "teams-send-text")).code, "MCP_ARGUMENTS_OUT_OF_POLICY");
});

test("Control treats Softeria confirmation as a connector flag, not a policy decision", async () => {
  const { policy, base, effective } = await setup();
  effective.document.mcp.servers.onecomputer_ms365.tools.push("create-calendar-event");
  effective.document.mcp.servers.onecomputer_ms365.toolPolicies = {
    ...effective.document.mcp.servers.onecomputer_ms365.toolPolicies,
    "create-calendar-event": "allow",
  };

  const decision = await policy.authorize({
    ...base,
    toolName: "create-calendar-event",
    arguments: {
      body: {
        subject: "OC-MVP-ALLOW",
        start: { dateTime: "2026-07-23T15:00:00", timeZone: "Singapore Standard Time" },
        end: { dateTime: "2026-07-23T15:15:00", timeZone: "Singapore Standard Time" },
      },
      onecomputerAudit: { target: "OC-MVP-ALLOW", targetType: "event" },
      confirm: true,
    },
  }, "calendar-write-allow");

  assert.equal(decision.decision, "allow");
  assert.equal(decision.code, "MCP_POLICY_ALLOWED");
});

test("the effective per-tool policy can require approval or deny an otherwise bounded read", async () => {
  const { store, policy, base, effective, operations } = await setup();
  effective.document.mcp.servers.onecomputer_ms365.toolPolicies = {
    "list-mail-folders": "approval_required",
    "list-calendars": "deny",
    "list-drives": "allow",
    "search-onedrive-files": "allow",
    "get-drive-item": "allow",
    "delete-onedrive-file": "approval_required",
  };

  const held = await policy.authorize(base, "read-requires-approval");
  assert.equal(held.decision, "approval_required");
  assert.ok(held.operationId);
  assert.equal((await store.getOwnedOperation(identity, held.operationId!))?.toolName, "list-mail-folders");
  const agentView = await operations.getForAgent(identity, held.operationId!, {
    workspaceId: base.workspaceId,
    agentId: base.agentId,
  });
  assert.equal(agentView.policyVersionId, base.policyVersionId);
  assert.equal(agentView.policyHash, base.policyHash);
  await assert.rejects(
    operations.getForAgent(identity, held.operationId!, { workspaceId: base.workspaceId, agentId: "another-agent" }),
    /Governed operation not found/,
  );

  const blocked = await policy.authorize({ ...base, toolName: "list-calendars" }, "read-denied");
  assert.equal(blocked.decision, "deny");
  assert.equal(blocked.code, "MCP_TOOL_BLOCKED_BY_POLICY");
});

test("a policy edit affects new calls without mutating an already-bound operation", async () => {
  const { store, policy, base, effective, operations } = await setup();
  effective.document.mcp.servers.onecomputer_ms365.toolPolicies = {
    ...effective.document.mcp.servers.onecomputer_ms365.toolPolicies,
    "list-mail-folders": "approval_required",
  };

  const held = await policy.authorize(base, "policy-v1-held");
  assert.equal(held.decision, "approval_required");
  const original = await store.getOwnedOperation(identity, held.operationId!);
  assert.equal(original?.policyVersionId, policyVersionId);
  assert.equal(original?.policyHash, policyHash);

  const nextPolicyVersionId = randomUUID();
  const nextPolicyHash = "b".repeat(64);
  effective.policyVersionId = nextPolicyVersionId;
  effective.version = 3;
  effective.documentHash = nextPolicyHash;
  effective.document.mcp.servers.onecomputer_ms365.toolPolicies["list-mail-folders"] = "deny";

  const next = await policy.authorize({
    ...base,
    policyVersionId: nextPolicyVersionId,
    policyHash: nextPolicyHash,
  }, "policy-v2-blocked");
  assert.equal(next.decision, "deny");
  assert.equal(next.code, "MCP_TOOL_BLOCKED_BY_POLICY");

  const unchanged = await store.getOwnedOperation(identity, held.operationId!);
  assert.equal(unchanged?.policyVersionId, policyVersionId);
  assert.equal(unchanged?.policyHash, policyHash);
  assert.equal(unchanged?.state, "approval_required");
  assert.equal((await operations.getForAgent(identity, held.operationId!, {
    workspaceId: base.workspaceId,
    agentId: base.agentId,
  })).policyVersionId, policyVersionId);
  // Operation status is read-only and remains visible to the same
  // workspace/agent after policy rotation. The operation itself stays bound
  // to the immutable policy version/hash captured above.
  assert.equal((await operations.getForAgent(identity, held.operationId!, {
    workspaceId: base.workspaceId,
    agentId: base.agentId,
  })).policyHash, policyHash);
});

test("protected OneDrive delete persists before approval and an exact lease dispatches once", async () => {
  const { store, policy, base } = await setup();
  const requested = await policy.authorize({
    ...base,
    toolName: "delete-onedrive-file",
    arguments: { driveId: "drive-1", driveItemId: "item-1", "If-Match": "etag-1", onecomputerAudit: { target: "Q3 draft.docx", targetType: "file" } },
  }, "delete-request");
  assert.equal(requested.decision, "approval_required");
  assert.ok(requested.operationId);
  const operation = await store.getOwnedOperation(identity, requested.operationId!);
  assert.deepEqual(operation?.arguments, {
    "If-Match": "etag-1",
    confirm: true,
    driveId: "drive-1",
    driveItemId: "item-1",
    excludeResponse: true,
    onecomputerAudit: { target: "Q3 draft.docx", targetType: "file" },
  });

  const decidedAt = new Date();
  await store.recordApproval({
    identity,
    operationId: operation!.id,
    approvalId: randomUUID(),
    decision: "approve",
    channel: "local-fixture",
    issuer: "onecomputer-local-fixture",
    keyId: "fixture-hmac-v1",
    operationDigest: operation!.operationDigest,
    nonce: operation!.nonce,
    proofHash: "c".repeat(64),
    issuedAt: decidedAt,
    expiresAt: new Date(decidedAt.getTime() + 30_000),
    decidedAt,
    correlationId: "approve",
  });
  const leaseId = randomUUID();
  await store.claimExecution(identity, operation!.id, leaseId, new Date(Date.now() + 30_000), "lease");
  const executionRequest: McpPolicyRequest = {
    ...base,
    toolName: "delete-onedrive-file",
    arguments: operation!.arguments,
    agentId,
    operationId: operation!.id,
    operationDigest: operation!.operationDigest,
    leaseId,
  };
  assert.equal((await policy.authorize(executionRequest, "dispatch-1")).decision, "allow");
  assert.equal((await policy.authorize(executionRequest, "dispatch-replay")).code, "MCP_EXECUTION_BINDING_INVALID");
  assert.equal((await policy.authorize({ ...executionRequest, arguments: { ...operation!.arguments as object, driveItemId: "mutated" } }, "dispatch-mutation")).code, "MCP_EXECUTION_BINDING_INVALID");
});

test("a repeated protected MCP action reuses the active approval and replaces a terminal attempt", async () => {
  const { store, policy, base } = await setup();
  const request: McpPolicyRequest = {
    ...base,
    toolName: "delete-onedrive-file",
    arguments: { driveId: "drive-1", driveItemId: "item-1", "If-Match": "etag-1", onecomputerAudit: { target: "Q3 draft.docx", targetType: "file" } },
  };

  const first = await policy.authorize(request, "delete-attempt-1");
  const second = await policy.authorize(request, "delete-attempt-2");

  assert.equal(first.decision, "approval_required");
  assert.equal(second.decision, "approval_required");
  assert.ok(first.operationId);
  assert.ok(second.operationId);
  assert.equal(second.operationId, first.operationId);
  assert.equal((await store.getOwnedOperation(identity, first.operationId!))?.state, "approval_required");

  const internals = store as unknown as { operations: Map<string, Record<string, unknown>> };
  internals.operations.set(first.operationId!, {
    ...internals.operations.get(first.operationId!)!,
    state: "expired",
  });
  const third = await policy.authorize(request, "delete-attempt-3");
  assert.equal(third.decision, "approval_required");
  assert.ok(third.operationId);
  assert.notEqual(third.operationId, first.operationId);
  assert.equal((await store.getOwnedOperation(identity, third.operationId!))?.state, "approval_required");
});
