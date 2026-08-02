import { useEffect, useMemo, useState } from "react";
import { ChevronRight16Regular } from "@fluentui/react-icons/svg/chevron-right";
import { LeafThree20Regular } from "@fluentui/react-icons/svg/leaf-three";
import { Info20Regular } from "@fluentui/react-icons/svg/info";
import { adminApi } from "./workspace-api.js";
import { AI_EMISSIONS_METHOD, estimateAiTokenEmissions } from "./ai-emissions.js";
import { formatOverviewMoney } from "./format-money.js";
import "./AiControlPlaneOverview.css";

const DAY_MS = 86_400_000;
const number = (value) => Number(value ?? 0);
const dateOnly = (value) => value.toISOString().slice(0, 10);
const isoDate = (value) => new Date(`${value}T00:00:00.000Z`).toISOString();
const sumCosts = (costs = [], currency) => costs
  .filter((item) => !currency || item.currency === currency)
  .reduce((sum, item) => sum + number(item.amount), 0);
const amountFor = (costs = [], currency) => costs.find((item) => item.currency === currency)?.amount;
const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0 });

const money = formatOverviewMoney;

const formatEmissions = (emissions) => {
  if (!emissions) return "Estimate not configured";
  const kg = emissions.amountKgCo2e ?? (number(emissions.amountTco2e) * 1_000);
  if (kg >= 1_000) return `${(kg / 1_000).toFixed(2)} tCO₂e`;
  if (kg >= 1) return `${kg.toFixed(2)} kgCO₂e`;
  const grams = kg * 1_000;
  return grams < 0.01 ? "<0.01 gCO₂e" : `${grams.toFixed(2)} gCO₂e`;
};

const emissionsComparison = (emissions) => emissions?.changePercent === null || emissions?.changePercent === undefined
  ? "no comparable prior-period estimate"
  : `${emissions.changePercent > 0 ? "+" : ""}${emissions.changePercent}% from prior period`;

const emissionsRegionName = (label = "") => label.split(" · ")[0] || label;

const currentMonthRange = (now = new Date()) => {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from, to };
};

const priorRangeFor = ({ from, to }) => {
  const duration = to.getTime() - from.getTime();
  return {
    from: new Date(from.getTime() - duration),
    to: from,
  };
};

const trendRanges = (now = new Date(), buckets = 6) => {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const from = new Date(to.getTime() - 30 * DAY_MS);
  const bucketMs = (to.getTime() - from.getTime()) / buckets;
  return Array.from({ length: buckets }, (_, index) => ({
    from: new Date(from.getTime() + (bucketMs * index)),
    to: new Date(from.getTime() + (bucketMs * (index + 1))),
  }));
};

const spendQuery = (range) => ({
  from: range.from.toISOString(),
  to: range.to.toISOString(),
  limit: 1,
});

const safely = async (operation) => {
  try {
    return { value: await operation(), error: null };
  } catch (error) {
    return { value: null, error };
  }
};

export async function loadAiControlPlaneOverviewData(now = new Date()) {
  const range = currentMonthRange(now);
  const priorRange = priorRangeFor(range);
  const ranges = trendRanges(now);
  const [currentResult, priorResult, teamsResult, providersResult, ...seriesResults] = await Promise.all([
    safely(() => adminApi.spend(spendQuery(range))),
    safely(() => adminApi.spend(spendQuery(priorRange))),
    safely(() => adminApi.teams(false)),
    safely(() => adminApi.providerSettings()),
    ...ranges.map((item) => safely(() => adminApi.spend(spendQuery(item)))),
  ]);

  if (!currentResult.value) throw currentResult.error;
  const teams = teamsResult.value?.teams ?? [];
  const [budgetResults, routingResults] = await Promise.all([
    Promise.all(teams.map((team) => safely(() => adminApi.teamBudget(team.id)))),
    Promise.all(teams.map((team) => safely(() => adminApi.routingSettings(team.id)))),
  ]);

  return {
    report: currentResult.value.report,
    priorReport: priorResult.value?.report ?? null,
    teams,
    providers: providersResult.value?.providers ?? [],
    budgets: budgetResults.map((result, index) => ({
      teamId: teams[index].id,
      status: result.value?.status ?? null,
    })),
    routing: routingResults.map((result, index) => ({
      teamId: teams[index].id,
      settings: result.value,
    })).filter((item) => item.settings),
    series: seriesResults.map((result, index) => ({
      from: ranges[index].from.toISOString(),
      to: ranges[index].to.toISOString(),
      costs: result.value?.report?.totals?.costs ?? [],
      unavailable: !result.value,
    })),
    partial: Boolean(priorResult.error || teamsResult.error || providersResult.error || seriesResults.some((result) => result.error)),
  };
}

