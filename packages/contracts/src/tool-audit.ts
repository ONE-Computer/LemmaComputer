import { z } from "zod";

export const toolAuditContextKinds = [
  "chat",
  "channel",
  "schedule",
  "background",
  "interactive",
  "workspace_native",
] as const;
export const toolAuditContextKindSchema = z.enum(toolAuditContextKinds);
export type ToolAuditContextKind = z.infer<typeof toolAuditContextKindSchema>;

export const toolAuditSourceSystems = [
  "litellm_mcp",
  "governed_operation",
  "workspace_broker",
] as const;
export const toolAuditSourceSystemSchema = z.enum(toolAuditSourceSystems);
export type ToolAuditSourceSystem = z.infer<typeof toolAuditSourceSystemSchema>;

export const toolAuditPolicyDecisions = ["allow", "deny", "approval_required"] as const;
export const toolAuditPolicyDecisionSchema = z.enum(toolAuditPolicyDecisions);
export type ToolAuditPolicyDecision = z.infer<typeof toolAuditPolicyDecisionSchema>;

export const toolAuditTerminalOutcomes = [
  "succeeded",
  "denied",
  "approval_required",
  "failed",
  "cancelled",
  "timed_out",
  "unconfirmed",
] as const;
export const toolAuditTerminalOutcomeSchema = z.enum(toolAuditTerminalOutcomes);
export type ToolAuditTerminalOutcome = z.infer<typeof toolAuditTerminalOutcomeSchema>;

export const toolAuditTargetTypes = [
  "recipient",
  "chat",
  "channel",
  "file",
  "folder",
  "event",
  "message",
  "item",
  "destination",
  "connector",
] as const;
export const toolAuditTargetTypeSchema = z.enum(toolAuditTargetTypes);
export type ToolAuditTargetType = z.infer<typeof toolAuditTargetTypeSchema>;

const managedToolAuditTargetTypes = [
  "recipient",
  "chat",
  "channel",
  "file",
  "folder",
  "event",
  "message",
  "item",
  "destination",
] as const;
export const managedToolAuditTargetTypeSchema = z.enum(managedToolAuditTargetTypes);
export type ManagedToolAuditTargetType = z.infer<typeof managedToolAuditTargetTypeSchema>;

const boundedIdentifier = z.string().trim().min(1).max(200);
const safeSummaryText = z.string().trim().min(1).max(200).refine(
  (value) => !/[\u0000-\u001f\u007f<>]/u.test(value),
  "Audit summaries cannot contain controls or HTML delimiters",
);

export const toolAuditTargetSummarySchema = z.strictObject({
  targetType: toolAuditTargetTypeSchema,
  text: safeSummaryText,
  provenance: z.enum(["managed_schema", "generic_template"]),
  redacted: z.boolean(),
});
export type ToolAuditTargetSummary = z.infer<typeof toolAuditTargetSummarySchema>;

export const toolAuditTargetDescriptorSchema = z.discriminatedUnion("provenance", [
  z.strictObject({
    provenance: z.literal("managed_schema"),
    targetType: managedToolAuditTargetTypeSchema,
    target: z.string().trim().min(1).max(2_000),
  }),
  z.strictObject({ provenance: z.literal("generic_template") }),
]);
export type ToolAuditTargetDescriptor = z.infer<typeof toolAuditTargetDescriptorSchema>;

export const toolAuditContextSchema = z.strictObject({
  kind: toolAuditContextKindSchema,
  taskId: boundedIdentifier.nullable(),
  sessionId: boundedIdentifier.nullable(),
  turnId: boundedIdentifier.nullable(),
});
export type ToolAuditContext = z.infer<typeof toolAuditContextSchema>;

const toolAuditAdmissionFactsShape = {
  tenantId: z.string().trim().min(1).max(128),
  subjectId: z.string().trim().min(1).max(128),
  workspaceId: z.uuid(),
  agentId: z.string().trim().min(1).max(128),
  agentInstanceId: z.uuid(),
  context: toolAuditContextSchema,
  sourceSystem: toolAuditSourceSystemSchema,
  sourceInvocationId: boundedIdentifier,
  correlationId: boundedIdentifier,
  connectorId: z.string().trim().min(1).max(128),
  serverId: z.string().trim().min(1).max(128),
  serverName: z.string().trim().min(1).max(128),
  toolName: z.string().trim().min(1).max(128),
  policyDecision: toolAuditPolicyDecisionSchema,
  policyCode: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_:-]{0,127}$/),
  policyVersionId: z.string().trim().min(1).max(128).nullable(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  governedOperationId: z.uuid().nullable(),
};

const requireGovernedOperationForApproval = (
  value: { policyDecision: ToolAuditPolicyDecision; governedOperationId: string | null },
  context: z.RefinementCtx,
) => {
  if (value.policyDecision === "approval_required" && value.governedOperationId === null) {
    context.addIssue({
      code: "custom",
      path: ["governedOperationId"],
      message: "Approval-required tool calls must reference their governed operation",
    });
  }
};

