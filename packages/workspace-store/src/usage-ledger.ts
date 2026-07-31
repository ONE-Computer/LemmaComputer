import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { MinimalSpendingTeam } from "@onecomputer/contracts";

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
export type AttemptAdmissionInput = {
  tenantId: string; sourceSystem: string; sourceAttemptId: string; subjectId: string; team: MinimalSpendingTeam;
  workspaceId?: string; agentId?: string; sessionId?: string; taskId: string; turnId?: string;
  taskBindingProvenance: "explicit_signed"|"unbound_generated"; policyVersionId?: string; policyHash?: string;
  requestedAlias: string; requestedServiceClass?: "auto"|"lite"|"balanced"|"pro"; selectedServiceClass?: "lite"|"balanced"|"pro";
  routeMappingVersion?: string; attemptKind: "inference"|"router"|"classifier"|"embedding"|"retry"|"fallback"; parentAttemptId?: string;
  resolvedProvider: string; providerAccountId: string; resolvedModel: string; resolvedDeploymentId: string; region?: string; providerServiceTier?: string; admittedAt: Date;
};
export type AdmissionResult = { status: "created"|"duplicate"|"conflict"; admissionId: string | null };

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
  status: "created"|"duplicate"|"conflict"; eventId: string | null;
  priceStatus?: PricedUsage["priceStatus"]; providerCost?: string | null; currency?: string | null;
};
export type EffectiveRateCard = {
  id: string; currency: string; source: RateCardInput["source"]; sourceVersion: string;
  sourceHash: string; effectiveFrom: Date; rates: RateAmount[];
};

const nonnegativeInteger = (value: number | undefined, name: string) => {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw new Error(`${name} must be a non-negative integer`);
  return normalized;
};
const asNullableText = (value: string | undefined) => value ?? null;

export interface UsageAttemptAdmissionHook {
  admit(input: AttemptAdmissionInput): Promise<{ decision: "allow" }|{ decision: "deny"; code: string }>;
}
export class AllowUsageAttemptAdmission implements UsageAttemptAdmissionHook {
  async admit() { return { decision: "allow" as const }; }
}

export class PostgresUsageLedgerStore {
  constructor(private readonly pool: pg.Pool) {}
  static fromConnectionString(connectionString: string) { return new PostgresUsageLedgerStore(new pg.Pool({ connectionString, max: 5 })); }
  async close() { await this.pool.end(); }

