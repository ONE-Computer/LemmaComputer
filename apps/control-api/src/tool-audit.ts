import { createHash } from "node:crypto";
import {
  canonicalJson,
  LemmaComputerError,
  toolAuditPageSchema,
  toolAuditQuerySchema,
  type ManagedToolAuditTargetType,
  type McpPolicyDecision,
  type McpPolicyRequest,
  type ToolAuditTargetDescriptor,
  type ToolAuditQuery,
} from "@lemmacomputer/contracts";
import type {
  AuditScope,
  FinalizeToolAuditBySourceInput,
  ToolAuditStore,
} from "@lemmacomputer/workspace-store";
import { z } from "zod";

type ConnectorIdentity = { id: string; name: string };

const managedTargetTypes = new Set([
  "recipient", "chat", "channel", "file", "folder", "event", "message", "item", "destination",
]);

const targetKeys: Array<[string, ManagedToolAuditTargetType]> = [
  ["messageId", "message"],
  ["eventId", "event"],
  ["driveItemId", "item"],
  ["chatMessageId", "message"],
  ["chatId", "chat"],
  ["channelId", "channel"],
];

export const mcpToolAuditTarget = (
  request: McpPolicyRequest,
  connectorId: string,
): ToolAuditTargetDescriptor => {
  if (connectorId !== "microsoft-365" || !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
    return { provenance: "generic_template" };
  }
  const argumentsValue = request.arguments as Record<string, unknown>;
  const audit = argumentsValue.lemmacomputerAudit;
  if (audit && typeof audit === "object" && !Array.isArray(audit)) {
    const target = (audit as Record<string, unknown>).target;
    const targetType = (audit as Record<string, unknown>).targetType;
    if (typeof target === "string" && typeof targetType === "string" && managedTargetTypes.has(targetType)) {
      return {
        provenance: "managed_schema",
        targetType: targetType as Extract<ToolAuditTargetDescriptor, { provenance: "managed_schema" }>["targetType"],
        target,
      };
    }
  }
  for (const [key, targetType] of targetKeys) {
    const target = argumentsValue[key];
    if (typeof target === "string" && target.trim()) {
      return { provenance: "managed_schema", targetType, target };
    }
  }
  return { provenance: "generic_template" };
};

export class ToolAuditService {
  constructor(
    private readonly store: ToolAuditStore,
    private readonly resolveConnector: (tenantId: string, serverName: string) => Promise<ConnectorIdentity | null>,
  ) {}

  async admitMcp(
    request: McpPolicyRequest,
    decision: McpPolicyDecision,
    correlationId: string,
  ) {
    if (!request.agentInstanceId || !request.sourceInvocationId) {
      throw new LemmaComputerError(
        "TOOL_AUDIT_INVOCATION_REQUIRED",
        "Tool execution requires a trusted compliance invocation identity",
        403,
      );
    }
    const connector = await this.resolveConnector(request.tenantId, request.serverName);
    const connectorId = connector?.id ?? request.serverName;
    return this.store.admit({
      tenantId: request.tenantId,
      subjectId: request.subjectId,
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      agentInstanceId: request.agentInstanceId,
      context: { kind: "workspace_native", taskId: null, sessionId: null, turnId: null },
      sourceSystem: "workspace_broker",
      sourceInvocationId: request.sourceInvocationId,
      correlationId,
      connectorId,
      serverId: request.serverId,
      serverName: request.serverName,
      toolName: request.toolName,
      policyDecision: decision.decision,
      policyCode: decision.code,
      policyVersionId: request.policyVersionId,
      policyHash: request.policyHash,
      governedOperationId: decision.operationId,
      target: mcpToolAuditTarget(request, connectorId),
    });
  }

  async finalizeMcp(input: AuditScope & Omit<FinalizeToolAuditBySourceInput, keyof AuditScope | "sourceSystem">) {
    return this.store.finalizeBySource({
      ...input,
      sourceSystem: "workspace_broker",
    });
  }

