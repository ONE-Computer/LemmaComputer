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
        await client.query(`INSERT INTO ai_usage_ingestion_conflicts (id,tenant_id,source_system,source_event_id,existing_fingerprint,received_fingerprint,conflict_type) VALUES ($1,$2,$3,$4,$5,$6,'attempt_fingerprint_mismatch')`, [randomUUID(),input.tenantId,input.sourceSystem,input.sourceAttemptId,prior.rows[0].source_fingerprint,fingerprint]);
        await client.query("COMMIT"); return { status:"conflict", admissionId:null };
      }
      const id = randomUUID();
      await client.query(`INSERT INTO ai_usage_attempt_admissions (id,tenant_id,source_system,source_attempt_id,source_fingerprint,subject_id,team_id,team_display_name,cost_center_code,workspace_id,agent_id,session_id,task_id,turn_id,task_binding_provenance,policy_version_id,policy_hash,requested_alias,requested_service_class,selected_service_class,route_mapping_version,attempt_kind,parent_attempt_id,resolved_provider,provider_account_id,resolved_model,resolved_deployment_id,region,provider_service_tier,admitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`, [id,input.tenantId,input.sourceSystem,input.sourceAttemptId,fingerprint,input.subjectId,input.team.id,input.team.displayName,input.team.costCenterCode,input.workspaceId??null,input.agentId??null,input.sessionId??null,input.taskId,input.turnId??null,input.taskBindingProvenance,input.policyVersionId??null,input.policyHash??null,input.requestedAlias,input.requestedServiceClass??null,input.selectedServiceClass??null,input.routeMappingVersion??null,input.attemptKind,input.parentAttemptId??null,input.resolvedProvider,input.providerAccountId,input.resolvedModel,input.resolvedDeploymentId,input.region??null,input.providerServiceTier??null,input.admittedAt]);
      await client.query("COMMIT"); return { status:"created", admissionId:id };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
