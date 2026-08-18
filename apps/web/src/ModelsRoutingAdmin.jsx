import { useEffect, useMemo, useRef, useState } from "react";
import { Bot24Regular } from "@fluentui/react-icons/svg/bot";
import { CheckmarkCircle20Regular } from "@fluentui/react-icons/svg/checkmark-circle";
import { ChevronDown16Regular } from "@fluentui/react-icons/svg/chevron-down";
import { ChevronRight16Regular } from "@fluentui/react-icons/svg/chevron-right";
import { Dismiss24Regular } from "@fluentui/react-icons/svg/dismiss";
import { ErrorCircle20Regular } from "@fluentui/react-icons/svg/error-circle";
import { Info20Regular } from "@fluentui/react-icons/svg/info";
import { emissionsRegionOptions } from "./ai-emissions.js";
import {
  configuredProviderDeployments,
  latestRateCardForDeployment,
  providerDeploymentKey,
  providerModelCapabilityLabels,
  providerTitle,
  rateCardMatchesDeployment,
} from "./provider-inventory.js";
import {
  MappingEditor,
  PricingEditor,
  clearRouteDraft,
  datetimeLocalValue,
  hashPricingRecord,
  pricingCoverage,
  pricingUnits,
  rateLabel,
  readRouteDraft,
  serviceClassLabels,
  shortId,
  writeRouteDraft,
} from "./RoutingAdmin.jsx";
import { adminApi } from "./workspace-api.js";
import { ModalDialog, SelectMenu } from "./ui.jsx";
import "./ModelsRoutingAdmin.css";

const inferredBedrockEmissionsRegion = (region) => region === "ap-southeast-1" ? "sg" : region?.startsWith("us-") ? "us" : "";
const accountingRegionOptions = [{ value: "", label: "Choose an estimated serving grid" }, ...emissionsRegionOptions];
const bedrockRegionOptions = [
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore) · ap-southeast-1" },
  { value: "us-east-1", label: "US East (N. Virginia) · us-east-1" },
  { value: "us-west-2", label: "US West (Oregon) · us-west-2" },
  { value: "eu-west-1", label: "Europe (Ireland) · eu-west-1" },
];
const bedrockProfileOptions = [
  { value: "claude-sonnet-4-5-global", label: "Claude Sonnet 4.5 · Global inference profile" },
];
const routeClasses = ["lite", "balanced", "pro"];
const routeRank = { lite: 0, balanced: 1, pro: 2 };

const routeIsAssigned = (route) => Boolean(
  route?.provider
  && route?.providerAccountId
  && route?.providerModel?.trim()
  && route?.providerDeployment?.trim()
);

const organizationRouteReadiness = (routes, inventory, cardById) => routeClasses.map((serviceClass) => {
  const assignments = routes.filter((route) => route.serviceClass === serviceClass && routeIsAssigned(route));
  if (assignments.length !== 1) return { serviceClass, ready: false };
  const route = assignments[0];
  const enabled = inventory.some((deployment) => providerDeploymentKey(deployment) === providerDeploymentKey(route));
  return { serviceClass, ready: enabled && pricingCoverage(cardById.get(route.rateCardId)).complete };
});

const displayDate = (value) => value ? new Date(value).toLocaleString() : "Not tested";
const providerStateLabel = (state) => ({
  active: "Connected",
  disabled: "Disabled",
  "needs-reconfiguration": "Needs reconfiguration",
  "not-configured": "Not connected",
}[state] ?? "Not connected");