const currencyFor = (data) => {
  const reportCurrencies = new Set(data?.report?.totals?.costs?.map((item) => item.currency) ?? []);
  if (reportCurrencies.size === 1) return [...reportCurrencies][0];
  if (reportCurrencies.size > 1) return null;
  const currencies = new Set();
  data?.budgets?.forEach(({ status }) => {
    if (status?.budget?.currency) currencies.add(status.budget.currency);
  });
  return currencies.size === 1 ? [...currencies][0] : null;
};

const budgetSummaryFor = (data, currency, report) => {
  if (!currency) return { spent: null, limit: null, configured: 0, total: data?.budgets?.length ?? 0 };
  const reportFrom = report?.range?.from ? new Date(report.range.from).getTime() : null;
  const reportTo = report?.range?.to ? new Date(report.range.to).getTime() : null;
  const statuses = (data?.budgets ?? [])
    .map((item) => item.status)
    .filter((status) => {
      if (status?.budget?.currency !== currency || status.budget.periodType !== "calendar_month") return false;
      if (reportFrom === null || reportTo === null) return true;
      return new Date(status.period?.start).getTime() === reportFrom
        && new Date(status.period?.end).getTime() === reportTo;
    });
  return {
    spent: statuses.length ? statuses.reduce((sum, status) => sum + number(status.settledProviderCost), 0) : null,
    limit: statuses.length ? statuses.reduce((sum, status) => sum + number(status.effectiveLimitAmount), 0) : null,
    configured: statuses.length,
    total: data?.budgets?.length ?? 0,
  };
};

const forecastFor = (spent, report) => {
  if (spent === null || !report?.range?.from || !report?.asOf) return null;
  const from = new Date(report.range.from);
  const asOf = new Date(report.asOf);
  const nextMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const elapsed = Math.max(1, (asOf.getTime() - from.getTime()) / DAY_MS);
  const period = Math.max(elapsed, (nextMonth.getTime() - from.getTime()) / DAY_MS);
  return spent * (period / elapsed);
};

function InlineLink({ onClick, children, className = "" }) {
  if (!onClick) return null;
  return (
    <button className={`ai-overview-link${className ? ` ${className}` : ""}`} type="button" onClick={onClick}>
      <span>{children}</span>
      <ChevronRight16Regular aria-hidden="true" />
    </button>
  );
}