  async createRateCard(input: RateCardInput) {
    if (!input.rates.length) throw new Error("A rate card requires at least one rate");
    if (input.source === "contract_override" && (!input.approvedBy || !input.overrideReason)) throw new Error("Contract overrides require actor and reason");
    const id = randomUUID();
    input.rates.forEach((rate) => { assertUnit(rate.unit); scaled(rate.amountPerUnit); scaled(rate.unitScale); });
    assertUniqueUnits(input.rates, "rate");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO ai_deployment_rate_cards (id,tenant_id,provider,provider_account_id,base_model,deployment_id,region,provider_service_tier,currency,source,source_version,source_hash,catalogue_release,effective_from,effective_to,approved_at,approved_by,override_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17)`, [id,input.tenantId,input.provider,input.providerAccountId,input.baseModel,input.deploymentId,input.region??null,input.providerServiceTier??null,input.currency,input.source,input.sourceVersion,input.sourceHash,input.catalogueRelease??null,input.effectiveFrom,input.effectiveTo??null,input.approvedBy??null,input.overrideReason??null]);
      for (const rate of input.rates) await client.query(`INSERT INTO ai_deployment_rate_card_rates (tenant_id,rate_card_id,unit,amount_per_unit,unit_scale) VALUES ($1,$2,$3,$4,$5)`, [input.tenantId,id,rate.unit,rate.amountPerUnit,rate.unitScale]);
      await client.query("COMMIT");
      return id;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async admitAttempt(input: AttemptAdmissionInput): Promise<AdmissionResult> {
    const fingerprint = usageFingerprint(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ai-attempt:${input.tenantId}:${input.sourceSystem}:${input.sourceAttemptId}`]);
      const prior = await client.query(`SELECT id,source_fingerprint FROM ai_usage_attempt_admissions WHERE tenant_id=$1 AND source_system=$2 AND source_attempt_id=$3`, [input.tenantId,input.sourceSystem,input.sourceAttemptId]);
      if (prior.rowCount) {
        if (prior.rows[0].source_fingerprint === fingerprint) { await client.query("COMMIT"); return { status:"duplicate", admissionId:String(prior.rows[0].id) }; }
        await client.query(`INSERT INTO ai_usage_ingestion_conflicts (id,tenant_id,source_system,source_event_id,existing_fingerprint,received_fingerprint,conflict_type) VALUES ($1,$2,$3,$4,$5,$6,'attempt_fingerprint_mismatch') ON CONFLICT DO NOTHING`, [randomUUID(),input.tenantId,input.sourceSystem,input.sourceAttemptId,prior.rows[0].source_fingerprint,fingerprint]);
        await client.query("COMMIT"); return { status:"conflict", admissionId:null };
      }
      const id = randomUUID();
      await client.query(`INSERT INTO ai_usage_attempt_admissions (id,tenant_id,source_system,source_attempt_id,source_fingerprint,subject_id,team_id,team_display_name,cost_center_code,workspace_id,agent_id,session_id,task_id,turn_id,task_binding_provenance,policy_version_id,policy_hash,requested_alias,requested_service_class,selected_service_class,route_mapping_version,attempt_kind,parent_attempt_id,resolved_provider,provider_account_id,resolved_model,resolved_deployment_id,region,provider_service_tier,admitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`, [id,input.tenantId,input.sourceSystem,input.sourceAttemptId,fingerprint,input.subjectId,input.team.id,input.team.displayName,input.team.costCenterCode,input.workspaceId??null,input.agentId??null,input.sessionId??null,input.taskId,input.turnId??null,input.taskBindingProvenance,input.policyVersionId??null,input.policyHash??null,input.requestedAlias,input.requestedServiceClass??null,input.selectedServiceClass??null,input.routeMappingVersion??null,input.attemptKind,input.parentAttemptId??null,input.resolvedProvider,input.providerAccountId,input.resolvedModel,input.resolvedDeploymentId,input.region??null,input.providerServiceTier??null,input.admittedAt]);
      await client.query("COMMIT"); return { status:"created", admissionId:id };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }

  }
  async selectEffectiveRateCard(input: {
    tenantId: string; provider: string; providerAccountId: string; baseModel: string;
    deploymentId: string; region?: string; providerServiceTier?: string; at: Date;
  }): Promise<EffectiveRateCard | null> {
    const client = await this.pool.connect();
    try { return await this.readEffectiveRateCard(client, input); } finally { client.release(); }
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
      const admissionResult = await client.query(`SELECT * FROM ai_usage_attempt_admissions WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [input.tenantId,input.admissionId]);
      if (!admissionResult.rowCount) throw new Error("Usage admission not found in tenant");
      const admission = admissionResult.rows[0];
      let correctionRateCardId: string | null | undefined;
      if (input.eventType === "correction") {
        const original = await client.query(`SELECT id,rate_card_id FROM ai_usage_events WHERE tenant_id=$1 AND id=$2 AND admission_id=$3 AND event_type='usage' FOR SHARE`, [input.tenantId,input.correctsEventId,input.admissionId]);
        if (!original.rowCount) throw new Error("Correction target must be an existing original usage event for the same attempt");
        correctionRateCardId = original.rows[0].rate_card_id;
      }
      const rateCard = input.eventType === "correction" ? (correctionRateCardId ? await this.readRateCardById(client,input.tenantId,correctionRateCardId) : null) : await this.readEffectiveRateCard(client, {
        tenantId:input.tenantId, provider:String(admission.resolved_provider), providerAccountId:String(admission.provider_account_id),
        baseModel:String(admission.resolved_model), deploymentId:String(admission.resolved_deployment_id),
        region:admission.region ?? undefined, providerServiceTier:admission.provider_service_tier ?? undefined, at:input.occurredAt,
      });
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

  private async readEffectiveRateCard(client: pg.PoolClient, input: {
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
