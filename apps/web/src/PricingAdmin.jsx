import { useEffect, useMemo, useState } from "react";
import { CheckmarkCircle20Regular } from "@fluentui/react-icons/svg/checkmark-circle";
import { ErrorCircle20Regular } from "@fluentui/react-icons/svg/error-circle";
import { Info20Regular } from "@fluentui/react-icons/svg/info";
import { adminApi } from "./workspace-api.js";
import { ModalDialog, SelectMenu } from "./ui.jsx";
import {
  configuredProviderDeployments,
  latestRateCardForDeployment,
  providerDeploymentLabel,
  providerTitle,
} from "./provider-inventory.js";
import "./PricingAdmin.css";

const pricingUnits = [
  { key: "input_uncached_token", label: "Input" },
  { key: "output_token", label: "Output" },
  { key: "cache_read_token", label: "Cache read" },
  { key: "cache_write_token", label: "Cache write" },
];
const shortId = (value) => value ? `${String(value).slice(0, 8)}…${String(value).slice(-4)}` : "Not available";
const datetimeLocalValue = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};
const ratePerMillion = (card, unit) => {
  const rate = card?.rates?.find((item) => item.unit === unit);
  if (!rate) return null;
  return Number(rate.amountPerUnit) * 1_000_000 / Number(rate.unitScale);
};
const rateLabel = (card, unit) => {
  const amount = ratePerMillion(card, unit);
  if (amount == null || !Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: card.currency,
    minimumFractionDigits: amount < 1 ? 3 : 2,
    maximumFractionDigits: amount < 1 ? 4 : 2,
  }).format(amount);
};
const coverageFor = (card) => {
  const missing = pricingUnits.filter((item) => ratePerMillion(card, item.key) == null);
  return { complete: Boolean(card) && missing.length === 0, missing };
};
const hashRecord = async (record) => {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
};

const editorFor = (deployment, rateCards) => {
  const card = latestRateCardForDeployment(rateCards, deployment);
  return {
    deployment,
    currency: card?.currency ?? "USD",
    sourceVersion: `manual-${new Date().toISOString().slice(0, 10)}`,
    effectiveFrom: datetimeLocalValue(),
    overrideReason: "",
    prices: Object.fromEntries(pricingUnits.map((item) => [item.key, ratePerMillion(card, item.key)?.toString() ?? ""])),
  };
};

function PriceVersionEditor({ editor, inventory, rateCards, busy, onChange, onClose, onCreate }) {
  const updateRate = (key, value) => onChange({ ...editor, prices: { ...editor.prices, [key]: value } });
  const selectDeployment = (id) => {
    const deployment = inventory.find((item) => item.id === id);
    if (deployment) onChange(editorFor(deployment, rateCards));
  };
  const canCreate = editor.sourceVersion.trim()
    && editor.overrideReason.trim()
    && editor.currency.trim().length === 3
    && editor.prices.input_uncached_token !== ""
    && editor.prices.output_token !== "";
  return <ModalDialog
    title="Create price version"
    description="Publish an immutable rate card for one configured provider deployment. Existing usage records keep the price snapshot captured when they ran."
    eyebrow="Pricing"
    labelledBy="pricing-editor-title"
    onClose={busy ? () => undefined : onClose}
    className="pricing-editor"
  >
    <label className="modal-field"><span>Provider deployment</span><SelectMenu ariaLabel="Price provider deployment" value={editor.deployment.id} options={inventory.map((deployment) => ({ value: deployment.id, label: providerDeploymentLabel(deployment) }))} disabled={busy} onValueChange={selectDeployment} /></label>
    <div className="pricing-target" role="note"><div><span>{providerTitle(editor.deployment.provider)}</span><strong>{editor.deployment.displayName}</strong><small>{editor.deployment.providerDeployment}</small></div><div><span>Provider account</span><strong>{editor.deployment.providerAccountId}</strong><small>{editor.deployment.region ?? "Global"}{editor.deployment.providerServiceTier ? ` · ${editor.deployment.providerServiceTier}` : ""}</small></div></div>
    <div className="pricing-form-grid">
      <label className="modal-field"><span>Currency</span><input aria-label="Pricing currency" value={editor.currency} maxLength={3} disabled={busy} onChange={(event) => onChange({ ...editor, currency: event.target.value.toUpperCase() })} /></label>
      <label className="modal-field"><span>Version label</span><input aria-label="Price version label" value={editor.sourceVersion} disabled={busy} onChange={(event) => onChange({ ...editor, sourceVersion: event.target.value })} /></label>
      {pricingUnits.map((item) => <label className="modal-field" key={item.key}><span>{item.label} / 1M tokens{item.key.startsWith("cache") ? " (optional)" : ""}</span><input aria-label={`${item.label} price per 1M tokens`} type="number" min="0" step="0.0001" value={editor.prices[item.key]} disabled={busy} onChange={(event) => updateRate(item.key, event.target.value)} /></label>)}
      <label className="modal-field"><span>Effective from</span><input aria-label="Price effective from" type="datetime-local" value={editor.effectiveFrom} disabled={busy} onChange={(event) => onChange({ ...editor, effectiveFrom: event.target.value })} /></label>
      <label className="modal-field pricing-reason"><span>Approval reason</span><textarea aria-label="Price approval reason" value={editor.overrideReason} disabled={busy} onChange={(event) => onChange({ ...editor, overrideReason: event.target.value })} /></label>
    </div>
    <div className="pricing-warning"><Info20Regular aria-hidden="true" /><span>This price version is independent of routing. A routing mapping must explicitly pin it before using it for governed route evaluation.</span></div>
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={busy || !canCreate} onClick={onCreate}>{busy ? "Creating…" : "Create immutable price"}</button></div>
  </ModalDialog>;
}