export function AiControlPlaneOverview({
  data: suppliedData,
  loadData = loadAiControlPlaneOverviewData,
  viewMode = "live",
  estimates = null,
  onOpenSpend,
  onOpenRouting,
  onOpenPricing,
}) {
  const [loadedData, setLoadedData] = useState(null);
  const [loading, setLoading] = useState(!suppliedData);
  const [error, setError] = useState("");

  useEffect(() => {
    if (suppliedData) {
      setLoadedData(null);
      setLoading(false);
      setError("");
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError("");
    Promise.resolve(loadData())
      .then((value) => { if (active) setLoadedData(value); })
      .catch((caught) => { if (active) setError(caught?.message ?? "AI spend data is unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [suppliedData, loadData]);

  const data = suppliedData ?? loadedData;
  const report = data?.report;
  const currency = currencyFor(data);
  const budget = useMemo(() => budgetSummaryFor(data, currency, report), [data, currency, report]);
  const providerSpend = currency ? sumCosts(report?.totals?.costs, currency) : null;
  const spent = providerSpend;
  const forecast = estimates?.forecastAmount ?? forecastFor(spent, report);
  const activeUnpricedCount = report?.costCoverage?.unpricedUsage?.activeEventCount
    ?? number(report?.totals?.unknownCostEventCount) + number(report?.totals?.incompleteCostEventCount);
  const missingPriceCount = report?.costCoverage?.unpricedUsage?.missingPriceEventCount
    ?? number(report?.totals?.unknownCostEventCount);
  const partialPriceCount = report?.costCoverage?.unpricedUsage?.partialPriceEventCount
    ?? number(report?.totals?.incompleteCostEventCount);
  const delayedAttemptCount = report?.costCoverage?.delayedReporting?.attemptCount
    ?? number(report?.totals?.delayedAttemptCount);
  const budgetRatio = spent !== null && budget.limit ? Math.max(0, spent / budget.limit) : null;
  const series = estimates?.spendSeries ?? (data?.series ?? []).map((item) => (
    currency ? sumCosts(item.costs, currency) : 0
  ));
  const seriesPeak = Math.max(...series, 1);
  const topTeams = (report?.teams ?? []).slice(0, 5);
  const teamBudgetById = new Map((data?.budgets ?? []).map((item) => [item.teamId, item.status]));
  const emissions = estimates?.emissions
    ?? estimateAiTokenEmissions(report, data?.priorReport, data?.providers);
  const estimatedView = viewMode === "estimated";
  const exportRange = report?.range ? {
    from: report.range.from,
    to: report.range.to,
    asOf: report.asOf,
  } : null;

  return (
    <section className="ai-overview" aria-labelledby="ai-overview-heading" aria-busy={loading || undefined}>
      <h2 id="ai-overview-heading" className="sr-only">AI Control Plane overview</h2>
      {estimatedView && (
        <div className="ai-overview-estimate-banner" role="status">
          <Info20Regular aria-hidden="true" />
          <span><strong>Estimated view</strong> Preview values are illustrative unless a live ledger or provider methodology is named.</span>
        </div>
      )}
      {error && (
        <div className="connection-error ai-overview-error" role="alert">
          <span><strong>Overview data unavailable</strong>{error}</span>
        </div>
      )}

      <section className="ai-budget-panel" aria-labelledby="ai-budget-heading">
        <div className="ai-budget-summary">
          <div className="ai-panel-heading">
            <div>
              <p>Organization budget</p>
              <h3 id="ai-budget-heading">Spend this month</h3>
            </div>
            <div className="ai-budget-actions">
              <InlineLink onClick={onOpenSpend}>View spend details</InlineLink>
              {exportRange && (
                <a className="ai-overview-link" href={adminApi.spendExportUrl(exportRange, "csv")} download>
                  <span>Export report</span>
                </a>
              )}
            </div>
          </div>
          <div className="ai-budget-numbers">
            <div className="ai-budget-primary">
              <strong>{loading ? "—" : money(spent, currency)}</strong>
              <span>{budget.limit === null ? "Budget not set" : `of ${money(budget.limit, currency)}`}</span>
            </div>
            <dl>
              <div>
                <dt>Forecast</dt>
                <dd>{money(forecast, currency)}</dd>
                <small>Straight-line estimate</small>
              </div>
              <div>
                <dt>Unpriced usage</dt>
                <dd>{loading ? "—" : compactNumber.format(activeUnpricedCount)}</dd>
                <small>{missingPriceCount} missing price · {partialPriceCount} partial price</small>
              </div>
              <div>
                <dt>Pending usage records</dt>
                <dd>{loading ? "—" : compactNumber.format(delayedAttemptCount)}</dd>
                <small>Attempts without final usage data</small>
              </div>
            </dl>
          </div>
          <div
            className="ai-budget-progress"
            role="progressbar"
            aria-label="Organization budget consumed"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={budgetRatio === null ? undefined : Math.min(100, Math.round(budgetRatio * 100))}
          >
            <span style={{ width: `${budgetRatio === null ? 0 : Math.min(100, budgetRatio * 100)}%` }} />
          </div>
          <div className="ai-budget-footnote">
            <span>{budget.configured ? `${budget.configured} of ${budget.total} Teams have a matching monthly ${currency} budget` : "No matching monthly Team budgets were found"}</span>
            {budgetRatio !== null && <strong>{percent.format(budgetRatio)} used</strong>}
          </div>
        </div>

        <div className="ai-spend-trend">
          <div className="ai-trend-heading">
            <div>
              <span>30-day provider cost</span>
              <strong>{series.length && currency ? `${money(series.at(-1), currency, { compact: true })} latest 5-day bucket` : "Ledger trend unavailable"}</strong>
            </div>
            <span>{data?.series?.some((item) => item.unavailable) ? "Some buckets unavailable" : "Immutable ledger buckets"}</span>
          </div>
          <div className="ai-trend-plot" aria-label="Provider cost over six five-day buckets">
            {series.length && currency ? (
              <div className="ai-trend-bars" role="img" aria-label={`Six provider-cost buckets: ${series.map((item) => money(item, currency, { compact: true })).join(", ")}`}>
                {series.map((item, index) => <span key={`${index}-${item}`} style={{ height: `${Math.max(4, (number(item) / seriesPeak) * 100)}%` }} />)}
              </div>
            ) : <div className="ai-trend-empty">Daily spend data will appear after governed model calls are recorded.</div>}
          </div>
          <div className="ai-trend-labels"><span>30 days ago</span><span>Today</span></div>
        </div>
      </section>

      <div className="ai-overview-columns">
        <section className="ai-overview-section ai-team-spend" aria-labelledby="ai-team-spend-heading">
          <div className="ai-panel-heading">
            <div><p>Allocation</p><h3 id="ai-team-spend-heading">Top spending Teams</h3></div>
            <InlineLink onClick={onOpenSpend}>View all</InlineLink>
          </div>
          <div className="ai-team-table" role="table" aria-label="Top spending Teams">
            <div className="ai-team-table-head" role="row">
              <span role="columnheader">Team</span><span role="columnheader">Budget</span><span role="columnheader">Spend</span>
            </div>
            {topTeams.length ? topTeams.map((team) => {
              const teamStatus = teamBudgetById.get(team.teamId);
              const teamCurrency = team.costs?.[0]?.currency ?? currency;
              const teamCost = amountFor(team.costs, teamCurrency);
              return (
                <div className="ai-team-row" role="row" key={team.teamId}>
                  <span role="cell"><strong>{team.teamDisplayName}</strong><small>{team.costCenterCode ?? `${team.attemptCount} attempts`}</small></span>
                  <span role="cell">{teamStatus?.percentConsumed === null || teamStatus?.percentConsumed === undefined ? "—" : `${number(teamStatus.percentConsumed).toFixed(0)}%`}</span>
                  <span role="cell"><strong>{money(teamCost, teamCurrency, { compact: true })}</strong><small>{providerSpend ? percent.format(number(teamCost) / providerSpend) : "share unavailable"}</small></span>
                </div>
              );
            }) : <p className="ai-overview-empty">{loading ? "Loading Team spend…" : "No Team spend was recorded this month."}</p>}
          </div>
        </section>

        <section className="ai-overview-section ai-cost-explanation" aria-labelledby="ai-cost-explanation-heading">
          <div className="ai-panel-heading">
            <h3 id="ai-cost-explanation-heading">Explainability</h3>
          </div>
          <div className="ai-explainability-placeholder">Coming Soon</div>
        </section>
      </div>

      <section className="ai-emissions" aria-labelledby="ai-emissions-heading">
        <span className="ai-emissions-icon"><LeafThree20Regular aria-hidden="true" /></span>
        <div className="ai-emissions-copy">
          <div className="ai-emissions-label">
            <p>Estimated AI-related emissions</p>
            <span className="ai-emissions-tooltip-wrap">
              <button type="button" aria-label="How estimated AI emissions are calculated" aria-describedby="ai-emissions-tooltip"><Info20Regular aria-hidden="true" /></button>
              <span className="ai-emissions-tooltip" id="ai-emissions-tooltip" role="tooltip">
                <strong>How this estimate is calculated</strong>
                <span>Covered text tokens ÷ 1,000,000 × {AI_EMISSIONS_METHOD.energyKwhPerMillionTextTokens} kWh × the selected grid factor. Regional results are added together.</span>
                {emissions?.regionSources?.length ? emissions.regionSources.map((source) => (
                  <span className="ai-emissions-tooltip-region" key={source.region}>
                    <b>{emissionsRegionName(source.label)}</b>
                    {number(source.tokens).toLocaleString("en")} tokens × {AI_EMISSIONS_METHOD.regions[source.region].kgCo2ePerKwh} kg CO₂e/kWh
                  </span>
                )) : <span className="ai-emissions-tooltip-region">Choose an estimated serving grid on a configured provider to apply a regional factor.</span>}
                <small>Includes input, output, cache-read, cache-write, and reasoning text tokens. This is an operational estimate, not an assured provider location.</small>
              </span>
            </span>
          </div>
          <h3 id="ai-emissions-heading">{formatEmissions(emissions)}</h3>
          <span>{emissions ? `${emissions.coveragePercent ?? 0}% token coverage · ${emissionsComparison(emissions)}` : "Choose an estimated serving grid on at least one configured provider before reporting a number."}</span>
        </div>
        <div className="ai-emissions-evidence">
          <strong>Operational estimate · Scope 3 Category 1 candidate</strong>
          <span>{emissions?.methodologyVersion ? `${emissions.energyKwhPerMillionTextTokens} kWh / 1M text tokens · ${emissions.methodologyVersion}` : "Purchased cloud/AI services; confirm the reporting boundary with your sustainability policy."}</span>
          {emissions?.methodologyUrl ? <div className="ai-emissions-links"><a href={emissions.methodologyUrl} target="_blank" rel="noreferrer">Energy method</a>{emissions.regionSources?.map((source) => <a key={source.region} href={source.sourceUrl} target="_blank" rel="noreferrer">{source.region.toUpperCase()} grid factor</a>)}</div> : <button type="button" disabled>Methodology required</button>}
        </div>
      </section>

      <footer className="ai-overview-footer">
        <span>Costs exclude unpriced usage; delayed reporting is tracked separately.</span>
        <InlineLink onClick={onOpenPricing}>Manage pricing</InlineLink>
      </footer>
    </section>
  );
}
