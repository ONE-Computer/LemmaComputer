import { useEffect, useMemo, useState } from "react";
import { adminApi } from "./workspace-api.js";
import "./SpendDashboard.css";

const day = (value) => value.toISOString().slice(0, 10);
const initialRange = () => {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: day(from), to: day(to) };
};
const isoDate = (value) => new Date(`${value}T00:00:00.000Z`).toISOString();
const money = (costs) => costs.length
  ? costs.map((item) => new Intl.NumberFormat("en", { style: "currency", currency: item.currency, maximumFractionDigits: 6 }).format(Number(item.amount))).join(" · ")
  : "Cost unavailable";
const quantity = (value) => new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(Number(value ?? 0));
const usageQuantity = (usage, unit) => Object.prototype.hasOwnProperty.call(usage, unit) ? quantity(usage[unit]) : "Unavailable";
const coreUsageUnits = new Set(["input_uncached_token", "cache_read_token", "cache_write_token", "output_token", "reasoning_token"]);
const otherUsage = (usage) => Object.entries(usage)
  .filter(([unit]) => !coreUsageUnits.has(unit))
  .slice(0, 3)
  .map(([unit, value]) => `${quantity(value)} ${unit.replaceAll("_", " ")}`)
  .join(" · ");

export function SpendDashboard({ onBack }) {
  const [dates, setDates] = useState(initialRange);
  const [appliedDates, setAppliedDates] = useState(initialRange);
  const [report, setReport] = useState(null);
  const [page, setPage] = useState(null);
  const [drillReport, setDrillReport] = useState(null);
  const [drillPage, setDrillPage] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [taskDetail, setTaskDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const query = useMemo(() => ({
    from: isoDate(appliedDates.from),
    to: isoDate(appliedDates.to),
    limit: 200,
  }), [appliedDates]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    adminApi.spend(query)
      .then((value) => {
        if (!active) return;
        setReport(value.report);
        setPage(value.page);
        setDrillReport(null);
        setDrillPage(null);
        setSelectedTeam("");
        setSelectedUser("");
        setTaskDetail(null);
      })
      .catch((caught) => { if (active) setError(caught.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [query]);

  useEffect(() => {
    if (!report || !selectedTeam) {
      setDrillReport(null);
      setDrillPage(null);
      return undefined;
    }
    let active = true;
    setLoading(true);
    adminApi.spend({
      from: report.range.from,
      to: report.range.to,
      asOf: report.asOf,
      teamId: selectedTeam,
      ...(selectedUser ? { userId: selectedUser } : {}),
      limit: 200,
    }).then((value) => {
      if (!active) return;
      setDrillReport(value.report);
      setDrillPage(value.page);
    }).catch((caught) => { if (active) setError(caught.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [report?.asOf, selectedTeam, selectedUser]);

  const activeReport = drillReport ?? report;
  const teams = report?.teams ?? [];
  const users = (activeReport?.users ?? []).filter((user) => !selectedTeam || user.teamId === selectedTeam);
  const tasks = (activeReport?.tasks ?? []).filter((task) => (
    (!selectedTeam || task.teamId === selectedTeam)
    && (!selectedUser || task.userId === selectedUser)
  ));
  const selectedTeamName = teams.find((team) => team.teamId === selectedTeam)?.teamDisplayName;
  const selectedUserName = users.find((user) => user.userId === selectedUser)?.userDisplayName;
  const exportQuery = report ? {
    from: report.range.from,
    to: report.range.to,
    asOf: report.asOf,
    ...(selectedTeam ? { teamId: selectedTeam } : {}),
    ...(selectedUser ? { userId: selectedUser } : {}),
  } : query;

  const dimensions = report?.breakdowns ? [
    {
      title: "Requested routes", rows: report.breakdowns.requestedRoutes,
      key: (row) => row.requestedRoute, label: (row) => row.requestedRoute,
    },
    {
      title: "Resolved models", rows: report.breakdowns.resolvedModels,
      key: (row) => `${row.provider}:${row.model}:${row.deploymentId}`,
      label: (row) => `${row.provider} / ${row.model}`, detail: (row) => row.deploymentId,
    },
    {
      title: "Workspaces", rows: report.breakdowns.workspaces,
      key: (row) => row.workspaceId ?? "unbound-workspace",
      label: (row) => row.workspaceId ?? "Unbound workspace",
    },
    {
      title: "Agents", rows: report.breakdowns.agents,
      key: (row) => row.agentId ?? "unbound-agent",
      label: (row) => row.agentId ?? "Unbound agent",
    },
  ] : [];
  const openTask = async (task) => {
    setLoading(true);
    setError("");
    try {
      const value = await adminApi.spendTask(task.taskKey, {
        from: report.range.from,
        to: report.range.to,
        asOf: report.asOf,
      });
      setTaskDetail(value.task);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  };
  const loadMoreTasks = async () => {
    if (!drillPage?.nextCursor || !drillReport) return;
    setLoading(true);
    try {
      const value = await adminApi.spend({ cursor: drillPage.nextCursor, limit: 200 });
      setDrillReport((current) => ({ ...value.report, tasks: [...current.tasks, ...value.report.tasks] }));
      setDrillPage(value.page);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  };

  if (taskDetail) {
    return (
      <div className="secondary-screen spend-screen">
        <button className="settings-back-button" type="button" onClick={() => setTaskDetail(null)}>← Back to spend</button>
        <header className="page-heading compact">
          <p>Sanitized task explanation</p>
          <h1>{taskDetail.task.taskId}</h1>
          <span>{taskDetail.task.teamDisplayName} · {taskDetail.task.userDisplayName} · {money(taskDetail.task.costs)}</span>
        </header>
        {taskDetail.task.priceState !== "priced" && <div className="spend-state-banner" role="status"><strong>Cost data is {taskDetail.task.priceState}.</strong><span>Usage remains visible and is not treated as zero.</span></div>}
        {taskDetail.task.corrected && <div className="spend-state-banner corrected" role="status"><strong>Corrected ledger facts included.</strong><span>Totals include each append-only correction delta once.</span></div>}
        <section className="spend-detail-card" aria-labelledby="cost-driver-heading">
          <div className="spend-section-heading"><div><p>Why this task cost</p><h2 id="cost-driver-heading">Safe cost drivers</h2></div></div>
          <div className="spend-driver-list">
            {taskDetail.drivers.length ? taskDetail.drivers.map((driver, index) => (
              <article key={driver.code}><span>{index + 1}</span><div><strong>{driver.label}</strong><small>{quantity(driver.evidenceCount)} allow-listed signals</small></div></article>
            )) : <p>No safe driver signal was reported by the provider.</p>}
          </div>
        </section>
        <section className="spend-detail-card" aria-labelledby="attempt-heading">
          <div className="spend-section-heading"><div><p>Governed calls</p><h2 id="attempt-heading">Attempts</h2></div><span>{taskDetail.attempts.length}</span></div>
          <div className="spend-attempt-list">
            {taskDetail.attempts.map((attempt) => (
              <article key={attempt.admissionId}>
                <div><strong>{attempt.attemptKind}</strong><small>{attempt.provider} / {attempt.model}</small></div>
                <div><strong>{money(attempt.costs)}</strong><small>{attempt.priceStatus} · {attempt.costStatus}{attempt.correction ? " · corrected" : ""}</small></div>
                <div><strong>{usageQuantity(attempt.usage, "input_uncached_token")} input · {usageQuantity(attempt.usage, "output_token")} output</strong><small>{usageQuantity(attempt.usage, "cache_read_token")} cache read · {usageQuantity(attempt.usage, "cache_write_token")} cache write · {usageQuantity(attempt.usage, "reasoning_token")} reasoning{otherUsage(attempt.usage) ? ` · ${otherUsage(attempt.usage)}` : ""}</small><small>{attempt.latencyMs === null ? "Latency unavailable" : `${attempt.latencyMs} ms`}</small></div>
                <div><strong>{attempt.priceBasis ? `${attempt.priceBasis.source} ${attempt.priceBasis.version}` : "Price basis unavailable"}</strong><small>{attempt.priceBasis ? `Effective ${new Date(attempt.priceBasis.effectiveFrom).toLocaleDateString()}` : "Usage is not treated as free"}</small></div>
              </article>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="secondary-screen spend-screen">
      <button className="settings-back-button" type="button" onClick={onBack}>← Back to Settings</button>
      <header className="page-heading compact">
        <p>AI spend governance</p>
        <h1>Organization spend</h1>
        <span>Provider cost by Team, user, and task. Prompts, responses, hidden reasoning, tool arguments, and secrets are never shown.</span>
      </header>
      <form className="spend-filter-bar" onSubmit={(event) => { event.preventDefault(); setAppliedDates(dates); }}>
        <label><span>From</span><input aria-label="Spend from date" type="date" value={dates.from} max={dates.to} onChange={(event) => setDates((current) => ({ ...current, from: event.target.value }))} /></label>
        <label><span>To</span><input aria-label="Spend to date" type="date" value={dates.to} min={dates.from} onChange={(event) => setDates((current) => ({ ...current, to: event.target.value }))} /></label>
        <button className="primary-button" type="submit" disabled={loading}>Apply dates</button>
        {report && <div className="spend-export-actions">
          <a className="secondary-button" href={adminApi.spendExportUrl(exportQuery, "csv")} download>Export CSV</a>
          <a className="secondary-button" href={adminApi.spendExportUrl(exportQuery, "json")} download>Export JSON</a>
        </div>}
      </form>
      {error && <div className="connection-error" role="alert"><span><strong>Spend view unavailable</strong>{error}</span></div>}
      {loading && !report ? <p className="spend-empty">Loading organization spend…</p> : report?.state === "empty" ? (
        <section className="spend-empty" aria-labelledby="empty-spend-heading"><h2 id="empty-spend-heading">No usage recorded</h2><p>No governed model calls or delayed attempts were recorded in this range. This is a true empty state, not a zero-cost estimate.</p></section>
      ) : report && <>
        <section className="spend-kpis" aria-label="Spend summary">
          <article><span>Provider cost</span><strong>{money(report.totals.costs)}</strong><small>{report.totals.providerConfirmedCosts.length ? `${money(report.totals.providerConfirmedCosts)} provider-confirmed` : "Estimated from immutable rate snapshots"}</small></article>
          <article><span>Governed attempts</span><strong>{report.totals.attemptCount}</strong><small>{report.totals.retryCount} retries · {report.totals.fallbackCount} fallbacks{report.totals.latency?.p95Ms !== null && report.totals.latency?.p95Ms !== undefined ? ` · ${report.totals.latency.p95Ms} ms p95` : " · latency unavailable"}</small></article>
          <article><span>Allocation</span><strong>{report.totals.allocatedAttemptCount} allocated</strong><small>{report.totals.unallocatedAttemptCount} unallocated</small></article>
          <article><span>Usage</span><strong>{usageQuantity(report.totals.usage, "input_uncached_token")} input · {usageQuantity(report.totals.usage, "output_token")} output</strong><small>{usageQuantity(report.totals.usage, "cache_read_token")} cache read · {usageQuantity(report.totals.usage, "cache_write_token")} cache write · {usageQuantity(report.totals.usage, "reasoning_token")} reasoning{otherUsage(report.totals.usage) ? ` · ${otherUsage(report.totals.usage)}` : ""}</small></article>
        </section>
        {report.trend && <section className="spend-trend" aria-labelledby="spend-trend-heading"><div><p>Compared with {new Date(report.trend.previousRange.from).toLocaleDateString()}–{new Date(report.trend.previousRange.to).toLocaleDateString()}</p><h2 id="spend-trend-heading">Previous-period trend</h2></div><strong>{money(report.trend.costDeltas)} cost change</strong><span>{report.trend.attemptCountDelta >= 0 ? "+" : ""}{report.trend.attemptCountDelta} attempts</span></section>}
        {dimensions.length > 0 && <section className="spend-table-card" aria-labelledby="spend-dimensions-heading">
          <div className="spend-section-heading"><div><p>Organization view</p><h2 id="spend-dimensions-heading">Spend dimensions</h2></div></div>
          <div className="spend-dimensions">
            {dimensions.map((dimension) => <article key={dimension.title}><h3>{dimension.title}</h3>{dimension.rows.slice(0, 5).map((row) => <div key={dimension.key(row)}><span><strong>{dimension.label(row)}</strong>{dimension.detail?.(row) && <small>{dimension.detail(row)}</small>}</span><span><strong>{money(row.costs)}</strong><small>{row.attemptCount} attempts</small></span></div>)}</article>)}
          </div>
        </section>}
        {(report.state === "partial") && <div className="spend-state-banner" role="status"><strong>Some cost data is unavailable.</strong><span>{report.totals.unknownCostEventCount} unknown-price, {report.totals.incompleteCostEventCount} partial-price, and {report.totals.delayedAttemptCount} delayed attempts are excluded from monetary totals, not counted as zero.</span></div>}
        <nav className="spend-breadcrumbs" aria-label="Spend drilldown">
          <button type="button" className={!selectedTeam ? "active" : ""} onClick={() => { setSelectedTeam(""); setSelectedUser(""); }}>All Teams</button>
          {selectedTeam && <><span>›</span><button type="button" className={!selectedUser ? "active" : ""} onClick={() => setSelectedUser("")}>{selectedTeamName}</button></>}
          {selectedUser && <><span>›</span><strong>{selectedUserName}</strong></>}
        </nav>
        {!selectedTeam && <section className="spend-table-card" aria-labelledby="team-spend-heading">
          <div className="spend-section-heading"><div><p>Allocation</p><h2 id="team-spend-heading">Teams</h2></div><span>{teams.length}</span></div>
          <div className="spend-row-list">{teams.map((team) => <button type="button" key={team.teamId} onClick={() => { setSelectedTeam(team.teamId); setSelectedUser(""); }}><span><strong>{team.teamDisplayName}</strong><small>{team.costCenterCode ?? (team.allocation === "unallocated" ? "Unallocated" : "No cost-center code")}</small></span><span><strong>{money(team.costs)}</strong><small>{team.attemptCount} attempts</small></span><b>›</b></button>)}</div>
        </section>}
        {selectedTeam && !selectedUser && <section className="spend-table-card" aria-labelledby="user-spend-heading">
          <div className="spend-section-heading"><div><p>{selectedTeamName}</p><h2 id="user-spend-heading">Users</h2></div><span>{users.length}</span></div>
          <div className="spend-row-list">{users.map((user) => <button type="button" key={`${user.teamId}:${user.userId}`} onClick={() => setSelectedUser(user.userId)}><span><strong>{user.userDisplayName}</strong><small>{user.userId}</small></span><span><strong>{money(user.costs)}</strong><small>{user.attemptCount} attempts</small></span><b>›</b></button>)}</div>
        </section>}
        {(selectedUser || selectedTeam) && <section className="spend-table-card" aria-labelledby="task-spend-heading">
          <div className="spend-section-heading"><div><p>{selectedUserName ?? selectedTeamName}</p><h2 id="task-spend-heading">Tasks</h2></div><span>{tasks.length}{(drillPage ?? page)?.totalTasks > tasks.length ? ` of ${(drillPage ?? page).totalTasks}` : ""}</span></div>
          <div className="spend-row-list">{tasks.length ? tasks.map((task) => <button type="button" key={task.taskKey} onClick={() => openTask(task)}><span><strong>{task.taskId}</strong><small>{task.requestedRoute} → {task.resolvedRoutes.join(", ")}</small></span><span><strong>{money(task.costs)}</strong><small>{task.dominantDriver?.label ?? "Driver unavailable"} · {task.priceState}{task.corrected ? " · corrected" : ""}</small></span><b>›</b></button>) : <p className="spend-empty-row">No tasks match this drilldown.</p>}</div>
          {drillPage?.nextCursor && <div className="spend-load-more"><button className="secondary-button" type="button" disabled={loading} onClick={loadMoreTasks}>{loading ? "Loading tasks…" : "Load more tasks"}</button></div>}
        </section>}
      </>}
    </div>
  );
}
