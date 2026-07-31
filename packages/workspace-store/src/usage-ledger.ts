import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { MinimalSpendingTeam } from "@onecomputer/contracts";
import { pinnedRateCardForDeployment } from "./pinned-rate-catalogue.js";

export const usageUnits = ["input_uncached_token","cache_read_token","cache_write_token","output_token","reasoning_token","image","audio_second","request","character","second"] as const;
export type UsageUnit = typeof usageUnits[number] | `provider:${string}`;
export type UsageAmount = { unit: UsageUnit; quantity: string; diagnostic?: boolean };
export type RateAmount = { unit: UsageUnit; amountPerUnit: string; unitScale: string };
export type PricedUsage = { providerCost: string | null; priceStatus: "priced" | "unknown" | "incomplete"; buckets: Array<UsageAmount & { rateAmountPerUnit: string | null; rateUnitScale: string | null; bucketCost: string | null }> };

const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const providerUnit = /^provider:[a-z0-9][a-z0-9_.:-]{0,79}$/;
const assertUnit = (unit: string) => {
  if (!(usageUnits as readonly string[]).includes(unit) && !providerUnit.test(unit)) throw new Error(`Invalid usage unit: ${unit}`);
};
const assertUniqueUnits = (values: Array<{ unit: string }>, label: string) => {
  const units = new Set(values.map((value) => value.unit));
  if (units.size !== values.length) throw new Error(`Duplicate ${label} unit`);
};
const scaled = (value: string) => {
  if (!decimal.test(value)) throw new Error(`Invalid decimal value: ${value}`);
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole!) * 1_000_000_000_000n + BigInt((fraction + "0".repeat(12)).slice(0, 12));
  return negative ? -result : result;
};
const formatted = (value: bigint) => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000_000_000n;
  const fraction = String(absolute % 1_000_000_000_000n).padStart(12, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
};
const divideRounded = (numerator: bigint, denominator: bigint) => {
  if (denominator <= 0n) throw new Error("Rate unit scale must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
};

/** Exact NUMERIC(30,12)-compatible arithmetic; aliases never participate. */
export const priceUsage = (usage: UsageAmount[], rates: RateAmount[]): PricedUsage => {
  usage.forEach((item) => assertUnit(item.unit));
  rates.forEach((item) => { assertUnit(item.unit); scaled(item.amountPerUnit); if (scaled(item.amountPerUnit) < 0n) throw new Error("Rates cannot be negative"); scaled(item.unitScale); });
  assertUniqueUnits(usage, "usage"); assertUniqueUnits(rates, "rate");
  const rateByUnit = new Map(rates.map((rate) => [rate.unit, rate]));
  let total = 0n;
  let billable = 0;
  let priced = 0;
  const buckets = usage.map((item) => {
    const quantity = scaled(item.quantity);
    if (!item.diagnostic) billable += 1;
    const rate = item.diagnostic ? undefined : rateByUnit.get(item.unit);
    if (!rate) return { ...item, rateAmountPerUnit: null, rateUnitScale: null, bucketCost: null };
    const cost = divideRounded(quantity * scaled(rate.amountPerUnit), scaled(rate.unitScale));
    total += cost;
    priced += 1;
    return { ...item, rateAmountPerUnit: rate.amountPerUnit, rateUnitScale: rate.unitScale, bucketCost: formatted(cost) };
  });
  return {
    providerCost: billable > 0 && priced === billable ? formatted(total) : null,
    priceStatus: priced === billable && billable > 0 ? "priced" : priced > 0 ? "incomplete" : "unknown",
    buckets,
  };
};

const canonical = (value: unknown): string => {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
};
export const usageFingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export type RateCardInput = {
  tenantId: string; provider: string; providerAccountId: string; baseModel: string; deploymentId: string;
  region?: string; providerServiceTier?: string; currency: string; source: "pinned_catalogue"|"contract_override"|"conservative";
  sourceVersion: string; sourceHash: string; catalogueRelease?: string; effectiveFrom: Date; effectiveTo?: Date;
  approvedBy?: string; overrideReason?: string; rates: RateAmount[];
};
export type AttemptBudgetBounds = {
  inputTokens: string;
  cacheReadTokens?: string;
  cacheWriteTokens?: string;
  maximumOutputTokens: string;
  maximumReasoningTokens?: string;
  requestUnits?: string;
  cacheStatus: "known_hit"|"known_miss"|"unknown";
  maxRetries: number;
  maxFallbacks: number;
  maxAgentSteps: number;
  routingOverhead?: UsageAmount[];
  reservationTtlSeconds?: number;
  providerDeadlineAt?: Date;
};
export type AttemptAdmissionInput = {
  tenantId: string; sourceSystem: string; sourceAttemptId: string; subjectId: string; team: MinimalSpendingTeam;
  workspaceId?: string; agentId?: string; sessionId?: string; taskId: string; turnId?: string;
  taskBindingProvenance: "explicit_signed"|"unbound_generated"; contextKind:"chat"|"channel"|"schedule"|"background"; policyVersionId?: string; policyHash?: string;
  requestedAlias: string; requestedServiceClass?: "auto"|"lite"|"balanced"|"pro"; selectedServiceClass?: "lite"|"balanced"|"pro";
  routeMappingVersion?: string; attemptKind: "inference"|"router"|"classifier"|"embedding"|"retry"|"fallback"; parentAttemptId?: string;
  resolvedProvider: string; providerAccountId: string; resolvedModel: string; resolvedDeploymentId: string; region?: string; providerServiceTier?: string; admittedAt: Date;
  budgetBounds?: AttemptBudgetBounds;
};
export type AttemptAdmissionSemanticInput = Omit<AttemptAdmissionInput,"team"|"admittedAt">;
export type AdmissionTeamSnapshot = Pick<MinimalSpendingTeam,"id"|"displayName"|"costCenterCode">;
export type AdmissionResult =
  | { status:"created"|"duplicate"; admissionId:string; team:AdmissionTeamSnapshot }
  | { status:"conflict"; admissionId:null }
  | { status:"denied"; admissionId:null; denialCode:string };

export const attemptAdmissionFingerprint = (input: AttemptAdmissionInput | AttemptAdmissionSemanticInput) => {
  const { team: _team,admittedAt: _admittedAt,budgetBounds,...semantic } = input as AttemptAdmissionInput;
  if (!budgetBounds) return usageFingerprint(semantic);
  const { reservationTtlSeconds: _reservationTtlSeconds,providerDeadlineAt: _providerDeadlineAt,...economicBounds } = budgetBounds;
  return usageFingerprint({ ...semantic,budgetBounds:economicBounds });
};

export type UsageCostDrivers = {
  conversationHistoryCount?: number; attachmentCount?: number; retrievalCount?: number;
  systemPolicyContextCount?: number; toolResultContextCount?: number; routingOverheadCount?: number;
};
export type UsageEventInput = {
  tenantId: string; admissionId: string; sourceSystem: string; sourceEventId: string;
  eventType: "usage"|"correction"; correctsEventId?: string; occurredAt: Date;
  outcome: "success"|"failure"|"cancelled"|"unknown"; errorClass?: string; latencyMs?: number;
  providerReportedTotalTokens?: string; providerConfirmedCost?: string; providerConfirmedCurrency?: string; units: UsageAmount[];
  costDrivers?: UsageCostDrivers;
};
export type UsageEventResult = {
  status: "created"|"duplicate"|"pending"|"conflict"; eventId: string | null;
  priceStatus?: PricedUsage["priceStatus"]; providerCost?: string | null; currency?: string | null;
};
export type EffectiveRateCard = {
  id: string; currency: string; source: RateCardInput["source"]; sourceVersion: string;
  sourceHash: string; effectiveFrom: Date; rates: RateAmount[];
};
export type UsageEventQuery = {
  tenantId:string; from:Date; to:Date; limit?:number; cursor?:{ occurredAt:Date; id:string };
  teamId?:string; subjectId?:string; taskId?:string;
};
export type UsageEventView = {
  id:string; occurredAt:string; eventType:"usage"|"correction"; correctsEventId:string|null;
  sourceSystem:string; sourceEventId:string; outcome:string; errorClass:string|null; latencyMs:number|null;
  subjectId:string; teamId:string; teamDisplayName:string; costCenterCode:string|null; workspaceId:string|null;
  agentId:string|null; sessionId:string|null; taskId:string; turnId:string|null; taskBindingProvenance:string; contextKind:string;
  requestedAlias:string; requestedServiceClass:string|null; selectedServiceClass:string|null; attemptKind:string;
  resolvedProvider:string; resolvedModel:string; resolvedDeploymentId:string; currency:string|null;
  providerCost:string|null; providerConfirmedCost:string|null; priceStatus:string; costStatus:string;
  rateCardId:string|null; rateCardSourceVersion:string|null; units:Array<{unit:string;quantity:string;bucketCost:string|null;diagnostic:boolean}>;
};
export type ReconciliationInput = {
  tenantId:string; sourceSystem:string; windowStart:Date; windowEnd:Date; startedBy:string;
  expected:Array<{ sourceEventId:string; fingerprint:string }>;
};
export type ReconciliationFinding = {
  findingType:"missing"|"duplicate"|"late"|"unknown_price"|"inconsistent";
  sourceEventId:string|null; ledgerEventId:string|null; expectedFingerprint:string|null; observedFingerprint:string|null; details:string;
};

const boundedQuery = (from:Date,to:Date,limit=100) => {
  if (!(from < to) || to.getTime()-from.getTime() > 31*24*60*60*1000) throw new Error("Usage query range must be positive and at most 31 days");
  if (!Number.isInteger(limit) || limit<1 || limit>500) throw new Error("Usage query limit must be between 1 and 500");
  return limit;
};

const nonnegativeInteger = (value: number | undefined, name: string) => {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error(`${name} must be a non-negative integer`);
  return normalized;
};
const asNullableText = (value: string | undefined) => value ?? null;
const validateRateCard = (input: RateCardInput) => {
  if (!input.rates.length) throw new Error("A rate card requires at least one rate");
  if (input.source === "contract_override" && (!input.approvedBy || !input.overrideReason)) throw new Error("Contract overrides require actor and reason");
  input.rates.forEach((rate) => { assertUnit(rate.unit); scaled(rate.amountPerUnit); scaled(rate.unitScale); });
  assertUniqueUnits(input.rates, "rate");
};

export interface UsageAttemptAdmissionHook {
  admit(input: AttemptAdmissionInput,transaction:pg.PoolClient): Promise<{ decision: "allow" }|{ decision: "deny"; code: string }>;
}
export class AllowUsageAttemptAdmission implements UsageAttemptAdmissionHook {
  async admit() { return { decision: "allow" as const }; }
}

export class PostgresUsageLedgerStore {
  constructor(private readonly pool: pg.Pool) {}
  static fromConnectionString(connectionString: string) { return new PostgresUsageLedgerStore(new pg.Pool({ connectionString, max: 5 })); }
  async close() { await this.pool.end(); }

  private async readAttemptReplay(
    client: pg.PoolClient,
    input: AttemptAdmissionSemanticInput,
    fingerprint: string,
  ): Promise<AdmissionResult | null> {
    const prior = await client.query(
      `SELECT id,source_fingerprint,team_id,team_display_name,cost_center_code
       FROM ai_usage_attempt_admissions
       WHERE tenant_id=$1 AND source_system=$2 AND source_attempt_id=$3`,
      [input.tenantId,input.sourceSystem,input.sourceAttemptId],
    );
    if (!prior.rowCount) return null;
    if (prior.rows[0].source_fingerprint === fingerprint) {
      return {
        status:"duplicate",admissionId:String(prior.rows[0].id),
        team:{
          id:String(prior.rows[0].team_id),
          displayName:String(prior.rows[0].team_display_name),
          costCenterCode:prior.rows[0].cost_center_code === null ? null : String(prior.rows[0].cost_center_code),
        },
      };
    }
    await client.query(
      `INSERT INTO ai_usage_ingestion_conflicts (
         id,tenant_id,source_system,source_event_id,existing_fingerprint,received_fingerprint,conflict_type
       ) VALUES ($1,$2,$3,$4,$5,$6,'attempt_fingerprint_mismatch') ON CONFLICT DO NOTHING`,
      [randomUUID(),input.tenantId,input.sourceSystem,input.sourceAttemptId,prior.rows[0].source_fingerprint,fingerprint],
    );
    return { status:"conflict",admissionId:null };
  }

  async replayAttempt(input: AttemptAdmissionSemanticInput): Promise<AdmissionResult | null> {
    const fingerprint = attemptAdmissionFingerprint(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ai-attempt:${input.tenantId}:${input.sourceSystem}:${input.sourceAttemptId}`]);
      const replay = await this.readAttemptReplay(client,input,fingerprint);
      await client.query("COMMIT");
      return replay;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async createRateCard(input: RateCardInput) {
    validateRateCard(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = await this.insertRateCard(client,input);
      await client.query("COMMIT");
      return id;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async admitAttempt(input: AttemptAdmissionInput,hook:UsageAttemptAdmissionHook=new AllowUsageAttemptAdmission()): Promise<AdmissionResult> {
    const fingerprint = attemptAdmissionFingerprint(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ai-attempt:${input.tenantId}:${input.sourceSystem}:${input.sourceAttemptId}`]);
      const replay = await this.readAttemptReplay(client,input,fingerprint);
      if (replay) { await client.query("COMMIT"); return replay; }
      const decision=await hook.admit(input,client);
      if(decision.decision==="deny"){await client.query("ROLLBACK");return {status:"denied",admissionId:null,denialCode:decision.code};}
      const id = randomUUID();
      await client.query(`INSERT INTO ai_usage_attempt_admissions (id,tenant_id,source_system,source_attempt_id,source_fingerprint,subject_id,team_id,team_display_name,cost_center_code,workspace_id,agent_id,session_id,task_id,turn_id,task_binding_provenance,context_kind,policy_version_id,policy_hash,requested_alias,requested_service_class,selected_service_class,route_mapping_version,attempt_kind,parent_attempt_id,resolved_provider,provider_account_id,resolved_model,resolved_deployment_id,region,provider_service_tier,admitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`, [id,input.tenantId,input.sourceSystem,input.sourceAttemptId,fingerprint,input.subjectId,input.team.id,input.team.displayName,input.team.costCenterCode,input.workspaceId??null,input.agentId??null,input.sessionId??null,input.taskId,input.turnId??null,input.taskBindingProvenance,input.contextKind,input.policyVersionId??null,input.policyHash??null,input.requestedAlias,input.requestedServiceClass??null,input.selectedServiceClass??null,input.routeMappingVersion??null,input.attemptKind,input.parentAttemptId??null,input.resolvedProvider,input.providerAccountId,input.resolvedModel,input.resolvedDeploymentId,input.region??null,input.providerServiceTier??null,input.admittedAt]);
      await client.query("COMMIT");
      return { status:"created",admissionId:id,team:{ id:input.team.id,displayName:input.team.displayName,costCenterCode:input.team.costCenterCode } };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async selectEffectiveRateCard(input: {
    tenantId: string; provider: string; providerAccountId: string; baseModel: string;
    deploymentId: string; region?: string; providerServiceTier?: string; at: Date;
  }): Promise<EffectiveRateCard | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await this.readEffectiveRateCard(client,input);
      await client.query("COMMIT");
      return selected;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async appendUsageEvent(input: UsageEventInput): Promise<UsageEventResult> {
    input.units.forEach((unit) => {
      assertUnit(unit.unit);
      const quantity = scaled(unit.quantity);
      if (input.eventType === "usage" && quantity < 0n) throw new Error("Usage quantities cannot be negative");
    });
    assertUniqueUnits(input.units, "usage");
    if (input.eventType === "usage" && input.correctsEventId) throw new Error("Usage events cannot correct another event");
    if (input.eventType === "correction" && !input.correctsEventId) throw new Error("Corrections require an original event");
    if (input.providerReportedTotalTokens !== undefined) {
      const total = scaled(input.providerReportedTotalTokens);
      if (input.eventType === "usage" && total < 0n) throw new Error("Usage totals cannot be negative");
    }
    if (input.providerConfirmedCost !== undefined) scaled(input.providerConfirmedCost);
    if ((input.providerConfirmedCost === undefined) !== (input.providerConfirmedCurrency === undefined)) throw new Error("Provider-confirmed cost and currency must be supplied together");
    if (input.providerConfirmedCurrency !== undefined && !/^[A-Z]{3}$/.test(input.providerConfirmedCurrency)) throw new Error("Invalid provider-confirmed currency");
    const drivers = input.costDrivers ?? {};
    const driverValues = [
      nonnegativeInteger(drivers.conversationHistoryCount,"conversationHistoryCount"),
      nonnegativeInteger(drivers.attachmentCount,"attachmentCount"),
      nonnegativeInteger(drivers.retrievalCount,"retrievalCount"),
      nonnegativeInteger(drivers.systemPolicyContextCount,"systemPolicyContextCount"),
      nonnegativeInteger(drivers.toolResultContextCount,"toolResultContextCount"),
      nonnegativeInteger(drivers.routingOverheadCount,"routingOverheadCount"),
    ];
    if (input.eventType === "correction" && driverValues.some((value) => value !== 0)) throw new Error("Correction events cannot repeat cost-driver counts");
    const fingerprint = usageFingerprint(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ai-event:${input.tenantId}:${input.sourceSystem}:${input.sourceEventId}`]);
      const prior = await client.query(`SELECT id,source_fingerprint,price_status,provider_cost,currency FROM ai_usage_events WHERE tenant_id=$1 AND source_system=$2 AND source_event_id=$3`, [input.tenantId,input.sourceSystem,input.sourceEventId]);
      if (prior.rowCount) {
        if (prior.rows[0].source_fingerprint === fingerprint) {
          await client.query("COMMIT");
          return { status:"duplicate", eventId:String(prior.rows[0].id), priceStatus:prior.rows[0].price_status, providerCost:prior.rows[0].provider_cost, currency:prior.rows[0].currency };
        }
        await client.query(`INSERT INTO ai_usage_ingestion_conflicts (id,tenant_id,source_system,source_event_id,existing_fingerprint,received_fingerprint,conflict_type) VALUES ($1,$2,$3,$4,$5,$6,'event_fingerprint_mismatch') ON CONFLICT DO NOTHING`, [randomUUID(),input.tenantId,input.sourceSystem,input.sourceEventId,prior.rows[0].source_fingerprint,fingerprint]);
        await client.query("COMMIT"); return { status:"conflict", eventId:null };
      }
      const pendingResult = await client.query(`SELECT id,source_fingerprint,admission_id,corrects_event_id FROM ai_usage_pending_corrections WHERE tenant_id=$1 AND source_system=$2 AND source_event_id=$3 FOR SHARE`, [input.tenantId,input.sourceSystem,input.sourceEventId]);
      const pending = pendingResult.rows[0];
      if (pending && (
        input.eventType !== "correction"
        || pending.source_fingerprint !== fingerprint
        || String(pending.admission_id) !== input.admissionId
        || String(pending.corrects_event_id) !== input.correctsEventId
      )) {
        await client.query(`INSERT INTO ai_usage_ingestion_conflicts (id,tenant_id,source_system,source_event_id,existing_fingerprint,received_fingerprint,conflict_type) VALUES ($1,$2,$3,$4,$5,$6,'event_fingerprint_mismatch') ON CONFLICT DO NOTHING`, [randomUUID(),input.tenantId,input.sourceSystem,input.sourceEventId,pending.source_fingerprint,fingerprint]);
        await client.query("COMMIT"); return { status:"conflict", eventId:null };
      }
      const admissionResult = await client.query(`SELECT * FROM ai_usage_attempt_admissions WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [input.tenantId,input.admissionId]);
      if (!admissionResult.rowCount) throw new Error("Usage admission not found in tenant");
      const admission = admissionResult.rows[0];
      let correctionRateCardId: string | null | undefined;
      if (input.eventType === "correction") {
        const original = await client.query(`SELECT id,rate_card_id,admission_id,event_type FROM ai_usage_events WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [input.tenantId,input.correctsEventId]);
        if (!original.rowCount) {
          if (!pending) {
            await client.query(`INSERT INTO ai_usage_pending_corrections (id,tenant_id,admission_id,source_system,source_event_id,source_fingerprint,corrects_event_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(),input.tenantId,input.admissionId,input.sourceSystem,input.sourceEventId,fingerprint,input.correctsEventId,input.occurredAt]);
          }
          await client.query("COMMIT");
          return { status:"pending", eventId:null };
        }
        if (original.rows[0].event_type !== "usage" || String(original.rows[0].admission_id) !== input.admissionId) {
          throw new Error("Correction target must be an existing original usage event for the same attempt");
        }
        correctionRateCardId = original.rows[0].rate_card_id;
      }
      const rateCard = input.eventType === "correction" ? (correctionRateCardId ? await this.readRateCardById(client,input.tenantId,correctionRateCardId) : null) : await this.readEffectiveRateCard(client, {
        tenantId:input.tenantId, provider:String(admission.resolved_provider), providerAccountId:String(admission.provider_account_id),
        baseModel:String(admission.resolved_model), deploymentId:String(admission.resolved_deployment_id),
        region:admission.region ?? undefined, providerServiceTier:admission.provider_service_tier ?? undefined, at:input.occurredAt,
      });
      if (rateCard && input.providerConfirmedCurrency && input.providerConfirmedCurrency !== rateCard.currency) {
        throw new Error("Provider-confirmed currency must match the selected rate-card currency");
      }
      const priced = priceUsage(input.units, rateCard?.rates ?? []);
      const currency = rateCard?.currency ?? input.providerConfirmedCurrency ?? null;
      const costStatus = input.providerConfirmedCost !== undefined ? "provider_confirmed" : priced.priceStatus === "priced" ? "estimated" : "unpriced";
      const id = randomUUID();
      await client.query(`INSERT INTO ai_usage_events (
        id,tenant_id,admission_id,source_system,source_event_id,source_fingerprint,event_type,corrects_event_id,correction_semantics,
        occurred_at,outcome,error_class,latency_ms,provider_reported_total_tokens,price_status,cost_status,currency,provider_cost,
        provider_confirmed_cost,rate_card_id,rate_card_source,rate_card_source_version,rate_card_source_hash,rate_card_effective_from,
        conversation_history_count,attachment_count,retrieval_count,system_policy_context_count,tool_result_context_count,routing_overhead_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`, [
        id,input.tenantId,input.admissionId,input.sourceSystem,input.sourceEventId,fingerprint,input.eventType,input.correctsEventId??null,input.eventType==="correction"?"delta":null,
        input.occurredAt,input.outcome,input.errorClass??null,input.latencyMs??null,input.providerReportedTotalTokens??null,priced.priceStatus,costStatus,currency,priced.providerCost,
        input.providerConfirmedCost??null,rateCard?.id??null,rateCard?.source??null,rateCard?.sourceVersion??null,rateCard?.sourceHash??null,rateCard?.effectiveFrom??null,...driverValues,
      ]);
      for (const bucket of priced.buckets) await client.query(`INSERT INTO ai_usage_event_units (tenant_id,event_id,unit,quantity,rate_amount_per_unit,rate_unit_scale,bucket_cost,is_provider_diagnostic) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [input.tenantId,id,bucket.unit,bucket.quantity,bucket.rateAmountPerUnit,bucket.rateUnitScale,bucket.bucketCost,bucket.diagnostic===true]);
      await client.query("COMMIT");
      return { status:"created", eventId:id, priceStatus:priced.priceStatus, providerCost:priced.providerCost, currency };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async listRateCards(tenantId:string,limit=200) {
    if (!Number.isInteger(limit)||limit<1||limit>500) throw new Error("Rate-card limit must be between 1 and 500");
    const result=await this.pool.query(`SELECT card.*,COALESCE(jsonb_agg(jsonb_build_object('unit',rate.unit,'amountPerUnit',rate.amount_per_unit::text,'unitScale',rate.unit_scale::text) ORDER BY rate.unit) FILTER (WHERE rate.unit IS NOT NULL),'[]'::jsonb) AS rates FROM ai_deployment_rate_cards card LEFT JOIN ai_deployment_rate_card_rates rate ON rate.tenant_id=card.tenant_id AND rate.rate_card_id=card.id WHERE card.tenant_id=$1 GROUP BY card.id ORDER BY card.effective_from DESC,card.id DESC LIMIT $2`,[tenantId,limit]);
    return result.rows.map((row)=>({ id:String(row.id),provider:String(row.provider),providerAccountId:String(row.provider_account_id),baseModel:String(row.base_model),deploymentId:String(row.deployment_id),region:row.region,providerServiceTier:row.provider_service_tier,currency:String(row.currency),source:String(row.source),sourceVersion:String(row.source_version),sourceHash:String(row.source_hash),catalogueRelease:row.catalogue_release,effectiveFrom:new Date(row.effective_from).toISOString(),effectiveTo:row.effective_to?new Date(row.effective_to).toISOString():null,approvedAt:new Date(row.approved_at).toISOString(),approvedBy:row.approved_by,overrideReason:row.override_reason,rates:row.rates }));
  }

  async listUsageEvents(input:UsageEventQuery):Promise<{events:UsageEventView[];nextCursor:{occurredAt:string;id:string}|null}> {
    const limit=boundedQuery(input.from,input.to,input.limit);
    const values:unknown[]=[input.tenantId,input.from,input.to,limit+1];
    const filters=["event.tenant_id=$1","event.occurred_at >= $2","event.occurred_at < $3"];
    const add=(sql:string,value:unknown)=>{values.push(value);filters.push(sql.replace("?",`$${values.length}`));};
    if(input.cursor){values.push(input.cursor.occurredAt,input.cursor.id);filters.push(`(event.occurred_at,event.id) < ($${values.length-1},$${values.length}::uuid)`);}
    if(input.teamId)add("admission.team_id=?::uuid",input.teamId);
    if(input.subjectId)add("admission.subject_id=?",input.subjectId);
    if(input.taskId)add("admission.task_id=?",input.taskId);
    const result=await this.pool.query(`SELECT event.*,admission.subject_id,admission.team_id,admission.team_display_name,admission.cost_center_code,admission.workspace_id,admission.agent_id,admission.session_id,admission.task_id,admission.turn_id,admission.task_binding_provenance,admission.context_kind,admission.requested_alias,admission.requested_service_class,admission.selected_service_class,admission.attempt_kind,admission.resolved_provider,admission.resolved_model,admission.resolved_deployment_id,COALESCE(jsonb_agg(jsonb_build_object('unit',unit.unit,'quantity',unit.quantity::text,'bucketCost',unit.bucket_cost::text,'diagnostic',unit.is_provider_diagnostic) ORDER BY unit.unit) FILTER (WHERE unit.unit IS NOT NULL),'[]'::jsonb) AS units FROM ai_usage_events event JOIN ai_usage_attempt_admissions admission ON admission.tenant_id=event.tenant_id AND admission.id=event.admission_id LEFT JOIN ai_usage_event_units unit ON unit.tenant_id=event.tenant_id AND unit.event_id=event.id WHERE ${filters.join(" AND ")} GROUP BY event.id,admission.id ORDER BY event.occurred_at DESC,event.id DESC LIMIT $4`,values);
    const rows=result.rows.slice(0,limit);
    const events:UsageEventView[]=rows.map((row)=>({ id:String(row.id),occurredAt:new Date(row.occurred_at).toISOString(),eventType:row.event_type,correctsEventId:row.corrects_event_id,sourceSystem:String(row.source_system),sourceEventId:String(row.source_event_id),outcome:String(row.outcome),errorClass:row.error_class,latencyMs:row.latency_ms,subjectId:String(row.subject_id),teamId:String(row.team_id),teamDisplayName:String(row.team_display_name),costCenterCode:row.cost_center_code,workspaceId:row.workspace_id,agentId:row.agent_id,sessionId:row.session_id,taskId:String(row.task_id),turnId:row.turn_id,taskBindingProvenance:String(row.task_binding_provenance),contextKind:String(row.context_kind),requestedAlias:String(row.requested_alias),requestedServiceClass:row.requested_service_class,selectedServiceClass:row.selected_service_class,attemptKind:String(row.attempt_kind),resolvedProvider:String(row.resolved_provider),resolvedModel:String(row.resolved_model),resolvedDeploymentId:String(row.resolved_deployment_id),currency:row.currency,providerCost:row.provider_cost,providerConfirmedCost:row.provider_confirmed_cost,priceStatus:String(row.price_status),costStatus:String(row.cost_status),rateCardId:row.rate_card_id,rateCardSourceVersion:row.rate_card_source_version,units:row.units }));
    const last=events.at(-1);
    return {events,nextCursor:result.rows.length>limit&&last?{occurredAt:last.occurredAt,id:last.id}:null};
  }

  async providerCostTotals(input:Omit<UsageEventQuery,"limit"|"cursor">) {
    boundedQuery(input.from,input.to,1);
    const values:unknown[]=[input.tenantId,input.from,input.to];
    const filters=["event.tenant_id=$1","event.occurred_at >= $2","event.occurred_at < $3","event.provider_cost IS NOT NULL"];
    const add=(sql:string,value:unknown)=>{values.push(value);filters.push(sql.replace("?",`$${values.length}`));};
    if(input.teamId)add("admission.team_id=?::uuid",input.teamId);
    if(input.subjectId)add("admission.subject_id=?",input.subjectId);
    if(input.taskId)add("admission.task_id=?",input.taskId);
    const result=await this.pool.query(`SELECT event.currency,sum(event.provider_cost)::text AS provider_cost FROM ai_usage_events event JOIN ai_usage_attempt_admissions admission ON admission.tenant_id=event.tenant_id AND admission.id=event.admission_id WHERE ${filters.join(" AND ")} GROUP BY event.currency ORDER BY event.currency`,values);
    return result.rows.map((row)=>({currency:String(row.currency),providerCost:String(row.provider_cost)}));
  }

  async reconcile(input:ReconciliationInput) {
    if(!(input.windowStart<input.windowEnd)||input.windowEnd.getTime()-input.windowStart.getTime()>31*24*60*60*1000)throw new Error("Reconciliation window must be positive and at most 31 days");
    if(input.expected.length>1000)throw new Error("Reconciliation accepts at most 1000 expected events");
    input.expected.forEach((item)=>{if(!/^[a-f0-9]{64}$/.test(item.fingerprint))throw new Error("Invalid reconciliation fingerprint");});
    const sorted=[...input.expected].sort((a,b)=>a.sourceEventId.localeCompare(b.sourceEventId)||a.fingerprint.localeCompare(b.fingerprint));
    const expectedFingerprint=usageFingerprint(sorted);
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const runId=randomUUID();
      await client.query(`INSERT INTO ai_usage_reconciliation_runs (id,tenant_id,source_system,window_start,window_end,expected_fingerprint,started_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[runId,input.tenantId,input.sourceSystem,input.windowStart,input.windowEnd,expectedFingerprint,input.startedBy]);
      const observed=await client.query(`SELECT id,source_event_id,source_fingerprint,price_status,occurred_at,received_at FROM ai_usage_events WHERE tenant_id=$1 AND source_system=$2 AND occurred_at >= $3 AND occurred_at < $4 ORDER BY source_event_id,id`,[input.tenantId,input.sourceSystem,input.windowStart,input.windowEnd]);
      const missingCompletions=await client.query(`SELECT admission.id FROM ai_usage_attempt_admissions admission WHERE admission.tenant_id=$1 AND admission.source_system=$2 AND admission.admitted_at >= $3 AND admission.admitted_at < $4 AND NOT EXISTS (SELECT 1 FROM ai_usage_events event WHERE event.tenant_id=admission.tenant_id AND event.admission_id=admission.id AND event.event_type='usage') ORDER BY admission.id`,[input.tenantId,input.sourceSystem,input.windowStart,input.windowEnd]);
      const pendingCorrections=await client.query(`SELECT pending.source_event_id,pending.source_fingerprint,pending.corrects_event_id FROM ai_usage_pending_corrections pending WHERE pending.tenant_id=$1 AND pending.source_system=$2 AND pending.occurred_at >= $3 AND pending.occurred_at < $4 AND NOT EXISTS (SELECT 1 FROM ai_usage_events event WHERE event.tenant_id=pending.tenant_id AND event.source_system=pending.source_system AND event.source_event_id=pending.source_event_id) ORDER BY pending.source_event_id,pending.id`,[input.tenantId,input.sourceSystem,input.windowStart,input.windowEnd]);
      const bySource=new Map<string,typeof observed.rows>();
      for(const row of observed.rows){const key=String(row.source_event_id);bySource.set(key,[...(bySource.get(key)??[]),row]);}
      const findings:ReconciliationFinding[]=[];
      const expectedBySource=new Map<string,string[]>();
      for(const item of sorted)expectedBySource.set(item.sourceEventId,[...(expectedBySource.get(item.sourceEventId)??[]),item.fingerprint]);
      for(const [sourceEventId,fingerprints] of expectedBySource){
        if(fingerprints.length>1)findings.push({findingType:"duplicate",sourceEventId,ledgerEventId:null,expectedFingerprint:fingerprints[0]!,observedFingerprint:null,details:"Expected evidence contains duplicate source event IDs"});
        const rows=bySource.get(sourceEventId)??[];
        if(!rows.length)findings.push({findingType:"missing",sourceEventId,ledgerEventId:null,expectedFingerprint:fingerprints[0]!,observedFingerprint:null,details:"Expected source event is absent from the immutable ledger"});
        for(const row of rows){
          if(row.source_fingerprint!==fingerprints[0])findings.push({findingType:"inconsistent",sourceEventId,ledgerEventId:String(row.id),expectedFingerprint:fingerprints[0]!,observedFingerprint:String(row.source_fingerprint),details:"Observed event fingerprint differs from expected evidence"});
          if(row.price_status!=="priced")findings.push({findingType:"unknown_price",sourceEventId,ledgerEventId:String(row.id),expectedFingerprint:fingerprints[0]!,observedFingerprint:String(row.source_fingerprint),details:`Observed event price status is ${row.price_status}`});
          if(new Date(row.received_at)>=input.windowEnd)findings.push({findingType:"late",sourceEventId,ledgerEventId:String(row.id),expectedFingerprint:fingerprints[0]!,observedFingerprint:String(row.source_fingerprint),details:"Event arrived after the reconciliation window closed"});
        }
      }
      for(const row of observed.rows)if(!expectedBySource.has(String(row.source_event_id)))findings.push({findingType:"inconsistent",sourceEventId:String(row.source_event_id),ledgerEventId:String(row.id),expectedFingerprint:null,observedFingerprint:String(row.source_fingerprint),details:"Ledger event has no matching expected evidence"});
      for(const row of missingCompletions.rows){
        const sourceEventId=`${row.id}:completion`;
        if(!findings.some((finding)=>finding.findingType==="missing"&&finding.sourceEventId===sourceEventId))findings.push({findingType:"missing",sourceEventId,ledgerEventId:null,expectedFingerprint:null,observedFingerprint:null,details:"Admitted provider attempt has no immutable usage completion event"});
      }
      for(const row of pendingCorrections.rows)if(!findings.some((finding)=>finding.findingType==="missing"&&finding.sourceEventId===String(row.source_event_id)))findings.push({findingType:"missing",sourceEventId:String(row.source_event_id),ledgerEventId:null,expectedFingerprint:String(row.source_fingerprint),observedFingerprint:null,details:`Correction is pending original usage event ${row.corrects_event_id}`});
      const conflicts=await client.query(`SELECT source_event_id,existing_fingerprint,received_fingerprint FROM ai_usage_ingestion_conflicts WHERE tenant_id=$1 AND source_system=$2 AND detected_at >= $3 AND detected_at < $4 ORDER BY source_event_id,id`,[input.tenantId,input.sourceSystem,input.windowStart,input.windowEnd]);
      for(const row of conflicts.rows)findings.push({findingType:"inconsistent",sourceEventId:String(row.source_event_id),ledgerEventId:null,expectedFingerprint:String(row.existing_fingerprint),observedFingerprint:String(row.received_fingerprint),details:"Conflicting replay was quarantined"});
      for(const finding of findings)await client.query(`INSERT INTO ai_usage_reconciliation_findings (id,tenant_id,run_id,finding_type,source_event_id,ledger_event_id,expected_fingerprint,observed_fingerprint,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),input.tenantId,runId,finding.findingType,finding.sourceEventId,finding.ledgerEventId,finding.expectedFingerprint,finding.observedFingerprint,finding.details]);
      await client.query("COMMIT");return {runId,expectedFingerprint,findings};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  private async readEffectiveRateCard(client: pg.PoolClient, input: {
    tenantId: string; provider: string; providerAccountId: string; baseModel: string;
    deploymentId: string; region?: string; providerServiceTier?: string; at: Date;
  }): Promise<EffectiveRateCard | null> {
    const existing = await this.queryEffectiveRateCard(client,input);
    if (existing?.source === "contract_override") return existing;
    const catalogue = pinnedRateCardForDeployment(input);
    if (catalogue.status === "unsupported") return existing;
    const isCurrentPinned = (card: EffectiveRateCard | null) => card?.source === "pinned_catalogue"
      && card.sourceVersion === catalogue.card.sourceVersion
      && card.sourceHash === catalogue.card.sourceHash
      && card.effectiveFrom.getTime() === catalogue.card.effectiveFrom.getTime();
    if (
      catalogue.card.effectiveFrom > input.at
      || isCurrentPinned(existing)
    ) return existing;

    const routeHash = usageFingerprint({
      tenantId:input.tenantId,provider:input.provider,providerAccountId:input.providerAccountId,
      baseModel:input.baseModel,deploymentId:input.deploymentId,region:asNullableText(input.region),
      providerServiceTier:asNullableText(input.providerServiceTier),
    });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ai-rate-card:${routeHash}`]);
    const selectedAfterLock = await this.queryEffectiveRateCard(client,input);
    if (
      selectedAfterLock?.source === "contract_override"
      || isCurrentPinned(selectedAfterLock)
    ) return selectedAfterLock;

    const priorCatalogueCard = await client.query(`SELECT id FROM ai_deployment_rate_cards
      WHERE tenant_id=$1 AND provider=$2 AND provider_account_id=$3 AND base_model=$4 AND deployment_id=$5
        AND region IS NOT DISTINCT FROM $6::text AND provider_service_tier IS NOT DISTINCT FROM $7::text
        AND source='pinned_catalogue' AND source_version=$8 AND source_hash=$9 AND effective_from=$10
        AND effective_to IS NULL
      LIMIT 1`, [
      input.tenantId,input.provider,input.providerAccountId,input.baseModel,input.deploymentId,
      asNullableText(input.region),asNullableText(input.providerServiceTier),
      catalogue.card.sourceVersion,catalogue.card.sourceHash,catalogue.card.effectiveFrom,
    ]);
    const pinnedCardId = priorCatalogueCard.rowCount
      ? String(priorCatalogueCard.rows[0].id)
      : await this.insertRateCard(client,catalogue.card);
    const finalSelection = await this.queryEffectiveRateCard(client,input);
    if (finalSelection?.source === "contract_override") return finalSelection;
    return this.readRateCardById(client,input.tenantId,pinnedCardId);
  }

  private async queryEffectiveRateCard(client: pg.PoolClient, input: {
    tenantId: string; provider: string; providerAccountId: string; baseModel: string;
    deploymentId: string; region?: string; providerServiceTier?: string; at: Date;
  }): Promise<EffectiveRateCard | null> {
    const selected = await client.query(`SELECT id,currency,source,source_version,source_hash,effective_from
      FROM ai_deployment_rate_cards
      WHERE tenant_id=$1 AND provider=$2 AND provider_account_id=$3 AND base_model=$4 AND deployment_id=$5
        AND region IS NOT DISTINCT FROM $6::text AND provider_service_tier IS NOT DISTINCT FROM $7::text
        AND effective_from <= $8 AND (effective_to IS NULL OR effective_to > $8)
      ORDER BY CASE source WHEN 'contract_override' THEN 3 WHEN 'pinned_catalogue' THEN 2 ELSE 1 END DESC,
        effective_from DESC, created_at DESC, id DESC LIMIT 1`, [input.tenantId,input.provider,input.providerAccountId,input.baseModel,input.deploymentId,asNullableText(input.region),asNullableText(input.providerServiceTier),input.at]);
    if (!selected.rowCount) return null;
    return this.readRateCardById(client,input.tenantId,String(selected.rows[0].id));
  }

  private async insertRateCard(client: pg.PoolClient,input: RateCardInput): Promise<string> {
    validateRateCard(input);
    const id = randomUUID();
    await client.query(`INSERT INTO ai_deployment_rate_cards (id,tenant_id,provider,provider_account_id,base_model,deployment_id,region,provider_service_tier,currency,source,source_version,source_hash,catalogue_release,effective_from,effective_to,approved_at,approved_by,override_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17)`, [id,input.tenantId,input.provider,input.providerAccountId,input.baseModel,input.deploymentId,input.region??null,input.providerServiceTier??null,input.currency,input.source,input.sourceVersion,input.sourceHash,input.catalogueRelease??null,input.effectiveFrom,input.effectiveTo??null,input.approvedBy??null,input.overrideReason??null]);
    for (const rate of input.rates) await client.query(`INSERT INTO ai_deployment_rate_card_rates (tenant_id,rate_card_id,unit,amount_per_unit,unit_scale) VALUES ($1,$2,$3,$4,$5)`, [input.tenantId,id,rate.unit,rate.amountPerUnit,rate.unitScale]);
    return id;
  }

  private async readRateCardById(client: pg.PoolClient, tenantId: string, rateCardId: string): Promise<EffectiveRateCard | null> {
    const selected = await client.query(`SELECT id,currency,source,source_version,source_hash,effective_from FROM ai_deployment_rate_cards WHERE tenant_id=$1 AND id=$2`, [tenantId,rateCardId]);
    if (!selected.rowCount) return null;
    const row = selected.rows[0];
    const rates = await client.query(`SELECT unit,amount_per_unit,unit_scale FROM ai_deployment_rate_card_rates WHERE tenant_id=$1 AND rate_card_id=$2 ORDER BY unit`, [tenantId,row.id]);
    return {
      id:String(row.id), currency:String(row.currency), source:row.source, sourceVersion:String(row.source_version),
      sourceHash:String(row.source_hash), effectiveFrom:new Date(row.effective_from),
      rates:rates.rows.map((rate) => ({ unit:String(rate.unit) as UsageUnit, amountPerUnit:String(rate.amount_per_unit), unitScale:String(rate.unit_scale) })),
    };
  }
}
