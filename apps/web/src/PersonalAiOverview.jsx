import { useEffect, useMemo, useRef, useState } from "react";
import { Info20Regular } from "@fluentui/react-icons/svg/info";
import { LeafThree20Regular } from "@fluentui/react-icons/svg/leaf-three";
import { ModalDialog } from "./ui.jsx";
import { AI_EMISSIONS_METHOD, estimateAiTokenEmissions, textTokenTotal } from "./ai-emissions.js";
import { memberApi } from "./workspace-api.js";
import "./PersonalAiOverview.css";

const count = (value) => new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(Number(value ?? 0));
const money = (costs = []) => costs.length
  ? costs.map((item) => new Intl.NumberFormat("en", { style: "currency", currency: item.currency, maximumFractionDigits: 6 }).format(Number(item.amount))).join(" · ")
  : "Cost unavailable";
const sameMoneyTotals = (left = [], right = []) => left.length === right.length && left.every((item) => {
  const match = right.find((candidate) => candidate.currency === item.currency);
  return match && Number(match.amount) === Number(item.amount);
});
const shortId = (value) => value ? `${value.slice(0, 8)}…` : "";
const period = (range) => range
  ? `${new Date(range.from).toLocaleDateString(undefined, { day: "numeric", month: "short" })}–${new Date(range.to).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
  : "Current month";
const emissionsAmount = (estimate) => {
  if (!estimate) return "Method unavailable";
  if (estimate.amountKgCo2e >= 1) return `${estimate.amountKgCo2e.toFixed(2)} kg CO₂e`;
  return `${(estimate.amountKgCo2e * 1_000).toFixed(2)} g CO₂e`;
};

const groupLabelMaps = (workspaces = []) => {
  const workspaceLabels = new Map();
  const agentLabels = new Map();
  for (const workspace of workspaces) {
    workspaceLabels.set(workspace.id, workspace.grantId === "personal" ? "Personal workspace" : workspace.grantId ?? "Workspace");
    for (const agent of workspace.agents ?? []) {
      if (agent.agentId) agentLabels.set(agent.agentId, agent.displayName ?? agent.id);
    }
  }
  return { workspaceLabels, agentLabels };
};

const Breakdown = ({ title, rows, idKey, labels, previousLabel }) => (
  <section className="personal-ai-breakdown" aria-labelledby={`personal-ai-${idKey}-heading`}>
    <div className="personal-ai-section-heading">
      <div><p>Your activity</p><h2 id={`personal-ai-${idKey}-heading`}>{title}</h2></div>
      <span>{rows.length}</span>
    </div>
    {rows.length ? <div className="personal-ai-breakdown-list">
      {rows.map((row) => {
        const id = row[idKey];
        const label = id ? labels.get(id) ?? `${previousLabel} (${shortId(id)})` : `No ${idKey === "workspaceId" ? "workspace" : "agent"} attribution`;
        return <article key={id ?? `unbound-${idKey}`}>
          <span><strong>{label}</strong><small>{count(row.attemptCount)} {row.attemptCount === 1 ? "request" : "requests"}{row.correctedEventCount ? ` · ${row.correctedEventCount} corrected` : ""}</small></span>
          <span><strong>{count(textTokenTotal(row.usage))} tokens</strong><small>{money(row.costs)}</small></span>
        </article>;
      })}
    </div> : <p className="personal-ai-breakdown-empty">No attributed activity in this period.</p>}
  </section>
);

export function PersonalAiOverview({ workspaces = [] }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [methodOpen, setMethodOpen] = useState(false);
  const methodButtonRef = useRef(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    memberApi.aiUsage()
      .then((value) => { if (active) setReport(value.report); })
      .catch((caught) => { if (active) setError(caught.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const labels = useMemo(() => groupLabelMaps(workspaces), [workspaces]);
  const emissions = useMemo(() => report ? estimateAiTokenEmissions({
    totals: report.totals,
    breakdowns: { resolvedModels: report.providerUsage },
  }, null, report.servingGridAssumptions) : null, [report]);
  const totalTokens = textTokenTotal(report?.totals?.usage);
  const mixedCurrencies = (report?.totals?.costs?.length ?? 0) > 1;
  const unpricedCount = report?.costCoverage?.unpricedUsage?.activeEventCount ?? 0;
  const delayedCount = report?.costCoverage?.delayedReporting?.attemptCount ?? 0;
  const correctedCount = report?.totals?.correctedEventCount ?? 0;
  const confirmed = report?.totals?.providerConfirmedCosts ?? [];
  const costBasis = confirmed.length === 0
    ? "Estimated from immutable rate snapshots"
    : sameMoneyTotals(confirmed, report?.totals?.costs)
      ? "Provider-confirmed cost"
      : `${money(confirmed)} provider-confirmed; remaining cost uses immutable rate snapshots`;
  const unsupportedUnits = Object.keys(report?.totals?.usage ?? {}).filter((unit) => ![
    "input_uncached_token", "cache_read_token", "cache_write_token", "output_token", "reasoning_token",
  ].includes(unit));

  return <div className="secondary-screen personal-ai-screen">
    <header className="page-heading">
      <p>Private member view</p>
      <h1>My AI usage</h1>
      <span>Your accounted tokens, provider cost, and estimated operational emissions. Organization budgets, model controls, and other people’s activity are not included.</span>
    </header>

    {error && <div className="connection-error" role="alert"><span><strong>AI usage unavailable</strong>{error}</span></div>}
    {loading && !report && <p className="personal-ai-loading" role="status">Loading your AI usage…</p>}
    {report?.state === "empty" ? <section className="personal-ai-empty" aria-labelledby="personal-ai-empty-heading">
      <h2 id="personal-ai-empty-heading">No AI usage recorded this month</h2>
      <p>No governed model calls or delayed usage reports are attributed to your membership in this period. Cost is unavailable because there is no usage—not assumed to be zero.</p>
    </section> : report && <>
      <div className="personal-ai-period"><span>{period(report.range)}</span><small>Updated {new Date(report.asOf).toLocaleString()}</small></div>
      <section className="personal-ai-kpis" aria-label="Your AI usage summary">
        <article><span>Accounted text tokens</span><strong>{count(totalTokens)}</strong><small>Input, output, cache, and reasoning tokens</small></article>
        <article><span>Accounted provider cost</span><strong>{money(report.totals.costs)}</strong><small>{costBasis}</small></article>
        <article><span>AI requests</span><strong>{count(report.totals.attemptCount)}</strong><small>Across {report.breakdowns.workspaces.length} workspace{report.breakdowns.workspaces.length === 1 ? "" : "s"} and {report.breakdowns.agents.length} agent{report.breakdowns.agents.length === 1 ? "" : "s"}</small></article>
      </section>

      {(unpricedCount || delayedCount || correctedCount || mixedCurrencies) ? <section className="personal-ai-data-state" aria-labelledby="personal-ai-data-state-heading">
        <div><p>What is included</p><h2 id="personal-ai-data-state-heading">Data notes</h2></div>
        <ul>
          {unpricedCount > 0 && <li><strong>{unpricedCount} unpriced usage {unpricedCount === 1 ? "event" : "events"}</strong><span>Usage is included, but missing cost stays unavailable and is never shown as zero.</span></li>}
          {delayedCount > 0 && <li><strong>{delayedCount} {delayedCount === 1 ? "request is" : "requests are"} awaiting a usage report</strong><span>These requests are tracked separately until a final provider record arrives.</span></li>}
          {correctedCount > 0 && <li><strong>{correctedCount} ledger {correctedCount === 1 ? "correction" : "corrections"} included</strong><span>Append-only correction deltas are applied once to the original attribution.</span></li>}
          {mixedCurrencies && <li><strong>Mixed currencies stay separate</strong><span>No exchange rate or combined currency total has been assumed.</span></li>}
        </ul>
      </section> : null}

      <div className="personal-ai-overview-grid">
        <section className="personal-ai-emissions" aria-labelledby="personal-ai-emissions-heading">
          <span className="personal-ai-emissions-icon"><LeafThree20Regular aria-hidden="true" /></span>
          <div>
            <p>Derived dashboard proxy</p>
            <h2 id="personal-ai-emissions-heading">{emissionsAmount(emissions)}</h2>
            <span>{emissions ? `${emissions.coveragePercent}% accounted-token coverage · ${emissions.regionSources.map((source) => source.label.split(" · ")[0]).join(" and ")}` : "No supported serving-grid assumption is configured for your recorded providers."}</span>
            {unsupportedUnits.length > 0 && <small>{unsupportedUnits.map((unit) => unit.replaceAll("_", " ")).join(", ")} usage is outside this text-token method.</small>}
          </div>
          <button ref={methodButtonRef} type="button" onClick={() => setMethodOpen(true)} aria-haspopup="dialog">How this estimate works <Info20Regular aria-hidden="true" /></button>
        </section>

        <section className="personal-ai-trend" aria-labelledby="personal-ai-trend-heading">
          <div><p>Previous period</p><h2 id="personal-ai-trend-heading">Usage trend</h2></div>
          {report.trend ? <>
            <div className="personal-ai-trend-row"><span>Requests</span><strong>{report.trend.attemptCountDelta >= 0 ? "+" : ""}{count(report.trend.attemptCountDelta)}</strong><small>from {count(report.trend.attemptCount)}</small></div>
            <div className="personal-ai-trend-row"><span>Provider cost change</span><strong>{money(report.trend.costDeltas)}</strong><small>{period(report.trend.previousRange)}</small></div>
          </> : <p>No comparable previous period is available yet.</p>}
        </section>
      </div>

      <div className="personal-ai-breakdown-grid">
        <Breakdown title="By workspace" rows={report.breakdowns.workspaces} idKey="workspaceId" labels={labels.workspaceLabels} previousLabel="Previous workspace" />
        <Breakdown title="By agent" rows={report.breakdowns.agents} idKey="agentId" labels={labels.agentLabels} previousLabel="Previous agent" />
      </div>

      <section className="personal-ai-privacy" aria-labelledby="personal-ai-privacy-heading">
        <h2 id="personal-ai-privacy-heading">Private by membership</h2>
        <p>{report.privacy.description} Prompt text, responses, hidden reasoning, tool arguments, and raw task content are excluded.</p>
      </section>
    </>}

    {methodOpen && <ModalDialog
      className="personal-ai-method-modal"
      title="How this estimate works"
      description="A disclosed operational proxy—not an invoice, product carbon footprint, life-cycle assessment, or sustainability assurance."
      eyebrow="Derived dashboard proxy"
      labelledBy="personal-ai-method-title"
      onClose={() => { setMethodOpen(false); window.requestAnimationFrame(() => methodButtonRef.current?.focus()); }}
    >
      <div className="personal-ai-method-details">
        <p><strong>Method version</strong><span>{AI_EMISSIONS_METHOD.version}</span></p>
        <p><strong>Energy factor</strong><span>{AI_EMISSIONS_METHOD.energyKwhPerMillionTextTokens} kWh per million accounted text tokens</span></p>
        {(emissions?.regionSources ?? []).map((source) => <p key={source.region}><strong>Selected serving-grid assumption</strong><span>{source.label} · {AI_EMISSIONS_METHOD.regions[source.region].kgCo2ePerKwh} kg CO₂e/kWh</span></p>)}
        {!emissions && <p><strong>Method unavailable</strong><span>An administrator has not selected a supported serving-grid assumption for the providers in this period.</span></p>}
        <p><strong>Coverage</strong><span>{emissions ? `${count(emissions.coveredTokens)} of ${count(emissions.totalTokens)} accounted text tokens (${emissions.coveragePercent}%)` : "Unavailable"}</span></p>
        <p><strong>Boundary</strong><span>Inference electricity only. Training, embodied hardware, networking outside the study boundary, storage, and employee devices are excluded.</span></p>
        <p><strong>Location caveat</strong><span>The selected grid is an accounting assumption. It does not control or prove the provider’s physical serving location.</span></p>
      </div>
      <div className="modal-actions"><button className="primary-button" type="button" onClick={() => { setMethodOpen(false); window.requestAnimationFrame(() => methodButtonRef.current?.focus()); }}>Close</button></div>
    </ModalDialog>}
  </div>;
}
