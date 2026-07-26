import { createHash, randomUUID } from "node:crypto";
import {
  OneComputerError,
  canonicalJson,
  m365ToolCatalog,
  ownedAgentCatalog,
  type IdentityContext,
  type McpPolicyDecision,
  type McpPolicyRequest,
  type OwnedJson,
} from "@onecomputer/contracts";
import { runtimePolicyFor, type GovernanceStore, type IdentityPolicyStore, type WorkspaceStore } from "@onecomputer/workspace-store";
import { z } from "zod";
import type { GovernedOperationService } from "./operations.js";

const boundedListArguments = z.strictObject({
  top: z.number().int().min(1).max(25).optional(),
  skip: z.number().int().min(0).max(1000).optional(),
  select: z.string().trim().min(1).max(256).optional(),
  filter: z.string().trim().min(1).max(512).optional(),
  search: z.string().trim().min(1).max(256).optional(),
  orderby: z.string().trim().min(1).max(128).optional(),
  count: z.boolean().optional(),
});
const listDrivesArguments = boundedListArguments.extend({
  top: z.number().int().min(2).max(25).optional(),
});

const calendarViewArguments = boundedListArguments.extend({
  startDateTime: z.string().datetime({ offset: true }),
  endDateTime: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(64).optional(),
}).superRefine((value, context) => {
  const start = Date.parse(value.startDateTime);
  const end = Date.parse(value.endDateTime);
  if (end <= start) {
    context.addIssue({ code: "custom", path: ["endDateTime"], message: "Calendar view end must be after start" });
  }
  if (end - start > 93 * 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", path: ["endDateTime"], message: "Calendar view cannot exceed 93 days" });
  }
});

const id = z.string().trim().min(1).max(512);
const uploadDriveItemId = id.refine(
  (value) => !/^(?:\/?items\/|\/?drives\/|https?:\/\/)/i.test(value) && !value.endsWith("/content"),
  "driveItemId must be an item ID or drive-relative path selector without Graph endpoint wrappers",
);
const body = z.record(z.string().min(1).max(128), z.json());
const noArguments = z.strictObject({});
const teamsMessageBody = z.strictObject({
  body: z.strictObject({
    contentType: z.literal("html"),
    content: z.string().trim().min(1).max(28_000),
  }),
});
const withId = (key: string) => z.strictObject({ [key]: id });
const withBody = z.strictObject({ body });
const withIdAndBody = (key: string) => z.strictObject({ [key]: id, body });
const withTwoIds = (first: string, second: string) => z.strictObject({ [first]: id, [second]: id });
const withTwoIdsAndBody = (first: string, second: string) => z.strictObject({ [first]: id, [second]: id, body });

const boundedDriveSearchArguments = z.strictObject({
  driveId: z.string().trim().min(1).max(512),
  q: z.string().trim().min(1).max(128),
  select: z.literal("id,name,eTag,parentReference").optional(),
  top: z.number().int().min(1).max(10).optional(),
});

const driveItemMetadataArguments = z.strictObject({
  driveId: z.string().trim().min(1).max(512),
  driveItemId: z.string().trim().min(1).max(512),
  includeHeaders: z.literal(true),
  select: z.literal("id,name,eTag,parentReference"),
});

const deleteRequestArguments = z.strictObject({
  driveId: z.string().trim().min(1).max(512),
  driveItemId: z.string().trim().min(1).max(512),
  "If-Match": z.string().trim().min(1).max(512),
  confirm: z.literal(false).optional(),
});

type CapabilityDefinition = {
  capabilityId: string;
  schemaId: string;
  schemaHash: string;
  displayName: string;
  description: string;
  risk: "read" | "write";
  service: "mail" | "calendar" | "onedrive" | "teams";
  mode: "allow" | "approval_required";
  parse: (argumentsValue: OwnedJson) => Record<string, OwnedJson>;
};

export type HostedToolPolicy = {
  connectorId: string;
  connectorName: string;
  serverId: string;
  serverName: string;
  toolName: string;
  displayName: string;
  decision: "allow" | "approval_required" | "deny";
};

