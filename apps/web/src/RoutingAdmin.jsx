import { useEffect, useMemo, useState } from "react";
import { CheckmarkCircle20Regular } from "@fluentui/react-icons/svg/checkmark-circle";
import { ErrorCircle20Regular } from "@fluentui/react-icons/svg/error-circle";
import { Info20Regular } from "@fluentui/react-icons/svg/info";
import { adminApi } from "./workspace-api.js";
import { PricingAdmin } from "./PricingAdmin.jsx";
import {
  configuredProviderDeployments,
  latestRateCardForDeployment,
  providerDeploymentKey,
  providerDeploymentLabel,
  providerModelCapabilityLabels,
  providerTitle,
  rateCardMatchesDeployment,
} from "./provider-inventory.js";
import { ModalDialog, SelectMenu } from "./ui.jsx";
import "./RoutingAdmin.css";

const serviceClassLabels = { lite: "Lite", balanced: "Balanced", pro: "Pro" };
const serviceClassDescriptions = {
  lite: "Fast, economical work",
  balanced: "Everyday reasoning and tool use",
  pro: "Highest capability for complex work",
};
const pricingUnits = [
  { key: "input_uncached_token", label: "Input" },
  { key: "output_token", label: "Output" },
  { key: "cache_read_token", label: "Cache read" },
  { key: "cache_write_token", label: "Cache write" },
];
const money = (amount, currency) => amount == null ? "—" : `${currency ?? ""} ${Number(amount).toFixed(2)}`.trim();
const shortId = (value) => value ? `${String(value).slice(0, 8)}…${String(value).slice(-4)}` : "Not configured";
const providerName = (value) => ({
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "Amazon Bedrock",
  foundry: "Azure AI Foundry",
  azure: "Azure AI Foundry",
  google: "Google",
}[value] ?? value);
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
const pricingCoverage = (card) => {
  if (!card) return { complete: false, missing: pricingUnits.map((item) => item.label) };
  const missing = pricingUnits.filter((item) => ratePerMillion(card, item.key) == null).map((item) => item.label);
  return { complete: missing.length === 0, missing };
};
const createInitialTeamPolicy = (mapping, cardById) => {
  const deployments = ["lite", "balanced", "pro"].map((serviceClass) => {
    const deployment = mapping?.deployments?.find((item) => item.serviceClass === serviceClass);
    if (!deployment) throw new Error(`The published mapping is missing a ${serviceClass} deployment.`);
    if (!deployment.capabilities) throw new Error(`The ${serviceClass} deployment is missing capability metadata.`);
    return deployment;
  });
  const cards = deployments.map((deployment) => cardById.get(deployment.rateCardId));
  if (cards.some((card) => !pricingCoverage(card).complete)) {
    throw new Error("Complete pricing for Lite, Balanced, and Pro before setting up this Team.");
  }
  const currencies = [...new Set(cards.map((card) => card.currency))];
  if (currencies.length !== 1) throw new Error("All routes must use the same billing currency for a Team policy.");
  const allowedDeploymentIds = deployments.map((deployment) => deployment.id);
  const scope = {
    allowedServiceClasses: ["lite", "balanced", "pro"],
    allowedDeploymentIds,
    explicitSelectionAllowed: true,
    forceServiceClass: null,
    safeDefault: "balanced",
  };
  const serviceClassPolicies = Object.fromEntries(deployments.map((deployment) => {
    const capabilities = deployment.capabilities;
    return [deployment.serviceClass, {
      capabilityFloor: {
        vision: capabilities.vision,
        tools: capabilities.tools,
        streaming: capabilities.streaming,
        contextTokens: capabilities.contextTokens,
        outputTokens: capabilities.outputTokens,
      },
      evaluationThreshold: "0.800000",
      qualityPosture: deployment.serviceClass === "pro" ? "premium" : "standard",
      costPosture: deployment.serviceClass === "lite" ? "lowest" : "balanced",
      latencyPosture: "balanced",
      requiredModalities: ["text"],
      requiredResidency: capabilities.residency ?? [],
      eligibleDeploymentIds: [deployment.id],
      safeDefault: deployment.serviceClass === "balanced",
    }];
  }));
  return {
    mappingVersionId: mapping.id,
    billingCurrency: currencies[0],
    serviceClassPolicies,
    identity: scope,
    team: { ...scope, allowedServiceClasses: [...scope.allowedServiceClasses], allowedDeploymentIds: [...scope.allowedDeploymentIds] },
  };
};
const datetimeLocalValue = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};
const hashPricingRecord = async (record) => {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
};
const routeDraftServiceClasses = ["lite", "balanced", "pro"];
const routeDraftStorageKey = (scope) => scope?.tenantId && scope?.userId
  ? `lemmacomputer.routing-mapping-draft:v2:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId)}`
  : "";
