import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresUsageLedgerStore, priceUsage, usageFingerprint, type AttemptAdmissionInput, type AttemptBudgetBounds, type RateAmount, type UsageAmount, type UsageAttemptAdmissionHook } from "./usage-ledger.js";

export type BudgetPeriodType = "calendar_month" | "calendar_week";
export type BudgetMode = "soft" | "hard";
export type BudgetPeriod = { start: Date; end: Date };
export type BudgetVersion = {
  id: string; tenantId: string; teamId: string; limitAmount: string; currency: string;
  periodType: BudgetPeriodType; timezone: string; mode: BudgetMode; thresholds: string[];
  effectiveFrom: Date; effectiveTo: Date | null; createdBy: string; createdAt: Date;
};
export type BudgetStatus = {
  budget: BudgetVersion | null;
  period: BudgetPeriod | null;
  effectiveLimitAmount: string | null;
  settledProviderCost: string | null;
  outstandingReservations: string | null;
  remainingAmount: string | null;
  percentConsumed: string | null;
  priceStatus: "priced" | "unknown";
  enforcement: "none" | "soft" | "hard" | "override";
  alerts: Array<{ thresholdPercent: string; createdAt: Date }>;
  lastReconciliation: { status: string; checkedAt: Date; detail: string | null } | null;
};
export type BudgetQuote = {
  providerCost: string | null;
  priceStatus: "priced" | "unknown" | "incomplete";
  cacheAssumption: "known_hit" | "known_miss" | "unknown_assume_miss";
  maxAttempts: number;
  maxAgentSteps: number;
  usage: UsageAmount[];
};
export type ReservationResult = {
  decision: "allow" | "deny";
  code?: string;
  reservationId?: string;
  quotedAmount?: string;
  remainingAmount?: string;
  warning?: "unpriced" | "over_limit";
};

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const signedDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const moneyScale = 1_000_000_000_000n;
const asScaled = (value: string) => {
  if (!decimalPattern.test(value)) throw new Error(`Invalid non-negative decimal: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * moneyScale + BigInt((fraction + "0".repeat(12)).slice(0, 12));
};
const asSignedScaled=(value:string)=>{if(!signedDecimalPattern.test(value))throw new Error(`Invalid decimal: ${value}`);return value.startsWith("-")?-asScaled(value.slice(1)):asScaled(value);};
const asMoney = (value: bigint) => `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / moneyScale}.${String((value < 0n ? -value : value) % moneyScale).padStart(12, "0")}`;
const multiplyQuantity = (value: string, multiplier: number) => asMoney(asScaled(value) * BigInt(multiplier));

const localParts = (instant: Date, timezone: string) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
};

/** Convert a local civil time to its UTC instant without relying on the host TZ. */
const localToUtc = (parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number }, timezone: string) => {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = localParts(new Date(guess), timezone);
    const observedCivil = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const adjustment = target - observedCivil;
    guess += adjustment;
    if (!adjustment) break;
  }
  return new Date(guess);
};

export const budgetPeriodFor = (instant: Date, periodType: BudgetPeriodType, timezone: string): BudgetPeriod => {
  const current = localParts(instant, timezone);
  if (periodType === "calendar_month") {
    const start = localToUtc({ year: current.year, month: current.month, day: 1 }, timezone);
    const nextMonth = current.month === 12 ? { year: current.year + 1, month: 1 } : { year: current.year, month: current.month + 1 };
    return { start, end: localToUtc({ ...nextMonth, day: 1 }, timezone) };
  }
  const civil = new Date(Date.UTC(current.year, current.month - 1, current.day));
  const daysSinceMonday = (civil.getUTCDay() + 6) % 7;
  civil.setUTCDate(civil.getUTCDate() - daysSinceMonday);
  const startParts = { year: civil.getUTCFullYear(), month: civil.getUTCMonth() + 1, day: civil.getUTCDate() };
  civil.setUTCDate(civil.getUTCDate() + 7);
  return { start: localToUtc(startParts, timezone), end: localToUtc({ year: civil.getUTCFullYear(), month: civil.getUTCMonth() + 1, day: civil.getUTCDate() }, timezone) };
};

export const quoteBudgetAttempt = (bounds: AttemptBudgetBounds, rates: RateAmount[]): BudgetQuote => {
  if (!Number.isInteger(bounds.maxRetries) || bounds.maxRetries < 0 || !Number.isInteger(bounds.maxFallbacks) || bounds.maxFallbacks < 0) throw new Error("Retry and fallback bounds must be non-negative integers");
  if (!Number.isInteger(bounds.maxAgentSteps) || bounds.maxAgentSteps < 1) throw new Error("Agent steps must have a positive bound");
  const maxAttempts = 1 + bounds.maxRetries + bounds.maxFallbacks;
  const cacheAssumption = bounds.cacheStatus === "known_hit" ? "known_hit" : bounds.cacheStatus === "known_miss" ? "known_miss" : "unknown_assume_miss";
  const perAttempt: UsageAmount[] = [];
  if (bounds.cacheStatus === "known_hit") {
    if (!bounds.cacheReadTokens) throw new Error("A known cache hit requires a cache-read bound");
    perAttempt.push({ unit: "cache_read_token", quantity: bounds.cacheReadTokens });
  } else {
    perAttempt.push({ unit: "input_uncached_token", quantity: bounds.inputTokens });
  }
  if (bounds.cacheWriteTokens) perAttempt.push({ unit: "cache_write_token", quantity: bounds.cacheWriteTokens });
  perAttempt.push({ unit: "output_token", quantity: bounds.maximumOutputTokens });
  if (bounds.maximumReasoningTokens) perAttempt.push({ unit: "reasoning_token", quantity: bounds.maximumReasoningTokens });
  if (bounds.requestUnits) perAttempt.push({ unit: "request", quantity: bounds.requestUnits });
  const boundedCalls = maxAttempts * bounds.maxAgentSteps;
  const expanded = [
    ...perAttempt.map((item) => ({ ...item, quantity: multiplyQuantity(item.quantity, boundedCalls) })),
    ...(bounds.routingOverhead ?? []).map((item) => ({ ...item, quantity: multiplyQuantity(item.quantity, bounds.maxAgentSteps) })),
  ];
  const totals = new Map<string,bigint>();
  for (const item of expanded) totals.set(item.unit,(totals.get(item.unit)??0n)+asScaled(item.quantity));
  const usage = [...totals.entries()].map(([unit,quantity])=>({unit:unit as UsageAmount["unit"],quantity:asMoney(quantity)}));
  const priced = priceUsage(usage, rates);
  return { providerCost: priced.providerCost, priceStatus: priced.priceStatus, cacheAssumption, maxAttempts, maxAgentSteps: bounds.maxAgentSteps, usage };
};

export type CreateBudgetVersionInput = {
  tenantId: string; teamId: string; limitAmount: string; currency: string; periodType: BudgetPeriodType;
  timezone: string; mode: BudgetMode; thresholds: string[]; effectiveFrom: Date; effectiveTo?: Date; createdBy: string;
};
export type CreateBudgetOverrideInput = {
  tenantId: string; teamId: string; overrideType: "limit_increase" | "hard_limit_bypass";
  newLimitAmount?: string; actorUserId: string; reason: string; expiresAt: Date; now: Date;
};

export type RecordBudgetReconciliationInput={tenantId:string;teamId:string;budgetVersionId:string;projectionKey:string;limitAmount:string;mode:BudgetMode;expectedFingerprint:string;observedFingerprint:string|null;status:"matched"|"drifted"|"unavailable"|"repaired";detail:string|null;startedBy:string;checkedAt:Date};

export interface TeamBudgetStore {
  createBudgetVersion(input: CreateBudgetVersionInput): Promise<BudgetVersion>;
  getBudgetStatus(tenantId: string, teamId: string, now?: Date): Promise<BudgetStatus>;
  reserveAttempt(input: AttemptAdmissionInput, now?: Date): Promise<ReservationResult>;
  settleReservation(input: { tenantId: string; sourceSystem: string; sourceAttemptId: string; usageEventId: string; settledAt?: Date }): Promise<{ status: "settled" | "duplicate"; actualProviderCost: string }>;
  settleUsageEvent(input: { tenantId:string; usageEventId:string; settledAt?:Date }): Promise<{ status:"settled"|"duplicate"|"not_reserved"; actualProviderCost:string|null }>;
  reserveAttemptInTransaction(input:AttemptAdmissionInput,transaction:pg.PoolClient,now?:Date):Promise<ReservationResult>;
  releaseReservation(input: { tenantId:string; sourceSystem:string; sourceAttemptId:string; reason:"provider_not_dispatched"|"cancelled"|"failed_unbilled"|"reconciled_terminal"; evidence:string; releasedAt?:Date }): Promise<"released"|"duplicate">;
  createOverride(input: CreateBudgetOverrideInput): Promise<string>;
  recordGatewayReconciliation(input:RecordBudgetReconciliationInput):Promise<void>;
}

const versionFrom = (row: Record<string, unknown>, thresholds: string[]): BudgetVersion => ({
  id: String(row.id), tenantId: String(row.tenant_id), teamId: String(row.team_id), limitAmount: String(row.limit_amount), currency: String(row.currency),
  periodType: row.period_type as BudgetPeriodType, timezone: String(row.timezone), mode: row.mode as BudgetMode, thresholds,
  effectiveFrom: new Date(String(row.effective_from)), effectiveTo: row.effective_to ? new Date(String(row.effective_to)) : null,
  createdBy: String(row.created_by), createdAt: new Date(String(row.created_at)),
});

export class PostgresTeamBudgetStore implements TeamBudgetStore {
  private readonly rateCards: PostgresUsageLedgerStore;
  constructor(private readonly pool: pg.Pool) {
    this.rateCards = new PostgresUsageLedgerStore(pool);
  }
  static fromConnectionString(connectionString: string) { return new PostgresTeamBudgetStore(new pg.Pool({ connectionString, max: 8 })); }
  async close() { await this.pool.end(); }

  async createBudgetVersion(input: CreateBudgetVersionInput): Promise<BudgetVersion> {
    asScaled(input.limitAmount);
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("Budget currency must be an ISO 4217 code");
    localParts(input.effectiveFrom, input.timezone);
    const thresholds = [...new Set(input.thresholds.map((value) => asMoney(asScaled(value))))].sort((a,b) => Number(a) - Number(b));
    if (!thresholds.length || thresholds.some((value) => asScaled(value) <= 0n || asScaled(value) > 100n * moneyScale)) throw new Error("Warning thresholds must be within (0, 100]");
    if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) throw new Error("Budget effective end must follow its start");
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`team-budget-config:${input.tenantId}:${input.teamId}`]);
      const team = await client.query("SELECT 1 FROM allocation_units WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE", [input.tenantId,input.teamId]);
      if (!team.rowCount) throw new Error("Active Team not found");
      await client.query(`INSERT INTO team_budget_versions (id,tenant_id,team_id,limit_amount,currency,period_type,timezone,mode,effective_from,effective_to,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id,input.tenantId,input.teamId,input.limitAmount,input.currency,input.periodType,input.timezone,input.mode,input.effectiveFrom,input.effectiveTo??null,input.createdBy]);
      for (const threshold of thresholds) await client.query("INSERT INTO team_budget_warning_thresholds (tenant_id,budget_version_id,threshold_percent) VALUES ($1,$2,$3)", [input.tenantId,id,threshold]);
      await client.query("COMMIT");
      const row = { id, tenant_id:input.tenantId, team_id:input.teamId, limit_amount:input.limitAmount, currency:input.currency, period_type:input.periodType, timezone:input.timezone, mode:input.mode, effective_from:input.effectiveFrom, effective_to:input.effectiveTo??null, created_by:input.createdBy, created_at:new Date() };
      return versionFrom(row, thresholds);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  private async activeBudget(client: pg.PoolClient, tenantId: string, teamId: string, now: Date) {
    const result = await client.query(`SELECT b.*,COALESCE(array_agg(t.threshold_percent::text ORDER BY t.threshold_percent) FILTER (WHERE t.threshold_percent IS NOT NULL),'{}') thresholds FROM team_budget_versions b LEFT JOIN team_budget_warning_thresholds t ON t.tenant_id=b.tenant_id AND t.budget_version_id=b.id WHERE b.tenant_id=$1 AND b.team_id=$2 AND b.effective_from<=$3 AND (b.effective_to IS NULL OR b.effective_to>$3) GROUP BY b.id ORDER BY b.effective_from DESC,b.created_at DESC LIMIT 1`, [tenantId,teamId,now]);
    if (!result.rowCount) return null;
    return versionFrom(result.rows[0], result.rows[0].thresholds as string[]);
  }

  private async budgetById(client:pg.PoolClient,tenantId:string,budgetVersionId:string){
    const result=await client.query(`SELECT b.*,COALESCE(array_agg(t.threshold_percent::text ORDER BY t.threshold_percent) FILTER (WHERE t.threshold_percent IS NOT NULL),'{}') thresholds FROM team_budget_versions b LEFT JOIN team_budget_warning_thresholds t ON t.tenant_id=b.tenant_id AND t.budget_version_id=b.id WHERE b.tenant_id=$1 AND b.id=$2 GROUP BY b.id`,[tenantId,budgetVersionId]);
    return result.rowCount?versionFrom(result.rows[0],result.rows[0].thresholds as string[]):null;
  }

  private async calculateStatus(client: pg.PoolClient, budget: BudgetVersion, now: Date, snappedPeriod?:BudgetPeriod): Promise<BudgetStatus> {
    const period = snappedPeriod??budgetPeriodFor(now,budget.periodType,budget.timezone);
    const override = await client.query(`SELECT override_type,new_limit_amount FROM team_budget_overrides WHERE tenant_id=$1 AND budget_version_id=$2 AND effective_from<=$3 AND expires_at>$3 ORDER BY created_at DESC`, [budget.tenantId,budget.id,now]);
    const bypass = override.rows.some((row) => row.override_type === "hard_limit_bypass");
    const increases = override.rows.filter((row) => row.override_type === "limit_increase").map((row) => asScaled(String(row.new_limit_amount)));
    const effectiveLimit = increases.length ? increases.reduce((maximum,value) => value > maximum ? value : maximum,asScaled(budget.limitAmount)) : asScaled(budget.limitAmount);
    const costs = await client.query(`SELECT COALESCE(SUM(e.provider_cost) FILTER (WHERE e.price_status='priced' AND e.currency=$5),0)::text settled,
      COUNT(*) FILTER (WHERE (e.price_status<>'priced' OR e.currency IS DISTINCT FROM $5) AND EXISTS (SELECT 1 FROM ai_usage_event_units unit WHERE unit.tenant_id=e.tenant_id AND unit.event_id=e.id AND unit.is_provider_diagnostic=false))::int unknown
      FROM ai_usage_events e JOIN ai_usage_attempt_admissions a ON a.tenant_id=e.tenant_id AND a.id=e.admission_id
      WHERE e.tenant_id=$1 AND a.team_id=$2 AND e.occurred_at>=$3 AND e.occurred_at<$4`, [budget.tenantId,budget.teamId,period.start,period.end,budget.currency]);
    const reservations = await client.query(`SELECT COALESCE(SUM(r.quoted_amount) FILTER (WHERE r.currency=$5),0)::text outstanding,COUNT(*) FILTER (WHERE r.currency IS DISTINCT FROM $5)::int foreign_currency FROM team_budget_reservations r LEFT JOIN team_budget_reservation_settlements s ON s.tenant_id=r.tenant_id AND s.reservation_id=r.id LEFT JOIN team_budget_reservation_releases x ON x.tenant_id=r.tenant_id AND x.reservation_id=r.id WHERE r.tenant_id=$1 AND r.team_id=$2 AND r.period_start=$3 AND r.period_end=$4 AND s.id IS NULL AND x.id IS NULL`, [budget.tenantId,budget.teamId,period.start,period.end,budget.currency]);
    const settled = asSignedScaled(String(costs.rows[0].settled));
    const outstanding = asScaled(String(reservations.rows[0].outstanding));
    const remaining = effectiveLimit-settled-outstanding;
    const percent = effectiveLimit === 0n ? (settled > 0n ? 100n*moneyScale : 0n) : (settled*100n*moneyScale)/effectiveLimit;
    const alerts = await client.query(`SELECT threshold_percent::text,created_at FROM team_budget_alerts WHERE tenant_id=$1 AND budget_version_id=$2 AND period_start=$3 ORDER BY threshold_percent`, [budget.tenantId,budget.id,period.start]);
    const projection = await client.query(`SELECT status,checked_at,detail FROM team_budget_gateway_projections WHERE tenant_id=$1 AND budget_version_id=$2`, [budget.tenantId,budget.id]);
    const priceStatus = Number(costs.rows[0].unknown)+Number(reservations.rows[0].foreign_currency)>0?"unknown":"priced";
    return { budget,period,effectiveLimitAmount:asMoney(effectiveLimit),settledProviderCost:asMoney(settled),outstandingReservations:asMoney(outstanding),remainingAmount:asMoney(remaining),percentConsumed:asMoney(percent),priceStatus,enforcement:bypass?"override":budget.mode,alerts:alerts.rows.map((row)=>({thresholdPercent:String(row.threshold_percent),createdAt:new Date(row.created_at)})),lastReconciliation:projection.rowCount?{status:String(projection.rows[0].status),checkedAt:new Date(projection.rows[0].checked_at),detail:projection.rows[0].detail?String(projection.rows[0].detail):null}:null };
  }

  private async emitThresholdAlerts(client:pg.PoolClient,status:BudgetStatus){
    if(!status.budget||!status.period||status.percentConsumed===null||status.settledProviderCost===null||status.effectiveLimitAmount===null)return;
    for(const threshold of status.budget.thresholds)if(asSignedScaled(status.percentConsumed)>=asScaled(threshold))await client.query(`INSERT INTO team_budget_alerts (id,tenant_id,budget_version_id,team_id,period_start,period_end,threshold_percent,consumed_amount,limit_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[randomUUID(),status.budget.tenantId,status.budget.id,status.budget.teamId,status.period.start,status.period.end,threshold,status.settledProviderCost,status.effectiveLimitAmount]);
  }

  async getBudgetStatus(tenantId: string, teamId: string, now = new Date()): Promise<BudgetStatus> {
    const client = await this.pool.connect();
    try {
      const budget = await this.activeBudget(client,tenantId,teamId,now);
      if (!budget) return { budget:null,period:null,effectiveLimitAmount:null,settledProviderCost:null,outstandingReservations:null,remainingAmount:null,percentConsumed:null,priceStatus:"unknown",enforcement:"none",alerts:[],lastReconciliation:null };
      return await this.calculateStatus(client,budget,now);
    } finally { client.release(); }
  }

  async reserveAttempt(input:AttemptAdmissionInput,now=input.admittedAt):Promise<ReservationResult>{
    const client=await this.pool.connect();
    try{await client.query("BEGIN");const result=await this.reserveAttemptInTransaction(input,client,now);await client.query("COMMIT");return result;}
    catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }

  async reserveAttemptInTransaction(input:AttemptAdmissionInput,client:pg.PoolClient,now=input.admittedAt):Promise<ReservationResult>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`team-budget-capacity:${input.tenantId}:${input.team.id}`]);
    const budget=await this.activeBudget(client,input.tenantId,input.team.id,now);
    if(!budget)return{decision:"allow"};
    const prior=await client.query("SELECT id,source_fingerprint,quoted_amount::text FROM team_budget_reservations WHERE tenant_id=$1 AND source_system=$2 AND source_attempt_id=$3",[input.tenantId,input.sourceSystem,input.sourceAttemptId]);
    const fingerprint=usageFingerprint({...input,admittedAt:input.admittedAt.toISOString(),budgetBounds:input.budgetBounds?{...input.budgetBounds,providerDeadlineAt:input.budgetBounds.providerDeadlineAt?.toISOString()}:undefined,budgetVersionId:budget.id});
    if(prior.rowCount)return prior.rows[0].source_fingerprint===fingerprint?{decision:"allow",reservationId:String(prior.rows[0].id),quotedAmount:String(prior.rows[0].quoted_amount)}:{decision:"deny",code:"BUDGET_RESERVATION_CONFLICT"};
    if(!input.budgetBounds)return budget.mode==="hard"?{decision:"deny",code:"BUDGET_QUOTE_REQUIRED"}:{decision:"allow",warning:"unpriced"};
    const card=await this.rateCards.selectEffectiveRateCardInTransaction(client,{
      tenantId:input.tenantId,provider:input.resolvedProvider,providerAccountId:input.providerAccountId,baseModel:input.resolvedModel,
      deploymentId:input.resolvedDeploymentId,...(input.region?{region:input.region}:{}),...(input.providerServiceTier?{providerServiceTier:input.providerServiceTier}:{}),at:now,
    });
    if(!card||card.currency!==budget.currency)return budget.mode==="hard"?{decision:"deny",code:"BUDGET_PRICE_UNAVAILABLE"}:{decision:"allow",warning:"unpriced"};
    const quote=quoteBudgetAttempt(input.budgetBounds,card.rates);
    if(quote.priceStatus!=="priced"||quote.providerCost===null)return budget.mode==="hard"?{decision:"deny",code:"BUDGET_PRICE_INCOMPLETE"}:{decision:"allow",warning:"unpriced"};
    const status=await this.calculateStatus(client,budget,now);const bypass=status.enforcement==="override";
    if(budget.mode==="hard"&&status.priceStatus!=="priced")return{decision:"deny",code:"BUDGET_LEDGER_STALE"};
    const enough=asSignedScaled(status.remainingAmount!)>=asScaled(quote.providerCost);
    if(budget.mode==="hard"&&!bypass&&!enough)return{decision:"deny",code:"TEAM_BUDGET_EXHAUSTED",remainingAmount:status.remainingAmount!};
    const id=randomUUID();const ttl=Math.min(Math.max(input.budgetBounds.reservationTtlSeconds??900,30),3600);const expiry=new Date(Math.max(now.getTime()+ttl*1000,(input.budgetBounds.providerDeadlineAt?.getTime()??now.getTime())+300_000));
    await client.query(`INSERT INTO team_budget_reservations (id,tenant_id,budget_version_id,team_id,source_system,source_attempt_id,source_fingerprint,period_start,period_end,quoted_amount,currency,rate_card_id,rate_card_source_hash,cache_assumption,max_attempts,max_agent_steps,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[id,input.tenantId,budget.id,input.team.id,input.sourceSystem,input.sourceAttemptId,fingerprint,status.period!.start,status.period!.end,quote.providerCost,budget.currency,card.id,card.sourceHash,quote.cacheAssumption,quote.maxAttempts,quote.maxAgentSteps,expiry,now]);
    return{decision:"allow",reservationId:id,quotedAmount:quote.providerCost,remainingAmount:asMoney(asSignedScaled(status.remainingAmount!)-asScaled(quote.providerCost)),warning:enough?undefined:"over_limit"};
  }

  async settleReservation(input: { tenantId:string; sourceSystem:string; sourceAttemptId:string; usageEventId:string; settledAt?:Date }) {
    const result=await this.settleUsageEvent({tenantId:input.tenantId,usageEventId:input.usageEventId,...(input.settledAt?{settledAt:input.settledAt}:{})});
    if(result.status==="not_reserved"||result.actualProviderCost===null)throw new Error("Reservation or ledger event not found");
    return result as {status:"settled"|"duplicate";actualProviderCost:string};
  }

  async settleUsageEvent(input:{tenantId:string;usageEventId:string;settledAt?:Date}) {
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found=await client.query(`SELECT r.*,r.id reservation_id,e.provider_cost::text,e.price_status,e.event_type FROM ai_usage_events e JOIN ai_usage_attempt_admissions a ON a.tenant_id=e.tenant_id AND a.id=e.admission_id LEFT JOIN team_budget_reservations r ON r.tenant_id=a.tenant_id AND r.source_system=a.source_system AND r.source_attempt_id=a.source_attempt_id WHERE e.tenant_id=$1 AND e.id=$2`,[input.tenantId,input.usageEventId]);
      if(!found.rowCount) throw new Error("Ledger event not found");
      const row=found.rows[0];
      if(row.reservation_id===null){await client.query("COMMIT");return{status:"not_reserved" as const,actualProviderCost:row.provider_cost===null?null:String(row.provider_cost)};}
      if(row.event_type!=="usage"||row.price_status!=="priced"||row.provider_cost===null) throw new Error("Ledger event does not price the reserved original attempt");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`team-budget-capacity:${input.tenantId}:${row.team_id}`]);
      if(asSignedScaled(String(row.provider_cost))<0n)throw new Error("Reservation settlement cost cannot be negative");
      const released=await client.query(`SELECT 1 FROM team_budget_reservation_releases WHERE tenant_id=$1 AND reservation_id=$2`,[input.tenantId,row.reservation_id]);
      if(released.rowCount)throw new Error("Released reservation cannot be settled");
      const inserted=await client.query(`INSERT INTO team_budget_reservation_settlements (id,tenant_id,reservation_id,usage_event_id,actual_provider_cost,settled_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,reservation_id) DO NOTHING RETURNING id`,[randomUUID(),input.tenantId,row.reservation_id,input.usageEventId,row.provider_cost,input.settledAt??new Date()]);
      const budget=await this.budgetById(client,input.tenantId,String(row.budget_version_id));
      if(budget)await this.emitThresholdAlerts(client,await this.calculateStatus(client,budget,new Date(row.created_at),{start:new Date(row.period_start),end:new Date(row.period_end)}));
      await client.query("COMMIT");
      return {status:inserted.rowCount?"settled" as const:"duplicate" as const,actualProviderCost:String(row.provider_cost)};
    } catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }

  async releaseReservation(input:{tenantId:string;sourceSystem:string;sourceAttemptId:string;reason:"provider_not_dispatched"|"cancelled"|"failed_unbilled"|"reconciled_terminal";evidence:string;releasedAt?:Date}){
    const client=await this.pool.connect();
    try{await client.query("BEGIN");
      const reservation=await client.query(`SELECT id,team_id FROM team_budget_reservations WHERE tenant_id=$1 AND source_system=$2 AND source_attempt_id=$3`,[input.tenantId,input.sourceSystem,input.sourceAttemptId]);
      if(!reservation.rowCount){await client.query("COMMIT");return "duplicate" as const;}
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`team-budget-capacity:${input.tenantId}:${reservation.rows[0].team_id}`]);
      const result=await client.query(`INSERT INTO team_budget_reservation_releases (id,tenant_id,reservation_id,reason,evidence,released_at) SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS (SELECT 1 FROM team_budget_reservation_settlements WHERE tenant_id=$2 AND reservation_id=$3) ON CONFLICT (tenant_id,reservation_id) DO NOTHING RETURNING id`,[randomUUID(),input.tenantId,reservation.rows[0].id,input.reason,input.evidence,input.releasedAt??new Date()]);
      await client.query("COMMIT");return result.rowCount?"released" as const:"duplicate" as const;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }

  async createOverride(input:CreateBudgetOverrideInput){
    if(input.expiresAt<=input.now) throw new Error("Budget override must expire in the future");
    const client=await this.pool.connect();
    try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`team-budget-config:${input.tenantId}:${input.teamId}`]);const budget=await this.activeBudget(client,input.tenantId,input.teamId,input.now);if(!budget)throw new Error("Active Team budget not found");const prior=await this.calculateStatus(client,budget,input.now);const oldLimit=prior.effectiveLimitAmount!;if(input.overrideType==="limit_increase"&&(!input.newLimitAmount||asScaled(input.newLimitAmount)<=asScaled(oldLimit)))throw new Error("A limit increase must exceed the effective current limit");const id=randomUUID();await client.query(`INSERT INTO team_budget_overrides (id,tenant_id,budget_version_id,team_id,override_type,old_limit_amount,new_limit_amount,actor_user_id,reason,effective_from,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,input.tenantId,budget.id,input.teamId,input.overrideType,oldLimit,input.newLimitAmount??null,input.actorUserId,input.reason,input.now,input.expiresAt]);await client.query("COMMIT");return id;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async recordGatewayReconciliation(input:RecordBudgetReconciliationInput){
    const client=await this.pool.connect();
    try{await client.query("BEGIN");
      const projectionStatus=input.status==="matched"||input.status==="repaired"?"current":input.status;
      await client.query(`INSERT INTO team_budget_gateway_projections(tenant_id,budget_version_id,team_id,projection_key,projected_limit_amount,projected_mode,gateway_fingerprint,status,checked_at,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,budget_version_id) DO UPDATE SET projection_key=EXCLUDED.projection_key,projected_limit_amount=EXCLUDED.projected_limit_amount,projected_mode=EXCLUDED.projected_mode,gateway_fingerprint=EXCLUDED.gateway_fingerprint,status=EXCLUDED.status,checked_at=EXCLUDED.checked_at,detail=EXCLUDED.detail`,[input.tenantId,input.budgetVersionId,input.teamId,input.projectionKey,input.limitAmount,input.mode,input.expectedFingerprint,projectionStatus,input.checkedAt,input.detail]);
      await client.query(`INSERT INTO team_budget_reconciliation_runs(id,tenant_id,budget_version_id,expected_fingerprint,observed_fingerprint,status,started_by,detail,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),input.tenantId,input.budgetVersionId,input.expectedFingerprint,input.observedFingerprint,input.status,input.startedBy,input.detail,input.checkedAt]);
      const budget=await this.budgetById(client,input.tenantId,input.budgetVersionId);
      if(budget)await this.emitThresholdAlerts(client,await this.calculateStatus(client,budget,input.checkedAt));
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }

}

export class BudgetUsageAttemptAdmission implements UsageAttemptAdmissionHook {
  constructor(private readonly budgets:Pick<TeamBudgetStore,"reserveAttemptInTransaction">,private readonly next?:UsageAttemptAdmissionHook){}
  async admit(input:AttemptAdmissionInput,transaction:pg.PoolClient){
    const eligibility=await this.next?.admit(input,transaction);
    if(eligibility?.decision==="deny")return eligibility;
    const budget=await this.budgets.reserveAttemptInTransaction(input,transaction,input.admittedAt);
    if(budget.decision==="deny")return {decision:"deny" as const,code:budget.code??"TEAM_BUDGET_DENIED"};
    return {decision:"allow" as const};
  }
}
