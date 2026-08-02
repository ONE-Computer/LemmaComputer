import pg from "pg";

export const spendUsageUnits = [
  "input_uncached_token",
  "cache_read_token",
  "cache_write_token",
  "output_token",
  "reasoning_token",
  "image",
  "audio_second",
  "request",
  "character",
  "second",
] as const;

export type SpendRange = {
  from: Date;
  to: Date;
  teamId?: string;
  userId?: string;
  workspaceId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  taskId?: string;
  turnId?: string | null;
  receivedBefore?: Date;
};

export type SpendUnitRow = {
  unit: string;
  quantity: string;
  bucketCost: string | null;
  diagnostic: boolean;
};

export type SpendEventRow = {
  eventId: string;
  admissionId: string;
  eventType: "usage" | "correction";
  correctsEventId: string | null;
  occurredAt: string;
  receivedAt: string;
  outcome: "success" | "failure" | "cancelled" | "unknown";
  latencyMs: number | null;
  priceStatus: "priced" | "unknown" | "incomplete";
  costStatus: "estimated" | "provider_confirmed" | "unpriced";
  currency: string | null;
  providerCost: string | null;
  providerConfirmedCost: string | null;
  rateCardId: string | null;
  rateCardSource: string | null;
  rateCardSourceVersion: string | null;
  rateCardSourceHash: string | null;
  rateCardEffectiveFrom: string | null;
  subjectId: string;
  subjectDisplayName: string;
  teamId: string;
  teamDisplayName: string;
  costCenterCode: string | null;
  workspaceId: string | null;
  agentId: string | null;
  sessionId: string | null;
  taskId: string;
  turnId: string | null;
  taskBindingProvenance: "explicit_signed" | "unbound_generated";
  requestedAlias: string;
  requestedServiceClass: string | null;
  selectedServiceClass: string | null;
  attemptKind: "inference" | "router" | "classifier" | "embedding" | "retry" | "fallback";
  parentAttemptId: string | null;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedDeploymentId: string;
  admittedAt: string;
  conversationHistoryCount: number;
  attachmentCount: number;
  retrievalCount: number;
  systemPolicyContextCount: number;
  toolResultContextCount: number;
  routingOverheadCount: number;
  units: SpendUnitRow[];
};

export type CurrencyTotal = { currency: string; amount: string };
export type UsageTotals = Record<string, string>;
export type CostCoverageAcknowledgement = {
  receivedBefore: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
  reason: "historical_usage_before_pricing";
};
export type CostCoverageSummary = {
  status: "complete" | "unpriced_usage" | "delayed_reporting" | "multiple_gaps" | "acknowledged_history";
  unpricedUsage: {
    activeEventCount: number;
    missingPriceEventCount: number;
    partialPriceEventCount: number;
    acknowledgedEventCount: number;
  };
  delayedReporting: { attemptCount: number };
  failedWithoutUsage: { attemptCount: number };
  latestAcknowledgement: CostCoverageAcknowledgement | null;
};
export type SafeCostDriver = {
  code:
    | "conversation_history"
    | "attachments"
    | "retrieved_context"
    | "system_policy_context"
    | "tool_result_context"
    | "output_reasoning"
    | "retries_fallbacks"
    | "routing_overhead"
    | "cache_behavior";
  label: string;
  score: string;
  evidenceCount: string;
};

type GroupTotals = {
  costs: CurrencyTotal[];
  providerConfirmedCosts: CurrencyTotal[];
  usage: UsageTotals;
  latency: {
    sampleCount: number;
    averageMs: number | null;
    p95Ms: number | null;
  };
  attemptCount: number;
  eventCount: number;
  retryCount: number;
  fallbackCount: number;
  failedAttemptCount: number;
  unknownCostEventCount: number;
  incompleteCostEventCount: number;
  correctedEventCount: number;
};

export type SpendReport = {
  contractVersion: 1;
  range: { from: string; to: string };
  asOf: string;
  filters: {
    teamId: string | null;
    userId: string | null;
    workspaceId: string | null;
    agentId: string | null;
    taskId: string | null;
    turnId: string | null;
  };
  state: "empty" | "complete" | "partial";
  costCoverage: CostCoverageSummary;
  totals: GroupTotals & {
    delayedAttemptCount: number;
    allocatedAttemptCount: number;
    unallocatedAttemptCount: number;
  };
  teams: Array<GroupTotals & {
    teamId: string;
    teamDisplayName: string;
    costCenterCode: string | null;
    allocation: "allocated" | "unallocated";
  }>;
  users: Array<GroupTotals & {
    teamId: string;
    userId: string;
    userDisplayName: string;
  }>;
  breakdowns: {
    requestedRoutes: Array<GroupTotals & { requestedRoute: string }>;
    resolvedModels: Array<GroupTotals & {
      provider: string;
      model: string;
      deploymentId: string;
    }>;
    workspaces: Array<GroupTotals & { workspaceId: string | null }>;
    agents: Array<GroupTotals & { agentId: string | null }>;
  };
  trend: null | {
    previousRange: { from: string; to: string };
    costs: CurrencyTotal[];
    providerConfirmedCosts: CurrencyTotal[];
    attemptCount: number;
    attemptCountDelta: number;
    costDeltas: CurrencyTotal[];
  };
  tasks: Array<GroupTotals & {
    taskKey: string;
    taskId: string;
    turnId: string | null;
    teamId: string;
    teamDisplayName: string;
    userId: string;
    userDisplayName: string;
    workspaceId: string | null;
    agentId: string | null;
    requestedRoute: string;
    resolvedRoutes: string[];
    dominantDriver: SafeCostDriver | null;
    priceState: "priced" | "missing" | "partial";
    corrected: boolean;
  }>;
};

