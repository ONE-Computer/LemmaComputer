import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import {
  AllowUsageAttemptAdmission,
  type AttemptAdmissionInput,
  type AttemptAdmissionSemanticInput,
  type AttemptBudgetBounds,
  type PostgresUsageLedgerStore,
  type TeamStore,
  type UsageAttemptAdmissionHook,
  type UsageEventInput,
} from "@lemmacomputer/workspace-store";
import { z } from "zod";

const boundedId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const optionalBoundedId = boundedId.nullable().optional();
const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/);
const usageUnit = z.string().refine((value) => [
  "input_uncached_token","cache_read_token","cache_write_token","output_token","reasoning_token",
  "image","audio_second","request","character","second",
].includes(value) || /^provider:[a-z0-9][a-z0-9_.:-]{0,79}$/.test(value), "Invalid usage unit");
const serviceClass = z.enum(["auto","lite","balanced","pro"]);
const nonnegativeDecimal = decimal.refine((value) => !value.startsWith("-"), "Quantity cannot be negative");
const budgetBounds = z.object({
  inputTokens:nonnegativeDecimal,cacheReadTokens:nonnegativeDecimal.optional(),cacheWriteTokens:nonnegativeDecimal.optional(),
  maximumOutputTokens:nonnegativeDecimal,maximumReasoningTokens:nonnegativeDecimal.optional(),requestUnits:nonnegativeDecimal.optional(),
  cacheStatus:z.enum(["known_hit","known_miss","unknown"]),
  maxRetries:z.number().int().min(0).max(100),maxFallbacks:z.number().int().min(0).max(100),maxAgentSteps:z.number().int().min(1).max(1000),
  routingOverhead:z.array(z.object({ unit:usageUnit,quantity:nonnegativeDecimal }).strict()).max(64).optional(),
  reservationTtlSeconds:z.number().int().min(30).max(3600).optional(),providerDeadlineAt:z.iso.datetime().optional(),
}).strict();

export const internalUsageAdmissionSchema = z.object({
  schemaVersion:z.literal(1), sourceSystem:z.literal("litellm"), sourceAttemptId:boundedId,
  tenantId:boundedId, subjectId:boundedId, workspaceId:optionalBoundedId, agentId:optionalBoundedId,
  taskBinding:z.string().min(32).max(4096).optional(), policyVersionId:optionalBoundedId,
  policyHash:z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), requestedAlias:boundedId,
  requestedServiceClass:serviceClass.nullable().optional(), selectedServiceClass:serviceClass.exclude(["auto"]).nullable().optional(),
  routeMappingVersion:optionalBoundedId, attemptKind:z.enum(["inference","router","classifier","embedding","retry","fallback"]),
  parentAttemptId:z.uuid().nullable().optional(), resolvedProvider:boundedId, providerAccountId:boundedId,
  resolvedModel:z.string().trim().min(1).max(300), resolvedDeploymentId:boundedId,
  region:optionalBoundedId, providerServiceTier:optionalBoundedId, admittedAt:z.iso.datetime(), budgetBounds:budgetBounds.optional(),
}).strict();
export type InternalUsageAdmission = z.infer<typeof internalUsageAdmissionSchema>;

const unboundTaskId = (input: Pick<InternalUsageAdmission,"tenantId"|"sourceSystem"|"sourceAttemptId">) => {
  const digest = createHash("sha256")
    .update("lemmacomputer-ai-unbound-task/v1\0")
    .update(input.tenantId).update("\0")
    .update(input.sourceSystem).update("\0")
    .update(input.sourceAttemptId)
    .digest("base64url");
  return `unbound:${digest}`;
};