  async query(tenantId: string, raw: Record<string, unknown>, now = new Date()) {
    if (!this.store.queryTerminal) {
      throw new LemmaComputerError("TOOL_AUDIT_QUERY_NOT_CONFIGURED", "Tool compliance history is unavailable", 503, true);
    }
    const queryInput = z.strictObject({
      from: z.iso.datetime(),
      to: z.iso.datetime(),
      subjectId: z.string().min(1).max(200).optional(),
      workspaceId: z.uuid().optional(),
      agentInstanceId: z.uuid().optional(),
      connectorId: z.string().min(1).max(200).optional(),
      toolName: z.string().min(1).max(200).optional(),
      policyDecision: z.enum(["allow", "deny", "approval_required"]).optional(),
      outcome: z.enum(["succeeded", "denied", "approval_required", "failed", "cancelled", "timed_out", "unconfirmed"]).optional(),
      cursor: z.string().min(1).max(1_024).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(raw);
    const query = toolAuditQuerySchema.parse({
      ...queryInput,
      subjectId: queryInput.subjectId ?? null,
      workspaceId: queryInput.workspaceId ?? null,
      agentInstanceId: queryInput.agentInstanceId ?? null,
      connectorId: queryInput.connectorId ?? null,
      toolName: queryInput.toolName ?? null,
      policyDecision: queryInput.policyDecision ?? null,
      outcome: queryInput.outcome ?? null,
      cursor: queryInput.cursor ?? null,
      pageSize: queryInput.pageSize ?? 50,
    });
    const queryHash = toolAuditQueryHash(query);
    const cursor = query.cursor ? decodeToolAuditCursor(query.cursor) : null;
    if (cursor && cursor.queryHash !== queryHash) {
      throw new LemmaComputerError("TOOL_AUDIT_CURSOR_INVALID", "The tool history cursor does not match these filters", 400);
    }
    const asOf = cursor ? new Date(cursor.asOf) : now;
    const page = await this.store.queryTerminal({
      ...query,
      tenantId,
      asOf,
      after: cursor ? { completedAt: new Date(cursor.completedAt), invocationId: cursor.invocationId } : null,
    });
    const last = page.events.at(-1);
    return toolAuditPageSchema.parse({
      events: page.events,
      nextCursor: page.hasMore && last ? encodeToolAuditCursor({
        version: 1,
        asOf: asOf.toISOString(),
        completedAt: last.completedAt,
        invocationId: last.invocationId,
        queryHash,
      }) : null,
      total: page.total,
      asOf: asOf.toISOString(),
      retainedDetailFrom: page.retainedDetailFrom?.toISOString() ?? null,
      detailState: page.detailState,
      summary: page.summary,
    });
  }
}

const toolAuditCursorSchema = z.strictObject({
  version: z.literal(1),
  asOf: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  invocationId: z.uuid(),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
});

type ToolAuditCursor = z.infer<typeof toolAuditCursorSchema>;

const toolAuditQueryHash = (query: ToolAuditQuery) => createHash("sha256").update(canonicalJson({
  from: query.from,
  to: query.to,
  subjectId: query.subjectId,
  workspaceId: query.workspaceId,
  agentInstanceId: query.agentInstanceId,
  connectorId: query.connectorId,
  toolName: query.toolName,
  policyDecision: query.policyDecision,
  outcome: query.outcome,
})).digest("hex");

export const encodeToolAuditCursor = (cursor: ToolAuditCursor) => Buffer
  .from(JSON.stringify(toolAuditCursorSchema.parse(cursor)))
  .toString("base64url");

export const decodeToolAuditCursor = (value: string): ToolAuditCursor => {
  try {
    return toolAuditCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new LemmaComputerError("TOOL_AUDIT_CURSOR_INVALID", "The tool history cursor is invalid", 400);
  }
};