const definition = (
  capabilityId: string,
  schemaId: string,
  displayName: string,
  description: string,
  service: CapabilityDefinition["service"],
  risk: CapabilityDefinition["risk"],
  mode: CapabilityDefinition["mode"],
  schema: z.ZodType<Record<string, OwnedJson>>,
): CapabilityDefinition => ({
  capabilityId,
  schemaId,
  displayName,
  description,
  service,
  risk,
  schemaHash: createHash("sha256").update(canonicalJson({ schemaId, jsonSchema: z.toJSONSchema(schema) })).digest("hex"),
  mode,
  parse: (value) => schema.parse(value),
});

const toolSchemas: Record<keyof typeof m365ToolCatalog, z.ZodType<Record<string, OwnedJson>>> = {
  "list-mail-folders": boundedListArguments,
  "list-mail-messages": boundedListArguments,
  "get-mail-message": withId("messageId"),
  "create-draft-email": withBody,
  "update-mail-message": withIdAndBody("messageId"),
  "delete-mail-message": z.strictObject({ messageId: id, "If-Match": id.optional() }),
  "move-mail-message": withIdAndBody("messageId"),
  "send-mail": withBody,
  "send-draft-message": withId("messageId"),
  "reply-mail-message": withIdAndBody("messageId"),
  "reply-all-mail-message": withIdAndBody("messageId"),
  "forward-mail-message": withIdAndBody("messageId"),
  "list-calendars": boundedListArguments,
  "list-calendar-events": boundedListArguments.extend({ timezone: z.string().trim().min(1).max(64).optional() }),
  "get-calendar-view": calendarViewArguments,
  "get-calendar-event": withId("eventId"),
  "create-calendar-event": withBody,
  "update-calendar-event": withIdAndBody("eventId"),
  "delete-calendar-event": z.strictObject({ eventId: id, "If-Match": id.optional() }),
  "list-drives": listDrivesArguments,
  "get-drive-root-item": withId("driveId"),
  "list-folder-files": boundedListArguments.extend({ driveId: id, driveItemId: id }),
  "search-onedrive-files": boundedDriveSearchArguments,
  "get-drive-item": driveItemMetadataArguments,
  "create-onedrive-folder": withTwoIdsAndBody("driveId", "driveItemId"),
  "upload-file-content": z.strictObject({ driveId: id, driveItemId: uploadDriveItemId, body: z.string().min(1).max(5_600_000) }),
  "move-rename-onedrive-item": withTwoIdsAndBody("driveId", "driveItemId"),
  "copy-drive-item": withTwoIdsAndBody("driveId", "driveItemId"),
  "delete-onedrive-file": deleteRequestArguments,
  "list-chats": boundedListArguments,
  "list-chat-messages": boundedListArguments.extend({ chatId: id }),
  "list-joined-teams": noArguments,
  "list-team-channels": boundedListArguments.extend({ teamId: id }),
  "list-channel-messages": boundedListArguments.extend({ teamId: id, channelId: id }),
  "send-chat-message": z.strictObject({ chatId: id, body: teamsMessageBody }),
  "reply-to-chat-message": z.strictObject({ chatId: id, chatMessageId: id, body: teamsMessageBody }),
  "send-channel-message": z.strictObject({ teamId: id, channelId: id, body: teamsMessageBody }),
  "reply-to-channel-message": z.strictObject({ teamId: id, channelId: id, chatMessageId: id, body: teamsMessageBody }),
};

const displayNames: Record<keyof typeof m365ToolCatalog, string> = {
  "list-mail-folders": "List mail folders", "list-mail-messages": "List email messages", "get-mail-message": "Read email message",
  "create-draft-email": "Create email draft", "update-mail-message": "Update email", "delete-mail-message": "Delete email",
  "move-mail-message": "Move email", "send-mail": "Send email", "send-draft-message": "Send draft",
  "reply-mail-message": "Reply to email", "reply-all-mail-message": "Reply all", "forward-mail-message": "Forward email",
  "list-calendars": "List calendars", "list-calendar-events": "List calendar event series", "get-calendar-view": "Get upcoming calendar view", "get-calendar-event": "Read calendar event",
  "create-calendar-event": "Create calendar event", "update-calendar-event": "Update calendar event", "delete-calendar-event": "Delete calendar event",
  "list-drives": "List OneDrive drives", "get-drive-root-item": "Read drive root", "list-folder-files": "List folder files",
  "search-onedrive-files": "Search OneDrive", "get-drive-item": "Read OneDrive metadata", "create-onedrive-folder": "Create OneDrive folder",
  "upload-file-content": "Upload file content", "move-rename-onedrive-item": "Move or rename OneDrive item", "copy-drive-item": "Copy OneDrive item", "delete-onedrive-file": "Delete OneDrive file",
  "list-chats": "List Teams chats", "list-chat-messages": "Read Teams chat messages", "list-joined-teams": "List joined teams",
  "list-team-channels": "List team channels", "list-channel-messages": "Read channel messages", "send-chat-message": "Send Teams chat message",
  "reply-to-chat-message": "Reply in Teams chat", "send-channel-message": "Send channel message", "reply-to-channel-message": "Reply in Teams channel",
};