const costDrivers = z.object({
  conversationHistoryCount:z.number().int().min(0).max(1_000_000).optional(),
  attachmentCount:z.number().int().min(0).max(10_000).optional(),
  retrievalCount:z.number().int().min(0).max(1_000_000).optional(),
  systemPolicyContextCount:z.number().int().min(0).max(1_000_000).optional(),
  toolResultContextCount:z.number().int().min(0).max(1_000_000).optional(),
  routingOverheadCount:z.number().int().min(0).max(10_000).optional(),
}).strict();
export const internalUsageCompletionSchema = z.object({
  schemaVersion:z.literal(1), tenantId:boundedId, admissionId:z.uuid(), sourceSystem:z.literal("litellm"),
  sourceEventId:boundedId, eventType:z.enum(["usage","correction"]), correctsEventId:z.uuid().nullable().optional(),
  occurredAt:z.iso.datetime(), outcome:z.enum(["success","failure","cancelled","unknown"]),
  errorClass:boundedId.nullable().optional(), latencyMs:z.number().int().min(0).max(86_400_000).nullable().optional(),
  providerReportedTotalTokens:decimal.nullable().optional(), providerConfirmedCost:decimal.nullable().optional(),
  providerConfirmedCurrency:z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  units:z.array(z.object({ unit:usageUnit,quantity:decimal,diagnostic:z.boolean().optional() }).strict()).max(64),
  costDrivers:costDrivers.optional(),
}).strict();
export type InternalUsageCompletion = z.infer<typeof internalUsageCompletionSchema>;
export const adminUsageQuerySchema=z.object({
  from:z.iso.datetime(),to:z.iso.datetime(),limit:z.coerce.number().int().min(1).max(500).default(100),
  cursor:z.string().max(500).optional(),teamId:z.uuid().optional(),subjectId:boundedId.optional(),taskId:boundedId.optional(),
}).strict();
export const adminRateCardSchema=z.object({
  provider:boundedId,providerAccountId:boundedId,baseModel:z.string().trim().min(1).max(300),deploymentId:boundedId,
  region:boundedId.nullable().optional(),providerServiceTier:boundedId.nullable().optional(),currency:z.string().regex(/^[A-Z]{3}$/),
  source:z.enum(["contract_override","conservative"]),sourceVersion:boundedId,sourceHash:z.string().regex(/^[a-f0-9]{64}$/),
  effectiveFrom:z.iso.datetime(),effectiveTo:z.iso.datetime().nullable().optional(),overrideReason:z.string().trim().min(1).max(500).nullable().optional(),
  rates:z.array(z.object({unit:usageUnit,amountPerUnit:decimal.refine((value)=>!value.startsWith("-"),"Rate cannot be negative"),unitScale:decimal.refine((value)=>value!=="0"&&!value.startsWith("-"),"Scale must be positive")}).strict()).min(1).max(64),
}).strict().superRefine((value,context)=>{if(value.source==="contract_override"&&!value.overrideReason)context.addIssue({code:"custom",path:["overrideReason"],message:"Contract override reason is required"});});
export const adminReconciliationSchema=z.object({
  sourceSystem:z.literal("litellm"),windowStart:z.iso.datetime(),windowEnd:z.iso.datetime(),
  expected:z.array(z.object({sourceEventId:boundedId,fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(1000),
}).strict();
export const decodeUsageCursor=(value:string|undefined)=>{
  if(!value)return undefined;
  try{
    const parsed=z.object({occurredAt:z.iso.datetime(),id:z.uuid()}).strict().parse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));
    return {occurredAt:new Date(parsed.occurredAt),id:parsed.id};
  }catch{throw new LemmaComputerError("AI_USAGE_CURSOR_INVALID","AI usage cursor is invalid",400);}
};
export const encodeUsageCursor=(value:{occurredAt:string;id:string}|null)=>value?Buffer.from(JSON.stringify(value)).toString("base64url"):null;

export interface UsageEventRecordedHook {
  recorded(input: InternalUsageCompletion, result: { status:"created"|"duplicate"; eventId:string }): Promise<void>;
}
export class NoopUsageEventRecordedHook implements UsageEventRecordedHook {
  async recorded() {}
}

export type UsageTaskContextKind = "chat"|"channel"|"schedule"|"background";
export type UsageTaskBinding = {
  schemaVersion:1; tenantId:string; subjectId:string; workspaceId:string; agentId:string;
  contextKind:UsageTaskContextKind; taskId:string; sessionId?:string; turnId?:string;
  requestedServiceClass?:"auto"|"lite"|"balanced"|"pro";
  issuedAt:string; expiresAt:string;
};
const taskBindingSchema = z.object({
  schemaVersion:z.literal(1),tenantId:boundedId,subjectId:boundedId,workspaceId:boundedId,agentId:boundedId,
  contextKind:z.enum(["chat","channel","schedule","background"]),taskId:boundedId,sessionId:boundedId.optional(),turnId:boundedId.optional(),
  requestedServiceClass:serviceClass.default("auto"),
  issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
}).strict();

export class UsageTaskBindingAuthority {
  constructor(private readonly secret: string, private readonly now = () => new Date()) {
    if (secret.length < 32) throw new Error("AI usage task-binding secret must contain at least 32 characters");
  }
  issue(input: Omit<UsageTaskBinding,"schemaVersion"|"issuedAt"|"expiresAt">, ttlSeconds = 3600) {
    const issuedAt = this.now();
    const payload = taskBindingSchema.parse({ ...input,schemaVersion:1,issuedAt:issuedAt.toISOString(),expiresAt:new Date(issuedAt.getTime()+ttlSeconds*1000).toISOString() });
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }
  verify(token: string): UsageTaskBinding {
    const [encoded,signature,...extra] = token.split(".");
    if (!encoded || !signature || extra.length) throw new LemmaComputerError("AI_USAGE_TASK_BINDING_INVALID","AI task binding is invalid",403);
    const expected = Buffer.from(this.sign(encoded));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected,received)) throw new LemmaComputerError("AI_USAGE_TASK_BINDING_INVALID","AI task binding is invalid",403);
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(encoded,"base64url").toString("utf8")); } catch { throw new LemmaComputerError("AI_USAGE_TASK_BINDING_INVALID","AI task binding is invalid",403); }
    const parsed = taskBindingSchema.safeParse(decoded);
    if (!parsed.success || new Date(parsed.data.expiresAt) <= this.now() || new Date(parsed.data.issuedAt) > this.now()) throw new LemmaComputerError("AI_USAGE_TASK_BINDING_INVALID","AI task binding is invalid or expired",403);
    return parsed.data;
  }
  private sign(encoded: string) { return createHmac("sha256",this.secret).update("lemmacomputer-ai-task/v1\0").update(encoded).digest("base64url"); }
}