const legacyRouteDraftStorageKey = (scope) => scope?.tenantId && scope?.userId
  ? `lemmacomputer.routing-mapping-draft:v1:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId)}`
  : "";
const storedRouteDeployment = (value) => {
  if (!value || typeof value !== "object"
    || typeof value.id !== "string"
    || !routeDraftServiceClasses.includes(value.serviceClass)
    || typeof value.provider !== "string"
    || typeof value.providerModel !== "string"
    || typeof value.providerDeployment !== "string"
    || !value.provider.trim()
    || !value.providerModel.trim()
    || !value.providerDeployment.trim()
    || !value.capabilities
    || typeof value.capabilities !== "object") return null;
  return value;
};
const readRouteDraft = (scope) => {
  const key = routeDraftStorageKey(scope);
  if (!key) return null;
  try {
    window.localStorage.removeItem(legacyRouteDraftStorageKey(scope));
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    const deployments = Array.isArray(parsed?.draft?.deployments)
      ? parsed.draft.deployments.map(storedRouteDeployment)
      : [];
    const classes = new Set(deployments.map((deployment) => deployment?.serviceClass));
    if (parsed?.schemaVersion !== 2
      || typeof parsed?.draft?.revisionNote !== "string"
      || parsed.draft.revisionNote.trim().length < 8
      || parsed.draft.revisionNote.length > 500
      || deployments.some((deployment) => !deployment)
      || deployments.length < 1
      || deployments.length > routeDraftServiceClasses.length
      || classes.size !== deployments.length) {
      window.localStorage.removeItem(key);
      return null;
    }
    return { revisionNote: parsed.draft.revisionNote, deployments };
  } catch {
    return null;
  }
};
const writeRouteDraft = (scope, draft) => {
  const key = routeDraftStorageKey(scope);
  if (!key) return false;
  try {
    window.localStorage.removeItem(legacyRouteDraftStorageKey(scope));
    window.localStorage.setItem(key, JSON.stringify({ schemaVersion: 2, savedAt: new Date().toISOString(), draft }));
    return true;
  } catch {
    return false;
  }
};
const clearRouteDraft = (scope) => {
  const key = routeDraftStorageKey(scope);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(legacyRouteDraftStorageKey(scope));
  } catch { /* Browser storage may be unavailable. */ }
};

export {
  MappingEditor,
  PricingEditor,
  clearRouteDraft,
  datetimeLocalValue,
  hashPricingRecord,
  pricingCoverage,
  pricingUnits,
  rateLabel,
  ratePerMillion,
  readRouteDraft,
  serviceClassDescriptions,
  serviceClassLabels,
  shortId,
  writeRouteDraft,
};

function PriceCell({ card, unit }) {
  const missing = ratePerMillion(card, unit) == null;
  return <span className={missing ? "route-price-missing" : ""}>{rateLabel(card, unit)}</span>;
}

function RouteHealth({ deployment }) {
  if (deployment.healthy === true) return <span className="route-health healthy"><CheckmarkCircle20Regular aria-hidden="true" />Healthy</span>;
  if (deployment.healthy === false) return <span className="route-health unavailable"><ErrorCircle20Regular aria-hidden="true" />Unavailable</span>;
  return <span className="route-health unknown"><Info20Regular aria-hidden="true" />Not reported</span>;
}