export const toolAuditAdmissionInputSchema = z.strictObject({
  ...toolAuditAdmissionFactsShape,
  target: toolAuditTargetDescriptorSchema,
}).superRefine(requireGovernedOperationForApproval);
export type ToolAuditAdmissionInput = z.infer<typeof toolAuditAdmissionInputSchema>;

export const toolAuditAdmissionRecordInputSchema = z.strictObject({
  ...toolAuditAdmissionFactsShape,
  targetSummary: toolAuditTargetSummarySchema,
}).superRefine(requireGovernedOperationForApproval);
export type ToolAuditAdmissionRecordInput = z.infer<typeof toolAuditAdmissionRecordInputSchema>;

export const toolAuditAdmissionSchema = toolAuditAdmissionRecordInputSchema.safeExtend({
  invocationId: z.uuid(),
  admittedAt: z.iso.datetime(),
});
export type ToolAuditAdmission = z.infer<typeof toolAuditAdmissionSchema>;

export const toolAuditTerminalInputSchema = z.strictObject({
  outcome: toolAuditTerminalOutcomeSchema,
  latencyMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1_000),
  failureClass: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_:-]{0,127}$/).nullable(),
}).superRefine((value, context) => {
  const failureOutcome = ["failed", "cancelled", "timed_out", "unconfirmed"].includes(value.outcome);
  if (failureOutcome !== (value.failureClass !== null)) {
    context.addIssue({
      code: "custom",
      path: ["failureClass"],
      message: "Only incomplete or unsuccessful outcomes carry a bounded failure class",
    });
  }
});
export type ToolAuditTerminalInput = z.infer<typeof toolAuditTerminalInputSchema>;

export const toolAuditTerminalRecordSchema = toolAuditAdmissionSchema.safeExtend({
  outcome: toolAuditTerminalOutcomeSchema,
  latencyMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1_000),
  failureClass: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_:-]{0,127}$/).nullable(),
  completedAt: z.iso.datetime(),
}).superRefine((value, context) => {
  const expectedOutcome: Partial<Record<ToolAuditPolicyDecision, ToolAuditTerminalOutcome>> = {
    deny: "denied",
    approval_required: "approval_required",
  };
  const fixedOutcome = expectedOutcome[value.policyDecision];
  if (fixedOutcome && value.outcome !== fixedOutcome) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: `The ${value.policyDecision} policy decision must terminate as ${fixedOutcome}`,
    });
  }
  if (value.policyDecision === "allow" && ["denied", "approval_required"].includes(value.outcome)) {
    context.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "Allowed calls cannot terminate as a policy denial or approval hold",
    });
  }
  const failureOutcome = ["failed", "cancelled", "timed_out", "unconfirmed"].includes(value.outcome);
  if (failureOutcome !== (value.failureClass !== null)) {
    context.addIssue({
      code: "custom",
      path: ["failureClass"],
      message: "Only incomplete or unsuccessful outcomes carry a bounded failure class",
    });
  }
  if (Date.parse(value.completedAt) < Date.parse(value.admittedAt)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal evidence cannot predate admission" });
  }
});
export type ToolAuditTerminalRecord = z.infer<typeof toolAuditTerminalRecordSchema>;

export const toolAuditQuerySchema = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  subjectId: boundedIdentifier.nullable().default(null),
  workspaceId: z.uuid().nullable().default(null),
  agentInstanceId: z.uuid().nullable().default(null),
  connectorId: boundedIdentifier.nullable().default(null),
  toolName: boundedIdentifier.nullable().default(null),
  policyDecision: toolAuditPolicyDecisionSchema.nullable().default(null),
  outcome: toolAuditTerminalOutcomeSchema.nullable().default(null),
  cursor: z.string().trim().min(1).max(1_024).nullable().default(null),
  pageSize: z.number().int().min(1).max(100).default(50),
}).superRefine((value, context) => {
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  if (to <= from) {
    context.addIssue({ code: "custom", path: ["to"], message: "Audit query end must follow its start" });
  }
  if (to - from > 366 * 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", path: ["to"], message: "Audit queries are limited to 366 days" });
  }
});
export type ToolAuditQuery = z.infer<typeof toolAuditQuerySchema>;

export const toolAuditSummaryBucketSchema = z.strictObject({
  outcome: toolAuditTerminalOutcomeSchema,
  count: z.number().int().nonnegative(),
});
export type ToolAuditSummaryBucket = z.infer<typeof toolAuditSummaryBucketSchema>;

export const toolAuditPageSchema = z.strictObject({
  events: z.array(toolAuditTerminalRecordSchema).max(100),
  nextCursor: z.string().max(1_024).nullable(),
  total: z.number().int().nonnegative(),
  asOf: z.iso.datetime(),
  retainedDetailFrom: z.iso.datetime().nullable(),
  detailState: z.enum(["complete", "partial", "rollup_only"]),
  summary: z.array(toolAuditSummaryBucketSchema).max(toolAuditTerminalOutcomes.length),
});
export type ToolAuditPage = z.infer<typeof toolAuditPageSchema>;