export type SpendTaskDetail = {
  task: SpendReport["tasks"][number];
  drivers: SafeCostDriver[];
  attempts: Array<{
    admissionId: string;
    attemptKind: SpendEventRow["attemptKind"];
    parentAttemptId: string | null;
    requestedRoute: string;
    selectedServiceClass: string | null;
    provider: string;
    model: string;
    deploymentId: string;
    outcome: SpendEventRow["outcome"];
    latencyMs: number | null;
    occurredAt: string;
    costs: CurrencyTotal[];
    providerConfirmedCosts: CurrencyTotal[];
    usage: UsageTotals;
    priceStatus: SpendEventRow["priceStatus"];
    costStatus: SpendEventRow["costStatus"];
    correction: boolean;
    priceBasis: null | {
      rateCardId: string;
      source: string;
      version: string;
      sourceHash: string;
      effectiveFrom: string;
    };
  }>;
};

export interface SpendObservabilityStore {
  report(tenantId: string, range: SpendRange): Promise<SpendReport>;
  task(tenantId: string, taskKey: string, range: Omit<SpendRange, "teamId" | "taskId" | "userId" | "workspaceId" | "agentId" | "sessionId" | "turnId">): Promise<SpendTaskDetail | null>;
  acknowledgeUnpricedUsage(input: {
    tenantId: string;
    receivedBefore: Date;
    acknowledgedBy: string;
  }): Promise<CostCoverageAcknowledgement>;
}

export class SpendReadLimitError extends Error {
  constructor() {
    super("The selected range contains too many usage facts; choose a shorter date range");
    this.name = "SpendReadLimitError";
  }
}