export class UsageLedgerService {
  constructor(
    private readonly store: PostgresUsageLedgerStore,
    private readonly teams: TeamStore,
    private readonly bindings: UsageTaskBindingAuthority,
    private readonly admissionHook: UsageAttemptAdmissionHook = new AllowUsageAttemptAdmission(),
    private readonly recordedHook: UsageEventRecordedHook = new NoopUsageEventRecordedHook(),
  ) {}

  async admit(input: InternalUsageAdmission) {
    const binding = input.taskBinding ? this.bindings.verify(input.taskBinding) : null;
    if (binding && (
      binding.tenantId !== input.tenantId || binding.subjectId !== input.subjectId
      || binding.workspaceId !== input.workspaceId || binding.agentId !== input.agentId
    )) throw new LemmaComputerError("AI_USAGE_TASK_BINDING_MISMATCH","AI task binding does not match the authenticated gateway identity",403);
    const attempt: AttemptAdmissionSemanticInput = {
      tenantId:input.tenantId,sourceSystem:input.sourceSystem,sourceAttemptId:input.sourceAttemptId,subjectId:input.subjectId,
      ...(input.workspaceId?{workspaceId:input.workspaceId}:{}),...(input.agentId?{agentId:input.agentId}:{}),
      ...(binding?.sessionId?{sessionId:binding.sessionId}:{}),taskId:binding?.taskId??unboundTaskId(input),
      ...(binding?.turnId?{turnId:binding.turnId}:{}),taskBindingProvenance:binding?"explicit_signed":"unbound_generated",contextKind:binding?.contextKind??"background",
      ...(input.policyVersionId?{policyVersionId:input.policyVersionId}:{}),...(input.policyHash?{policyHash:input.policyHash}:{}),
      requestedAlias:input.requestedAlias,...(input.requestedServiceClass?{requestedServiceClass:input.requestedServiceClass}:{}),
      ...(input.selectedServiceClass?{selectedServiceClass:input.selectedServiceClass}:{}),...(input.routeMappingVersion?{routeMappingVersion:input.routeMappingVersion}:{}),
      attemptKind:input.attemptKind,...(input.parentAttemptId?{parentAttemptId:input.parentAttemptId}:{}),resolvedProvider:input.resolvedProvider,
      providerAccountId:input.providerAccountId,resolvedModel:input.resolvedModel,resolvedDeploymentId:input.resolvedDeploymentId,
      ...(input.region?{region:input.region}:{}),...(input.providerServiceTier?{providerServiceTier:input.providerServiceTier}:{}),
      ...(input.budgetBounds?{budgetBounds:{...input.budgetBounds,routingOverhead:input.budgetBounds.routingOverhead as AttemptBudgetBounds["routingOverhead"],providerDeadlineAt:input.budgetBounds.providerDeadlineAt?new Date(input.budgetBounds.providerDeadlineAt):undefined}}:{}),
    };
    const finish = (result: Awaited<ReturnType<PostgresUsageLedgerStore["admitAttempt"]>>) => {
      if (result.status === "denied") throw new LemmaComputerError(result.denialCode,"AI usage admission was denied",429,true);
      if (result.status === "conflict") throw new LemmaComputerError("AI_USAGE_ATTEMPT_CONFLICT","The source attempt key was reused with different facts",409);
      return { schemaVersion:1,admissionId:result.admissionId,status:result.status,taskId:attempt.taskId,taskBindingProvenance:attempt.taskBindingProvenance,contextKind:attempt.contextKind,team:result.team };
    };
    const replay = await this.store.replayAttempt(attempt);
    if (replay) return finish(replay);
    const team = await this.teams.resolveDefaultSpendingTeam({ tenantId:input.tenantId,userId:input.subjectId,actorUserId:input.subjectId });
    return finish(await this.store.admitAttempt({ ...attempt,team,admittedAt:new Date(input.admittedAt) },this.admissionHook));
  }