function ProviderEditor({ provider, busy, onClose, onSave }) {
  const [apiKey, setApiKey] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState(() => provider.selectedModelIds?.length
    ? provider.selectedModelIds
    : provider.modelId
      ? [provider.modelId]
      : provider.modelOptions?.[0]?.id
        ? [provider.modelOptions[0].id]
        : []);
  const [region, setRegion] = useState(provider.region ?? "ap-southeast-1");
  const [emissionsRegion, setEmissionsRegion] = useState(provider.emissionsRegion ?? (provider.provider === "bedrock" ? inferredBedrockEmissionsRegion(provider.region ?? "ap-southeast-1") : ""));
  const [modelProfileId, setModelProfileId] = useState(provider.modelProfileId ?? "claude-sonnet-4-5-global");
  const toggleModel = (modelId, selected) => setSelectedModelIds((current) => selected
    ? [...new Set([...current, modelId])]
    : current.filter((id) => id !== modelId));
  const submit = async () => {
    const key = apiKey.trim();
    if (!key || !emissionsRegion || (provider.provider !== "bedrock" && !selectedModelIds.length)) return;
    const input = provider.provider === "bedrock"
      ? { apiKey: key, region, modelProfileId, emissionsRegion }
      : { apiKey: key, modelIds: selectedModelIds, emissionsRegion };
    if (await onSave(provider.provider, input)) onClose();
  };
  return <ModalDialog
    title={`${provider.state === "active" ? "Manage" : "Connect"} ${providerTitle(provider.provider)}`}
    description={provider.provider === "bedrock" ? "Choose an approved Bedrock region and inference profile. The API key remains write-only." : "One provider account key is shared by every enabled model. Choose the approved models this organization may use."}
    eyebrow="Provider account"
    labelledBy="provider-account-editor-title"
    onClose={busy ? () => undefined : onClose}
  >
    {provider.modelOptions?.length > 0 && <fieldset className="provider-model-options">
      <legend>Enabled models</legend>
      <span>Enable any approved model now; pricing can be added before it is assigned to a route.</span>
      {provider.modelOptions.map((option) => <label key={option.id}>
        <input type="checkbox" checked={selectedModelIds.includes(option.id)} disabled={busy} onChange={(event) => toggleModel(option.id, event.target.checked)} />
        <span><strong>{option.displayName}</strong><small>{option.id}</small>{providerModelCapabilityLabels(option.modelCapabilities).length > 0 && <small className="provider-model-capabilities">{providerModelCapabilityLabels(option.modelCapabilities).join(" · ")}</small>}</span>
      </label>)}
    </fieldset>}
    {provider.provider === "bedrock" && <>
      <label className="modal-field"><span>Approved region</span><SelectMenu value={region} options={bedrockRegionOptions} ariaLabel="Approved Bedrock region" disabled={busy || provider.state === "active"} onValueChange={setRegion} /></label>
      <label className="modal-field"><span>Approved inference profile</span><SelectMenu value={modelProfileId} options={bedrockProfileOptions} ariaLabel="Approved Bedrock inference profile" disabled={busy || provider.state === "active"} onValueChange={setModelProfileId} /></label>
    </>}
    <label className="modal-field"><span>Estimated serving grid</span><SelectMenu value={emissionsRegion} options={accountingRegionOptions} ariaLabel="Estimated serving grid for emissions" disabled={busy} onValueChange={setEmissionsRegion} /><small>Accounting assumption only; this does not control the provider's inference location.</small></label>
    <label className="modal-field"><span>{providerTitle(provider.provider)} API key</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste the provider API key" disabled={busy} /></label>
    <div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" type="button" disabled={busy || !apiKey.trim() || !emissionsRegion || (provider.provider !== "bedrock" && !selectedModelIds.length)} onClick={submit}>{busy ? "Validating" : provider.state === "active" ? "Apply changes" : "Connect account"}</button></div>
  </ModalDialog>;
}