export function PricingAdmin({ onBack }) {
  const [providers, setProviders] = useState([]);
  const [rateCards, setRateCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState(null);
  const inventory = useMemo(() => configuredProviderDeployments(providers), [providers]);
  const rows = useMemo(() => inventory.map((deployment) => ({
    deployment,
    card: latestRateCardForDeployment(rateCards, deployment),
  })), [inventory, rateCards]);
  const completeCount = rows.filter((row) => coverageFor(row.card).complete).length;
  const currencies = new Set(rows.map((row) => row.card?.currency).filter(Boolean));

  useEffect(() => {
    Promise.all([adminApi.providerSettings(), adminApi.rateCards()])
      .then(([providerResult, rateResult]) => {
        setProviders(providerResult.providers ?? []);
        setRateCards(rateResult.rateCards ?? []);
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false));
  }, []);

  const openEditor = (deployment = inventory[0]) => {
    if (deployment) setEditor(editorFor(deployment, rateCards));
  };
  const createPrice = async () => {
    const record = {
      provider: editor.deployment.provider,
      providerAccountId: editor.deployment.providerAccountId,
      baseModel: editor.deployment.providerModel,
      deploymentId: editor.deployment.providerDeployment,
      ...(editor.deployment.region ? { region: editor.deployment.region } : {}),
      ...(editor.deployment.providerServiceTier ? { providerServiceTier: editor.deployment.providerServiceTier } : {}),
      currency: editor.currency.trim().toUpperCase(),
      source: "contract_override",
      sourceVersion: editor.sourceVersion.trim(),
      effectiveFrom: new Date(editor.effectiveFrom).toISOString(),
      overrideReason: editor.overrideReason.trim(),
      rates: pricingUnits.filter((item) => editor.prices[item.key] !== "").map((item) => ({ unit: item.key, amountPerUnit: String(editor.prices[item.key]), unitScale: "1000000" })),
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const sourceHash = await hashRecord(record);
      const created = await adminApi.createRateCard({ ...record, sourceHash });
      const refreshed = await adminApi.rateCards();
      setRateCards(refreshed.rateCards ?? []);
      setEditor(null);
      setNotice(`Price version ${shortId(created.id)} created for ${editor.deployment.displayName}. It is available to new usage and future routing mappings.`);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const PageTitle = onBack ? "h1" : "h2";
  return <div className="secondary-screen pricing-admin-screen">
    {onBack && <button className="settings-back-button" type="button" onClick={onBack}>← Back to AI control</button>}
    <header className="page-heading pricing-page-heading"><div><p>Rate cards</p><PageTitle>Pricing</PageTitle><span>Define immutable token prices directly on configured provider deployments, independently of model routing.</span></div><button className="primary-button" type="button" disabled={loading || busy || !inventory.length} onClick={() => openEditor()}>Add price version</button></header>
    {error && <div className="workspace-error" role="alert"><span><strong>Pricing unavailable</strong>{error}</span></div>}
    {notice && <div className="pricing-success" role="status"><CheckmarkCircle20Regular aria-hidden="true" /><span>{notice}</span></div>}

    <section className="pricing-summary" aria-label="Pricing summary"><article><span>Configured deployments</span><strong>{inventory.length}</strong><small>Available from Models & providers</small></article><article><span>Complete price coverage</span><strong>{inventory.length ? `${completeCount}/${inventory.length}` : "—"}</strong><small>Input, output, cache read, cache write</small></article><article><span>Immutable versions</span><strong>{rateCards.length}</strong><small>Historical evidence remains queryable</small></article><article><span>Currencies</span><strong>{currencies.size || "—"}</strong><small>{currencies.size ? [...currencies].join(", ") : "No priced deployments"}</small></article></section>

    <section className="pricing-table-card" aria-labelledby="pricing-table-heading"><div className="pricing-section-heading"><div><p>Provider inventory</p><h2 id="pricing-table-heading">Deployment rate cards</h2><span>Amounts are shown per 1M tokens. Cache dimensions stay explicit instead of being folded into input price.</span></div></div>
      {rows.length ? <div className="pricing-table-scroll"><table className="pricing-table"><thead><tr><th>Provider deployment</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Coverage</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{rows.map(({ deployment, card }) => {
        const coverage = coverageFor(card);
        return <tr key={deployment.id}><td><strong>{deployment.displayName}</strong><small>{providerTitle(deployment.provider)} · {deployment.providerDeployment}</small></td>{pricingUnits.map((item) => <td key={item.key}><span className={ratePerMillion(card, item.key) == null ? "pricing-missing" : ""}>{rateLabel(card, item.key)}</span></td>)}<td>{coverage.complete ? <span className="pricing-coverage complete"><CheckmarkCircle20Regular aria-hidden="true" />Complete</span> : <span className="pricing-coverage gap"><ErrorCircle20Regular aria-hidden="true" />{card ? `${coverage.missing.length} gap${coverage.missing.length === 1 ? "" : "s"}` : "Not priced"}</span>}<small>{card?.sourceVersion ?? "No rate card"}</small></td><td><button type="button" className="pricing-text-button" onClick={() => openEditor(deployment)}>{card ? "New version" : "Set pricing"}</button></td></tr>;
      })}</tbody></table></div> : !loading && <div className="pricing-empty"><Info20Regular aria-hidden="true" /><div><strong>No configured provider deployments</strong><span>Connect a provider and select at least one model before creating prices.</span></div><a className="secondary-button" href="?view=ai-control-plane&section=models-providers">Open Models & providers</a></div>}
    </section>
    {editor && <PriceVersionEditor editor={editor} inventory={inventory} rateCards={rateCards} busy={busy} onChange={setEditor} onClose={() => setEditor(null)} onCreate={createPrice} />}
  </div>;
}
