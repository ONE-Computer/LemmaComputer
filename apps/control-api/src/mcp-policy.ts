import { createHash, randomUUID } from "node:crypto";
import {
  LemmaComputerError,
  canonicalJson,
  m365ToolCatalog,
  ownedAgentCatalog,
  type IdentityContext,
  type McpPolicyDecision,
  type McpPolicyRequest,
  type OwnedJson,
} from "@lemmacomputer/contracts";
import { runtimePolicyFor, type GovernanceStore, type IdentityPolicyStore, type WorkspaceStore } from "@lemmacomputer/workspace-store";
import { z } from "zod";
import type { GovernedOperationService } from "./operations.js";

const boundedListArguments = z.strictObject({
  top: z.number().int().min(1).max(25).optional(),
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
const noArguments = z.strictObject({});
const teamsMessageBody = z.strictObject({
  body: z.strictObject({
    contentType: z.literal("html"),
    content: z.string().trim().min(1).max(28_000),
  }),
});
const operationAuditContext = z.strictObject({
  target: z.string().trim().min(1).max(512),
  targetType: z.enum(["recipient", "chat", "channel", "file", "folder", "event", "message", "item", "destination"]),
});
type OperationAuditTargetType = z.infer<typeof operationAuditContext>["targetType"];

const governedTargetType: Partial<Record<string, OperationAuditTargetType>> = Object.freeze({
  "send-chat-message": "chat",
  "reply-to-chat-message": "chat",
  "send-channel-message": "channel",
  "reply-to-channel-message": "channel",
});

const canonicalizeOperationAudit = (
  toolName: string,
  argumentsValue: Record<string, OwnedJson>,
): Record<string, OwnedJson> => {
  const targetType = governedTargetType[toolName];
  if (!targetType) return argumentsValue;
  const context = argumentsValue.lemmacomputerAudit;
  if (!context || typeof context !== "object" || Array.isArray(context)) return argumentsValue;
  return {
    ...argumentsValue,
    lemmacomputerAudit: {
      ...context,
      // The tool determines whether a destination is a chat or a channel.
      // Keeping this out of model control makes retries of the same provider
      // effect converge on one active governed operation.
      targetType,
    },
  };
};
const withId = (key: string) => z.strictObject({ [key]: id });

const emailAddress = z.strictObject({
  emailAddress: z.strictObject({
    address: z.email(),
    name: z.string().trim().min(1).max(256).optional(),
  }),
});
const itemBody = z.strictObject({
  contentType: z.enum(["text", "html"]),
  content: z.string().trim().min(1).max(100_000),
});
const mailMessageFields = {
  subject: z.string().trim().min(1).max(998).optional(),
  body: itemBody.optional(),
  toRecipients: z.array(emailAddress).max(100).optional(),
  ccRecipients: z.array(emailAddress).max(100).optional(),
  bccRecipients: z.array(emailAddress).max(100).optional(),
  importance: z.enum(["low", "normal", "high"]).optional(),
};
const draftMailBody = z.strictObject(mailMessageFields).refine(
  (value) => value.subject !== undefined && value.body !== undefined,
  "subject and body are required",
);
const mailPatchBody = z.strictObject(mailMessageFields).refine(
  (value) => Object.values(value).some((candidate) => candidate !== undefined),
  "at least one editable mail field is required",
);
const sendMailBody = z.strictObject({
  Message: z.strictObject(mailMessageFields).refine(
    (value) => value.subject !== undefined && value.body !== undefined && Boolean(value.toRecipients?.length),
    "subject, body, and at least one toRecipient are required",
  ),
  SaveToSentItems: z.boolean().optional(),
});
const commentBody = z.strictObject({ Comment: z.string().trim().min(1).max(100_000) });
const forwardBody = z.strictObject({
  ToRecipients: z.array(emailAddress).min(1).max(100),
  Comment: z.string().max(100_000).optional(),
});
const dateTimeZone = z.strictObject({
  dateTime: z.string().trim().min(1).max(64),
  timeZone: z.string().trim().min(1).max(64),
});
const calendarEventFields = {
  subject: z.string().trim().min(1).max(998).optional(),
  start: dateTimeZone.optional(),
  end: dateTimeZone.optional(),
  body: itemBody.optional(),
  location: z.strictObject({ displayName: z.string().trim().min(1).max(512) }).optional(),
  attendees: z.array(z.strictObject({
    emailAddress: emailAddress.shape.emailAddress,
    type: z.enum(["required", "optional", "resource"]),
  })).max(100).optional(),
  isAllDay: z.boolean().optional(),
  isOnlineMeeting: z.boolean().optional(),
  isReminderOn: z.boolean().optional(),
  reminderMinutesBeforeStart: z.number().int().min(0).max(40_320).optional(),
  importance: z.enum(["low", "normal", "high"]).optional(),
  sensitivity: z.enum(["normal", "personal", "private", "confidential"]).optional(),
  showAs: z.enum(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]).optional(),
};
const createCalendarEventBody = z.strictObject(calendarEventFields).refine(
  (value) => value.subject !== undefined && value.start !== undefined && value.end !== undefined,
  "subject, start, and end are required",
);
const updateCalendarEventBody = z.strictObject(calendarEventFields).refine(
  (value) => Object.values(value).some((candidate) => candidate !== undefined),
  "at least one editable calendar field is required",
);
const createFolderBody = z.strictObject({
  name: z.string().trim().min(1).max(255),
  folder: z.strictObject({}),
  "@microsoft.graph.conflictBehavior": z.enum(["fail", "replace", "rename"]).optional(),
});
const moveDriveItemBody = z.strictObject({
  name: z.string().trim().min(1).max(255).optional(),
  parentReference: z.strictObject({ id }).optional(),
}).refine(
  (value) => value.name !== undefined || value.parentReference !== undefined,
  "name or parentReference is required",
);
const copyDriveItemBody = z.strictObject({
  name: z.string().trim().min(1).max(255).optional(),
  parentReference: z.strictObject({ driveId: id.optional(), id }),
});

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
const resumableUploadArguments = z.strictObject({
  driveId: id,
  driveItemId: uploadDriveItemId,
  body: z.strictObject({
    item: z.strictObject({
      "@microsoft.graph.conflictBehavior": z.enum(["fail", "replace", "rename"]),
    }),
  }),
  lemmacomputerFile: z.strictObject({
    name: z.string().trim().min(1).max(255),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
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
  schemaHash: createHash("sha256").update(canonicalJson({
    schemaId,
    jsonSchema: z.toJSONSchema(schema),
    ...(risk === "write" ? { operationAuditContext: z.toJSONSchema(operationAuditContext) } : {}),
  })).digest("hex"),
  mode,
  parse: (value) => {
    if (risk !== "write" || !value || typeof value !== "object" || Array.isArray(value)) return schema.parse(value);
    const { lemmacomputerAudit, ...toolArguments } = value as Record<string, OwnedJson>;
    return {
      ...schema.parse(toolArguments),
      lemmacomputerAudit: operationAuditContext.parse(lemmacomputerAudit),
    };
  },
});

const toolSchemas: Record<keyof typeof m365ToolCatalog, z.ZodType<Record<string, OwnedJson>>> = {
  "list-mail-folders": boundedListArguments,
  "list-mail-messages": boundedListArguments,
  "get-mail-message": withId("messageId"),
  "create-draft-email": z.strictObject({ body: draftMailBody }),
  "update-mail-message": z.strictObject({ messageId: id, body: mailPatchBody }),
  "delete-mail-message": z.strictObject({ messageId: id, "If-Match": id.optional() }),
  "move-mail-message": z.strictObject({ messageId: id, body: z.strictObject({ DestinationId: id }) }),
  "send-mail": z.strictObject({ body: sendMailBody }),
  "send-draft-message": withId("messageId"),
  "reply-mail-message": z.strictObject({ messageId: id, body: commentBody }),
  "reply-all-mail-message": z.strictObject({ messageId: id, body: commentBody }),
  "forward-mail-message": z.strictObject({ messageId: id, body: forwardBody }),
  "list-calendars": boundedListArguments,
  "list-calendar-events": boundedListArguments.extend({ timezone: z.string().trim().min(1).max(64).optional() }),
  "get-calendar-view": calendarViewArguments,
  "get-calendar-event": z.strictObject({ eventId: id, timezone: z.string().trim().min(1).max(64).optional() }),
  "create-calendar-event": z.strictObject({ body: createCalendarEventBody }),
  "update-calendar-event": z.strictObject({ eventId: id, body: updateCalendarEventBody }),
  "delete-calendar-event": z.strictObject({ eventId: id, "If-Match": id.optional() }),
  "list-drives": listDrivesArguments,
  "get-drive-root-item": withId("driveId"),
  "list-folder-files": boundedListArguments.extend({ driveId: id, driveItemId: id }),
  "search-onedrive-files": boundedDriveSearchArguments,
  "get-drive-item": driveItemMetadataArguments,
  "create-onedrive-folder": z.strictObject({ driveId: id, driveItemId: id, body: createFolderBody }),
  "upload-file-content": z.strictObject({ driveId: id, driveItemId: uploadDriveItemId, body: z.string().min(1).max(5_600_000) }),
  "move-rename-onedrive-item": z.strictObject({ driveId: id, driveItemId: id, body: moveDriveItemBody }),
  "copy-drive-item": z.strictObject({ driveId: id, driveItemId: id, body: copyDriveItemBody }),
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

const withoutJsonSchemaDialect = (schema: Record<string, unknown>): Record<string, unknown> => {
  const { $schema: _dialect, ...contract } = schema;
  return contract;
};

export const m365ControlInputSchemas = Object.fromEntries(
  Object.entries(m365ToolCatalog).map(([name, metadata]) => {
    const schema = withoutJsonSchemaDialect(z.toJSONSchema(toolSchemas[name as keyof typeof m365ToolCatalog]));
    if (metadata.risk === "read") return [name, schema];
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((field): field is string => typeof field === "string")
      : [];
    return [name, {
      ...schema,
      properties: {
        ...properties,
        lemmacomputerAudit: withoutJsonSchemaDialect(z.toJSONSchema(operationAuditContext)),
      },
      required: [...required, "lemmacomputerAudit"],
    }];
  }),
) as Record<keyof typeof m365ToolCatalog, Record<string, unknown>>;

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
    `lemmacomputer.m365.${name}.v1`,
    displayNames[name as keyof typeof m365ToolCatalog],
    metadata.risk === "read" ? `Read Microsoft 365 data using ${name}.` : `Change Microsoft 365 data using ${name}.`,
    metadata.service,
    metadata.risk,
    metadata.decision,
    toolSchemas[name as keyof typeof m365ToolCatalog],
  )]),
) as Record<keyof typeof m365ToolCatalog, CapabilityDefinition>;