function HistoryDialog({ kind, deployment, rateCards, mapping, onClose }) {
  const cards = rateCards.filter((card) => rateCardMatchesDeployment(card, deployment));
  const route = mapping?.deployments?.find((candidate) => providerDeploymentKey(candidate) === providerDeploymentKey(deployment));
  return <ModalDialog
    title={kind === "pricing" ? "Pricing history" : "Published route"}
    description={kind === "pricing" ? `Immutable price versions for ${deployment.displayName}.` : `The latest published organization route using ${deployment.displayName}.`}
    eyebrow={kind === "pricing" ? "Rate cards" : "Organization route"}
    labelledBy="model-history-title"
    onClose={onClose}
  >
    <div className="model-history-list">
      {kind === "pricing" ? cards.length ? cards.map((card) => <article key={card.id}><div><strong>{card.sourceVersion}</strong><span>{card.currency} · effective {new Date(card.effectiveFrom).toLocaleDateString()}</span></div><small>{rateLabel(card, "input_uncached_token")} input · {rateLabel(card, "output_token")} output / 1M</small></article>) : <p>No price versions have been created for this model.</p>
        : route ? <article><div><strong>{serviceClassLabels[route.serviceClass]} route</strong><span>{mapping.revisionNote}</span></div><small>Published {new Date(mapping.createdAt).toLocaleString()} · {shortId(mapping.id)}</small></article> : <p>This model is not used by the latest published route version.</p>}
    </div>
  </ModalDialog>;
}