export const m365CapabilityDefinitions = Object.fromEntries(
  Object.entries(m365ToolCatalog).map(([name, metadata]) => [name, definition(
    `m365.${name}`,
    `onecomputer.m365.${name}.v1`,
    displayNames[name as keyof typeof m365ToolCatalog],
    metadata.risk === "read" ? `Read Microsoft 365 data using ${name}.` : `Change Microsoft 365 data using ${name}.`,
    metadata.service,
    metadata.risk,
    metadata.decision,
    toolSchemas[name as keyof typeof m365ToolCatalog],
  )]),
) as Record<keyof typeof m365ToolCatalog, CapabilityDefinition>;

export const m365LiteLlmServerId = createHash("sha256")
  .update("onecomputer_ms365|http://ms365-mcp:3000/mcp|http|oauth2|")
  .digest("hex")
  .slice(0, 32);

const denied = (code: string, capability?: CapabilityDefinition): McpPolicyDecision => ({
  schemaVersion: 1,
  decision: "deny",
  code,
  capabilityId: capability?.capabilityId ?? null,
  schemaId: capability?.schemaId ?? null,
  schemaHash: capability?.schemaHash ?? null,
  operationId: null,
});

export class McpPolicyService {
  constructor(
    private readonly identityPolicies: IdentityPolicyStore,
    private readonly governance: WorkspaceStore & GovernanceStore,
    private readonly operations: GovernedOperationService,
    private readonly hostedToolPolicy?: (identity: IdentityContext, serverName: string, toolName: string) => Promise<HostedToolPolicy | null>,
  ) {}