export const resumableUploadCapability = definition(
  "m365.create-upload-session",
  "lemmacomputer.m365.create-upload-session.v1",
  "Upload large OneDrive file",
  "Create an approval-bound resumable upload session for one workspace-local file.",
  "onedrive",
  "write",
  "approval_required",
  resumableUploadArguments,
);

export const m365LiteLlmServerId = createHash("sha256")
  .update("lemmacomputer_ms365|http://ms365-mcp:3000/mcp|http|oauth2|")
  .digest("hex")
  .slice(0, 32);

const denied = (
  code: string,
  capability?: CapabilityDefinition,
  problem?: McpPolicyDecision["problem"],
): McpPolicyDecision => ({
  schemaVersion: 1,
  decision: "deny",
  code,
  capabilityId: capability?.capabilityId ?? null,
  schemaId: capability?.schemaId ?? null,
  schemaHash: capability?.schemaHash ?? null,
  operationId: null,
  ...(problem ? { problem } : {}),
});

const invalidArguments = (error: unknown, capability: CapabilityDefinition): McpPolicyDecision => {
  const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
  const unsupported = issue?.code === "unrecognized_keys";
  const field = issue?.path[0]
    ?? (unsupported && "keys" in issue && Array.isArray(issue.keys) ? issue.keys[0] : undefined);
  const safeField = typeof field === "string" || typeof field === "number" ? String(field).slice(0, 128) : null;
  return denied("MCP_ARGUMENTS_OUT_OF_POLICY", capability, {
    category: unsupported ? "unsupported_option" : "invalid_argument",
    field: safeField,
    message: safeField
      ? `${unsupported ? "Unsupported" : "Invalid"} field '${safeField}'. Use the published tool schema and omit raw Graph syntax.`
      : "The tool arguments do not match the published contract. Use only the documented fields and value types.",
    retryable: false,
  });
};