function PricingEditor({ editor, busy, onChange, onClose, onCreate }) {
  const updateRate = (key, value) => onChange({ ...editor, prices: { ...editor.prices, [key]: value } });
  const canCreate = editor.providerAccountId.trim()
    && editor.sourceVersion.trim()
    && editor.overrideReason.trim()
    && editor.prices.input_uncached_token !== ""
    && editor.prices.output_token !== "";
  return <ModalDialog
    title={`New ${serviceClassLabels[editor.deployment.serviceClass] ?? editor.deployment.displayName ?? "model"} price version`}
    description="Create immutable pricing evidence for this provider deployment and attach it to a local mapping draft. This does not change a current Team policy."
    eyebrow="Rate card"
    labelledBy="route-pricing-title"
    onClose={busy ? () => undefined : onClose}
  >
    <div className="route-price-target" role="note">
      <span>{providerName(editor.deployment.provider)}</span>
      <strong>{editor.deployment.providerModel}</strong>
      <small>{editor.deployment.providerDeployment}</small>
    </div>
    <div className="route-price-form-grid">
      <label className="modal-field route-price-currency"><span>Currency</span><input aria-label="Pricing currency" value={editor.currency} maxLength={3} disabled={busy} onChange={(event) => onChange({ ...editor, currency: event.target.value.toUpperCase() })} /></label>
      {pricingUnits.map((item) => <label className="modal-field" key={item.key}><span>{item.label} / 1M tokens{item.key.startsWith("cache") ? " (optional)" : ""}</span><input aria-label={`${item.label} price per 1M tokens`} type="number" min="0" step="0.0001" value={editor.prices[item.key]} disabled={busy} onChange={(event) => updateRate(item.key, event.target.value)} /></label>)}
      <label className="modal-field"><span>Version label</span><input aria-label="Price version label" value={editor.sourceVersion} disabled={busy} onChange={(event) => onChange({ ...editor, sourceVersion: event.target.value })} /></label>
      <label className="modal-field"><span>Effective from</span><input aria-label="Price effective from" type="datetime-local" value={editor.effectiveFrom} disabled={busy} onChange={(event) => onChange({ ...editor, effectiveFrom: event.target.value })} /></label>
      <label className="modal-field route-price-reason"><span>Approval reason</span><textarea aria-label="Price approval reason" value={editor.overrideReason} disabled={busy} onChange={(event) => onChange({ ...editor, overrideReason: event.target.value })} /></label>
    </div>
    <div className="route-editor-warning"><Info20Regular aria-hidden="true" /><span>The new record is staged in a local mapping draft. Publish that mapping version separately before a Team policy can adopt it.</span></div>
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={busy || !canCreate} onClick={onCreate}>{busy ? "Creating…" : "Create price record"}</button></div>
  </ModalDialog>;
}