  async authorize(request: McpPolicyRequest, correlationId: string): Promise<McpPolicyDecision> {
    const capability = m365CapabilityDefinitions[request.toolName as keyof typeof m365CapabilityDefinitions];
    if (request.serverId !== m365LiteLlmServerId || request.serverName !== "onecomputer_ms365" || !capability) {
      return this.authorizeHosted(request, correlationId);
    }

    const identity: IdentityContext = {
      tenantId: request.tenantId,
      subjectId: request.subjectId,
      audience: "onecomputer-control",
    };
    const [principal, effectivePolicy, workspace] = await Promise.all([
      this.identityPolicies.getPrincipal(request.subjectId),
      this.identityPolicies.getEffectivePolicy(request.subjectId),
      this.governance.getOwned(identity, request.workspaceId),
    ]);
    if (!principal || principal.tenantId !== request.tenantId) return denied("MCP_IDENTITY_MISMATCH", capability);
    if (!effectivePolicy || !workspace) return denied("MCP_POLICY_NOT_ASSIGNED", capability);

    const runtime = runtimePolicyFor(effectivePolicy);
    const catalogRuntime = runtimePolicyFor(effectivePolicy, undefined, undefined, ownedAgentCatalog.map((agent) => agent.id));
    const allowedAgentIds = new Set([runtime.agentId, ...(catalogRuntime.agents?.map((agent) => agent.agentId) ?? [])]);
    // Connector credentials and effective policy are user-scoped. Workspace
    // isolation comes from the exact owned lookup above and from the
    // workspace/agent/policy metadata on the LiteLLM grant.
    const bindingMatches = allowedAgentIds.has(request.agentId)
      && runtime.policyVersionId === request.policyVersionId
      && runtime.policyHash === request.policyHash
      && runtime.mcpServer === request.serverName
      && runtime.allowedTools.includes(request.toolName);
    const isExecution = Boolean(request.operationId || request.operationDigest || request.leaseId);
    if (!bindingMatches && !isExecution) return denied("MCP_POLICY_BINDING_MISMATCH", capability);

    if (isExecution) {
      if (!request.operationId || !request.operationDigest || !request.leaseId) return denied("MCP_EXECUTION_BINDING_INCOMPLETE", capability);
      const claimed = await this.governance.claimToolDispatch(identity, {
        operationId: request.operationId,
        operationDigest: request.operationDigest,
        leaseId: request.leaseId,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: request.arguments,
        dispatchedAt: new Date(),
        correlationId,
      });
      return claimed ? {
        schemaVersion: 1,
        decision: "allow",
        code: "MCP_APPROVED_EXECUTION_LEASE",
        capabilityId: capability.capabilityId,
        schemaId: capability.schemaId,
        schemaHash: capability.schemaHash,
        operationId: request.operationId,
      } : denied("MCP_EXECUTION_BINDING_INVALID", capability);
    }

    let canonicalArguments: Record<string, OwnedJson>;
    try {
      // Softeria requires `confirm: true` before it will execute a write. That
      // connector guard is not a ONEComputer policy decision and must never
      // become part of the bound operation fingerprint. The managed bridge
      // supplies it for every write; Control removes it before validating the
      // user-controlled arguments and independently applies Allow / Approval /
      // Deny below.
      const policyArguments = capability.risk === "write"
        && request.arguments !== null
        && typeof request.arguments === "object"
        && !Array.isArray(request.arguments)
        ? Object.fromEntries(Object.entries(request.arguments).filter(([key]) => !["confirm", "excludeResponse"].includes(key)))
        : request.arguments;
      canonicalArguments = capability.parse(policyArguments);
    } catch {
      return denied("MCP_ARGUMENTS_OUT_OF_POLICY", capability);
    }

    const policyDecision = runtime.toolPolicies[request.toolName];
    if (!policyDecision) return denied("MCP_TOOL_NOT_ASSIGNED", capability);
    if (policyDecision === "deny") return denied("MCP_TOOL_BLOCKED_BY_POLICY", capability);
    if (policyDecision === "allow") return {
      schemaVersion: 1,
      decision: "allow",
      code: "MCP_POLICY_ALLOWED",
      capabilityId: capability.capabilityId,
      schemaId: capability.schemaId,
      schemaHash: capability.schemaHash,
      operationId: null,
    };

    const executionArguments: Record<string, OwnedJson> = capability.risk === "write"
      ? { ...canonicalArguments, confirm: true, ...(request.toolName === "delete-onedrive-file" ? { excludeResponse: true } : {}) }
      : canonicalArguments;
    const requestFingerprint = createHash("sha256").update(canonicalJson({
      tenantId: request.tenantId,
      subjectId: request.subjectId,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      policyVersionId: request.policyVersionId,
      toolName: request.toolName,
      arguments: canonicalArguments,
    })).digest("hex");
    const operation = await this.operations.createMicrosoft365Operation(
      identity,
      request.workspaceId,
      {
        capabilityId: capability.capabilityId,
        schemaId: capability.schemaId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: executionArguments,
        displayName: capability.displayName,
      },
      request.agentId,
      { policyVersionId: runtime.policyVersionId, policyHash: runtime.policyHash },
      // Reuse one active approval for an identical action. The store replaces
      // this stable slot only after denial, failure, or expiry.
      `mcp:${requestFingerprint}`,
      correlationId || randomUUID(),
      true,
    );
    return {
      schemaVersion: 1,
      decision: "approval_required",
      code: "MCP_APPROVAL_REQUIRED",
      capabilityId: capability.capabilityId,
      schemaId: capability.schemaId,
      schemaHash: capability.schemaHash,
      operationId: operation.id,
    };
  }