const scale = 1_000_000_000_000n;
const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const decimal = (value: string) => {
  if (!decimalPattern.test(value)) throw new Error("Invalid ledger decimal");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole!) * scale + BigInt((fraction + "0".repeat(12)).slice(0, 12));
  return negative ? -result : result;
};
const formatDecimal = (value: bigint) => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = String(absolute % scale).padStart(12, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${absolute / scale}${fraction ? `.${fraction}` : ""}`;
};
const add = (map: Map<string, bigint>, key: string, value: string) => {
  map.set(key, (map.get(key) ?? 0n) + decimal(value));
};
const sortedTotals = (map: Map<string, bigint>): CurrencyTotal[] => (
  [...map].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: formatDecimal(amount) }))
);
const usageTotals = (map: Map<string, bigint>): UsageTotals => Object.fromEntries(
  [...map].sort(([a], [b]) => a.localeCompare(b)).map(([unit, quantity]) => [unit, formatDecimal(quantity)]),
);
const isUnallocated = (row: SpendEventRow) => row.teamDisplayName === "Unallocated";
const routeFor = (row: SpendEventRow) => `${row.resolvedProvider}/${row.resolvedModel}`;

export type SpendTaskIdentity = {
  teamId: string;
  userId: string;
  workspaceId: string | null;
  agentId: string | null;
  sessionId: string | null;
  taskId: string;
  turnId: string | null;
};
const taskIdentity = (row: SpendEventRow): SpendTaskIdentity => ({
  teamId: row.teamId,
  userId: row.subjectId,
  workspaceId: row.workspaceId,
  agentId: row.agentId,
  sessionId: row.sessionId,
  taskId: row.taskId,
  turnId: row.turnId,
});
export const encodeSpendTaskKey = (identity: SpendTaskIdentity) => Buffer.from(JSON.stringify([
  identity.teamId, identity.userId, identity.workspaceId, identity.agentId, identity.sessionId, identity.taskId, identity.turnId,
])).toString("base64url");
export const decodeSpendTaskKey = (value: string): SpendTaskIdentity | null => {
  if (!/^[A-Za-z0-9_-]{8,2048}$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 7 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || typeof parsed[5] !== "string") return null;
    if (parsed.some((item) => item !== null && (typeof item !== "string" || item.length > 512))) return null;
    return { teamId: parsed[0], userId: parsed[1], workspaceId: parsed[2], agentId: parsed[3], sessionId: parsed[4], taskId: parsed[5], turnId: parsed[6] };
  } catch { return null; }
};

type MutableGroup = {
  rows: SpendEventRow[];
  admissions: Set<string>;
  costs: Map<string, bigint>;
  providerConfirmedCosts: Map<string, bigint>;
  usage: Map<string, bigint>;
  retries: Set<string>;
  fallbacks: Set<string>;
  failed: Set<string>;
  unknown: number;
  incomplete: number;
  corrected: number;
};
const mutableGroup = (): MutableGroup => ({
  rows: [],
  admissions: new Set(),
  costs: new Map(),
  providerConfirmedCosts: new Map(),
  usage: new Map(),
  retries: new Set(),
  fallbacks: new Set(),
  failed: new Set(),
  unknown: 0,
  incomplete: 0,
  corrected: 0,
});
const include = (group: MutableGroup, row: SpendEventRow) => {
  group.rows.push(row);
  group.admissions.add(row.admissionId);
  if (row.currency && row.providerCost !== null) add(group.costs, row.currency, row.providerCost);
  if (row.currency && row.providerConfirmedCost !== null) add(group.providerConfirmedCosts, row.currency, row.providerConfirmedCost);
  for (const unit of row.units) {
    if (!unit.diagnostic) add(group.usage, unit.unit, unit.quantity);
  }
  if (row.attemptKind === "retry") group.retries.add(row.admissionId);
  if (row.attemptKind === "fallback") group.fallbacks.add(row.admissionId);
  if (row.outcome === "failure") group.failed.add(row.admissionId);
  if (row.priceStatus === "unknown") group.unknown += 1;
  if (row.priceStatus === "incomplete") group.incomplete += 1;
  if (row.eventType === "correction") group.corrected += 1;
};
// A failed provider call with no billable units is still retained in the
// append-only ledger for investigation, but it is not financial usage. This
// distinguishes an immediate provider rejection from a genuine pricing gap.
export const failedWithoutBillableUsage = (row: SpendEventRow) => (
  row.eventType === "usage"
  && row.outcome === "failure"
  && row.providerCost === null
  && row.providerConfirmedCost === null
  && row.units.length > 0
  && row.units.every((unit) => unit.diagnostic)
);
const finalized = (group: MutableGroup): GroupTotals => ({
  costs: sortedTotals(group.costs),
  providerConfirmedCosts: sortedTotals(group.providerConfirmedCosts),
  usage: usageTotals(group.usage),
  latency: (() => {
    const byAdmission = new Map<string, number>();
    for (const row of group.rows) {
      if (row.latencyMs !== null) byAdmission.set(row.admissionId, row.latencyMs);
    }
    const values = [...byAdmission.values()].sort((a, b) => a - b);
    return {
      sampleCount: values.length,
      averageMs: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
      p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1]! : null,
    };
  })(),
  attemptCount: group.admissions.size,
  eventCount: group.rows.length,
  retryCount: group.retries.size,
  fallbackCount: group.fallbacks.size,
  failedAttemptCount: group.failed.size,
  unknownCostEventCount: group.unknown,
  incompleteCostEventCount: group.incomplete,
  correctedEventCount: group.corrected,
});

const driverLabels: Record<SafeCostDriver["code"], string> = {
  conversation_history: "Conversation history",
  attachments: "Attachments",
  retrieved_context: "Retrieved context",
  system_policy_context: "System and policy context",
  tool_result_context: "Tool-result context",
  output_reasoning: "Output and reasoning",
  retries_fallbacks: "Retries and fallbacks",
  routing_overhead: "Routing overhead",
  cache_behavior: "Cache behavior",
};
const driverOrder = Object.keys(driverLabels) as SafeCostDriver["code"][];
export const explainSafeCostDrivers = (rows: SpendEventRow[]): SafeCostDriver[] => {
  const scores = new Map<SafeCostDriver["code"], bigint>(driverOrder.map((code) => [code, 0n]));
  const evidence = new Map<SafeCostDriver["code"], bigint>(driverOrder.map((code) => [code, 0n]));
  const bump = (code: SafeCostDriver["code"], value: bigint) => {
    if (value <= 0n) return;
    scores.set(code, (scores.get(code) ?? 0n) + value);
    evidence.set(code, (evidence.get(code) ?? 0n) + value);
  };
  for (const row of rows) {
    bump("conversation_history", BigInt(row.conversationHistoryCount));
    bump("attachments", BigInt(row.attachmentCount));
    bump("retrieved_context", BigInt(row.retrievalCount));
    bump("system_policy_context", BigInt(row.systemPolicyContextCount));
    bump("tool_result_context", BigInt(row.toolResultContextCount));
    bump("routing_overhead", BigInt(row.routingOverheadCount));
    if (row.attemptKind === "router" || row.attemptKind === "classifier") bump("routing_overhead", 1n);
    if (row.attemptKind === "retry" || row.attemptKind === "fallback") bump("retries_fallbacks", 1n);
    for (const unit of row.units) {
      const quantity = decimal(unit.quantity);
      const magnitude = quantity < 0n ? -quantity : quantity;
      if (unit.unit === "output_token" || unit.unit === "reasoning_token") bump("output_reasoning", magnitude / scale);
      if (unit.unit === "cache_read_token" || unit.unit === "cache_write_token") bump("cache_behavior", magnitude / scale);
    }
  }
  return driverOrder
    .map((code) => ({ code, label: driverLabels[code], raw: scores.get(code) ?? 0n, evidence: evidence.get(code) ?? 0n }))
    .filter((item) => item.raw > 0n)
    .sort((a, b) => a.raw === b.raw ? driverOrder.indexOf(a.code) - driverOrder.indexOf(b.code) : a.raw > b.raw ? -1 : 1)
    .map(({ code, label, raw, evidence: count }) => ({
      code,
      label,
      score: raw.toString(),
      evidenceCount: count.toString(),
    }));
};

export const buildSpendReport = (
  rows: SpendEventRow[],
  range: SpendRange,
  delayedAttemptCount = 0,
  previousRows?: SpendEventRow[],
  latestAcknowledgement: CostCoverageAcknowledgement | null = null,
): SpendReport => {
  const financialRows = rows.filter((row) => !failedWithoutBillableUsage(row));
  const financialPreviousRows = previousRows?.filter((row) => !failedWithoutBillableUsage(row));
  const failedWithoutUsageAttemptCount = new Set(
    rows.filter(failedWithoutBillableUsage).map((row) => row.admissionId),
  ).size;
  const all = mutableGroup();
  const teamGroups = new Map<string, MutableGroup>();
  const userGroups = new Map<string, MutableGroup>();
  const taskGroups = new Map<string, MutableGroup>();
  const requestedRouteGroups = new Map<string, MutableGroup>();
  const resolvedModelGroups = new Map<string, MutableGroup>();
  const workspaceGroups = new Map<string, MutableGroup>();
  const agentGroups = new Map<string, MutableGroup>();
  for (const row of financialRows) {
    include(all, row);
    const team = teamGroups.get(row.teamId) ?? mutableGroup();
    include(team, row);
    teamGroups.set(row.teamId, team);
    const userKey = `${row.teamId}\u0000${row.subjectId}`;
    const user = userGroups.get(userKey) ?? mutableGroup();
    include(user, row);
    userGroups.set(userKey, user);
    const taskKey = encodeSpendTaskKey(taskIdentity(row));
    const task = taskGroups.get(taskKey) ?? mutableGroup();
    include(task, row);
    taskGroups.set(taskKey, task);
    const requestedRoute = row.requestedServiceClass ?? row.requestedAlias;
    const requestedRouteGroup = requestedRouteGroups.get(requestedRoute) ?? mutableGroup();
    include(requestedRouteGroup, row);
    requestedRouteGroups.set(requestedRoute, requestedRouteGroup);
    const resolvedModelKey = JSON.stringify([row.resolvedProvider, row.resolvedModel, row.resolvedDeploymentId]);
    const resolvedModelGroup = resolvedModelGroups.get(resolvedModelKey) ?? mutableGroup();
    include(resolvedModelGroup, row);
    resolvedModelGroups.set(resolvedModelKey, resolvedModelGroup);
    const workspaceKey = JSON.stringify(row.workspaceId);
    const workspaceGroup = workspaceGroups.get(workspaceKey) ?? mutableGroup();
    include(workspaceGroup, row);
    workspaceGroups.set(workspaceKey, workspaceGroup);
    const agentKey = JSON.stringify(row.agentId);
    const agentGroup = agentGroups.get(agentKey) ?? mutableGroup();
    include(agentGroup, row);
    agentGroups.set(agentKey, agentGroup);
  }
  const uniqueAdmissions = new Map<string, SpendEventRow>();
  financialRows.forEach((row) => uniqueAdmissions.set(row.admissionId, row));
  const allocatedAttemptCount = [...uniqueAdmissions.values()].filter((row) => !isUnallocated(row)).length;
  const unallocatedAttemptCount = uniqueAdmissions.size - allocatedAttemptCount;
  const groupSort = (a: GroupTotals, b: GroupTotals) => {
    const aCost = a.costs.reduce((sum, item) => sum + decimal(item.amount), 0n);
    const bCost = b.costs.reduce((sum, item) => sum + decimal(item.amount), 0n);
    return aCost === bCost ? b.attemptCount - a.attemptCount : aCost > bCost ? -1 : 1;
  };
  const teams = [...teamGroups].map(([teamId, group]) => {
    const first = group.rows[0]!;
    return {
      ...finalized(group),
      teamId,
      teamDisplayName: first.teamDisplayName,
      costCenterCode: first.costCenterCode,
      allocation: isUnallocated(first) ? "unallocated" as const : "allocated" as const,
    };
  }).sort(groupSort);
  const users = [...userGroups].map(([, group]) => {
    const first = group.rows[0]!;
    return {
      ...finalized(group),
      teamId: first.teamId,
      userId: first.subjectId,
      userDisplayName: first.subjectDisplayName,
    };
  }).sort(groupSort);
  const tasks = [...taskGroups].map(([taskKey, group]) => {
    const first = group.rows[0]!;
    const drivers = explainSafeCostDrivers(group.rows);
    const priceStates = new Set(group.rows.map((row) => row.priceStatus));
    const hasCorrection = group.rows.some((row) => row.eventType === "correction");
    return {
      ...finalized(group),
      taskKey,
      taskId: first.taskId,
      turnId: first.turnId,
      teamId: first.teamId,
      teamDisplayName: first.teamDisplayName,
      userId: first.subjectId,
      userDisplayName: first.subjectDisplayName,
      workspaceId: first.workspaceId,
      agentId: first.agentId,
      requestedRoute: first.requestedServiceClass ?? first.requestedAlias,
      resolvedRoutes: [...new Set(group.rows.map(routeFor))].sort(),
      dominantDriver: drivers[0] ?? null,
      priceState: priceStates.has("unknown")
          ? "missing" as const
          : priceStates.has("incomplete")
            ? "partial" as const
            : "priced" as const,
      corrected: hasCorrection,
    };
  }).sort((a, b) => groupSort(a, b) || a.taskKey.localeCompare(b.taskKey));
  const totals = finalized(all);
  const acknowledgementCutoff = latestAcknowledgement
    ? new Date(latestAcknowledgement.receivedBefore).getTime()
    : null;
  const unpricedRows = financialRows.filter((row) => row.priceStatus !== "priced");
  const acknowledgedUnpricedRows = acknowledgementCutoff === null
    ? []
    : unpricedRows.filter((row) => new Date(row.receivedAt).getTime() <= acknowledgementCutoff);
  const activeUnpricedRows = acknowledgementCutoff === null
    ? unpricedRows
    : unpricedRows.filter((row) => new Date(row.receivedAt).getTime() > acknowledgementCutoff);
  const missingPriceEventCount = activeUnpricedRows.filter((row) => row.priceStatus === "unknown").length;
  const partialPriceEventCount = activeUnpricedRows.filter((row) => row.priceStatus === "incomplete").length;
  const activeUnpricedEventCount = missingPriceEventCount + partialPriceEventCount;
  const costCoverage: CostCoverageSummary = {
    status: activeUnpricedEventCount > 0 && delayedAttemptCount > 0
      ? "multiple_gaps"
      : activeUnpricedEventCount > 0
        ? "unpriced_usage"
        : delayedAttemptCount > 0
          ? "delayed_reporting"
          : acknowledgedUnpricedRows.length > 0
            ? "acknowledged_history"
            : "complete",
    unpricedUsage: {
      activeEventCount: activeUnpricedEventCount,
      missingPriceEventCount,
      partialPriceEventCount,
      acknowledgedEventCount: acknowledgedUnpricedRows.length,
    },
    delayedReporting: { attemptCount: delayedAttemptCount },
    failedWithoutUsage: { attemptCount: failedWithoutUsageAttemptCount },
    latestAcknowledgement,
  };
  const breakdowns = {
    requestedRoutes: [...requestedRouteGroups].map(([requestedRoute, group]) => ({
      ...finalized(group),
      requestedRoute,
    })).sort(groupSort),
    resolvedModels: [...resolvedModelGroups].map(([, group]) => {
      const first = group.rows[0]!;
      return {
        ...finalized(group),
        provider: first.resolvedProvider,
        model: first.resolvedModel,
        deploymentId: first.resolvedDeploymentId,
      };
    }).sort(groupSort),
    workspaces: [...workspaceGroups].map(([, group]) => ({
      ...finalized(group),
      workspaceId: group.rows[0]!.workspaceId,
    })).sort(groupSort),
    agents: [...agentGroups].map(([, group]) => ({
      ...finalized(group),
      agentId: group.rows[0]!.agentId,
    })).sort(groupSort),
  };
  const trend = financialPreviousRows === undefined ? null : (() => {
    const previous = mutableGroup();
    financialPreviousRows.forEach((row) => include(previous, row));
    const previousTotals = finalized(previous);
    const currentByCurrency = new Map(totals.costs.map((item) => [item.currency, decimal(item.amount)]));
    const previousByCurrency = new Map(previousTotals.costs.map((item) => [item.currency, decimal(item.amount)]));
    const currencies = [...new Set([...currentByCurrency.keys(), ...previousByCurrency.keys()])].sort();
    const duration = range.to.getTime() - range.from.getTime();
    return {
      previousRange: {
        from: new Date(range.from.getTime() - duration).toISOString(),
        to: range.from.toISOString(),
      },
      costs: previousTotals.costs,
      providerConfirmedCosts: previousTotals.providerConfirmedCosts,
      attemptCount: previousTotals.attemptCount,
      attemptCountDelta: totals.attemptCount - previousTotals.attemptCount,
      costDeltas: currencies.map((currency) => ({
        currency,
        amount: formatDecimal((currentByCurrency.get(currency) ?? 0n) - (previousByCurrency.get(currency) ?? 0n)),
      })),
    };
  })();
  return {
    contractVersion: 1,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    asOf: (range.receivedBefore ?? range.to).toISOString(),
    filters: {
      teamId: range.teamId ?? null,
      userId: range.userId ?? null,
      workspaceId: range.workspaceId ?? null,
      agentId: range.agentId ?? null,
      taskId: range.taskId ?? null,
      turnId: range.turnId ?? null,
    },
    state: financialRows.length === 0 && delayedAttemptCount === 0
      ? "empty"
      : totals.unknownCostEventCount > 0 || totals.incompleteCostEventCount > 0 || delayedAttemptCount > 0
        ? "partial"
        : "complete",
    costCoverage,
    totals: { ...totals, delayedAttemptCount, allocatedAttemptCount, unallocatedAttemptCount },
    teams,
    users,
    breakdowns,
    trend,
    tasks,
  };
};

const attemptDetail = (rows: SpendEventRow[]) => {
  const groups = new Map<string, SpendEventRow[]>();
  for (const row of rows) groups.set(row.admissionId, [...(groups.get(row.admissionId) ?? []), row]);
  return [...groups].map(([admissionId, events]) => {
    const first = events[0]!;
    const costs = new Map<string, bigint>();
    const confirmed = new Map<string, bigint>();
    const units = new Map<string, bigint>();
    for (const event of events) {
      if (event.currency && event.providerCost !== null) add(costs, event.currency, event.providerCost);
      if (event.currency && event.providerConfirmedCost !== null) add(confirmed, event.currency, event.providerConfirmedCost);
      event.units.filter((unit) => !unit.diagnostic).forEach((unit) => add(units, unit.unit, unit.quantity));
    }
    return {
      admissionId,
      attemptKind: first.attemptKind,
      parentAttemptId: first.parentAttemptId,
      requestedRoute: first.requestedServiceClass ?? first.requestedAlias,
      selectedServiceClass: first.selectedServiceClass,
      provider: first.resolvedProvider,
      model: first.resolvedModel,
      deploymentId: first.resolvedDeploymentId,
      outcome: events.at(-1)!.outcome,
      latencyMs: events.at(-1)!.latencyMs,
      occurredAt: first.occurredAt,
      costs: sortedTotals(costs),
      providerConfirmedCosts: sortedTotals(confirmed),
      usage: usageTotals(units),
      priceStatus: events.some((event) => event.priceStatus === "unknown") ? "unknown" as const : events.some((event) => event.priceStatus === "incomplete") ? "incomplete" as const : "priced" as const,
      costStatus: events.some((event) => event.costStatus === "provider_confirmed") ? "provider_confirmed" as const : events.every((event) => event.costStatus === "unpriced") ? "unpriced" as const : "estimated" as const,
      correction: events.some((event) => event.eventType === "correction"),
      priceBasis: first.rateCardId && first.rateCardSource && first.rateCardSourceVersion && first.rateCardSourceHash && first.rateCardEffectiveFrom
        ? {
          rateCardId: first.rateCardId,
          source: first.rateCardSource,
          version: first.rateCardSourceVersion,
          sourceHash: first.rateCardSourceHash,
          effectiveFrom: first.rateCardEffectiveFrom,
        }
        : null,
    };
  }).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.admissionId.localeCompare(b.admissionId));
};

export const buildSpendTaskDetail = (rows: SpendEventRow[], range: SpendRange): SpendTaskDetail | null => {
  if (!rows.length) return null;
  const report = buildSpendReport(rows, range);
  return { task: report.tasks[0]!, drivers: explainSafeCostDrivers(rows), attempts: attemptDetail(rows) };
};

const eventLimit = 50_000;
const rowFromDatabase = (row: Record<string, unknown>): SpendEventRow => ({
  eventId: String(row.event_id),
  admissionId: String(row.admission_id),
  eventType: row.event_type as SpendEventRow["eventType"],
  correctsEventId: row.corrects_event_id ? String(row.corrects_event_id) : null,
  occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
  receivedAt: new Date(row.received_at as string | Date).toISOString(),
  outcome: row.outcome as SpendEventRow["outcome"],
  latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
  priceStatus: row.price_status as SpendEventRow["priceStatus"],
  costStatus: row.cost_status as SpendEventRow["costStatus"],
  currency: row.currency ? String(row.currency) : null,
  providerCost: row.provider_cost === null ? null : String(row.provider_cost),
  providerConfirmedCost: row.provider_confirmed_cost === null ? null : String(row.provider_confirmed_cost),
  rateCardId: row.rate_card_id ? String(row.rate_card_id) : null,
  rateCardSource: row.rate_card_source ? String(row.rate_card_source) : null,
  rateCardSourceVersion: row.rate_card_source_version ? String(row.rate_card_source_version) : null,
  rateCardSourceHash: row.rate_card_source_hash ? String(row.rate_card_source_hash) : null,
  rateCardEffectiveFrom: row.rate_card_effective_from ? new Date(row.rate_card_effective_from as string | Date).toISOString() : null,
  subjectId: String(row.subject_id),
  subjectDisplayName: String(row.subject_display_name),
  teamId: String(row.team_id),
  teamDisplayName: String(row.team_display_name),
  costCenterCode: row.cost_center_code ? String(row.cost_center_code) : null,
  workspaceId: row.workspace_id ? String(row.workspace_id) : null,
  agentId: row.agent_id ? String(row.agent_id) : null,
  sessionId: row.session_id ? String(row.session_id) : null,
  taskId: String(row.task_id),
  turnId: row.turn_id ? String(row.turn_id) : null,
  taskBindingProvenance: row.task_binding_provenance as SpendEventRow["taskBindingProvenance"],
  requestedAlias: String(row.requested_alias),
  requestedServiceClass: row.requested_service_class ? String(row.requested_service_class) : null,
  selectedServiceClass: row.selected_service_class ? String(row.selected_service_class) : null,
  attemptKind: row.attempt_kind as SpendEventRow["attemptKind"],
  parentAttemptId: row.parent_attempt_id ? String(row.parent_attempt_id) : null,
  resolvedProvider: String(row.resolved_provider),
  resolvedModel: String(row.resolved_model),
  resolvedDeploymentId: String(row.resolved_deployment_id),
  admittedAt: new Date(row.admitted_at as string | Date).toISOString(),
  conversationHistoryCount: Number(row.conversation_history_count),
  attachmentCount: Number(row.attachment_count),
  retrievalCount: Number(row.retrieval_count),
  systemPolicyContextCount: Number(row.system_policy_context_count),
  toolResultContextCount: Number(row.tool_result_context_count),
  routingOverheadCount: Number(row.routing_overhead_count),
  units: Array.isArray(row.units) ? (row.units as Array<Record<string, unknown>>).map((unit) => ({
    unit: String(unit.unit),
    quantity: String(unit.quantity),
    bucketCost: unit.bucketCost === null || unit.bucketCost === undefined ? null : String(unit.bucketCost),
    diagnostic: Boolean(unit.diagnostic),
  })) : [],
});

export class PostgresSpendObservabilityStore implements SpendObservabilityStore {
  constructor(private readonly pool: pg.Pool) {}
  static fromConnectionString(connectionString: string) {
    return new PostgresSpendObservabilityStore(new pg.Pool({ connectionString, max: 5 }));
  }
  async close() { await this.pool.end(); }
  private async latestCostCoverageAcknowledgement(tenantId: string, asOf: Date): Promise<CostCoverageAcknowledgement | null> {
    const result = await this.pool.query(`
      SELECT unpriced_events_received_before,acknowledged_at,acknowledged_by
      FROM ai_cost_coverage_acknowledgements
      WHERE tenant_id=$1 AND acknowledged_at <= $2
      ORDER BY unpriced_events_received_before DESC,acknowledged_at DESC
      LIMIT 1
    `, [tenantId, asOf]);
    const row = result.rows[0];
    return row ? {
      receivedBefore: new Date(row.unpriced_events_received_before).toISOString(),
      acknowledgedAt: new Date(row.acknowledged_at).toISOString(),
      acknowledgedBy: String(row.acknowledged_by),
      reason: "historical_usage_before_pricing",
    } : null;
  }

  async acknowledgeUnpricedUsage(input: {
    tenantId: string;
    receivedBefore: Date;
    acknowledgedBy: string;
  }): Promise<CostCoverageAcknowledgement> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cost-coverage:${input.tenantId}`]);
      const existing = await client.query(`
        SELECT unpriced_events_received_before,acknowledged_at,acknowledged_by
        FROM ai_cost_coverage_acknowledgements
        WHERE tenant_id=$1
        ORDER BY unpriced_events_received_before DESC,acknowledged_at DESC
        LIMIT 1
      `, [input.tenantId]);
      const current = existing.rows[0];
      if (current && new Date(current.unpriced_events_received_before).getTime() >= input.receivedBefore.getTime()) {
        await client.query("COMMIT");
        return {
          receivedBefore: new Date(current.unpriced_events_received_before).toISOString(),
          acknowledgedAt: new Date(current.acknowledged_at).toISOString(),
          acknowledgedBy: String(current.acknowledged_by),
          reason: "historical_usage_before_pricing",
        };
      }
      const inserted = await client.query(`
        INSERT INTO ai_cost_coverage_acknowledgements(
          tenant_id,unpriced_events_received_before,reason,acknowledged_by
        ) VALUES ($1,$2,'historical_usage_before_pricing',$3)
        RETURNING unpriced_events_received_before,acknowledged_at,acknowledged_by
      `, [input.tenantId, input.receivedBefore, input.acknowledgedBy]);
      await client.query("COMMIT");
      const row = inserted.rows[0];
      return {
        receivedBefore: new Date(row.unpriced_events_received_before).toISOString(),
        acknowledgedAt: new Date(row.acknowledged_at).toISOString(),
        acknowledgedBy: String(row.acknowledged_by),
        reason: "historical_usage_before_pricing",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private conditions(tenantId: string, range: SpendRange, prefix = "e") {
    const values: unknown[] = [tenantId, range.from, range.to, range.receivedBefore ?? new Date()];
    const clauses = [`${prefix}.tenant_id=$1`, `${prefix}.occurred_at >= $2`, `${prefix}.occurred_at < $3`, `${prefix}.received_at <= $4`];
    const admissionClauses: string[] = [];
    const bind = (clause: string, value: string | null) => {
      values.push(value);
      admissionClauses.push(clause.replace("?", `$${values.length}`));
    };
    if (range.teamId) bind("a.team_id=?", range.teamId);
    if (range.userId) bind("a.subject_id=?", range.userId);
    if (range.workspaceId !== undefined) bind("a.workspace_id IS NOT DISTINCT FROM ?", range.workspaceId);
    if (range.agentId !== undefined) bind("a.agent_id IS NOT DISTINCT FROM ?", range.agentId);
    if (range.sessionId !== undefined) bind("a.session_id IS NOT DISTINCT FROM ?", range.sessionId);
    if (range.taskId) bind("a.task_id=?", range.taskId);
    if (range.turnId !== undefined) bind("a.turn_id IS NOT DISTINCT FROM ?", range.turnId);
    return { values, clauses: [...clauses, ...admissionClauses] };
  }

  private async rows(tenantId: string, range: SpendRange) {
    const { values, clauses } = this.conditions(tenantId, range);
    const result = await this.pool.query(`
      SELECT e.*, a.subject_id, u.display_name AS subject_display_name,
        a.team_id, a.team_display_name, a.cost_center_code, a.workspace_id, a.agent_id, a.session_id, a.task_id, a.turn_id,
        a.task_binding_provenance, a.requested_alias, a.requested_service_class, a.selected_service_class,
        a.attempt_kind, a.parent_attempt_id, a.resolved_provider, a.resolved_model, a.resolved_deployment_id, a.admitted_at,
        COALESCE(jsonb_agg(jsonb_build_object(
          'unit', eu.unit, 'quantity', eu.quantity::text, 'bucketCost', eu.bucket_cost::text, 'diagnostic', eu.is_provider_diagnostic
        ) ORDER BY eu.unit) FILTER (WHERE eu.unit IS NOT NULL), '[]'::jsonb) AS units
      FROM ai_usage_events e
      JOIN ai_usage_attempt_admissions a ON a.tenant_id=e.tenant_id AND a.id=e.admission_id
      JOIN users u ON u.tenant_id=a.tenant_id AND u.id=a.subject_id
      LEFT JOIN ai_usage_event_units eu ON eu.tenant_id=e.tenant_id AND eu.event_id=e.id
      WHERE ${clauses.join(" AND ")}
      GROUP BY e.id, a.id, u.id
      ORDER BY e.occurred_at DESC, e.id
      LIMIT ${eventLimit + 1}
    `, values);
    if (result.rows.length > eventLimit) throw new SpendReadLimitError();
    return result.rows.map(rowFromDatabase);
  }

  private async delayed(tenantId: string, range: SpendRange) {
    const values: unknown[] = [tenantId, range.from, range.to, range.receivedBefore ?? new Date()];
    const clauses = ["a.tenant_id=$1", "a.admitted_at >= $2", "a.admitted_at < $3", "a.created_at <= $4"];
    const bind = (column: string, value?: string | null) => {
      if (value === undefined) return;
      values.push(value);
      clauses.push(`a.${column} IS NOT DISTINCT FROM $${values.length}`);
    };
    bind("team_id", range.teamId);
    bind("subject_id", range.userId);
    bind("workspace_id", range.workspaceId);
    bind("agent_id", range.agentId);
    bind("session_id", range.sessionId);
    bind("task_id", range.taskId);
    bind("turn_id", range.turnId);
    const result = await this.pool.query(`
      SELECT count(*)::integer AS count
      FROM ai_usage_attempt_admissions a
      WHERE ${clauses.join(" AND ")}
        AND NOT EXISTS (
          SELECT 1 FROM ai_usage_events e WHERE e.tenant_id=a.tenant_id AND e.admission_id=a.id AND e.received_at <= $4
        )
    `, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  async report(tenantId: string, range: SpendRange) {
    const duration = range.to.getTime() - range.from.getTime();
    const previousRange = {
      ...range,
      from: new Date(range.from.getTime() - duration),
      to: range.from,
    };
    const [rows, delayed, previousRows, latestAcknowledgement] = await Promise.all([
      this.rows(tenantId, range),
      this.delayed(tenantId, range),
      this.rows(tenantId, previousRange),
      this.latestCostCoverageAcknowledgement(tenantId, range.receivedBefore ?? new Date()),
    ]);
    return buildSpendReport(rows, range, delayed, previousRows, latestAcknowledgement);
  }

  async task(tenantId: string, taskKey: string, range: Omit<SpendRange, "teamId" | "taskId" | "userId" | "workspaceId" | "agentId" | "sessionId" | "turnId">) {
    const identity = decodeSpendTaskKey(taskKey);
    if (!identity) return null;
    const scoped = { ...range, ...identity };
    return buildSpendTaskDetail(await this.rows(tenantId, scoped), scoped);
  }
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
};
export const spendReportCsv = (report: SpendReport, tenantId = "") => {
  const header = [
    "contract_version", "tenant_id", "range_from", "range_to", "as_of", "team_id", "team_name", "cost_center_code",
    "user_id", "user_name", "task_key", "task_id", "turn_id", "workspace_id", "agent_id", "requested_route",
    "resolved_routes", "currency", "provider_cost", "provider_confirmed_cost", "attempt_count", "event_count", "retry_count",
    "fallback_count", "failed_attempt_count", "latency_average_ms", "latency_p95_ms", "price_state", "corrected", "dominant_driver",
  ];
  const rows = report.tasks.flatMap((task) => {
    const currencies = [...new Set([
      ...task.costs.map((item) => item.currency),
      ...task.providerConfirmedCosts.map((item) => item.currency),
    ])].sort();
    if (!currencies.length) currencies.push("");
    return currencies.map((currency) => [
      report.contractVersion, tenantId, report.range.from, report.range.to, report.asOf, task.teamId, task.teamDisplayName, report.teams.find((team) => team.teamId === task.teamId)?.costCenterCode ?? "",
      task.userId, task.userDisplayName, task.taskKey, task.taskId, task.turnId, task.workspaceId, task.agentId, task.requestedRoute,
      task.resolvedRoutes.join("|"), currency, task.costs.find((item) => item.currency === currency)?.amount ?? "",
      task.providerConfirmedCosts.find((item) => item.currency === currency)?.amount ?? "",
      task.attemptCount, task.eventCount, task.retryCount, task.fallbackCount, task.failedAttemptCount,
      task.latency.averageMs, task.latency.p95Ms, task.priceState, task.corrected, task.dominantDriver?.code ?? "",
    ]);
  });
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
};