function MappingEditor({ editor, inventory, rateCards, busy, onChange, onClose, onSave }) {
  const updateDeployment = (id, change) => onChange({
    ...editor,
    deployments: editor.deployments.map((deployment) => {
      if (deployment.id !== id) return deployment;
      const next = { ...deployment, ...change };
      return next;
    }),
  });
  const minimumRevisionLength = 8;
  const revisionLength = editor.revisionNote.trim().length;
  const remainingRevisionCharacters = Math.max(0, minimumRevisionLength - revisionLength);
  const revisionValid = remainingRevisionCharacters === 0;
  const assignedDeployments = editor.deployments.filter((item) => item.provider || item.providerAccountId || item.providerModel || item.providerDeployment);
  const deploymentsValid = assignedDeployments.length > 0 && assignedDeployments.every((item) => item.provider && item.providerAccountId && item.providerModel.trim() && item.providerDeployment.trim());
  const valid = revisionValid && deploymentsValid;
  return <ModalDialog
    title="Create a mapping draft"
    description="Edit the private provider deployment behind each stable employee alias. Saving keeps the draft in this browser until you publish a new immutable mapping version."
    eyebrow="Model routes"
    labelledBy="route-mapping-editor-title"
    onClose={busy ? () => undefined : onClose}
    className="route-mapping-editor"
  >
    <label className="modal-field route-revision-field"><span>Revision note</span><input aria-label="Mapping revision note" aria-describedby="route-revision-help" aria-invalid={revisionLength > 0 && !revisionValid} value={editor.revisionNote} disabled={busy} onChange={(event) => onChange({ ...editor, revisionNote: event.target.value })} placeholder="Why these routes are changing" /><small id="route-revision-help" className={`route-field-help${revisionLength > 0 && !revisionValid ? " invalid" : revisionValid ? " valid" : ""}`}>{revisionValid ? "Ready to save." : revisionLength ? `${remainingRevisionCharacters} more character${remainingRevisionCharacters === 1 ? "" : "s"} needed.` : `Use at least ${minimumRevisionLength} characters so administrators can identify this change.`}</small></label>
    <div className="route-mapping-editor-list">
      {editor.deployments.map((deployment) => {
        const compatibleCards = rateCards.filter((card) => rateCardMatchesDeployment(card, deployment));
        const selectedDeployment = inventory.find((item) => providerDeploymentKey(item) === providerDeploymentKey(deployment));
        const selectProviderDeployment = (inventoryId) => {
          const selected = inventory.find((item) => item.id === inventoryId);
          if (!selected) {
            updateDeployment(deployment.id, {
              provider: "",
              providerAccountId: "",
              providerModel: "",
              providerDeployment: "",
              region: null,
              providerServiceTier: null,
              rateCardId: "",
            });
            return;
          }
          updateDeployment(deployment.id, {
            ...selected,
            id: deployment.id,
            serviceClass: deployment.serviceClass,
            rateCardId: latestRateCardForDeployment(rateCards, selected)?.id ?? "",
          });
        };
        return <section key={deployment.id} className="route-mapping-editor-row" aria-labelledby={`route-editor-${deployment.serviceClass}`}>
          <header><span className={`route-alias ${deployment.serviceClass}`} id={`route-editor-${deployment.serviceClass}`}>{serviceClassLabels[deployment.serviceClass]}</span><small>{serviceClassDescriptions[deployment.serviceClass]}</small></header>
          <label className="modal-field"><span>Provider deployment</span><SelectMenu ariaLabel={`${serviceClassLabels[deployment.serviceClass]} provider deployment`} value={selectedDeployment?.id ?? ""} options={[{ value: "", label: "Not assigned" }, ...inventory.map((item) => ({ value: item.id, label: providerDeploymentLabel(item) }))]} disabled={busy} onValueChange={selectProviderDeployment} />{providerModelCapabilityLabels(selectedDeployment?.modelCapabilities).length > 0 && <small className="route-model-capabilities">Inherited model capabilities: {providerModelCapabilityLabels(selectedDeployment.modelCapabilities).join(" · ")}</small>}</label>
          <label className="modal-field route-editor-rate"><span>Pinned price record</span><SelectMenu ariaLabel={`${serviceClassLabels[deployment.serviceClass]} price record`} value={deployment.rateCardId ?? ""} options={[{ value: "", label: "No price record" }, ...compatibleCards.map((card) => ({ value: card.id, label: `${card.sourceVersion} · ${card.currency}` }))]} disabled={busy || !selectedDeployment} onValueChange={(rateCardId) => updateDeployment(deployment.id, { rateCardId })} /></label>
        </section>;
      })}
    </div>
    {!valid && <div className="route-editor-validation" role="status" aria-live="polite"><Info20Regular aria-hidden="true" /><span>{!revisionValid ? revisionLength ? `Add ${remainingRevisionCharacters} more character${remainingRevisionCharacters === 1 ? "" : "s"} to the revision note to save this draft.` : `Add a revision note of at least ${minimumRevisionLength} characters to save this draft.` : assignedDeployments.length ? "Finish or clear the incomplete provider assignment." : "Assign at least one organization route to save this draft."}</span></div>}
    <div className="route-editor-warning"><Info20Regular aria-hidden="true" /><span>Publishing creates an immutable version for Team policy adoption. It does not activate or repoint any current Team route.</span></div>
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={busy || !valid} onClick={onSave}>Save local draft</button></div>
  </ModalDialog>;
}

export function RoutingAdmin({ onBack, section = "routes", draftScope }) {
  if (section === "pricing") return <PricingAdmin onBack={onBack} />;
  return <ModelRoutesAdmin onBack={onBack} draftScope={draftScope} />;
}

