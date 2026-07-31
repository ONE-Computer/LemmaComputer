import { useEffect, useState } from "react";
import { adminApi } from "./workspace-api.js";
const labels = { lite: "Lite", balanced: "Balanced", pro: "Pro" };
const money = (amount, currency) =>
  amount == null
    ? "—"
    : `${currency ?? ""} ${Number(amount).toFixed(2)}`.trim();
export function RoutingAdmin({ onBack }) {
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState("");
  const [settings, setSettings] = useState(null);
  const [report, setReport] = useState(null);
  const [classes, setClasses] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [enableOpen, setEnableOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewPassed, setReviewPassed] = useState(false);
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    adminApi
      .teams(false)
      .then(({ teams }) => {
        setTeams(teams);
        setTeamId(teams[0]?.id ?? "");
      })
      .catch((caught) => setError(caught.message));
  }, []);
  const load = async (id) => {
    if (!id) return;
    setError("");
    try {
      const [current, shadow] = await Promise.all([
        adminApi.routingSettings(id),
        adminApi.routingShadowReport(id),
      ]);
      setSettings(current);
      setReport(shadow);
      setClasses(
        current.policy?.team?.allowedServiceClasses ??
          current.policy?.identity.allowedServiceClasses ??
          [],
      );
    } catch (caught) {
      setError(caught.message);
    }
  };
  useEffect(() => {
    void load(teamId);
  }, [teamId]);
  const run = async (operation) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await load(teamId);
      return true;
    } catch (caught) {
      setError(caught.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const savePolicy = () =>
    run(() =>
      adminApi.saveRoutingPolicy(teamId, {
        mappingVersionId: settings.policy.mappingVersionId,
        billingCurrency: settings.policy.billingCurrency,
        serviceClassPolicies: settings.policy.serviceClassPolicies,
        identity: settings.policy.identity,
        team: {
          ...settings.policy.identity,
          allowedServiceClasses: classes,
          allowedDeploymentIds:
            settings.policy.identity.allowedDeploymentIds.filter((id) =>
              settings.deployments.some(
                (deployment) =>
                  deployment.id === id &&
                  classes.includes(deployment.serviceClass),
              ),
            ),
        },
        ...(settings.policy.requiredResidency
          ? { requiredResidency: settings.policy.requiredResidency }
          : {}),
      }),
    );
  const rollout = (mode, confirmation) =>
    run(() =>
      adminApi.changeRoutingRollout(teamId, {
        policyVersionId: settings.policy.id,
        mappingVersionId: settings.policy.mappingVersionId,
        mode,
        fixedDeploymentId: settings.rollout.fixedDeploymentId,
        ...(mode === "enabled" && settings.review?.id
          ? { evidenceReviewId: settings.review.id }
          : {}),
        reason:
          mode === "shadow"
            ? "Administrator started bounded shadow evaluation"
            : "Administrator reviewed evidence and enabled governed Auto routing",
        ...(confirmation ? { confirmation } : {}),
      }),
    );
  const enable = async () => {
    if (await rollout("enabled", "ENABLE AUTO ROUTING")) {
      setEnableOpen(false);
      setConfirmed(false);
    }
  };
  const kill = () =>
    run(() =>
      adminApi.routingKillSwitch(teamId, {
        reason: "Administrator activated the immediate routing kill switch",
      }),
    );
  const review = async () => {
    if (
      await run(() =>
        adminApi.saveRoutingReview(teamId, {
          evaluationPassed: reviewPassed,
          reviewNote,
        }),
      )
    ) {
      setReviewOpen(false);
      setReviewNote("");
      setReviewPassed(false);
    }
  };
  const openDecision = async (id) => {
    setError("");
    try {
      setDetail(await adminApi.routingDecision(id));
    } catch (caught) {
      setError(caught.message);
    }
  };
  return (
    <div className="secondary-screen routing-admin-screen">
      <button className="settings-back-button" type="button" onClick={onBack}>
        ← Back to Settings
      </button>
      <header className="page-heading compact">
        <p>AI governance</p>
        <h1>Model routing</h1>
        <span>
          Users see stable Auto, Lite, Balanced, and Pro service classes.
          Concrete provider deployments remain administrator-only.
        </span>
      </header>
      {error && (
        <div className="workspace-error" role="alert">
          <span>
            <strong>Routing unavailable</strong>
            {error}
          </span>
        </div>
      )}
      <section className="routing-control-card">
        <label className="modal-field">
          <span>Team</span>
          <select
            aria-label="Routing Team"
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.displayName}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span>Rollout state</span>
          <strong
            className={`routing-mode ${settings?.rollout?.mode ?? "disabled"}`}
          >
            {settings?.rollout?.mode ?? "not configured"}
          </strong>
        </div>
        <p>
          The kill switch always restores the prior fixed route without changing
          provider credentials.
        </p>
      </section>
      {settings?.policy && (
        <>
          <section
            className="routing-control-card"
            aria-labelledby="routing-policy-heading"
          >
            <div>
              <p>Team policy</p>
              <h2 id="routing-policy-heading">Eligible service classes</h2>
            </div>
            <div className="routing-class-grid">
              {["lite", "balanced", "pro"].map((item) => (
                <label key={item}>
                  <input
                    type="checkbox"
                    checked={classes.includes(item)}
                    disabled={
                      busy ||
                      !settings.policy.identity.allowedServiceClasses.includes(
                        item,
                      )
                    }
                    onChange={(event) =>
                      setClasses((current) =>
                        event.target.checked
                          ? [...current, item]
                          : current.filter((value) => value !== item),
                      )
                    }
                  />
                  <strong>{labels[item]}</strong>
                  <span>
                    {item === "lite"
                      ? "Lowest-cost routine work"
                      : item === "balanced"
                        ? "Safe default for ambiguous work"
                        : "Highest capability floor"}
                  </span>
                </label>
              ))}
            </div>
            <button
              className="secondary-button"
              disabled={busy || !classes.length}
              onClick={savePolicy}
            >
              Save Team policy
            </button>
          </section>
          <section
            className="routing-control-card"
            aria-labelledby="routing-rollout-heading"
          >
            <div>
              <p>Controlled rollout</p>
              <h2 id="routing-rollout-heading">
                Shadow first, enable with evidence
              </h2>
            </div>
            <div className="routing-actions">
              <button
                className="secondary-button"
                disabled={busy || !report?.sampleSize}
                onClick={() => setReviewOpen(true)}
              >
                Review evidence
              </button>
              <button
                className="secondary-button"
                disabled={busy || settings.rollout?.mode === "shadow"}
                onClick={() => rollout("shadow")}
              >
                Start shadow mode
              </button>
              <button
                className="primary-button"
                disabled={busy || !settings.review?.evaluationPassed}
                onClick={() => setEnableOpen(true)}
              >
                Enable production routing
              </button>
              <button
                className="connection-quiet-button danger-button"
                disabled={busy || settings.rollout?.mode === "disabled"}
                onClick={kill}
              >
                Activate kill switch
              </button>
            </div>
            {!settings.review?.evaluationPassed && (
              <p>
                Production remains off until a reviewed evidence record passes
                its evaluation thresholds.
              </p>
            )}
          </section>
        </>
      )}
      <section
        className="routing-control-card"
        aria-labelledby="routing-evidence-heading"
      >
        <div>
          <p>Shadow evidence</p>
          <h2 id="routing-evidence-heading">Enablement report</h2>
        </div>
        <div className="routing-metrics">
          <div>
            <span>Requests</span>
            <strong>{report?.sampleSize ?? 0}</strong>
          </div>
          <div>
            <span>Estimated savings</span>
            <strong>{money(report?.estimatedSavings, report?.currency)}</strong>
          </div>
          <div>
            <span>Fallback rate</span>
            <strong>
              {Number(report?.fallbackRate ?? 0).toLocaleString(undefined, {
                style: "percent",
                maximumFractionDigits: 1,
              })}
            </strong>
          </div>
          <div>
            <span>Error rate</span>
            <strong>
              {Number(report?.errorRate ?? 0).toLocaleString(undefined, {
                style: "percent",
                maximumFractionDigits: 1,
              })}
            </strong>
          </div>
          <div>
            <span>Regret / override</span>
            <strong>
              {Number(report?.regretRate ?? 0).toLocaleString(undefined, {
                style: "percent",
                maximumFractionDigits: 1,
              })}
            </strong>
          </div>
          <div>
            <span>Router overhead</span>
            <strong>
              {Number(report?.routerOverheadMs ?? 0).toFixed(2)} ms
            </strong>
          </div>
        </div>
        <div
          className="routing-decisions"
          role="region"
          aria-label="Recent routing decisions"
        >
          {report?.decisions?.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => openDecision(item.id)}
            >
              <span>
                {labels[item.selectedServiceClass] ?? item.selectedServiceClass}
              </span>
              <strong>{item.reasonCode.replaceAll("_", " ")}</strong>
              <small>
                {money(item.expectedCost, item.currency)} ·{" "}
                {item.outcome ?? "outcome pending"}
              </small>
            </button>
          ))}
        </div>
      </section>
      {enableOpen && (
        <div className="modal-backdrop">
          <section
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Enable production routing"
          >
            <p>Controlled rollout</p>
            <h2>Enable production routing?</h2>
            <p>
              Auto will replace the fixed route for this Team. The reviewed
              mapping and policy stay pinned, and the kill switch remains
              available.
            </p>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              I reviewed the shadow evidence and understand this changes the
              executed deployment.
            </label>
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setEnableOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!confirmed || busy}
                onClick={enable}
              >
                Enable Auto routing
              </button>
            </div>
          </section>
        </div>
      )}
      {reviewOpen && (
        <div className="modal-backdrop">
          <section
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Review routing evidence"
          >
            <p>Shadow evidence</p>
            <h2>Record administrator review</h2>
            <p>
              This immutable review records the current sample and rollout
              thresholds.
            </p>
            <label className="modal-field">
              <span>Review note</span>
              <textarea
                aria-label="Routing review note"
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={reviewPassed}
                onChange={(event) => setReviewPassed(event.target.checked)}
              />{" "}
              Evidence passed the configured evaluation threshold.
            </label>
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setReviewOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy || reviewNote.trim().length < 8}
                onClick={review}
              >
                Record review
              </button>
            </div>
          </section>
        </div>
      )}
      {detail && (
        <div className="modal-backdrop">
          <section
            className="modal-dialog routing-decision-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Routing decision details"
          >
            <p>Administrator evidence</p>
            <h2>Routing decision</h2>
            <dl>
              <div>
                <dt>Selected class</dt>
                <dd>
                  {labels[detail.selected_service_class] ??
                    detail.selected_service_class}
                </dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{String(detail.reason_code).replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Executed provider</dt>
                <dd>{detail.executed_provider}</dd>
              </div>
              <div>
                <dt>Provider model</dt>
                <dd>{detail.executed_model}</dd>
              </div>
              <div>
                <dt>Deployment</dt>
                <dd>{detail.executed_provider_deployment}</dd>
              </div>
              <div>
                <dt>Mapping version</dt>
                <dd>{detail.mapping_version_id}</dd>
              </div>
              <div>
                <dt>Rate card</dt>
                <dd>{detail.rate_card_id}</dd>
              </div>
            </dl>
            <h3>Candidate evidence</h3>
            <ul>
              {detail.candidates?.map((item) => (
                <li key={`${item.ordinal}-${item.deployment_id}`}>
                  {item.provider_deployment}: {item.eligibility}
                  {item.reason_code ? ` (${item.reason_code})` : ""}
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button
                className="primary-button"
                onClick={() => setDetail(null)}
              >
                Close details
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