export class McpPolicyService {
  constructor(
    private readonly identityPolicies: IdentityPolicyStore,
    private readonly governance: WorkspaceStore & GovernanceStore,
    private readonly operations: GovernedOperationService,
    private readonly hostedToolPolicy?: (identity: IdentityContext, serverName: string, toolName: string) => Promise<HostedToolPolicy | null>,
  ) {}

  async authorize(request: McpPolicyRequest, correlationId: string): Promise<McpPolicyDecision> {
    const capability = request.toolName === "create-upload-session"
      ? resumableUploadCapability
      : m365CapabilityDefinitions[request.toolName as keyof typeof m365CapabilityDefinitions];
    if (request.serverId !== m365LiteLlmServerId || request.serverName !== "lemmacomputer_ms365" || !capability) {
      return this.authorizeHosted(request, correlationId);
    }

    const identity: IdentityContext = {
      tenantId: request.tenantId,
      subjectId: request.subjectId,
      audience: "lemmacomputer-control",
    };
    const [principal, effectivePolicy, workspace] = await Promise.all([
      this.identityPolicies.getPrincipal(request.subjectId),
      this.identityPolicies.getEffectivePolicy(request.subjectId),
      this.governance.getOwned(identity, request.workspaceId),
    ]);
    if (!principal || principal.tenantId !== request.tenantId) return denied("MCP_IDENTITY_MISMATCH", capability);
    if (!effectivePolicy || !workspace) return denied("MCP_POLICY_NOT_ASSIGNED", capability);
    // The policy callback is a privileged boundary in its own right. A token
    // projected into a sandbox must not be able to authorize MCP work while
    // that exact workspace is stopped, restarting, or has otherwise ceased to
    // be an active instance.
    if (!["ready", "open"].includes(workspace.state)) return denied("MCP_WORKSPACE_NOT_READY", capability);

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
      // connector guard is not a LemmaComputer policy decision and must never
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
      canonicalArguments = canonicalizeOperationAudit(request.toolName, capability.parse(policyArguments));
    } catch (error) {
      return invalidArguments(error, capability);
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
      audience: "lemmacomputer-control",
    };
    const hosted = await this.hostedToolPolicy(identity, request.serverName, request.toolName);
    if (!hosted || hosted.serverId !== request.serverId) return denied("MCP_TOOL_NOT_GOVERNED");
    const capabilityId = `mcp.${hosted.connectorId}.${request.toolName}`.slice(0, 128);
    const schemaId = `lemmacomputer.mcp.${createHash("sha256").update(`${request.serverName}\0${request.toolName}`).digest("hex").slice(0, 32)}.v1`;
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
    if (!["ready", "open"].includes(workspace.state)) return genericDecision("deny", "MCP_WORKSPACE_NOT_READY");
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
  if (decision.decision !== "allow") throw new LemmaComputerError(decision.code, "The Microsoft 365 tool call is not approved for execution", 403);
  return decision;
};