  private async authorizeHosted(request: McpPolicyRequest, correlationId: string): Promise<McpPolicyDecision> {
    if (!this.hostedToolPolicy) return denied("MCP_TOOL_NOT_GOVERNED");
    const identity: IdentityContext = {
      tenantId: request.tenantId,
      subjectId: request.subjectId,
      audience: "onecomputer-control",
    };
    const hosted = await this.hostedToolPolicy(identity, request.serverName, request.toolName);
    if (!hosted || hosted.serverId !== request.serverId) return denied("MCP_TOOL_NOT_GOVERNED");
    const capabilityId = `mcp.${hosted.connectorId}.${request.toolName}`.slice(0, 128);
    const schemaId = `onecomputer.mcp.${createHash("sha256").update(`${request.serverName}\0${request.toolName}`).digest("hex").slice(0, 32)}.v1`;
    const schemaHash = createHash("sha256").update(canonicalJson({
      schemaVersion: 1,
      serverName: request.serverName,
      toolName: request.toolName,
      arguments: "owned-json-object",
    })).digest("hex");
    const genericDecision = (
      decision: McpPolicyDecision["decision"],
      code: string,
      operationId: string | null = null,
    ): McpPolicyDecision => ({
      schemaVersion: 1,
      decision,
      code,
      capabilityId,
      schemaId,
      schemaHash,
      operationId,
    });
    const [principal, effectivePolicy, workspace] = await Promise.all([
      this.identityPolicies.getPrincipal(request.subjectId),
      this.identityPolicies.getEffectivePolicy(request.subjectId),
      this.governance.getOwned(identity, request.workspaceId),
    ]);
    if (!principal || principal.tenantId !== request.tenantId) return genericDecision("deny", "MCP_IDENTITY_MISMATCH");
    if (!effectivePolicy || !workspace) return genericDecision("deny", "MCP_POLICY_NOT_ASSIGNED");
    const runtime = runtimePolicyFor(effectivePolicy);
    const catalogRuntime = runtimePolicyFor(effectivePolicy, undefined, undefined, ownedAgentCatalog.map((agent) => agent.id));
    const allowedAgentIds = new Set([runtime.agentId, ...(catalogRuntime.agents?.map((agent) => agent.agentId) ?? [])]);
    const bindingMatches = allowedAgentIds.has(request.agentId)
      && runtime.policyVersionId === request.policyVersionId
      && runtime.policyHash === request.policyHash;
    const isExecution = Boolean(request.operationId || request.operationDigest || request.leaseId);
    if (!bindingMatches && !isExecution) return genericDecision("deny", "MCP_POLICY_BINDING_MISMATCH");
    if (isExecution) {
      if (!request.operationId || !request.operationDigest || !request.leaseId) {
        return genericDecision("deny", "MCP_EXECUTION_BINDING_INCOMPLETE");
      }
      const claimed = await this.governance.claimToolDispatch(identity, {
        operationId: request.operationId,
        operationDigest: request.operationDigest,
        leaseId: request.leaseId,
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: request.arguments,
        dispatchedAt: new Date(),
        correlationId,
      });
      return claimed
        ? genericDecision("allow", "MCP_APPROVED_EXECUTION_LEASE", request.operationId)
        : genericDecision("deny", "MCP_EXECUTION_BINDING_INVALID");
    }
    if (hosted.decision === "deny") return genericDecision("deny", "MCP_TOOL_BLOCKED_BY_POLICY");
    if (hosted.decision === "allow") return genericDecision("allow", "MCP_POLICY_ALLOWED");
    if (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
      return genericDecision("deny", "MCP_ARGUMENTS_OUT_OF_POLICY");
    }
    const requestFingerprint = createHash("sha256").update(canonicalJson({
      tenantId: request.tenantId,
      subjectId: request.subjectId,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      policyVersionId: request.policyVersionId,
      serverName: request.serverName,
      toolName: request.toolName,
      arguments: request.arguments,
    })).digest("hex");
    const operation = await this.operations.createMicrosoft365Operation(
      identity,
      request.workspaceId,
      {
        capabilityId,
        schemaId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: request.arguments,
        displayName: hosted.displayName,
        safeSummary: `${hosted.displayName} in ${hosted.connectorName}`,
        resourceName: hosted.displayName,
        resourceLocation: hosted.connectorName,
      },
      request.agentId,
      { policyVersionId: runtime.policyVersionId, policyHash: runtime.policyHash },
      `mcp:${requestFingerprint}`,
      correlationId || randomUUID(),
      true,
    );
    return genericDecision("approval_required", "MCP_APPROVAL_REQUIRED", operation.id);
  }
}

export const requireMcpPolicyAllow = (decision: McpPolicyDecision) => {
  if (decision.decision !== "allow") throw new OneComputerError(decision.code, "The Microsoft 365 tool call is not approved for execution", 403);
  return decision;
};
