import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowSync20Regular } from "@fluentui/react-icons/svg/arrow-sync";
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

function ProviderEditor({ provider, busy, onClose, onSave, onDelete }) {
  const [apiKey, setApiKey] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState(provider.selectedModelIds?.length ? provider.selectedModelIds : provider.modelId ? [provider.modelId] : []);
  const [foundry, setFoundry] = useState(provider.foundry ?? { endpoint: "", deployments: {}, protocols: {} });
  const [vertex, setVertex] = useState(provider.vertex ?? { authMethod: "api-key", location: "global" });
  const googleApiKey = provider.provider === "vertex" && vertex.authMethod === "api-key";
  const credentialField = provider.provider === "vertex" && !googleApiKey ? "serviceAccountJson" : "apiKey";
  const [region, setRegion] = useState(provider.region ?? "ap-southeast-1");
  const [emissionsRegion, setEmissionsRegion] = useState(provider.emissionsRegion ?? (provider.provider === "bedrock" ? inferredBedrockEmissionsRegion(region) : ""));
  const [catalog, setCatalog] = useState(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [search, setSearch] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState("all");
  const [customId, setCustomId] = useState("");
  const discoveryGeneration = useRef(0);
  const active = provider.state === "active";
  const cloudValid = provider.provider === "foundry"
    ? /^https:\/\/[a-z0-9-]+\.(?:openai\.azure\.com|services\.ai\.azure\.com)\/openai\/v1\/?$/.test(foundry.endpoint)
      && selectedModelIds.every((id) => foundry.deployments[id]?.trim())
    : provider.provider === "vertex" ? googleApiKey ? selectedModelIds.every((id) => /^gemini-[a-zA-Z0-9._-]+$/.test(id))
      : /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(vertex.projectId) && /^(global|[a-z]{2,12}-[a-z]{2,16}[0-9])$/.test(vertex.location)
    : provider.provider === "bedrock" ? /^[a-z]{2}-[a-z]+-[0-9]$/.test(region) : true;
  const discover = async (refresh = false, withDraft = false) => {
    const generation = ++discoveryGeneration.current;
    setCatalogBusy(true);
    setCatalogError("");
    const input = { refresh };
    if (withDraft) {
      if (apiKey.trim()) input[credentialField] = apiKey.trim();
      if (provider.provider === "foundry" && foundry.endpoint) input.foundry = { endpoint: foundry.endpoint, deployments: {} };
      if (provider.provider === "vertex" && (googleApiKey || vertex.projectId)) input.vertex = vertex;
      if (provider.provider === "bedrock") input.region = region;
    }
    try {
      const result = await adminApi.discoverProviderModels(provider.provider, input);
      if (generation === discoveryGeneration.current) setCatalog(result);
    } catch {
      if (generation === discoveryGeneration.current) setCatalogError("Model discovery is unavailable. Your selection is preserved; you can add an exact model ID or retry.");
    } finally {
      if (generation === discoveryGeneration.current) setCatalogBusy(false);
    }
  };
  useEffect(() => {
    void discover();
    const timer = setInterval(() => void discover(), 3600_000);
    return () => { clearInterval(timer); discoveryGeneration.current += 1; };
  }, [provider.provider]);
  const options = useMemo(() => {
    const all = new Map((provider.modelOptions ?? []).map((model) => [model.id, model]));
    for (const model of catalog?.models ?? []) all.set(model.id, model);
    for (const id of selectedModelIds) if (!all.has(id)) all.set(id, { id, displayName: id, source: "manual", capabilities: {} });
    return [...all.values()].sort((a, b) => Number(selectedModelIds.includes(b.id)) - Number(selectedModelIds.includes(a.id)) || a.displayName.localeCompare(b.displayName));
  }, [catalog, provider.modelOptions, selectedModelIds]);
  const matching = options.filter((model) => (!googleApiKey || /^gemini-[a-zA-Z0-9._-]+$/.test(model.id)) && `${model.id} ${model.displayName} ${model.publisher ?? ""}`.toLowerCase().includes(search.toLowerCase()) && (capabilityFilter === "all" || (model.capabilities ?? model.modelCapabilities)?.[capabilityFilter] === true));
  const toggleModel = (id, selected) => {
    setSelectedModelIds((current) => selected ? [...new Set([...current, id])].slice(0, 64) : current.filter((item) => item !== id));
    if (selected && provider.provider === "foundry") setFoundry((current) => ({ ...current,
      deployments: { ...current.deployments, [id]: current.deployments[id] ?? (id.length <= 64 && !id.includes("/") ? id : "") },
      protocols: { ...current.protocols, [id]: current.protocols?.[id] ?? (id.startsWith("claude-") ? "anthropic" : "openai") },
    }));
  };
  const validCustomId = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,179}$/.test(customId.trim()) && !customId.includes("..") && !customId.includes("//") && !["__proto__", "constructor", "prototype"].includes(customId.trim()) && (!googleApiKey || /^gemini-[a-zA-Z0-9._-]+$/.test(customId.trim()));
  const submit = async () => {
    if ((!apiKey.trim() && !active) || !cloudValid || !emissionsRegion || !selectedModelIds.length) return;
    const credential = apiKey.trim() ? { [credentialField]: apiKey.trim() } : {};
    const input = { ...credential, modelIds: selectedModelIds, emissionsRegion };
    if (provider.provider === "foundry") input.foundry = { endpoint: foundry.endpoint,
      deployments: Object.fromEntries(selectedModelIds.map((id) => [id, foundry.deployments[id].trim()])),
      protocols: Object.fromEntries(selectedModelIds.map((id) => [id, foundry.protocols?.[id] ?? "openai"])) };
    if (provider.provider === "vertex") input.vertex = vertex;
    if (provider.provider === "bedrock") input.region = region;
    setApiKey("");
    if (await onSave(provider.provider, input)) onClose();
  };
  return <ModalDialog title={`${active ? "Manage" : "Connect"} ${providerTitle(provider.provider)}`}
    description="Choose models for your organization. Applying changes tests the selected models; pricing and route assignments are managed separately."
    eyebrow="Provider account" labelledBy="provider-account-editor-title" onClose={busy ? () => undefined : onClose}>
    {provider.provider === "foundry" && <label className="modal-field"><span>Foundry OpenAI v1 endpoint</span><input type="url" value={foundry.endpoint} placeholder="https://your-resource.openai.azure.com/openai/v1/" disabled={busy || active} onChange={(event) => setFoundry((current) => ({ ...current, endpoint: event.target.value }))} /><small>Claude deployments use the Anthropic endpoint on this resource.</small></label>}
    {provider.provider === "vertex" && <>
      <label className="modal-field"><span>Authentication method</span><SelectMenu ariaLabel="Google authentication method" value={vertex.authMethod ?? "service-account"} disabled={busy || active} options={[{ value: "api-key", label: "API key" }, { value: "service-account", label: "Service-account JSON" }]} onValueChange={(authMethod) => {
        setVertex(authMethod === "api-key" ? { authMethod, location: "global" } : { authMethod, projectId: "", location: "global" });
        setApiKey(""); setSelectedModelIds([]); setCustomId("");
        discoveryGeneration.current += 1; setCatalogBusy(false); setCatalogError("");
      }} /></label>
      {googleApiKey ? <p>Use a Google Cloud Agent Platform API key. This connection supports Gemini through the global endpoint; the key determines the billing project. Partner models require service-account authentication.</p> : <>
        <label className="modal-field"><span>Google Cloud project ID</span><input value={vertex.projectId ?? ""} disabled={busy || active} onChange={(event) => setVertex((current) => ({ ...current, projectId: event.target.value }))} /></label>
        <label className="modal-field"><span>Google Cloud location</span><input value={vertex.location} disabled={busy || active} placeholder="global or us-east5" onChange={(event) => setVertex((current) => ({ ...current, location: event.target.value }))} /><small>Enter a supported location for your selected models. Global does not pin inference to one region.</small></label>
      </>}
    </>}
    {provider.provider === "bedrock" && <label className="modal-field"><span>Bedrock region</span><input value={region} disabled={busy || active} placeholder="ap-southeast-1" onChange={(event) => setRegion(event.target.value)} /><small>Use a model ID or inference profile ID supported by Bedrock Converse in this region.</small></label>}
    <label className="modal-field"><span>{provider.provider === "vertex" ? googleApiKey ? "Google Cloud API key" : "Google service account JSON" : providerTitle(provider.provider) + " API key"}</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={active ? "Leave blank to keep the saved credential" : "Paste the provider credential"} disabled={busy} /></label>
    <div className="provider-catalog-toolbar provider-catalog-controls">
      <label className="modal-field"><span>Search models</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search model name or publisher" /></label>
      <label className="modal-field"><span>Reported capabilities</span><SelectMenu value={capabilityFilter} options={[{ value: "all", label: "All models" }, { value: "tools", label: "Function tools" }, { value: "vision", label: "Vision" }, { value: "streaming", label: "Streaming" }]} ariaLabel="Filter models by capability" onValueChange={setCapabilityFilter} /></label>
      <button className="secondary-button provider-catalog-refresh" type="button" aria-label="Refresh models" title={catalogBusy ? "Refreshing models…" : "Refresh models"} aria-busy={catalogBusy} disabled={busy || catalogBusy} onClick={() => void discover(true, true)}><ArrowSync20Regular aria-hidden="true" /></button>
    </div>
    <p className="provider-catalog-status" role="status">{catalogError || catalog?.warning || (catalogBusy ? "Loading available model information…" : "Catalog visibility does not guarantee account access. Selected models are tested when you apply changes.")}</p>
    {catalog?.fetchedAt && <p className="provider-catalog-status">Updated {displayDate(catalog.fetchedAt)} · Refreshes automatically every hour</p>}
    <fieldset className="provider-model-options provider-dynamic-models">
      <legend>Enabled models ({selectedModelIds.length}/64)</legend>
      {matching.slice(0, 100).map((option) => {
        const capabilities = option.capabilities ?? option.modelCapabilities;
        return <label key={option.id}>
          <input type="checkbox" checked={selectedModelIds.includes(option.id)} disabled={busy || (!selectedModelIds.includes(option.id) && selectedModelIds.length >= 64)} onChange={(event) => toggleModel(option.id, event.target.checked)} />
          <span><strong>{option.displayName}</strong><small>{option.id}{option.publisher ? ` · ${option.publisher}` : ""}</small>
            <small>{providerModelCapabilityLabels(capabilities).join(" · ") || "Capabilities unknown"}{option.source ? ` · ${option.source === "litellm" ? "LiteLLM metadata" : option.source === "manual" ? "Added by ID" : option.source === "legacy" ? "Legacy profile" : option.source === "admin" ? "Administrator metadata" : "Provider catalog"}` : " · Legacy profile"}</small>
            {(option.contextTokens || option.outputTokens) && <small>{option.contextTokens ? `${option.contextTokens.toLocaleString()} input tokens` : "Input limit unknown"} · {option.outputTokens ? `${option.outputTokens.toLocaleString()} output tokens` : "Output limit unknown"}</small>}
            {(option.inputUsdPerMillion !== undefined || option.outputUsdPerMillion !== undefined) && <small>Reference USD / 1M tokens: {option.inputUsdPerMillion ?? "?"} input · {option.outputUsdPerMillion ?? "?"} output. Review pricing before routing.</small>}
          </span>
        </label>;
      })}
      {!matching.length && <p>No matching models. Add an exact model ID below.</p>}
      {matching.length > 100 && <p>Showing 100 of {matching.length} matches. Refine your search.</p>}
    </fieldset>
    <div className="provider-catalog-toolbar">
      <label className="modal-field"><span>Model ID</span><input value={customId} maxLength={180} disabled={busy} onChange={(event) => setCustomId(event.target.value)} placeholder="Exact provider model ID, including version" /></label>
      <button className="secondary-button" type="button" disabled={busy || !validCustomId || selectedModelIds.length >= 64} onClick={() => { toggleModel(customId.trim(), true); setCustomId(""); setSearch(""); }}>Add by model ID</button>
    </div>
    {provider.provider === "foundry" && selectedModelIds.map((id) => <div key={id} className="provider-deployment-fields">
      <label className="modal-field"><span>{id} deployment name</span><input value={foundry.deployments[id] ?? ""} disabled={busy || Boolean(active && provider.foundry?.deployments?.[id])} onChange={(event) => setFoundry((current) => ({ ...current, deployments: { ...current.deployments, [id]: event.target.value } }))} /><small>Use the deployment name from your Azure resource.</small></label>
      <label className="modal-field"><span>{id} API format</span><SelectMenu value={foundry.protocols?.[id] ?? "openai"} options={[{ value: "openai", label: "OpenAI compatible" }, { value: "anthropic", label: "Anthropic (Claude)" }]} ariaLabel={`${id} API format`} disabled={busy || Boolean(active && provider.foundry?.deployments?.[id])} onValueChange={(protocol) => setFoundry((current) => ({ ...current, protocols: { ...current.protocols, [id]: protocol } }))} /></label>
    </div>)}
    {active && ["foundry", "vertex", "bedrock"].includes(provider.provider) && <p>Disconnect before changing the account's resource, project, region, or an existing deployment target.</p>}
    <label className="modal-field"><span>Estimated serving grid</span><SelectMenu value={emissionsRegion} options={accountingRegionOptions} ariaLabel="Estimated serving grid for emissions" disabled={busy} onValueChange={setEmissionsRegion} /><small>Accounting assumption only; this does not control inference location.</small></label>
    <div className="modal-actions provider-account-actions">
      {provider.state !== "not-configured" && <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => onDelete(provider.provider)}>Disconnect provider</button>}
      <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="primary-button" type="button" disabled={busy || !cloudValid || (!active && !apiKey.trim()) || !emissionsRegion || !selectedModelIds.length} onClick={submit}>{busy ? "Validating" : active ? "Apply changes" : "Connect account"}</button>
    </div>
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

function ModelLimitsEditor({ deployment, limits, busy, error, onClose, onSave }) {
  const [contextTokens, setContextTokens] = useState(String(limits?.contextTokens ?? ""));
  const [outputTokens, setOutputTokens] = useState(String(limits?.outputTokens ?? ""));
  const context = Number(contextTokens);
  const output = Number(outputTokens);
  const valid = Number.isSafeInteger(context) && context >= 1024 && context <= 100_000_000
    && Number.isSafeInteger(output) && output > 0 && output < context;
  return <ModalDialog title="Edit model limits" eyebrow={deployment.displayName} labelledBy="model-limits-title" onClose={busy ? () => undefined : onClose}>
    <p>Use the limits supported by your provider deployment. Increasing these values does not increase the model's actual capacity.</p>
    {error && <p role="alert">{error}</p>}
    <label className="modal-field"><span>Context window (tokens)</span><input type="number" min="1024" max="100000000" step="1" value={contextTokens} disabled={busy} onChange={(event) => setContextTokens(event.target.value)} /></label>
    <label className="modal-field"><span>Maximum output tokens</span><input type="number" min="1" step="1" value={outputTokens} disabled={busy} onChange={(event) => setOutputTokens(event.target.value)} /></label>
    {!valid && <p role="status">Enter whole numbers. Maximum output must be smaller than the context window.</p>}
    <p>Saving updates this deployment's organization routes and restarts running workspaces through the route-update flow. Agent context settings apply when the workspace starts.</p>
    <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !valid} onClick={() => onSave({ contextTokens: context, outputTokens: output })}>{busy ? "Saving" : "Save model limits"}</button></div>
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
  onDeleteProvider,
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
  const [limitsEditor, setLimitsEditor] = useState(null);
  const [updatedProviders, setUpdatedProviders] = useState({});
  useEffect(() => setUpdatedProviders({}), [providers]);
  const focusApplied = useRef(false);

  const inventory = useMemo(() => configuredProviderDeployments(providers.map((provider) => updatedProviders[provider.provider] ?? provider)), [providers, updatedProviders]);
  const cardById = useMemo(() => new Map(rateCards.map((card) => [card.id, card])), [rateCards]);
  const effectiveRoutes = useMemo(() => [...(draft?.deployments ?? mapping?.deployments ?? [])].sort((left, right) => (routeRank[left.serviceClass] ?? 9) - (routeRank[right.serviceClass] ?? 9)), [draft, mapping]);
  const routeByDeployment = useMemo(() => new Map(effectiveRoutes.map((route) => [providerDeploymentKey(route), route])), [effectiveRoutes]);
  const selected = inventory.find((deployment) => deployment.id === selectedId) ?? inventory[0] ?? null;
  const selectedProvider = selected ? providers.find((provider) => provider.provider === selected.provider) : null;
  const selectedRoute = selected ? routeByDeployment.get(providerDeploymentKey(selected)) : null;
  const availableLimits = selected?.modelLimits ?? selectedRoute?.capabilities;
  const selectedLimits = Number.isSafeInteger(availableLimits?.contextTokens) && Number.isSafeInteger(availableLimits?.outputTokens) ? availableLimits : null;
  const selectedCard = selected ? cardById.get(selectedRoute?.rateCardId) ?? latestRateCardForDeployment(rateCards, selected) : null;
  const selectedCoverage = pricingCoverage(selectedCard);
  const routeReadiness = useMemo(() => organizationRouteReadiness(effectiveRoutes, inventory, cardById), [cardById, effectiveRoutes, inventory]);
  const readyRoutes = routeReadiness.filter((route) => route.ready).length;
  const issueCount = routeClasses.length - readyRoutes;
  const assignedRoutes = effectiveRoutes.filter(routeIsAssigned).length;
  const routesReadyToPublish = assignedRoutes === readyRoutes && (assignedRoutes > 0 || Boolean(mapping?.id));

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
  const saveModelLimits = async (limits) => {
    setBusy(true);
    setError("");
    try {
      const result = await adminApi.saveModelLimits(limitsEditor.deployment.provider, { deploymentId: limitsEditor.deployment.id, limits });
      setUpdatedProviders((current) => ({ ...current, [result.provider.provider]: result.provider }));
      setMapping(result.mapping);
      setLimitsEditor(null);
      const attention = (result.workspaceActivation?.restartFailed ?? 0) + (result.workspaceActivation?.actionRequired ?? 0);
      if (result.activationError) setError(result.activationError);
      else setNotice(attention ? `Model limits saved. ${attention} workspaces need administrator attention.` : result.workspaceActivation ? "Model limits saved. Published routes and workspace settings now use these limits." : "Model limits saved. They will apply when this deployment is assigned to a route.");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };
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
          contextTokens: normalized.modelLimits?.contextTokens ?? normalized.capabilities?.contextTokens ?? 32000,
          outputTokens: normalized.modelLimits?.outputTokens ?? normalized.capabilities?.outputTokens ?? 32768,
          residency: normalized.capabilities?.residency ?? (normalized.region ? [normalized.region] : []),
        },
        approved: normalized.approved ?? true,
        evaluationPassed: normalized.evaluationPassed ?? true,
      };
    });
  };
  const openMappingEditor = () => setMappingEditor({ revisionNote: draft?.revisionNote ?? "", deployments: draftableDeployments() });
  const removeSelectedRoute = () => {
    if (!selectedRoute) return;
    const next = {
      revisionNote: `Remove the ${serviceClassLabels[selectedRoute.serviceClass]} organization route`,
      deployments: effectiveRoutes.filter((route) => route.serviceClass !== selectedRoute.serviceClass),
    };
    setDraft(next);
    writeRouteDraft(draftScope, next);
    setNotice(`${serviceClassLabels[selectedRoute.serviceClass]} was removed from the pending changes. Save the change to update Chat and workspace settings.`);
    setPublishOpen(true);
  };
  const deleteProvider = async (provider) => {
    const result = await onDeleteProvider(provider);
    if (!result) return;
    if (result.mapping) setMapping(result.mapping);
    if (draft) {
      const next = { ...draft, deployments: draft.deployments.filter((deployment) => deployment.provider !== provider) };
      setDraft(next);
      writeRouteDraft(draftScope, next);
    }
    setProviderEditor(null);
    setNotice(`${providerTitle(provider)} was disconnected. Its credential and organization routes were removed.`);
  };
  const saveMappingDraft = () => {
    const next = { revisionNote: mappingEditor.revisionNote.trim(), deployments: mappingEditor.deployments.filter(routeIsAssigned) };
    setDraft(next);
    writeRouteDraft(draftScope, next);
    setMappingEditor(null);
    setNotice("Route changes are ready. Save them to make the new routes available across the organization.");
    setPublishOpen(true);
  };
  const mappingInput = (value) => {
    const assigned = value.deployments.filter(routeIsAssigned);
    const currencies = [...new Set(assigned
      .map((deployment) => cardById.get(deployment.rateCardId)?.currency)
      .filter(Boolean))];
    return {
      revisionNote: value.revisionNote,
      billingCurrency: currencies[0] ?? "USD",
      deployments: assigned.map((deployment) => ({
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
    };
  };
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
      const activation = result.workspaceActivation;
      const needsAttention = Number(activation?.restartFailed ?? 0) + Number(activation?.actionRequired ?? 0);
      setNotice(needsAttention
        ? `Organization routes saved. ${needsAttention} ${needsAttention === 1 ? "workspace needs" : "workspaces need"} administrator attention; all other Chat and workspace settings now use this version.`
        : "Organization routes saved. Chat and workspaces now use this version according to each workspace policy.");
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
      prices: Object.fromEntries(pricingUnits.map((item) => [item.key, card ? String(Number(card.rates?.find((rate) => rate.unit === item.key)?.amountPerUnit ?? 0) * 1_000_000 / Number(card.rates?.find((rate) => rate.unit === item.key)?.unitScale ?? 1_000_000)) : item.key === "input_uncached_token" ? String(deployment.metadata?.inputUsdPerMillion ?? "") : item.key === "output_token" ? String(deployment.metadata?.outputUsdPerMillion ?? "") : ""])),
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
        setPublishOpen(true);
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
      <div className="models-routing-version"><span>{mapping?.id ? `Saved ${shortId(mapping.id)}` : "No saved routes"}{draft ? " · Unsaved changes" : ""}</span>{canManageRouting && <button className="primary-button" type="button" disabled={busy || !draft} onClick={() => setPublishOpen(true)}>Save changes</button>}</div>
    </header>
    {(error || providerError) && <div className="workspace-error" role="alert"><span><strong>Models and routing unavailable</strong>{error || providerError}</span></div>}
    {notice && <div className="models-routing-notice" role="status"><CheckmarkCircle20Regular aria-hidden="true" /><span>{notice}</span></div>}
    {draft && <div className="models-routing-pending" role="note"><Info20Regular aria-hidden="true" /><span><strong>Unsaved route changes</strong><small>Save changes to update Chat, workspace configuration, and the organization routing default.</small></span>{canManageRouting && <button className="primary-button" type="button" disabled={busy} onClick={() => setPublishOpen(true)}>Save changes</button>}</div>}
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
                <div><strong>{providerTitle(provider.provider)}</strong><span className={`models-routing-provider-state ${provider.state}`}>{provider.state === "active" && <CheckmarkCircle20Regular aria-hidden="true" />}{providerStateLabel(provider.state)}</span><small>{provider.state === "active" ? `Last tested ${displayDate(provider.lastTestedAt)}` : "One credential is shared across every enabled model."}</small></div>
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
          <section><div className="models-routing-inspector-title"><strong>Model limits</strong>{canManageProviders && <button type="button" aria-label="Edit model limits" disabled={busy || loading || Boolean(draft)} onClick={() => setLimitsEditor({ deployment: selected, limits: selectedLimits })}>Edit</button>}</div><p>{selectedLimits ? `${selectedLimits.contextTokens.toLocaleString()} context · ${selectedLimits.outputTokens.toLocaleString()} maximum output tokens` : "Not configured"}</p><small>{draft ? "Save or discard route changes before editing model limits." : "Provider deployment capacity, shared by routing and agent context settings."}</small></section>
          <section><div className="models-routing-inspector-title"><strong>Availability</strong>{canManageProviders && selectedProvider && <button type="button" onClick={() => setProviderEditor(selectedProvider)}>Edit</button>}</div><span className="models-routing-ready"><CheckmarkCircle20Regular aria-hidden="true" />Enabled</span><p>This approved model is enabled for your organization.</p></section>
          <section><div className="models-routing-inspector-title"><strong>Pricing</strong><Info20Regular aria-hidden="true" /></div>{selectedCoverage.complete ? <span className="models-routing-ready"><CheckmarkCircle20Regular aria-hidden="true" />{rateLabel(selectedCard, "input_uncached_token")} input · {rateLabel(selectedCard, "output_token")} output</span> : <span className="models-routing-gap"><ErrorCircle20Regular aria-hidden="true" />Pricing missing</span>}<p>{selectedCoverage.complete ? "Current immutable rates shown per 1M tokens." : "Add input, output, cache-read, and cache-write prices to make this model routable."}</p>{canManagePricing && <button className="secondary-button" type="button" onClick={() => openPricing(selected)}>{selectedCard ? "Add price version" : "Add pricing"}</button>}<button className="models-routing-inline-link" type="button" onClick={() => setHistory({ kind: "pricing", deployment: selected })}>View pricing history</button></section>
          <section><div className="models-routing-inspector-title"><strong>Organization route</strong><Info20Regular aria-hidden="true" /></div>{selectedRoute ? <span className={selectedCoverage.complete ? "models-routing-ready" : "models-routing-gap"}>{selectedCoverage.complete ? <CheckmarkCircle20Regular aria-hidden="true" /> : <ErrorCircle20Regular aria-hidden="true" />}{serviceClassLabels[selectedRoute.serviceClass]}</span> : <span className="models-routing-gap"><ErrorCircle20Regular aria-hidden="true" />Not assigned</span>}<p>{selectedCoverage.complete ? "Assign this model to Lite, Balanced, or Pro in the organization route changes." : "Pricing must exist before a route using this model can be saved."}</p>{canManageRouting && <div className="models-routing-route-actions"><button className="secondary-button" type="button" disabled={!inventory.length} onClick={openMappingEditor}>{selectedRoute ? "Change route" : "Assign route"}</button>{selectedRoute && <button className="models-routing-inline-link danger-button" type="button" onClick={removeSelectedRoute}>Remove from {serviceClassLabels[selectedRoute.serviceClass]}</button>}</div>}<button className="models-routing-inline-link" type="button" onClick={() => setHistory({ kind: "routes", deployment: selected })}>View route versions</button></section>
          <section><div className="models-routing-inspector-title"><strong>Health</strong></div><p>Test the shared provider account connection for this model.</p>{canManageProviders && selectedProvider?.state === "active" && <button className="secondary-button" type="button" disabled={providerBusy} onClick={() => onTestProvider(selected.provider)}>Test model</button>}<small>Last tested {displayDate(selectedProvider?.lastTestedAt)}</small></section>
        </> : <div className="models-routing-inspector-empty"><Info20Regular aria-hidden="true" /><strong>Select an enabled model</strong><span>Pricing, organization route use, and health appear here.</span></div>}
      </aside>
    </div>
    {providerEditor && <ProviderEditor provider={providerEditor} busy={providerBusy} onClose={() => setProviderEditor(null)} onSave={onSaveProvider} onDelete={deleteProvider} />}
    {limitsEditor && <ModelLimitsEditor {...limitsEditor} error={error} busy={busy} onClose={() => setLimitsEditor(null)} onSave={saveModelLimits} />}
    {priceEditor && <PricingEditor editor={priceEditor} busy={busy} onChange={setPriceEditor} onClose={() => setPriceEditor(null)} onCreate={createPriceRecord} />}
    {mappingEditor && <MappingEditor editor={mappingEditor} inventory={inventory} rateCards={rateCards} busy={busy} onChange={setMappingEditor} onClose={() => setMappingEditor(null)} onSave={saveMappingDraft} />}
    {publishOpen && <ModalDialog title="Save organization routes?" description="Saving creates an immutable route version and immediately updates Chat and every workspace according to its assigned workspace policy." eyebrow="Models & routing" labelledBy="models-routing-publish-title" onClose={busy ? () => undefined : () => setPublishOpen(false)}><div className="route-editor-warning"><Info20Regular aria-hidden="true" /><span>{assignedRoutes ? "Every assigned route must point to an enabled model with complete pricing. Unassigned service levels remain unavailable in Chat and workspace settings." : "Saving this removal makes every organization route unavailable in Chat and workspace settings."}</span></div><div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setPublishOpen(false)}>Cancel</button><button className="primary-button" type="button" disabled={busy || !routesReadyToPublish} onClick={publishMapping}>{busy ? "Saving…" : assignedRoutes ? `Save ${readyRoutes} ${readyRoutes === 1 ? "route" : "routes"}` : "Save route removal"}</button></div></ModalDialog>}
    {history && <HistoryDialog kind={history.kind} deployment={history.deployment} rateCards={rateCards} mapping={mapping} onClose={() => setHistory(null)} />}
  </div>;
}
