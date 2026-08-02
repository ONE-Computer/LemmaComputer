import { useEffect, useMemo, useState } from "react";
import { adminApi } from "./workspace-api.js";
import { ModalDialog } from "./ui.jsx";
import "./UsageDataHealth.css";

const monthRange = () => {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: from.toISOString(), to: to.toISOString(), limit: 1 };
};

export function UsageDataHealth({ onOpenPricing }) {
  const query = useMemo(monthRange, []);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;
    adminApi.spend(query)
      .then((value) => { if (active) setReport(value.report); })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [query, refreshVersion]);

  const pricing = report?.costCoverage?.unpricedUsage ?? {
    activeEventCount: 0,
    missingPriceEventCount: 0,
    partialPriceEventCount: 0,
    acknowledgedEventCount: 0,
  };
  const delayed = report?.costCoverage?.delayedReporting?.attemptCount ?? 0;
  const failedWithoutUsage = report?.costCoverage?.failedWithoutUsage?.attemptCount ?? 0;
  const acknowledgement = report?.costCoverage?.latestAcknowledgement ?? null;
  const healthy = report && pricing.activeEventCount === 0 && delayed === 0 && failedWithoutUsage === 0;
  const recordHistoricalReview = async () => {
    if (!report || reviewing) return;
    setReviewing(true);
    setError("");
    try {
      await adminApi.acknowledgeUnpricedUsage({ receivedBefore: report.asOf });
      setReviewOpen(false);
      setRefreshVersion((current) => current + 1);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setReviewing(false);
    }
  };

  return (
    <section className="usage-data-health" aria-labelledby="usage-data-health-heading">
      <header className="page-heading compact">
        <p>Administrator diagnostics</p>
        <h2 id="usage-data-health-heading">Usage data health</h2>
        <span>Review provider reporting and pricing issues here. These diagnostics do not change the spend figures shown elsewhere.</span>
      </header>
      {error && <div className="connection-error" role="alert"><span><strong>Usage data health unavailable</strong>{error}</span></div>}
      {!report && !error && <p className="usage-data-health-loading">Loading usage diagnostics…</p>}
      {healthy && <div className="usage-data-health-good" role="status"><strong>Usage data is current.</strong><span>No pricing gaps, delayed reports, or failed attempts without billable usage were found in this period.</span></div>}
      {report && <div className="usage-data-health-grid">
        <article>
          <span>Pricing review</span>
          <strong>{pricing.activeEventCount}</strong>
          <p>{pricing.missingPriceEventCount} missing rate · {pricing.partialPriceEventCount} partial rate</p>
          {pricing.activeEventCount > 0 && <div className="usage-data-health-actions">
            <button className="secondary-button" type="button" onClick={onOpenPricing}>Manage pricing</button>
            <button className="secondary-button" type="button" onClick={() => setReviewOpen(true)}>Record historical review</button>
          </div>}
        </article>
        <article>
          <span>Awaiting usage reports</span>
          <strong>{delayed}</strong>
          <p>Admitted attempts without a final provider usage record.</p>
        </article>
        <article>
          <span>Failed without usage</span>
          <strong>{failedWithoutUsage}</strong>
          <p>Provider failures with no billable usage reported. They are retained for audit and excluded from spend.</p>
        </article>
        <article>
          <span>Historical pricing baseline</span>
          <strong>{pricing.acknowledgedEventCount}</strong>
          <p>{acknowledgement ? `Acknowledged through ${new Date(acknowledgement.receivedBefore).toLocaleDateString()}.` : "No historical pricing baseline recorded."}</p>
        </article>
      </div>}
      {reviewOpen && report && <ModalDialog
        title="Record historical pricing review?"
        description={`Acknowledge pricing gaps received through ${new Date(report.asOf).toLocaleString()}.`}
        eyebrow="Usage data health"
        labelledBy="historical-pricing-review-title"
        onClose={reviewing ? () => undefined : () => setReviewOpen(false)}
      >
        <div className="usage-data-health-review-copy">
          <p>This records an auditable review baseline. It does not delete usage or change past spend totals.</p>
          <p>Pricing gaps received after this baseline remain visible for review.</p>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" type="button" disabled={reviewing} onClick={() => setReviewOpen(false)}>Cancel</button>
          <button className="primary-button" type="button" disabled={reviewing} onClick={recordHistoricalReview}>{reviewing ? "Recording…" : "Record review"}</button>
        </div>
      </ModalDialog>}
    </section>
  );
}