export function ModelsRoutingAdmin({
  providers,
  providerLoading,
  providerBusy,
  providerError,
  canManageProviders,
  canManageRouting,
  canManagePricing,
  focus,
  draftScope,
  onSaveProvider,
  onTestProvider,
  onDisableProvider,
}) {
  const [rateCards, setRateCards] = useState([]);
  const [mapping, setMapping] = useState(null);
  const [draft, setDraft] = useState(() => readRouteDraft(draftScope));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [providerEditor, setProviderEditor] = useState(null);
  const [priceEditor, setPriceEditor] = useState(null);
  const [mappingEditor, setMappingEditor] = useState(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [history, setHistory] = useState(null);
  const focusApplied = useRef(false);

  const inventory = useMemo(() => configuredProviderDeployments(providers), [providers]);
  const cardById = useMemo(() => new Map(rateCards.map((card) => [card.id, card])), [rateCards]);
  const effectiveRoutes = useMemo(() => [...(draft?.deployments ?? mapping?.deployments ?? [])].sort((left, right) => (routeRank[left.serviceClass] ?? 9) - (routeRank[right.serviceClass] ?? 9)), [draft, mapping]);
  const routeByDeployment = useMemo(() => new Map(effectiveRoutes.map((route) => [providerDeploymentKey(route), route])), [effectiveRoutes]);
  const selected = inventory.find((deployment) => deployment.id === selectedId) ?? inventory[0] ?? null;
  const selectedProvider = selected ? providers.find((provider) => provider.provider === selected.provider) : null;
  const selectedRoute = selected ? routeByDeployment.get(providerDeploymentKey(selected)) : null;
  const selectedCard = selected ? cardById.get(selectedRoute?.rateCardId) ?? latestRateCardForDeployment(rateCards, selected) : null;
  const selectedCoverage = pricingCoverage(selectedCard);
  const routeReadiness = useMemo(() => organizationRouteReadiness(effectiveRoutes, inventory, cardById), [cardById, effectiveRoutes, inventory]);
  const readyRoutes = routeReadiness.filter((route) => route.ready).length;
  const issueCount = routeClasses.length - readyRoutes;
  const routesReadyToPublish = routeReadiness.every((route) => route.ready);

  useEffect(() => {
    Promise.all([adminApi.rateCards(), adminApi.latestRoutingMapping()])
      .then(([rateResult, mappingResult]) => {
        setRateCards(rateResult.rateCards ?? []);
        setMapping(mappingResult.mapping ?? null);
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (selectedId && inventory.some((deployment) => deployment.id === selectedId)) return;
    setSelectedId(inventory[0]?.id ?? "");
  }, [inventory, selectedId]);

  useEffect(() => {
    if (focusApplied.current || loading || providerLoading || !inventory.length) return;
    const target = focus === "pricing"
      ? inventory.find((deployment) => !pricingCoverage(latestRateCardForDeployment(rateCards, deployment)).complete)
      : focus === "route"
        ? inventory.find((deployment) => !routeByDeployment.has(providerDeploymentKey(deployment)))
        : null;
    if (target) setSelectedId(target.id);
    focusApplied.current = true;
  }, [focus, inventory, loading, providerLoading, rateCards, routeByDeployment]);

  const toggleProvider = (provider) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    return next;
  });
  const draftableDeployments = () => {
    const source = routeClasses.map((serviceClass) => effectiveRoutes.find((route) => route.serviceClass === serviceClass) ?? {
      id: `draft-${serviceClass}`,
      serviceClass,
      provider: "",
      providerAccountId: "",
      providerModel: "",
      providerDeployment: "",
      rateCardId: "",
    });
    return source.map((deployment) => {
      const model = inventory.find((candidate) => providerDeploymentKey(candidate) === providerDeploymentKey(deployment));
      const normalized = model ? { ...deployment, ...model, id: deployment.id } : deployment;
      const card = routeIsAssigned(normalized) ? cardById.get(normalized.rateCardId) ?? latestRateCardForDeployment(rateCards, normalized) : null;
      return {
        ...normalized,
        rateCardId: normalized.rateCardId ?? card?.id ?? "",
        capabilities: {
          vision: normalized.modelCapabilities?.vision ?? normalized.capabilities?.vision ?? false,
          tools: normalized.modelCapabilities?.tools ?? normalized.capabilities?.tools ?? true,
          streaming: normalized.modelCapabilities?.streaming ?? normalized.capabilities?.streaming ?? true,
          contextTokens: normalized.capabilities?.contextTokens ?? 32000,
          outputTokens: normalized.capabilities?.outputTokens ?? 32768,
          residency: normalized.capabilities?.residency ?? (normalized.region ? [normalized.region] : []),
        },
        approved: normalized.approved ?? true,
        evaluationPassed: normalized.evaluationPassed ?? true,
      };
    });
  };
  const openMappingEditor = () => setMappingEditor({ revisionNote: draft?.revisionNote ?? "", deployments: draftableDeployments() });
  const saveMappingDraft = () => {
    const next = { revisionNote: mappingEditor.revisionNote.trim(), deployments: mappingEditor.deployments.filter(routeIsAssigned) };
    setDraft(next);
    writeRouteDraft(draftScope, next);
    setMappingEditor(null);
    setNotice("Draft saved. Review and publish it when the organization routes are ready.");
  };
  const mappingInput = (value) => ({
    revisionNote: value.revisionNote,
    deployments: value.deployments.filter(routeIsAssigned).map((deployment) => ({
      serviceClass: deployment.serviceClass,
      provider: deployment.provider,
      ...(deployment.providerAccountId?.trim() ? { providerAccountId: deployment.providerAccountId.trim() } : {}),
      providerModel: deployment.providerModel.trim(),
      providerDeployment: deployment.providerDeployment.trim(),
      ...(deployment.region ? { region: deployment.region } : {}),
      ...(deployment.providerServiceTier ? { providerServiceTier: deployment.providerServiceTier } : {}),
      ...(deployment.rateCardId ? { rateCardId: deployment.rateCardId } : {}),
      capabilities: deployment.capabilities,
      approved: deployment.approved,
      evaluationPassed: deployment.evaluationPassed,
    })),
  });
  const publishMapping = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const result = await adminApi.createRoutingMapping(mappingInput(draft));
      setMapping(result.mapping);
      setDraft(null);
      clearRouteDraft(draftScope);
      setPublishOpen(false);
      setNotice("Organization route version published. Existing Team overrides remain unchanged.");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };
  const openPricing = (deployment) => {
    const route = routeByDeployment.get(providerDeploymentKey(deployment));
    const card = cardById.get(route?.rateCardId) ?? latestRateCardForDeployment(rateCards, deployment);
    setPriceEditor({
      deployment: { ...deployment, ...(route?.serviceClass ? { serviceClass: route.serviceClass } : {}) },
      providerAccountId: deployment.providerAccountId,
      currency: card?.currency ?? "USD",
      sourceVersion: `manual-${new Date().toISOString().slice(0, 10)}`,
      effectiveFrom: datetimeLocalValue(),
      overrideReason: "",
      prices: Object.fromEntries(pricingUnits.map((item) => [item.key, card ? String(Number(card.rates?.find((rate) => rate.unit === item.key)?.amountPerUnit ?? 0) * 1_000_000 / Number(card.rates?.find((rate) => rate.unit === item.key)?.unitScale ?? 1_000_000)) : ""])),
    });
  };
  const createPriceRecord = async () => {
    const record = {
      provider: priceEditor.deployment.provider,
      providerAccountId: priceEditor.providerAccountId.trim(),
      baseModel: priceEditor.deployment.providerModel,
      deploymentId: priceEditor.deployment.providerDeployment,
      ...(priceEditor.deployment.region ? { region: priceEditor.deployment.region } : {}),
      ...(priceEditor.deployment.providerServiceTier ? { providerServiceTier: priceEditor.deployment.providerServiceTier } : {}),
      currency: priceEditor.currency.trim().toUpperCase(),
      source: "contract_override",
      sourceVersion: priceEditor.sourceVersion.trim(),
      effectiveFrom: new Date(priceEditor.effectiveFrom).toISOString(),
      overrideReason: priceEditor.overrideReason.trim(),
      rates: pricingUnits.filter((item) => priceEditor.prices[item.key] !== "").map((item) => ({ unit: item.key, amountPerUnit: String(priceEditor.prices[item.key]), unitScale: "1000000" })),
    };
    setBusy(true);
    setError("");
    try {
      const sourceHash = await hashPricingRecord(record);
      const created = await adminApi.createRateCard({ ...record, sourceHash });
      const refreshed = await adminApi.rateCards();
      setRateCards(refreshed.rateCards ?? []);
      const source = draft?.deployments ?? mapping?.deployments;
      if (source?.length) {
        const selectedKey = providerDeploymentKey(priceEditor.deployment);
        const next = {
          revisionNote: draft?.revisionNote ?? `Update ${priceEditor.deployment.displayName} pricing`,
          deployments: source.map((route) => providerDeploymentKey(route) === selectedKey ? { ...route, rateCardId: created.id } : route),
        };
        setDraft(next);
        writeRouteDraft(draftScope, next);
      }
      setPriceEditor(null);
      setNotice(`Price version ${shortId(created.id)} created${source?.length ? " and added to the draft" : ""}.`);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="models-routing-screen">
    <header className="models-routing-heading">
      <div><p>Models & routing</p><h2>Models & routing</h2><span>Enable approved models and maintain how they are priced and routed across your organization.</span></div>
      <div className="models-routing-version"><span>{mapping?.id ? `Published ${shortId(mapping.id)}` : "No published version"}{draft ? " · 1 draft change" : ""}</span>{canManageRouting && <button className="secondary-button" type="button" disabled={busy || !draft} onClick={() => setPublishOpen(true)}>Review & publish</button>}</div>
    </header>
    {(error || providerError) && <div className="workspace-error" role="alert"><span><strong>Models and routing unavailable</strong>{error || providerError}</span></div>}
    {notice && <div className="models-routing-notice" role="status"><CheckmarkCircle20Regular aria-hidden="true" /><span>{notice}</span></div>}
    {focus && <div className="models-routing-focus" role="note"><Info20Regular aria-hidden="true" /><span><strong>{focus === "provider" ? "Connect a provider account" : focus === "pricing" ? "Complete model pricing" : "Complete the organization route"}</strong>{focus === "provider" ? "Use one provider API key across every enabled model from that provider." : focus === "pricing" ? "The first enabled model missing complete pricing is selected. Add its required rates before routing it." : "The first unassigned model is selected. Assign priced models to the Lite, Balanced, and Pro organization defaults."}</span></div>}
    <div className="models-routing-layout">
      <main className="models-routing-main">
        <section className="models-routing-readiness" aria-label="Organization route readiness"><CheckmarkCircle20Regular aria-hidden="true" /><strong>{readyRoutes} of 3 routes ready</strong><span>{issueCount ? `${issueCount} organization route${issueCount === 1 ? "" : "s"} still need an assigned model with complete pricing` : "All organization routes are ready"}</span></section>
        <div className="models-routing-columns" aria-hidden="true"><span>Provider / model</span><span>Pricing (per 1M tokens)</span><span>Route use (org default)</span><span>Status</span></div>
        <section className="models-routing-inventory" aria-label="Provider accounts and enabled models">
          {(providerLoading || loading) && <p className="models-routing-empty">Loading provider accounts and routes…</p>}
          {!providerLoading && providers.map((provider) => {
            const deployments = inventory.filter((deployment) => deployment.provider === provider.provider);
            const isCollapsed = collapsed.has(provider.provider);
            return <article className="models-routing-provider" key={provider.provider}>
              <header>
                <button className="models-routing-expand" type="button" aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${providerTitle(provider.provider)}`} onClick={() => toggleProvider(provider.provider)}>{isCollapsed ? <ChevronRight16Regular aria-hidden="true" /> : <ChevronDown16Regular aria-hidden="true" />}</button>
                <span className="models-routing-provider-icon"><Bot24Regular aria-hidden="true" /></span>
                <div><strong>{providerTitle(provider.provider)}</strong><span className={`models-routing-provider-state ${provider.state}`}>{provider.state === "active" && <CheckmarkCircle20Regular aria-hidden="true" />}{providerStateLabel(provider.state)}</span><small>{provider.state === "active" ? `Last tested ${displayDate(provider.lastTestedAt)}` : "One API key is shared across every enabled model."}</small></div>
                {canManageProviders && <button className="models-routing-text-action" type="button" disabled={providerBusy || provider.state === "needs-reconfiguration"} onClick={() => setProviderEditor(provider)}>{provider.state === "active" ? "Manage account" : "Connect account"}</button>}
              </header>
              {!isCollapsed && deployments.map((deployment) => {
                const route = routeByDeployment.get(providerDeploymentKey(deployment));
                const card = cardById.get(route?.rateCardId) ?? latestRateCardForDeployment(rateCards, deployment);
                const coverage = pricingCoverage(card);
                const selectedRow = selected?.id === deployment.id;
                return <button className={`models-routing-row${selectedRow ? " selected" : ""}`} type="button" key={deployment.id} onClick={() => setSelectedId(deployment.id)}>
                  <span className="models-routing-row-name"><strong>{deployment.displayName}</strong><small>{deployment.providerModel}</small></span>
                  <span className={coverage.complete ? "" : "models-routing-gap"}>{card ? `${rateLabel(card, "input_uncached_token")} / ${rateLabel(card, "output_token")}` : "Pricing missing"}</span>
                  <span>{route ? serviceClassLabels[route.serviceClass] : "Not assigned"}</span>
                  <span className={coverage.complete && route ? "models-routing-ready" : "models-routing-gap"}>{coverage.complete && route ? <><CheckmarkCircle20Regular aria-hidden="true" />Routable</> : <><ErrorCircle20Regular aria-hidden="true" />Not routable</>}</span>
                </button>;
              })}
              {!isCollapsed && provider.state === "active" && !deployments.length && <p className="models-routing-empty">No models are enabled for this account.</p>}
            </article>;
          })}
        </section>
      </main>
      <aside className="models-routing-inspector" aria-label="Model details">
        {selected ? <>
          <header><div><span>{providerTitle(selected.provider)}</span><strong>{selected.displayName}</strong><small>Model</small></div><button type="button" aria-label="Close model details" onClick={() => setSelectedId("")}><Dismiss24Regular aria-hidden="true" /></button></header>
          <div className="models-routing-model-id"><span>Model ID (LemmaComputer)</span><strong>{selected.id}</strong></div>
          <section><div className="models-routing-inspector-title"><strong>Availability</strong>{canManageProviders && selectedProvider && <button type="button" onClick={() => setProviderEditor(selectedProvider)}>Edit</button>}</div><span className="models-routing-ready"><CheckmarkCircle20Regular aria-hidden="true" />Enabled</span><p>This approved model is enabled for your organization.</p></section>
          <section><div className="models-routing-inspector-title"><strong>Pricing</strong><Info20Regular aria-hidden="true" /></div>{selectedCoverage.complete ? <span className="models-routing-ready"><CheckmarkCircle20Regular aria-hidden="true" />{rateLabel(selectedCard, "input_uncached_token")} input · {rateLabel(selectedCard, "output_token")} output</span> : <span className="models-routing-gap"><ErrorCircle20Regular aria-hidden="true" />Pricing missing</span>}<p>{selectedCoverage.complete ? "Current immutable rates shown per 1M tokens." : "Add input, output, cache-read, and cache-write prices to make this model routable."}</p>{canManagePricing && <button className="secondary-button" type="button" onClick={() => openPricing(selected)}>{selectedCard ? "Add price version" : "Add pricing"}</button>}<button className="models-routing-inline-link" type="button" onClick={() => setHistory({ kind: "pricing", deployment: selected })}>View pricing history</button></section>
          <section><div className="models-routing-inspector-title"><strong>Organization route</strong><Info20Regular aria-hidden="true" /></div>{selectedRoute ? <span className={selectedCoverage.complete ? "models-routing-ready" : "models-routing-gap"}>{selectedCoverage.complete ? <CheckmarkCircle20Regular aria-hidden="true" /> : <ErrorCircle20Regular aria-hidden="true" />}{serviceClassLabels[selectedRoute.serviceClass]}</span> : <span className="models-routing-gap"><ErrorCircle20Regular aria-hidden="true" />Not assigned</span>}<p>{selectedCoverage.complete ? "Assign this model to Lite, Balanced, or Pro in the organization route draft." : "Pricing must exist before a route using this model can be published."}</p>{canManageRouting && <button className="secondary-button" type="button" disabled={!inventory.length} onClick={openMappingEditor}>{selectedRoute ? "Change route" : "Assign route"}</button>}<button className="models-routing-inline-link" type="button" onClick={() => setHistory({ kind: "routes", deployment: selected })}>View route versions</button></section>
          <section><div className="models-routing-inspector-title"><strong>Health</strong></div><p>Test the shared provider account connection for this model.</p>{canManageProviders && selectedProvider?.state === "active" && <button className="secondary-button" type="button" disabled={providerBusy} onClick={() => onTestProvider(selected.provider)}>Test model</button>}<small>Last tested {displayDate(selectedProvider?.lastTestedAt)}</small></section>
        </> : <div className="models-routing-inspector-empty"><Info20Regular aria-hidden="true" /><strong>Select an enabled model</strong><span>Pricing, organization route use, and health appear here.</span></div>}
      </aside>
    </div>
    {providerEditor && <ProviderEditor provider={providerEditor} busy={providerBusy} onClose={() => setProviderEditor(null)} onSave={onSaveProvider} />}
    {priceEditor && <PricingEditor editor={priceEditor} busy={busy} onChange={setPriceEditor} onClose={() => setPriceEditor(null)} onCreate={createPriceRecord} />}
    {mappingEditor && <MappingEditor editor={mappingEditor} inventory={inventory} rateCards={rateCards} busy={busy} onChange={setMappingEditor} onClose={() => setMappingEditor(null)} onSave={saveMappingDraft} />}
    {publishOpen && <ModalDialog title="Publish organization routes?" description="This publishes an immutable route version. Team overrides remain pinned until they are changed separately." eyebrow="Models & routing" labelledBy="models-routing-publish-title" onClose={busy ? () => undefined : () => setPublishOpen(false)}><div className="route-editor-warning"><Info20Regular aria-hidden="true" /><span>Every route in this version must point to an enabled model with complete pricing.</span></div><div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setPublishOpen(false)}>Cancel</button><button className="primary-button" type="button" disabled={busy || !routesReadyToPublish} onClick={publishMapping}>{busy ? "Publishing…" : "Publish route version"}</button></div></ModalDialog>}
    {history && <HistoryDialog kind={history.kind} deployment={history.deployment} rateCards={rateCards} mapping={mapping} onClose={() => setHistory(null)} />}
  </div>;
}
