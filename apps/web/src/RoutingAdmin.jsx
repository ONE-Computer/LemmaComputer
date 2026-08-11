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

const serviceClassLabels = { auto: "Auto", lite: "Lite", balanced: "Balanced", pro: "Pro" };
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
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    const deployments = Array.isArray(parsed?.draft?.deployments)
      ? parsed.draft.deployments.map(storedRouteDeployment)
      : [];
    const classes = new Set(deployments.map((deployment) => deployment?.serviceClass));
    if (parsed?.schemaVersion !== 1
      || typeof parsed?.draft?.revisionNote !== "string"
      || parsed.draft.revisionNote.trim().length < 8
      || parsed.draft.revisionNote.length > 500
      || deployments.some((deployment) => !deployment)
      || deployments.length !== 3
      || classes.size !== 3
      || routeDraftServiceClasses.some((serviceClass) => !classes.has(serviceClass))) {
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
    window.localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), draft }));
    return true;
  } catch {
    return false;
  }
};
const clearRouteDraft = (scope) => {
  const key = routeDraftStorageKey(scope);
  if (!key) return;
  try { window.localStorage.removeItem(key); } catch { /* Browser storage may be unavailable. */ }
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
    title={`New ${serviceClassLabels[editor.deployment.serviceClass]} price version`}
    description="Create immutable pricing evidence for this provider deployment and attach it to a local mapping draft. This does not change a current Team rollout."
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
      <label className="modal-field"><span>Provider account ID</span><input aria-label="Provider account ID" value={editor.providerAccountId} disabled={busy} onChange={(event) => onChange({ ...editor, providerAccountId: event.target.value })} /></label>
      <label className="modal-field"><span>Currency</span><input aria-label="Pricing currency" value={editor.currency} maxLength={3} disabled={busy} onChange={(event) => onChange({ ...editor, currency: event.target.value.toUpperCase() })} /></label>
      {pricingUnits.map((item) => <label className="modal-field" key={item.key}><span>{item.label} / 1M tokens{item.key.startsWith("cache") ? " (optional)" : ""}</span><input aria-label={`${item.label} price per 1M tokens`} type="number" min="0" step="0.0001" value={editor.prices[item.key]} disabled={busy} onChange={(event) => updateRate(item.key, event.target.value)} /></label>)}
      <label className="modal-field"><span>Version label</span><input aria-label="Price version label" value={editor.sourceVersion} disabled={busy} onChange={(event) => onChange({ ...editor, sourceVersion: event.target.value })} /></label>
      <label className="modal-field"><span>Effective from</span><input aria-label="Price effective from" type="datetime-local" value={editor.effectiveFrom} disabled={busy} onChange={(event) => onChange({ ...editor, effectiveFrom: event.target.value })} /></label>
      <label className="modal-field route-price-reason"><span>Approval reason</span><textarea aria-label="Price approval reason" value={editor.overrideReason} disabled={busy} onChange={(event) => onChange({ ...editor, overrideReason: event.target.value })} /></label>
    </div>
    <div className="route-editor-warning"><Info20Regular aria-hidden="true" /><span>The new record is staged in a local mapping draft. Publish that mapping version separately for policy and shadow evaluation.</span></div>
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
  const deploymentsValid = editor.deployments.length >= 3 && editor.deployments.every((item) => item.provider && item.providerModel.trim() && item.providerDeployment.trim());
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
          if (!selected) return;
          updateDeployment(deployment.id, {
            ...selected,
            id: deployment.id,
            serviceClass: deployment.serviceClass,
            rateCardId: latestRateCardForDeployment(rateCards, selected)?.id ?? "",
          });
        };
        return <section key={deployment.id} className="route-mapping-editor-row" aria-labelledby={`route-editor-${deployment.serviceClass}`}>
          <header><span className={`route-alias ${deployment.serviceClass}`} id={`route-editor-${deployment.serviceClass}`}>{serviceClassLabels[deployment.serviceClass]}</span><small>{serviceClassDescriptions[deployment.serviceClass]}</small></header>
          <label className="modal-field"><span>Provider deployment</span><SelectMenu ariaLabel={`${serviceClassLabels[deployment.serviceClass]} provider deployment`} value={selectedDeployment?.id ?? ""} options={inventory.map((item) => ({ value: item.id, label: providerDeploymentLabel(item) }))} disabled={busy} onValueChange={selectProviderDeployment} />{providerModelCapabilityLabels(selectedDeployment?.modelCapabilities).length > 0 && <small className="route-model-capabilities">Inherited model capabilities: {providerModelCapabilityLabels(selectedDeployment.modelCapabilities).join(" · ")}</small>}</label>
          <label className="modal-field route-editor-rate"><span>Pinned price record</span><SelectMenu ariaLabel={`${serviceClassLabels[deployment.serviceClass]} price record`} value={deployment.rateCardId ?? ""} options={[{ value: "", label: "No price record" }, ...compatibleCards.map((card) => ({ value: card.id, label: `${card.sourceVersion} · ${card.currency}` }))]} disabled={busy} onValueChange={(rateCardId) => updateDeployment(deployment.id, { rateCardId })} /></label>
        </section>;
      })}
    </div>
    {!valid && <div className="route-editor-validation" role="status" aria-live="polite"><Info20Regular aria-hidden="true" /><span>{!revisionValid ? revisionLength ? `Add ${remainingRevisionCharacters} more character${remainingRevisionCharacters === 1 ? "" : "s"} to the revision note to save this draft.` : `Add a revision note of at least ${minimumRevisionLength} characters to save this draft.` : "Select a valid provider deployment for Lite, Balanced, and Pro."}</span></div>}
    <div className="route-editor-warning"><Info20Regular aria-hidden="true" /><span>Publishing creates a version for policy and shadow evaluation. It does not activate or repoint any current Team rollout.</span></div>
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
  const [report, setReport] = useState(null);
  const [rateCards, setRateCards] = useState([]);
  const [mapping, setMapping] = useState(null);
  const [draft, setDraft] = useState(() => readRouteDraft(draftScope));
  const [providers, setProviders] = useState([]);
  const [classes, setClasses] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [enableOpen, setEnableOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewPassed, setReviewPassed] = useState(false);
  const [detail, setDetail] = useState(null);
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
      : currentMappingRollout?.mode === "enabled"
        ? "Active for selected Team"
        : currentMappingRollout?.mode === "shadow"
          ? "Shadow evaluation"
          : currentMappingRollout?.mode === "disabled"
            ? "Fixed route active"
            : settings?.policy?.mappingVersionId === mapping.id
              ? "Ready for shadow"
              : "Published · not active";
  const autoPolicyStatus = settings?.rollout?.mode === "enabled"
    ? { label: "Policy active", className: "healthy", icon: CheckmarkCircle20Regular }
    : settings?.rollout?.mode === "shadow"
      ? { label: "Shadow evaluation", className: "unknown", icon: Info20Regular }
      : settings?.rollout?.mode === "disabled"
        ? { label: "Fixed route active", className: "healthy", icon: CheckmarkCircle20Regular }
        : settings?.policy
          ? { label: "Ready for shadow", className: "unknown", icon: Info20Regular }
          : { label: "Policy not configured", className: "unknown", icon: Info20Regular };
  const AutoPolicyStatusIcon = autoPolicyStatus.icon;

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
      const [current, shadow] = await Promise.all([adminApi.routingSettings(id), adminApi.routingShadowReport(id)]);
      setSettings(current);
      setReport(shadow);
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
    `${selectedTeam?.displayName ?? "Team"} can use Auto now through its fixed Balanced route. Shadow evaluation is optional.`,
  );
  const rollout = (mode, confirmation) => run(() => {
    const fixedDeploymentId = settings.rollout?.fixedDeploymentId
      ?? settings.deployments.find((deployment) => deployment.serviceClass === "balanced")?.id
      ?? settings.deployments[0]?.id;
    if (!fixedDeploymentId) throw new Error("Choose a valid fixed fallback deployment before starting rollout.");
    return adminApi.changeRoutingRollout(teamId, {
      policyVersionId: settings.policy.id,
      mappingVersionId: settings.policy.mappingVersionId,
      mode,
      fixedDeploymentId,
      ...(mode === "enabled" && settings.review?.id ? { evidenceReviewId: settings.review.id } : {}),
      reason: mode === "shadow" ? "Administrator started bounded shadow evaluation" : "Administrator reviewed evidence and enabled governed Auto routing",
      ...(confirmation ? { confirmation } : {}),
    });
  }, mode === "shadow" ? "Shadow evaluation started for this Team." : "");
  const enable = async () => {
    if (await rollout("enabled", "ENABLE AUTO ROUTING")) {
      setEnableOpen(false);
      setConfirmed(false);
      setNotice("Production routing enabled for this Team.");
    }
  };
  const kill = () => run(() => adminApi.routingKillSwitch(teamId, { reason: "Administrator activated the immediate routing kill switch" }), "Kill switch activated. The prior fixed route is restored.");
  const review = async () => {
    if (await run(() => adminApi.saveRoutingReview(teamId, { evaluationPassed: reviewPassed, reviewNote }), "Evidence review recorded.")) {
      setReviewOpen(false);
      setReviewNote("");
      setReviewPassed(false);
    }
  };
  const openDecision = async (id) => {
    setError("");
    try { setDetail(await adminApi.routingDecision(id)); } catch (caught) { setError(caught.message); }
  };
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
      setNotice("Published for policy/shadow evaluation; current Team rollouts are unchanged.");
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
    <div className="route-api-boundary" role="note"><Info20Regular aria-hidden="true" /><span><strong>Publishing is non-activating.</strong> A new immutable mapping becomes available for policy and shadow evaluation; current Team rollouts stay pinned until separately reviewed.</span></div>
    {error && <div className="workspace-error" role="alert"><span><strong>Model routes unavailable</strong>{error}</span></div>}
    {notice && <div className="route-success" role="status"><CheckmarkCircle20Regular aria-hidden="true" /><span>{notice}</span></div>}

    <section className="route-summary-grid" aria-label="Route summary">
      <article><span>Employee aliases</span><strong>4</strong><small>Auto, Lite, Balanced, Pro</small></article>
      <article><span>Concrete deployments</span><strong>{mappedDeployments.length}</strong><small>Across {new Set(mappedDeployments.map((item) => item.provider)).size} providers</small></article>
      <article className={pricingGapCount ? "has-gap" : ""}><span>Pricing coverage</span><strong>{mappedDeployments.length ? `${mappedDeployments.length - pricingGapCount}/${mappedDeployments.length}` : "—"}</strong><small>{pricingGapCount ? `${pricingGapCount} route${pricingGapCount === 1 ? "" : "s"} need attention` : "All token buckets covered"}</small></article>
      <article><span>Selected Team rollout</span><strong className={`routing-mode ${settings?.rollout?.mode ?? "disabled"}`}>{settings?.rollout?.mode ?? "not configured"}</strong><small>Team-specific, mapping remains shared</small></article>
    </section>

    <section className="route-table-card" aria-labelledby="route-map-heading">
      <div className="route-section-heading"><div><p>Alias map</p><h2 id="route-map-heading">Stable choices, private deployments</h2><span>Prices are the rate card pinned to this mapping version, shown per 1M tokens.</span></div><span className={`route-readonly-badge${draft ? " draft" : ""}`}>{mappingStatus}</span></div>
      <div className="route-table-scroll">
        <table className="route-table">
          <thead><tr><th>Alias</th><th>Provider deployment</th><th>Capabilities</th><th>Health</th><th>Token prices / 1M</th><th>Pricing</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {!!mappedDeployments.length && <tr className="route-auto-row"><td><span className="route-alias auto">Auto</span><small>Recommended default</small></td><td><strong>Task-based route selection</strong><small>Chooses Lite, Balanced, or Pro within policy</small></td><td><small className="route-capability-copy">Inherits the selected route</small></td><td><span className={`route-health ${autoPolicyStatus.className}`}><AutoPolicyStatusIcon aria-hidden="true" />{autoPolicyStatus.label}</span></td><td><span className="route-auto-pricing">Uses the selected tier’s pinned price</span></td><td><span className="route-coverage complete"><CheckmarkCircle20Regular aria-hidden="true" />Inherited</span></td><td><button type="button" className="route-text-button" disabled={busy || !mappedDeployments.length} onClick={openMappingEditor}>Edit mapping</button></td></tr>}
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
      <div className="route-section-heading"><div><p>Team rollout</p><h2 id="route-team-heading">Eligibility and controlled release</h2><span>The deployment map is shared. Eligibility, evidence, and rollout are scoped to the selected Team.</span></div><label className="route-team-picker"><span>Team</span><SelectMenu ariaLabel="Routing Team" value={teamId} options={teams.map((team) => ({ value: team.id, label: team.displayName }))} disabled={busy} onValueChange={setTeamId} /></label></div>
      {settings?.policy ? <>
        <div className="routing-class-grid">{["lite", "balanced", "pro"].map((item) => <label key={item}><input aria-label={serviceClassLabels[item]} type="checkbox" checked={classes.includes(item)} disabled={busy || !settings.policy.identity.allowedServiceClasses.includes(item)} onChange={(event) => setClasses((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} /><strong>{serviceClassLabels[item]}</strong><span>{serviceClassDescriptions[item]}</span></label>)}</div>
        <div className="route-rollout-footer"><button className="secondary-button" type="button" disabled={busy || !classes.length} onClick={savePolicy}>Save Team policy</button><div className="routing-actions"><button className="secondary-button" type="button" disabled={busy || !report?.sampleSize} onClick={() => setReviewOpen(true)}>Review evidence</button><button className="secondary-button" type="button" disabled={busy || settings?.rollout?.mode === "shadow"} onClick={() => rollout("shadow")}>Start shadow mode</button><button className="primary-button" type="button" disabled={busy || !settings?.review?.evaluationPassed} onClick={() => setEnableOpen(true)}>Enable production routing</button><button className="connection-quiet-button danger-button" type="button" disabled={busy || !settings?.rollout || settings.rollout.mode === "disabled"} onClick={kill}>Activate kill switch</button></div></div>
        {!settings?.review?.evaluationPassed && <p className="route-helper">{settings?.rollout?.mode === "shadow" ? "Collect representative requests, then review the shadow evidence before enabling production." : "Start shadow mode to collect evidence before enabling production routing."}</p>}
      </> : <div className="route-team-setup">
        <Info20Regular aria-hidden="true" />
        <div><strong>Set up routing for {selectedTeam?.displayName ?? "this Team"}</strong><span>Start with a safe fixed Balanced route so Auto works immediately. Shadow evaluation is optional and only needed before dynamic model selection.</span>{publishedPricingGapCount > 0 && <small>Complete pricing for all published routes before setup.</small>}</div>
        <button className="primary-button" type="button" disabled={busy || !mapping?.id || (mapping.deployments?.length ?? 0) < 3 || publishedPricingGapCount > 0} onClick={setupTeamRollout}>{busy ? "Setting up…" : "Set up Team rollout"}</button>
      </div>}
    </section>

    <section className="route-evidence-card" aria-labelledby="routing-evidence-heading">
      <div className="route-section-heading"><div><p>Shadow evidence</p><h2 id="routing-evidence-heading">Enablement report</h2></div><small>{report?.sampleSize ? `${report.sampleSize} observed requests` : "No observations yet"}</small></div>
      <div className="routing-metrics"><div><span>Estimated savings</span><strong>{money(report?.estimatedSavings, report?.currency)}</strong></div><div><span>Fallback rate</span><strong>{Number(report?.fallbackRate ?? 0).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 })}</strong></div><div><span>Error rate</span><strong>{Number(report?.errorRate ?? 0).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 })}</strong></div><div><span>Regret / override</span><strong>{Number(report?.regretRate ?? 0).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 })}</strong></div><div><span>Router overhead</span><strong>{Number(report?.routerOverheadMs ?? 0).toFixed(2)} ms</strong></div></div>
      <div className="routing-decisions" role="region" aria-label="Recent routing decisions">{report?.decisions?.map((item) => <button type="button" key={item.id} onClick={() => openDecision(item.id)}><span>{serviceClassLabels[item.selectedServiceClass] ?? item.selectedServiceClass}</span><strong>{item.reasonCode.replaceAll("_", " ")}</strong><small>{money(item.expectedCost, item.currency)} · {item.outcome ?? "outcome pending"}</small></button>)}</div>
    </section>

    {mappingEditor && <MappingEditor editor={mappingEditor} inventory={providerDeployments} rateCards={rateCards} busy={busy} onChange={setMappingEditor} onClose={() => setMappingEditor(null)} onSave={saveMappingDraft} />}
    {publishOpen && <ModalDialog title="Publish mapping version?" description="This creates an immutable mapping version for policy and shadow evaluation. Current Team policies and rollouts remain pinned to their existing mapping." eyebrow="Model routes" labelledBy="route-publish-title" onClose={busy ? () => undefined : () => setPublishOpen(false)}><div className="route-editor-warning"><Info20Regular aria-hidden="true" /><span><strong>No automatic activation.</strong> Review and adoption happen through each Team’s controlled policy and rollout workflow.</span></div><div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setPublishOpen(false)}>Cancel</button><button type="button" className="primary-button" disabled={busy} onClick={publishMapping}>{busy ? "Publishing…" : "Publish mapping version"}</button></div></ModalDialog>}
    {enableOpen && <ModalDialog title="Enable production routing?" description="Auto will replace the fixed route for this Team. The reviewed mapping and policy stay pinned, and the kill switch remains available." eyebrow="Controlled rollout" labelledBy="route-enable-title" onClose={busy ? () => undefined : () => setEnableOpen(false)}><label className="route-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the shadow evidence and understand this changes the executed deployment.</label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setEnableOpen(false)}>Cancel</button><button className="primary-button" type="button" disabled={!confirmed || busy} onClick={enable}>Enable Auto routing</button></div></ModalDialog>}
    {reviewOpen && <ModalDialog title="Record administrator review" description="This immutable review records the current sample and rollout thresholds." eyebrow="Shadow evidence" labelledBy="route-review-title" onClose={busy ? () => undefined : () => setReviewOpen(false)}><label className="modal-field"><span>Review note</span><textarea aria-label="Routing review note" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label><label className="route-confirm"><input type="checkbox" checked={reviewPassed} onChange={(event) => setReviewPassed(event.target.checked)} /> Evidence passed the configured evaluation threshold.</label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setReviewOpen(false)}>Cancel</button><button className="primary-button" type="button" disabled={busy || reviewNote.trim().length < 8} onClick={review}>Record review</button></div></ModalDialog>}
    {detail && <ModalDialog title="Routing decision" description="The provider deployment and immutable evidence used for this governed request." eyebrow="Administrator evidence" labelledBy="route-decision-title" onClose={() => setDetail(null)}><dl className="route-decision-list"><div><dt>Selected class</dt><dd>{serviceClassLabels[detail.selected_service_class] ?? detail.selected_service_class}</dd></div><div><dt>Reason</dt><dd>{String(detail.reason_code).replaceAll("_", " ")}</dd></div><div><dt>Executed provider</dt><dd>{detail.executed_provider}</dd></div><div><dt>Provider model</dt><dd>{detail.executed_model}</dd></div><div><dt>Deployment</dt><dd>{detail.executed_provider_deployment}</dd></div><div><dt>Mapping version</dt><dd>{detail.mapping_version_id}</dd></div><div><dt>Rate card</dt><dd>{detail.rate_card_id}</dd></div></dl><h3>Candidate evidence</h3><ul className="route-candidates">{detail.candidates?.map((item) => <li key={`${item.ordinal}-${item.deployment_id}`}>{item.provider_deployment}: {item.eligibility}{item.reason_code ? ` (${item.reason_code})` : ""}</li>)}</ul><div className="modal-actions"><button className="primary-button" type="button" onClick={() => setDetail(null)}>Close details</button></div></ModalDialog>}
  </div>;
}