  async complete(input: InternalUsageCompletion) {
    const event: UsageEventInput = {
      tenantId:input.tenantId,admissionId:input.admissionId,sourceSystem:input.sourceSystem,sourceEventId:input.sourceEventId,
      eventType:input.eventType,...(input.correctsEventId?{correctsEventId:input.correctsEventId}:{}),occurredAt:new Date(input.occurredAt),outcome:input.outcome,
      ...(input.errorClass?{errorClass:input.errorClass}:{}),...(input.latencyMs!==null&&input.latencyMs!==undefined?{latencyMs:input.latencyMs}:{}),
      ...(input.providerReportedTotalTokens?{providerReportedTotalTokens:input.providerReportedTotalTokens}:{}),
      ...(input.providerConfirmedCost?{providerConfirmedCost:input.providerConfirmedCost}:{}),
      ...(input.providerConfirmedCurrency?{providerConfirmedCurrency:input.providerConfirmedCurrency}:{}),
      units:input.units as UsageEventInput["units"],...(input.costDrivers?{costDrivers:input.costDrivers}:{}),
    };
    const result = await this.store.appendUsageEvent(event);
    if (result.status === "conflict") throw new LemmaComputerError("AI_USAGE_EVENT_CONFLICT","The source event key was reused with different facts",409);
    if (result.status === "pending") return { schemaVersion:1,...result };
    if (input.eventType === "usage") {
      if (!result.eventId) throw new Error("Recorded AI usage event did not return an event id");
      await this.recordedHook.recorded(input,{ status:result.status,eventId:result.eventId });
    }
    return { schemaVersion:1,...result };
  }
}