function ModelRoutesAdmin({ onBack, draftScope }) {
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState("");
  const [settings, setSettings] = useState(null);
  const [rateCards, setRateCards] = useState([]);
  const [mapping, setMapping] = useState(null);
  const [draft, setDraft] = useState(() => readRouteDraft(draftScope));
  const [providers, setProviders] = useState([]);
  const [classes, setClasses] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [priceEditor, setPriceEditor] = useState(null);
  const [mappingEditor, setMappingEditor] = useState(null);
  const [publishOpen, setPublishOpen] = useState(false);

  const cardById = useMemo(() => new Map(rateCards.map((card) => [card.id, card])), [rateCards]);
  const providerDeployments = useMemo(() => configuredProviderDeployments(providers), [providers]);
  const mappedDeployments = useMemo(() => {
    const rank = { lite: 0, balanced: 1, pro: 2 };
    return [...(draft?.deployments ?? mapping?.deployments ?? settings?.deployments ?? [])].sort((left, right) => (rank[left.serviceClass] ?? 9) - (rank[right.serviceClass] ?? 9));
  }, [draft, mapping, settings]);
  const pricingGapCount = mappedDeployments.filter((deployment) => !pricingCoverage(cardById.get(deployment.rateCardId)).complete).length;
  const publishedPricingGapCount = (mapping?.deployments ?? []).filter((deployment) => !pricingCoverage(cardById.get(deployment.rateCardId)).complete).length;
  const selectedTeam = teams.find((team) => team.id === teamId);
  const currentMappingRollout = mapping?.id && settings?.rollout?.mappingVersionId === mapping.id ? settings.rollout : null;
  const mappingStatus = draft
    ? "Local draft"
    : !mapping?.id
      ? "Not configured"
      : currentMappingRollout || settings?.policy?.mappingVersionId === mapping.id
        ? "Active for selected Team"
        : "Published · not active";

  useEffect(() => {
    Promise.all([adminApi.teams(false), adminApi.rateCards(), adminApi.latestRoutingMapping(), adminApi.providerSettings()])
      .then(([teamResult, rateResult, mappingResult, providerResult]) => {
        setTeams(teamResult.teams);
        setTeamId(teamResult.teams[0]?.id ?? "");
        setRateCards(rateResult.rateCards ?? []);
        setMapping(mappingResult.mapping ?? null);
        setProviders(providerResult.providers ?? []);
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false));
  }, []);

  const load = async (id) => {
    if (!id) return;
    setError("");
    try {
      const current = await adminApi.routingSettings(id);
      setSettings(current);
      setClasses(current.policy?.team?.allowedServiceClasses ?? current.policy?.identity.allowedServiceClasses ?? []);
    } catch (caught) {
      setError(caught.message);
    }
  };
  useEffect(() => { void load(teamId); }, [teamId]);

  const run = async (operation, successNotice = "") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await load(teamId);
      if (successNotice) setNotice(successNotice);
      return true;
    } catch (caught) {
      setError(caught.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = () => run(() => adminApi.saveRoutingPolicy(teamId, {
    mappingVersionId: settings.policy.mappingVersionId,
    billingCurrency: settings.policy.billingCurrency,
    serviceClassPolicies: settings.policy.serviceClassPolicies,
    identity: settings.policy.identity,
    team: {
      ...settings.policy.identity,
      allowedServiceClasses: classes,
      allowedDeploymentIds: settings.policy.identity.allowedDeploymentIds.filter((id) => settings.deployments.some((deployment) => deployment.id === id && classes.includes(deployment.serviceClass))),
    },
    ...(settings.policy.requiredResidency ? { requiredResidency: settings.policy.requiredResidency } : {}),
  }), "Team route eligibility saved.");
  const setupTeamRollout = () => run(
    () => adminApi.saveRoutingPolicy(teamId, createInitialTeamPolicy(mapping, cardById)),
    `${selectedTeam?.displayName ?? "Team"} can choose its allowed model tiers. Balanced remains the safe fallback.`,
  );
  const draftableDeployments = () => {
    const source = mappedDeployments.length ? mappedDeployments : ["lite", "balanced", "pro"].map((serviceClass, index) => ({
      ...providerDeployments[Math.min(index, providerDeployments.length - 1)],
      id: `draft-${serviceClass}`,
      serviceClass,
    }));
    return source.map((deployment) => {
      const policyCapabilities = settings?.policy?.serviceClassPolicies?.[deployment.serviceClass]?.capabilityFloor;
      const inventoryDeployment = providerDeployments.find((item) => providerDeploymentKey(item) === providerDeploymentKey(deployment));
      const selected = inventoryDeployment ? { ...deployment, ...inventoryDeployment, id: deployment.id } : deployment;
      const card = cardById.get(selected.rateCardId) ?? latestRateCardForDeployment(rateCards, selected);
      const capableByDefault = selected.serviceClass !== "lite";
      const routeDefaults = {
        vision: policyCapabilities?.vision ?? capableByDefault,
        tools: policyCapabilities?.tools ?? capableByDefault,
        streaming: policyCapabilities?.streaming ?? true,
        contextTokens: policyCapabilities?.contextTokens ?? (selected.serviceClass === "pro" ? 128000 : 32000),
        outputTokens: policyCapabilities?.outputTokens ?? 32768,
        residency: selected.region ? [selected.region] : settings?.policy?.requiredResidency ? [settings.policy.requiredResidency] : [],
      };
      return {
        ...selected,
        providerAccountId: selected.providerAccountId ?? card?.providerAccountId ?? "",
        region: selected.region ?? card?.region ?? null,
        providerServiceTier: selected.providerServiceTier ?? card?.providerServiceTier ?? null,
        rateCardId: selected.rateCardId ?? card?.id ?? "",
        capabilities: { ...routeDefaults, ...(selected.capabilities ?? {}), ...(selected.modelCapabilities ?? {}) },
        approved: selected.approved ?? true,
        evaluationPassed: selected.evaluationPassed ?? true,
      };
    });
  };
  const openMappingEditor = () => setMappingEditor({
    revisionNote: draft?.revisionNote ?? "",
    deployments: draftableDeployments(),
  });
  const saveMappingDraft = () => {
    const nextDraft = { revisionNote: mappingEditor.revisionNote.trim(), deployments: mappingEditor.deployments };
    const persisted = writeRouteDraft(draftScope, nextDraft);
    setDraft(nextDraft);
    setMappingEditor(null);
    setNotice(persisted ? "Local mapping draft saved in this browser. It will remain after a refresh until you publish it." : "Draft saved for this page only because browser storage is unavailable. Publish it before refreshing.");
  };
  const mappingInput = (value) => ({
    revisionNote: value.revisionNote,
    deployments: value.deployments.map((deployment) => ({
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
    setNotice("");
    try {
      const result = await adminApi.createRoutingMapping(mappingInput(draft));
      setMapping(result.mapping);
      setDraft(null);
      clearRouteDraft(draftScope);
      setPublishOpen(false);
      setNotice("Published for Team policy adoption; current Team routes are unchanged.");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };
  const openPricing = (deployment) => {
    const card = cardById.get(deployment.rateCardId);
    setPriceEditor({
      deployment,
      providerAccountId: deployment.providerAccountId ?? card?.providerAccountId ?? "",
      currency: card?.currency ?? settings?.policy?.billingCurrency ?? "USD",
      sourceVersion: `manual-${new Date().toISOString().slice(0, 10)}`,
      effectiveFrom: datetimeLocalValue(),
      overrideReason: "",
      prices: Object.fromEntries(pricingUnits.map((item) => [item.key, ratePerMillion(card, item.key)?.toString() ?? ""])),
    });
  };
  const createPriceRecord = async () => {
    const record = {
      provider: priceEditor.deployment.provider,
      providerAccountId: priceEditor.providerAccountId.trim(),
      baseModel: priceEditor.deployment.providerModel,
      deploymentId: priceEditor.deployment.providerDeployment,
      currency: priceEditor.currency.trim().toUpperCase(),
      source: "contract_override",
      sourceVersion: priceEditor.sourceVersion.trim(),
      effectiveFrom: new Date(priceEditor.effectiveFrom).toISOString(),
      overrideReason: priceEditor.overrideReason.trim(),
      rates: pricingUnits.filter((item) => priceEditor.prices[item.key] !== "").map((item) => ({ unit: item.key, amountPerUnit: String(priceEditor.prices[item.key]), unitScale: "1000000" })),
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const sourceHash = await hashPricingRecord(record);
      const created = await adminApi.createRateCard({ ...record, sourceHash });
      const refreshed = await adminApi.rateCards();
      setRateCards(refreshed.rateCards ?? []);
      setPriceEditor(null);
      const source = draft?.deployments ?? mapping?.deployments;
      if (source?.length) {
        const nextDraft = {
          revisionNote: draft?.revisionNote ?? `Update ${serviceClassLabels[priceEditor.deployment.serviceClass]} pricing`,
          deployments: source.map((deployment) => deployment.id === priceEditor.deployment.id ? { ...deployment, rateCardId: created.id } : deployment),
        };
        setDraft(nextDraft);
        writeRouteDraft(draftScope, nextDraft);
        setNotice(`Price record ${shortId(created.id)} was created and attached to the local mapping draft. Publish the mapping version to make it available for policy evaluation.`);
      } else {
        setNotice(`Price record ${shortId(created.id)} was created, but no complete mapping was available to attach it.`);
      }
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const PageTitle = onBack ? "h1" : "h2";
  return <div className="secondary-screen routing-admin-screen">
    {onBack && <button className="settings-back-button" type="button" onClick={onBack}>← Back to AI control</button>}
    <header className="page-heading route-page-heading">
      <div>
        <p>AI control</p>
        <PageTitle>Model routes</PageTitle>
        <span>Keep employee-facing choices stable while providers and models change behind the scenes.</span>
      </div>
      <div className="route-heading-actions">
        <div className="route-version"><span>{draft ? "Local draft" : "Latest published mapping"}</span><strong title={draft ? draft.revisionNote : mapping?.id}>{draft ? "Unsaved changes" : shortId(mapping?.id)}</strong></div>
        <button className="secondary-button" type="button" disabled={busy || !providerDeployments.length} onClick={openMappingEditor}>{draft ? "Edit draft" : "Create draft"}</button>
        <button className="primary-button" type="button" disabled={busy || !draft} onClick={() => setPublishOpen(true)}>Publish mapping version</button>
      </div>
    </header>
    <div className="route-api-boundary" role="note"><Info20Regular aria-hidden="true" /><span><strong>Publishing is non-activating.</strong> A new immutable mapping becomes available for Team policy adoption; current Team routes stay pinned until separately saved.</span></div>
    {error && <div className="workspace-error" role="alert"><span><strong>Model routes unavailable</strong>{error}</span></div>}
    {notice && <div className="route-success" role="status"><CheckmarkCircle20Regular aria-hidden="true" /><span>{notice}</span></div>}

    <section className="route-summary-grid" aria-label="Route summary">
      <article><span>Model tiers</span><strong>3</strong><small>Lite, Balanced, Pro</small></article>
      <article><span>Concrete deployments</span><strong>{mappedDeployments.length}</strong><small>Across {new Set(mappedDeployments.map((item) => item.provider)).size} providers</small></article>
      <article className={pricingGapCount ? "has-gap" : ""}><span>Pricing coverage</span><strong>{mappedDeployments.length ? `${mappedDeployments.length - pricingGapCount}/${mappedDeployments.length}` : "—"}</strong><small>{pricingGapCount ? `${pricingGapCount} route${pricingGapCount === 1 ? "" : "s"} need attention` : "All token buckets covered"}</small></article>
      <article><span>Selected Team policy</span><strong>{settings?.policy ? "Configured" : "Not configured"}</strong><small>Balanced remains the safe fallback</small></article>
    </section>

    <section className="route-table-card" aria-labelledby="route-map-heading">
      <div className="route-section-heading"><div><p>Alias map</p><h2 id="route-map-heading">Stable choices, private deployments</h2><span>Prices are the rate card pinned to this mapping version, shown per 1M tokens.</span></div><span className={`route-readonly-badge${draft ? " draft" : ""}`}>{mappingStatus}</span></div>
      <div className="route-table-scroll">
        <table className="route-table">
          <thead><tr><th>Alias</th><th>Provider deployment</th><th>Capabilities</th><th>Health</th><th>Token prices / 1M</th><th>Pricing</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {mappedDeployments.map((deployment) => {
              const card = cardById.get(deployment.rateCardId);
              const coverage = pricingCoverage(card);
              return <tr key={deployment.id}>
                <td><span className={`route-alias ${deployment.serviceClass}`}>{serviceClassLabels[deployment.serviceClass] ?? deployment.serviceClass}</span><small>{serviceClassDescriptions[deployment.serviceClass]}</small></td>
                <td><strong>{providerTitle(deployment.provider)} · {deployment.providerModel}</strong><small>{deployment.providerDeployment}</small></td>
                <td><small className="route-capability-copy">{providerModelCapabilityLabels(deployment.capabilities).join(" · ") || "Not declared"}</small></td>
                <td><RouteHealth deployment={deployment} /></td>
                <td><div className="route-price-grid">{pricingUnits.map((item) => <span key={item.key}><small>{item.label}</small><PriceCell card={card} unit={item.key} /></span>)}</div></td>
                <td>{coverage.complete ? <span className="route-coverage complete"><CheckmarkCircle20Regular aria-hidden="true" />Complete</span> : <span className="route-coverage gap"><ErrorCircle20Regular aria-hidden="true" />{card ? `${coverage.missing.length} gap${coverage.missing.length === 1 ? "" : "s"}` : "No card"}</span>}<small className="route-card-version" title={card?.id}>{card ? card.sourceVersion : "No pinned rate card"}</small></td>
                <td><div className="route-row-actions"><a className="route-text-button" href="?view=ai-control-plane&section=pricing">Manage pricing</a><button type="button" className="route-text-button" disabled={busy} onClick={openMappingEditor}>Edit mapping</button></div></td>
              </tr>;
            })}
            {!loading && !mappedDeployments.length && <tr><td className="route-empty" colSpan={6}><div className="route-empty-state"><Info20Regular aria-hidden="true" /><div><strong>{providerDeployments.length ? "No model routes yet" : "No configured provider deployments"}</strong><span>{providerDeployments.length ? "Assign configured provider deployments to Lite, Balanced, and Pro to create the first mapping." : "Connect a provider and select at least one model before creating routes."}</span></div>{providerDeployments.length ? <button className="primary-button" type="button" onClick={openMappingEditor}>Configure first mapping</button> : <a className="secondary-button" href="?view=ai-control-plane&section=models-providers">Open Models & providers</a>}</div></td></tr>}
          </tbody>
        </table>
      </div>
    </section>

    <section className="route-team-card" aria-labelledby="route-team-heading">
      <div className="route-section-heading"><div><p>Team policy</p><h2 id="route-team-heading">Model-tier eligibility</h2><span>The deployment map is shared. Each Team policy decides which ready tiers its members may choose.</span></div><label className="route-team-picker"><span>Team</span><SelectMenu ariaLabel="Routing Team" value={teamId} options={teams.map((team) => ({ value: team.id, label: team.displayName }))} disabled={busy} onValueChange={setTeamId} /></label></div>
      {settings?.policy ? <>
        <div className="routing-class-grid">{["lite", "balanced", "pro"].map((item) => <label key={item}><input aria-label={serviceClassLabels[item]} type="checkbox" checked={classes.includes(item)} disabled={busy || !settings.policy.identity.allowedServiceClasses.includes(item)} onChange={(event) => setClasses((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} /><strong>{serviceClassLabels[item]}</strong><span>{serviceClassDescriptions[item]}</span></label>)}</div>
        <div className="route-rollout-footer"><button className="secondary-button" type="button" disabled={busy || !classes.length} onClick={savePolicy}>Save Team policy</button></div>
        <p className="route-helper">Members see only allowed tiers with a ready provider route and approved pricing. Balanced is used when no retained explicit choice is valid.</p>
      </> : <div className="route-team-setup">
        <Info20Regular aria-hidden="true" />
        <div><strong>Set up model tiers for {selectedTeam?.displayName ?? "this Team"}</strong><span>Allow explicit Lite, Balanced, and Pro choices while keeping Balanced as the safe fallback.</span>{publishedPricingGapCount > 0 && <small>Complete pricing for all published routes before setup.</small>}</div>
        <button className="primary-button" type="button" disabled={busy || !mapping?.id || (mapping.deployments?.length ?? 0) < 3 || publishedPricingGapCount > 0} onClick={setupTeamRollout}>{busy ? "Setting up…" : "Set up Team policy"}</button>
      </div>}
    </section>

    {mappingEditor && <MappingEditor editor={mappingEditor} inventory={providerDeployments} rateCards={rateCards} busy={busy} onChange={setMappingEditor} onClose={() => setMappingEditor(null)} onSave={saveMappingDraft} />}
    {publishOpen && <ModalDialog title="Publish mapping version?" description="This creates an immutable mapping version for Team policy adoption. Current Team policies stay pinned to their existing mapping." eyebrow="Model routes" labelledBy="route-publish-title" onClose={busy ? () => undefined : () => setPublishOpen(false)}><div className="route-editor-warning"><Info20Regular aria-hidden="true" /><span><strong>No automatic activation.</strong> Adoption happens only when an administrator separately saves a Team policy.</span></div><div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setPublishOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={busy} onClick={publishMapping}>{busy ? "Publishing…" : "Publish mapping version"}</button></div></ModalDialog>}
  </div>;
}
