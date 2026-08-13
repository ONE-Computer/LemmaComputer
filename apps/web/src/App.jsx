import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import QRCode from "react-qr-code";
import { Home24Filled, Home24Regular } from "@fluentui/react-icons/svg/home";
import { Apps24Filled, Apps24Regular, Apps48Regular } from "@fluentui/react-icons/svg/apps";
import { WindowApps24Regular } from "@fluentui/react-icons/svg/window-apps";
import { Clock24Regular } from "@fluentui/react-icons/svg/clock";
import { Calendar24Regular } from "@fluentui/react-icons/svg/calendar";
import { Open24Regular } from "@fluentui/react-icons/svg/open";
import { ArrowClockwise24Regular } from "@fluentui/react-icons/svg/arrow-clockwise";
import { CheckmarkCircle24Regular } from "@fluentui/react-icons/svg/checkmark-circle";
import { Laptop24Regular, Laptop48Regular } from "@fluentui/react-icons/svg/laptop";
import { Delete24Regular } from "@fluentui/react-icons/svg/delete";
import { Person24Regular } from "@fluentui/react-icons/svg/person";
import { ChevronDown16Regular } from "@fluentui/react-icons/svg/chevron-down";
import { ChevronRight16Regular } from "@fluentui/react-icons/svg/chevron-right";
import { Checkmark16Filled } from "@fluentui/react-icons/svg/checkmark";
import { ArrowLeft24Regular } from "@fluentui/react-icons/svg/arrow-left";
import { ArrowUp24Regular } from "@fluentui/react-icons/svg/arrow-up";
import { Add24Regular } from "@fluentui/react-icons/svg/add";
import { Attach24Regular } from "@fluentui/react-icons/svg/attach";
import { Dismiss16Regular, Dismiss24Regular } from "@fluentui/react-icons/svg/dismiss";
import { Document24Regular } from "@fluentui/react-icons/svg/document";
import { Navigation24Regular } from "@fluentui/react-icons/svg/navigation";
import { ShieldCheckmark24Regular } from "@fluentui/react-icons/svg/shield-checkmark";
import { Info24Regular } from "@fluentui/react-icons/svg/info";
import { Eye24Regular } from "@fluentui/react-icons/svg/eye";
import { EyeOff24Regular } from "@fluentui/react-icons/svg/eye-off";
import { Bot24Regular } from "@fluentui/react-icons/svg/bot";
import { PlugConnected24Regular } from "@fluentui/react-icons/svg/plug-connected";
import { Settings24Regular } from "@fluentui/react-icons/svg/settings";
import { SignOut24Regular } from "@fluentui/react-icons/svg/sign-out";
import { Search24Regular } from "@fluentui/react-icons/svg/search";
import { operationApi, workspaceApi, sandboxApi, connectionApi, approvalApi, authApi, adminApi, chatApi, scheduleApi, siteApi, skillApi } from "./workspace-api.js";
import { SpendDashboard } from "./SpendDashboard.jsx";
import { UsageDataHealth } from "./UsageDataHealth.jsx";
import { RoutingAdmin } from "./RoutingAdmin.jsx";
import { AiControlPlane, aiControlPlaneTabs } from "./AiControlPlane.jsx";
import { AiControlPlaneOverview } from "./AiControlPlaneOverview.jsx";
import { emissionsRegionOptions } from "./ai-emissions.js";
import { clipboardStatusForBrowser } from "./clipboard-status.js";
import {
  clearBrowserApprover,
  enrollBrowserApprover,
  getBrowserApproverIdentity,
  hasBrowserApprover,
  loadPendingApproval,
  signApprovalDecision,
} from "./openvtc-browser-agent.js";
import { ConfirmDialog, ModalDialog, SelectMenu, TextPromptDialog, useDismissOnOutside } from "./ui.jsx";
import { ActivityPanel, ActivityToggle } from "./ActivityPanel.jsx";
import { providerModelCapabilityLabels } from "./provider-inventory.js";
import { customerPasskeyApi } from "./customer-auth-client.js";
import { reconcileWorkspaceInventory, replaceWorkspaceInInventory } from "./workspace-inventory.js";

const busyStates = new Set(["loading", "provisioning", "restarting", "stopping"]);
const providerTitle = (provider) => ({
  openai: "OpenAI",
  anthropic: "Anthropic",
  glm: "GLM (Z.ai)",
  bedrock: "Amazon Bedrock",
}[provider] ?? provider);
const emissionsRegionLabel = (region) => emissionsRegionOptions.find((option) => option.value === region)?.label ?? null;
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
const operationStateLabels = {
  approval_required: "waiting for approval",
  approved: "approved",
  executing: "executing",
  succeeded: "completed",
  denied: "denied",
  failed: "failed",
  expired: "expired",
};
const navByView = Object.freeze({
  home: "Workspace",
  schedules: "Schedules",
  sites: "Sites",
  chat: "Chat",
  trail: "Trail",
  firewall: "Firewall",
  connections: "Connections",
  settings: "Settings",
  "ai-control-plane": "AI control plane",
});
const viewByNav = Object.freeze(Object.fromEntries(
  Object.entries(navByView).map(([view, name]) => [name, view]),
));
const chatAttachmentMaxFiles = 4;
const chatAttachmentMaxBytes = 8 * 1024 * 1024;
const chatAttachmentMaxTotalBytes = 16 * 1024 * 1024;
const restoredChatTurnMaxAgeMs = 16 * 60 * 1000;
const chatServiceClassOptions = [
  { value: "auto", label: "Auto (Beta) · Balanced unless Team-enabled" },
  { value: "lite", label: "Lite · lowest cost" },
  { value: "balanced", label: "Balanced · everyday work" },
  { value: "pro", label: "Pro · highest capability" },
];
const chatServiceClassLabel = Object.fromEntries(chatServiceClassOptions.map((item) => [item.value, item.label.split(" · ")[0]]));
const chatServiceClassValues = new Set(chatServiceClassOptions.map((item) => item.value));
const workspaceModelNames = {
  "lemmacomputer-auto": "Governed routing",
  "lemmacomputer-claude": "Claude",
  "lemmacomputer-openai": "OpenAI",
  "lemmacomputer-glm": "GLM",
  "lemmacomputer-bedrock": "Amazon Bedrock",
  "lemmacomputer-assistant": "Standard route",
};
const workspaceModelName = (alias) => workspaceModelNames[alias] ?? alias;
const chatAttachmentTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/json",
  "application/xml",
  "application/yaml",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/xml",
  "text/yaml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const chatAttachmentTypeByExtension = {
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  txt: "text/plain",
  log: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  py: "text/plain",
  java: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  sh: "text/plain",
  sql: "text/plain",
  css: "text/plain",
  html: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const signInErrorByReason = {
  OIDC_DENIED: "Microsoft sign-in was cancelled or denied.",
  OIDC_CALLBACK_INVALID: "Microsoft returned an incomplete sign-in response.",
  OIDC_STATE_MISMATCH: "Sign-in returned to a different browser origin. Start again from this page.",
  OIDC_STATE_EXPIRED: "The sign-in attempt expired or was already used. Please try again.",
  OIDC_TOKEN_EXCHANGE_FAILED: "Microsoft rejected the authorization-code exchange. Check the configured callback URL.",
  OIDC_ID_TOKEN_MISSING: "Microsoft did not return an identity token.",
  OIDC_ID_TOKEN_INVALID: "Microsoft returned an identity token that could not be verified.",
  OIDC_NONCE_MISMATCH: "Microsoft returned an identity token for a different sign-in attempt.",
  OIDC_IDENTITY_INVALID: "This Microsoft identity is not allowed for the configured tenant.",
  OIDC_STATE_INVALID: "The saved sign-in state could not be decrypted.",
  SOCIAL_SIGNIN_FAILED: "The provider authenticated this account, but LemmaComputer could not finish sign-in. If your email still needs verification, try the provider again and resend the verification email.",
  INVITATION_SIGNIN_FAILED: "This invitation cannot be used. Ask your organization administrator for a new invitation.",
  EXTERNAL_ID_SIGNIN_FAILED: "Microsoft could not complete this sign-in. Check the account or ask your organization administrator for a new invitation.",
  OIDC_FAILED: "LemmaComputer could not finish the sign-in bootstrap.",
};
const socialProviderNameById = {
  google: "Google",
  microsoft: "Microsoft",
};
const socialSignInErrorMessage = (error, provider) => {
  if (error !== "account_not_linked") return null;
  const providerName = socialProviderNameById[provider] ?? "that provider";
  return `An account already exists for this email. Sign in using its existing method, then open Manage account security and link ${providerName}.`;
};
const socialLinkErrorMessage = (provider) => {
  const providerName = socialProviderNameById[provider] ?? "The provider";
  return `${providerName} could not be linked to this account. Try again from Manage account security.`;
};
const safeSsoProviderErrorDetail = (description) => {
  let normalized = String(description ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // URLSearchParams normally decodes this already. Keep the bounded original
    // when a provider returns a malformed percent-encoded description.
  }
  return normalized.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 320);
};
const ssoTestProviderErrorMessage = (error, description) => {
  const safeDescription = safeSsoProviderErrorDetail(description);
  const microsoftReference = safeDescription.match(/\bAADSTS\d+\b/i)?.[0]?.toUpperCase() ?? "";
  const referenceSuffix = microsoftReference ? ` Microsoft reference: ${microsoftReference}` : "";
  if (error === "access_denied") return `The provider sign-in was cancelled. No Company SSO settings were changed.${referenceSuffix}`;
  if (error === "discovery_failed") return `LemmaComputer could not load the provider metadata. Confirm the issuer URL, refresh metadata, and test again.${referenceSuffix}`;
  if (error === "invalid_provider" && safeDescription === "provider not found") {
    return "The saved authentication provider could not be found. Disconnect this connection and configure it again.";
  }
  if (error === "invalid_provider" && ["token_response_not_found", "token_not_verified"].includes(safeDescription)) {
    return "Microsoft did not return a usable sign-in token. Confirm the Application (client) ID, client secret value, and exact OIDC redirect URI, then test again.";
  }
  if (error === "invalid_provider" && safeDescription === "token_endpoint_not_found") {
    return "The provider metadata does not include a token endpoint. Confirm the issuer URL, refresh metadata, and test again.";
  }
  if (error === "invalid_provider" && microsoftReference === "AADSTS7000215") {
    return `Microsoft rejected the client secret. Paste the secret value, not its Secret ID, then test again.${referenceSuffix}`;
  }
  if (error === "invalid_provider" && microsoftReference === "AADSTS7000222") {
    return `The Microsoft client secret has expired. Create a new secret value, rotate the saved credentials, and test again.${referenceSuffix}`;
  }
  if (error === "invalid_provider" && microsoftReference === "AADSTS700016") {
    return `Microsoft could not find this application in the configured directory. Confirm the Directory (tenant) ID and Application (client) ID are different values from the same app registration.${referenceSuffix}`;
  }
  if (error === "invalid_provider") {
    const detailSuffix = safeDescription ? ` Provider response: ${safeDescription}` : "";
    return `The provider rejected the saved Company SSO configuration.${detailSuffix}${referenceSuffix}`;
  }
  const detailSuffix = safeDescription ? ` Provider response: ${safeDescription}` : "";
  return `Company SSO provider sign-in was not completed. No saved connection settings were changed.${detailSuffix}${referenceSuffix}`;
};
const ssoTestConnectionIdFromLocation = () => {
  const match = window.location.pathname.match(/^\/sso-test\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
};
const attachmentMediaType = (file) => {
  if (chatAttachmentTypes.has(file.type)) return file.type;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return chatAttachmentTypeByExtension[extension] ?? null;
};
const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
  reader.readAsDataURL(file);
});
const attachmentSize = (bytes) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const navFromLocation = () => {
  if (ssoTestConnectionIdFromLocation()) return "Settings";
  const view = new URLSearchParams(window.location.search).get("view") ?? "home";
  return navByView[view] ?? "Workspace";
};
const workspaceSections = new Set(["mine", "organization", "policies"]);
const workspaceSectionFromLocation = () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") && params.get("view") !== "home") return "mine";
  const section = params.get("section") ?? "mine";
  return workspaceSections.has(section) ? section : "mine";
};
const settingsSectionByView = Object.freeze({
  admin: "people",
  credentials: "credentials",
  security: "security",
});
const settingsViewBySection = Object.freeze({
  people: "admin",
  credentials: "credentials",
  security: "security",
});
const settingsSectionFromLocation = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "settings" ? params.get("section") ?? "" : "";
};
const settingsViewFromLocation = () => {
  if (ssoTestConnectionIdFromLocation()) return "admin";
  return settingsViewBySection[settingsSectionFromLocation()] ?? "overview";
};
const accountSecurityOpenFromLocation = () => settingsSectionFromLocation() === "security";
const aiControlPlaneViews = new Set([...aiControlPlaneTabs.map((tab) => tab.id), "spend"]);
const aiControlPlaneViewFromLocation = () => {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("section") ?? "overview";
  return params.get("view") === "ai-control-plane" && aiControlPlaneViews.has(view) ? view : "overview";
};
const chatSessionFromLocation = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "chat" ? params.get("chat") ?? "" : "";
};

const operationTime = (value) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(value));

function NavButton({ active, icon: Icon, label, onClick }) {
  return (
    <button
      className={`nav-button${active ? " active" : ""}`}
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function Drawer({ title, children, onClose }) {
  const drawerRef = useRef(null);
  const closeButtonRef = useRef(null);
  const closeHandlerRef = useRef(onClose);

  // The parent refreshes operation data while this panel is open. Keep the
  // current close handler without re-running the focus setup on each refresh:
  // focusing the close button causes the browser to scroll this panel to top.
  closeHandlerRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHandlerRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...(drawerRef.current?.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])];
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0].focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <h2 id="drawer-title">{title}</h2>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={onClose} aria-label="Close panel">
            <Dismiss24Regular aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

const applicationNames = {
  firefox: "Firefox ESR",
  "google-chrome": "Google Chrome",
};

const workspaceStatus = (state) => ({
  not_created: "Not started",
  provisioning: "Preparing",
  ready: "Ready",
  open: "Running",
  restarting: "Restarting",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Needs attention",
}[state] ?? "Unknown");

const policyStatus = (workspace) => ({
  match: "Verified",
  drift: "Mismatch",
  expired: "Refresh required",
  invalid: "Invalid",
  unavailable: "Unverified",
}[workspace.policyIntegrity?.state] ?? (workspace.policyAssignment ? "Assigned" : "Not assigned"));

function WorkspaceAssignment({ label, icon: Icon, children, detail }) {
  return (
    <div className="workspace-assignment">
      <span className="workspace-assignment-icon"><Icon aria-hidden="true" /></span>
      <div>
        <small>{label}</small>
        {children}
        {detail && <span className="workspace-assignment-detail">{detail}</span>}
      </div>
    </div>
  );
}

function WorkspaceScreen({ section, workspaces, loading, apiError, actionWorkspaceId, canCreateWorkspace, canManageWorkspace, canManageAnyWorkspace, canManagePolicy, onSectionChange, onOpen, onRestart, onStop, onDelete, onCreate, onManage, workspaceMembers, adminLoading, workspaceError, workspaceBusyId, onWorkspaceCommand, policyUsers, onConfigureConnections }) {
  const organizationSection = section === "organization" && canManageAnyWorkspace;
  const policySection = section === "policies" && canManagePolicy;
  return (
    <div className="home-screen workspace-overview">
      <header className="page-heading workspace-overview-heading">
        <div>
          <p>{organizationSection || policySection ? "Organization administration" : "Your workspace"}</p>
          <h1>Workspace</h1>
          <span>{organizationSection
            ? "Monitor and manage member workspace runtimes. Workspace contents remain private to each member."
            : policySection
              ? "Review the locked product baseline, set stricter organization limits, and keep member assignments current."
              : "Create and manage the workspaces available to you."}</span>
        </div>
        {!organizationSection && !policySection && canCreateWorkspace && <button className="primary-button create-workspace-button" type="button" onClick={onCreate}>
          <Add24Regular aria-hidden="true" />Create workspace
        </button>}
      </header>

      {(canManageAnyWorkspace || canManagePolicy) && <nav className="workspace-page-tabs" aria-label="Workspace sections">
        <button type="button" className={section === "mine" ? "active" : ""} aria-current={section === "mine" ? "page" : undefined} onClick={() => onSectionChange("mine")}>My workspaces</button>
        {canManageAnyWorkspace && <button type="button" className={organizationSection ? "active" : ""} aria-current={organizationSection ? "page" : undefined} onClick={() => onSectionChange("organization")}>Organization workspaces</button>}
        {canManagePolicy && <button type="button" className={policySection ? "active" : ""} aria-current={policySection ? "page" : undefined} onClick={() => onSectionChange("policies")}>Workspace policies</button>}
      </nav>}

      {organizationSection ? <MemberWorkspaceConsole members={workspaceMembers} loading={adminLoading} error={workspaceError} busyWorkspaceId={workspaceBusyId} onCommand={onWorkspaceCommand} />
        : policySection ? <ProtectedWorkspacePolicySection users={policyUsers} onConfigureConnections={onConfigureConnections} />
          : <>

      {apiError && <div className="workspace-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Workspace service unavailable</strong>{apiError}</span></div>}

      {loading ? (
        <div className="workspace-overview-empty" role="status">Loading your workspaces…</div>
      ) : workspaces.length === 0 ? (
        <section className="workspace-overview-empty">
          <Laptop48Regular aria-hidden="true" />
          <div><h2>No workspaces yet</h2><p>Create a workspace to choose its applications, agents, model, and policy.</p></div>
        </section>
      ) : (
        <section className="workspace-overview-list" aria-label="Your workspaces">
          {workspaces.map((workspace) => {
            const busy = actionWorkspaceId === workspace.id || busyStates.has(workspace.state);
            const primaryLabel = ["not_created", "stopped", "failed"].includes(workspace.state)
              ? "Start workspace"
              : workspace.state === "open" ? "Return to workspace" : busy ? "Preparing workspace" : "Open workspace";
            const model = workspaceModelName(workspace.modelRoute?.alias ?? workspace.profile?.modelAlias ?? "Not assigned");
            const apps = workspace.applications?.map((application) => applicationNames[application] ?? application) ?? [];
            const agents = workspace.agents ?? [];
            const titleId = `workspace-${workspace.id}`;

            return (
              <article className={`workspace-overview-card${workspace.profile?.executionMode === "disposable-open" ? " disposable-open" : ""}`} key={workspace.id} aria-labelledby={titleId}>
                <header className="workspace-card-header">
                  <span className={`workspace-card-icon${busy ? " busy" : ""}`}><Laptop24Regular aria-hidden="true" /></span>
                  <div className="workspace-card-title">
                    <h2 id={titleId}>{workspaceName(workspace)}</h2>
                    <p>{workspace.profile?.executionMode === "disposable-open" ? "Disposable open · non-sensitive work" : workspace.grantId === "personal" ? "Personal managed workspace" : "Managed workspace"}</p>
                  </div>
                  <span className={`workspace-state state-${workspace.state}`}>{workspaceStatus(workspace.state)}</span>
                </header>

                <div className="workspace-assignment-grid" aria-label={`Assignments for ${workspaceName(workspace)}`}>
                  <WorkspaceAssignment label="Apps" icon={Laptop24Regular} detail={apps.length ? undefined : "No apps assigned"}>
                    {apps.length > 0 && <div className="workspace-assignment-tags">{apps.map((app) => <span key={app}>{app}</span>)}</div>}
                  </WorkspaceAssignment>
                  <WorkspaceAssignment label="Agents" icon={Bot24Regular} detail={agents.length ? undefined : "No agents assigned"}>
                    {agents.length > 0 && <div className="workspace-assignment-tags">{agents.map((agent) => <span key={agent.id}>{agent.displayName}</span>)}</div>}
                  </WorkspaceAssignment>
                  <WorkspaceAssignment label="Model" icon={Bot24Regular} detail={model} />
                  <WorkspaceAssignment label="Policy" icon={ShieldCheckmark24Regular} detail={workspace.policyAssignment ? `v${workspace.policyAssignment.version} · ${policyStatus(workspace)}` : policyStatus(workspace)} />
                </div>

                <footer className="workspace-card-actions">
                  <button className="primary-button" type="button" onClick={() => onOpen(workspace)} disabled={busy}>
                    <Open24Regular aria-hidden="true" />{primaryLabel}
                  </button>
                  {canManageWorkspace(workspace.id) && <>
                    <button className="workspace-manage-button" type="button" onClick={() => onManage(workspace.grantId)}>Manage configuration <ChevronRight16Regular aria-hidden="true" /></button>
                    {workspace.state === "stopped" ? (
                      <button className="secondary-button danger-button" type="button" onClick={() => onDelete(workspace)} disabled={busy}><Delete24Regular aria-hidden="true" />Delete</button>
                    ) : (
                      <div className="workspace-secondary-actions">
                        <button className="secondary-button" type="button" onClick={() => onRestart(workspace)} disabled={busy}><ArrowClockwise24Regular aria-hidden="true" />Restart</button>
                        <button className="secondary-button" type="button" onClick={() => onStop(workspace)} disabled={busy}><Dismiss24Regular aria-hidden="true" />Stop</button>
                      </div>
                    )}
                  </>}
                </footer>
              </article>
            );
          })}
        </section>
      )}
      </>}
    </div>
  );
}

const scheduledAgentIds = new Set(["claude-cli", "codex-cli", "hermes-claw"]);
const defaultScheduleTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const scheduleWeekdays = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];
const scheduleCadences = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
];
const scheduleDateTime = (value) => value
  ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "Not scheduled";
const scheduleDraft = (schedule, workspaces) => {
  const [minute = "0", hour = "9", , , days = "*"] = schedule?.cronExpression?.split(/\s+/) ?? [];
  const cadence = days === "*" ? "daily" : days === "1-5" ? "weekdays" : "weekly";
  const workspace = workspaces.find((item) => item.id === schedule?.workspaceId) ?? workspaces[0];
  const agents = workspace?.agents?.filter((agent) => scheduledAgentIds.has(agent.id)) ?? [];
  return {
    id: schedule?.id ?? "",
    title: schedule?.title ?? "",
    workspaceId: workspace?.id ?? "",
    agentCatalogId: schedule?.agentCatalogId ?? agents[0]?.id ?? "",
    prompt: schedule?.prompt ?? "",
    cadence,
    weekday: cadence === "weekly" ? days : "1",
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    timeZone: schedule?.timeZone ?? defaultScheduleTimeZone,
    state: schedule?.state ?? "enabled",
  };
};

function ScheduleDialog({ schedule, workspaces, busy, onSave, onClose }) {
  const [draft, setDraft] = useState(() => scheduleDraft(schedule, workspaces));
  const selectedWorkspace = workspaces.find((item) => item.id === draft.workspaceId);
  const agentOptions = (selectedWorkspace?.agents ?? [])
    .filter((agent) => scheduledAgentIds.has(agent.id))
    .map((agent) => ({ value: agent.id, label: agent.displayName }));
  const workspaceOptions = workspaces.map((item) => ({ value: item.id, label: workspaceName(item) }));
  const set = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async (event) => {
    event.preventDefault();
    const [hour, minute] = draft.time.split(":");
    const days = draft.cadence === "daily" ? "*" : draft.cadence === "weekdays" ? "1-5" : draft.weekday;
    const saved = await onSave({
      ...(draft.id ? { id: draft.id } : {}),
      title: draft.title,
      workspaceId: draft.workspaceId,
      agentCatalogId: draft.agentCatalogId,
      prompt: draft.prompt,
      cronExpression: `${Number(minute)} ${Number(hour)} * * ${days}`,
      timeZone: draft.timeZone,
      state: draft.state,
    });
    if (saved) onClose();
  };
  return (
    <ModalDialog
      title={draft.id ? "Edit schedule" : "Create schedule"}
      description="LemmaComputer will re-check the workspace, agent, and current policy before every run."
      eyebrow="Scheduled agent prompt"
      onClose={onClose}
    >
      <form className="schedule-form" onSubmit={save}>
        <label><span>Name</span><input name="schedule-title" value={draft.title} maxLength="120" required onChange={(event) => set("title", event.target.value)} placeholder="Weekday project summary" /></label>
        <div className="schedule-form-grid">
          <label><span>Workspace</span><SelectMenu value={draft.workspaceId} options={workspaceOptions} ariaLabel="Workspace" onValueChange={(value) => {
            const nextWorkspace = workspaces.find((item) => item.id === value);
            const nextAgent = nextWorkspace?.agents?.find((agent) => scheduledAgentIds.has(agent.id));
            setDraft((current) => ({ ...current, workspaceId: value, agentCatalogId: nextAgent?.id ?? "" }));
          }} /></label>
          <label><span>Agent</span><SelectMenu value={draft.agentCatalogId} options={agentOptions} ariaLabel="Agent" disabled={!agentOptions.length} onValueChange={(value) => set("agentCatalogId", value)} /></label>
        </div>
        <label><span>Prompt</span><textarea name="schedule-prompt" value={draft.prompt} maxLength="16000" rows="6" required onChange={(event) => set("prompt", event.target.value)} placeholder="Describe what the agent should do on each run." /></label>
        <div className={`schedule-form-grid schedule-timing-grid${draft.cadence === "weekly" ? " schedule-timing-grid-weekly" : ""}`}>
          <label><span>Repeat</span><SelectMenu value={draft.cadence} options={scheduleCadences} ariaLabel="Repeat schedule" onValueChange={(value) => set("cadence", value)} /></label>
          {draft.cadence === "weekly" && <label><span>Day</span><SelectMenu value={draft.weekday} options={scheduleWeekdays} ariaLabel="Day of week" onValueChange={(value) => set("weekday", value)} /></label>}
          <label><span>Time</span><input name="schedule-time" type="time" value={draft.time} required onChange={(event) => set("time", event.target.value)} /></label>
          <label><span>Timezone</span><input name="schedule-time-zone" value={draft.timeZone} maxLength="100" required onChange={(event) => set("timeZone", event.target.value)} /></label>
        </div>
        {selectedWorkspace && !["ready", "open"].includes(selectedWorkspace.state) && (
          <p className="schedule-workspace-note"><Info24Regular aria-hidden="true" />Runs are skipped while this workspace is stopped.</p>
        )}
        <div className="modal-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={busy || !draft.workspaceId || !draft.agentCatalogId}>{busy ? "Saving schedule" : draft.id ? "Save" : "Create schedule"}</button>
        </div>
      </form>
    </ModalDialog>
  );
}

function SchedulesScreen({ schedules, workspaces, loading, busyId, error, onSave, onToggle, onDelete, onRunNow, onLoadRuns }) {
  const [editor, setEditor] = useState(null);
  const [runsFor, setRunsFor] = useState("");
  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const showRuns = async (scheduleId) => {
    if (runsFor === scheduleId) { setRunsFor(""); return; }
    setRunsFor(scheduleId);
    setRunsLoading(true);
    try { setRuns(await onLoadRuns(scheduleId)); } finally { setRunsLoading(false); }
  };
  return (
    <div className="secondary-screen schedules-screen">
      <header className="page-heading schedules-heading">
        <div><p>Unattended work</p><h1>Schedules</h1><span>Run a saved prompt with a selected workspace agent. Current policy is checked at execution time.</span></div>
        <button className="primary-button" type="button" disabled={!workspaces.length} onClick={() => setEditor({})}><Add24Regular aria-hidden="true" />Create schedule</button>
      </header>
      {error && <div className="workspace-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Schedules unavailable</strong>{error}</span></div>}
      {loading ? <div className="workspace-overview-empty" role="status">Loading schedules…</div> : schedules.length === 0 ? (
        <section className="workspace-overview-empty schedules-empty">
          <Calendar24Regular aria-hidden="true" />
          <div><h2>No schedules yet</h2><p>Create a recurring prompt for one of your workspace agents.</p></div>
        </section>
      ) : (
        <section className="schedule-list" aria-label="Your schedules">
          {schedules.map((schedule) => {
            const selectedWorkspace = workspaces.find((item) => item.id === schedule.workspaceId);
            const selectedAgent = selectedWorkspace?.agents?.find((item) => item.id === schedule.agentCatalogId);
            const busy = busyId === schedule.id;
            return <article className="schedule-card" key={schedule.id}>
              <div className="schedule-card-main">
                <span className="schedule-card-icon"><Calendar24Regular aria-hidden="true" /></span>
                <span className="schedule-card-copy"><strong>{schedule.title}</strong><small>{workspaceName(selectedWorkspace)} · {selectedAgent?.displayName ?? schedule.agentCatalogId}</small></span>
                <span className={`schedule-state ${schedule.state}`}>{schedule.state === "enabled" ? "Active" : "Paused"}</span>
              </div>
              <dl className="schedule-metadata">
                <div><dt>Next run</dt><dd>{scheduleDateTime(schedule.nextRunAt)}</dd></div>
                <div><dt>Timezone</dt><dd>{schedule.timeZone}</dd></div>
                <div><dt>Last run</dt><dd>{scheduleDateTime(schedule.lastRunAt)}</dd></div>
              </dl>
              <div className="schedule-actions">
                <button className="primary-button compact-button" type="button" disabled={busy} onClick={() => onRunNow(schedule)}>Run now</button>
                <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => setEditor(schedule)}>Edit</button>
                <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onToggle(schedule)}>{schedule.state === "enabled" ? "Pause" : "Resume"}</button>
                <button className="text-button" type="button" disabled={busy} onClick={() => showRuns(schedule.id)}>{runsFor === schedule.id ? "Hide runs" : "Recent runs"}</button>
                <button className="text-button danger-button" type="button" disabled={busy} onClick={() => onDelete(schedule)}>Delete</button>
              </div>
              {runsFor === schedule.id && <div className="schedule-runs">
                {runsLoading ? <p>Loading recent runs…</p> : runs.length ? <ol>{runs.map((run) => <li key={run.id}><span className={`schedule-run-state ${run.state}`}>{run.state}</span><span>{scheduleDateTime(run.scheduledFor)}</span>{run.failureSummary && <small>{run.failureSummary}</small>}</li>)}</ol> : <p>No runs recorded yet.</p>}
              </div>}
            </article>;
          })}
        </section>
      )}
      {editor && <ScheduleDialog schedule={editor.id ? editor : null} workspaces={workspaces} busy={Boolean(busyId)} onSave={onSave} onClose={() => setEditor(null)} />}
    </div>
  );
}

const siteUpdatedAt = (value) => new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
}).format(new Date(value));

function SitesScreen({ sites, loading, error, busySiteId, onDelete }) {
  return <div className="secondary-screen sites-screen">
    <header className="page-heading sites-heading">
      <div><p>Your published apps</p><h1>Sites</h1><span>Sites built by your workspace agents appear here automatically.</span></div>
    </header>
    {error && <div className="workspace-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Sites unavailable</strong>{error}</span></div>}
    {loading ? <div className="workspace-overview-empty" role="status">Loading sites…</div> : sites.length === 0 ? (
      <section className="workspace-overview-empty sites-empty">
        <Apps48Regular aria-hidden="true" />
        <div><h2>No sites yet</h2><p>Ask a workspace agent to use Make a site, then publish the result.</p></div>
      </section>
    ) : <section className="sites-list" aria-label="Your sites">
      {sites.map((site) => <article className="site-row" key={site.id}>
        <div className="site-row-copy">
          <div className="site-row-heading">
            <h2>{site.name}</h2>
            <span className="site-state"><span aria-hidden="true" />Ready</span>
          </div>
          <div className="site-row-meta">
            <span>{site.slug}</span>
            <span>Revision {site.currentRevision}</span>
            <span>Published {siteUpdatedAt(site.updatedAt)}</span>
          </div>
        </div>
        <div className="site-row-actions">
          <a className="primary-button compact-button" href={siteApi.contentUrl(site.id)} target="_blank" rel="noopener noreferrer">
            Open<span className="sr-only"> {site.name} in a new tab</span>
          </a>
          <button className="text-button danger-button" type="button" disabled={busySiteId === site.id} onClick={() => onDelete(site)}>{busySiteId === site.id ? "Deleting…" : "Delete"}</button>
        </div>
      </article>)}
    </section>}
  </div>;
}

function SignInScreen({ error, invitationActive = false, invitationBusy = false, invitationError = "", invitationContext = null, invitationVerified = false, onSignedIn }) {
  const invited = invitationActive;
  const [capabilities, setCapabilities] = useState(null);
  const [mode, setMode] = useState(() => window.location.pathname === "/reset-password"
    ? "reset"
    : invited && !invitationVerified ? "signup" : "signin");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [status, setStatus] = useState(() => invitationVerified
    ? "Your email is verified. Sign in below to finish joining the organization."
    : "");
  const [verificationRecipient, setVerificationRecipient] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  useEffect(() => {
    if (invited && invitationContext?.email) setEmail(invitationContext.email);
  }, [invited, invitationContext?.email]);
  useEffect(() => {
    authApi.customerCapabilities()
      .then(setCapabilities)
      .catch((capabilityError) => setFormError(capabilityError.message));
  }, []);
  const changeMode = (nextMode) => {
    setMode(nextMode);
    setFormError("");
    setStatus("");
    setVerificationRecipient("");
    setPassword("");
    setVerificationCode("");
    setUseBackupCode(false);
  };
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    setStatus("");
    try {
      if (mode === "signup") {
        const callbackURL = new URL(invited ? "/invite?verified=1" : "/", window.location.origin).toString();
        await authApi.signUpWithEmail({
          name,
          email,
          password,
          ...(invited ? { callbackURL } : {}),
        });
        setVerificationRecipient(email);
        setStatus(invited ? "" : "Check your email to verify your account, then return here to sign in.");
      } else if (mode === "recovery") {
        await authApi.requestPasswordReset(email, `${window.location.origin}/reset-password`);
        setStatus("If an account exists for that email, a reset link is on its way.");
      } else if (mode === "reset") {
        const token = new URLSearchParams(window.location.search).get("token") ?? "";
        if (!token) throw new Error("This password reset link is incomplete or expired.");
        await authApi.resetPassword(token, password);
        window.history.replaceState(window.history.state, "", "/");
        changeMode("signin");
        setStatus("Your password has been reset. Sign in with the new password.");
      } else if (mode === "two-factor") {
        if (useBackupCode) await authApi.verifyBackupCode(verificationCode);
        else await authApi.verifyTotp(verificationCode);
        await onSignedIn();
      } else {
        const result = await authApi.signInWithEmail(email, password);
        if (result?.twoFactorRedirect) changeMode("two-factor");
        else await onSignedIn();
      }
    } catch (submitError) {
      setFormError(submitError.message ?? "Sign-in could not be completed.");
    } finally {
      setBusy(false);
    }
  };
  const resendVerification = async () => {
    setBusy(true);
    setFormError("");
    setStatus("");
    try {
      await authApi.sendVerificationEmail(verificationRecipient, invited ? "/invite?verified=1" : "/");
      setStatus("Verification email sent. Check your inbox and junk folder, then open the link to continue.");
    } catch (sendError) {
      setFormError(sendError.message ?? "The verification email could not be sent.");
    } finally {
      setBusy(false);
    }
  };
  const startSocialSignIn = async (provider) => {
    setBusy(true);
    setFormError("");
    try {
      const started = await authApi.signInWithSocialProvider(provider, invited ? "/invite" : "/");
      if (!started?.url) throw new Error("This sign-in method could not be started.");
      window.location.assign(started.url);
    } catch (socialError) {
      setFormError(socialError.message ?? "This sign-in method could not be started.");
      setBusy(false);
    }
  };
  const startCompanySso = async (requestedEmail = email) => {
    if (!requestedEmail.trim()) {
      setFormError("Enter your work email before continuing with company SSO.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const started = await authApi.signInWithCompanySso(requestedEmail, invited ? "/invite" : "/");
      if (!started?.location) throw new Error("Company SSO could not be started.");
      window.location.assign(started.location);
    } catch (companyError) {
      setFormError(companyError.message ?? "Company SSO could not be started.");
      setBusy(false);
    }
  };
  const signInWithPasskey = async () => {
    setBusy(true);
    setFormError("");
    try {
      await customerPasskeyApi.signIn();
      await onSignedIn();
    } catch (passkeyError) {
      setFormError(passkeyError.message ?? "Passkey verification was not completed.");
    } finally {
      setBusy(false);
    }
  };
  if (!capabilities && !formError) {
    return <main className="signin-screen"><div className="signin-loading">Loading secure sign-in…</div></main>;
  }
  if (invited && verificationRecipient) {
    return (
      <main className="signin-screen">
        <section className="signin-card">
          <div className="brand signin-brand" aria-label="LemmaComputer"><strong>Lemma</strong><span>Computer</span></div>
          <p>Organization invitation</p>
          <h1>Check your email</h1>
          <span>We sent a verification link to <strong>{verificationRecipient}</strong>. Open it in this browser to verify your email and finish joining {invitationContext?.organizationDisplayName ?? "the organization"} automatically.</span>
          {status && <div className="signin-status" role="status">{status}</div>}
          {formError && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Email could not be sent</strong>{formError}</span></div>}
          <button className="primary-button signin-button" type="button" disabled={busy} onClick={resendVerification}>{busy ? "Sending…" : "Resend verification email"}</button>
          <button className="secondary-button signin-button" type="button" disabled={busy} onClick={onSignedIn}>I’ve verified my email</button>
          <button className="signin-back-button" type="button" onClick={() => changeMode("signin")}>Use an existing account instead</button>
          <small><ShieldCheckmark24Regular aria-hidden="true" />The invitation stays reserved in this browser and still enforces the exact invited email and role.</small>
        </section>
      </main>
    );
  }
  if (invited && invitationContext?.companySsoAvailable) {
    return <main className="signin-screen">
      <section className="signin-card invitation-sso-card">
        <div className="brand signin-brand" aria-label="LemmaComputer"><strong>Lemma</strong><span>Computer</span></div>
        <p>Organization invitation</p>
        <h1>Join {invitationContext.organizationDisplayName}</h1>
        <span>Use the company sign-in configured by your organization. This invitation already fixes your email and organization role.</span>
        {(error || invitationError || formError) && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Sign-in was not completed</strong>{error || invitationError || formError}</span></div>}
        <label className="signin-locked-identity">Invited work email<input aria-label="Invited work email" type="email" readOnly value={invitationContext.email} /></label>
        <button className="primary-button signin-button" type="button" disabled={busy || invitationBusy} onClick={() => startCompanySso(invitationContext.email)}>{busy || invitationBusy ? "Please wait…" : "Continue with company SSO"}</button>
      </section>
    </main>;
  }
  const title = {
    signin: "Sign in to LemmaComputer",
    signup: "Create your account",
    recovery: "Reset your password",
    reset: "Choose a new password",
    "two-factor": "Verify it’s you",
    "company-sso": "Sign in with company SSO",
  }[mode];
  const description = {
    signin: "Use a secure method configured for your organization.",
    signup: "Create your identity first. Organization access is assigned separately.",
    recovery: "Enter your email and we’ll send a secure, time-limited reset link.",
    reset: "Use at least 12 characters for your new password.",
    "two-factor": useBackupCode ? "Enter one unused backup code." : "Enter the current code from your authenticator app.",
    "company-sso": "Enter your work email so LemmaComputer can find your organization’s sign-in page.",
  }[mode];
  return (
    <main className="signin-screen">
      <section className="signin-card">
        <div className="brand signin-brand" aria-label="LemmaComputer"><strong>Lemma</strong><span>Computer</span></div>
        <p>{invited ? "Organization invitation" : "Your managed work computer"}</p>
        <h1>{invited ? `Join ${invitationContext?.organizationDisplayName ?? "your organization"}` : title}</h1>
        <span>{invited
          ? `Create a LemmaComputer account or use an existing account. The organization and role fixed by this invitation cannot be changed by a sign-in provider.`
          : description}</span>
        {(error || invitationError || formError) && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Sign-in was not completed</strong>{error || invitationError || formError}</span></div>}
        <>
            {status && <div className="signin-status" role="status">{status}</div>}
            <form className="signin-form" onSubmit={submit}>
              {mode === "signup" && <label>Full name<input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} /></label>}
              {["signin", "signup", "recovery"].includes(mode) && <label>{invited ? "Invited work email" : "Work email"}<input type="email" autoComplete="email" required readOnly={invited} value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
              {mode === "company-sso" && <label>Company work email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
              {["signin", "signup", "reset"].includes(mode) && <label>Password<input type="password" minLength={12} maxLength={128} autoComplete={mode === "signin" ? "current-password" : "new-password"} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
              {mode === "two-factor" && <label>{useBackupCode ? "Backup code" : "Authenticator code"}<input inputMode={useBackupCode ? "text" : "numeric"} autoComplete="one-time-code" required value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} /></label>}
              <button className="primary-button signin-button" type="submit" onClick={mode === "company-sso" ? (event) => { event.preventDefault(); startCompanySso(); } : undefined} disabled={busy || invitationBusy}>{busy || invitationBusy ? "Please wait…" : ({ signin: "Sign in", signup: "Create account", recovery: "Send reset link", reset: "Reset password", "two-factor": "Verify", "company-sso": "Continue to company sign-in" }[mode])}</button>
            </form>
            {!invited && mode === "signup" && verificationRecipient && <button className="secondary-button signin-button" type="button" disabled={busy} onClick={resendVerification}>Resend verification email</button>}
            {mode === "signin" && <div className="signin-secondary-actions"><button type="button" onClick={() => changeMode("recovery")}>Forgot password?</button>{!invited && <button type="button" onClick={() => changeMode("signup")}>Create account</button>}</div>}
            {invited && mode === "signin" && <button className="signin-back-button" type="button" onClick={() => changeMode("signup")}>Create a new account</button>}
            {invited && mode === "signup" && <button className="signin-back-button" type="button" onClick={() => changeMode("signin")}>I already have an account</button>}
            {!invited && ["signup", "recovery", "reset"].includes(mode) && <button className="signin-back-button" type="button" onClick={() => changeMode("signin")}>Back to sign in</button>}
            {mode === "company-sso" && <button className="signin-back-button" type="button" onClick={() => changeMode("signin")}>Back to all sign-in options</button>}
            {mode === "two-factor" && <button className="signin-back-button" type="button" onClick={() => setUseBackupCode((current) => !current)}>{useBackupCode ? "Use authenticator code" : "Use a backup code"}</button>}
            {(mode === "signin" || (invited && mode === "signup")) && ((capabilities?.passkey && !invited) || capabilities?.socialProviders?.length || capabilities?.companySso) && <div className="signin-method-divider"><span>or</span></div>}
            {mode === "signin" && capabilities?.companySso && <button className="secondary-button signin-button" type="button" disabled={busy} onClick={() => changeMode("company-sso")}>Continue with company SSO</button>}
            {mode === "signin" && capabilities?.passkey && !invited && <button className="secondary-button signin-button" type="button" disabled={busy} onClick={signInWithPasskey}>Sign in with a passkey</button>}
            {(mode === "signin" || invited) && capabilities?.socialProviders?.includes("google") && <button className="secondary-button signin-button" type="button" disabled={busy} onClick={() => startSocialSignIn("google")}>Continue with Google</button>}
            {(mode === "signin" || invited) && capabilities?.socialProviders?.includes("microsoft") && <button className="secondary-button signin-button" type="button" disabled={busy} onClick={() => startSocialSignIn("microsoft")}>Continue with Microsoft</button>}
          </>
      </section>
    </main>
  );
}

function InvitationAccountSwitchScreen({ account, organizationDisplayName, onSignOut }) {
  const identity = account?.email || account?.displayName || account?.name || "the current account";
  return (
    <main className="signin-screen">
      <section className="signin-card">
        <div className="brand signin-brand" aria-label="LemmaComputer"><strong>Lemma</strong><span>Computer</span></div>
        <p>Organization invitation</p>
        <h1>Continue with the invited account</h1>
        <span>{organizationDisplayName
          ? `This invitation grants access to ${organizationDisplayName}, but the account currently signed in cannot accept it.`
          : "The account currently signed in cannot accept this invitation."}</span>
        <div className="signin-status" role="status"><strong>Signed in as {identity}</strong><br />Your current account and organization remain unchanged.</div>
        <button className="primary-button signin-button" type="button" onClick={onSignOut}>Sign out and continue</button>
        <button className="signin-back-button" type="button" onClick={() => window.location.assign("/")}>Keep current account</button>
        <small><ShieldCheckmark24Regular aria-hidden="true" />Only the exact invited identity can activate the preassigned organization role.</small>
      </section>
    </main>
  );
}

function AccountSecurityPanel({ onSessionChanged, onSignOutAll }) {
  const [capabilities, setCapabilities] = useState(null);
  const [identitySession, setIdentitySession] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [busyAction, setBusyAction] = useState("");
  const [securityError, setSecurityError] = useState("");
  const [securityStatus, setSecurityStatus] = useState("");
  const [totpStep, setTotpStep] = useState("idle");
  const [passwordProof, setPasswordProof] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [totpSetupKey, setTotpSetupKey] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [backupCodes, setBackupCodes] = useState([]);
  const load = useCallback(async () => {
    const [configured, current, linked] = await Promise.all([
      authApi.customerCapabilities(),
      authApi.customerIdentitySession(),
      authApi.linkedAccounts(),
    ]);
    setCapabilities(configured);
    setIdentitySession(current);
    setAccounts(linked);
  }, []);
  useEffect(() => {
    load().catch((loadError) => setSecurityError(loadError.message));
  }, [load]);
  const run = async (action, operation, success) => {
    setBusyAction(action);
    setSecurityError("");
    setSecurityStatus("");
    try {
      await operation();
      if (success) setSecurityStatus(success);
    } catch (operationError) {
      setSecurityError(operationError.message ?? "Account security could not be updated.");
    } finally {
      setBusyAction("");
    }
  };
  const linkProvider = (provider) => run(`link-${provider}`, async () => {
    const started = await authApi.linkSocialProvider(provider);
    if (!started?.url) throw new Error("Provider verification could not be started.");
    window.location.assign(started.url);
  });
  const unlinkProvider = (account) => run(`unlink-${account.id}`, async () => {
    await authApi.unlinkAccount(account.providerId, account.accountId);
    await load();
  }, `${account.providerId === "google" ? "Google" : "Microsoft"} was unlinked.`);
  const addPasskey = () => run("passkey", () => customerPasskeyApi.add(), "Passkey added. You can use it the next time you sign in.");
  const beginTotp = (event) => {
    event.preventDefault();
    run("totp-enable", async () => {
      const enrollment = await authApi.enableTotp(passwordProof);
      const setupKey = new URL(enrollment.totpURI).searchParams.get("secret");
      if (!setupKey || !Array.isArray(enrollment.backupCodes)) throw new Error("Authenticator enrollment could not be started.");
      setTotpSetupKey(setupKey);
      setTotpUri(enrollment.totpURI);
      setBackupCodes(enrollment.backupCodes);
      setPasswordProof("");
      setTotpStep("verify");
    });
  };
  const verifyTotpEnrollment = (event) => {
    event.preventDefault();
    run("totp-verify", async () => {
      await authApi.verifyTotp(totpCode);
      setTotpCode("");
      setTotpSetupKey("");
      setTotpUri("");
      setBackupCodes([]);
      setTotpStep("idle");
      await onSessionChanged?.();
    }, "Authenticator verification is active.");
  };
  const disableTotp = (event) => {
    event.preventDefault();
    run("totp-disable", async () => {
      await authApi.disableTotp(passwordProof);
      setPasswordProof("");
      await load();
    }, "Authenticator verification was disabled.");
  };
  const providers = ["google", "microsoft"];
  const providerName = (provider) => provider === "google" ? "Google" : "Microsoft";
  return <div className="account-security-panel">
    {(securityError) && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Security change was not completed</strong>{securityError}</span></div>}
    {securityStatus && <div className="signin-status" role="status">{securityStatus}</div>}
    <section>
      <h3>Sign-in methods</h3>
      <div className="account-security-methods">
        {accounts.map((account) => <div key={account.id}>
          <span><strong>{account.providerId === "credential" ? "Email and password" : providerName(account.providerId)}</strong><small>Linked to this account</small></span>
          {account.providerId !== "credential" && accounts.length > 1 && <button type="button" disabled={Boolean(busyAction)} onClick={() => unlinkProvider(account)}>Unlink</button>}
        </div>)}
        {providers.filter((provider) => capabilities?.socialProviders?.includes(provider) && !accounts.some((account) => account.providerId === provider)).map((provider) => <div key={provider}>
          <span><strong>{providerName(provider)}</strong><small>Requires proof from both signed-in accounts</small></span>
          <button type="button" disabled={Boolean(busyAction)} onClick={() => linkProvider(provider)}>{busyAction === `link-${provider}` ? "Starting…" : `Link ${providerName(provider)}`}</button>
        </div>)}
      </div>
      {capabilities?.passkey && <button className="secondary-button" type="button" disabled={Boolean(busyAction)} onClick={addPasskey}>{busyAction === "passkey" ? "Adding passkey…" : "Add a passkey"}</button>}
      {capabilities?.passkey && <p className="account-security-method-note">Passkeys can sign you in, but protected owner actions—including Company SSO changes—require an authenticator code.</p>}
    </section>
    <section>
      <h3>Authenticator app</h3>
      {totpStep === "idle" && !identitySession?.user?.twoFactorEnabled && <button className="secondary-button" type="button" onClick={() => setTotpStep("proof")}>Set up authenticator</button>}
      {totpStep === "proof" && <form className="account-security-form" onSubmit={beginTotp}><label>Current password<input type="password" autoComplete="current-password" required value={passwordProof} onChange={(event) => setPasswordProof(event.target.value)} /></label><button className="primary-button" type="submit" disabled={Boolean(busyAction)}>Continue</button></form>}
      {totpStep === "verify" && <form className="account-security-form" onSubmit={verifyTotpEnrollment}>
        <div className="totp-enrollment">
          <div className="totp-qr-code"><QRCode role="img" aria-label="Scan this QR code with your authenticator app" value={totpUri} size={176} /></div>
          <div><strong>Scan with your authenticator app</strong><p>Then enter the six-digit code it shows.</p></div>
        </div>
        <details className="totp-manual-setup"><summary>Can’t scan the QR code?</summary><p>Enter this setup key manually:</p><code className="totp-setup-key">{totpSetupKey}</code></details>
        <label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" required value={totpCode} onChange={(event) => setTotpCode(event.target.value)} /></label>
        <button className="primary-button" type="submit" disabled={Boolean(busyAction)}>Verify authenticator</button>
        <div className="backup-code-list"><strong>Save these one-time backup codes now</strong>{backupCodes.map((code) => <code key={code}>{code}</code>)}</div>
      </form>}
      {identitySession?.user?.twoFactorEnabled && <form className="account-security-form" onSubmit={disableTotp}><label>Current password<input type="password" autoComplete="current-password" required value={passwordProof} onChange={(event) => setPasswordProof(event.target.value)} /></label><button className="secondary-button danger-button" type="submit" disabled={Boolean(busyAction)}>Disable authenticator</button></form>}
    </section>
    <section>
      <h3>Device sessions</h3>
      <div className="account-security-actions">
        <button className="secondary-button" type="button" disabled={Boolean(busyAction)} onClick={() => run("revoke-others", () => authApi.revokeOtherSessions(), "Other device sessions were signed out.")}>Sign out other devices</button>
        <button className="secondary-button danger-button" type="button" disabled={Boolean(busyAction)} onClick={() => run("revoke-all", async () => { await authApi.revokeAllSessions(); await onSignOutAll?.(); })}>Sign out all devices</button>
      </div>
    </section>
  </div>;
}

function VerificationRequiredScreen({ customerSession, invitationActive = false, invitationContext = null, onSignOut }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const resend = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await authApi.sendVerificationEmail(
        customerSession.user.email,
        invitationActive ? "/invite?verified=1" : "/",
      );
      setStatus("Verification email sent. Check your inbox and junk folder, then open the link to continue.");
    } catch (sendError) {
      setError(sendError.message ?? "The verification email could not be sent.");
    } finally {
      setBusy(false);
    }
  };
  return <main className="signin-screen">
    <section className="signin-card organization-selection-card">
      <div className="brand signin-brand" aria-label="LemmaComputer"><strong>Lemma</strong><span>Computer</span></div>
      <p>Signed in as {customerSession.user.email}</p>
      <h1>Verify your email</h1>
      <span>Your identity provider did not supply a verified email claim. Verify this address before LemmaComputer can check organization access.</span>
      {invitationActive && <span>After verification, return here to finish joining {invitationContext?.organizationDisplayName ?? "the organization"} automatically.</span>}
      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Email was not sent</strong>{error}</span></div>}
      {status && <div className="signin-status" role="status">{status}</div>}
      <button className="primary-button signin-button" type="button" disabled={busy} onClick={resend}>{busy ? "Sending…" : "Resend verification email"}</button>
      <button className="signin-back-button" type="button" onClick={onSignOut}>Sign out</button>
      <small><ShieldCheckmark24Regular aria-hidden="true" />Provider authentication and email ownership are verified separately.</small>
    </section>
  </main>;
}

function OrganizationSelectionScreen({ customerSession, error, onSelected, onSignOut }) {
  const [busyMembershipId, setBusyMembershipId] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [securityOpen, setSecurityOpen] = useState(false);
  const organizationIdempotencyKey = useRef(crypto.randomUUID());
  const memberships = customerSession?.memberships ?? [];
  const selectMembership = async (membershipId) => {
    setBusyMembershipId(membershipId);
    setSelectionError("");
    try {
      await authApi.selectProductMembership(membershipId);
      await onSelected();
    } catch (error) {
      setSelectionError(error.message ?? "Organization access could not be selected.");
      setBusyMembershipId("");
    }
  };
  const createOrganization = async (event) => {
    event.preventDefault();
    setBusyMembershipId("organization");
    setSelectionError("");
    try {
      await authApi.createOrganization(organizationName, organizationIdempotencyKey.current);
      await onSelected();
    } catch (error) {
      setSelectionError(error.message ?? "Organization creation was not completed.");
      setBusyMembershipId("");
    }
  };
  return <><main className="signin-screen">
    <section className="signin-card organization-selection-card">
      <div className="brand signin-brand" aria-label="LemmaComputer"><strong>Lemma</strong><span>Computer</span></div>
      <p>Signed in as {customerSession.user.email}</p>
      <h1>{memberships.length ? "Choose an organization" : "Create your organization"}</h1>
      <span>{memberships.length
        ? "Your identity does not grant tenant access by itself. Choose one active membership for this session."
        : "Set up your organization. You will become its protected owner, and access can be assigned to other people separately."}</span>
      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Account security was not updated</strong>{error}</span></div>}
      {selectionError && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Organization was not selected</strong>{selectionError}</span></div>}
      {memberships.length
        ? <div className="organization-selection-list">
          {memberships.map((membership) => <button
            key={membership.membershipId}
            type="button"
            disabled={membership.status !== "active" || Boolean(busyMembershipId)}
            onClick={() => selectMembership(membership.membershipId)}
          >
            <span><strong>{membership.organizationDisplayName}</strong><small>{membership.role}</small></span>
            <span>{busyMembershipId === membership.membershipId ? "Opening…" : membership.status}</span>
          </button>)}
        </div>
        : <form className="signin-form organization-creation-form" onSubmit={createOrganization}>
          <label htmlFor="organization-name">Organization name</label>
          <input
            id="organization-name"
            name="organizationName"
            value={organizationName}
            minLength={2}
            maxLength={100}
            autoComplete="organization"
            required
            disabled={Boolean(busyMembershipId)}
            onChange={(event) => setOrganizationName(event.target.value)}
          />
          <button className="primary-button signin-button" type="submit" disabled={Boolean(busyMembershipId)}>
            {busyMembershipId === "organization" ? "Creating organization…" : "Create organization"}
          </button>
        </form>}
      <button className="secondary-button signin-button" type="button" onClick={() => setSecurityOpen(true)}>Manage account security</button>
      <button className="signin-back-button" type="button" onClick={onSignOut}>Sign out</button>
      <small><ShieldCheckmark24Regular aria-hidden="true" />Only an active, server-verified membership can open organization data.</small>
    </section>
  </main>{securityOpen && <ModalDialog
    className="account-security-modal"
    title="Account security"
    description="Manage authentication methods and device sessions for your LemmaComputer identity. Organization access remains separate."
    eyebrow="Your identity"
    labelledBy="account-security-title"
    onClose={() => setSecurityOpen(false)}
  ><AccountSecurityPanel onSessionChanged={onSelected} onSignOutAll={onSignOut} /></ModalDialog>}</>;
}

function ToolPolicyEditor({ mcpPolicy, loading, policySaving, onPolicyChange, onPolicySave }) {
  const serviceLabels = mcpPolicy?.connectorId
    ? { tools: `${mcpPolicy.connectorName} tools` }
    : { mail: "Outlook Mail", calendar: "Calendar", onedrive: "OneDrive", teams: "Teams" };
  const connectorChanges = mcpPolicy?.connectorId ? mcpPolicy.changes : null;
  const changeSummary = connectorChanges
    ? [
      connectorChanges.added?.length ? `${connectorChanges.added.length} added` : "",
      connectorChanges.changed?.length ? `${connectorChanges.changed.length} changed` : "",
      connectorChanges.removed?.length ? `${connectorChanges.removed.length} removed` : "",
    ].filter(Boolean).join(", ")
    : "";
  const groupedTools = Object.entries(serviceLabels)
    .map(([service, label]) => ({ service, label, tools: mcpPolicy?.tools.filter((tool) => tool.service === service) ?? [] }))
    .filter((group) => group.tools.length);
  if (loading && !mcpPolicy) return <div className="tool-policy-loading">Loading connector tools…</div>;
  return (
      <section className="tool-policy-card connector-tool-policy" aria-labelledby="tool-policy-heading">
        <div className="tool-policy-heading">
          <div><p>Organization tool policy</p><h2 id="tool-policy-heading">Tools &amp; approvals</h2></div>
          {mcpPolicy && <span>{mcpPolicy.version ? `Version ${mcpPolicy.version} · ` : ""}{mcpPolicy.documentHash.slice(0, 12)}…</span>}
        </div>
        <p className="tool-policy-intro">{mcpPolicy?.connectorId
          ? "Review the provider-supplied definition before choosing what workspace agents may run. New or changed tools stay blocked until this exact definition is saved; a later provider change requires another review."
          : "Choose what assigned workspace agents may run immediately, what requires a signed approval, and what is blocked. Saving creates an immutable policy version and refreshes running workspace grants."}</p>
        {changeSummary && <p className="tool-policy-change-summary"><strong>Review required:</strong> {changeSummary}. Open each provider definition before allowing it.</p>}
        <div className="tool-policy-groups">
          {groupedTools.map((group) => <section key={group.service} className="tool-policy-group">
            <h3>{group.label}<span>{group.tools.length} tools</span></h3>
            <div className="tool-policy-list">
              {group.tools.map((tool) => (
                <label key={tool.name}>
                  <span>
                    <strong>{tool.displayName}</strong>
                    <small>{tool.description}</small>
                    <code>{tool.name}</code>
                    {tool.definitionPreview && <details className="tool-definition-preview">
                      <summary>View current provider definition</summary>
                      <pre>{tool.definitionPreview}</pre>
                    </details>}
                  </span>
                  <SelectMenu
                    value={tool.decision}
                    onValueChange={(value) => onPolicyChange(tool.name, value)}
                    ariaLabel={`${tool.displayName} policy`}
                    options={[
                      { value: "allow", label: "Allow" },
                      { value: "approval_required", label: "Require approval" },
                      { value: "deny", label: "Block" },
                    ]}
                  />
                </label>
              ))}
            </div>
          </section>)}
        </div>
        <div className="tool-policy-actions">
          <span><ShieldCheckmark24Regular aria-hidden="true" />Approval rules are enforced in Control, not trusted to the desktop client.</span>
          <button className="primary-button compact-button" type="button" onClick={onPolicySave} disabled={!mcpPolicy || policySaving}>{policySaving ? "Saving changes" : "Save changes"}</button>
        </div>
      </section>
  );
}

function FirewallEditorDialog({ versions, saving, onSave, onClose, initialSecurityGroupId, createNew = false }) {
  const latest = versions.filter((item, index, all) => all.findIndex((candidate) => candidate.securityGroupId === item.securityGroupId) === index);
  const selected = createNew ? undefined : latest.find((item) => item.securityGroupId === initialSecurityGroupId) ?? latest[0];
  const [draft, setDraft] = useState(null);
  const [rule, setRule] = useState({ action: "allow", host: "", protocol: "https", port: 443, includeSubdomains: false, purpose: "" });

  useEffect(() => {
    if (!selected) {
      setDraft({ name: "", description: "", defaultAction: "deny", rules: [] });
      return;
    }
    setDraft({
      securityGroupId: selected.securityGroupId,
      name: selected.name,
      description: selected.description,
      defaultAction: selected.defaultAction,
      rules: selected.rules,
    });
  }, [selected?.id]);

  const addRule = () => {
    if (!draft || !rule.host.trim() || !rule.purpose.trim()) return;
    const id = `${rule.action}-${rule.protocol}-${rule.host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${rule.port}`.slice(0, 64);
    setDraft({ ...draft, rules: [...draft.rules, { ...rule, id, host: rule.host.trim(), purpose: rule.purpose.trim(), port: Number(rule.port) }] });
    setRule({ action: rule.action, host: "", protocol: "https", port: 443, includeSubdomains: false, purpose: "" });
  };

  const save = async () => {
    if (!draft) return;
    const saved = await onSave(draft);
    if (saved) onClose();
  };

  return (
    <ModalDialog
      className="firewall-editor-modal"
      title={draft?.securityGroupId ? `Manage ${draft.name}` : "Create security group"}
      description="A security group is a reusable collection of Allow and Deny rules. Saved changes apply live to every workspace using the group."
      eyebrow="Egress firewall"
      labelledBy="firewall-editor-title"
      onClose={saving ? () => undefined : onClose}
    >
      {draft && <div className="firewall-editor">
        <div className="firewall-editor-fields">
          <label><span>Name</span><input name="security-group-name" placeholder="Approved agent updates" value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label><span>Description</span><input name="security-group-description" placeholder="What this group controls" value={draft.description} disabled={saving} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <label className="firewall-editor-default-action"><span>Default behavior</span><SelectMenu value={draft.defaultAction} disabled={saving} onValueChange={(value) => setDraft({ ...draft, defaultAction: value })} ariaLabel="Default security group behavior" options={[{ value: "deny", label: "Deny unmatched destinations" }, { value: "allow-public-http-https", label: "Allow public HTTP and HTTPS" }]} /></label>
        </div>
        <div className="firewall-editor-rule-heading">
          <div><h3>Rules</h3><p>Rules are evaluated for every workspace using this group. A matching Deny rule takes precedence.</p></div>
          <span>{draft.rules.length}</span>
        </div>
        <div className="firewall-editor-rule-list" aria-label="Firewall rules in this group">
          {draft.rules.length === 0 ? <p>No rules yet. Add an Allow or Deny rule below.</p> : draft.rules.map((item, index) => (
            <article key={`${item.id}-${index}`}>
              <div><strong>{item.host}</strong><small>{item.purpose}</small></div>
              <code><span className={`firewall-rule-effect ${item.action}`}>{item.action}</span> · {item.protocol.toUpperCase()} · {item.port} · {item.includeSubdomains ? "Subdomains" : "Exact domain"}</code>
              <button type="button" disabled={saving} aria-label={`Remove ${item.host}`} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, ruleIndex) => ruleIndex !== index) })}>Remove</button>
            </article>
          ))}
        </div>
        <div className="firewall-editor-rule-builder" role="group" aria-labelledby="firewall-add-rule-heading">
          <div className="firewall-editor-rule-builder-title"><strong id="firewall-add-rule-heading">Add rule</strong><span>Choose whether this destination should be allowed or denied.</span></div>
          <label><span>Action</span><SelectMenu value={rule.action} disabled={saving} onValueChange={(value) => setRule({ ...rule, action: value })} ariaLabel="Rule action" options={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }]} /></label>
          <label><span>Destination</span><input name="firewall-rule-destination" placeholder="updates.example.com" value={rule.host} disabled={saving} onChange={(event) => setRule({ ...rule, host: event.target.value })} /></label>
          <label><span>Protocol</span><SelectMenu value={rule.protocol} disabled={saving} onValueChange={(value) => setRule({ ...rule, protocol: value, port: value === "https" ? 443 : 80 })} ariaLabel="Protocol" options={[{ value: "https", label: "HTTPS" }, { value: "http", label: "HTTP" }]} /></label>
          <label><span>Port</span><input name="firewall-rule-port" type="number" min="1" max="65535" value={rule.port} disabled={saving} onChange={(event) => setRule({ ...rule, port: event.target.value })} /></label>
          <label className="firewall-editor-subdomains"><input name="firewall-rule-subdomains" type="checkbox" checked={rule.includeSubdomains} disabled={saving} onChange={(event) => setRule({ ...rule, includeSubdomains: event.target.checked })} /><span>Include subdomains</span></label>
          <label className="firewall-editor-purpose"><span>Purpose</span><input name="firewall-rule-purpose" placeholder={`Why this access is ${rule.action === "deny" ? "denied" : "needed"}`} value={rule.purpose} disabled={saving} onChange={(event) => setRule({ ...rule, purpose: event.target.value })} /></label>
          <button className="secondary-button" type="button" disabled={saving || !rule.host.trim() || !rule.purpose.trim()} onClick={addRule}>Add rule</button>
        </div>
        <div className="firewall-editor-actions">
          <span><ShieldCheckmark24Regular aria-hidden="true" />HTTPS paths are not inspected. Redirects are checked as new connections.</span>
          <div>
            <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
            <button className="primary-button compact-button" type="button" disabled={saving || !draft.name || !draft.description} onClick={save}>{saving ? "Saving changes" : draft.securityGroupId ? "Save changes" : "Create security group"}</button>
          </div>
        </div>
      </div>}
    </ModalDialog>
  );
}

function TeamBudgetDialog({ team, onClose }) {
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState({ limitAmount: "1000", currency: "USD", periodType: "calendar_month", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", mode: "soft", thresholds: "50, 80, 100" });
  const [override, setOverride] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hydrate = (value) => {
    setStatus(value);
    if (value?.budget) setDraft({ limitAmount: value.budget.limitAmount, currency: value.budget.currency, periodType: value.budget.periodType, timezone: value.budget.timezone, mode: value.budget.mode, thresholds: value.budget.thresholds.join(", ") });
  };
  useEffect(() => {
    let active = true;
    setBusy(true);
    adminApi.teamBudget(team.id).then((value) => { if (active) hydrate(value.status); }).catch((caught) => { if (active) setError(caught.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [team.id]);
  const run = async (operation) => {
    setBusy(true); setError("");
    try { return await operation(); } catch (caught) { setError(caught.message); return null; } finally { setBusy(false); }
  };
  const save = async () => {
    const result = await run(() => adminApi.saveTeamBudget(team.id, { ...draft, thresholds: draft.thresholds.split(",").map((item) => item.trim()).filter(Boolean), effectiveFrom: new Date().toISOString() }));
    if (result) hydrate(result.status);
  };
  const saveOverride = async () => {
    if (!override?.confirmed) return;
    const payload = { overrideType: override.overrideType, ...(override.overrideType === "limit_increase" ? { newLimitAmount: override.newLimitAmount } : {}), reason: override.reason, expiresAt: new Date(override.expiresAt).toISOString() };
    const result = await run(() => adminApi.overrideTeamBudget(team.id, payload));
    if (result) { hydrate(result.status); setOverride(null); }
  };
  const reconcile = async () => {
    const result = await run(async () => { await adminApi.reconcileTeamBudget(team.id); return adminApi.teamBudget(team.id); });
    if (result) hydrate(result.status);
  };
  const money = (value) => value === null || value === undefined ? "—" : `${status?.budget?.currency ?? draft.currency} ${Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  return <ModalDialog className="team-budget-modal" title={`${team.displayName} budget`} description="LemmaComputer is the authoritative spend ledger. The LiteLLM Team limit is a defense-in-depth projection." eyebrow="Organization spend" labelledBy="team-budget-title" onClose={busy ? () => undefined : onClose}>
    {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Budget operation failed</strong>{error}</span></div>}
    {status?.budget && <section className="team-budget-status" aria-label="Current budget period">
      <div><span>Settled spend</span><strong>{money(status.settledProviderCost)}</strong></div>
      <div><span>In-flight reservations</span><strong>{money(status.outstandingReservations)}</strong></div>
      <div><span>Remaining</span><strong>{money(status.remainingAmount)}</strong></div>
      <div><span>Consumed</span><strong>{Number(status.percentConsumed).toFixed(1)}%</strong></div>
      <p>{status.period ? `${new Date(status.period.start).toLocaleDateString()} – ${new Date(status.period.end).toLocaleDateString()}` : "No current period"} · {status.enforcement} enforcement · pricing {status.priceStatus}</p>
    </section>}
    {!!status?.alerts?.length && <div className="team-budget-alert" role="status"><Info24Regular aria-hidden="true" /><span><strong>Spend warning</strong>{status.alerts.map((item) => `${Number(item.thresholdPercent)}%`).join(", ")} threshold reached this period.</span></div>}
    <div className="team-budget-fields">
      <label className="modal-field"><span>Budget limit</span><input name="team-budget-limit" inputMode="decimal" value={draft.limitAmount} disabled={busy} onChange={(event) => setDraft({ ...draft, limitAmount: event.target.value })} /></label>
      <label className="modal-field"><span>Currency</span><input name="team-budget-currency" maxLength="3" value={draft.currency} disabled={busy} onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} /></label>
      <label className="modal-field"><span>Period</span><SelectMenu value={draft.periodType} disabled={busy} onValueChange={(periodType) => setDraft({ ...draft, periodType })} ariaLabel="Period" options={[{value:"calendar_month",label:"Calendar month"},{value:"calendar_week",label:"Calendar week"}]} /></label>
      <label className="modal-field"><span>Enforcement</span><SelectMenu value={draft.mode} disabled={busy} onValueChange={(mode) => setDraft({ ...draft, mode })} ariaLabel="Enforcement" options={[{value:"soft",label:"Soft · warn only"},{value:"hard",label:"Hard · block before dispatch"}]} /></label>
      <label className="modal-field"><span>IANA timezone</span><input name="team-budget-timezone" value={draft.timezone} disabled={busy} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></label>
      <label className="modal-field"><span>Warning thresholds (%)</span><input name="team-budget-thresholds" value={draft.thresholds} disabled={busy} onChange={(event) => setDraft({ ...draft, thresholds: event.target.value })} /></label>
    </div>
    {override && <section className="team-budget-override" aria-label="Temporary budget override">
      <strong>Temporary audited override</strong>
      <label className="modal-field"><span>Override</span><SelectMenu value={override.overrideType} onValueChange={(overrideType) => setOverride({ ...override, overrideType })} ariaLabel="Override" options={[{value:"limit_increase",label:"Increase limit"},{value:"hard_limit_bypass",label:"Bypass hard limit"}]} /></label>
      {override.overrideType === "limit_increase" && <label className="modal-field"><span>Temporary limit</span><input name="team-budget-override-limit" value={override.newLimitAmount} onChange={(event) => setOverride({ ...override, newLimitAmount: event.target.value })} /></label>}
      <label className="modal-field"><span>Expires at</span><input name="team-budget-override-expiry" type="datetime-local" value={override.expiresAt} onChange={(event) => setOverride({ ...override, expiresAt: event.target.value })} /></label>
      <label className="modal-field"><span>Reason</span><input name="team-budget-override-reason" value={override.reason} onChange={(event) => setOverride({ ...override, reason: event.target.value })} /></label>
      <label className="team-budget-confirm"><input name="team-budget-override-confirm" type="checkbox" checked={override.confirmed} onChange={(event) => setOverride({ ...override, confirmed: event.target.checked })} /><span>I confirm this time-bound override will be recorded in the audit history.</span></label>
      <button className="primary-button compact-button" type="button" disabled={busy || !override.confirmed || !override.reason.trim() || (override.overrideType === "limit_increase" && !override.newLimitAmount)} onClick={saveOverride}>Apply override</button>
    </section>}
    <div className="modal-actions team-budget-actions"><button className="secondary-button" type="button" disabled={busy || !status?.budget} onClick={reconcile}>Reconcile gateway</button><button className="secondary-button" type="button" disabled={busy || !status?.budget} onClick={() => setOverride({ overrideType: "limit_increase", newLimitAmount: status?.effectiveLimitAmount ?? draft.limitAmount, reason: "", expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16), confirmed: false })}>Temporary override</button><span /><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" type="button" disabled={busy || !draft.limitAmount || !draft.currency || !draft.timezone || !draft.thresholds} onClick={save}>{busy ? "Saving" : status?.budget ? "Save new version" : "Create budget"}</button></div>
  </ModalDialog>;
}

function TeamsAdminSection({ teams, users, loading, busy, onLoad, onCreate, onUpdate, onArchive, onAssignMember, onRemoveMember, onSetDefault }) {
  const [editor, setEditor] = useState(null);
  const [budgetTeam, setBudgetTeam] = useState(null);
  const [memberUserId, setMemberUserId] = useState("");
  const userOptions = users.filter((user) => user.status === "active").map((user) => ({ value: user.userId, label: `${user.displayName} · ${user.email}` }));
  const userName = (userId) => users.find((user) => user.userId === userId)?.displayName ?? userId;
  const openCreate = () => {
    setMemberUserId("");
    setEditor({ id: null, displayName: "", description: "", ownerUserId: userOptions[0]?.value ?? "", costCenterCode: "", status: "active", isRolloutFallback: false });
  };
  const openEdit = async (team) => {
    setMemberUserId(userOptions[0]?.value ?? "");
    const detail = await onLoad(team.id);
    if (detail) setEditor({ ...detail, costCenterCode: detail.costCenterCode ?? "" });
  };
  const save = async () => {
    if (!editor?.displayName.trim() || !editor.ownerUserId) return;
    const input = { displayName: editor.displayName.trim(), description: editor.description.trim(), ownerUserId: editor.ownerUserId, costCenterCode: editor.costCenterCode.trim() || null };
    const saved = editor.id ? await onUpdate(editor.id, input) : await onCreate(input);
    if (saved) setEditor(null);
  };
  return (
    <>
    <section className="admin-team-section" aria-labelledby="admin-teams-heading">
      <div className="admin-team-heading">
        <div><p>Spend allocation</p><h2 id="admin-teams-heading">Teams</h2><span>Team membership decides where AI usage is charged. It does not grant workspace, model, tool, connector, or administrator access.</span></div>
        <button className="primary-button compact-button" type="button" onClick={openCreate}>Add Team</button>
      </div>
      {loading ? <p className="admin-team-empty">Loading Teams…</p> : !teams.length ? <p className="admin-team-empty">No Teams have been created yet.</p> : <div className="admin-team-list">
        {teams.map((team) => <article key={team.id}>
          <div><strong>{team.displayName}</strong><small>{team.description || "No description"}</small></div>
          <div><strong>{team.costCenterCode || "No cost-center code"}</strong><small>{team.activeMemberCount} active {team.activeMemberCount === 1 ? "member" : "members"}</small></div>
          <span className={`admin-team-status ${team.status}`}>{team.status === "archived" ? "Archived" : team.isRolloutFallback ? "Rollout fallback" : "Active"}</span>
          {!team.isRolloutFallback && team.status === "active" && <div className="admin-team-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setBudgetTeam(team)}>Budget</button><button className="secondary-button" type="button" disabled={busy} onClick={() => openEdit(team)}>Manage</button></div>}
        </article>)}
      </div>}
      {editor && <ModalDialog title={editor.id ? `Manage ${editor.displayName}` : "Create Team"} description="A Team is an internal spend-allocation group. The optional cost-center code is an external accounting reference only." eyebrow="Organization spend" labelledBy="team-editor-title" onClose={busy ? () => undefined : () => setEditor(null)}>
        <div className="team-editor-fields">
          <label className="modal-field"><span>Team name</span><input name="team-name" value={editor.displayName} disabled={busy || editor.isRolloutFallback} onChange={(event) => setEditor({ ...editor, displayName: event.target.value })} /></label>
          <label className="modal-field"><span>Description</span><input name="team-description" value={editor.description} disabled={busy || editor.isRolloutFallback} onChange={(event) => setEditor({ ...editor, description: event.target.value })} /></label>
          <label className="modal-field"><span>Owner / budget manager</span><SelectMenu value={editor.ownerUserId} disabled={busy || editor.isRolloutFallback} onValueChange={(ownerUserId) => setEditor({ ...editor, ownerUserId })} ariaLabel="Team owner or budget manager" options={userOptions} /></label>
          <label className="modal-field"><span>Cost-center code (optional)</span><input name="team-cost-center-code" value={editor.costCenterCode} disabled={busy || editor.isRolloutFallback} onChange={(event) => setEditor({ ...editor, costCenterCode: event.target.value })} /></label>
        </div>
        {editor.id && <div className="team-membership-editor">
          <div><strong>Spending membership</strong><span>Assign a member, then choose whether this Team should become their default charge destination.</span></div>
          <div className="team-membership-list" role="region" aria-label="Team membership history">
            {!editor.memberships?.length ? <p>No membership history yet.</p> : editor.memberships.map((membership) => <article key={membership.id}>
              <div>
                <strong>{userName(membership.userId)}</strong>
                <small>{membership.effectiveTo ? `Ended ${new Date(membership.effectiveTo).toLocaleDateString()}` : `Active since ${new Date(membership.effectiveFrom).toLocaleDateString()}`}</small>
              </div>
              {membership.isDefaultSpendingTeam && <span className="admin-team-status active">Current default</span>}
              {!membership.effectiveTo && !membership.isDefaultSpendingTeam && <button className="connection-quiet-button danger-button" type="button" disabled={busy} onClick={async () => {
                const detail = await onRemoveMember(editor.id, membership.userId);
                if (detail) setEditor({ ...detail, costCenterCode: detail.costCenterCode ?? "" });
              }}>Remove</button>}
            </article>)}
          </div>
          <SelectMenu value={memberUserId} disabled={busy} onValueChange={setMemberUserId} ariaLabel="Team member" options={userOptions} />
          <button className="secondary-button" type="button" disabled={busy || !memberUserId} onClick={async () => {
            const detail = await onAssignMember(editor.id, memberUserId);
            if (detail) setEditor({ ...detail, costCenterCode: detail.costCenterCode ?? "" });
          }}>Assign member</button>
          <button className="secondary-button" type="button" disabled={busy || !memberUserId} onClick={async () => {
            const detail = await onSetDefault(editor.id, memberUserId);
            if (detail) setEditor({ ...detail, costCenterCode: detail.costCenterCode ?? "" });
          }}>Make default</button>
        </div>}
        <div className="modal-actions team-editor-actions">
          {editor.id && <button className="connection-quiet-button danger-button" type="button" disabled={busy} onClick={async () => { if (await onArchive(editor)) setEditor(null); }}>Archive Team</button>}
          <span />
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button>
          <button className="primary-button" type="button" disabled={busy || !editor.displayName.trim() || !editor.ownerUserId} onClick={save}>{busy ? "Saving" : editor.id ? "Save changes" : "Create Team"}</button>
        </div>
      </ModalDialog>}
    </section>
    {budgetTeam && <TeamBudgetDialog team={budgetTeam} onClose={() => setBudgetTeam(null)} />}
    </>
  );
}

function OrganizationRoleEditor({ users }) {
  const [catalog, setCatalog] = useState(null);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(null);
  const [assignmentTargets, setAssignmentTargets] = useState({});
  const [roleMembers, setRoleMembers] = useState([]);
  const refresh = () => adminApi.roles()
    .then((result) => {
      setCatalog(result.catalog);
      setRoles(result.roles);
      if (result.memberships) setRoleMembers(result.memberships.map((membership) => ({
        ...membership,
        membershipStatus: membership.status,
      })));
      setError("");
    })
    .catch((requestError) => setError(requestError.message))
    .finally(() => setLoading(false));
  useEffect(() => { void refresh(); }, []);
  const assignableUsers = roleMembers.length ? roleMembers : users;
  const beginCreate = () => setEditor({ name: "", description: "", grants: [] });
  const beginEdit = (role) => setEditor({ ...role, grants: role.grants.map((grant) => ({ ...grant, scope: { ...grant.scope } })) });
  const selectedGrant = (permission) => editor?.grants.find((grant) => grant.permission === permission);
  const togglePermission = (permission, selected) => {
    if (!editor) return;
    if (!selected) {
      setEditor({ ...editor, grants: editor.grants.filter((grant) => grant.permission !== permission.key) });
      return;
    }
    const type = permission.scopeTypes[0];
    const resourceId = type === "organization" ? undefined : permission.resourceIds?.[type]?.[0] ?? "";
    setEditor({ ...editor, grants: [...editor.grants, {
      permission: permission.key,
      scope: type === "organization" ? { type } : { type, resourceId },
    }] });
  };
  const changeScope = (permission, type) => setEditor((current) => ({
    ...current,
    grants: current.grants.map((grant) => grant.permission === permission
      ? { ...grant, scope: type === "organization" ? { type } : { type, resourceId: "" } }
      : grant),
  }));
  const changeResource = (permission, resourceId) => setEditor((current) => ({
    ...current,
    grants: current.grants.map((grant) => grant.permission === permission
      ? { ...grant, scope: { ...grant.scope, resourceId } }
      : grant),
  }));
  const save = async () => {
    if (!editor) return;
    setBusy(true);
    setError("");
    try {
      const document = { name: editor.name.trim(), description: editor.description.trim(), grants: editor.grants };
      if (editor.id) await adminApi.updateRole(editor.id, { ...document, expectedVersion: editor.version });
      else await adminApi.createRole(document);
      setEditor(null);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };
  const archive = async (role) => {
    setBusy(true);
    setError("");
    try { await adminApi.archiveRole(role.id, role.version); await refresh(); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  const assign = async (role) => {
    const membershipId = assignmentTargets[role.id];
    if (!membershipId) return;
    setBusy(true);
    try {
      await adminApi.assignRole(membershipId, role.id);
      setAssignmentTargets((current) => ({ ...current, [role.id]: "" }));
      await refresh();
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  const unassign = async (role, membershipId) => {
    setBusy(true);
    try { await adminApi.unassignRole(membershipId, role.id); await refresh(); }
    catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  const userName = (membershipId) => assignableUsers.find((user) => user.membershipId === membershipId)?.displayName ?? "Unknown member";
  return <section className="admin-role-section" aria-labelledby="custom-roles-heading">
    <div className="admin-section-heading admin-action-heading">
      <div><p>Authorization</p><h2 id="custom-roles-heading">Custom roles</h2></div>
      <button className="primary-button admin-section-action" type="button" onClick={beginCreate}>Create custom role</button>
    </div>
    <p className="admin-role-intro">Owner, Administrator, and Member remain protected. Custom roles add an explicit, server-enforced permission union. New catalog permissions are never added automatically.</p>
    {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Role change failed</strong>{error}</span></div>}
    {loading ? <p className="admin-empty-state">Loading organization roles…</p> : !roles.filter((role) => role.status === "active").length
      ? <p className="admin-empty-state">No custom roles have been created.</p>
      : <div className="admin-custom-role-list">{roles.filter((role) => role.status === "active").map((role) => {
        const availableUsers = assignableUsers.filter((user) => user.membershipId && user.membershipStatus === "active" && !role.assignedMembershipIds.includes(user.membershipId));
        return <article className="admin-custom-role-card" key={role.id}>
          <div className="admin-custom-role-heading"><div><h3>{role.name}</h3><p>{role.description || "No description"}</p></div><span>Version {role.version}</span></div>
          <div className="admin-custom-role-grants">{role.grants.map((grant) => <span key={`${grant.permission}-${grant.scope.type}-${grant.scope.resourceId ?? ""}`}><strong>{grant.permission}</strong><small>{grant.scope.type === "organization" ? "All organization resources" : `${grant.scope.type}: ${grant.scope.resourceId}`}</small></span>)}</div>
          <div className="admin-custom-role-assignments">
            {role.assignedMembershipIds.length ? role.assignedMembershipIds.map((membershipId) => <span key={membershipId}>Assigned to {userName(membershipId)}<button type="button" aria-label={`Remove ${role.name} from ${userName(membershipId)}`} disabled={busy} onClick={() => unassign(role, membershipId)}>Remove</button></span>) : <small>Not assigned</small>}
          </div>
          <div className="admin-custom-role-actions">
            <SelectMenu value={assignmentTargets[role.id] ?? ""} disabled={busy || !availableUsers.length} onValueChange={(membershipId) => setAssignmentTargets((current) => ({ ...current, [role.id]: membershipId }))} ariaLabel={`Assign ${role.name} to member`} options={availableUsers.map((user) => ({ value: user.membershipId, label: user.displayName }))} placeholder="Choose member" />
            <button className="secondary-button compact-button" type="button" disabled={busy || !assignmentTargets[role.id]} onClick={() => assign(role)}>Assign role</button>
            <button className="secondary-button compact-button" type="button" disabled={busy} aria-label={`Edit ${role.name}`} onClick={() => beginEdit(role)}>Edit</button>
            <button className="connection-quiet-button danger-button" type="button" disabled={busy} onClick={() => archive(role)}>Archive</button>
          </div>
        </article>;
      })}</div>}
    {editor && <ModalDialog title={editor.id ? `Edit ${editor.name}` : "Create custom role"} description="Select only the product permissions and resource scopes this role requires. Saving an edit creates a new immutable version and signs out affected product sessions." eyebrow={`Permission catalog version ${catalog?.version ?? 1}`} labelledBy="custom-role-editor-title" onClose={busy ? () => undefined : () => setEditor(null)}>
      <label className="modal-field"><span>Role name</span><input aria-label="Role name" value={editor.name} maxLength={80} disabled={busy} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
      <label className="modal-field"><span>Role description</span><textarea aria-label="Role description" value={editor.description} maxLength={500} disabled={busy} onChange={(event) => setEditor({ ...editor, description: event.target.value })} /></label>
      <fieldset className="admin-role-permission-editor"><legend>Permissions</legend>{catalog?.permissions.filter((permission) => permission.key !== "organization.transfer_ownership").map((permission) => {
        const grant = selectedGrant(permission.key);
        return <div key={permission.key} className={grant ? "selected" : ""}>
          <label><input type="checkbox" checked={Boolean(grant)} disabled={busy} onChange={(event) => togglePermission(permission, event.target.checked)} /><span><strong>{permission.description}</strong><small>{permission.key}</small></span></label>
          {grant && <div className="admin-role-scope-editor"><SelectMenu value={grant.scope.type} disabled={busy} onValueChange={(type) => {
            changeScope(permission.key, type);
            const resourceId = permission.resourceIds?.[type]?.[0];
            if (type !== "organization" && resourceId) changeResource(permission.key, resourceId);
          }} ariaLabel={`Scope for ${permission.description}`} options={permission.scopeTypes.map((type) => ({ value: type, label: type === "organization" ? "All organization resources" : `Selected ${type}` }))} />{grant.scope.type !== "organization" && (permission.resourceIds?.[grant.scope.type]
            ? <SelectMenu ariaLabel={`${permission.description} resource ID`} value={grant.scope.resourceId ?? ""} disabled={busy} onValueChange={(resourceId) => changeResource(permission.key, resourceId)} options={permission.resourceIds[grant.scope.type].map((resourceId) => ({ value: resourceId, label: resourceId }))} />
            : <input aria-label={`${permission.description} resource ID`} value={grant.scope.resourceId ?? ""} placeholder={`${grant.scope.type} ID`} onChange={(event) => changeResource(permission.key, event.target.value)} />)}</div>}
        </div>;
      })}</fieldset>
      <div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setEditor(null)}>Cancel</button><button className="primary-button" type="button" disabled={busy || !editor.name.trim() || !editor.grants.length || editor.grants.some((grant) => grant.scope.type !== "organization" && !grant.scope.resourceId?.trim())} onClick={save}>{busy ? "Saving" : editor.id ? "Save new version" : "Create role"}</button></div>
    </ModalDialog>}
  </section>;
}

function SecretInputField({ id, value, onChange, helperText }) {
  const [revealed, setRevealed] = useState(false);
  return <div className="modal-field">
    <label htmlFor={id}>Client secret</label>
    <div className="secret-input-control">
      <input id={id} type={revealed ? "text" : "password"} autoComplete="new-password" value={value} onChange={onChange} />
      <button type="button" aria-label={`${revealed ? "Hide" : "Show"} client secret`} aria-pressed={revealed} onClick={() => setRevealed((current) => !current)}>
        {revealed ? <EyeOff24Regular aria-hidden="true" /> : <Eye24Regular aria-hidden="true" />}
      </button>
    </div>
    {helperText && <small>{helperText}</small>}
  </div>;
}

function isMicrosoftTenantIdAsClientId(issuer, clientId) {
  if (!issuer?.trim() || !clientId?.trim()) return false;
  try {
    const url = new URL(issuer);
    if (url.hostname.toLowerCase() !== "login.microsoftonline.com") return false;
    const tenantId = url.pathname.split("/").filter(Boolean)[0];
    return tenantId?.toLowerCase() === clientId.trim().toLowerCase();
  } catch {
    return false;
  }
}

function OidcClientIdField({ id, issuer, value, onChange }) {
  const tenantIdWasUsed = isMicrosoftTenantIdAsClientId(issuer, value);
  const helpId = `${id}-help`;
  return <label className="modal-field">
    <span>Client ID</span>
    <input id={id} aria-describedby={helpId} autoComplete="off" value={value} onChange={onChange} />
    <small id={helpId} className={`sso-client-id-help${tenantIdWasUsed ? " warning" : ""}`}>{tenantIdWasUsed
      ? "This is the Directory (tenant) ID. Paste the Application (client) ID instead."
      : "In Microsoft Entra, use the Application (client) ID—not the Directory (tenant) ID."}</small>
  </label>;
}

function CopyConfigurationField({ label, value, copyLabel }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef(null);
  useEffect(() => {
    setCopied(false);
    return () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    };
  }, [value]);
  const copy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  return <div className="sso-configuration-field">
    <label><span>{label}</span><input aria-label={label} readOnly value={value} /></label>
    <button className="sso-copy-button" type="button" aria-label={copied ? `${label} copied` : copyLabel} aria-live="polite" title={copied ? `${label} copied` : copyLabel} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
  </div>;
}

function OrganizationSsoSection({ isOwner }) {
  const emptyDraft = { protocol: "oidc", domain: "", issuer: "", clientId: "", clientSecret: "", entryPoint: "", certificate: "" };
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState(null);
  const [registrationProof, setRegistrationProof] = useState(null);
  const [protectedAction, setProtectedAction] = useState(null);
  const [stepUpCode, setStepUpCode] = useState("");
  const load = async () => {
    const result = await adminApi.ssoConnections();
    setConnections(result.connections ?? []);
  };
  useEffect(() => {
    let active = true;
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const legacyTestValue = params.get("sso_test") ?? "";
      const legacySeparator = legacyTestValue.indexOf("?");
      const legacyErrorParams = legacySeparator >= 0
        ? new URLSearchParams(legacyTestValue.slice(legacySeparator + 1))
        : null;
      const testConnectionId = ssoTestConnectionIdFromLocation()
        || (legacySeparator >= 0 ? legacyTestValue.slice(0, legacySeparator) : legacyTestValue);
      const providerError = params.get("error") ?? legacyErrorParams?.get("error") ?? "";
      const providerErrorDescription = params.get("error_description")
        ?? legacyErrorParams?.get("error_description")
        ?? "";
      if (testConnectionId) {
        try {
          if (providerError) {
            if (active) setError(ssoTestProviderErrorMessage(providerError, providerErrorDescription));
          } else {
            await adminApi.completeSsoTest(testConnectionId);
            if (active) setStatus("Company SSO test completed successfully.");
          }
        } catch {
          if (active) setError("Company SSO test could not be completed. The saved connection is unchanged.");
        } finally {
          params.delete("sso_test");
          params.delete("error");
          params.delete("error_description");
          params.set("view", "settings");
          params.set("section", "people");
          window.history.replaceState({}, "", `/?${params.toString()}`);
        }
      }
      try {
        if (active) await load();
      } catch (loadError) {
        if (active) setError(loadError.message ?? "Company SSO settings could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);
  const register = async () => {
    if (!draft) return;
    setBusy("register");
    setError("");
    try {
      const input = draft.protocol === "oidc"
        ? { protocol: "oidc", domain: draft.domain, issuer: draft.issuer, clientId: draft.clientId, clientSecret: draft.clientSecret }
        : { protocol: "saml", domain: draft.domain, issuer: draft.issuer, entryPoint: draft.entryPoint, certificate: draft.certificate };
      const created = await adminApi.registerSso(input);
      setRegistrationProof({
        connectionId: created.connection.id,
        providerId: created.connection.authenticationProviderId,
        domain: created.connection.domain,
        token: created.domainVerification.token,
        redirectURI: created.domainVerification.redirectURI,
      });
      setDraft(null);
      setStatus("Company SSO was saved in pending state. Add the DNS proof before testing it.");
      await load();
    } catch (registerError) {
      setError(registerError.message ?? "Company SSO could not be registered.");
    } finally {
      setBusy("");
    }
  };
  const run = async (connection, action) => {
    setBusy(`${connection.id}:${action}`);
    setError("");
    setStatus("");
    try {
      if (action === "proof") setRegistrationProof(await adminApi.requestSsoDomainProof(connection.id));
      if (action === "verify") await adminApi.verifySsoDomain(connection.id);
      if (action === "test") {
        const started = await adminApi.startSsoTest(connection.id);
        window.location.assign(started.location);
        return;
      }
      if (action === "suspend") await adminApi.suspendSso(connection.id);
      setStatus({ proof: "DNS proof is ready to copy.", verify: "Domain ownership verified.", suspend: "Company SSO is suspended. Other sign-in methods remain available." }[action] ?? "Company SSO updated.");
      await load();
    } catch (actionError) {
      setError(actionError.message ?? "Company SSO could not be updated.");
    } finally {
      setBusy("");
    }
  };
  const confirmProtected = async () => {
    if (!protectedAction) return;
    setBusy(`${protectedAction.connection.id}:${protectedAction.action}`);
    setError("");
    try {
      await authApi.completeOwnerStepUp(stepUpCode);
      const action = protectedAction.action;
      if (action === "recovery") await adminApi.confirmSsoRecovery(protectedAction.connection.id);
      if (action === "enforce") await adminApi.enforceSso(protectedAction.connection.id);
      if (action === "rotation") {
        await adminApi.rotateSsoCredentials(protectedAction.connection.id, {
          protocol: protectedAction.connection.protocol,
          ...protectedAction.credentials,
        });
      }
      if (action === "metadata") {
        await adminApi.refreshSsoMetadata(protectedAction.connection.id, {
          protocol: protectedAction.connection.protocol,
          ...(protectedAction.connection.protocol === "saml" ? { metadata: protectedAction.metadata } : {}),
        });
      }
      if (action === "rollback") await adminApi.rollbackSso(protectedAction.connection.id);
      if (action === "disconnect") await adminApi.disconnectSso(protectedAction.connection.id);
      setProtectedAction(null);
      setStepUpCode("");
      setStatus({
        recovery: "Protected owner recovery confirmed.",
        enforce: "Company SSO is now enforced for this email domain.",
        rotation: "Credentials rotated. Company SSO is pending until the provider is tested again and owner recovery is reconfirmed.",
        metadata: "Provider metadata refreshed. Company SSO is pending until the provider is tested again and owner recovery is reconfirmed.",
        rollback: "Company SSO returned to active state.",
        disconnect: "Company SSO was disconnected.",
      }[action]);
      await load();
    } catch (actionError) {
      setError(actionError.message ?? "The protected SSO action could not be completed.");
    } finally {
      setBusy("");
    }
  };
  const actionLabel = { recovery: "Confirm recovery", enforce: "Enforce SSO", rotation: "Rotate credentials", metadata: "Refresh metadata", rollback: "Roll back", disconnect: "Disconnect" };
  const protectedActionReady = protectedAction?.action === "rotation"
    ? (protectedAction.connection.protocol === "oidc"
      ? Boolean(protectedAction.credentials?.clientId.trim()
        && protectedAction.credentials?.clientSecret
        && !isMicrosoftTenantIdAsClientId(protectedAction.connection.issuer, protectedAction.credentials.clientId))
      : Boolean(protectedAction.credentials?.certificate.trim().length >= 64))
    : protectedAction?.action === "metadata" && protectedAction.connection.protocol === "saml"
      ? Boolean(protectedAction.metadata?.trim().length >= 64)
      : true;
  const draftClientIdIsTenantId = draft?.protocol === "oidc" && isMicrosoftTenantIdAsClientId(draft.issuer, draft.clientId);
  return <section className="admin-member-section" aria-labelledby="organization-sso-heading">
    <div className="admin-section-heading admin-action-heading"><div><p>Authentication</p><h2 id="organization-sso-heading">Company SSO</h2><small>Configure OIDC or SAML without letting identity-provider claims assign product access.</small></div>{isOwner && <button className="primary-button admin-section-action" type="button" onClick={() => { setDraft({ ...emptyDraft }); setRegistrationProof(null); }}>Add connection</button>}</div>
    {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Company SSO needs attention</strong>{error}</span></div>}
    {status && <div className="signin-status" role="status">{status}</div>}
    {registrationProof && <div className="sso-configuration-details" aria-live="polite">
      <div className="sso-configuration-heading"><strong>Configuration details</strong><small>Copy each value into the matching field at your DNS host or identity provider.</small></div>
      <section><h3>DNS TXT record</h3>
        <CopyConfigurationField label="DNS TXT host" value={`_lemmacomputer-sso-${registrationProof.providerId}`} copyLabel="Copy DNS TXT host" />
        <CopyConfigurationField label="DNS TXT value" value={registrationProof.token} copyLabel="Copy DNS TXT value" />
        <small>Publish this record for {registrationProof.domain}.</small>
      </section>
      <section><h3>Identity provider callback</h3>
        <CopyConfigurationField label="OIDC redirect URI" value={registrationProof.redirectURI} copyLabel="Copy OIDC redirect URI" />
      </section>
    </div>}
    {loading ? <p className="admin-empty-state">Loading company SSO…</p> : !connections.length ? <p className="admin-empty-state">No company SSO connection is configured.</p> : <div className="admin-user-list sso-connection-list" aria-label="Company SSO connections">{connections.map((connection) => {
      const actionBusy = busy.startsWith(`${connection.id}:`);
      return <article key={connection.id}>
        <div className="admin-user-copy"><strong>{connection.domain}</strong><small>{connection.protocol.toUpperCase()} · {connection.issuer}</small><div className="admin-user-badges"><span>{connection.state}</span><span>Version {connection.configVersion}</span></div></div>
        <div className="admin-policy-copy"><small>{connection.domainVerifiedAt ? "Domain verified" : "DNS proof required"}</small><small>{connection.lastTestedAt ? "Provider login tested" : "Provider test required"}</small><small>{connection.recoveryConfirmedAt ? "Owner recovery confirmed" : "Owner recovery not confirmed"}</small></div>
        <div className="admin-user-actions">
          {isOwner && !connection.domainVerifiedAt && connection.state !== "disconnected" && <button className="secondary-button admin-row-action" type="button" disabled={actionBusy} onClick={() => run(connection, "proof")}>Show DNS proof</button>}
          {isOwner && !connection.domainVerifiedAt && connection.state !== "disconnected" && <button className="secondary-button admin-row-action" type="button" disabled={actionBusy} onClick={() => run(connection, "verify")}>Verify DNS</button>}
          {connection.domainVerifiedAt && !connection.lastTestedAt && connection.state !== "disconnected" && <button className="secondary-button admin-row-action" type="button" disabled={actionBusy} onClick={() => run(connection, "test")}>Test provider</button>}
          {isOwner && connection.state === "active" && !connection.recoveryConfirmedAt && <button className="secondary-button admin-row-action" type="button" disabled={actionBusy} onClick={() => { setStepUpCode(""); setProtectedAction({ connection, action: "recovery" }); }}>Confirm recovery</button>}
          {isOwner && connection.state === "active" && connection.recoveryConfirmedAt && <button className="primary-button admin-row-action" type="button" disabled={actionBusy} onClick={() => { setStepUpCode(""); setProtectedAction({ connection, action: "enforce" }); }}>Enforce SSO</button>}
          {isOwner && connection.state !== "disconnected" && <button className="secondary-button admin-row-action" type="button" disabled={actionBusy} onClick={() => { setStepUpCode(""); setProtectedAction({ connection, action: "metadata", metadata: "" }); }}>Refresh metadata</button>}
          {isOwner && connection.state !== "disconnected" && <button className="secondary-button admin-row-action" type="button" disabled={actionBusy} onClick={() => { setStepUpCode(""); setProtectedAction({ connection, action: "rotation", credentials: connection.protocol === "oidc" ? { clientId: "", clientSecret: "" } : { certificate: "" } }); }}>Rotate credentials</button>}
          {connection.state === "enforced" && <button className="secondary-button danger-button admin-row-action" type="button" disabled={actionBusy} onClick={() => run(connection, "suspend")}>Suspend</button>}
          {isOwner && connection.state === "suspended" && <button className="secondary-button admin-row-action" type="button" disabled={actionBusy} onClick={() => { setStepUpCode(""); setProtectedAction({ connection, action: "rollback" }); }}>Roll back</button>}
          {isOwner && connection.state !== "disconnected" && <button className="connection-quiet-button danger-button admin-row-action" type="button" disabled={actionBusy} onClick={() => { setStepUpCode(""); setProtectedAction({ connection, action: "disconnect" }); }}>Disconnect</button>}
        </div>
      </article>;
    })}</div>}
    {draft && <ModalDialog title="Add company SSO" description="Credentials are sent directly to the authentication store. LemmaComputer keeps only the organization association and lifecycle status." eyebrow="Organization authentication" labelledBy="company-sso-editor-title" onClose={busy ? () => undefined : () => setDraft(null)}>
      <label className="modal-field"><span>Protocol</span><SelectMenu value={draft.protocol} options={[{ value: "oidc", label: "OpenID Connect (OIDC)" }, { value: "saml", label: "SAML 2.0" }]} ariaLabel="Company SSO protocol" disabled={Boolean(busy)} onValueChange={(protocol) => setDraft({ ...emptyDraft, protocol })} /></label>
      <label className="modal-field"><span>Verified email domain</span><input type="text" autoComplete="off" placeholder="example.com" value={draft.domain} onChange={(event) => setDraft({ ...draft, domain: event.target.value })} /></label>
      <label className="modal-field"><span>Issuer URL</span><input type="url" autoComplete="off" placeholder="https://idp.example.com" value={draft.issuer} onChange={(event) => setDraft({ ...draft, issuer: event.target.value })} /></label>
      {draft.protocol === "oidc" ? <>
        <OidcClientIdField id="company-sso-client-id" issuer={draft.issuer} value={draft.clientId} onChange={(event) => setDraft({ ...draft, clientId: event.target.value })} />
        <SecretInputField id="company-sso-client-secret" value={draft.clientSecret} onChange={(event) => setDraft({ ...draft, clientSecret: event.target.value })} helperText="Paste the secret Value from the identity provider, not its Secret ID." />
      </> : <>
        <label className="modal-field"><span>Sign-in URL</span><input type="url" autoComplete="off" value={draft.entryPoint} onChange={(event) => setDraft({ ...draft, entryPoint: event.target.value })} /></label>
        <label className="modal-field"><span>Signing certificate</span><textarea rows={6} autoComplete="off" value={draft.certificate} onChange={(event) => setDraft({ ...draft, certificate: event.target.value })} /></label>
      </>}
      <div className="modal-actions"><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => setDraft(null)}>Cancel</button><button className="primary-button" type="button" disabled={Boolean(busy) || !draft.domain.trim() || !draft.issuer.trim() || (draft.protocol === "oidc" ? !draft.clientId.trim() || !draft.clientSecret || draftClientIdIsTenantId : !draft.entryPoint.trim() || draft.certificate.trim().length < 64)} onClick={register}>{busy ? "Saving" : "Save connection"}</button></div>
    </ModalDialog>}
    {protectedAction && <ModalDialog title={actionLabel[protectedAction.action]} description={`${actionLabel[protectedAction.action]} for ${protectedAction.connection.domain}. Enter the six-digit authenticator code for this protected owner action; a passkey only signs you in.`} eyebrow="Protected owner action" labelledBy="company-sso-protected-action-title" onClose={busy ? () => undefined : () => setProtectedAction(null)}>
      {protectedAction.action === "rotation" && protectedAction.connection.protocol === "oidc" && <>
        <OidcClientIdField id="company-sso-rotated-client-id" issuer={protectedAction.connection.issuer} value={protectedAction.credentials.clientId} onChange={(event) => setProtectedAction({ ...protectedAction, credentials: { ...protectedAction.credentials, clientId: event.target.value } })} />
        <SecretInputField id="company-sso-rotated-client-secret" value={protectedAction.credentials.clientSecret} onChange={(event) => setProtectedAction({ ...protectedAction, credentials: { ...protectedAction.credentials, clientSecret: event.target.value } })} helperText="Paste the secret Value from the identity provider, not its Secret ID." />
      </>}
      {protectedAction.action === "rotation" && protectedAction.connection.protocol === "saml" && <label className="modal-field"><span>Signing certificate</span><textarea rows={6} autoComplete="off" value={protectedAction.credentials.certificate} onChange={(event) => setProtectedAction({ ...protectedAction, credentials: { certificate: event.target.value } })} /></label>}
      {protectedAction.action === "metadata" && protectedAction.connection.protocol === "oidc" && <p className="admin-role-intro">LemmaComputer will fetch the issuer discovery document again and replace the stored authorization, token, user-info, and JWKS endpoints. Routing remains disabled until you retest it.</p>}
      {protectedAction.action === "metadata" && protectedAction.connection.protocol === "saml" && <label className="modal-field"><span>Identity-provider metadata XML</span><textarea rows={8} autoComplete="off" value={protectedAction.metadata} onChange={(event) => setProtectedAction({ ...protectedAction, metadata: event.target.value })} /></label>}
      <label className="modal-field"><span>Authenticator code</span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={stepUpCode} onChange={(event) => setStepUpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /><small>Enter the current six-digit code from the LemmaComputer entry in your authenticator app.</small></label>
      <div className="modal-actions"><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => setProtectedAction(null)}>Cancel</button><button className="primary-button" type="button" disabled={Boolean(busy) || !protectedActionReady || !/^\d{6}$/.test(stepUpCode)} onClick={confirmProtected}>{busy ? "Verifying" : actionLabel[protectedAction.action]}</button></div>
    </ModalDialog>}
  </section>;
}

const protectedPolicyAgentNames = {
  "claude-desktop": "Claude Desktop",
  "claude-cli": "Claude CLI",
  "codex-cli": "Codex CLI",
  "hermes-desktop": "Hermes Desktop",
  "hermes-claw": "Hermes Agent",
};
const protectedPolicyProfileNames = {
  "claude-desktop-standard-v1": "Standard managed workspace",
  "kasm-persistent-standard": "Persistent Ubuntu workspace",
  "disposable-open-v1": "Disposable open workspace",
};
const protectedPolicyConnectorNames = { "microsoft-365": "Microsoft 365" };
const protectedPolicyServiceClassNames = { auto: "Auto (Beta)", lite: "Lite", balanced: "Balanced", pro: "Pro" };
const protectedPolicyReasoningOptions = ["disabled", "low", "medium", "high", "max"];
const protectedPolicyReasoningName = (value) => value === "disabled" ? "Off" : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
const protectedPolicyAllowed = (constraint) => constraint.allow.filter((value) => !constraint.deny.includes(value));
const protectedPolicyEffectiveValues = (baseline, overlay) => {
  const ceiling = protectedPolicyAllowed(baseline);
  const selected = overlay?.allow ? ceiling.filter((value) => overlay.allow.includes(value)) : ceiling;
  return selected.filter((value) => !overlay?.deny?.includes(value));
};
const protectedPolicyDate = (value) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const protectedPolicyList = (values, labels) => values.map((value) => labels[value] ?? value);
const protectedPolicyClipboardSummary = (clipboard) => {
  const direction = clipboard.localToWorkspace && clipboard.workspaceToLocal
    ? "Clipboard transfer in both directions"
    : clipboard.localToWorkspace ? "Copy into workspaces only"
      : clipboard.workspaceToLocal ? "Copy out of workspaces only" : "Clipboard transfer blocked";
  return `${direction}, up to ${Math.max(1, Math.round(clipboard.maxBytes / 1024))} KB`;
};

function ProtectedPolicyControlGroup({ icon: Icon, title, lines, action }) {
  return <div className="workspace-policy-control-group">
    <Icon aria-hidden="true" />
    <strong>{title}</strong>
    <div>{lines.map((line) => <span key={line}>{line}</span>)}{action}</div>
  </div>;
}

function ProtectedPolicyResourceEditor({ legend, description, values, labels, selected, onChange }) {
  const toggle = (value) => onChange(selected.includes(value)
    ? selected.filter((item) => item !== value)
    : [...selected, value]);
  return <fieldset className="workspace-policy-editor-group">
    <legend>{legend}</legend>
    <p>{description}</p>
    <div>{values.map((value) => <label key={value} className="workspace-policy-choice">
      <input type="checkbox" checked={selected.includes(value)} onChange={() => toggle(value)} />
      <span><strong>{labels[value] ?? value}</strong><small>{selected.includes(value) ? "Available to member assignments" : "Restricted by the organization"}</small></span>
    </label>)}</div>
  </fieldset>;
}

function ProtectedWorkspacePolicySection({ users, onConfigureConnections }) {
  const [overview, setOverview] = useState(null);
  const [assignments, setAssignments] = useState({});
  const [remediations, setRemediations] = useState({});
  const [busyUserId, setBusyUserId] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [editor, setEditor] = useState(null);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [reviewUser, setReviewUser] = useState(null);
  const [error, setError] = useState("");
  const userIds = users.map((user) => user.userId).join(",");
  const load = async () => {
    const policy = await adminApi.protectedWorkspacePolicy();
    const histories = await Promise.all(users.map(async (user) => [user.userId, await adminApi.protectedMemberPolicyVersions(user.userId)]));
    setOverview(policy);
    setAssignments(Object.fromEntries(histories.map(([userId, history]) => [userId, history.versions?.[0] ?? null])));
    return policy;
  };
  useEffect(() => {
    let active = true;
    Promise.all([
      adminApi.protectedWorkspacePolicy(),
      ...users.map(async (user) => [user.userId, await adminApi.protectedMemberPolicyVersions(user.userId)]),
    ]).then(([policy, ...histories]) => {
      if (!active) return;
      setOverview(policy);
      setAssignments(Object.fromEntries(histories.map(([userId, history]) => [userId, history.versions?.[0] ?? null])));
      setError("");
    }).catch((loadError) => {
      if (active) setError(loadError.message ?? "Workspace policy could not be loaded.");
    });
    return () => { active = false; };
  }, [userIds]);
  if (!overview && error) return <section className="workspace-policy-admin"><div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Workspace policy needs attention</strong>{error}</span></div></section>;
  if (!overview) return <section className="workspace-policy-admin"><p className="admin-empty-state" role="status">Loading workspace policy…</p></section>;

  const { baseline } = overview;
  const organizationVersions = overview.organizationPolicyVersions ?? [];
  const latest = organizationVersions[0] ?? null;
  const overlay = latest?.constraints ?? {};
  const effective = {
    workspaceProfiles: protectedPolicyEffectiveValues(baseline.constraints.workspaceProfiles, overlay.workspaceProfiles),
    agents: protectedPolicyEffectiveValues(baseline.constraints.agents, overlay.agents),
    applications: protectedPolicyEffectiveValues(baseline.constraints.applications, overlay.applications),
    modelAliases: protectedPolicyEffectiveValues(baseline.constraints.modelAliases, overlay.modelAliases),
    serviceClasses: protectedPolicyEffectiveValues(baseline.constraints.serviceClasses, overlay.serviceClasses),
    connectors: protectedPolicyEffectiveValues(baseline.constraints.connectors, overlay.connectors),
    maximumReasoningEffort: overlay.maximumReasoningEffort ?? baseline.constraints.maximumReasoningEffort,
    maximumEgressMode: overlay.maximumEgressMode ?? baseline.constraints.maximumEgressMode,
    clipboard: {
      localToWorkspace: baseline.constraints.clipboard.localToWorkspace && (overlay.clipboard?.localToWorkspace ?? true),
      workspaceToLocal: baseline.constraints.clipboard.workspaceToLocal && (overlay.clipboard?.workspaceToLocal ?? true),
      maxBytes: Math.min(baseline.constraints.clipboard.maxBytes, overlay.clipboard?.maxBytes ?? baseline.constraints.clipboard.maxBytes),
    },
  };
  const selection = {
    workspaceProfile: effective.workspaceProfiles.includes("kasm-persistent-standard") ? "kasm-persistent-standard" : effective.workspaceProfiles[0],
    agentIds: effective.agents,
    applicationIds: effective.applications,
    modelAlias: effective.modelAliases.includes("lemmacomputer-auto") ? "lemmacomputer-auto" : effective.modelAliases[0],
    serviceClass: effective.serviceClasses.includes("balanced") ? "balanced" : effective.serviceClasses[0],
    reasoningEffort: effective.maximumReasoningEffort,
    egressMode: effective.maximumEgressMode,
    connectorIds: effective.connectors,
  };
  const openEditor = () => setEditor({
    workspaceProfiles: [...effective.workspaceProfiles],
    agents: [...effective.agents],
    applications: [...effective.applications],
    modelAliases: [...effective.modelAliases],
    serviceClasses: [...effective.serviceClasses],
    connectors: [...effective.connectors],
    maximumReasoningEffort: effective.maximumReasoningEffort,
    maximumEgressMode: effective.maximumEgressMode,
    clipboardLocalToWorkspace: effective.clipboard.localToWorkspace,
    clipboardWorkspaceToLocal: effective.clipboard.workspaceToLocal,
    clipboardMaxKb: Math.max(1, Math.round(effective.clipboard.maxBytes / 1024)),
    revisionNote: "",
  });
  const resourceConstraint = (baselineConstraint, selected) => {
    const ceiling = protectedPolicyAllowed(baselineConstraint);
    return { allow: selected, deny: ceiling.filter((value) => !selected.includes(value)) };
  };
  const savePolicy = async () => {
    setSavingPolicy(true);
    setError("");
    try {
      const constraints = {
        ...overlay,
        workspaceProfiles: resourceConstraint(baseline.constraints.workspaceProfiles, editor.workspaceProfiles),
        agents: resourceConstraint(baseline.constraints.agents, editor.agents),
        applications: resourceConstraint(baseline.constraints.applications, editor.applications),
        modelAliases: resourceConstraint(baseline.constraints.modelAliases, editor.modelAliases),
        serviceClasses: resourceConstraint(baseline.constraints.serviceClasses, editor.serviceClasses),
        maximumReasoningEffort: editor.maximumReasoningEffort,
        maximumEgressMode: editor.maximumEgressMode,
        clipboard: {
          localToWorkspace: editor.clipboardLocalToWorkspace,
          workspaceToLocal: editor.clipboardWorkspaceToLocal,
          maxBytes: Math.min(baseline.constraints.clipboard.maxBytes, Math.max(1, editor.clipboardMaxKb) * 1024),
        },
        connectors: {
          allow: editor.connectors,
          deny: protectedPolicyAllowed(baseline.constraints.connectors).filter((value) => !editor.connectors.includes(value)),
          toolPolicies: overlay.connectors?.toolPolicies ?? {},
        },
      };
      await adminApi.createProtectedOrganizationPolicyVersion(constraints, editor.revisionNote.trim());
      await load();
      setEditor(null);
    } catch (saveError) {
      setError(saveError.message ?? "The organization policy version could not be saved.");
    } finally {
      setSavingPolicy(false);
    }
  };
  const assign = async (user) => {
    setBusyUserId(user.userId);
    setError("");
    try {
      const result = await adminApi.assignProtectedMemberPolicy(user.userId, selection);
      setAssignments((current) => ({ ...current, [user.userId]: result.version }));
      setRemediations((current) => ({ ...current, [user.userId]: result.remediation }));
    } catch (assignError) {
      setError(assignError.message ?? "The workspace policy could not be assigned.");
    } finally {
      setBusyUserId("");
    }
  };
  const revoke = async (user) => {
    setBusyUserId(user.userId);
    setError("");
    try {
      const result = await adminApi.revokeProtectedMemberPolicy(user.userId);
      setRemediations((current) => ({ ...current, [user.userId]: result.remediation }));
      await load();
      setReviewUser(null);
    } catch (revokeError) {
      setError(revokeError.message ?? "Workspace access could not be revoked.");
    } finally {
      setBusyUserId("");
    }
  };
  const editorReady = editor
    && editor.workspaceProfiles.length > 0
    && editor.agents.length > 0
    && editor.applications.length > 0
    && editor.modelAliases.length > 0
    && editor.serviceClasses.length > 0
    && editor.revisionNote.trim().length >= 3;
  const versionCreator = (version) => users.find((user) => user.userId === version.createdBy)?.displayName ?? "Organization administrator";

  return <section className="workspace-policy-admin" aria-labelledby="protected-workspace-policy-heading">
    <header className="workspace-policy-heading">
      <div><div className="workspace-policy-title-line"><h2 id="protected-workspace-policy-heading">{latest ? "Current organization policy" : "Current workspace policy"}</h2><span>{latest ? `v${latest.version}` : "Baseline only"}</span></div>
        <p>{latest
          ? `Version ${latest.version} is the latest policy available to assign. Existing members stay on their assigned version until updated.`
          : "No additional organization restrictions have been added. The Office worker baseline remains the maximum configuration."}</p></div>
      <button className="primary-button workspace-policy-primary-action" type="button" onClick={openEditor}>{latest ? "Edit organization policy" : <><Add24Regular aria-hidden="true" />Set organization policy</>}</button>
    </header>
    {error && <div className="workspace-policy-error connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>The workspace policy was not updated</strong>{error}</span></div>}

    <div className="workspace-policy-overview">
      <section className="workspace-policy-controls" aria-labelledby="workspace-policy-controls-heading">
        <h3 id="workspace-policy-controls-heading">Policy controls</h3>
        <ProtectedPolicyControlGroup icon={Bot24Regular} title="Agents" lines={protectedPolicyList(effective.agents, protectedPolicyAgentNames)} />
        <ProtectedPolicyControlGroup icon={Apps24Regular} title="Applications" lines={protectedPolicyList(effective.applications, applicationNames)} />
        <ProtectedPolicyControlGroup icon={PlugConnected24Regular} title="Connection access" lines={effective.connectors.length ? protectedPolicyList(effective.connectors, protectedPolicyConnectorNames) : ["No connections available"]} action={<button type="button" onClick={onConfigureConnections}>Tool permissions are managed in Connections</button>} />
        <ProtectedPolicyControlGroup icon={Info24Regular} title="Models and thinking" lines={[`${effective.modelAliases.length} approved model ${effective.modelAliases.length === 1 ? "route" : "routes"}`, `Maximum thinking: ${protectedPolicyReasoningName(effective.maximumReasoningEffort)}`, `Service levels: ${protectedPolicyList(effective.serviceClasses, protectedPolicyServiceClassNames).join(", ")}`]} />
        <ProtectedPolicyControlGroup icon={ShieldCheckmark24Regular} title="Workspace security" lines={[protectedPolicyList(effective.workspaceProfiles, protectedPolicyProfileNames).join(", "), effective.maximumEgressMode === "restricted" ? "Restricted internet access" : "Full web access permitted", protectedPolicyClipboardSummary(effective.clipboard)]} />
      </section>
      <aside className="workspace-policy-context">
        <section><div className="workspace-policy-context-title"><ShieldCheckmark24Regular aria-hidden="true" /><strong>Locked baseline</strong></div><h3>Office worker baseline <span>v{baseline.version}</span></h3><p>Published by LemmaComputer release {baseline.release.releaseId}. This is the maximum configuration and cannot be edited or weakened.</p><button type="button" onClick={() => setBaselineOpen(true)}>View baseline</button></section>
        <section><div className="workspace-policy-context-title"><Clock24Regular aria-hidden="true" /><strong>Policy state</strong></div>{latest ? <><p><strong>Organization policy v{latest.version}</strong></p><p>{latest.revisionNote}</p><p>Saved {protectedPolicyDate(latest.createdAt)} by {versionCreator(latest)}.</p></> : <><p><strong>Product baseline active</strong></p><p>No organization version yet.</p></>}<p>Every organization change is saved as a new immutable version.</p></section>
      </aside>
    </div>

    <section className="workspace-policy-members" aria-labelledby="workspace-policy-members-heading">
      <div><h3 id="workspace-policy-members-heading">Member policy status</h3><p>See who has the latest organization policy assignment and whether a workspace action is required.</p></div>
      <div className="workspace-policy-member-table" role="table" aria-label="Member workspace policy status">
        <div className="workspace-policy-member-header" role="row"><span role="columnheader">Member</span><span role="columnheader">Applied policy</span><span role="columnheader">Assignment status</span><span role="columnheader">Workspace action</span><span role="columnheader">Action</span></div>
        {users.length === 0 ? <p className="admin-empty-state">No organization members are available to assign.</p> : users.map((user) => {
          const assignment = assignments[user.userId];
          const selected = assignment?.state === "selected";
          const revoked = assignment?.state === "revoked";
          const currentOrganizationVersion = selected && latest && assignment.organizationPolicyVersionId === latest.policyVersionId;
          const currentBaseline = selected && !latest && !assignment.organizationPolicyVersionId;
          const updateAvailable = selected && !currentOrganizationVersion && !currentBaseline;
          const remediation = remediations[user.userId];
          const policyLabel = selected ? assignment.organizationPolicyVersionId
            ? `Organization policy v${organizationVersions.find((version) => version.policyVersionId === assignment.organizationPolicyVersionId)?.version ?? "previous"}`
            : `Office worker baseline v${baseline.version}` : revoked ? "Access revoked" : "Not assigned";
          const assignmentStatus = updateAvailable ? "Update available" : selected ? "Current" : revoked ? "Revoked" : "Not assigned";
          const workspaceAction = remediation?.required ? "Restart to apply" : remediation ? "No restart required" : "No pending action recorded";
          return <div className="workspace-policy-member-row" role="row" key={user.userId}>
            <div className="workspace-policy-member-copy" role="cell" data-label="Member"><strong>{user.displayName}</strong><small>{user.email}</small></div>
            <span role="cell" data-label="Applied policy">{policyLabel}</span>
            <span role="cell" data-label="Assignment status" className={`workspace-policy-state ${updateAvailable ? "attention" : selected ? "current" : "muted"}`}>{assignmentStatus}</span>
            <span role="cell" data-label="Workspace action">{workspaceAction}</span>
            <div className="workspace-policy-member-actions" role="cell" data-label="Action">{updateAvailable || !selected
              ? <button type="button" disabled={busyUserId === user.userId || !selection.workspaceProfile || !selection.agentIds.length || !selection.applicationIds.length || !selection.modelAlias || !selection.serviceClass} onClick={() => assign(user)}>{busyUserId === user.userId ? "Updating" : updateAvailable ? "Apply latest" : revoked ? "Restore access" : "Assign policy"}</button>
              : <button type="button" onClick={() => setReviewUser(user)}>Review</button>}</div>
          </div>;
        })}
      </div>
    </section>

    <details className="workspace-policy-history">
      <summary><span><Clock24Regular aria-hidden="true" /><strong>Version history</strong><small>{organizationVersions.length ? `${organizationVersions.length} immutable organization ${organizationVersions.length === 1 ? "version" : "versions"}` : "No organization policy versions yet."}</small></span><ChevronDown16Regular aria-hidden="true" /></summary>
      {organizationVersions.length > 0 && <div className="workspace-policy-history-list">{organizationVersions.map((version) => <article key={version.policyVersionId}><strong>v{version.version}{version === latest ? " · Current" : ""}</strong><span>{version.revisionNote}</span><small>{versionCreator(version)} · {protectedPolicyDate(version.createdAt)}</small></article>)}</div>}
    </details>

    {editor && <ModalDialog className="workspace-policy-editor-modal" title={latest ? "Edit organization policy" : "Set organization policy"} description="Start from the Office worker baseline and add stricter organization limits. You cannot enable anything blocked by LemmaComputer." eyebrow={latest ? `Current organization version ${latest.version}` : "Baseline only"} labelledBy="workspace-policy-editor-title" onClose={savingPolicy ? () => undefined : () => { setEditor(null); setError(""); }}>
      <div className="workspace-policy-editor-body">
        <ProtectedPolicyResourceEditor legend="Agents" description="Choose the Claude experiences members may select." values={protectedPolicyAllowed(baseline.constraints.agents)} labels={protectedPolicyAgentNames} selected={editor.agents} onChange={(agents) => setEditor({ ...editor, agents })} />
        <ProtectedPolicyResourceEditor legend="Applications" description="Members remain free to choose from these approved workspace applications." values={protectedPolicyAllowed(baseline.constraints.applications)} labels={applicationNames} selected={editor.applications} onChange={(applications) => setEditor({ ...editor, applications })} />
        <ProtectedPolicyResourceEditor legend="Workspace types" description="Limit which protected workspace profiles may be assigned." values={protectedPolicyAllowed(baseline.constraints.workspaceProfiles)} labels={protectedPolicyProfileNames} selected={editor.workspaceProfiles} onChange={(workspaceProfiles) => setEditor({ ...editor, workspaceProfiles })} />
        <ProtectedPolicyResourceEditor legend="Model routes" description="Choose the organization-approved model routes available to assignments." values={protectedPolicyAllowed(baseline.constraints.modelAliases)} labels={workspaceModelNames} selected={editor.modelAliases} onChange={(modelAliases) => setEditor({ ...editor, modelAliases })} />
        <ProtectedPolicyResourceEditor legend="Service levels" description="Choose the service levels members may request." values={protectedPolicyAllowed(baseline.constraints.serviceClasses)} labels={protectedPolicyServiceClassNames} selected={editor.serviceClasses} onChange={(serviceClasses) => setEditor({ ...editor, serviceClasses })} />
        <ProtectedPolicyResourceEditor legend="Connections" description="Control connector availability here. Review exact tool permissions in Connections." values={protectedPolicyAllowed(baseline.constraints.connectors)} labels={protectedPolicyConnectorNames} selected={editor.connectors} onChange={(connectors) => setEditor({ ...editor, connectors })} />
        <fieldset className="workspace-policy-editor-group workspace-policy-editor-limits"><legend>Thinking and workspace security</legend><p>Set ceilings that every member assignment must remain within.</p><div className="workspace-policy-limit-grid">
          <label><span>Maximum thinking</span><SelectMenu value={editor.maximumReasoningEffort} ariaLabel="Maximum thinking level" options={protectedPolicyReasoningOptions.filter((value) => protectedPolicyReasoningOptions.indexOf(value) <= protectedPolicyReasoningOptions.indexOf(baseline.constraints.maximumReasoningEffort)).map((value) => ({ value, label: protectedPolicyReasoningName(value) }))} onValueChange={(maximumReasoningEffort) => setEditor({ ...editor, maximumReasoningEffort })} /></label>
          <label><span>Internet access ceiling</span><SelectMenu value={editor.maximumEgressMode} ariaLabel="Internet access ceiling" options={[{ value: "restricted", label: "Restricted" }, ...(baseline.constraints.maximumEgressMode === "full-web" ? [{ value: "full-web", label: "Full web" }] : [])]} onValueChange={(maximumEgressMode) => setEditor({ ...editor, maximumEgressMode })} /></label>
          <label><span>Clipboard limit (KB)</span><input type="number" min="1" max={Math.round(baseline.constraints.clipboard.maxBytes / 1024)} value={editor.clipboardMaxKb} onChange={(event) => setEditor({ ...editor, clipboardMaxKb: Number(event.target.value) })} /></label>
          <label className="workspace-policy-switch"><input type="checkbox" checked={editor.clipboardLocalToWorkspace} onChange={(event) => setEditor({ ...editor, clipboardLocalToWorkspace: event.target.checked })} /><span><strong>Copy into workspace</strong><small>Allow local clipboard content to enter the workspace.</small></span></label>
          <label className="workspace-policy-switch"><input type="checkbox" checked={editor.clipboardWorkspaceToLocal} onChange={(event) => setEditor({ ...editor, clipboardWorkspaceToLocal: event.target.checked })} /><span><strong>Copy out of workspace</strong><small>Allow workspace clipboard content to return locally.</small></span></label>
        </div></fieldset>
        <label className="workspace-policy-revision-note"><span>Change summary</span><textarea rows="3" maxLength="240" placeholder="Explain why this version is being created" value={editor.revisionNote} onChange={(event) => setEditor({ ...editor, revisionNote: event.target.value })} /><small>This note appears in immutable version history.</small></label>
      </div>
      {error && <div className="workspace-policy-modal-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="secondary-button" type="button" disabled={savingPolicy} onClick={() => { setEditor(null); setError(""); }}>Cancel</button><button className="primary-button" type="button" disabled={!editorReady || savingPolicy} onClick={savePolicy}>{savingPolicy ? "Saving version" : latest ? "Save as new version" : "Save organization policy"}</button></div>
    </ModalDialog>}

    {baselineOpen && <ModalDialog className="workspace-policy-baseline-modal" title="Office worker baseline" description="This LemmaComputer release defines the maximum workspace configuration. Organization policy can only make it stricter." eyebrow={`Locked product baseline · v${baseline.version}`} labelledBy="workspace-policy-baseline-title" onClose={() => setBaselineOpen(false)}><div className="workspace-policy-baseline-details"><section><strong>Agents</strong><span>{protectedPolicyList(protectedPolicyAllowed(baseline.constraints.agents), protectedPolicyAgentNames).join(", ")}</span></section><section><strong>Applications</strong><span>{protectedPolicyList(protectedPolicyAllowed(baseline.constraints.applications), applicationNames).join(", ")}</span></section><section><strong>Connections</strong><span>{protectedPolicyList(protectedPolicyAllowed(baseline.constraints.connectors), protectedPolicyConnectorNames).join(", ") || "None"}</span></section><section><strong>Models and thinking</strong><span>{protectedPolicyAllowed(baseline.constraints.modelAliases).length} approved routes · maximum {protectedPolicyReasoningName(baseline.constraints.maximumReasoningEffort)}</span></section><section><strong>Workspace security</strong><span>{baseline.constraints.maximumEgressMode === "restricted" ? "Restricted internet" : "Full web permitted"} · {protectedPolicyClipboardSummary(baseline.constraints.clipboard)}</span></section><section><strong>Release provenance</strong><span>{baseline.release.releaseId} · published {protectedPolicyDate(baseline.release.publishedAt)}</span></section></div><div className="modal-actions"><span /><button className="primary-button" type="button" onClick={() => setBaselineOpen(false)}>Done</button></div></ModalDialog>}

    {reviewUser && <ModalDialog className="workspace-policy-review-modal" title={reviewUser.displayName} description="Review the immutable policy version currently assigned to this member." eyebrow="Member policy assignment" labelledBy="workspace-policy-review-title" onClose={busyUserId ? () => undefined : () => setReviewUser(null)}>{(() => { const assignment = assignments[reviewUser.userId]; return <><div className="workspace-policy-review-details"><section><strong>Assignment state</strong><span>{assignment?.state === "selected" ? "Assigned" : assignment?.state === "revoked" ? "Access revoked" : "Not assigned"}</span></section>{assignment?.state === "selected" && <><section><strong>Agents</strong><span>{protectedPolicyList(assignment.selection.agentIds, protectedPolicyAgentNames).join(", ")}</span></section><section><strong>Applications</strong><span>{protectedPolicyList(assignment.selection.applicationIds, applicationNames).join(", ")}</span></section><section><strong>Model and service</strong><span>{workspaceModelName(assignment.selection.modelAlias)} · {protectedPolicyServiceClassNames[assignment.selection.serviceClass] ?? assignment.selection.serviceClass} · {protectedPolicyReasoningName(assignment.selection.reasoningEffort)} thinking</span></section><section><strong>Assigned</strong><span>{protectedPolicyDate(assignment.createdAt)}</span></section></>}</div><div className="modal-actions"><button className="danger-button secondary-button" type="button" disabled={busyUserId === reviewUser.userId} onClick={() => revoke(reviewUser)}>{busyUserId === reviewUser.userId ? "Revoking" : "Revoke workspace access"}</button><button className="primary-button" type="button" onClick={() => setReviewUser(null)}>Done</button></div></>; })()}</ModalDialog>}
  </section>;
}

const workspaceHealthLabel = {
  healthy: "Healthy",
  transitioning: "Updating",
  offline: "Offline",
  needs_attention: "Needs attention",
};
const workspaceAdminDate = (value) => value
  ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "No agent activity yet";

function MemberWorkspaceConsole({ members, loading, error, busyWorkspaceId, onCommand }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const total = members.reduce((count, member) => count + member.workspaceCount, 0);
  const normalizedSearch = search.trim().toLowerCase();
  const statusMatches = (workspace) => statusFilter === "all"
    || statusFilter === "running" && ["provisioning", "ready", "open", "restarting"].includes(workspace.state)
    || statusFilter === "stopped" && ["not_created", "stopped"].includes(workspace.state)
    || statusFilter === "attention" && (workspace.state === "failed" || workspace.health.status === "needs_attention");
  const filteredMembers = members.map((member) => ({
    ...member,
    workspaces: member.workspaces.filter((workspace) => statusMatches(workspace)
      && (!normalizedSearch || `${member.displayName} ${member.email} ${workspace.name}`.toLowerCase().includes(normalizedSearch))),
  })).filter((member) => member.workspaces.length > 0
    || statusFilter === "all" && (!normalizedSearch || `${member.displayName} ${member.email}`.toLowerCase().includes(normalizedSearch)));
  return <section className="member-workspace-console" aria-labelledby="member-workspace-console-heading">
    <div className="member-workspace-filters">
      <label className="member-workspace-search"><span className="sr-only">Search members or workspaces</span><Search24Regular aria-hidden="true" /><input type="search" value={search} placeholder="Search members or workspaces" onChange={(event) => setSearch(event.target.value)} /></label>
      <SelectMenu value={statusFilter} options={[{ value: "all", label: "All statuses" }, { value: "running", label: "Running" }, { value: "stopped", label: "Stopped" }, { value: "attention", label: "Needs attention" }]} ariaLabel="Workspace status" onValueChange={setStatusFilter} />
    </div>
    {error && <div className="member-workspace-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Workspace controls unavailable</strong>{error}</span></div>}
    {loading ? <p className="admin-empty-state" role="status">Loading member workspaces…</p> : members.length === 0 ? (
      <p className="admin-empty-state">No member workspaces are assigned to you.</p>
    ) : <div className="member-workspace-table" role="table" aria-label="Organization workspaces">
      <div className="member-workspace-summary"><strong>{members.length} {members.length === 1 ? "member" : "members"}</strong><strong>{total} {total === 1 ? "workspace" : "workspaces"}</strong><small>Administrators can manage runtime state but cannot open member workspaces or view their content.</small></div>
      <div className="member-workspace-table-header" role="row">
        <span role="columnheader">Member</span><span role="columnheader">Workspace</span><span role="columnheader">Status</span><span role="columnheader">Health</span><span role="columnheader">Profile</span><span role="columnheader">Policy version</span><span role="columnheader">Last agent activity</span><span role="columnheader">Actions</span>
      </div>
      {filteredMembers.length === 0 ? <p className="admin-empty-state">No workspaces match these filters.</p> : <div className="member-workspace-members">{filteredMembers.map((member) => member.workspaces.length === 0
        ? <div className="member-workspace-row empty" role="row" key={member.userId}>
          <div className="member-workspace-member-copy" role="cell"><strong>{member.displayName}</strong><small>{member.email}</small><span>No workspaces</span></div>
          <div className="member-workspace-no-runtime" role="cell">No workspace has been created yet.</div>
        </div>
        : member.workspaces.map((workspace, index) => {
        const busy = busyWorkspaceId === workspace.id || busyStates.has(workspace.state);
        const running = ["provisioning", "ready", "open", "restarting"].includes(workspace.state);
        return <section className="member-workspace-row" role="row" key={workspace.id} aria-label={`${workspace.name} for ${member.displayName}`}>
          <div className="member-workspace-member-copy" role="cell">{index === 0 && <><strong>{member.displayName}</strong><small>{member.email}</small><span>{member.workspaceCount} {member.workspaceCount === 1 ? "workspace" : "workspaces"}</span></>}</div>
          <div className="member-workspace-name" role="cell" data-label="Workspace"><strong>{workspace.name}</strong></div>
          <div role="cell" data-label="Status"><span className={`workspace-state state-${workspace.state}`}>{workspaceStatus(workspace.state)}</span></div>
          <div className={`member-workspace-health ${workspace.health.status}`} role="cell" data-label="Health">{workspace.health.status === "healthy" && <CheckmarkCircle24Regular aria-hidden="true" />}<span>{workspaceHealthLabel[workspace.health.status] ?? "Unknown"}</span></div>
          <div className="member-workspace-profile" role="cell" data-label="Profile">{workspace.profile?.id ?? "Unavailable"}</div>
          <div role="cell" data-label="Policy version">{workspace.policyAssignment ? `Policy v${workspace.policyAssignment.version}` : "Not assigned"}</div>
          <div className="member-workspace-activity" role="cell" data-label="Last agent activity">{workspaceAdminDate(workspace.lastActivityAt)}</div>
          <div className="member-workspace-actions" role="cell" data-label="Actions">
            {!running && <button className="primary-button" type="button" disabled={busy} onClick={() => onCommand(member, workspace, "start")}>Start</button>}
            {running && <><div><button className="secondary-button" type="button" disabled={busy} onClick={() => onCommand(member, workspace, "restart")}>Restart</button><button className="secondary-button" type="button" disabled={busy} onClick={() => onCommand(member, workspace, "stop")}>Stop</button></div><button className="connection-quiet-button danger-button" type="button" disabled={busy} onClick={() => onCommand(member, workspace, "terminate_runtime")}>Terminate runtime</button></>}
            {busy && <small role="status">Updating…</small>}
          </div>
        </section>;
      }))}</div>}
    </div>}
  </section>;
}

function AdminScreen({ users, invitations, delegableBuiltInRoles, currentUserId, loading, invitationBusy, busyUserId, canManageMembers, canManageRoles, canManageSettings, onInvite, onResendInvitation, onRevokeInvitation, onRoleChange, onStatusChange, onTransferOwnership, onInitiateClosure, onRevokeSessions, onBack }) {
  const allRoleOptions = [
    { value: "member", label: "Member" },
    { value: "admin", label: "Administrator" },
    { value: "owner", label: "Owner" },
  ];
  const roleOptions = allRoleOptions.filter((option) => option.value !== "owner" && delegableBuiltInRoles.includes(option.value));
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteDraft, setInviteDraft] = useState({ email: "", role: "member" });
  const [acceptancePath, setAcceptancePath] = useState("");
  const [deliveryWarning, setDeliveryWarning] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferCode, setTransferCode] = useState("");
  const [closureOpen, setClosureOpen] = useState(false);
  const [closureReason, setClosureReason] = useState("");
  const [closureCode, setClosureCode] = useState("");
  const [closureStatus, setClosureStatus] = useState("");
  const closureIdempotencyKey = useRef(crypto.randomUUID());
  const currentMembership = users.find((user) => user.userId === currentUserId);
  const isOwner = currentMembership?.role === "owner" && currentMembership?.membershipStatus === "active";
  const invite = async () => {
    const result = await onInvite(inviteDraft);
    if (!result) return;
    setInviteDraft({ email: "", role: "member" });
    setInviteOpen(false);
    if (result.acceptancePath) {
      setAcceptancePath(result.acceptancePath);
      setDeliveryWarning(result.delivery?.warning ?? "Share this single-use link through a trusted channel. Resending rotates it.");
      setLinkCopied(false);
    }
  };
  const resend = async (invitation) => {
    const result = await onResendInvitation(invitation);
    if (result?.acceptancePath) {
      setAcceptancePath(result.acceptancePath);
      setDeliveryWarning(result.delivery?.warning ?? "Share this single-use link through a trusted channel. Resending rotates it.");
      setLinkCopied(false);
    }
  };
  const acceptanceUrl = acceptancePath ? new URL(acceptancePath, window.location.origin).toString() : "";
  const transferOwnership = async () => {
    if (!transferTarget) return;
    if (await onTransferOwnership(transferTarget, transferCode)) {
      setTransferCode("");
      setTransferTarget(null);
    }
  };
  const initiateClosure = async () => {
    const result = await onInitiateClosure(closureReason, closureIdempotencyKey.current, closureCode);
    if (!result) return;
    setClosureOpen(false);
    setClosureCode("");
    setClosureStatus(`Organization closure is pending until ${new Date(result.request.executeAfter).toLocaleDateString()}.`);
  };
  return (
    <div className="secondary-screen admin-screen">
      <button className="settings-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />Back to Settings</button>
      <header className="page-heading compact">
        <p>Organization administration</p>
        <h1>People and access</h1>
        <span>Invite people, assign organization roles, and remove access. Identity-provider credentials remain outside LemmaComputer.</span>
      </header>
      {canManageMembers && <><section className="admin-access-summary" aria-labelledby="organization-access-heading">
        <div><p>Organization access</p><h2 id="organization-access-heading">Members and invitations</h2><span>Invitations expire after seven days. The selected organization and role cannot be changed by identity-provider claims.</span></div>
        <button className="primary-button admin-section-action" type="button" disabled={!roleOptions.length} onClick={() => setInviteOpen(true)}>Invite person</button>
      </section>
      {acceptanceUrl && <section className="admin-invitation-link" aria-live="polite">
        <div><strong>Invitation link created</strong><small>{deliveryWarning}</small></div>
        <input aria-label="Invitation link" readOnly value={acceptanceUrl} />
        <button className="secondary-button" type="button" onClick={async () => {
          await navigator.clipboard?.writeText(acceptanceUrl);
          setLinkCopied(true);
        }}>{linkCopied ? "Copied" : "Copy link"}</button>
        <button className="connection-quiet-button" type="button" onClick={() => { setAcceptancePath(""); setDeliveryWarning(""); }}>Dismiss</button>
      </section>}
      <section className="admin-invitation-list" aria-labelledby="organization-invitations-heading">
        <div className="admin-section-heading"><div><p>Invitations</p><h2 id="organization-invitations-heading">Organization invitations</h2></div><span>{invitations.length}</span></div>
        {!invitations.length ? <p className="admin-empty-state">No invitations have been created.</p> : invitations.map((item) => <article key={item.invitationId}>
          <div><strong>{item.email}</strong><small>{allRoleOptions.find((option) => option.value === item.role)?.label ?? item.role} · expires {new Date(item.expiresAt).toLocaleDateString()}</small></div>
          <span className={`admin-access-status ${item.status}`}>{item.status}</span>
          <div className="admin-invitation-actions">
            {(item.status === "pending" || item.status === "expired") && <button className="secondary-button" type="button" disabled={invitationBusy} onClick={() => resend(item)}>Resend</button>}
            {(item.status === "pending" || item.status === "expired") && <button className="connection-quiet-button danger-button" type="button" disabled={invitationBusy} onClick={() => onRevokeInvitation(item)}>Revoke</button>}
          </div>
        </article>)}
      </section>
      <section className="admin-member-section" aria-labelledby="organization-members-heading">
        <div className="admin-section-heading"><div><p>People</p><h2 id="organization-members-heading">Organization members</h2></div><span>{users.length}</span></div>
        <div className="admin-user-list" aria-label="Organization users">
          {loading ? <p>Loading organization users…</p> : users.map((item) => {
            const membershipStatus = item.membershipStatus ?? (item.status === "disabled" ? "suspended" : "active");
            return <article key={item.userId}>
              <div className="admin-user-copy">
                <strong>{item.displayName}</strong><small>{item.email}</small>
                <div className="admin-user-badges">
                  <span>{allRoleOptions.find((option) => option.value === item.role)?.label ?? (item.roles.includes("administrator") ? "Administrator" : "Member")}</span>
                  {membershipStatus !== "active" && <span className="disabled">{membershipStatus}</span>}
                </div>
              </div>
              <div className="admin-policy-copy">
                {canManageRoles && roleOptions.some((option) => option.value === (item.role ?? (item.roles.includes("administrator") ? "admin" : "member"))) && <label><span>Organization role</span><SelectMenu value={item.role ?? (item.roles.includes("administrator") ? "admin" : "member")} options={roleOptions} ariaLabel={`Organization role for ${item.displayName}`} disabled={busyUserId === item.userId || membershipStatus !== "active"} onValueChange={(role) => onRoleChange(item, role)} /></label>}
              </div>
              <div className="admin-user-actions">
                {isOwner && item.userId !== currentUserId && membershipStatus === "active" && <button className="secondary-button admin-row-action" type="button" disabled={busyUserId === item.userId} onClick={() => { setTransferCode(""); setTransferTarget(item); }}>Transfer ownership</button>}
                <button className="secondary-button admin-row-action" type="button" disabled={busyUserId === item.userId} onClick={() => onRevokeSessions(item.userId)}>Sign out sessions</button>
                {item.userId !== currentUserId && membershipStatus !== "revoked" && <button className={`secondary-button admin-row-action${membershipStatus === "active" ? " danger-button" : ""}`} type="button" disabled={busyUserId === item.userId} onClick={() => onStatusChange(item, membershipStatus === "active" ? "suspended" : "active")}>{membershipStatus === "active" ? "Suspend" : "Reactivate"}</button>}
                {item.userId !== currentUserId && membershipStatus !== "revoked" && <button className="secondary-button admin-row-action danger-button" type="button" disabled={busyUserId === item.userId} onClick={() => onStatusChange(item, "revoked")}>Remove access</button>}
              </div>
            </article>;
          })}
        </div>
      </section>
      {isOwner && <section className="admin-access-summary admin-lifecycle-summary" aria-labelledby="organization-lifecycle-heading">
        <div><p>Protected owner action</p><h2 id="organization-lifecycle-heading">Organization lifecycle</h2><span>Closure starts a seven-day pending period. Recent MFA verification is required, and no data is deleted by this initiation step.</span></div>
        <button className="secondary-button danger-button admin-section-action" type="button" onClick={() => { setClosureCode(""); setClosureOpen(true); }}>Initiate organization closure</button>
      </section>}
      {closureStatus && <div className="signin-status" role="status">{closureStatus}</div>}
      </>}
      {canManageSettings && <OrganizationSsoSection isOwner={isOwner} />}
      {canManageRoles && <OrganizationRoleEditor users={users} />}
      {canManageMembers && inviteOpen && <ModalDialog title="Invite a person" description="Create pending product access. The person will choose their password and complete supported MFA with the configured identity provider." eyebrow="Organization access" labelledBy="organization-invite-title" onClose={invitationBusy ? () => undefined : () => setInviteOpen(false)}>
        <label className="modal-field"><span>Email address</span><input name="organization-invite-email" type="email" autoComplete="off" value={inviteDraft.email} onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })} placeholder="person@example.com" disabled={invitationBusy} /></label>
        <label className="modal-field"><span>Organization role</span><SelectMenu value={roleOptions.some((option) => option.value === inviteDraft.role) ? inviteDraft.role : roleOptions[0]?.value ?? ""} options={roleOptions} ariaLabel="Invited organization role" disabled={invitationBusy || !roleOptions.length} onValueChange={(role) => setInviteDraft({ ...inviteDraft, role })} /><small>Only roles within your server-verified delegation authority are available.</small></label>
        <div className="modal-actions"><button className="secondary-button" type="button" disabled={invitationBusy} onClick={() => setInviteOpen(false)}>Cancel</button><button className="primary-button" type="button" disabled={invitationBusy || !inviteDraft.email.trim()} onClick={invite}>{invitationBusy ? "Creating invitation" : "Create invitation"}</button></div>
      </ModalDialog>}
      {transferTarget && <ModalDialog title="Transfer organization ownership" description={`Make ${transferTarget.displayName} the protected owner and change your membership to Administrator.`} eyebrow="Protected owner action" labelledBy="organization-ownership-transfer-title" onClose={busyUserId ? () => undefined : () => setTransferTarget(null)}>
        <label className="modal-field"><span>Authenticator code</span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={transferCode} onChange={(event) => setTransferCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
        <div className="signin-status" role="status">Verify this action with the six-digit code from your authenticator. Both memberships will be signed out after transfer.</div>
        <div className="modal-actions"><button className="secondary-button" type="button" disabled={Boolean(busyUserId)} onClick={() => setTransferTarget(null)}>Cancel</button><button className="primary-button danger-button" type="button" disabled={Boolean(busyUserId) || !/^\d{6}$/.test(transferCode)} onClick={transferOwnership}>{busyUserId ? "Transferring ownership" : "Transfer ownership"}</button></div>
      </ModalDialog>}
      {closureOpen && <ModalDialog title="Initiate organization closure" description="Start a seven-day pending period. This does not immediately delete data or close the organization." eyebrow="Protected owner action" labelledBy="organization-closure-title" onClose={invitationBusy ? () => undefined : () => setClosureOpen(false)}>
        <label className="modal-field"><span>Reason for closure</span><textarea value={closureReason} minLength={12} maxLength={1000} rows={4} onChange={(event) => setClosureReason(event.target.value)} /></label>
        <label className="modal-field"><span>Authenticator code</span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={closureCode} onChange={(event) => setClosureCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
        <div className="signin-status" role="status">Verify this protected owner action with the six-digit code from your authenticator.</div>
        <div className="modal-actions"><button className="secondary-button" type="button" disabled={invitationBusy} onClick={() => setClosureOpen(false)}>Cancel</button><button className="primary-button danger-button" type="button" disabled={invitationBusy || closureReason.trim().length < 12 || !/^\d{6}$/.test(closureCode)} onClick={initiateClosure}>Initiate closure</button></div>
      </ModalDialog>}
    </div>
  );
}

function CredentialsScreen({ credentials, workspaces, loading, busy, error, onCreate, onRotate, onDelete, onBack }) {
  const [newToken, setNewToken] = useState("");
  const [rotation, setRotation] = useState(null);
  const workspaceLabel = (workspaceId) => workspaceName(workspaces.find((item) => item.id === workspaceId));
  const create = async () => {
    if (!newToken.trim()) return;
    const created = await onCreate(newToken.trim());
    if (created) setNewToken("");
  };
  const rotate = async () => {
    if (!rotation?.token.trim()) return;
    const saved = await onRotate(rotation.id, rotation.token.trim());
    if (saved) setRotation(null);
  };
  return (
    <div className="secondary-screen settings-screen credentials-screen">
      <button className="settings-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />Back to Settings</button>
      <header className="page-heading compact">
        <p>Write-only credential storage</p>
        <h1>Credentials</h1>
        <span>Store credentials for reviewed integrations. Their secret values remain encrypted in the trusted broker and are never displayed again.</span>
      </header>
      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Credential operation failed</strong>{error}</span></div>}
      <section className="credential-create-card" aria-labelledby="credential-add-heading">
        <div><p>Supported credential</p><h2 id="credential-add-heading">Telegram bot token</h2><span>Create a dedicated bot with BotFather. After validation, attach it from a workspace’s Channels section.</span></div>
        <label><span>New bot token</span><input name="new-telegram-credential" type="password" autoComplete="new-password" value={newToken} onChange={(event) => setNewToken(event.target.value)} placeholder="123456789:AA…" disabled={busy} /></label>
        <button className="primary-button" type="button" onClick={create} disabled={busy || !newToken.trim()}>{busy ? "Validating credential" : "Add Telegram credential"}</button>
      </section>
      <section className="credential-inventory" aria-labelledby="credential-inventory-heading">
        <div className="credential-inventory-heading"><div><p>Inventory</p><h2 id="credential-inventory-heading">Saved credentials</h2></div><span>{credentials.length}</span></div>
        {loading ? <p className="credential-empty">Loading credentials…</p> : !credentials.length ? <p className="credential-empty">No channel credentials are stored yet.</p> : credentials.map((credential) => (
          <article key={credential.id}>
            <span className="connection-logo compact"><Bot24Regular aria-hidden="true" /></span>
            <div className="credential-copy"><strong>{credential.displayName}</strong><small>Telegram bot token · version {credential.version}</small><span>{credential.workspaceId ? `Attached to ${workspaceLabel(credential.workspaceId)}` : "Not attached"}</span></div>
            <div className="credential-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setRotation({ id: credential.id, token: "" })}>Rotate</button>
              <button className="connection-quiet-button" type="button" disabled={busy} onClick={() => onDelete(credential)}>Delete</button>
            </div>
          </article>
        ))}
      </section>
      {rotation && <ModalDialog title="Rotate Telegram credential" description="The new token is validated and committed as a new credential version. The old token is no longer used by the broker." eyebrow="Write-only replacement" labelledBy="credential-rotation-title" onClose={busy ? () => undefined : () => setRotation(null)}>
        <label className="modal-field"><span>Replacement bot token</span><input name="rotated-telegram-credential" type="password" autoComplete="new-password" value={rotation.token} onChange={(event) => setRotation({ ...rotation, token: event.target.value })} placeholder="123456789:AA…" /></label>
        <div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setRotation(null)}>Cancel</button><button className="primary-button" type="button" disabled={busy || !rotation.token.trim()} onClick={rotate}>{busy ? "Rotating" : "Rotate credential"}</button></div>
      </ModalDialog>}
    </div>
  );
}

function ProviderSettingsScreen({ providers, loading, busy, error, onSave, onTest, onDisable, onDelete }) {
  const [editor, setEditor] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const closeEditor = () => { setApiKey(""); setEditor(null); };
  const openEditor = (provider) => {
    const selectedModelIds = provider.selectedModelIds?.length
      ? provider.selectedModelIds
      : provider.modelId
        ? [provider.modelId]
        : provider.modelOptions?.[0]?.id
          ? [provider.modelOptions[0].id]
          : [];
    setApiKey("");
    setEditor({
      ...provider,
      selectedModelIds,
      region: provider.region ?? "ap-southeast-1",
      emissionsRegion: provider.emissionsRegion ?? (provider.provider === "bedrock" ? inferredBedrockEmissionsRegion(provider.region ?? "ap-southeast-1") : ""),
      modelProfileId: provider.modelProfileId ?? "claude-sonnet-4-5-global",
    });
  };
  const toggleModel = (modelId, selected) => setEditor((current) => ({
    ...current,
    selectedModelIds: selected
      ? [...new Set([...current.selectedModelIds, modelId])]
      : current.selectedModelIds.filter((id) => id !== modelId),
  }));
  const save = async () => {
    const submitted = apiKey.trim();
    if (!editor || !submitted || !editor.emissionsRegion || (editor.provider !== "bedrock" && !editor.selectedModelIds.length)) return;
    setApiKey("");
    const input = editor.provider === "bedrock"
      ? { apiKey: submitted, region: editor.region, modelProfileId: editor.modelProfileId, emissionsRegion: editor.emissionsRegion }
      : { apiKey: submitted, modelIds: editor.selectedModelIds, emissionsRegion: editor.emissionsRegion };
    const saved = await onSave(editor.provider, input);
    if (saved) setEditor(null);
  };
  return (
    <div className="secondary-screen settings-screen provider-settings-screen">
      <header className="page-heading compact">
        <p>Model access</p>
        <h1>Provider settings</h1>
        <span>Connect provider credentials and choose the deployments that organization routing may use. Credentials remain write-only.</span>
      </header>
      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Provider operation failed</strong>{error}</span></div>}
      <section className="credential-inventory provider-settings-inventory" aria-labelledby="provider-settings-heading">
        <div className="credential-inventory-heading"><div><p>Organization routes</p><h2 id="provider-settings-heading">Managed providers</h2></div><span>{providers.length}</span></div>
        {loading ? <p className="credential-empty">Loading provider settings…</p> : providers.map((provider) => {
          const needsRecovery = provider.state === "needs-reconfiguration";
          const stateLabel = provider.state === "active" ? "Active" : provider.state === "disabled" ? "Disabled" : needsRecovery ? "Needs reconfiguration" : "Not configured";
          const deployments = provider.deployments ?? [];
          return (
            <article key={provider.provider}>
              <span className="connection-logo compact"><Bot24Regular aria-hidden="true" /></span>
              <div className="credential-copy">
                <strong>{providerTitle(provider.provider)}</strong>
                {deployments.length > 0 ? <ul className="provider-deployment-list" aria-label={`${providerTitle(provider.provider)} configured deployments`}>
                  {deployments.map((deployment) => {
                    const modelId = deployment.modelId ?? deployment.id;
                    const displayName = deployment.displayName ?? deployment.upstreamModelDisplayName ?? provider.modelOptions?.find((option) => option.id === modelId)?.displayName ?? modelId;
                    const aliases = deployment.aliases ?? (deployment.alias ? [deployment.alias] : []);
                    const capabilities = providerModelCapabilityLabels(deployment.modelCapabilities);
                    return <li key={deployment.id ?? modelId}><strong>{displayName}</strong><small>{aliases.length ? aliases.join(" · ") : modelId}</small>{capabilities.length > 0 && <small className="provider-model-capabilities">{capabilities.join(" · ")}</small>}</li>;
                  })}
                </ul> : <small>{provider.primaryAlias} · {provider.upstreamModelDisplayName}</small>}
                <span>{stateLabel}{provider.fingerprint ? <> · {provider.fingerprint}</> : null}</span>
                {provider.provider === "bedrock" && provider.region && <span>Region {provider.region} · Profile {provider.modelProfileId}</span>}
                <span>{provider.emissionsRegion ? "Emissions grid " + emissionsRegionLabel(provider.emissionsRegion) : "Emissions estimate not configured"}</span>
                {provider.lastTestedAt && <span>Last tested {new Date(provider.lastTestedAt).toLocaleString()}</span>}
                {provider.lastErrorCode && <span>Last safe error: {provider.lastErrorCode}</span>}
              </div>
              <div className="credential-actions">
                {!needsRecovery && <button className="secondary-button" type="button" disabled={busy} onClick={() => openEditor(provider)}>{provider.state === "active" ? "Configure" : "Connect"}</button>}
                {provider.state === "active" && <button className="secondary-button" type="button" disabled={busy} onClick={() => onTest(provider.provider)}>Test</button>}
                {(provider.state === "active" || needsRecovery) && <button className="connection-quiet-button" type="button" disabled={busy} onClick={() => onDisable(provider.provider)}>Disable</button>}
                {provider.state !== "not-configured" && <button className="connection-quiet-button" type="button" disabled={busy} onClick={() => onDelete(provider.provider)}>Delete</button>}
              </div>
            </article>
          );
        })}
      </section>
      {editor && <ModalDialog title={(editor.state === "active" ? "Configure " : "Connect ") + providerTitle(editor.provider)} description={editor.provider === "bedrock" ? "Choose an approved Bedrock region and inference profile. The API key is encrypted and never displayed again." : "Choose every approved model this provider should make available to organization routing. Re-enter the provider key to validate and apply the deployment set."} eyebrow="Write-only provider key" labelledBy="provider-key-title" onClose={busy ? () => undefined : closeEditor}>
        {editor.modelOptions?.length > 0 && <fieldset className="provider-model-options">
          <legend>Models available for routing</legend>
          <span>Select one or more provider models. Model routes decide which tier uses each deployment.</span>
          {editor.modelOptions.map((option) => <label key={option.id}>
            <input type="checkbox" checked={editor.selectedModelIds.includes(option.id)} disabled={busy} onChange={(event) => toggleModel(option.id, event.target.checked)} />
            <span><strong>{option.displayName}</strong><small>{option.id}</small>{providerModelCapabilityLabels(option.modelCapabilities).length > 0 && <small className="provider-model-capabilities">{providerModelCapabilityLabels(option.modelCapabilities).join(" · ")}</small>}</span>
          </label>)}
        </fieldset>}
        {editor.provider === "bedrock" && <>
          <label className="modal-field"><span>Approved region</span><SelectMenu value={editor.region} options={bedrockRegionOptions} ariaLabel="Approved Bedrock region" disabled={busy || editor.state === "active"} onValueChange={(region) => setEditor((current) => ({ ...current, region }))} /></label>
          <label className="modal-field"><span>Approved inference profile</span><SelectMenu value={editor.modelProfileId} options={bedrockProfileOptions} ariaLabel="Approved Bedrock inference profile" disabled={busy || editor.state === "active"} onValueChange={(modelProfileId) => setEditor((current) => ({ ...current, modelProfileId }))} /></label>
        </>}
        <label className="modal-field"><span>Estimated serving grid</span><SelectMenu value={editor.emissionsRegion} options={accountingRegionOptions} ariaLabel="Estimated serving grid for emissions" disabled={busy} onValueChange={(emissionsRegion) => setEditor((current) => ({ ...current, emissionsRegion }))} /><small>Accounting assumption only; this does not control or guarantee the provider’s inference location.</small></label>
        <label className="modal-field"><span>{providerTitle(editor.provider)} API key</span><input name="provider-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste the provider API key" disabled={busy} /></label>
        <div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={closeEditor}>Cancel</button><button className="primary-button" type="button" disabled={busy || !apiKey.trim() || !editor.emissionsRegion || (editor.provider !== "bedrock" && !editor.selectedModelIds.length)} onClick={save}>{busy ? "Validating" : editor.state === "active" ? "Apply configuration" : "Connect provider"}</button></div>
      </ModalDialog>}
    </div>
  );
}

function SettingsScreen({ view, canManageMembers, canManageRoles, canManageSettings, delegableBuiltInRoles, currentUserId, onOpenAdmin, onOpenCredentials, onOpenAccountSecurity, onBack, credentials, workspaces, credentialsLoading, credentialsBusy, credentialsError, onCreateCredential, onRotateCredential, onDeleteCredential, users, invitations, loading, invitationBusy, busyUserId, onInvite, onResendInvitation, onRevokeInvitation, onRoleChange, onStatusChange, onTransferOwnership, onInitiateClosure, onRevokeSessions }) {
  if (view === "admin" && (canManageMembers || canManageRoles || canManageSettings)) {
    return <AdminScreen
      users={users}
      invitations={invitations}
      delegableBuiltInRoles={delegableBuiltInRoles}
      currentUserId={currentUserId}
      loading={loading}
      invitationBusy={invitationBusy}
      busyUserId={busyUserId}
      canManageMembers={canManageMembers}
      canManageRoles={canManageRoles}
      canManageSettings={canManageSettings}
      onInvite={onInvite}
      onResendInvitation={onResendInvitation}
      onRevokeInvitation={onRevokeInvitation}
      onRoleChange={onRoleChange}
      onStatusChange={onStatusChange}
      onTransferOwnership={onTransferOwnership}
      onInitiateClosure={onInitiateClosure}
      onRevokeSessions={onRevokeSessions}
      onBack={onBack}
    />;
  }
  if (view === "credentials") {
    return <CredentialsScreen credentials={credentials} workspaces={workspaces} loading={credentialsLoading} busy={credentialsBusy} error={credentialsError} onCreate={onCreateCredential} onRotate={onRotateCredential} onDelete={onDeleteCredential} onBack={onBack} />;
  }

  return (
    <div className="secondary-screen settings-screen">
      <header className="page-heading compact">
        <p>Account and workspace</p>
        <h1>Settings</h1>
        <span>Manage your credentials and current workspace controls.</span>
      </header>
      <section className="settings-list" aria-label="Settings">
        <button className="settings-item" type="button" onClick={onOpenAccountSecurity}>
          <span className="settings-item-icon"><ShieldCheckmark24Regular aria-hidden="true" /></span>
          <span className="settings-item-copy"><strong>Account security</strong><small>Manage sign-in methods, authenticator verification, and device sessions.</small></span>
          <ChevronRight16Regular aria-hidden="true" />
        </button>
        <button className="settings-item" type="button" onClick={onOpenCredentials}>
          <span className="settings-item-icon"><ShieldCheckmark24Regular aria-hidden="true" /></span>
          <span className="settings-item-copy"><strong>Credentials</strong><small>Manage write-only credentials for official workspace channels.</small></span>
          <ChevronRight16Regular aria-hidden="true" />
        </button>
        {(canManageMembers || canManageRoles || canManageSettings) && <button className="settings-item" type="button" onClick={onOpenAdmin}>
          <span className="settings-item-icon"><Settings24Regular aria-hidden="true" /></span>
          <span className="settings-item-copy"><strong>People and access</strong><small>Invite people, assign organization roles, and configure company sign-in.</small></span>
          <ChevronRight16Regular aria-hidden="true" />
        </button>}
      </section>
    </div>
  );
}

function FirewallScreen({ loading, versions, saving, onSave }) {
  const latestVersions = versions.filter((item, index, all) => (
    all.findIndex((candidate) => candidate.securityGroupId === item.securityGroupId) === index
  ));
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState(null);
  const normalizedSearch = search.trim().toLowerCase();
  const groups = latestVersions.filter((group) => (
    !normalizedSearch
    || `${group.name} ${group.description} ${group.rules.map((rule) => `${rule.host} ${rule.purpose}`).join(" ")}`
      .toLowerCase()
      .includes(normalizedSearch)
  ));

  return (
    <div className="secondary-screen firewall-screen">
      <header className="page-heading firewall-page-heading">
        <div>
          <p>Network control</p>
          <h1>Egress firewall</h1>
          <span>Create and manage reusable security groups with Allow and Deny rules.</span>
        </div>
        <div className="firewall-page-actions">
          <button className="primary-button" type="button" onClick={() => setEditor({ securityGroupId: null, createNew: true })}><Add24Regular aria-hidden="true" />Create security group</button>
        </div>
      </header>

      <section className="firewall-security-groups" aria-labelledby="firewall-security-groups-heading">
        <div className="firewall-security-groups-heading">
          <div>
            <p>Rule collections</p>
            <h2 id="firewall-security-groups-heading">Security groups</h2>
            <span>Default applies to new workspaces. Rule changes apply live.</span>
          </div>
          <strong>{latestVersions.length} {latestVersions.length === 1 ? "group" : "groups"}</strong>
        </div>
        <div className="firewall-group-toolbar">
          <label className="firewall-search"><span className="sr-only">Search security groups</span><input id="firewall-security-group-search" name="firewall-security-group-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search security groups, destinations, or purposes" /></label>
        </div>
        <div className="firewall-security-group-list">
          {loading ? <p className="firewall-security-group-empty">Loading security groups…</p> : groups.length === 0 ? (
            <div className="firewall-security-group-empty">
              <strong>{normalizedSearch ? "No security groups match" : "No security groups yet"}</strong>
              <span>{normalizedSearch ? "Try a different search." : "Create a group and add Allow or Deny rules."}</span>
            </div>
          ) : groups.map((group) => {
            const allowCount = group.rules.filter((rule) => rule.action === "allow").length;
            const denyCount = group.rules.filter((rule) => rule.action === "deny").length;
            return (
              <article key={group.securityGroupId}>
                <div className="firewall-security-group-copy">
                  <button type="button" onClick={() => setEditor({ securityGroupId: group.securityGroupId, createNew: false })}>{group.name}</button>
                  <small>{group.description}</small>
                  {group.isDefault && <span className="firewall-default-badge">Default</span>}
                </div>
                <div className="firewall-security-group-rules" aria-label={`${allowCount} Allow and ${denyCount} Deny rules`}>
                  <span className="allow"><strong>{allowCount}</strong> Allow</span>
                  <span className="deny"><strong>{denyCount}</strong> Deny</span>
                </div>
                <div className="firewall-security-group-baseline">
                  <strong>{group.defaultAction === "allow-public-http-https" ? "Allow public web" : "Deny unmatched"}</strong>
                  <small>{group.isDefault ? "Built-in default" : "Deny rules take precedence"}</small>
                </div>
                <span className="firewall-security-group-version">Revision {group.version}</span>
                <button className="secondary-button" type="button" onClick={() => setEditor({ securityGroupId: group.securityGroupId, createNew: false })}>Manage group</button>
              </article>
            );
          })}
        </div>
      </section>

      {editor && <FirewallEditorDialog versions={versions} saving={saving} onSave={onSave} initialSecurityGroupId={editor.securityGroupId} createNew={editor.createNew} onClose={() => setEditor(null)} />}
    </div>
  );
}

function ActivityScreen({ displayName, operations, onOpenOperation }) {
  return (
    <div className="secondary-screen">
      <header className="page-heading compact">
        <p>Protected action history</p>
        <h1>Trail</h1>
        <span>Review protected actions and manage the device that signs your decisions.</span>
      </header>
      <div className="trail-device">
        <ApprovalDeviceCard displayName={displayName} />
        <div className="connection-privacy-note"><ShieldCheckmark24Regular aria-hidden="true" /><p>Approval keys stay encrypted on their enrolled devices. Protected actions are sent to active approval devices and require a local confirmation.</p></div>
      </div>
      <div className="timeline">
        {operations.map((operation) => (
          <button type="button" key={operation.id} onClick={() => onOpenOperation(operation)}>
            <span className={`timeline-icon${operation.state === "succeeded" ? "" : " pending"}`}>
              {operation.state === "succeeded" ? <CheckmarkCircle24Regular aria-hidden="true" /> : <Clock24Regular aria-hidden="true" />}
            </span>
            <span><strong>{operation.safeSummary}</strong><small>{operationStateLabels[operation.state]} · {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(operation.requestedAt))}</small></span>
            <ChevronRight16Regular aria-hidden="true" />
          </button>
        ))}
        <div>
          <span className="timeline-icon"><Laptop24Regular aria-hidden="true" /></span>
          <span><strong>Acme Workspace became ready</strong><small>All assigned services connected · Today, 8:58 AM</small></span>
        </div>
        <div>
          <span className="timeline-icon"><ShieldCheckmark24Regular aria-hidden="true" /></span>
          <span><strong>Workspace access verified</strong><small>Identity and policy checks passed · Today, 8:57 AM</small></span>
        </div>
      </div>
    </div>
  );
}

const pendingApplications = [
  { name: "Obsidian", type: "Knowledge workspace", detail: "Available when the approved application package is published." },
  { name: "Visual Studio Code", type: "Code editor", detail: "Available when the approved application package is published." },
];

const agentChoices = [
  { family: "Claude", choices: [{ catalogId: "claude-desktop", name: "Desktop", status: "available" }, { catalogId: "claude-cli", name: "CLI", status: "available" }] },
  { family: "OpenAI", choices: [{ name: "Desktop", status: "coming soon" }, { catalogId: "codex-cli", name: "Codex CLI", status: "available" }] },
  { family: "Hermes Agent", choices: [{ catalogId: "hermes-desktop", name: "Desktop", status: "available" }, { catalogId: "hermes-claw", name: "CLI", status: "available" }] },
];

const workspaceName = (workspace) => workspace?.grantId === "personal"
  ? "Acme Workspace"
  : workspace?.grantId?.replace(/^(sandbox|workspace)-/, "").split("-").filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ") || "Managed workspace";

const workspacePreferenceKey = "lemmacomputer.active-workspace-id";
const chatAgentPreferenceKey = (workspaceId) => `lemmacomputer.active-chat-agent:${workspaceId}`;
const chatServiceClassPreferenceKey = (workspaceId, agentId, sessionId) => (
  `lemmacomputer.chat-service-class:${workspaceId}:${agentId}:${sessionId}`
);

const readPreference = (key) => {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};

const writePreference = (key, value) => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // A blocked storage area must not prevent the workspace from being used.
  }
};

const readChatServiceClassPreference = (workspaceId, agentId, sessionId) => {
  if (!workspaceId || !agentId || !sessionId) return "auto";
  const value = readPreference(chatServiceClassPreferenceKey(workspaceId, agentId, sessionId));
  return chatServiceClassValues.has(value) ? value : "auto";
};

const workspaceConfigurationStatus = (state) => ({
  not_created: "Not started",
  provisioning: "Preparing",
  ready: "Ready",
  open: "Open",
  restarting: "Restarting",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Needs attention",
}[state] ?? "Unknown");

function WorkspaceConfigurationScreen({ settings, workspaces, loading, saving, error, selectedGrantId, onBack, onSave, onAssignSecurityGroup, canManageFirewall, telegram, credentials, channelLoading, channelBusy, channelError, onSaveTelegram, onDisconnectTelegram, onCreateCredential, showChannels = true, ownerName = "", backLabel = "All workspaces" }) {
  const [profileId, setProfileId] = useState("");
  const [applicationIds, setApplicationIds] = useState([]);
  const [modelAlias, setModelAlias] = useState("");
  const [requestedServiceClass, setRequestedServiceClass] = useState("auto");
  const [agentIds, setAgentIds] = useState([]);
  const [securityGroupVersionId, setSecurityGroupVersionId] = useState("");

  useEffect(() => {
    if (!settings) return;
    setProfileId(settings.profileId);
    setApplicationIds(settings.applicationIds);
    setModelAlias(settings.modelAlias);
    setRequestedServiceClass(settings.requestedServiceClass);
    setAgentIds(settings.agentIds);
    setSecurityGroupVersionId(settings.securityGroup?.id ?? settings.availableSecurityGroups?.find((group) => group.isDefault)?.id ?? "");
  }, [settings?.profileId, settings?.applicationIds, settings?.modelAlias, settings?.requestedServiceClass, settings?.agentIds, settings?.securityGroup?.id, settings?.availableSecurityGroups]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.grantId === selectedGrantId);
  const creatingWorkspace = !selectedWorkspace;
  const canChange = !["provisioning", "ready", "open", "restarting", "stopping"].includes(selectedWorkspace?.state);
  const dirty = settings && (
    settings.routePreferenceMigrationRequired
    ||
    profileId !== settings.profileId
    || applicationIds.join(",") !== settings.applicationIds.join(",")
    || modelAlias !== settings.modelAlias
    || requestedServiceClass !== settings.requestedServiceClass
    || agentIds.join(",") !== settings.agentIds.join(",")
    || (creatingWorkspace && securityGroupVersionId !== (settings.securityGroup?.id ?? ""))
  );
  const toggleApplication = (applicationId) => setApplicationIds((current) => (
    current.includes(applicationId) ? current.filter((id) => id !== applicationId) : [...current, applicationId]
  ));
  const toggleAgent = (agentId) => setAgentIds((current) => (
    current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]
  ));
  const selectedProfile = settings?.availableProfiles.find((profile) => profile.id === profileId) ?? settings?.profile;
  const disposableOpen = selectedProfile?.executionMode === "disposable-open";

  return (
    <div className="secondary-screen sandbox-screen sandbox-detail-screen">
      <button className="text-button sandbox-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />{backLabel}</button>
      <header className="sandbox-detail-heading">
        <div>
          <p>{ownerName ? `${ownerName} · Workspace configuration` : creatingWorkspace ? "Create workspace" : "Workspace configuration"}</p>
          <h1>{workspaceName(selectedWorkspace ?? { grantId: selectedGrantId })}</h1>
          <span>{ownerName ? "Manage this member’s policy-bounded workspace configuration. Profile, application, agent, and model changes apply after the workspace restarts." : creatingWorkspace ? "Choose the profile, applications, agents, and model before LemmaComputer starts this workspace." : "Changes are recorded as a policy-bounded configuration document and apply the next time this workspace starts."}</span>
        </div>
        <span className={`sandbox-state ${creatingWorkspace ? "not_created" : selectedWorkspace?.state}`}>{creatingWorkspace ? "Not created" : workspaceConfigurationStatus(selectedWorkspace?.state)}</span>
      </header>
      {error && <div className="workspace-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Workspace configuration unavailable</strong>{error}</span></div>}
      {loading || !settings ? <p className="sandbox-loading">Loading workspace configuration…</p> : (
        <form className="sandbox-management-form" onSubmit={(event) => { event.preventDefault(); onSave({ grantId: settings.grantId, profileId, applicationIds, modelAlias, requestedServiceClass, agentIds, securityGroupVersionId }); }}>
          <section className="sandbox-management-section" aria-labelledby="workspace-profile-heading">
            <div className="sandbox-management-heading"><span className="sandbox-section-icon"><ShieldCheckmark24Regular aria-hidden="true" /></span><span><h2 id="workspace-profile-heading">Workspace access</h2><p>Choose a restricted organization workspace or an open workspace for non-sensitive work. This does not choose your AI agent.</p></span></div>
            <fieldset className="workspace-profile-options"><legend className="sr-only">Workspace access mode</legend>{settings.availableProfiles.map((profile) => {
              const selected = profile.id === profileId;
              const open = profile.executionMode === "disposable-open";
              return <label className={`workspace-profile-option${selected ? " selected" : ""}${open ? " open-profile" : ""}`} key={profile.id}>
                <input type="radio" name="workspace-profile" value={profile.id} checked={selected} onChange={() => setProfileId(profile.id)} />
                <span className="profile-radio" aria-hidden="true" />
                <span className="workspace-profile-copy">
                  <span className="workspace-profile-title"><strong>{profile.displayName}</strong><em>{open ? "Non-sensitive work only" : "Organization managed"}</em></span>
                  <small>{profile.description}</small>
                  <span className="workspace-profile-capabilities">{open ? "Local shell, editable files, skills, packages, browser, public web, and cron" : "Policy-approved tools and destinations only"}</span>
                </span>
              </label>;
            })}</fieldset>
            <p className="workspace-profile-note"><Info24Regular aria-hidden="true" />Choose the AI agents you want to run in the separate section below. Claude Desktop is only enabled when you select it there.</p>
            {disposableOpen && <div className="disposable-profile-warning" role="note"><Info24Regular aria-hidden="true" /><span><strong>Use only non-sensitive data</strong><p>Downloaded code and tools are untrusted. Stop keeps this workspace and pauses schedules; restarting restores it and resumes future schedules. Delete permanently removes its files, schedules, logs, and installed tools.</p></span></div>}
          </section>

          <section className="sandbox-management-section" aria-labelledby="sandbox-applications-heading">
            <div className="sandbox-management-heading"><span className="sandbox-section-icon"><Laptop24Regular aria-hidden="true" /></span><span><h2 id="sandbox-applications-heading">Applications</h2><p>Choose approved applications that need a desktop interface. This workspace only exposes applications that are included and policy-approved.</p></span></div>
            <fieldset className="application-grid"><legend className="sr-only">Approved applications</legend>{settings.availableApplications.map((application) => (
              <label className={`application-option${applicationIds.includes(application.id) ? " selected" : ""}`} key={application.id}><input type="checkbox" checked={applicationIds.includes(application.id)} onChange={() => toggleApplication(application.id)} /><span className="agent-check" aria-hidden="true">{applicationIds.includes(application.id) && <Checkmark16Filled />}</span><span><strong>{application.displayName}</strong><small>{application.category} · {application.version}</small><em>{application.description}</em></span></label>
            ))}</fieldset>
            {!applicationIds.length && <p className="sandbox-selection-error" role="alert">Select at least one approved application.</p>}
            <div className="application-roadmap two-column" aria-label="Planned application catalog">{pendingApplications.map((application) => <div key={application.name}><span><strong>{application.name}</strong><small>{application.type}</small></span><span className="coming-soon">Coming soon</span><p>{application.detail}</p></div>)}</div>
          </section>

          <section className="sandbox-management-section" aria-labelledby="sandbox-agents-heading">
            <div className="sandbox-management-heading"><span className="sandbox-section-icon"><Bot24Regular aria-hidden="true" /></span><span><h2 id="sandbox-agents-heading">AI agents</h2><p>Each enabled agent receives a separate governed identity, model grant, and tool scope. Unavailable clients cannot be selected.</p></span></div>
            <div className="agent-family-grid">{agentChoices.map((family) => <section className="agent-family" key={family.family}><h3>{family.family}</h3>{family.choices.map((choice) => {
              const agent = choice.catalogId ? settings.availableAgents.find((item) => item.id === choice.catalogId) : null;
              const selected = agent && agentIds.includes(agent.id);
              return agent ? <label className={`agent-choice${selected ? " selected" : ""}`} key={choice.name}><input type="checkbox" checked={selected} onChange={() => toggleAgent(agent.id)} /><span className="agent-check" aria-hidden="true">{selected && <Checkmark16Filled />}</span><span><strong>{choice.name}</strong><small>{agent.displayName} · v{agent.clientVersion}</small><em>{agent.description}</em></span></label> : <div className="agent-choice unavailable" key={choice.name}><span><strong>{choice.name}</strong><small>Coming soon</small><em>This client is not in the approved workspace image yet.</em></span></div>;
            })}</section>)}</div>
            {!agentIds.length && <p className="sandbox-selection-error" role="alert">Select at least one approved AI agent.</p>}
          </section>

          {showChannels && <TelegramChannelSection
            connection={telegram}
            credentials={credentials}
            agents={settings.availableAgents.filter((agent) => agentIds.includes(agent.id))}
            workspaceExists={!creatingWorkspace}
            loading={channelLoading}
            busy={channelBusy}
            error={channelError}
            onSave={onSaveTelegram}
            onDisconnect={onDisconnectTelegram}
            onCreateCredential={onCreateCredential}
          />}

          <section className="sandbox-management-section" aria-labelledby="sandbox-model-heading">
            <div className="sandbox-management-heading"><span className="sandbox-section-icon"><Bot24Regular aria-hidden="true" /></span><span><h2 id="sandbox-model-heading">Default model mode</h2><p>Choose the default quality and cost mode for this workspace. You can choose a different mode for each conversation in Chat.</p></span></div>
            <div className="model-options sandbox-model-options" role="radiogroup" aria-labelledby="sandbox-model-heading">{settings.availableServiceClasses.map((serviceClass) => <label className={requestedServiceClass === serviceClass.value ? "selected" : ""} key={serviceClass.value}><input type="radio" name="model-route" value={serviceClass.value} checked={requestedServiceClass === serviceClass.value} onChange={() => setRequestedServiceClass(serviceClass.value)} /><span><strong>{serviceClass.displayName}</strong><small>{serviceClass.description}</small></span>{requestedServiceClass === serviceClass.value && <CheckmarkCircle24Regular aria-hidden="true" />}</label>)}</div>
          </section>

          <section className="sandbox-management-section" aria-labelledby="sandbox-security-heading">
            <div className="sandbox-management-heading"><span className="sandbox-section-icon"><ShieldCheckmark24Regular aria-hidden="true" /></span><span><h2 id="sandbox-security-heading">Security</h2><p>Choose the security group for this workspace. Group and rule changes apply live without restarting.</p></span></div>
            <div className="sandbox-security-card">
              <div>
                <strong>Security group</strong>
                <span>{settings.securityGroup?.name ?? "Default security group"}</span>
                <small>{settings.securityGroup ? `Revision ${settings.securityGroup.version} · ` : ""}{settings.securityGroup?.defaultAction === "allow-public-http-https" ? "Public HTTP and HTTPS are allowed by default; matching Deny rules block exceptions." : "Unmatched destinations are denied; matching Allow rules grant exceptions."}</small>
              </div>
              {canManageFirewall && settings.availableSecurityGroups?.length ? <label className="workspace-security-group-select">
                <span className="sr-only">Security group</span>
                <SelectMenu
                  value={securityGroupVersionId}
                  disabled={saving}
                  onValueChange={(value) => {
                    setSecurityGroupVersionId(value);
                    if (!creatingWorkspace) onAssignSecurityGroup(settings.grantId, value);
                  }}
                  ariaLabel="Security group"
                  options={settings.availableSecurityGroups
                    .filter((group, index, all) => all.findIndex((candidate) => candidate.securityGroupId === group.securityGroupId) === index)
                    .map((group) => ({ value: group.id, label: `${group.name}${group.isDefault ? " · Default" : ""}` }))}
                />
              </label> : null}
            </div>
          </section>

          <div className="sandbox-management-footer">
            <div><strong>{creatingWorkspace ? "Ready to create" : "Workspace manifest"}</strong><small>Schema v2 · {selectedProfile?.displayName} · persistent home · gateway-only network</small></div>
            <button className="primary-button" type="submit" disabled={(!creatingWorkspace && !dirty) || saving || !canChange || !applicationIds.length || !agentIds.length}>{saving ? creatingWorkspace ? "Creating workspace" : "Saving configuration" : creatingWorkspace ? "Create workspace" : "Save configuration"}</button>
          </div>
          {!canChange && <p className="sandbox-stop-note"><Info24Regular aria-hidden="true" />Stop this workspace before changing its profile, applications, agents, or AI model. Security-group changes apply live.</p>}
          <details className="sandbox-json"><summary>View workspace manifest JSON</summary><pre>{JSON.stringify(settings.manifest, null, 2)}</pre></details>
        </form>
      )}
    </div>
  );
}

const connectionReason = {
  MCP_OAUTH_DENIED: "Access was not granted. You can try again when you’re ready.",
  MCP_OAUTH_STATE_INVALID: "That connection attempt expired or was already used. Please start again.",
  MCP_OAUTH_STATE_EXPIRED: "That connection attempt expired. Please start again.",
  MCP_OAUTH_IDENTITY_MISMATCH: "That connection attempt belongs to another signed-in user.",
  MCP_OAUTH_CONNECTOR_MISMATCH: "That connection returned to a different connector. Please start again.",
  MCP_CONNECTOR_SETUP_REQUIRED: "This service needs organization setup before it can be connected.",
  MCP_CONNECTOR_REQUEST_REQUIRED: "This service needs provider approval or organization access before it can be connected.",
  MCP_TOKEN_EXCHANGE_FAILED: "The provider could not complete the connection. Please try again.",
  M365_OAUTH_DENIED: "Microsoft 365 access was not granted. You can try again when you’re ready.",
  M365_OAUTH_STATE_INVALID: "That connection attempt expired or was already used. Please start again.",
  M365_OAUTH_STATE_EXPIRED: "That connection attempt expired. Please start again.",
  M365_OAUTH_IDENTITY_MISMATCH: "That connection attempt belongs to another signed-in user.",
  M365_TOKEN_EXCHANGE_FAILED: "Microsoft 365 could not complete the connection. Please try again.",
};

const defaultConnectorActivation = {
  readiness: "request_access",
  action: "view_requirements",
  message: "This service needs provider approval or organization access before people can connect.",
};
const activationFor = (connector) => connector?.activation ?? defaultConnectorActivation;
const activationActionLabel = (activation) => (
  activation.action === "view_setup" ? "View setup" : activation.action === "view_requirements" ? "View requirements" : "Connect"
);

const getApprovalDeviceContext = async () => {
  const local = await getBrowserApproverIdentity();
  const [accountStatus, localStatus] = await Promise.all([
    approvalApi.status(),
    local ? approvalApi.status(local.did) : Promise.resolve(null),
  ]);
  const localReady = Boolean(local && localStatus?.connected && await hasBrowserApprover(local.did));
  return { accountStatus, local, localStatus, localReady };
};

function ApprovalDeviceCard({ displayName }) {
  const [status, setStatus] = useState(null);
  const [localApprover, setLocalApprover] = useState(null);
  const [localReady, setLocalReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refresh = async () => {
    const context = await getApprovalDeviceContext();
    setStatus(context.accountStatus);
    setLocalApprover(context.local);
    setLocalReady(context.localReady);
  };

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, []);

  const enroll = async () => {
    setBusy("enroll");
    setMessage("");
    try {
      const challenge = await approvalApi.challenge();
      await enrollBrowserApprover(
        challenge,
        `${displayName}’s browser`,
        (document) => approvalApi.enroll(challenge.id, document),
        (approverDid) => approvalApi.revoke(approverDid),
      );
      await refresh();
      setMessage("This browser is now your approval device.");
    } catch (error) {
      setMessage(error.name === "NotAllowedError" ? "Device verification was cancelled." : error.message);
    } finally {
      setBusy("");
    }
  };

  const disconnect = async () => {
    setConfirmRemove(false);
    setBusy("disconnect");
    setMessage("");
    try {
      await approvalApi.revoke(localApprover?.did);
      await clearBrowserApprover(localApprover?.did);
      await refresh();
      setMessage("The browser approval device was removed.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const connected = status?.connected;
  const readyElsewhere = connected && !localReady;
  return (
    <>
      <section className="connection-card approval-device-card" aria-labelledby="approval-device-title">
        <div className="connection-logo"><ShieldCheckmark24Regular aria-hidden="true" /></div>
        <div className="connection-copy">
          <div className="connection-title-row">
            <div>
              <h2 id="approval-device-title">Approval device</h2>
              <p>OpenVTC browser agent</p>
            </div>
            <span className={`connection-status ${connected || localReady ? "connected" : "disconnected"}`}>
              {localReady ? "Ready here" : readyElsewhere ? "Ready on another device" : "Not enrolled"}
            </span>
          </div>
          <p className="connection-description">{
            localReady
              ? "This browser can sign protected actions after one deliberate biometric, PIN, or security-key confirmation."
              : readyElsewhere
                ? `${status.approver.displayName} is enrolled. Protected actions will be sent there; its approval key never leaves that device.`
                : "Set up an approval device to receive protected actions and confirm them with its biometric, PIN, or security key."
          }</p>
          {connected && <p className="connection-metadata">{status.approver.displayName} · {status.approver.approverDid.slice(0, 26)}…</p>}
          {message && <p className="approval-device-message" role="status" aria-live="polite">{message}</p>}
        </div>
        <div className="connection-actions">
          {localReady ? (
            <button className="secondary-button" type="button" onClick={() => setConfirmRemove(true)} disabled={Boolean(busy)}>{busy === "disconnect" ? "Removing" : "Remove device"}</button>
          ) : (
            <button className="primary-button" type="button" onClick={enroll} disabled={Boolean(busy)}>
              <ShieldCheckmark24Regular aria-hidden="true" />
              {busy === "enroll" ? "Waiting for device" : readyElsewhere ? "Set up this browser too" : "Set up this browser"}
            </button>
          )}
        </div>
      </section>
      {confirmRemove && (
        <ConfirmDialog
          title="Remove this approval device?"
          description="Pending protected actions will remain blocked until an approval device is set up again."
          confirmLabel="Remove device"
          danger
          onConfirm={disconnect}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  );
}

const connectorIconBrands = new Set([
  "asana", "atlassian", "box", "cloudflare", "exa", "figma", "github", "hubspot", "intercom",
  "linear", "microsoft", "neon", "notion", "slack", "stripe", "supabase", "vercel",
]);
const connectorIconExtensions = { exa: "png" };
const connectorCategories = ["Productivity", "Search", "Developer tools", "Business", "Communication", "Data and analytics", "Other"];

function ConnectorMark({ connector, large = false }) {
  const brand = connector?.brand ?? "microsoft";
  if (connector?.iconDataUrl) {
    return <span className={`connector-mark uploaded${large ? " large" : ""}`} aria-hidden="true"><img src={connector.iconDataUrl} alt="" /></span>;
  }
  const iconBrand = connectorIconBrands.has(brand) ? brand : connectorIconBrands.has(connector?.id) ? connector.id : null;
  if (iconBrand) {
    const extension = connectorIconExtensions[iconBrand] ?? "svg";
    return <span className={`connector-mark branded ${iconBrand}${large ? " large" : ""}`} aria-hidden="true"><img src={`/connector-icons/${iconBrand}.${extension}`} alt="" /></span>;
  }
  const fallback = connector?.name?.trim().match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
  const glyph = { notion: "N", linear: "L", atlassian: "A", github: "GH" }[brand] ?? fallback;
  return <span className={`connector-mark ${brand}${large ? " large" : ""}`} aria-hidden="true">{glyph}</span>;
}

function Microsoft365AccountMetadata({ account }) {
  const accountId = account?.userPrincipalName || account?.email;
  if (!accountId) return <p className="connection-metadata">Connected account details unavailable</p>;
  return (
    <p className="connection-metadata">
      Connected as <strong>{account?.displayName || accountId}</strong>
      {account?.displayName && accountId !== account.displayName ? ` · ${accountId}` : ""}
    </p>
  );
}

const connectorPolicyDecisionLabel = {
  allow: "Allowed",
  approval_required: "Approval required",
  deny: "Blocked",
};
const connectorPolicySourceLabel = {
  protected_baseline: "LemmaComputer baseline",
  organization_policy: "Organization policy",
  connector_policy: "Connector policy",
};
const connectorReviewStateLabel = {
  product_owned: "Product definition",
  current: "Definition current",
  awaiting_review: "Review required",
  not_checked: "Definition not checked",
  removed: "No longer provided",
};

function ConnectorEffectivePolicyCard({ policy, loading, error, deliveryBusy, onRetryDelivery }) {
  if (loading && !policy) return <section className="connector-effective-policy-card loading" aria-live="polite">Loading effective connector policy…</section>;
  if (error && !policy) return <section className="connector-effective-policy-card error" role="alert"><strong>Effective policy unavailable</strong><span>{error}</span></section>;
  if (!policy) return null;
  const application = policy.policyApplication;
  const applicationMessage = application.state === "mixed"
    ? `${application.remediationRequiredMembers} of ${application.activeMembers} active members need the current policy version.`
    : application.state === "conflict"
      ? "Conflicting documents share the newest member-policy version. Tools remain blocked until the assignments are reconciled."
      : application.state === "unassigned"
        ? `${application.unassignedMembers} active members do not have a workspace policy assignment.`
        : application.state === "current"
          ? `All ${application.currentMembers} assigned active members use version ${application.currentVersion?.version}.`
          : application.state === "empty"
            ? "There are no active members to evaluate."
            : "This connector uses one organization connector policy rather than member policy versions.";
  const reviewRequired = policy.tools.filter((tool) => ["awaiting_review", "not_checked"].includes(tool.reviewState)).length;
  const deliveryWorkspaces = policy.delivery?.members.flatMap((member) => member.workspaces.map((workspace) => ({ ...workspace, member }))) ?? [];
  const failedDeliveries = deliveryWorkspaces.filter((workspace) => workspace.delivery === "failed").length;
  const refreshedDeliveries = deliveryWorkspaces.filter((workspace) => workspace.delivery === "refreshed").length;
  const nextStartDeliveries = deliveryWorkspaces.filter((workspace) => workspace.delivery === "applies_on_next_start").length;
  return (
    <section className="connector-effective-policy-card" aria-labelledby={`connector-effective-policy-${policy.connector.id}`}>
      <div className="connector-effective-policy-heading">
        <div><p>Effective organization policy</p><h2 id={`connector-effective-policy-${policy.connector.id}`}>What workspace agents can use</h2></div>
        <span className={`connector-effective-access ${policy.access.effectiveDecision}`}>{connectorPolicyDecisionLabel[policy.access.effectiveDecision]}</span>
      </div>
      <dl className="connector-effective-summary">
        <div><dt>Connector access</dt><dd>{connectorPolicyDecisionLabel[policy.access.effectiveDecision]}<small>{connectorPolicySourceLabel[policy.access.controllingSource.kind]} · v{policy.access.controllingSource.version}</small></dd></div>
        <div><dt>Member connections</dt><dd>{policy.access.membersCanManage ? "Members can manage connections" : "Members cannot manage connections"}<small>{policy.access.membersCanManage ? "Members may connect or disconnect their own account." : "Members cannot connect or disconnect their own account."}</small></dd></div>
        <div><dt>Policy application</dt><dd>{application.state === "current" || application.state === "not_applicable" ? "Current" : "Action needed"}<small>{applicationMessage}</small></dd></div>
      </dl>
      <div className="connector-effective-tools" role="table" aria-label="Effective connector tool policy">
        <div className="connector-effective-tool-heading" role="row">
          <span role="columnheader">Tool</span><span role="columnheader">Effective decision</span><span role="columnheader">Definition review</span><span role="columnheader">Controlling sources</span>
        </div>
        {policy.tools.map((tool) => <div className="connector-effective-tool-row" role="row" key={tool.name}>
          <span role="cell" data-label="Tool"><strong>{tool.displayName}</strong><code>{tool.name}</code></span>
          <span role="cell" data-label="Effective decision"><strong className={`connector-tool-decision ${tool.effectiveDecision}`}>{connectorPolicyDecisionLabel[tool.effectiveDecision]}</strong></span>
          <span role="cell" data-label="Definition review"><strong>{connectorReviewStateLabel[tool.reviewState]}</strong>{tool.observedDefinitionHash && <small>Current hash {tool.observedDefinitionHash.slice(0, 10)}…</small>}</span>
          <span role="cell" data-label="Controlling sources"><small>{tool.sources.map((source) => `${connectorPolicySourceLabel[source.kind]} v${source.version}: ${connectorPolicyDecisionLabel[source.decision]}`).join(" · ")}</small></span>
        </div>)}
      </div>
      <section className="connector-policy-delivery" aria-labelledby={`connector-policy-delivery-${policy.connector.id}`}>
        <div className="connector-policy-delivery-heading">
          <div><h3 id={`connector-policy-delivery-${policy.connector.id}`}>Workspace delivery</h3><p>{policy.delivery ? `Policy v${policy.delivery.policyVersion} · last attempted ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(policy.delivery.changedAt))}` : "No connector policy delivery has been recorded yet."}</p></div>
          {failedDeliveries > 0 && <button className="secondary-button compact-button" type="button" disabled={deliveryBusy} onClick={() => onRetryDelivery(policy.connector.id)}>{deliveryBusy ? "Retrying delivery" : "Retry failed delivery"}</button>}
        </div>
        {policy.delivery && <>
          <p className="connector-policy-delivery-summary"><strong>{refreshedDeliveries} refreshed</strong><span>{nextStartDeliveries} apply on next start</span>{failedDeliveries > 0 && <span className="failed">{failedDeliveries} need retry</span>}</p>
          <div className="connector-policy-delivery-members">
            {policy.delivery.members.map((member) => <div key={member.userId}>
              <span><strong>{member.displayName}</strong>{member.email && <small>{member.email}</small>}</span>
              <ul>{member.workspaces.map((workspace) => <li key={workspace.workspaceId}><code>{workspace.grantId}</code><span className={`connector-delivery-state ${workspace.delivery}`}>{workspace.delivery === "refreshed" ? "Refreshed" : workspace.delivery === "applies_on_next_start" ? "Applies on next start" : "Retry needed"}</span></li>)}</ul>
            </div>)}
          </div>
        </>}
      </section>
      <div className={`connector-effective-remediation${policy.remediation.required ? " action" : ""}`} role="status">
        <Info24Regular aria-hidden="true" />
        <div>
          <strong>{policy.remediation.required ? "Remediation required" : "No policy remediation required"}</strong>
          <span>{reviewRequired ? `${reviewRequired} tool ${reviewRequired === 1 ? "definition is" : "definitions are"} blocked pending review. ` : ""}{applicationMessage}</span>
          <small>Saving a policy records each workspace delivery attempt. Failed live refreshes remain unavailable until delivery succeeds. Stopped workspaces receive the policy when they next start; a connector policy change does not require a restart.</small>
        </div>
      </div>
    </section>
  );
}

function ConnectorAccessPolicyCard({ connector, busy, onSave }) {
  const [enabled, setEnabled] = useState(connector.enabled !== false);
  const [membersCanManage, setMembersCanManage] = useState(connector.membersCanManage !== false);
  useEffect(() => {
    setEnabled(connector.enabled !== false);
    setMembersCanManage(connector.membersCanManage !== false);
  }, [connector.id, connector.enabled, connector.membersCanManage]);
  const dirty = enabled !== (connector.enabled !== false) || membersCanManage !== (connector.membersCanManage !== false);
  return (
    <section className="connector-access-policy-card" aria-labelledby={`connector-access-${connector.id}`}>
      <div>
        <p>Organization access</p>
        <h2 id={`connector-access-${connector.id}`}>Member connection policy</h2>
        <span>These controls apply to every organization member and are enforced by Control.</span>
      </div>
      <label><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>Connector enabled</strong><small>Assigned workspaces may use approved tools from this service.</small></span></label>
      <label><input type="checkbox" checked={membersCanManage} disabled={busy || !enabled} onChange={(event) => setMembersCanManage(event.target.checked)} /><span><strong>Members can manage connections</strong><small>Members may connect and disconnect their own work account.</small></span></label>
      <button className="primary-button compact-button" type="button" disabled={busy || !dirty} onClick={() => onSave(connector.id, { enabled, membersCanManage, expectedVersion: connector.accessPolicyVersion })}>{busy ? "Saving policy" : "Save access policy"}</button>
    </section>
  );
}

function Microsoft365Detail({ connection, loading, busy, error, onConnect, onDisconnect, onAccessPolicySave, displayName, canManageConnector, canManagePolicy, activeTab, onTabChange, onBack, mcpPolicy, policyLoading, policySaving, onPolicyChange, onPolicySave, effectivePolicy, effectivePolicyLoading, effectivePolicyError, deliveryBusy, onRetryDelivery }) {
  const connected = connection?.state === "connected";
  const expired = connection?.state === "expired";
  const organizationDisabled = connection?.enabled === false;
  const connectionLocked = connection?.canManageConnection === false;
  const connectedAt = connection?.connectedAt
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(connection.connectedAt))
    : null;
  return (
    <div className="secondary-screen connections-screen connector-detail-screen">
      <button className="connector-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />Back to Connections</button>
      <header className="connector-detail-header">
        <div className="connection-logo"><PlugConnected24Regular aria-hidden="true" /></div>
        <div>
          <p>Connected service</p>
          <h1>Microsoft 365</h1>
          <span>Outlook Mail, Calendar, OneDrive, and Teams</span>
        </div>
        <span className={`connection-status ${connected ? "connected" : expired ? "expired" : "disconnected"}`}>
          {loading ? "Checking" : organizationDisabled ? "Disabled" : connected ? "Connected" : expired ? "Reconnect required" : "Not connected"}
        </span>
      </header>

      <nav className="connector-tabs" aria-label="Microsoft 365 settings">
        <button className={activeTab === "overview" ? "active" : ""} type="button" onClick={() => onTabChange("overview")}>Overview</button>
        {canManagePolicy && <button className={activeTab === "tools" ? "active" : ""} type="button" onClick={() => onTabChange("tools")}>Tools &amp; approvals</button>}
      </nav>
      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>The connector was not updated</strong>{error}</span></div>}

      {activeTab === "tools" && canManagePolicy ? (
        <ToolPolicyEditor mcpPolicy={mcpPolicy} loading={policyLoading} policySaving={policySaving} onPolicyChange={onPolicyChange} onPolicySave={onPolicySave} />
      ) : (
        <div className="connector-overview">
          <section className="connector-overview-card">
            <div>
              <p>Connection status</p>
              <h2>{organizationDisabled ? "Disabled by your organization" : connectionLocked ? "Managed by your administrator" : connected ? "Ready for assigned workspaces" : expired ? "Microsoft access needs attention" : "Connect your work account"}</h2>
              <span>{organizationDisabled ? "Microsoft 365 tools and new connections are unavailable until an administrator enables this connector." : connectionLocked ? "Your existing connection status is visible, but only an administrator can change it." : connected ? "Your workspace agent can use the tools your organization has allowed." : "Connect once to make approved Microsoft 365 tools available to your workspace."}</span>
              <div className="connection-services" aria-label="Included services"><span>Outlook Mail</span><span>Calendar</span><span>OneDrive</span><span>Teams</span></div>
              {connected && <Microsoft365AccountMetadata account={connection?.account} />}
              {connectedAt && <p className="connection-metadata">Connected {connectedAt}</p>}
            </div>
            <div className="connection-actions">
              {connected ? (
                <button className="secondary-button" type="button" onClick={onDisconnect} disabled={busy || loading || organizationDisabled || connectionLocked}>{busy ? "Disconnecting" : "Disconnect"}</button>
              ) : (
                <button className="primary-button" type="button" onClick={onConnect} disabled={busy || loading || organizationDisabled || connectionLocked}><PlugConnected24Regular aria-hidden="true" />{busy ? "Opening Microsoft" : expired ? "Reconnect" : "Connect Microsoft 365"}</button>
              )}
            </div>
          </section>
          {canManageConnector && <ConnectorEffectivePolicyCard policy={effectivePolicy} loading={effectivePolicyLoading} error={effectivePolicyError} deliveryBusy={deliveryBusy} onRetryDelivery={onRetryDelivery} />}
          {canManageConnector && <ConnectorAccessPolicyCard connector={connection} busy={busy} onSave={onAccessPolicySave} />}
        </div>
      )}
    </div>
  );
}

function ConnectorIconEditor({ connector, busy, onSave }) {
  const [error, setError] = useState("");
  const chooseIcon = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      await onSave(connector.id, await readConnectorIcon(file));
    } catch (requestError) {
      setError(requestError.message);
    }
  };
  const removeIcon = async () => {
    setError("");
    try {
      await onSave(connector.id, null);
    } catch (requestError) {
      setError(requestError.message);
    }
  };
  return (
    <section className="connector-appearance-card" aria-labelledby="connector-icon-heading">
      <ConnectorMark connector={connector} />
      <div>
        <h2 id="connector-icon-heading">Connector icon</h2>
        <p>Use a square PNG, JPEG, or WebP image up to 256 KB.</p>
        {error && <span role="alert">{error}</span>}
      </div>
      <div className="connector-icon-actions">
        <label className="secondary-button">
          {busy ? "Saving" : connector.iconDataUrl ? "Replace icon" : "Upload icon"}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseIcon} disabled={busy} />
        </label>
        {connector.iconDataUrl && <button className="connection-quiet-button" type="button" onClick={removeIcon} disabled={busy}>Remove</button>}
      </div>
    </section>
  );
}

function ConnectorRemovalCard({ connector, busy, onRemove }) {
  return (
    <section className="connector-removal-card" aria-labelledby="connector-removal-heading">
      <div>
        <h2 id="connector-removal-heading">Remove connector</h2>
        <p>Remove this customer-added service from the organization. Everyone’s connection and workspace access will be removed; provider accounts and data stay with the provider.</p>
      </div>
      <button className="secondary-button danger-button" type="button" onClick={() => onRemove(connector)} disabled={busy}>{busy ? "Removing connector" : "Remove connector"}</button>
    </section>
  );
}

function HostedConnectorDetail({ connector, loading, busy, error, onConnect, onDisconnect, onIconChange, onAccessPolicySave, onRemove, onBack, canManageConnector, activeTab, onTabChange, mcpPolicy, policyLoading, policySaving, onPolicyChange, onPolicySave, effectivePolicy, effectivePolicyLoading, effectivePolicyError, deliveryBusy, onRetryDelivery }) {
  const connected = connector?.state === "connected";
  const expired = connector?.state === "expired";
  const activation = activationFor(connector);
  const canConnect = activation.action === "connect";
  const setupRequired = activation.readiness === "setup_required";
  const accessRequired = activation.readiness === "request_access";
  const organizationDisabled = connector?.enabled === false;
  const connectionLocked = connector?.canManageConnection === false;
  const connectedAt = connector?.connectedAt
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(connector.connectedAt))
    : null;
  const statusLabel = loading
    ? "Checking"
    : organizationDisabled
      ? "Disabled"
      : connected
      ? "Connected"
      : expired
        ? "Reconnect required"
        : setupRequired
          ? "Setup required"
          : accessRequired
            ? "Access required"
            : "Not connected";
  return (
    <div className="secondary-screen connections-screen connector-detail-screen">
      <button className="connector-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />Back to Connections</button>
      <header className="connector-detail-header">
        <ConnectorMark connector={connector} large />
        <div>
          <p>{connector.source === "custom" ? "Organization connector" : "Connected service"}</p>
          <h1>{connector.name}</h1>
          <span>{connector.shortDescription}</span>
        </div>
        <span className={`connection-status ${connected ? "connected" : expired ? "expired" : "disconnected"}`}>{statusLabel}</span>
      </header>

      <nav className="connector-tabs" aria-label={`${connector.name} settings`}>
        <button className={activeTab === "overview" ? "active" : ""} type="button" onClick={() => onTabChange("overview")}>Overview</button>
        {canManageConnector && connected && <button className={activeTab === "tools" ? "active" : ""} type="button" onClick={() => onTabChange("tools")}>Tools &amp; approvals</button>}
      </nav>
      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>The connector was not updated</strong>{error}</span></div>}

      {activeTab === "tools" && canManageConnector && connected ? (
        <ToolPolicyEditor mcpPolicy={mcpPolicy} loading={policyLoading} policySaving={policySaving} onPolicyChange={onPolicyChange} onPolicySave={onPolicySave} />
      ) : <div className="connector-overview">
        <section className="connector-overview-card">
          <div>
            <p>Connection status</p>
            <h2>{organizationDisabled
              ? "Disabled by your organization"
              : connectionLocked ? "Managed by your administrator" : connected ? "Connection ready" : expired ? "Provider access needs attention"
                : setupRequired ? "Organization setup required"
                  : accessRequired ? "Provider approval or access required"
                    : `Connect ${connector.name}`}</h2>
            <span>{organizationDisabled
              ? "This connector and its workspace tools are unavailable until an administrator enables it."
              : connectionLocked
                ? "Your existing connection status is visible, but only an administrator can change it."
                : connected
              ? "Your account is connected and ready for any tools your organization approves."
              : expired
                ? "Provider access needs attention. Reconnect to restore it."
                : canConnect
                  ? connector.description
                  : activation.message}</span>
            {connector.services.length > 0 && <div className="connection-services" aria-label="Included services">{connector.services.map((service) => <span key={service}>{service}</span>)}</div>}
            {connectedAt && <p className="connection-metadata">Connected {connectedAt}</p>}
          </div>
          <div className="connection-actions">
            {connected ? (
              <button className="secondary-button" type="button" onClick={() => onDisconnect(connector)} disabled={busy || loading || organizationDisabled || connectionLocked}>{busy ? "Disconnecting" : "Disconnect"}</button>
            ) : canConnect ? (
              <button className="primary-button" type="button" onClick={() => onConnect(connector.id)} disabled={busy || loading || organizationDisabled || connectionLocked}>
                <PlugConnected24Regular aria-hidden="true" />
                {busy ? `Opening ${connector.name}` : expired ? "Reconnect" : `Connect ${connector.name}`}
              </button>
            ) : (
              <div className="connection-privacy-note" role="status"><Info24Regular aria-hidden="true" /><p><strong>{activationActionLabel(activation)}</strong>{activation.message}</p></div>
            )}
          </div>
        </section>
        {canManageConnector && <ConnectorEffectivePolicyCard policy={effectivePolicy} loading={effectivePolicyLoading} error={effectivePolicyError} deliveryBusy={deliveryBusy} onRetryDelivery={onRetryDelivery} />}
        {canManageConnector && <ConnectorAccessPolicyCard connector={connector} busy={busy} onSave={onAccessPolicySave} />}
        <div className="connector-policy-note">
          <Info24Regular aria-hidden="true" />
          <p><strong>{connector.policySupport === "governed" ? "Approved tools available" : "Available to your workspace agents"}</strong>{connector.policySupport === "governed"
            ? "Your organization decides which tools each workspace can use."
            : "Once connected, this service and its available tools are added to your workspace agents automatically."}</p>
        </div>
        {canManageConnector && connector.source === "custom" && <ConnectorIconEditor connector={connector} busy={busy} onSave={onIconChange} />}
        {canManageConnector && connector.source === "custom" && <ConnectorRemovalCard connector={connector} busy={busy} onRemove={onRemove} />}
      </div>}
    </div>
  );
}

const messagingAgentIds = new Set(["hermes-claw", "claude-cli", "codex-cli"]);

function TelegramChannelSection({ connection, credentials, agents, workspaceExists, loading, busy, error, onSave, onDisconnect, onCreateCredential }) {
  const configured = connection?.state === "connected";
  const [credentialId, setCredentialId] = useState("");
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [allowedUserIds, setAllowedUserIds] = useState("");
  const [allowAgentSwitch, setAllowAgentSwitch] = useState(true);
  const [newBotToken, setNewBotToken] = useState("");
  const agentOptions = agents.filter((agent) => messagingAgentIds.has(agent.id))
    .map((agent) => ({ value: agent.id, label: agent.displayName }));
  const availableCredentials = credentials.filter((credential) => !credential.workspaceId || credential.id === connection?.credentialId);

  useEffect(() => {
    setCredentialId(connection?.credentialId ?? availableCredentials[0]?.id ?? "");
    setDefaultAgentId(connection?.defaultAgentId ?? "");
    setAllowedUserIds((connection?.allowedUserIds ?? []).join(", "));
    setAllowAgentSwitch(connection?.state === "connected" ? connection.allowAgentSwitch : true);
  }, [connection?.updatedAt, connection?.state, availableCredentials.map((item) => item.id).join(",")]);

  useEffect(() => {
    if (!agentOptions.some((agent) => agent.value === defaultAgentId)) {
      setDefaultAgentId(agentOptions[0]?.value ?? "");
    }
  }, [agentOptions.map((agent) => agent.value).join(","), defaultAgentId]);

  const parsedUserIds = [...new Set(allowedUserIds.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
  const save = () => {
    if (!credentialId || !defaultAgentId || !parsedUserIds.length) return;
    onSave({
      credentialId,
      allowedUserIds: parsedUserIds,
      defaultAgentId,
      allowAgentSwitch,
    });
  };
  const createCredential = async () => {
    if (!newBotToken.trim()) return;
    const created = await onCreateCredential(newBotToken.trim());
    if (created) {
      setCredentialId(created.id);
      setNewBotToken("");
    }
  };

  return (
    <details className="sandbox-management-section workspace-channels-section telegram-channel-section">
      <summary className="workspace-channels-summary">
        <span className="sandbox-section-icon"><PlugConnected24Regular aria-hidden="true" /></span>
        <span className="workspace-channels-summary-copy">
          <span><h2 id="workspace-channels-heading">Channels</h2><em>Optional</em></span>
          <p>Add a messaging channel only if you want to reach this workspace outside LemmaComputer.</p>
        </span>
        <span className={`workspace-channels-status${configured ? " connected" : ""}`}>{loading ? "Checking" : configured ? "Telegram connected" : "None connected"}</span>
        <ChevronDown16Regular className="workspace-channels-chevron" aria-hidden="true" />
      </summary>
      <div className="workspace-channels-content" aria-labelledby="workspace-channels-heading">
        {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Telegram was not updated</strong>{error}</span></div>}
        <article className="workspace-channel-card">
          <header className="workspace-channel-card-heading">
            <span className="workspace-channel-mark telegram" aria-hidden="true">T</span>
            <span><strong>Telegram</strong><small>{configured ? "Connected to this workspace" : "Bot channel"}</small></span>
            <em>{configured ? "Connected" : "Optional"}</em>
          </header>
          <div className="telegram-connection-form">
            <div>
              <p>Telegram</p>
              <h3>{loading ? "Checking connection" : configured ? `Connected${connection.botUsername ? ` as @${connection.botUsername}` : ""}` : "Not connected"}</h3>
              <span>{configured ? `${connection.allowedUserCount} approved ${connection.allowedUserCount === 1 ? "sender" : "senders"} · token version ${connection.tokenVersion}` : "One dedicated bot credential can be attached to this workspace."}</span>
            </div>
            {!workspaceExists ? (
              <div className="telegram-empty-workspace" role="status"><Info24Regular aria-hidden="true" /><span><strong>Available after creation</strong>Create this workspace without a channel, then return here if you want to connect Telegram.</span></div>
            ) : !agentOptions.length ? (
              <div className="telegram-empty-workspace" role="status"><Info24Regular aria-hidden="true" /><span><strong>No eligible agent</strong>Save Hermes Agent, Claude CLI, or Codex CLI in this workspace configuration first.</span></div>
            ) : <>
              {availableCredentials.length ? <label>
                <span>Credential</span>
                <SelectMenu value={credentialId} onValueChange={setCredentialId} ariaLabel="Telegram credential" options={availableCredentials.map((credential) => ({ value: credential.id, label: `${credential.displayName} · v${credential.version}` }))} disabled={busy || loading} />
                <small>Only unattached Telegram credentials are available. Rotation and deletion live under Settings → Credentials.</small>
              </label> : <div className="telegram-inline-credential">
                <label><span>New Telegram bot token</span><input name="telegram-new-bot-token" type="password" autoComplete="new-password" value={newBotToken} onChange={(event) => setNewBotToken(event.target.value)} placeholder="123456789:AA…" disabled={busy || loading} /></label>
                <button className="secondary-button" type="button" disabled={busy || loading || !newBotToken.trim()} onClick={createCredential}>Add credential</button>
              </div>}
              <label>
                <span>Default agent</span>
                <SelectMenu value={defaultAgentId} onValueChange={setDefaultAgentId} ariaLabel="Default Telegram agent" options={agentOptions} disabled={busy || loading} />
              </label>
              <label>
                <span>Allowed Telegram user IDs</span>
                <textarea name="telegram-allowed-user-ids" value={allowedUserIds} onChange={(event) => setAllowedUserIds(event.target.value)} placeholder="123456789, 987654321" disabled={busy || loading} rows="3" />
                <small>Numeric user IDs only, separated by commas or new lines. Usernames and group membership never authorize access.</small>
              </label>
              <label className="telegram-switch-option">
                <input name="telegram-allow-agent-switch" type="checkbox" checked={allowAgentSwitch} onChange={(event) => setAllowAgentSwitch(event.target.checked)} disabled={busy || loading} />
                <span><strong>Allow explicit agent switching</strong><small>Approved users can use <code>/agent hermes-agent</code>, <code>/agent claude-cli</code>, or <code>/agent codex-cli</code>. Each agent keeps an independent conversation.</small></span>
              </label>
              <div className="connection-actions telegram-connection-actions">
                <button className="primary-button" type="button" onClick={save} disabled={busy || loading || !credentialId || !defaultAgentId || parsedUserIds.length === 0}>{busy ? "Saving Telegram" : configured ? "Save channel" : "Connect Telegram"}</button>
                {configured && <button className="connection-quiet-button" type="button" onClick={onDisconnect} disabled={busy || loading}>Disconnect</button>}
              </div>
            </>}
          </div>
          <div className="connection-privacy-note"><ShieldCheckmark24Regular aria-hidden="true" /><p>Channel selection changes broker routing only. It does not install Telegram or its token inside this workspace.</p></div>
        </article>
        <article className="workspace-channel-card workspace-channel-roadmap" aria-disabled="true">
          <span className="workspace-channel-mark slack" aria-hidden="true">S</span>
          <span><strong>Slack</strong><small>Workspace messaging</small></span>
          <em>Coming soon</em>
        </article>
      </div>
    </details>
  );
}

const emptyConnectorDraft = {
  name: "",
  shortDescription: "",
  description: "",
  category: "Productivity",
  endpointUrl: "",
  iconDataUrl: "",
  clientId: "",
  clientSecret: "",
};

const readConnectorIcon = (file) => new Promise((resolve, reject) => {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    reject(new Error("Choose a PNG, JPEG, or WebP image."));
    return;
  }
  if (!file.size || file.size > 256 * 1024) {
    reject(new Error("Connector icons must be 256 KB or smaller."));
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("The connector icon could not be read."));
  reader.onload = () => resolve(String(reader.result));
  reader.readAsDataURL(file);
});

function AddConnectorDialog({ onCreated, onClose }) {
  const [draft, setDraft] = useState(emptyConnectorDraft);
  const [checked, setChecked] = useState(null);
  const [showCredentials, setShowCredentials] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const description = draft.description.trim();
  const payload = {
    ...draft,
    description: description.length >= 3 ? description : draft.shortDescription.trim(),
    iconDataUrl: draft.iconDataUrl || undefined,
    clientId: draft.clientId.trim() || undefined,
    clientSecret: draft.clientSecret || undefined,
  };
  const chooseIcon = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      update("iconDataUrl", await readConnectorIcon(file));
    } catch (iconError) {
      setError(iconError.message);
    }
  };
  const validationError = !/^https:\/\//i.test(draft.endpointUrl.trim())
    ? "Enter a secure MCP server URL beginning with https://."
    : draft.name.trim().length < 2
      ? "Enter a connector name using at least two characters."
      : draft.shortDescription.trim().length < 3
        ? "Enter a card description using at least three characters."
        : "";
  const update = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setChecked(null);
    setError("");
    if (field === "endpointUrl") setShowCredentials(false);
  };
  const discover = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy("checking");
    setError("");
    try {
      setChecked(await adminApi.discoverConnector(payload));
    } catch (requestError) {
      const credentialsRequired = !payload.clientId
        && (requestError.code === "MCP_OAUTH_CLIENT_REQUIRED"
          || (requestError.code === "MCP_OAUTH_REGISTRATION_FAILED" && !requestError.retryable));
      if (credentialsRequired) {
        setShowCredentials(true);
      } else {
        setError(requestError.message);
      }
    } finally {
      setBusy("");
    }
  };
  const create = async () => {
    setBusy("creating");
    setError("");
    try {
      const result = await adminApi.createConnector({ ...payload, discoveryToken: checked.discoveryToken });
      await onCreated(result.connector);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <ModalDialog
      title="Add connector"
      description="Add a reviewed remote MCP service to the organization catalog. People can connect it without a future deployment."
      eyebrow="Organization connector"
      labelledBy="add-connector-title"
      className="add-connector-dialog"
      onClose={busy ? () => undefined : onClose}
    >
      <div className="add-connector-fields">
        <label className="wide"><span>MCP server URL</span><input name="connector-endpoint-url" type="url" placeholder="https://service.example.com/mcp" value={draft.endpointUrl} onChange={(event) => update("endpointUrl", event.target.value)} disabled={Boolean(busy)} /></label>
        <label><span>Name</span><input name="connector-name" placeholder="Service name" value={draft.name} onChange={(event) => update("name", event.target.value)} disabled={Boolean(busy)} /></label>
        <label><span>Category</span><SelectMenu value={draft.category} onValueChange={(value) => update("category", value)} ariaLabel="Connector category" disabled={Boolean(busy)} options={connectorCategories.map((value) => ({ value, label: value }))} /></label>
        <label className="wide"><span>Card description</span><input name="connector-short-description" placeholder="What people can do with this service" value={draft.shortDescription} onChange={(event) => update("shortDescription", event.target.value)} disabled={Boolean(busy)} /></label>
        <label className="wide connector-icon-field">
          <span>Connector icon <em>Optional</em></span>
          <div>
            <ConnectorMark connector={{ name: draft.name, brand: "generic", iconDataUrl: draft.iconDataUrl }} />
            <span className="secondary-button">{draft.iconDataUrl ? "Replace icon" : "Upload icon"}<input name="connector-icon" type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseIcon} disabled={Boolean(busy)} /></span>
            {draft.iconDataUrl && <button className="connection-quiet-button" type="button" onClick={() => update("iconDataUrl", "")} disabled={Boolean(busy)}>Remove</button>}
          </div>
          <small>Square PNG, JPEG, or WebP, up to 256 KB.</small>
        </label>
        <label className="wide"><span>Connection description <em>Optional</em></span><textarea name="connector-description" rows="3" placeholder="Defaults to the card description" value={draft.description} onChange={(event) => update("description", event.target.value)} disabled={Boolean(busy)} /></label>
      </div>
      {showCredentials && <section className="add-connector-app-credentials" role="alert" aria-labelledby="connector-credentials-title">
        <div className="add-connector-app-credentials-heading">
          <strong id="connector-credentials-title">Provider app required</strong>
          <span>This server cannot set up the connection automatically. Enter credentials from the provider, then check it again.</span>
        </div>
        <div>
          <label><span>Client ID</span><input name="connector-client-id" autoComplete="off" value={draft.clientId} onChange={(event) => update("clientId", event.target.value)} disabled={Boolean(busy)} /></label>
          <label><span>Client secret</span><input name="connector-client-secret" type="password" autoComplete="new-password" value={draft.clientSecret} onChange={(event) => update("clientSecret", event.target.value)} disabled={Boolean(busy)} /></label>
        </div>
      </section>}
      {checked && <div className="connector-discovery-result" role="status"><CheckmarkCircle24Regular aria-hidden="true" /><span><strong>Connection flow verified</strong>{checked.dynamicClientRegistration ? "Connection setup is automatic. No provider credentials are needed." : "The provider app is ready to use."} Review the authorization destination before adding: <code>{checked.authorizationOrigin}</code>.</span></div>}
      {error && <p className="add-connector-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="secondary-button" type="button" onClick={onClose} disabled={Boolean(busy)}>Cancel</button>
        {!checked
          ? <button className="primary-button" type="button" onClick={discover} disabled={Boolean(busy)} aria-busy={busy === "checking"}>{busy === "checking" ? "Checking server" : "Check server"}</button>
          : <button className="primary-button" type="button" onClick={create} disabled={Boolean(busy)} aria-busy={busy === "creating"}>{busy === "creating" ? "Adding connector" : "Add connector"}</button>}
      </div>
    </ModalDialog>
  );
}

function ConnectionsScreen({ connections, loading, busyConnectorId, error, onConnect, onDisconnect, onIconChange, onAccessPolicySave, onRemoveConnector, onAddConnector, displayName, canAddConnector, canManagePolicy, view, onViewChange, mcpPolicy, policyLoading, policySaving, onPolicyChange, onPolicySave, effectivePolicy, effectivePolicyLoading, effectivePolicyError, onRetryDelivery }) {
  const microsoft = connections.find((connector) => connector.id === "microsoft-365");
  if (view !== "list") {
    if (view.startsWith("microsoft365-") && microsoft) {
      return <Microsoft365Detail connection={microsoft} loading={loading} busy={busyConnectorId === microsoft.id} error={error} onConnect={() => onConnect(microsoft.id)} onDisconnect={() => onDisconnect(microsoft)} onAccessPolicySave={onAccessPolicySave} displayName={displayName} canManageConnector={Boolean(microsoft.canAdministerConnector)} canManagePolicy={canManagePolicy} activeTab={view === "microsoft365-tools" ? "tools" : "overview"} onTabChange={(tab) => onViewChange(`microsoft365-${tab}`)} onBack={() => onViewChange("list")} mcpPolicy={mcpPolicy} policyLoading={policyLoading} policySaving={policySaving} onPolicyChange={onPolicyChange} onPolicySave={onPolicySave} effectivePolicy={effectivePolicy?.connector.id === microsoft.id ? effectivePolicy : null} effectivePolicyLoading={effectivePolicyLoading} effectivePolicyError={effectivePolicyError} deliveryBusy={busyConnectorId === microsoft.id} onRetryDelivery={onRetryDelivery} />;
    }
    const selected = connections.find((connector) => view === `connector-${connector.id}` || view === `connector-${connector.id}-tools`);
    if (selected) {
      return <HostedConnectorDetail connector={selected} loading={loading} busy={busyConnectorId === selected.id} error={error} onConnect={onConnect} onDisconnect={onDisconnect} onIconChange={onIconChange} onAccessPolicySave={onAccessPolicySave} onRemove={onRemoveConnector} onBack={() => onViewChange("list")} canManageConnector={Boolean(selected.canAdministerConnector)} activeTab={view.endsWith("-tools") ? "tools" : "overview"} onTabChange={(tab) => onViewChange(tab === "tools" ? `connector-${selected.id}-tools` : `connector-${selected.id}`)} mcpPolicy={mcpPolicy?.connectorId === selected.id ? mcpPolicy : null} policyLoading={policyLoading} policySaving={policySaving} onPolicyChange={onPolicyChange} onPolicySave={onPolicySave} effectivePolicy={effectivePolicy?.connector.id === selected.id ? effectivePolicy : null} effectivePolicyLoading={effectivePolicyLoading} effectivePolicyError={effectivePolicyError} deliveryBusy={busyConnectorId === selected.id} onRetryDelivery={onRetryDelivery} />;
    }
  }
  return (
    <div className="secondary-screen connections-screen">
      <div className="connections-page-intro">
        <header className="page-heading compact">
          <p>Your services</p>
          <h1>Connections</h1>
          <span>Connect the work services you want to use. Connected services become available to your workspace agents automatically.</span>
        </header>
        {canAddConnector && <button className="primary-button connections-add-button" type="button" onClick={onAddConnector}><Add24Regular aria-hidden="true" />Add connector</button>}
      </div>

      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>The connection was not updated</strong>{error}</span></div>}

      {connectorCategories.map((category) => {
        const categoryConnections = connections.filter((connector) => connector.category === category);
        if (!categoryConnections.length) return null;
        return (
          <section className="connector-catalog-section" aria-labelledby={`connector-category-${category.replace(/\s+/g, "-").toLowerCase()}`} key={category}>
            <div className="connector-category-heading">
              <h2 id={`connector-category-${category.replace(/\s+/g, "-").toLowerCase()}`}>{category}</h2>
              <span>{categoryConnections.filter((connector) => connector.state === "connected").length} connected</span>
            </div>
            <div className="connector-grid">
              {categoryConnections.map((connector) => {
                const connected = connector.state === "connected";
                const expired = connector.state === "expired";
                const activation = activationFor(connector);
                const canConnect = activation.action === "connect";
                const setupRequired = activation.readiness === "setup_required";
                const accessRequired = activation.readiness === "request_access";
                const organizationDisabled = connector.enabled === false;
                const connectionLocked = connector.canManageConnection === false;
                const busy = busyConnectorId === connector.id;
                return (
                  <article className={`connector-catalog-card${connected ? " connected" : ""}`} key={connector.id}>
                    <ConnectorMark connector={connector} />
                    <div className="connector-catalog-copy">
                      <div>
                        <h3>{connector.name}</h3>
                        <span className={`connector-card-state ${connected ? "connected" : expired ? "expired" : ""}`}>{loading ? "Checking" : organizationDisabled ? "Disabled" : connected ? "Connected" : expired ? "Reconnect" : connectionLocked ? "Admin managed" : setupRequired ? "Setup required" : accessRequired ? "Access required" : "Available"}</span>
                      </div>
                      <p>{connector.shortDescription}</p>
                      <small>{connector.policySupport === "governed" ? "Approved tools ready" : "Added to workspace agents after connection"}</small>
                    </div>
                    <div className="connector-catalog-action">
                      {connector.canAdministerConnector && connector.source === "custom" && !connected && <button className="connector-manage-link" type="button" onClick={() => onViewChange(`connector-${connector.id}`)}>Manage</button>}
                      {connected ? (
                        <button className="secondary-button" type="button" onClick={() => onViewChange(connector.id === "microsoft-365" ? "microsoft365-overview" : `connector-${connector.id}`)}>Manage<ChevronRight16Regular aria-hidden="true" /></button>
                      ) : canConnect ? (
                        <button className="secondary-button" type="button" onClick={() => onConnect(connector.id)} disabled={loading || busy || organizationDisabled || connectionLocked}>{busy ? "Opening" : expired ? "Reconnect" : "Connect"}</button>
                      ) : (
                        <button className="secondary-button" type="button" onClick={() => onViewChange(connector.id === "microsoft-365" ? "microsoft365-overview" : `connector-${connector.id}`)} disabled={loading}>{activationActionLabel(activation)}<ChevronRight16Regular aria-hidden="true" /></button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}

    </div>
  );
}

function ChatPart({ part, markdown = false }) {
  if (part.type === "text") {
    return markdown
      ? <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown></div>
      : <p className="chat-message-text">{part.text}</p>;
  }
  if (part.type === "file" || part.type === "data-file-reference") {
    const file = part.type === "file" ? part : part.data;
    const image = part.type === "file" && file.mediaType.startsWith("image/");
    return (
      <div className={`chat-file-part${image ? " image" : ""}`}>
        {image
          ? <img src={part.url} alt={file.filename || "Attached image"} />
          : <Document24Regular aria-hidden="true" />}
        <span>{file.filename || "Attached file"}</span>
      </div>
    );
  }
  if (part.type === "data-progress") {
    return (
      <div className={`chat-activity progress ${part.data.state}`}>
        <span aria-hidden="true" />
        <p>{part.data.label}</p>
      </div>
    );
  }
  if (part.type === "data-tool") {
    return null;
  }
  if (part.type === "data-approval") {
    return (
      <div className={`chat-approval ${part.data.state}`}>
        <ShieldCheckmark24Regular aria-hidden="true" />
        <span><strong>{part.data.summary}</strong><small>Governed Microsoft 365 action</small></span>
      </div>
    );
  }
  if (part.type === "data-terminal" && part.data.state !== "completed") {
    if (part.data.state === "needs_input") {
      return (
        <div className="chat-terminal needs_input" role="status">
          Waiting for your reply. Your next message will continue this conversation.
        </div>
      );
    }
    return <div className={`chat-terminal ${part.data.state}`} role="status">{part.data.message || `Turn ${part.data.state}`}</div>;
  }
  return null;
}

function ChatConversation({
  threadId,
  workspaceId,
  agentId,
  agentName,
  supportsVision,
  requestedServiceClass,
  onTurnBusyChange,
  sessionId,
  onSessionsChange,
  onSessionCreated,
  onNewThread,
  onOpenThread,
  onRefreshSessions,
  companionComposer = false,
  composerContext,
  contextSummary,
  skills = [],
  sessionOptions = [],
  historyHasMore = false,
  historyLoadingMore = false,
  onLoadOlder,
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [historyState, setHistoryState] = useState("ready");
  const [historyError, setHistoryError] = useState("");
  const [historyReload, setHistoryReload] = useState(0);
  const [chatActionsOpen, setChatActionsOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const transcriptRef = useRef(null);
  const fileInputRef = useRef(null);
  const sessionRef = useRef(sessionId);
  const loadedSessionRef = useRef("");
  const chatActionsRef = useRef(null);
  const contextRef = useRef(null);
  const activityToggleRef = useRef(null);
  const chatPopoverRefs = useMemo(() => [chatActionsRef, contextRef], []);
  const [activityOpen, setActivityOpen] = useState(false);
  const [selectedActivityTurnId, setSelectedActivityTurnId] = useState("");

  useDismissOnOutside(chatActionsOpen || contextOpen, () => {
    setChatActionsOpen(false);
    setContextOpen(false);
  }, chatPopoverRefs);

  const refreshSessions = () => onRefreshSessions?.();
  const transport = useMemo(() => new DefaultChatTransport({
    prepareSendMessagesRequest: ({ messages }) => {
      const sessionId = sessionRef.current;
      if (!sessionId) throw new Error("The conversation is not ready.");
      return {
        api: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
        headers: {
          "idempotency-key": crypto.randomUUID(),
        },
        body: { message: messages.at(-1), requestedServiceClass },
      };
    },
  }), [workspaceId, agentId, requestedServiceClass]);
  const {
    messages,
    sendMessage,
    setMessages,
    status,
    error,
    stop,
    clearError,
  } = useChat({
    // A thread stays mounted while its sibling threads stream. Its controller
    // therefore needs a stable, thread-specific identity rather than sharing
    // state with every conversation for this workspace and agent.
    id: `${workspaceId}:${agentId}:${threadId}`,
    transport,
    onFinish: () => { void refreshSessions(); },
  });
  const busy = status === "submitted" || status === "streaming";
  const latestMessage = messages.at(-1);
  const latestMessageCreatedAt = Date.parse(latestMessage?.metadata?.createdAt ?? "");
  const restoredTurnActive = !busy
    && Boolean(sessionId)
    && Number.isFinite(latestMessageCreatedAt)
    && Date.now() - latestMessageCreatedAt <= restoredChatTurnMaxAgeMs
    && (latestMessage?.role === "user"
      || (latestMessage?.role === "assistant" && latestMessage.metadata?.state === "streaming"));
  const turnBusy = busy || restoredTurnActive;
  const pendingApprovalKey = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "data-approval"
      && ["approval_required", "approved", "executing"].includes(part.data.state))
    .map((part) => part.data.operationId)
    .sort()
    .join(":");
  const activityTurns = messages
    .filter((message) => message.role === "assistant" && message.metadata?.turnId)
    .map((message) => message.metadata.turnId);
  const latestActivityTurnId = activityTurns.at(-1) ?? "";

  useEffect(() => {
    onTurnBusyChange?.(turnBusy);
    return () => onTurnBusyChange?.(false);
  }, [onTurnBusyChange, turnBusy]);

  useEffect(() => {
    if (latestActivityTurnId) setSelectedActivityTurnId(latestActivityTurnId);
  }, [latestActivityTurnId]);

  useEffect(() => {
    sessionRef.current = sessionId;
    if (!sessionId) {
      loadedSessionRef.current = "";
      setMessages([]);
      setSelectedActivityTurnId("");
      setAttachments([]);
      setAttachmentError("");
      setHistoryState("ready");
      setHistoryError("");
      clearError();
      return undefined;
    }
    if (loadedSessionRef.current === sessionId) return undefined;
    let active = true;
    setHistoryState("loading");
    setHistoryError("");
    setSelectedActivityTurnId("");
    setMessages([]);
    chatApi.messages(workspaceId, agentId, sessionId)
      .then((result) => {
        if (!active) return;
        loadedSessionRef.current = sessionId;
        setMessages(result.messages);
        setHistoryState("ready");
      })
      .catch((requestError) => {
        if (!active) return;
        setHistoryError(requestError.message);
        setHistoryState("error");
      });
    return () => { active = false; };
  }, [sessionId, workspaceId, agentId, historyReload, setMessages, clearError]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    if (busy || !sessionId || (!restoredTurnActive && !pendingApprovalKey)) return undefined;
    let active = true;
    const refresh = () => chatApi.messages(workspaceId, agentId, sessionId)
      .then((result) => {
        if (active && sessionRef.current === sessionId) setMessages(result.messages);
      })
      .catch(() => {
        // The ordinary chat error surface handles session/runtime failures.
        // A transient reconciliation miss must not erase the transcript.
      });
    refresh();
    const interval = window.setInterval(refresh, 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [sessionId, agentId, busy, pendingApprovalKey, restoredTurnActive, setMessages, workspaceId]);

  const addAttachments = async (files) => {
    const selected = [...files];
    if (!selected.length) return;
    setAttachmentError("");
    const image = selected.find((file) => attachmentMediaType(file)?.startsWith("image/"));
    if (image && !supportsVision) {
      setAttachmentError("The selected workspace model does not support image input. Choose another model or attach a document.");
      return;
    }
    if (attachments.length + selected.length > chatAttachmentMaxFiles) {
      setAttachmentError(`Attach up to ${chatAttachmentMaxFiles} files per message.`);
      return;
    }
    const nextTotal = attachments.reduce((total, attachment) => total + attachment.size, 0)
      + selected.reduce((total, file) => total + file.size, 0);
    const oversized = selected.find((file) => file.size > chatAttachmentMaxBytes);
    if (oversized) {
      setAttachmentError(`${oversized.name} is larger than 8 MB.`);
      return;
    }
    if (nextTotal > chatAttachmentMaxTotalBytes) {
      setAttachmentError("Attachments can total up to 16 MB per message.");
      return;
    }
    const unsupported = selected.find((file) => !attachmentMediaType(file));
    if (unsupported) {
      setAttachmentError(`${unsupported.name} is not a supported image or document.`);
      return;
    }
    setAttachmentBusy(true);
    try {
      const prepared = await Promise.all(selected.map(async (file) => {
        const mediaType = attachmentMediaType(file);
        const normalized = file.type === mediaType
          ? file
          : new File([file], file.name, { type: mediaType, lastModified: file.lastModified });
        return {
          size: normalized.size,
          part: {
            type: "file",
            filename: normalized.name,
            mediaType,
            url: await fileToDataUrl(normalized),
          },
        };
      }));
      setAttachments((current) => [...current, ...prepared]);
    } catch (requestError) {
      setAttachmentError(requestError.message);
    } finally {
      setAttachmentBusy(false);
    }
  };

  const removeAttachment = (index) => {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setAttachmentError("");
  };

  const submit = async (event) => {
    event.preventDefault();
    const text = input.trim();
    if ((!text && !attachments.length) || turnBusy || attachmentBusy) return;
    clearError();
    let sessionId = sessionRef.current;
    if (!sessionId) {
      try {
        const title = (text || attachments.map((attachment) => attachment.part.filename).join(", "))
          .replace(/\s+/g, " ")
          .slice(0, 56);
        const created = await chatApi.createSession(workspaceId, agentId, title);
        sessionId = created.id;
        sessionRef.current = sessionId;
        loadedSessionRef.current = sessionId;
        onSessionsChange((current) => [
          { ...created, title: created.title ?? title },
          ...current.filter((item) => item.id !== created.id),
        ]);
        onSessionCreated?.(threadId, sessionId);
      } catch (requestError) {
        setHistoryError(requestError.message);
        setHistoryState("error");
        return;
      }
    }
    const outgoingAttachments = attachments;
    setInput("");
    setAttachments([]);
    setAttachmentError("");
    try {
      await sendMessage({
        ...(text ? { text } : {}),
        files: outgoingAttachments.map((attachment) => attachment.part),
        metadata: {
          agentCatalogId: agentId,
          state: "completed",
          createdAt: new Date().toISOString(),
        },
      });
    } catch (requestError) {
      setInput(text);
      setAttachments(outgoingAttachments);
      setAttachmentError(requestError.message);
    }
  };

  const stopTurn = () => {
    void stop();
    const sessionId = sessionRef.current;
    if (!sessionId) return;
    chatApi.cancelTurn(workspaceId, agentId, sessionId)
      .then(() => {
        if (sessionRef.current === sessionId) setHistoryReload((value) => value + 1);
      })
      .catch((requestError) => setHistoryError(requestError.message));
  };

  const visibleMessages = messages.filter((item) => item.role === "user" || item.role === "assistant");
  const awaitingAssistant = turnBusy && visibleMessages.at(-1)?.role === "user";
  const needsInput = !turnBusy
    && visibleMessages.at(-1)?.role === "assistant"
    && visibleMessages.at(-1)?.metadata?.state === "needs_input";
  const messageField = (
    <>
      <label className="sr-only" htmlFor={`chat-message-${threadId}`}>Message {agentName}</label>
      <textarea
        id={`chat-message-${threadId}`}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onPaste={(event) => {
          const images = [...event.clipboardData.items]
            .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
            .flatMap((item) => {
              const blob = item.getAsFile();
              if (!blob) return [];
              const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
              return [new File([blob], `pasted-image-${Date.now()}.${extension}`, { type: blob.type })];
            });
          if (images.length) {
            event.preventDefault();
            void addAttachments(images);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={needsInput ? `Reply to ${agentName}` : `Message ${agentName}`}
        rows="1"
        maxLength="16000"
        disabled={restoredTurnActive || historyState === "loading"}
      />
    </>
  );
  return (
    <div className={`chat-stage${activityOpen ? " activity-open" : ""}`}>
    <section className={`chat-conversation${visibleMessages.length === 0 ? " is-empty" : ""}`} aria-label="Current conversation">
      <ActivityToggle
        open={activityOpen}
        buttonRef={activityToggleRef}
        onClick={() => {
          if (!selectedActivityTurnId && latestActivityTurnId) setSelectedActivityTurnId(latestActivityTurnId);
          setActivityOpen((open) => !open);
        }}
      />
      <div className={visibleMessages.length === 0 ? "chat-empty-state" : "chat-conversation-content"}>
      <div className="chat-transcript" ref={transcriptRef} aria-live="polite" aria-busy={turnBusy || historyState === "loading"}>
        {visibleMessages.length === 0 ? (
          <div className="chat-welcome">
            <h1>How can {agentName} help?</h1>
            <p>Ask about the files, approved tools, and connections in your managed workspace.</p>
            {skills.length > 0 && <div className="chat-welcome-skills" aria-label="Available skills">
              {skills.map((skill) => <button type="button" key={skill.id} onClick={() => setInput(skill.defaultPrompt)}>
                <WindowApps24Regular aria-hidden="true" />
                <span><strong>{skill.displayName}</strong><small>{skill.description}</small></span>
              </button>)}
            </div>}
          </div>
        ) : visibleMessages.map((message) => (
          <article className={`chat-message ${message.role}`} key={message.id}>
            <div className="chat-message-heading">
              <span>{message.role === "assistant" ? agentName : "You"}</span>
              {message.role === "assistant" && message.metadata?.turnId && (
                <button
                  type="button"
                  aria-label={`View activity for this ${agentName} response`}
                  aria-pressed={activityOpen && selectedActivityTurnId === message.metadata.turnId}
                  onClick={() => {
                    setSelectedActivityTurnId(message.metadata.turnId);
                    setActivityOpen(true);
                  }}
                >
                  View activity
                </button>
              )}
            </div>
            <div className="chat-message-parts">
              {message.parts.map((part, index) => (
                <ChatPart
                  key={part.id || `${part.type}-${index}`}
                  part={part}
                  markdown={message.role === "assistant"}
                />
              ))}
            </div>
          </article>
        ))}
        {awaitingAssistant && (
          <article className="chat-message system chat-acknowledgement" aria-label="LemmaComputer received your message">
            <span>LemmaComputer</span>
            <div className="chat-activity progress running" role="status">
              <span aria-hidden="true" />
              <p>Message received.</p>
            </div>
          </article>
        )}
      </div>
      {(error || historyError) && (
        <div className="workspace-error chat-error" role="alert">
          <Info24Regular aria-hidden="true" />
          <span>{error?.message || historyError}</span>
          {historyError && (
            <button type="button" className="chat-error-retry" onClick={() => setHistoryReload((value) => value + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
      <form className={`chat-composer${companionComposer ? " companion-chat-composer" : ""}`} onSubmit={submit}>
        {attachments.length > 0 && (
          <div className="chat-attachment-list" aria-label="Attachments">
            {attachments.map((attachment, index) => (
              <div className="chat-attachment-preview" key={`${attachment.part.filename}-${index}`}>
                {attachment.part.mediaType.startsWith("image/")
                  ? <img src={attachment.part.url} alt="" />
                  : <Document24Regular aria-hidden="true" />}
                <span><strong>{attachment.part.filename}</strong><small>{attachmentSize(attachment.size)}</small></span>
                <button type="button" onClick={() => removeAttachment(index)} aria-label={`Remove ${attachment.part.filename}`}>
                  <Dismiss16Regular aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && <p className="chat-attachment-error" role="alert">{attachmentError}</p>}
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv,.json,.xml,.yaml,.yml,.log,.js,.jsx,.ts,.tsx,.py,.java,.go,.rs,.sh,.sql,.css,.html"
          onChange={(event) => {
            void addAttachments(event.target.files || []);
            event.target.value = "";
          }}
        />
        {companionComposer ? (
          <div className="companion-chat-composer-row">
            <div ref={chatActionsRef} className="companion-chat-composer-control actions-control">
              <button
                className="chat-attach-button"
                type="button"
                aria-label="Chat actions"
                aria-expanded={chatActionsOpen}
                aria-controls="companion-chat-actions"
                disabled={turnBusy || attachmentBusy || historyState === "loading"}
                onClick={() => {
                  setChatActionsOpen((open) => !open);
                  setContextOpen(false);
                }}
              >
                <Add24Regular aria-hidden="true" />
              </button>
              {chatActionsOpen && (
                <div id="companion-chat-actions" className="companion-chat-composer-menu" role="menu" aria-label="Chat actions">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setChatActionsOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <Attach24Regular aria-hidden="true" />Attach files
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setChatActionsOpen(false);
                      onNewThread?.();
                    }}
                  >
                    <Add24Regular aria-hidden="true" />New thread
                  </button>
                  {skills.length > 0 && <div className="companion-chat-skill-list" role="group" aria-label="Skills">
                    <span>Skills</span>
                    {skills.map((skill) => <button type="button" role="menuitem" key={skill.id} onClick={() => {
                      setInput(skill.defaultPrompt);
                      setChatActionsOpen(false);
                    }}>
                      <WindowApps24Regular aria-hidden="true" /><span><strong>{skill.displayName}</strong><small>{skill.description}</small></span>
                    </button>)}
                  </div>}
                  {sessionOptions.length > 1 && <div className="companion-chat-recent-sessions" role="group" aria-label="Recent conversations">
                    <span>Recent conversations</span>
                    {sessionOptions.filter((session) => session.value).map((session) => (
                      <button
                        className={session.value === sessionId ? "active" : ""}
                        type="button"
                        key={session.value}
                        onClick={() => {
                          setChatActionsOpen(false);
                          onOpenThread?.(session.value);
                        }}
                      >
                        {session.label}
                      </button>
                    ))}
                  </div>}
                  {historyHasMore && <button type="button" className="companion-chat-load-older" disabled={historyLoadingMore} onClick={onLoadOlder}>
                    {historyLoadingMore ? "Loading conversations…" : "Load older conversations"}
                  </button>}
                </div>
              )}
            </div>
            {messageField}
            <div ref={contextRef} className="companion-chat-composer-control context-control">
              {composerContext ? (
                <>
                  <button
                    className="companion-chat-context-button"
                    type="button"
                    aria-expanded={contextOpen}
                    aria-controls="companion-chat-context"
                    onClick={() => {
                      setContextOpen((open) => !open);
                      setChatActionsOpen(false);
                    }}
                  >
                    <span>{contextSummary}</span><ChevronDown16Regular aria-hidden="true" />
                  </button>
                  {contextOpen && <div id="companion-chat-context" className="companion-chat-composer-menu companion-chat-context-menu" role="dialog" aria-label="Chat context">{composerContext}</div>}
                </>
              ) : <span className="companion-chat-context-static">{contextSummary}</span>}
            </div>
            {turnBusy ? (
              <button className="chat-stop-button" type="button" aria-label={`Stop ${agentName}`} onClick={stopTurn}><Dismiss24Regular aria-hidden="true" /></button>
            ) : (
              <button className="chat-send-button" type="submit" aria-label="Send message" disabled={restoredTurnActive || (!input.trim() && !attachments.length) || attachmentBusy || historyState === "loading"}><ArrowUp24Regular aria-hidden="true" /></button>
            )}
          </div>
        ) : (
          <>
            <button
              className="chat-attach-button"
              type="button"
              aria-label="Attach files"
              title="Attach files"
              disabled={turnBusy || attachmentBusy || historyState === "loading"}
              onClick={() => fileInputRef.current?.click()}
            >
              <Attach24Regular aria-hidden="true" />
            </button>
            {messageField}
            {turnBusy ? (
              <button className="chat-stop-button" type="button" aria-label={`Stop ${agentName}`} onClick={stopTurn}><Dismiss24Regular aria-hidden="true" /></button>
            ) : (
              <button className="chat-send-button" type="submit" aria-label="Send message" disabled={restoredTurnActive || (!input.trim() && !attachments.length) || attachmentBusy || historyState === "loading"}><ArrowUp24Regular aria-hidden="true" /></button>
            )}
          </>
        )}
      </form>
      </div>
    </section>
      <ActivityPanel
        open={activityOpen}
        workspaceId={workspaceId}
        agentId={agentId}
        sessionId={sessionId}
        turnId={selectedActivityTurnId || latestActivityTurnId}
        onClose={() => setActivityOpen(false)}
        returnFocusRef={activityToggleRef}
      />
    </div>
  );
}

export function ChatScreen({
  workspace,
  workspaces,
  workspaceState,
  skills = [],
  onWorkspaceChange,
  onStartWorkspace,
  onRestartWorkspace,
  activeSessionId,
  onSessionsChange,
  onSessionChange,
  preferredAgentId,
  onAgentChange,
  historyLoadRequest,
  onHistoryMetadataChange,
  companionComposer = false,
  sessions = [],
  historyHasMore = false,
  historyLoadingMore = false,
  onLoadOlder,
  newThreadRequest = 0,
  onRunningSessionIdsChange,
}) {
  const [agents, setAgents] = useState([]);
  const [activeAgentId, setActiveAgentId] = useState("");
  const [status, setStatus] = useState("loading");
  const [reasonCode, setReasonCode] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [sessionNextCursor, setSessionNextCursor] = useState(null);
  const [sessionLoadingMore, setSessionLoadingMore] = useState(false);
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState("");
  const [threadBusy, setThreadBusy] = useState({});
  const [threadServiceClasses, setThreadServiceClasses] = useState({});
  const handledHistoryLoadRequest = useRef(historyLoadRequest);
  const handledNewThreadRequest = useRef(newThreadRequest);

  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const selectedSessionId = activeThread?.sessionId ?? "";
  const contextBusy = Object.values(threadBusy).some(Boolean);
  const serviceClassFor = (thread) => threadServiceClasses[thread.id] ?? "auto";
  const activeRequestedServiceClass = activeThread ? serviceClassFor(activeThread) : "auto";

  useEffect(() => {
    if (!activeThreadId) return;
    const restored = readChatServiceClassPreference(
      workspace?.id,
      activeAgentId,
      selectedSessionId,
    );
    setThreadServiceClasses((current) => current[activeThreadId] === restored
      ? current
      : { ...current, [activeThreadId]: restored });
  }, [workspace?.id, activeAgentId, activeThreadId, selectedSessionId]);

  const publishHistoryMetadata = (nextCursor = sessionNextCursor, loading = sessionLoadingMore) => {
    onHistoryMetadataChange?.({ hasMore: Boolean(nextCursor), loading });
  };

  const loadSessionPage = async (cursor, append = false) => {
    if (!workspace || !activeAgentId) return;
    if (append) {
      setSessionLoadingMore(true);
      publishHistoryMetadata(sessionNextCursor, true);
    }
    try {
      const page = await chatApi.sessions(workspace.id, activeAgentId, { cursor });
      onSessionsChange((current) => {
        const incoming = page.sessions ?? [];
        if (!append) return incoming;
        return [...current, ...incoming.filter((item) => !current.some((existing) => existing.id === item.id))];
      });
      setSessionNextCursor(page.nextCursor ?? null);
      publishHistoryMetadata(page.nextCursor ?? null, false);
    } catch (requestError) {
      setError(requestError.message);
      publishHistoryMetadata(sessionNextCursor, false);
    } finally {
      if (append) setSessionLoadingMore(false);
    }
  };

  const startNewThread = () => {
    const thread = { id: `new-${crypto.randomUUID()}`, sessionId: "" };
    setThreads((current) => [...current, thread]);
    setActiveThreadId(thread.id);
    onSessionChange("");
  };

  const openThread = (sessionId) => {
    if (!sessionId) {
      startNewThread();
      return;
    }
    const existing = threads.find((thread) => thread.sessionId === sessionId);
    const threadId = existing?.id ?? sessionId;
    if (!existing) setThreads((current) => [...current, { id: threadId, sessionId }]);
    setActiveThreadId(threadId);
    onSessionChange(sessionId);
  };

  const changeThreadBusy = (threadId, busy) => {
    setThreadBusy((current) => current[threadId] === busy ? current : { ...current, [threadId]: busy });
  };

  const registerThreadSession = (threadId, sessionId) => {
    setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, sessionId } : thread));
    const serviceClass = threadServiceClasses[threadId] ?? "auto";
    if (workspace?.id && activeAgentId) {
      writePreference(chatServiceClassPreferenceKey(workspace.id, activeAgentId, sessionId), serviceClass);
    }
    onSessionChange(sessionId);
  };

  useEffect(() => {
    const runningSessions = threads
      .filter((thread) => thread.sessionId && threadBusy[thread.id])
      .map((thread) => thread.sessionId);
    onRunningSessionIdsChange?.(runningSessions);
    return () => onRunningSessionIdsChange?.([]);
  }, [onRunningSessionIdsChange, threadBusy, threads]);

  useEffect(() => {
    let active = true;
    setError("");
    onSessionsChange([]);
    setSessionNextCursor(null);
    onHistoryMetadataChange?.({ hasMore: false, loading: false });
    setAgents([]);
    setActiveAgentId("");
    setThreads([]);
    setActiveThreadId("");
    setThreadBusy({});
    setThreadServiceClasses({});
    if (!workspace || !["ready", "open"].includes(workspaceState)) {
      setStatus("offline");
      setReasonCode("WORKSPACE_NOT_READY");
      return () => { active = false; };
    }
    setStatus("loading");
    chatApi.agents(workspace.id)
      .then((result) => {
        if (!active) return;
        const nextAgents = result.agents ?? [];
        setAgents(nextAgents);
        if (nextAgents.length === 0) {
          setStatus("unavailable");
          setReasonCode("CHAT_AGENT_NOT_SELECTED");
          return;
        }
        const preferred = nextAgents.find((agent) => agent.catalogId === preferredAgentId)
          ?? nextAgents.find((agent) => agent.state === "ready")
          ?? nextAgents[0];
        setActiveAgentId(preferred.catalogId);
        onAgentChange?.(workspace.id, preferred.catalogId);
      })
      .catch((requestError) => {
        if (!active) return;
        setStatus("error");
        setError(requestError.message);
      });
    return () => { active = false; };
  }, [workspace?.id, workspaceState, reload]);

  useEffect(() => {
    if (!workspace || !activeAgentId || !["ready", "open"].includes(workspaceState)) return undefined;
    let active = true;
    setStatus("loading");
    setError("");
    onSessionsChange([]);
    setSessionNextCursor(null);
    onHistoryMetadataChange?.({ hasMore: false, loading: false });
    setThreads([]);
    setActiveThreadId("");
    setThreadBusy({});
    setThreadServiceClasses({});
    chatApi.status(workspace.id, activeAgentId)
      .then(async (nextStatus) => {
        if (!active) return;
        setStatus(nextStatus.state);
        setReasonCode(nextStatus.reasonCode);
        if (nextStatus.state === "ready") {
          await loadSessionPage();
        }
      })
      .catch((requestError) => {
        if (!active) return;
        setStatus("error");
        setError(requestError.message);
      });
    return () => { active = false; };
  }, [workspace?.id, workspaceState, activeAgentId, reload]);

  useEffect(() => {
    if (historyLoadRequest === handledHistoryLoadRequest.current) return;
    handledHistoryLoadRequest.current = historyLoadRequest;
    if (status !== "ready" || !sessionNextCursor || sessionLoadingMore) return;
    void loadSessionPage(sessionNextCursor, true);
  }, [historyLoadRequest, sessionNextCursor, sessionLoadingMore, status]);

  useEffect(() => {
    if (status !== "ready" || !activeSessionId) return;
    const existing = threads.find((thread) => thread.sessionId === activeSessionId);
    if (!existing) {
      setThreads((current) => [...current, { id: activeSessionId, sessionId: activeSessionId }]);
      setActiveThreadId(activeSessionId);
      return;
    }
    if (activeThreadId !== existing.id) setActiveThreadId(existing.id);
  }, [activeSessionId, activeThreadId, status, threads]);

  useEffect(() => {
    if (status !== "ready" || activeSessionId || threads.length || activeThreadId) return;
    startNewThread();
  }, [activeSessionId, activeThreadId, status, threads.length]);

  useEffect(() => {
    if (newThreadRequest === handledNewThreadRequest.current || status !== "ready") return;
    handledNewThreadRequest.current = newThreadRequest;
    startNewThread();
  }, [newThreadRequest, status]);

  useEffect(() => {
    if (
      status !== "offline"
      || reasonCode !== "CHAT_RUNTIME_UNAVAILABLE"
      || !workspace
      || !["ready", "open"].includes(workspaceState)
    ) return undefined;
    const timeout = window.setTimeout(() => setReload((value) => value + 1), 2000);
    return () => window.clearTimeout(timeout);
  }, [status, reasonCode, workspace?.id, workspaceState]);

  const offline = status === "offline";
  const unavailable = status === "unavailable";
  const activeAgent = agents.find((agent) => agent.catalogId === activeAgentId);
  const agentName = activeAgent?.displayName ?? "workspace agent";
  const agentOptions = agents.map((agent) => ({
    value: agent.catalogId,
    label: agent.displayName,
  }));
  const selectAgent = (catalogId) => {
    if (catalogId === activeAgentId) return;
    onSessionChange("");
    setActiveAgentId(catalogId);
    onAgentChange?.(workspace?.id, catalogId);
  };
  const selectRequestedServiceClass = (serviceClass) => {
    if (!activeThread) return;
    setThreadServiceClasses((current) => ({ ...current, [activeThread.id]: serviceClass }));
    if (workspace?.id && activeAgentId && selectedSessionId) {
      writePreference(
        chatServiceClassPreferenceKey(workspace.id, activeAgentId, selectedSessionId),
        serviceClass,
      );
    }
  };
  const workspaceOptions = workspaces?.length ? workspaces : workspace ? [workspace] : [];
  const hasContextControls = workspaceOptions.length > 0 || agents.length > 0;
  const contextControls = hasContextControls ? (
    <>
      {workspaceOptions.length > 0 && <div className="chat-agent-selector">
        <span className="chat-agent-selector-label">Workspace</span>
        <SelectMenu
          value={workspace?.id ?? ""}
          onValueChange={onWorkspaceChange}
          disabled={contextBusy}
          ariaLabel="Choose workspace"
          options={workspaceOptions.map((item) => ({ value: item.id, label: workspaceName(item) }))}
        />
      </div>}
      {agents.length > 0 && <div className="chat-agent-selector">
        <span className="chat-agent-selector-label">Agent</span>
        <SelectMenu
          value={activeAgentId}
          onValueChange={selectAgent}
          disabled={contextBusy}
          ariaLabel="Choose chat agent"
          options={agentOptions}
        />
      </div>}
      <div className="chat-agent-selector">
        <span className="chat-agent-selector-label">Model</span>
        <SelectMenu
          value={activeRequestedServiceClass}
          onValueChange={selectRequestedServiceClass}
          disabled={contextBusy}
          ariaLabel="Choose model mode"
          options={chatServiceClassOptions}
        />
      </div>
    </>
  ) : null;
  const contextSelector = contextControls ? (
    <div className="chat-context-selectors">
      {contextControls}
    </div>
  ) : null;
  if (status !== "ready") {
    const workspaceCanRetry = workspace && ["ready", "open"].includes(workspaceState);
    const workspaceBusy = ["loading", "provisioning", "restarting", "stopping"].includes(workspaceState);
    const restartRequired = offline && reasonCode === "CHAT_RUNTIME_UNAVAILABLE" && workspaceCanRetry;
    return (
      <div className="secondary-screen chat-screen">
        <div className="chat-stage chat-runtime-state" aria-label="Current conversation">
        <section className="chat-unavailable" aria-live="polite">
          <span className={`chat-agent-mark${status === "loading" ? " loading" : ""}`}><Bot24Regular aria-hidden="true" /></span>
          <div>
            <h2>{status === "loading" ? `Connecting to ${agentName}` : unavailable ? "No chat agent is selected" : offline ? `${agentName} is offline` : "Chat could not connect"}</h2>
            <p>{status === "loading"
              ? "We’re checking the selected agent inside your workspace."
              : unavailable
                ? "Select a supported CLI agent in this workspace’s settings, then restart the workspace."
                : restartRequired
                  ? `${agentName} is not responding in this workspace. Restart it once to apply the latest managed agent runtime.`
                  : offline
                    ? `Start the workspace to bring ${agentName}, its sessions, and its connections online.`
                    : error || `${agentName} is temporarily unavailable.`}</p>
            {status !== "loading" && !unavailable && (
              <div className="chat-recovery-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={restartRequired ? onRestartWorkspace : workspaceCanRetry ? () => setReload((value) => value + 1) : onStartWorkspace}
                  disabled={workspaceBusy}
                >
                  {workspaceBusy ? "Preparing workspace" : restartRequired ? "Restart workspace" : workspaceCanRetry ? "Try again" : "Start workspace"}
                </button>
                {restartRequired && <button className="secondary-button" type="button" onClick={() => setReload((value) => value + 1)}>Try again</button>}
              </div>
            )}
          </div>
        </section>
        </div>
      </div>
    );
  }

  return (
    <div className="secondary-screen chat-screen">
      {!companionComposer && contextSelector}
      <div className="chat-thread-panes">
        {threads.map((thread) => {
          const requestedServiceClass = serviceClassFor(thread);
          const threadContextSummary = [agentName, workspace ? workspaceName(workspace) : "", chatServiceClassLabel[requestedServiceClass]]
            .filter(Boolean)
            .join(" · ");
          return <div className="chat-thread-pane" key={`${workspace.id}:${activeAgentId}:${thread.id}`} hidden={thread.id !== activeThreadId}>
            <ChatConversation
              threadId={thread.id}
              workspaceId={workspace.id}
              agentId={activeAgentId}
              agentName={agentName}
              supportsVision={workspace.modelRoute?.capabilities?.vision === true}
              requestedServiceClass={requestedServiceClass}
              onTurnBusyChange={(busy) => changeThreadBusy(thread.id, busy)}
              sessionId={thread.sessionId}
              onSessionsChange={onSessionsChange}
              onSessionCreated={registerThreadSession}
              onNewThread={startNewThread}
              onOpenThread={openThread}
              onRefreshSessions={() => loadSessionPage()}
              companionComposer={companionComposer}
              composerContext={companionComposer && contextControls ? <div className="companion-chat-composer-context-fields">{contextControls}</div> : null}
              contextSummary={threadContextSummary}
              skills={skills}
              sessionOptions={sessions.map((session, index) => ({
                value: session.id,
                label: session.title || `Conversation ${sessions.length - index}`,
              }))}
              historyHasMore={historyHasMore}
              historyLoadingMore={historyLoadingMore}
              onLoadOlder={onLoadOlder}
            />
          </div>;
        })}
      </div>
    </div>
  );
}

export function App() {
  const invitationActive = window.location.pathname === "/invite";
  const [invitationVerified] = useState(() => window.location.pathname === "/invite"
    && new URLSearchParams(window.location.search).get("verified") === "1");
  const [invitationToken] = useState(() => window.location.pathname === "/invite"
    ? new URLSearchParams(window.location.search).get("token") ?? ""
    : "");
  const [invitationContext, setInvitationContext] = useState(null);
  const [invitationPreparing, setInvitationPreparing] = useState(invitationActive);
  const [invitationAcceptable, setInvitationAcceptable] = useState(false);
  const [invitationError, setInvitationError] = useState("");
  const [session, setSession] = useState(null);
  const [customerSession, setCustomerSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [activeNav, setActiveNav] = useState(navFromLocation);
  const [workspaceSection, setWorkspaceSection] = useState(workspaceSectionFromLocation);
  const [workspace, setWorkspace] = useState(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => readPreference(workspacePreferenceKey));
  const [workspaceState, setWorkspaceState] = useState("loading");
  const [homeWorkspaces, setHomeWorkspaces] = useState([]);
  const [homeWorkspacesLoading, setHomeWorkspacesLoading] = useState(true);
  const [sites, setSites] = useState([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState("");
  const [siteBusyId, setSiteBusyId] = useState("");
  const [reviewedSkills, setReviewedSkills] = useState([]);
  const [workspaceActionId, setWorkspaceActionId] = useState("");
  const [apiError, setApiError] = useState("");
  const [schedules, setSchedules] = useState([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [scheduleBusyId, setScheduleBusyId] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [accountSecurityOpen, setAccountSecurityOpen] = useState(accountSecurityOpenFromLocation);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [operation, setOperation] = useState(null);
  const [operationHistory, setOperationHistory] = useState([]);
  const [operationAudit, setOperationAudit] = useState(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState(null);
  const [approvalRequestState, setApprovalRequestState] = useState("idle");
  const [approvalRequestMessage, setApprovalRequestMessage] = useState("");
  const [approvalReload, setApprovalReload] = useState(0);
  const [mcpConnections, setMcpConnections] = useState([]);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionBusy, setConnectionBusy] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [connectionCatalogRefresh, setConnectionCatalogRefresh] = useState(0);
  const [connectorDialogOpen, setConnectorDialogOpen] = useState(false);
  const [telegramConnection, setTelegramConnection] = useState(null);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramError, setTelegramError] = useState("");
  const [credentials, setCredentials] = useState([]);
  const [credentialsLoading, setCredentialsLoading] = useState(false);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const [credentialsError, setCredentialsError] = useState("");
  const [providerSettings, setProviderSettings] = useState([]);
  const [providerSettingsLoading, setProviderSettingsLoading] = useState(false);
  const [providerSettingsBusy, setProviderSettingsBusy] = useState(false);
  const [providerSettingsError, setProviderSettingsError] = useState("");
  const [connectionsView, setConnectionsView] = useState("list");
  const [settingsView, setSettingsView] = useState(settingsViewFromLocation);
  const [chatSessions, setChatSessions] = useState([]);
  const [aiControlPlaneView, setAiControlPlaneView] = useState(aiControlPlaneViewFromLocation);
  const [activeChatSessionId, setActiveChatSessionId] = useState(chatSessionFromLocation);
  const [chatAgentPreferences, setChatAgentPreferences] = useState({});
  const [chatHistoryHasMore, setChatHistoryHasMore] = useState(false);
  const [chatHistoryLoadingMore, setChatHistoryLoadingMore] = useState(false);
  const [chatHistoryLoadRequest, setChatHistoryLoadRequest] = useState(0);
  const [newChatRequest, setNewChatRequest] = useState(0);
  const [runningChatSessionIds, setRunningChatSessionIds] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminDelegableBuiltInRoles, setAdminDelegableBuiltInRoles] = useState([]);
  const [adminInvitations, setAdminInvitations] = useState([]);
  const [adminInvitationBusy, setAdminInvitationBusy] = useState(false);
  const [adminTeams, setAdminTeams] = useState([]);
  const [adminTeamsLoading, setAdminTeamsLoading] = useState(false);
  const [adminTeamsBusy, setAdminTeamsBusy] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminBusyUserId, setAdminBusyUserId] = useState("");
  const [adminWorkspaceMembers, setAdminWorkspaceMembers] = useState([]);
  const [adminWorkspaceError, setAdminWorkspaceError] = useState("");
  const [adminWorkspaceBusyId, setAdminWorkspaceBusyId] = useState("");
  const [egressVersions, setEgressVersions] = useState([]);
  const [egressSaving, setEgressSaving] = useState(false);
  const [mcpPolicy, setMcpPolicy] = useState(null);
  const [mcpPolicyLoading, setMcpPolicyLoading] = useState(false);
  const [mcpPolicySaving, setMcpPolicySaving] = useState(false);
  const [connectorEffectivePolicy, setConnectorEffectivePolicy] = useState(null);
  const [connectorEffectivePolicyLoading, setConnectorEffectivePolicyLoading] = useState(false);
  const [connectorEffectivePolicyError, setConnectorEffectivePolicyError] = useState("");
  const [connectorEffectivePolicyRefresh, setConnectorEffectivePolicyRefresh] = useState(0);
  const [sandboxSettings, setSandboxSettings] = useState(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxSaving, setSandboxSaving] = useState(false);
  const [sandboxCreateOpen, setSandboxCreateOpen] = useState(false);
  const [selectedSandboxGrantId, setSelectedSandboxGrantId] = useState(null);
  const [sandboxError, setSandboxError] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [revisionPromptOpen, setRevisionPromptOpen] = useState(false);
  const [revisionSaving, setRevisionSaving] = useState(false);
  const surfacedApprovalIds = useRef(new Set());
  const invitationInitializationStarted = useRef(false);
  const mainContentRef = useRef(null);
  const sidebarRef = useRef(null);
  const profileRef = useRef(null);
  const profilePopoverRefs = useMemo(() => [profileRef], []);
  const hasCapability = (permission) => Boolean(session?.capabilities?.includes(permission));
  const hasScopedCapability = (permission, type, resourceId) => hasCapability(permission)
    || Boolean(session?.resourceCapabilities?.some((grant) => grant.permission === permission
      && grant.scope?.type === type && grant.scope?.resourceId === resourceId));
  const hasAnyCapability = (permission) => hasCapability(permission)
    || Boolean(session?.resourceCapabilities?.some((grant) => grant.permission === permission));
  const canManageMembers = hasCapability("organization.manage_members");
  const canManageRoles = hasCapability("organization.manage_roles");
  const canManageSettings = hasCapability("organization.manage_settings");
  const canManagePolicy = hasCapability("policy.manage");
  const canManageAnyWorkspace = hasAnyCapability("workspace.manage");
  const canManageAnyProvider = hasAnyCapability("provider.manage");
  const canReadUsage = hasCapability("usage.read");
  const canManageUsage = hasCapability("usage.manage");
  const canOpenAiControlPlane = canReadUsage || canManageUsage || canManageAnyProvider || canManagePolicy;
  const availableAiControlPlaneTabs = aiControlPlaneTabs.filter((tab) => ({
    overview: canReadUsage,
    "models-providers": canManageAnyProvider,
    "model-routes": canManagePolicy || hasCapability("provider.manage"),
    pricing: canReadUsage || canManageUsage,
    "teams-budgets": canManageUsage,
    "data-health": canReadUsage || canManageUsage,
  }[tab.id]));

  useDismissOnOutside(profileOpen, () => setProfileOpen(false), profilePopoverRefs);

  const requestConfirmation = (options) => new Promise((resolve) => {
    setConfirmation({ ...options, resolve });
  });

  const settleConfirmation = (accepted) => {
    const pending = confirmation;
    setConfirmation(null);
    pending?.resolve(accepted);
  };

  const refreshAuthentication = useCallback(async (acceptPendingInvitation = false) => {
    setAuthLoading(true);
    let pendingInvitationError = "";
    try {
      if (acceptPendingInvitation) {
        try {
          const accepted = await authApi.acceptInvitation();
          setInvitationError("");
          setToast(invitationVerified
            ? `Email verified. You joined ${accepted.organization.displayName}.`
            : `You joined ${accepted.organization.displayName}.`);
        } catch (acceptError) {
          if (acceptError.code !== "UNAUTHENTICATED") {
            pendingInvitationError = acceptError.message ?? "This invitation could not be accepted.";
            setInvitationError(pendingInvitationError);
          }
        }
      }
      const value = await authApi.session();
      setSession(value);
      setCustomerSession(null);
      setAuthError(pendingInvitationError);
    } catch (sessionError) {
      setSession(null);
      if (!["UNAUTHENTICATED", "ACTIVE_MEMBERSHIP_REQUIRED"].includes(sessionError.code)) {
        setAuthError(sessionError.message);
        setCustomerSession(null);
        return;
      }
      try {
        const product = await authApi.productSession();
        setCustomerSession(product);
        setAuthError(pendingInvitationError);
      } catch (productError) {
        setCustomerSession(null);
        if (!["UNAUTHENTICATED", "AUTH_PROVIDER_NOT_AVAILABLE"].includes(productError.code)) {
          setAuthError(productError.message);
          return;
        }
        if (productError.code === "UNAUTHENTICATED") {
          const identity = await authApi.customerIdentitySession().catch(() => null);
          if (identity?.user?.emailVerified === false) {
            setCustomerSession({ status: "verification-required", user: identity.user });
            setAuthError("");
          }
        }
      }
    } finally {
      setAuthLoading(false);
    }
  }, [invitationVerified]);

  useEffect(() => {
    if (invitationInitializationStarted.current) return;
    invitationInitializationStarted.current = true;
    const params = new URLSearchParams(window.location.search);
    let callbackError = "";
    if (params.get("signin") === "error") {
      const reason = params.get("reason") ?? "OIDC_FAILED";
      const socialError = reason === "SOCIAL_LINK_FAILED"
        ? socialLinkErrorMessage(params.get("provider"))
        : socialSignInErrorMessage(params.get("error"), params.get("provider"));
      callbackError = socialError ?? signInErrorByReason[reason] ?? "Microsoft could not verify this sign-in. Please try again.";
    } else if (window.location.pathname === "/invite" && params.has("error")) {
      callbackError = "Your organization’s identity provider could not complete sign-in. Ask an administrator to test the Company SSO connection, then try this invitation again.";
    }
    const initializeAuthentication = async () => {
      let shouldAcceptInvitation = false;
      if (invitationToken) {
        window.history.replaceState(window.history.state, "", "/invite");
        try {
          const prepared = await authApi.prepareInvitation(invitationToken);
          setInvitationContext(prepared);
          setInvitationError("");
          shouldAcceptInvitation = true;
          setInvitationAcceptable(true);
        } catch (prepareError) {
          setInvitationError(prepareError.message ?? "This invitation cannot be used to sign in.");
          setInvitationAcceptable(false);
        } finally {
          setInvitationPreparing(false);
        }
      } else if (invitationActive) {
        try {
          const restored = await authApi.invitationContext();
          setInvitationContext(restored);
          setInvitationError("");
          shouldAcceptInvitation = true;
          setInvitationAcceptable(true);
        } catch (contextError) {
          setInvitationError(contextError.message ?? "This invitation cannot be used to sign in.");
          setInvitationAcceptable(false);
        } finally {
          window.history.replaceState(window.history.state, "", "/invite");
          setInvitationPreparing(false);
        }
      }
      await refreshAuthentication(shouldAcceptInvitation);
      if (callbackError) setAuthError(callbackError);
    };
    void initializeAuthentication();
  }, [invitationToken, refreshAuthentication]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const onPopState = () => {
      const name = navFromLocation();
      setActiveNav(name);
      setWorkspaceSection(workspaceSectionFromLocation());
      setActiveChatSessionId(chatSessionFromLocation());
      setAiControlPlaneView(aiControlPlaneViewFromLocation());
      if (name === "Connections") {
        setConnectionsView("list");
        setConnectionCatalogRefresh((current) => current + 1);
      }
      if (name === "Settings") {
        const nextSettingsView = settingsViewFromLocation();
        setSettingsView(nextSettingsView);
        setAccountSecurityOpen(nextSettingsView === "security");
      } else {
        setAccountSecurityOpen(false);
      }
      if (name === "Sites") { setActiveSite(null); setSitePreview(null); setSitesError(""); }
      if (name === "Workspace") {
        setSelectedSandboxGrantId(null);
        setSandboxSettings(null);
      }
      setMobileNavOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!session || activeNav !== "Workspace") return;
    const allowed = workspaceSection === "mine"
      || workspaceSection === "organization" && canManageAnyWorkspace
      || workspaceSection === "policies" && canManagePolicy;
    if (allowed) return;
    setWorkspaceSection("mine");
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.delete("section");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }, [session, activeNav, workspaceSection, canManageAnyWorkspace, canManagePolicy]);

  useEffect(() => {
    if (activeNav !== "Chat" || !activeChatSessionId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") === "chat" && url.searchParams.get("chat") === activeChatSessionId) return;
    url.searchParams.set("view", "chat");
    url.searchParams.set("chat", activeChatSessionId);
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }, [activeNav, activeChatSessionId]);

  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const previouslyFocused = document.activeElement;
    const sidebar = sidebarRef.current;
    sidebar?.querySelector(".nav-button")?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileNavOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...(sidebar?.querySelectorAll("a[href], button:not([disabled])") ?? [])];
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0].focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [mobileNavOpen]);

  const applyWorkspace = (next) => {
    setWorkspace(next);
    setWorkspaceState(next?.state ?? "not_created");
    setApiError("");
  };

  const selectActiveWorkspace = (workspaceId) => {
    const next = homeWorkspaces.find((item) => item.id === workspaceId);
    if (!next || next.id === workspace?.id) return;
    applyWorkspace(next);
    setActiveWorkspaceId(next.id);
    writePreference(workspacePreferenceKey, next.id);
    setChatSessions([]);
    setChatHistoryHasMore(false);
    setActiveChatSessionId("");
    const url = new URL(window.location.href);
    url.searchParams.delete("chat");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  };

  const updateWorkspaceInventory = (next) => {
    if (!next) return;
    setHomeWorkspaces((current) => replaceWorkspaceInInventory(current, next));
    if (next.id === workspace?.id) applyWorkspace(next);
  };

  const saveChatAgentPreference = (workspaceId, agentId) => {
    if (!workspaceId || !agentId) return;
    writePreference(chatAgentPreferenceKey(workspaceId), agentId);
    setChatAgentPreferences((current) => ({ ...current, [workspaceId]: agentId }));
  };

  const showApiError = (error) => {
    setApiError(error.message);
    setToast("");
  };

  useEffect(() => {
    if (!session) return;
    Promise.all([
      workspaceApi.current().catch((error) => {
        if (error.code === "WORKSPACE_NOT_FOUND") return null;
        throw error;
      }),
      workspaceApi.list(),
    ])
      .then(([current, value]) => {
        const workspaces = value.workspaces;
        const selected = workspaces.find((item) => item.id === activeWorkspaceId)
          ?? current
          ?? workspaces[0]
          ?? null;
        setHomeWorkspaces((current) => reconcileWorkspaceInventory(current, workspaces));
        applyWorkspace(selected);
        setActiveWorkspaceId(selected?.id ?? "");
        writePreference(workspacePreferenceKey, selected?.id ?? "");
      })
      .catch((error) => { setWorkspaceState("failed"); showApiError(error); })
      .finally(() => setHomeWorkspacesLoading(false));
    operationApi.recent().then(setOperation).catch(showApiError);
    operationApi.list().then((value) => setOperationHistory(value.operations)).catch(showApiError);
    skillApi.list().then((value) => setReviewedSkills(value.skills)).catch(() => setReviewedSkills([]));
    connectionApi.credentials()
      .then((value) => setCredentials(value.credentials))
      .catch((error) => setCredentialsError(error.message));
  }, [session?.user.id]);

  useEffect(() => {
    if (!session || activeNav !== "Connections") return undefined;
    const controller = new AbortController();
    let active = true;
    setConnectionLoading(true);
    setConnectionError("");
    const refresh = async () => {
      const value = await connectionApi.catalog({ signal: controller.signal });
      let connections = value.connections;
      if (connectionsView.startsWith("microsoft365-")) {
        const status = await connectionApi.status("microsoft-365", { signal: controller.signal });
        connections = connections.map((connector) => (
          connector.id === "microsoft-365" ? { ...connector, ...status } : connector
        ));
      }
      return connections;
    };
    refresh()
      .then((connections) => {
        if (!active) return;
        setMcpConnections(connections);
        setConnectionError("");
      })
      .catch((error) => {
        if (!active || error?.name === "AbortError") return;
        setConnectionError(error.message);
      })
      .finally(() => {
        if (active) setConnectionLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeNav, connectionsView, connectionCatalogRefresh, session?.user.id]);

  useEffect(() => {
    if (!session || activeNav !== "Settings" || settingsView !== "credentials") return;
    setCredentialsLoading(true);
    connectionApi.credentials()
      .then((value) => { setCredentials(value.credentials); setCredentialsError(""); })
      .catch((error) => setCredentialsError(error.message))
      .finally(() => setCredentialsLoading(false));
  }, [activeNav, settingsView, session?.user.id]);

  useEffect(() => {
    const providerPageOpen = activeNav === "AI control plane" && aiControlPlaneView === "models-providers";
    if (!session || !providerPageOpen || !canManageAnyProvider) return undefined;
    let active = true;
    setProviderSettingsLoading(true);
    adminApi.providerSettings()
      .then((value) => { if (active) { setProviderSettings(value.providers); setProviderSettingsError(""); } })
      .catch((error) => { if (active) setProviderSettingsError(error.message); })
      .finally(() => { if (active) setProviderSettingsLoading(false); });
    return () => { active = false; };
  }, [activeNav, aiControlPlaneView, settingsView, session?.user.id, canManageAnyProvider]);

  useEffect(() => {
    if (!session || activeNav !== "Sites") return undefined;
    let active = true;
    setSitesLoading(true);
    siteApi.list()
      .then((value) => { if (active) { setSites(value.sites); setSitesError(""); } })
      .catch((error) => { if (active) setSitesError(error.message); })
      .finally(() => { if (active) setSitesLoading(false); });
    return () => { active = false; };
  }, [activeNav, session?.user.id]);

  useEffect(() => {
    if (!session || activeNav !== "Schedules") return undefined;
    let active = true;
    const refresh = () => {
      setSchedulesLoading(true);
      return scheduleApi.list()
        .then((value) => {
          if (!active) return;
          setSchedules(value.schedules);
          setScheduleError("");
        })
        .catch((error) => { if (active) setScheduleError(error.message); })
        .finally(() => { if (active) setSchedulesLoading(false); });
    };
    void refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [activeNav, session?.user.id]);

  useEffect(() => {
    if (!session) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "connections") return;
    const legacyResult = params.get("m365");
    const connectorId = legacyResult ? "microsoft-365" : params.get("connector");
    const result = legacyResult ?? params.get("connection");
    if (!connectorId || !result) return;
    setActiveNav("Connections");
    setConnectionsView(connectorId === "microsoft-365" ? "microsoft365-overview" : `connector-${connectorId}`);
    if (result === "connected") {
      const connectorName = mcpConnections.find((connector) => connector.id === connectorId)?.name ?? "The service";
      setToast(`${connectorName} is connected.`);
      setConnectionCatalogRefresh((current) => current + 1);
    } else if (result === "error") {
      const reason = params.get("reason");
      setConnectionError(connectionReason[reason] ?? "The provider could not complete the connection. Please try again.");
    }
    params.delete("m365");
    params.delete("connector");
    params.delete("connection");
    params.delete("reason");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [session?.user.id]);

  useEffect(() => {
    const allowed = activeNav === "Firewall" ? canManagePolicy : activeNav === "AI control plane" ? canOpenAiControlPlane : true;
    if (!session || allowed || !["Firewall", "AI control plane"].includes(activeNav)) return;
    setActiveNav("Workspace");
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.delete("section");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }, [activeNav, session?.user.id, canManagePolicy, canOpenAiControlPlane]);

  useEffect(() => {
    if (activeNav !== "AI control plane" || !canOpenAiControlPlane) return;
    const allowed = aiControlPlaneView === "spend"
      ? canReadUsage
      : availableAiControlPlaneTabs.some((tab) => tab.id === aiControlPlaneView);
    if (allowed) return;
    const fallback = availableAiControlPlaneTabs[0]?.id;
    if (fallback) setAiControlPlaneView(fallback);
  }, [activeNav, aiControlPlaneView, canOpenAiControlPlane, canReadUsage, availableAiControlPlaneTabs]);

  useEffect(() => {
    const peopleOpen = activeNav === "Settings" && settingsView === "admin";
    const organizationWorkspacesOpen = activeNav === "Workspace" && workspaceSection === "organization";
    const workspacePoliciesOpen = activeNav === "Workspace" && workspaceSection === "policies";
    const teamsOpen = activeNav === "AI control plane" && aiControlPlaneView === "teams-budgets";
    const workspaceAdminOpen = peopleOpen || organizationWorkspacesOpen || workspacePoliciesOpen;
    if ((!workspaceAdminOpen && !teamsOpen)
      || peopleOpen && !canManageMembers && !canManageRoles && !canManageSettings
      || organizationWorkspacesOpen && !canManageAnyWorkspace
      || workspacePoliciesOpen && !canManagePolicy
      || teamsOpen && !canManageUsage) return;
    if (workspaceAdminOpen) setAdminLoading(true);
    if (teamsOpen) setAdminTeamsLoading(true);
    Promise.all([
      (peopleOpen || workspacePoliciesOpen || teamsOpen) && canManageMembers ? adminApi.users() : Promise.resolve({ users: [] }),
      peopleOpen && canManageMembers ? adminApi.invitations() : Promise.resolve(null),
      organizationWorkspacesOpen && canManageAnyWorkspace
        ? adminApi.memberWorkspaces()
          .then((value) => ({ ...value, error: null }))
          .catch((error) => ({ members: [], error }))
        : Promise.resolve(null),
      teamsOpen ? adminApi.teams(true) : Promise.resolve(null),
    ])
      .then(([users, invitations, memberWorkspaces, teams]) => {
        setAdminUsers(users.users);
        setAdminDelegableBuiltInRoles(users.delegableBuiltInRoles ?? []);
        if (invitations) setAdminInvitations(invitations.invitations);
        if (memberWorkspaces) {
          setAdminWorkspaceMembers(memberWorkspaces.members);
          setAdminWorkspaceError(memberWorkspaces.error?.message ?? "");
        }
        if (teams) setAdminTeams(teams.teams);
      })
      .catch(showApiError)
      .finally(() => {
        if (workspaceAdminOpen) setAdminLoading(false);
        if (teamsOpen) setAdminTeamsLoading(false);
      });
  }, [activeNav, aiControlPlaneView, settingsView, workspaceSection, session?.user.id, canManageMembers, canManageRoles, canManageSettings, canManagePolicy, canManageAnyWorkspace, canManageUsage]);

  useEffect(() => {
    if (activeNav !== "Firewall" || !canManagePolicy) return;
    setAdminLoading(true);
    adminApi.egressSecurityGroups()
      .then((egress) => setEgressVersions(egress.securityGroups))
      .catch(showApiError)
      .finally(() => setAdminLoading(false));
  }, [activeNav, session?.user.id, canManagePolicy]);

  useEffect(() => {
    if (activeNav !== "Connections" || !connectionsView.endsWith("-tools")) return;
    const hosted = mcpConnections.find((connector) => connectionsView === `connector-${connector.id}-tools`);
    if (connectionsView === "microsoft365-tools" ? !canManagePolicy : !hosted?.canAdministerConnector) return;
    setMcpPolicyLoading(true);
    (connectionsView === "microsoft365-tools"
      ? adminApi.mcpPolicy()
      : hosted
        ? adminApi.connectorToolPolicy(hosted.id)
        : Promise.reject(new Error("That connector is unavailable.")))
      .then(setMcpPolicy)
      .catch(showApiError)
      .finally(() => setMcpPolicyLoading(false));
  }, [activeNav, connectionsView, session?.user.id, mcpConnections, canManagePolicy]);

  useEffect(() => {
    if (activeNav !== "Connections" || connectionsView === "list") {
      setConnectorEffectivePolicy(null);
      setConnectorEffectivePolicyError("");
      setConnectorEffectivePolicyLoading(false);
      return;
    }
    const selected = mcpConnections.find((connector) => (
      connector.id === "microsoft-365"
        ? connectionsView.startsWith("microsoft365-")
        : connectionsView === `connector-${connector.id}` || connectionsView === `connector-${connector.id}-tools`
    ));
    if (!selected?.canAdministerConnector) {
      setConnectorEffectivePolicy(null);
      setConnectorEffectivePolicyError("");
      setConnectorEffectivePolicyLoading(false);
      return;
    }
    let cancelled = false;
    setConnectorEffectivePolicyLoading(true);
    setConnectorEffectivePolicyError("");
    adminApi.connectorEffectivePolicy(selected.id)
      .then((result) => {
        if (!cancelled) setConnectorEffectivePolicy(result.policy);
      })
      .catch((error) => {
        if (!cancelled) {
          setConnectorEffectivePolicy(null);
          setConnectorEffectivePolicyError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) setConnectorEffectivePolicyLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeNav, connectionsView, session?.user.id, connectorEffectivePolicyRefresh,
    mcpConnections.map((connector) => `${connector.id}:${connector.canAdministerConnector}:${connector.accessPolicyVersion}`).join("|")]);

  useEffect(() => {
    if (activeNav !== "Workspace" || !session || !selectedSandboxGrantId) return;
    const selectedWorkspace = homeWorkspaces.find((item) => item.grantId === selectedSandboxGrantId);
    setSandboxLoading(true);
    sandboxApi.settings(selectedSandboxGrantId)
      .then((value) => { setSandboxSettings(value); setSandboxError(""); })
      .catch((error) => setSandboxError(error.message))
      .finally(() => setSandboxLoading(false));
    if (selectedWorkspace) {
      setTelegramLoading(true);
      Promise.all([connectionApi.telegram(selectedWorkspace.id), connectionApi.credentials()])
        .then(([channel, savedCredentials]) => {
          setTelegramConnection(channel);
          setCredentials(savedCredentials.credentials);
          setTelegramError("");
        })
        .catch((error) => setTelegramError(error.message))
        .finally(() => setTelegramLoading(false));
    } else {
      setTelegramConnection(null);
      setTelegramError("");
      setTelegramLoading(false);
    }
  }, [activeNav, session?.user.id, selectedSandboxGrantId, homeWorkspaces.map((item) => `${item.id}:${item.grantId}`).join(",")]);

  useEffect(() => {
    if (!session || !workspace?.id) return undefined;
    const delay = ["provisioning", "restarting", "stopping"].includes(workspaceState)
      ? 2000
      : ["ready", "open"].includes(workspaceState)
        ? 10000
        : null;
    if (!delay) return undefined;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const value = await workspaceApi.list();
        if (!active) return;
        setHomeWorkspaces((current) => reconcileWorkspaceInventory(current, value.workspaces));
        const refreshed = value.workspaces.find((item) => item.id === workspace.id);
        if (refreshed) applyWorkspace(refreshed);
      } catch (error) {
        if (active) showApiError(error);
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(() => { void refresh(); }, delay);
    return () => { active = false; window.clearInterval(interval); };
  }, [session?.user.id, workspace?.id, workspaceState]);

  useEffect(() => {
    if (!operation || !["approved", "executing"].includes(operation.state)) return undefined;
    const interval = window.setInterval(() => operationApi.get(operation.id).then(setOperation).catch(showApiError), 1500);
    return () => window.clearInterval(interval);
  }, [operation?.id, operation?.state]);

  useEffect(() => {
    if (!session) return undefined;
    let active = true;
    const refreshRecentOperation = async () => {
      try {
        const recent = await operationApi.recent();
        if (!active || !recent) return;
        setOperation(recent);
        if (recent.state === "approval_required" && !surfacedApprovalIds.current.has(recent.id)) {
          const approvalContext = recent.requiredApprovalChannel === "openvtc-task-consent"
            ? await getApprovalDeviceContext()
            : null;
          if (!active) return;
          surfacedApprovalIds.current.add(recent.id);
          if (!approvalContext || approvalContext.localReady || !approvalContext.accountStatus.connected) {
            setDrawer("request");
            setToast("An agent action is waiting for your approval.");
          } else {
            setToast(`Approval sent to ${approvalContext.accountStatus.approver.displayName}.`);
          }
        }
      } catch (error) {
        if (active) showApiError(error);
      }
    };
    const interval = window.setInterval(refreshRecentOperation, 1500);
    return () => { active = false; window.clearInterval(interval); };
  }, [session?.user.id]);

  useEffect(() => {
    if (!operation) return;
    setOperationHistory((items) => [operation, ...items.filter((item) => item.id !== operation.id)]);
  }, [operation?.id, operation?.state, operation?.updatedAt]);

  useEffect(() => {
    if (drawer !== "request" || !operation) { setOperationAudit(null); return; }
    operationApi.audit(operation.id).then(setOperationAudit).catch(showApiError);
  }, [drawer, operation?.id, operation?.state]);

  useEffect(() => {
    if (drawer !== "request" || operation?.state !== "approval_required"
      || operation.requiredApprovalChannel !== "openvtc-task-consent") {
      setApprovalRequest(null);
      setApprovalRequestState("idle");
      setApprovalRequestMessage("");
      return undefined;
    }
    let active = true;
    setApprovalRequest(null);
    setApprovalRequestState("loading");
    setApprovalRequestMessage("");
    getApprovalDeviceContext()
      .then(async ({ accountStatus, local, localStatus, localReady }) => {
        if (!localReady) {
          if (active) {
            setApprovalRequestState(accountStatus.connected ? "remote" : "setup");
            setApprovalRequestMessage(accountStatus.connected
              ? `${accountStatus.approver.displayName} is ready on another device. Open the Approval Companion there to approve or deny this request.`
              : "Set up this browser as your approval device before deciding this operation.");
          }
          return;
        }
        const request = await loadPendingApproval(() => approvalApi.pending(local.did), localStatus.executorDid);
        if (!active) return;
        setApprovalRequest(request);
        setApprovalRequestState(request ? "ready" : "empty");
        setApprovalRequestMessage(request ? "Signed request verified. One device confirmation will approve or deny it." : "No live signed approval request is available.");
      })
      .catch((error) => {
        if (!active) return;
        setApprovalRequestState("error");
        setApprovalRequestMessage(error.message);
      });
    return () => { active = false; };
  }, [drawer, operation?.id, operation?.state, operation?.requiredApprovalChannel, approvalReload]);

  const createWorkspace = async (grantId = "personal") => {
    if (grantId === workspace?.grantId) setWorkspaceState("provisioning");
    setApiError("");
    try {
      const created = await workspaceApi.create(grantId);
      updateWorkspaceInventory(created);
      setToast(`${workspaceName(created)} is being prepared.`);
      return created;
    } catch (error) {
      if (grantId === workspace?.grantId) setWorkspaceState("failed");
      showApiError(error);
      return null;
    }
  };

  const restartWorkspace = async (targetWorkspace = workspace) => {
    if (!targetWorkspace) return createWorkspace();
    if (targetWorkspace.id === workspace?.id) setWorkspaceState("restarting");
    setWorkspaceActionId(targetWorkspace.id);
    setApiError("");
    try {
      updateWorkspaceInventory(await workspaceApi.restart(targetWorkspace.id));
      setToast(`${workspaceName(targetWorkspace)} is restarting.`);
    } catch (error) {
      if (targetWorkspace.id === workspace?.id) setWorkspaceState(targetWorkspace.state);
      showApiError(error);
    } finally {
      setWorkspaceActionId("");
    }
  };

  const openWorkspace = async (targetWorkspace = workspace) => {
    if (!targetWorkspace || ["not_created", "stopped", "failed"].includes(targetWorkspace.state)) {
      return createWorkspace(targetWorkspace?.grantId ?? "personal");
    }
    const sessionWindow = window.open("about:blank", "lemmacomputer-workspace");
    setWorkspaceActionId(targetWorkspace.id);
    try {
      const result = await workspaceApi.open(targetWorkspace.id);
      updateWorkspaceInventory(result.workspace);
      const clipboardStatus = clipboardStatusForBrowser(result.launch.clipboard);
      if (sessionWindow) sessionWindow.location.replace(result.launch.launchUrl);
      else window.location.assign(result.launch.launchUrl);
      setToast(clipboardStatus.message);
    } catch (error) {
      sessionWindow?.close();
      showApiError(error);
    } finally {
      setWorkspaceActionId("");
    }
  };

  const stopWorkspace = async (targetWorkspace = workspace) => {
    if (!targetWorkspace) return;
    if (targetWorkspace.id === workspace?.id) setWorkspaceState("stopping");
    setWorkspaceActionId(targetWorkspace.id);
    try {
      updateWorkspaceInventory(await workspaceApi.stop(targetWorkspace.id));
      setToast(`${workspaceName(targetWorkspace)} has stopped.`);
    } catch (error) {
      try {
        const value = await workspaceApi.list();
        setHomeWorkspaces(value.workspaces);
        const refreshed = value.workspaces.find((item) => item.id === targetWorkspace.id);
        if (refreshed) applyWorkspace(refreshed);
      } catch {
        if (targetWorkspace.id === workspace?.id) setWorkspaceState(targetWorkspace.state);
      }
      showApiError(error);
    } finally {
      setWorkspaceActionId("");
    }
  };

  const deleteWorkspace = async (targetWorkspace = workspace) => {
    if (!targetWorkspace || !await requestConfirmation({
      title: "Delete this workspace record?",
      description: "The stopped workspace record and its retained home storage will be removed. You can create a new workspace later.",
      confirmLabel: "Delete workspace",
      danger: true,
    })) return;
    try {
      await workspaceApi.delete(targetWorkspace.id);
      const remaining = homeWorkspaces.filter((item) => item.id !== targetWorkspace.id);
      setHomeWorkspaces(remaining);
      if (targetWorkspace.id === workspace?.id) {
        const fallback = remaining.find((item) => item.grantId === "personal") ?? remaining[0] ?? null;
        applyWorkspace(fallback);
        setActiveWorkspaceId(fallback?.id ?? "");
        writePreference(workspacePreferenceKey, fallback?.id ?? "");
        setChatSessions([]);
        setChatHistoryHasMore(false);
        setActiveChatSessionId("");
      }
      setToast(`${workspaceName(targetWorkspace)} deleted.`);
    } catch (error) {
      showApiError(error);
    }
  };

  const createGovernedOperation = async () => {
    if (!workspace) return;
    setOperationBusy(true);
    setApiError("");
    try {
      const created = await operationApi.createDeleteFile(workspace.id, "/Finance/2026/Q3-draft.docx");
      setOperation(created);
      setOperationHistory((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      setDrawer("request");
      setToast("Protected deletion request created. No tool has run yet.");
    } catch (error) {
      showApiError(error);
    } finally {
      setOperationBusy(false);
    }
  };

  const decideGovernedOperation = async (decision) => {
    if (!operation) return;
    setOperationBusy(true);
    setApiError("");
    try {
      const decided = await operationApi.decideWithFixture(operation.id, decision);
      setOperation(decided);
      setToast(decision === "approve" ? "Approved operation executed once through the governed gateway." : "The protected operation was denied.");
    } catch (error) {
      showApiError(error);
      operationApi.get(operation.id).then(setOperation).catch(() => undefined);
    } finally {
      setOperationBusy(false);
    }
  };

  const decideWithApprovalDevice = async (decision) => {
    if (!approvalRequest) return;
    setOperationBusy(true);
    setApprovalRequestMessage("");
    try {
      const signed = await signApprovalDecision(approvalRequest, decision);
      const response = await approvalApi.decide(signed.transportToken, signed.document);
      setOperation(response.operation);
      setApprovalRequest(null);
      setApprovalRequestState("idle");
      setToast(decision === "approve" ? "Approved. The bound operation was released once." : "Denied. No connector action was released.");
    } catch (error) {
      setApprovalRequestMessage(error.name === "NotAllowedError" ? "Device verification was cancelled." : error.message);
      operationApi.get(operation.id).then(setOperation).catch(() => undefined);
    } finally {
      setOperationBusy(false);
    }
  };

  const connectMcpConnector = (connectorId) => {
    setConnectionBusy(connectorId);
    setConnectionError("");
    window.location.assign(connectionApi.authorizeUrl(connectorId));
  };

  const disconnectMcpConnector = async (connector) => {
    if (!await requestConfirmation({
      title: `Disconnect ${connector.name}?`,
      description: `LemmaComputer will revoke this connection. Your ${connector.name} account and provider data will not be deleted.`,
      confirmLabel: "Disconnect",
      danger: true,
    })) return;
    setConnectionBusy(connector.id);
    setConnectionError("");
    try {
      const status = await connectionApi.disconnect(connector.id);
      setMcpConnections((current) => current.map((item) => item.id === connector.id ? { ...item, ...status } : item));
      setToast(`${connector.name} was disconnected.`);
    } catch (error) {
      setConnectionError(error.message);
    } finally {
      setConnectionBusy("");
    }
  };

  const saveConnectorIcon = async (connectorId, iconDataUrl) => {
    setConnectionBusy(connectorId);
    setConnectionError("");
    try {
      const result = await adminApi.saveConnectorIcon(connectorId, iconDataUrl);
      setMcpConnections((current) => current.map((item) => item.id === connectorId ? { ...item, ...result.connector } : item));
      setToast(iconDataUrl ? "Connector icon updated." : "Connector icon removed.");
      return result.connector;
    } catch (error) {
      setConnectionError(error.message);
      throw error;
    } finally {
      setConnectionBusy("");
    }
  };

  const saveConnectorAccessPolicy = async (connectorId, policy) => {
    setConnectionBusy(connectorId);
    setConnectionError("");
    try {
      const result = await adminApi.saveConnectorAccessPolicy(connectorId, policy);
      const catalog = await connectionApi.catalog();
      setMcpConnections(catalog.connections);
      setConnectorEffectivePolicyRefresh((current) => current + 1);
      const failures = result.workspaceGrants?.failed ?? 0;
      setToast(failures
        ? `Connector access policy saved. ${failures} workspace grant refreshes failed; those connector tools remain unavailable until a refresh succeeds.`
        : "Connector access policy is active for the organization.");
      return result.connector;
    } catch (error) {
      setConnectionError(error.message);
      throw error;
    } finally {
      setConnectionBusy("");
    }
  };

  const retryConnectorPolicyDelivery = async (connectorId) => {
    setConnectionBusy(connectorId);
    setConnectionError("");
    try {
      const result = await adminApi.retryConnectorPolicyDelivery(connectorId);
      setConnectorEffectivePolicyRefresh((current) => current + 1);
      const failures = result.workspaceGrants?.failed ?? 0;
      const refreshed = result.workspaceGrants?.refreshed ?? 0;
      setToast(failures
        ? `Delivery retried. ${refreshed} workspace ${refreshed === 1 ? "grant was" : "grants were"} refreshed; ${failures} still need attention.`
        : `Connector policy delivered to ${refreshed} running ${refreshed === 1 ? "workspace" : "workspaces"}.`);
    } catch (error) {
      setConnectionError(error.message);
    } finally {
      setConnectionBusy("");
    }
  };

  const removeMcpConnector = async (connector) => {
    if (!await requestConfirmation({
      title: `Remove ${connector.name}?`,
      description: `This removes ${connector.name} from the organization and revokes everyone’s connection and workspace access. Provider accounts and data will not be deleted.`,
      confirmLabel: "Remove connector",
      danger: true,
    })) return;
    setConnectionBusy(connector.id);
    setConnectionError("");
    try {
      await adminApi.deleteConnector(connector.id);
      setMcpConnections((current) => current.filter((item) => item.id !== connector.id));
      setMcpPolicy((current) => current?.connectorId === connector.id ? null : current);
      setConnectionsView("list");
      setToast(`${connector.name} was removed from Connections.`);
    } catch (error) {
      setConnectionError(error.message);
    } finally {
      setConnectionBusy("");
    }
  };

  const connectorCreated = async (connector) => {
    const catalog = await connectionApi.catalog();
    setMcpConnections(catalog.connections);
    setConnectorDialogOpen(false);
    setToast(`${connector.name} was added to Connections.`);
  };

  const refreshWorkspaceManifest = async () => {
    if (!selectedSandboxGrantId) return;
    setSandboxSettings(await sandboxApi.settings(selectedSandboxGrantId));
  };

  const saveTelegram = async (configuration) => {
    const selectedWorkspace = homeWorkspaces.find((item) => item.grantId === selectedSandboxGrantId);
    if (!selectedWorkspace) return null;
    setTelegramBusy(true);
    setTelegramError("");
    try {
      const saved = await connectionApi.saveTelegram(selectedWorkspace.id, configuration);
      setTelegramConnection(saved);
      const refreshed = await connectionApi.credentials();
      setCredentials(refreshed.credentials);
      await refreshWorkspaceManifest();
      setToast(telegramConnection?.state === "connected" ? "Telegram routing updated." : "Telegram connected to this workspace.");
      return saved;
    } catch (error) {
      setTelegramError(error.message);
      return null;
    } finally {
      setTelegramBusy(false);
    }
  };

  const disconnectTelegram = async () => {
    const selectedWorkspace = homeWorkspaces.find((item) => item.grantId === selectedSandboxGrantId);
    if (!selectedWorkspace) return;
    if (!await requestConfirmation({
      title: "Disconnect Telegram?",
      description: "The channel broker will delete this workspace’s Telegram routing and conversation sessions. The credential remains available under Settings until you delete it.",
      confirmLabel: "Disconnect",
      danger: true,
    })) return;
    setTelegramBusy(true);
    setTelegramError("");
    try {
      await connectionApi.disconnectTelegram(selectedWorkspace.id);
      setTelegramConnection(await connectionApi.telegram(selectedWorkspace.id));
      const refreshed = await connectionApi.credentials();
      setCredentials(refreshed.credentials);
      await refreshWorkspaceManifest();
      setToast("Telegram was disconnected.");
    } catch (error) {
      setTelegramError(error.message);
    } finally {
      setTelegramBusy(false);
    }
  };

  const createTelegramCredential = async (botToken) => {
    setCredentialsBusy(true);
    setCredentialsError("");
    setTelegramError("");
    try {
      const created = await connectionApi.createTelegramCredential(botToken);
      setCredentials((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setToast("Telegram credential stored.");
      return created;
    } catch (error) {
      setCredentialsError(error.message);
      setTelegramError(error.message);
      return null;
    } finally {
      setCredentialsBusy(false);
    }
  };

  const rotateTelegramCredential = async (credentialId, botToken) => {
    setCredentialsBusy(true);
    setCredentialsError("");
    try {
      const saved = await connectionApi.rotateTelegramCredential(credentialId, botToken);
      setCredentials((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      if (telegramConnection?.credentialId === saved.id) {
        const selectedWorkspace = homeWorkspaces.find((item) => item.grantId === selectedSandboxGrantId);
        if (selectedWorkspace) {
          setTelegramConnection(await connectionApi.telegram(selectedWorkspace.id));
          await refreshWorkspaceManifest();
        }
      }
      setToast("Telegram credential rotated.");
      return saved;
    } catch (error) {
      setCredentialsError(error.message);
      return null;
    } finally {
      setCredentialsBusy(false);
    }
  };

  const deleteTelegramCredential = async (credential) => {
    if (!await requestConfirmation({
      title: "Delete Telegram credential?",
      description: credential.workspaceId
        ? "This also disconnects Telegram from its workspace and deletes its channel sessions. The bot itself remains in Telegram."
        : "The encrypted credential will be permanently removed from LemmaComputer.",
      confirmLabel: "Delete credential",
      danger: true,
    })) return;
    setCredentialsBusy(true);
    setCredentialsError("");
    try {
      await connectionApi.deleteCredential(credential.id);
      setCredentials((current) => current.filter((item) => item.id !== credential.id));
      if (telegramConnection?.credentialId === credential.id) {
        setTelegramConnection(null);
        await refreshWorkspaceManifest();
      }
      setToast("Telegram credential deleted.");
    } catch (error) {
      setCredentialsError(error.message);
    } finally {
      setCredentialsBusy(false);
    }
  };

  const updateProviderSetting = (provider) => {
    setProviderSettings((current) => {
      const existing = current.find((item) => item.provider === provider.provider);
      return existing
        ? current.map((item) => item.provider === provider.provider ? provider : item)
        : [...current, provider];
    });
  };

  const refreshProviderSettings = async () => {
    const value = await adminApi.providerSettings();
    setProviderSettings(value.providers);
    return value.providers;
  };

  const runProviderAction = async (action, onSuccess) => {
    setProviderSettingsBusy(true);
    setProviderSettingsError("");
    try {
      const result = await action();
      if (result.provider) updateProviderSetting(result.provider);
      onSuccess(result);
      return result;
    } catch (error) {
      setProviderSettingsError(error.message);
      return null;
    } finally {
      setProviderSettingsBusy(false);
    }
  };

  const saveProviderSetting = (provider, input) => runProviderAction(
    () => adminApi.saveProviderSetting(provider, input),
    () => setToast(providerTitle(provider) + " provider key saved."),
  );

  const testProviderSetting = (provider) => runProviderAction(
    () => adminApi.testProviderSetting(provider),
    () => setToast(providerTitle(provider) + " route passed its test."),
  );

  const disableProviderSetting = async (provider) => {
    if (!await requestConfirmation({
      title: "Disable " + providerTitle(provider) + "?",
      description: "The provider route will be removed and active workspace grants for that model will be revoked. Affected workspaces must restart before they can use it again.",
      confirmLabel: "Disable provider",
      danger: true,
    })) return null;
    return runProviderAction(
      () => adminApi.disableProviderSetting(provider),
      (result) => setToast(result.restartRequired
        ? "Provider disabled. Affected workspace access was revoked; restart those workspaces."
        : "Provider disabled."),
    );
  };

  const deleteProviderSetting = async (provider) => {
    if (!await requestConfirmation({
      title: "Delete " + providerTitle(provider) + " key?",
      description: "The encrypted LiteLLM credential and all routes for this provider will be removed. Active workspace grants for that model will be revoked.",
      confirmLabel: "Delete provider key",
      danger: true,
    })) return null;
    return runProviderAction(async () => {
      const result = await adminApi.deleteProviderSetting(provider);
      const providers = await refreshProviderSettings();
      return { ...result, provider: providers.find((item) => item.provider === provider) };
    }, (result) => setToast(result.restartRequired
      ? "Provider key deleted. Affected workspace access was revoked; restart those workspaces."
      : "Provider key deleted."));
  };

  const saveWorkspaceSettings = async (configuration) => {
    setSandboxSaving(true);
    setSandboxError("");
    try {
      const { securityGroupVersionId, ...sandboxConfiguration } = configuration;
      if (securityGroupVersionId && securityGroupVersionId !== sandboxSettings?.securityGroup?.id) {
        await adminApi.assignWorkspaceEgressSecurityGroup(configuration.grantId, securityGroupVersionId);
      }
      await sandboxApi.save(sandboxConfiguration);
      const creatingWorkspace = !homeWorkspaces.some((item) => item.grantId === configuration.grantId);
      if (creatingWorkspace) {
        const created = await workspaceApi.create(configuration.grantId);
        updateWorkspaceInventory(created);
        setSelectedSandboxGrantId(null);
        setSandboxSettings(null);
        setToast(`${workspaceName(created)} is being prepared with your configuration.`);
      } else {
        setSelectedSandboxGrantId(null);
        setSandboxSettings(null);
        setTelegramConnection(null);
        setTelegramError("");
        workspaceApi.list().then((value) => setHomeWorkspaces((current) => reconcileWorkspaceInventory(current, value.workspaces))).catch(() => undefined);
        setToast("Workspace configuration saved. Restart the workspace to apply changes.");
        window.requestAnimationFrame(() => mainContentRef.current?.focus());
      }
    } catch (error) {
      setSandboxError(error.message);
    } finally {
      setSandboxSaving(false);
    }
  };

  const assignWorkspaceSecurityGroup = async (grantId, securityGroupVersionId) => {
    setSandboxSaving(true);
    setSandboxError("");
    try {
      const assigned = await adminApi.assignWorkspaceEgressSecurityGroup(grantId, securityGroupVersionId);
      setSandboxSettings(await sandboxApi.settings(grantId));
      setToast(`${assigned.name} is now active. No workspace restart was needed.`);
    } catch (error) {
      setSandboxError(error.message);
      setSandboxSettings(await sandboxApi.settings(grantId).catch(() => sandboxSettings));
    } finally {
      setSandboxSaving(false);
    }
  };

  const selectNav = (name, historyMode = "push") => {
    setActiveNav(name);
    if (name === "Workspace") setWorkspaceSection("mine");
    const url = new URL(window.location.href);
    if (name === "Workspace") url.searchParams.delete("view");
    else url.searchParams.set("view", viewByNav[name]);
    if (name === "Chat" && activeChatSessionId) url.searchParams.set("chat", activeChatSessionId);
    else url.searchParams.delete("chat");
    url.searchParams.delete("section");
    const nextLocation = `${url.pathname}${url.search}`;
    if (historyMode === "replace") window.history.replaceState({}, "", nextLocation);
    else if (nextLocation !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState({}, "", nextLocation);
    }
    if (name === "Connections") {
      setConnectionsView("list");
      setConnectionCatalogRefresh((current) => current + 1);
    }
    if (name === "Settings") {
      setSettingsView("overview");
      setAccountSecurityOpen(false);
    }
    if (name === "Sites") setSitesError("");
    if (name === "Workspace") { setSelectedSandboxGrantId(null); setSandboxSettings(null); setSandboxError(""); }
    setProfileOpen(false);
    setMobileNavOpen(false);
    window.requestAnimationFrame(() => mainContentRef.current?.focus());
  };

  const selectWorkspaceSection = (section = "mine", historyMode = "push") => {
    const nextSection = workspaceSections.has(section) ? section : "mine";
    setActiveNav("Workspace");
    setWorkspaceSection(nextSection);
    setSelectedSandboxGrantId(null);
    setSandboxSettings(null);
    setSandboxError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("chat");
    if (nextSection === "mine") {
      url.searchParams.delete("view");
      url.searchParams.delete("section");
    } else {
      url.searchParams.set("view", "home");
      url.searchParams.set("section", nextSection);
    }
    const nextLocation = `${url.pathname}${url.search}`;
    if (historyMode === "replace") window.history.replaceState({}, "", nextLocation);
    else if (nextLocation !== `${window.location.pathname}${window.location.search}`) window.history.pushState({}, "", nextLocation);
    window.requestAnimationFrame(() => mainContentRef.current?.focus());
  };

  const selectSettingsView = (view = "overview", historyMode = "push") => {
    const nextView = settingsSectionByView[view] ? view : "overview";
    setActiveNav("Settings");
    setSettingsView(nextView);
    setAccountSecurityOpen(nextView === "security");
    const url = new URL(window.location.href);
    url.searchParams.set("view", "settings");
    const section = settingsSectionByView[nextView];
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
    url.searchParams.delete("chat");
    const nextLocation = `${url.pathname}${url.search}`;
    if (historyMode === "replace") window.history.replaceState({}, "", nextLocation);
    else if (nextLocation !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState({}, "", nextLocation);
    }
    setProfileOpen(false);
    setMobileNavOpen(false);
    window.requestAnimationFrame(() => mainContentRef.current?.focus());
  };


  const selectAiControlPlaneView = (view = "overview", historyMode = "push") => {
    const requestedView = aiControlPlaneViews.has(view) ? view : "overview";
    const nextView = requestedView === "spend" && canReadUsage
      ? requestedView
      : availableAiControlPlaneTabs.some((tab) => tab.id === requestedView)
        ? requestedView
        : availableAiControlPlaneTabs[0]?.id ?? "overview";
    setActiveNav("AI control plane");
    setAiControlPlaneView(nextView);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "ai-control-plane");
    if (nextView === "overview") url.searchParams.delete("section");
    else url.searchParams.set("section", nextView);
    url.searchParams.delete("chat");
    const nextLocation = `${url.pathname}${url.search}`;
    if (historyMode === "replace") window.history.replaceState({}, "", nextLocation);
    else if (nextLocation !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState({}, "", nextLocation);
    }
    setProfileOpen(false);
    setMobileNavOpen(false);
    window.requestAnimationFrame(() => mainContentRef.current?.focus());
  };

  const deleteSite = async (site) => {
    if (!await requestConfirmation({
      title: "Delete this site?",
      description: `“${site.name}” and all published revisions will be permanently removed.`,
      confirmLabel: "Delete site",
      danger: true,
    })) return;
    setSiteBusyId(site.id);
    setSitesError("");
    try {
      await siteApi.delete(site.id);
      setSites((current) => current.filter((item) => item.id !== site.id));
      setToast("Site deleted.");
    } catch (error) { setSitesError(error.message); }
    finally { setSiteBusyId(""); }
  };

  const saveSchedule = async (input) => {
    const { id, ...document } = input;
    setScheduleBusyId(id || "new");
    setScheduleError("");
    try {
      const saved = id
        ? await scheduleApi.update(id, document)
        : await scheduleApi.create(document);
      setSchedules((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setToast(id ? "Schedule updated." : "Schedule created.");
      return true;
    } catch (error) {
      setScheduleError(error.message);
      return false;
    } finally {
      setScheduleBusyId("");
    }
  };

  const toggleSchedule = async (schedule) => {
    setScheduleBusyId(schedule.id);
    setScheduleError("");
    try {
      const saved = await scheduleApi.update(schedule.id, {
        state: schedule.state === "enabled" ? "paused" : "enabled",
      });
      setSchedules((current) => current.map((item) => item.id === saved.id ? saved : item));
      setToast(saved.state === "enabled" ? "Schedule resumed." : "Schedule paused.");
    } catch (error) { setScheduleError(error.message); }
    finally { setScheduleBusyId(""); }
  };

  const deleteSchedule = async (schedule) => {
    if (!await requestConfirmation({
      title: "Delete schedule?",
      description: `"${schedule.title}" and its run history will be permanently removed.`,
      confirmLabel: "Delete schedule",
      danger: true,
    })) return;
    setScheduleBusyId(schedule.id);
    setScheduleError("");
    try {
      await scheduleApi.delete(schedule.id);
      setSchedules((current) => current.filter((item) => item.id !== schedule.id));
      setToast("Schedule deleted.");
    } catch (error) { setScheduleError(error.message); }
    finally { setScheduleBusyId(""); }
  };

  const runScheduleNow = async (schedule) => {
    setScheduleBusyId(schedule.id);
    setScheduleError("");
    try {
      await scheduleApi.runNow(schedule.id);
      setToast("Scheduled run queued.");
    } catch (error) { setScheduleError(error.message); }
    finally { setScheduleBusyId(""); }
  };

  const selectChatSession = (sessionId, historyMode = "push") => {
    setActiveChatSessionId(sessionId);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "chat");
    if (sessionId) url.searchParams.set("chat", sessionId);
    else url.searchParams.delete("chat");
    const nextLocation = `${url.pathname}${url.search}`;
    if (historyMode === "replace") window.history.replaceState({}, "", nextLocation);
    else if (nextLocation !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState({}, "", nextLocation);
    }
  };

  const requestNewChat = () => {
    setNewChatRequest((current) => current + 1);
    selectChatSession("");
  };

  const selectWorkspaceConfiguration = (grantId) => {
    setSelectedSandboxGrantId(grantId);
    setSandboxSettings(null);
    setSandboxError("");
    setTelegramConnection(null);
    setTelegramError("");
    window.requestAnimationFrame(() => mainContentRef.current?.focus());
  };

  const createAdditionalWorkspace = (name) => {
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 110);
    const grantId = `workspace-${slug || "managed"}`;
    setSandboxError("");
    setSandboxCreateOpen(false);
    selectWorkspaceConfiguration(grantId);
    setToast("Choose the configuration, then create the workspace.");
  };

  const configureMicrosoft365 = () => {
    selectNav("Connections");
    setConnectionsView("microsoft365-tools");
  };

  const refreshAdminUsers = () => adminApi.users().then((value) => {
    setAdminUsers(value.users);
    setAdminDelegableBuiltInRoles(value.delegableBuiltInRoles ?? []);
  });
  const refreshAdminWorkspaceMembers = () => adminApi.memberWorkspaces().then((value) => {
    setAdminWorkspaceMembers(value.members);
    setAdminWorkspaceError("");
    return value.members;
  });
  const refreshAdminAccess = () => Promise.all([adminApi.users(), adminApi.invitations()]).then(([users, invitations]) => {
    setAdminUsers(users.users);
    setAdminDelegableBuiltInRoles(users.delegableBuiltInRoles ?? []);
    setAdminInvitations(invitations.invitations);
  });
  const refreshAdminTeams = () => adminApi.teams(true).then((value) => setAdminTeams(value.teams));
  const commandAdminWorkspace = async (member, targetWorkspace, action) => {
    const confirmations = {
      restart: {
        title: `Restart ${targetWorkspace.name}?`,
        description: "The active runtime and viewer sessions will disconnect. Persistent files are retained.",
        confirmLabel: "Restart workspace",
      },
      stop: {
        title: `Stop ${targetWorkspace.name}?`,
        description: "The runtime, viewer sessions, agents, and grants will stop. Persistent files are retained.",
        confirmLabel: "Stop workspace",
      },
      terminate_runtime: {
        title: `Terminate ${targetWorkspace.name} runtime?`,
        description: "This immediately revokes the active runtime, viewer sessions, agents, and grants. Persistent files are retained and the workspace record is not deleted.",
        confirmLabel: "Terminate runtime",
        danger: true,
      },
    };
    const confirmationOptions = confirmations[action];
    if (confirmationOptions && !await requestConfirmation(confirmationOptions)) return;

    const actionLabel = {
      start: "started",
      restart: "restarted",
      stop: "stopped",
      terminate_runtime: "terminated",
    }[action];
    setAdminWorkspaceBusyId(targetWorkspace.id);
    setAdminWorkspaceError("");
    try {
      await adminApi.commandMemberWorkspace(member.userId, targetWorkspace.id, action);
      let members = await refreshAdminWorkspaceMembers();
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const refreshed = members.flatMap((item) => item.workspaces).find((item) => item.id === targetWorkspace.id);
        if (!refreshed || !busyStates.has(refreshed.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
        members = await refreshAdminWorkspaceMembers();
      }
      setToast(`${targetWorkspace.name} runtime ${actionLabel}.`);
    } catch (error) {
      setAdminWorkspaceError(error.message ?? "The workspace command could not be completed.");
    } finally {
      setAdminWorkspaceBusyId("");
    }
  };
  const createAdminTeam = async (input) => {
    setAdminTeamsBusy(true);
    try {
      await adminApi.createTeam(input);
      await refreshAdminTeams();
      setToast(`${input.displayName} was created.`);
      return true;
    } catch (error) {
      showApiError(error);
      return false;
    } finally {
      setAdminTeamsBusy(false);
    }
  };
  const updateAdminTeam = async (teamId, input) => {
    setAdminTeamsBusy(true);
    try {
      await adminApi.updateTeam(teamId, input);
      await refreshAdminTeams();
      setToast(`${input.displayName} was updated.`);
      return true;
    } catch (error) {
      showApiError(error);
      return false;
    } finally {
      setAdminTeamsBusy(false);
    }
  };
  const archiveAdminTeam = async (team) => {
    if (!await requestConfirmation({
      title: `Archive ${team.displayName}?`,
      description: "Membership history is retained. Anyone currently charging to this Team is moved to the Unallocated rollout fallback.",
      confirmLabel: "Archive Team",
      danger: true,
    })) return false;
    setAdminTeamsBusy(true);
    try {
      await adminApi.archiveTeam(team.id);
      await refreshAdminTeams();
      setToast(`${team.displayName} was archived.`);
      return true;
    } catch (error) {
      showApiError(error);
      return false;
    } finally {
      setAdminTeamsBusy(false);
    }
  };
  const loadAdminTeam = async (teamId) => {
    setAdminTeamsBusy(true);
    try {
      return (await adminApi.team(teamId)).team;
    } catch (error) {
      showApiError(error);
      return null;
    } finally {
      setAdminTeamsBusy(false);
    }
  };
  const assignAdminTeamMember = async (teamId, userId) => {
    setAdminTeamsBusy(true);
    try {
      await adminApi.assignTeamMembership(teamId, userId);
      await refreshAdminTeams();
      setToast("Team membership was assigned.");
      return (await adminApi.team(teamId)).team;
    } catch (error) {
      showApiError(error);
      return null;
    }
    finally { setAdminTeamsBusy(false); }
  };
  const removeAdminTeamMember = async (teamId, userId) => {
    setAdminTeamsBusy(true);
    try {
      await adminApi.removeTeamMembership(teamId, userId);
      await refreshAdminTeams();
      setToast("Team membership was removed.");
      return (await adminApi.team(teamId)).team;
    } catch (error) {
      showApiError(error);
      return null;
    } finally {
      setAdminTeamsBusy(false);
    }
  };
  const setAdminDefaultTeam = async (teamId, userId) => {
    setAdminTeamsBusy(true);
    try {
      await adminApi.setDefaultSpendingTeam(teamId, userId);
      await refreshAdminTeams();
      setToast("The default spending Team was updated.");
      return (await adminApi.team(teamId)).team;
    } catch (error) {
      showApiError(error);
      return null;
    }
    finally { setAdminTeamsBusy(false); }
  };
  const refreshEgressGroups = () => adminApi.egressSecurityGroups().then((value) => setEgressVersions(value.securityGroups));
  const assignPolicy = async (userId) => {
    setAdminBusyUserId(userId);
    try { await adminApi.assignPolicy(userId); await refreshAdminUsers(); setToast("The MVP policy is assigned."); }
    catch (error) { showApiError(error); }
    finally { setAdminBusyUserId(""); }
  };
  const revokePolicy = async (userId) => {
    if (!await requestConfirmation({
      title: "Revoke this user’s policy?",
      description: "New workspace and agent authority will be revoked. Their persistent workspace storage will not be deleted.",
      confirmLabel: "Revoke policy",
      danger: true,
    })) return;
    setAdminBusyUserId(userId);
    try { await adminApi.revokePolicy(userId); await refreshAdminUsers(); setToast("Workspace and agent authority was revoked."); }
    catch (error) { showApiError(error); }
    finally { setAdminBusyUserId(""); }
  };
  const createOrganizationInvitation = async (input) => {
    setAdminInvitationBusy(true);
    try {
      const result = await adminApi.createInvitation(input);
      await refreshAdminAccess();
      setToast(result.delivery?.mode === "email"
        ? `Invitation emailed to ${input.email.trim().toLowerCase()}.`
        : `Invitation created for ${input.email.trim().toLowerCase()}.`);
      return result;
    } catch (error) {
      showApiError(error);
      return null;
    } finally {
      setAdminInvitationBusy(false);
    }
  };
  const resendOrganizationInvitation = async (invitation) => {
    setAdminInvitationBusy(true);
    try {
      const result = await adminApi.resendInvitation(invitation.invitationId);
      await refreshAdminAccess();
      setToast(result.delivery?.mode === "email"
        ? `A new invitation email was sent to ${invitation.email}.`
        : `A new invitation link was created for ${invitation.email}.`);
      return result;
    } catch (error) {
      showApiError(error);
      return null;
    } finally {
      setAdminInvitationBusy(false);
    }
  };
  const revokeOrganizationInvitation = async (invitation) => {
    if (!await requestConfirmation({
      title: `Revoke the invitation for ${invitation.email}?`,
      description: "The current invitation link will stop working. No organization membership has been created yet.",
      confirmLabel: "Revoke invitation",
      danger: true,
    })) return false;
    setAdminInvitationBusy(true);
    try {
      await adminApi.revokeInvitation(invitation.invitationId);
      await refreshAdminAccess();
      setToast(`The invitation for ${invitation.email} was revoked.`);
      return true;
    } catch (error) {
      showApiError(error);
      return false;
    } finally {
      setAdminInvitationBusy(false);
    }
  };
  const changeMembershipRole = async (user, role) => {
    if (role === user.role) return;
    if (!await requestConfirmation({
      title: `Change ${user.displayName} to ${role === "admin" ? "Administrator" : role === "owner" ? "Owner" : "Member"}?`,
      description: role === "owner"
        ? "This grants full organization authority. It does not remove any existing owner."
        : "The new organization permission set applies immediately.",
      confirmLabel: "Change role",
      danger: role === "owner",
    })) return;
    setAdminBusyUserId(user.userId);
    try {
      await adminApi.changeMembership(user.userId, { role });
      await refreshAdminAccess();
      setToast(`${user.displayName}'s organization role was updated.`);
    } catch (error) {
      showApiError(error);
    } finally {
      setAdminBusyUserId("");
    }
  };
  const transferOrganizationOwnership = async (user, authenticatorCode) => {
    setAdminBusyUserId(user.userId);
    try {
      await authApi.completeOwnerStepUp(authenticatorCode);
      await adminApi.transferOwnership(user.membershipId);
      setToast(`Organization ownership was transferred to ${user.displayName}. This device has been signed out of the organization.`);
      return true;
    } catch (error) {
      showApiError(error);
      return false;
    } finally {
      setAdminBusyUserId("");
    }
  };
  const initiateOrganizationClosure = async (reason, idempotencyKey, authenticatorCode) => {
    setAdminInvitationBusy(true);
    try {
      await authApi.completeOwnerStepUp(authenticatorCode);
      return await adminApi.initiateOrganizationClosure(reason, idempotencyKey);
    } catch (error) {
      showApiError(error);
      return null;
    } finally {
      setAdminInvitationBusy(false);
    }
  };
  const changeUserStatus = async (user, status) => {
    const suspending = status === "suspended";
    const removing = status === "revoked";
    if (!await requestConfirmation({
      title: removing ? `Remove ${user.displayName}'s access?` : suspending ? `Suspend ${user.displayName}?` : `Reactivate ${user.displayName}?`,
      description: removing
        ? "Their membership is revoked and active browser sessions and workspace grants are invalidated. Persistent workspace storage is retained."
        : suspending
          ? "Their browser sessions and active workspace gateway grants will be revoked immediately. Persistent workspace storage is retained."
          : "They will be able to sign in again. Workspace access resumes from their existing organization policy.",
      confirmLabel: removing ? "Remove access" : suspending ? "Suspend" : "Reactivate",
      danger: suspending || removing,
    })) return;
    setAdminBusyUserId(user.userId);
    try {
      await adminApi.changeMembership(user.userId, { status });
      await refreshAdminAccess();
      setToast(removing ? `${user.displayName}'s access was removed.` : suspending ? `${user.displayName} was suspended.` : `${user.displayName} was reactivated.`);
    } catch (error) {
      showApiError(error);
    } finally {
      setAdminBusyUserId("");
    }
  };
  const revokeUserSessions = async (userId) => {
    setAdminBusyUserId(userId);
    try {
      const result = await adminApi.revokeUserSessions(userId);
      setToast(result.revokedSessions
        ? `${result.revokedSessions} active ${result.revokedSessions === 1 ? "session was" : "sessions were"} signed out.`
        : "That user had no active sessions.");
    } catch (error) {
      showApiError(error);
    } finally {
      setAdminBusyUserId("");
    }
  };
  const createPolicyVersion = async () => {
    setRevisionPromptOpen(true);
  };
  const submitPolicyVersion = async (revisionNote) => {
    setRevisionSaving(true);
    try {
      const version = await adminApi.createPolicyVersion(revisionNote);
      setRevisionPromptOpen(false);
      setToast(`Policy version ${version.version} created. Existing assignments remain pinned.`);
    }
    catch (error) { showApiError(error); }
    finally { setRevisionSaving(false); }
  };
  const saveEgressSecurityGroup = async (document) => {
    setEgressSaving(true);
    try {
      const saved = await adminApi.saveEgressSecurityGroup(document);
      await refreshEgressGroups();
      const applied = saved.workspaceProxies?.refreshed ?? 0;
      setToast(applied
        ? `${saved.name} saved and applied live to ${applied} running ${applied === 1 ? "workspace" : "workspaces"}.`
        : `${saved.name} saved. Workspaces using this group will resolve revision ${saved.version}.`);
      return saved;
    } catch (error) { showApiError(error); }
    finally { setEgressSaving(false); }
  };
  const changeMcpPolicy = (name, decision) => setMcpPolicy((current) => ({
    ...current,
    tools: current.tools.map((tool) => tool.name === name ? { ...tool, decision } : tool),
  }));
  const saveMcpPolicy = async () => {
    if (!mcpPolicy) return;
    setMcpPolicySaving(true);
    if (mcpPolicy.connectorId) setConnectionError("");
    try {
      const decisions = Object.fromEntries(mcpPolicy.tools.map((tool) => [tool.name, tool.decision]));
      if (mcpPolicy.connectorId) {
        const refreshed = await adminApi.saveConnectorToolPolicy(mcpPolicy.connectorId, decisions, mcpPolicy.documentHash, mcpPolicy.accessPolicyVersion);
        setMcpPolicy(refreshed);
        setConnectorEffectivePolicyRefresh((current) => current + 1);
        if (refreshed.workspaceGrants?.failed) {
          setToast(`${mcpPolicy.connectorName} policy saved. ${refreshed.workspaceGrants.failed} workspace grant refreshes failed; those tools remain unavailable until a refresh succeeds.`);
        } else if (refreshed.tools?.some((tool) => tool.reviewRequired)) {
          setToast(`${mcpPolicy.connectorName} changed again while it was being saved. Review the current definitions before they can be used.`);
        } else {
          setToast(`${mcpPolicy.connectorName} tool and approval rules are active.`);
        }
        return;
      }
      const saved = await adminApi.saveMcpPolicy(decisions);
      const refreshed = await adminApi.mcpPolicy();
      setMcpPolicy(refreshed);
      await refreshAdminUsers();
      setConnectorEffectivePolicyRefresh((current) => current + 1);
      setToast(saved.workspaceGrants?.failed
        ? `Microsoft 365 tool policy version ${saved.version} is saved. ${saved.workspaceGrants.failed} workspace grant refreshes failed; those tools remain unavailable until a refresh succeeds.`
        : `Microsoft 365 tool policy version ${saved.version} is active for new calls${saved.workspaceGrants?.refreshed ? ` in ${saved.workspaceGrants.refreshed} running workspace` : ""}.`);
    } catch (error) {
      if (mcpPolicy.connectorId) setConnectionError(error.message);
      else showApiError(error);
    }
    finally { setMcpPolicySaving(false); }
  };
  const logout = async () => {
    try { await authApi.logout(); } finally { window.location.assign("/"); }
  };
  const switchInvitationAccount = async () => {
    setAuthLoading(true);
    try {
      await authApi.logout();
      setSession(null);
      setCustomerSession(null);
      setAuthError("");
      setInvitationError("");
      await refreshAuthentication(false);
    } catch (error) {
      setAuthError(error.message ?? "The current account could not be signed out.");
      setAuthLoading(false);
    }
  };

  if (authLoading) return <main className="signin-screen"><div className="signin-loading">Checking your work account…</div></main>;
  const invitationAccount = session?.user ?? customerSession?.user ?? customerSession?.account ?? null;
  if (invitationActive && invitationError && invitationAccount) {
    return <InvitationAccountSwitchScreen
      account={invitationAccount}
      organizationDisplayName={invitationContext?.organizationDisplayName}
      onSignOut={switchInvitationAccount}
    />;
  }
  if (customerSession?.status === "verification-required") {
    return <VerificationRequiredScreen
      customerSession={customerSession}
      invitationActive={invitationActive}
      invitationContext={invitationContext}
      onSignOut={logout}
    />;
  }
  if (customerSession) {
    return <OrganizationSelectionScreen customerSession={customerSession} error={authError} onSelected={refreshAuthentication} onSignOut={logout} />;
  }
  if (!session) {
    return <SignInScreen
      error={authError}
      invitationActive={invitationActive}
      invitationBusy={invitationPreparing}
      invitationError={invitationError}
      invitationContext={invitationContext}
      invitationVerified={invitationVerified}
      onSignedIn={() => refreshAuthentication(invitationAcceptable)}
    />;
  }
  const modalActive = Boolean(drawer || confirmation || revisionPromptOpen || sandboxCreateOpen || accountSecurityOpen);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside ref={sidebarRef} id="primary-navigation" className={`sidebar${mobileNavOpen ? " mobile-open" : ""}`} aria-label="Application navigation" inert={modalActive ? true : undefined}>
        <div className="brand" aria-label="LemmaComputer">
          <strong>Lemma</strong><span>Computer</span>
        </div>
        <nav aria-label="Primary navigation">
          <NavButton active={activeNav === "Workspace"} icon={activeNav === "Workspace" ? Home24Filled : Home24Regular} label="Workspace" onClick={() => selectNav("Workspace")} />
          <NavButton active={activeNav === "Schedules"} icon={Calendar24Regular} label="Schedules" onClick={() => selectNav("Schedules")} />
          <NavButton active={activeNav === "Sites"} icon={activeNav === "Sites" ? Apps24Filled : Apps24Regular} label="Sites" onClick={() => selectNav("Sites")} />
          <NavButton active={activeNav === "Trail"} icon={Clock24Regular} label="Trail" onClick={() => selectNav("Trail")} />
          {canManagePolicy && <NavButton active={activeNav === "Firewall"} icon={ShieldCheckmark24Regular} label="Firewall" onClick={() => selectNav("Firewall")} />}
          <NavButton active={activeNav === "Connections"} icon={PlugConnected24Regular} label="Connections" onClick={() => selectNav("Connections")} />
          <NavButton active={activeNav === "Chat"} icon={Bot24Regular} label="Chat" onClick={() => selectNav("Chat")} />
          {activeNav === "Chat" && <div className="sidebar-chat-history" aria-label="Recent chat threads">
            <div className="sidebar-chat-history-heading"><span>Recent</span><button type="button" aria-label="Start a new chat" title="Start a new chat" onClick={() => { requestNewChat(); setMobileNavOpen(false); }}><Add24Regular aria-hidden="true" /></button></div>
            {chatSessions.length === 0
              ? <p>No recent chats</p>
              : chatSessions.map((item, index) => <button key={item.id} className={activeChatSessionId === item.id ? "active" : ""} type="button" onClick={() => { selectChatSession(item.id); setMobileNavOpen(false); }} aria-current={activeChatSessionId === item.id ? "true" : undefined}>
                <span>{item.title || `Conversation ${chatSessions.length - index}`}</span>
                {runningChatSessionIds.includes(item.id) && <span className="sidebar-chat-running" aria-hidden="true" />}
              </button>)}
            {chatHistoryHasMore && <button className="sidebar-chat-load-more" type="button" disabled={chatHistoryLoadingMore} onClick={() => setChatHistoryLoadRequest((value) => value + 1)}>{chatHistoryLoadingMore ? "Loading chats…" : "Load older chats"}</button>}
          </div>}
        </nav>
        <div ref={profileRef} className="sidebar-account">
          <button
            className="sidebar-profile"
            type="button"
            onClick={() => setProfileOpen((value) => !value)}
            aria-expanded={profileOpen}
            aria-controls="sidebar-account-menu"
          >
            <Person24Regular aria-hidden="true" />
            <span><strong>{session.user.displayName}</strong></span>
            <ChevronDown16Regular aria-hidden="true" />
          </button>
          {profileOpen && (
            <div id="sidebar-account-menu" className="sidebar-account-menu" role="group" aria-label="Account menu">
              <div className="sidebar-menu-profile">
                <span className="sidebar-menu-avatar"><Person24Regular aria-hidden="true" /></span>
                <span><strong>{session.user.displayName}</strong><small>{session.user.email}</small></span>
              </div>
              <div className="sidebar-account-menu-actions">
                {canOpenAiControlPlane && <>
                  <span className="sidebar-menu-section-label">Organization</span>
                  <button className="sidebar-control-plane-link" type="button" onClick={() => selectAiControlPlaneView("overview")}><Bot24Regular aria-hidden="true" /><span>AI control plane</span><ChevronRight16Regular aria-hidden="true" /></button>
                  <span className="sidebar-menu-divider" aria-hidden="true" />
                </>}
                <button type="button" onClick={() => selectNav("Settings")}><Settings24Regular aria-hidden="true" /><span>Settings</span><ChevronRight16Regular aria-hidden="true" /></button>
                <button className="sidebar-signout" type="button" onClick={logout}><SignOut24Regular aria-hidden="true" /><span>Log out</span></button>
              </div>
            </div>
          )}
        </div>
      </aside>

      <main id="main-content" ref={mainContentRef} className="main-content" tabIndex="-1" inert={mobileNavOpen || modalActive ? true : undefined}>
        <header className="topbar">
          <button className="mobile-menu" type="button" aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileNavOpen} aria-controls="primary-navigation" onClick={() => setMobileNavOpen((value) => !value)}>
            <Navigation24Regular aria-hidden="true" />
          </button>
          <div className="mobile-brand"><strong>Lemma</strong><span>Computer</span></div>
        </header>

        {activeNav === "Workspace" && !selectedSandboxGrantId && (
          <WorkspaceScreen
            section={workspaceSection}
            workspaces={homeWorkspaces}
            loading={homeWorkspacesLoading}
            apiError={apiError}
            actionWorkspaceId={workspaceActionId}
            canCreateWorkspace={hasCapability("workspace.create")}
            canManageWorkspace={(workspaceId) => hasScopedCapability("workspace.manage", "workspace", workspaceId) || hasScopedCapability("workspace.manage_own", "workspace", workspaceId)}
            canManageAnyWorkspace={canManageAnyWorkspace}
            canManagePolicy={canManagePolicy}
            onSectionChange={selectWorkspaceSection}
            onOpen={openWorkspace}
            onRestart={restartWorkspace}
            onStop={stopWorkspace}
            onDelete={deleteWorkspace}
            onCreate={() => setSandboxCreateOpen(true)}
            onManage={selectWorkspaceConfiguration}
            workspaceMembers={adminWorkspaceMembers}
            adminLoading={adminLoading}
            workspaceError={adminWorkspaceError}
            workspaceBusyId={adminWorkspaceBusyId}
            onWorkspaceCommand={commandAdminWorkspace}
            policyUsers={adminUsers}
            onConfigureConnections={configureMicrosoft365}
          />
        )}
        {activeNav === "Sites" && <SitesScreen
          sites={sites}
          loading={sitesLoading}
          error={sitesError}
          busySiteId={siteBusyId}
          onDelete={deleteSite}
        />}
        {activeNav === "Trail" && <ActivityScreen displayName={session.user.displayName} operations={operationHistory} onOpenOperation={(selected) => { setOperation(selected); setDrawer("request"); }} />}
        {activeNav === "Schedules" && <SchedulesScreen
          schedules={schedules}
          workspaces={homeWorkspaces}
          loading={schedulesLoading}
          busyId={scheduleBusyId}
          error={scheduleError}
          onSave={saveSchedule}
          onToggle={toggleSchedule}
          onDelete={deleteSchedule}
          onRunNow={runScheduleNow}
          onLoadRuns={async (scheduleId) => (await scheduleApi.runs(scheduleId)).runs}
        />}
        {activeNav === "Chat" && <ChatScreen
          key={workspace?.id ?? "no-workspace"}
          workspace={workspace}
          workspaces={homeWorkspaces}
          workspaceState={workspaceState}
          skills={reviewedSkills}
          onWorkspaceChange={selectActiveWorkspace}
          onStartWorkspace={openWorkspace}
          onRestartWorkspace={restartWorkspace}
          activeSessionId={activeChatSessionId}
          onSessionsChange={setChatSessions}
          onSessionChange={(sessionId) => selectChatSession(sessionId, "replace")}
          preferredAgentId={workspace ? chatAgentPreferences[workspace.id] ?? readPreference(chatAgentPreferenceKey(workspace.id)) : ""}
          onAgentChange={saveChatAgentPreference}
          historyLoadRequest={chatHistoryLoadRequest}
          newThreadRequest={newChatRequest}
          onRunningSessionIdsChange={setRunningChatSessionIds}
          onHistoryMetadataChange={({ hasMore, loading }) => {
            setChatHistoryHasMore(hasMore);
            setChatHistoryLoadingMore(loading);
          }}
          sessions={chatSessions}
          companionComposer
          historyHasMore={chatHistoryHasMore}
          historyLoadingMore={chatHistoryLoadingMore}
          onLoadOlder={() => setChatHistoryLoadRequest((value) => value + 1)}
        />}
        {activeNav === "Workspace" && selectedSandboxGrantId && <WorkspaceConfigurationScreen
          settings={sandboxSettings}
          workspaces={homeWorkspaces}
          loading={sandboxLoading}
          saving={sandboxSaving}
          error={sandboxError}
          selectedGrantId={selectedSandboxGrantId}
          onBack={() => { setSelectedSandboxGrantId(null); setSandboxSettings(null); setSandboxError(""); setTelegramConnection(null); setTelegramError(""); }}
          onSave={saveWorkspaceSettings}
          onAssignSecurityGroup={assignWorkspaceSecurityGroup}
          canManageFirewall={Boolean(homeWorkspaces.find((item) => item.grantId === selectedSandboxGrantId)?.id
            && hasScopedCapability("policy.manage", "workspace", homeWorkspaces.find((item) => item.grantId === selectedSandboxGrantId)?.id))}
          telegram={telegramConnection}
          credentials={credentials}
          channelLoading={telegramLoading}
          channelBusy={telegramBusy || credentialsBusy}
          channelError={telegramError}
          onSaveTelegram={saveTelegram}
          onDisconnectTelegram={disconnectTelegram}
          onCreateCredential={createTelegramCredential}
        />}
        {activeNav === "Connections" && (
          <ConnectionsScreen
            connections={mcpConnections}
            loading={connectionLoading}
            busyConnectorId={connectionBusy}
            error={connectionError}
            onConnect={connectMcpConnector}
            onDisconnect={disconnectMcpConnector}
            onIconChange={saveConnectorIcon}
            onAccessPolicySave={saveConnectorAccessPolicy}
            onRemoveConnector={removeMcpConnector}
            onAddConnector={() => setConnectorDialogOpen(true)}
            displayName={session.user.displayName}
            canAddConnector={hasCapability("provider.manage")}
            canManagePolicy={canManagePolicy}
            view={connectionsView}
            onViewChange={setConnectionsView}
            mcpPolicy={mcpPolicy}
            policyLoading={mcpPolicyLoading}
            policySaving={mcpPolicySaving}
            onPolicyChange={changeMcpPolicy}
            onPolicySave={saveMcpPolicy}
            effectivePolicy={connectorEffectivePolicy}
            effectivePolicyLoading={connectorEffectivePolicyLoading}
            effectivePolicyError={connectorEffectivePolicyError}
            onRetryDelivery={retryConnectorPolicyDelivery}
          />
        )}
        {activeNav === "Firewall" && canManagePolicy && <FirewallScreen loading={adminLoading} versions={egressVersions} saving={egressSaving} onSave={saveEgressSecurityGroup} />}
        {activeNav === "AI control plane" && canOpenAiControlPlane && (
          <AiControlPlane activeView={aiControlPlaneView} onViewChange={selectAiControlPlaneView} tabs={availableAiControlPlaneTabs}>
            {aiControlPlaneView === "overview" && canReadUsage && <AiControlPlaneOverview
              onOpenSpend={() => selectAiControlPlaneView("spend")}
              onOpenRouting={() => selectAiControlPlaneView("model-routes")}
              onOpenPricing={() => selectAiControlPlaneView("pricing")}
            />}
            {aiControlPlaneView === "spend" && canReadUsage && <SpendDashboard onBack={() => selectAiControlPlaneView("overview")} />}
            {aiControlPlaneView === "data-health" && (canReadUsage || canManageUsage) && <UsageDataHealth onOpenPricing={() => selectAiControlPlaneView("pricing")} />}
            {aiControlPlaneView === "models-providers" && canManageAnyProvider && <ProviderSettingsScreen
              providers={providerSettings}
              loading={providerSettingsLoading}
              busy={providerSettingsBusy}
              error={providerSettingsError}
              onSave={saveProviderSetting}
              onTest={testProviderSetting}
              onDisable={disableProviderSetting}
              onDelete={deleteProviderSetting}
            />}
            {aiControlPlaneView === "model-routes" && (canManagePolicy || hasCapability("provider.manage")) && <RoutingAdmin draftScope={{ tenantId: session.tenant.id, userId: session.user.id }} />}
            {aiControlPlaneView === "pricing" && (canReadUsage || canManageUsage) && <RoutingAdmin section="pricing" />}
            {aiControlPlaneView === "teams-budgets" && canManageUsage && <TeamsAdminSection
              teams={adminTeams}
              users={adminUsers}
              loading={adminTeamsLoading}
              busy={adminTeamsBusy}
              onLoad={loadAdminTeam}
              onCreate={createAdminTeam}
              onUpdate={updateAdminTeam}
              onArchive={archiveAdminTeam}
              onAssignMember={assignAdminTeamMember}
              onRemoveMember={removeAdminTeamMember}
              onSetDefault={setAdminDefaultTeam}
            />}
          </AiControlPlane>
        )}
        {activeNav === "Settings" && <SettingsScreen
          view={settingsView}
          canManageMembers={canManageMembers}
          canManageRoles={canManageRoles}
          canManageSettings={canManageSettings}
          delegableBuiltInRoles={adminDelegableBuiltInRoles}
          currentUserId={session.user.id}
          onOpenAdmin={() => selectSettingsView("admin")}
          onOpenCredentials={() => selectSettingsView("credentials")}
          onOpenAccountSecurity={() => selectSettingsView("security")}
          onBack={() => selectSettingsView("overview")}
          credentials={credentials}
          workspaces={homeWorkspaces}
          credentialsLoading={credentialsLoading}
          credentialsBusy={credentialsBusy}
          credentialsError={credentialsError}
          onCreateCredential={createTelegramCredential}
          onRotateCredential={rotateTelegramCredential}
          onDeleteCredential={deleteTelegramCredential}
          users={adminUsers}
          invitations={adminInvitations}
          loading={adminLoading}
          invitationBusy={adminInvitationBusy}
          busyUserId={adminBusyUserId}
          onInvite={createOrganizationInvitation}
          onResendInvitation={resendOrganizationInvitation}
          onRevokeInvitation={revokeOrganizationInvitation}
          onRoleChange={changeMembershipRole}
          onStatusChange={changeUserStatus}
          onTransferOwnership={transferOrganizationOwnership}
          onInitiateClosure={initiateOrganizationClosure}
          onRevokeSessions={revokeUserSessions}
        />}
      </main>

      {mobileNavOpen && <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      {confirmation && (
        <ConfirmDialog
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel={confirmation.confirmLabel}
          danger={confirmation.danger}
          onConfirm={() => settleConfirmation(true)}
          onCancel={() => settleConfirmation(false)}
        />
      )}

      {revisionPromptOpen && (
        <TextPromptDialog
          title="Create an immutable policy version"
          description="Describe why this organization policy version is being created. Existing assignments remain pinned until explicitly changed."
          label="Revision note"
          defaultValue="Policy review"
          confirmLabel="Create version"
          busy={revisionSaving}
          onConfirm={submitPolicyVersion}
          onCancel={() => setRevisionPromptOpen(false)}
        />
      )}

      {sandboxCreateOpen && (
        <TextPromptDialog
          title="Create workspace"
          description="Choose a clear name first. You’ll review the profile, applications, agents, and model before LemmaComputer starts anything."
          label="Workspace name"
          defaultValue="Project workspace"
          confirmLabel="Continue to configuration"
          onConfirm={createAdditionalWorkspace}
          onCancel={() => setSandboxCreateOpen(false)}
        />
      )}

      {accountSecurityOpen && <ModalDialog
        className="account-security-modal"
        title="Account security"
        description="Manage authentication methods and device sessions for your LemmaComputer identity. Organization access remains separate."
        eyebrow="Your identity"
        labelledBy="account-security-title"
        onClose={() => selectSettingsView("overview")}
      >
        <AccountSecurityPanel onSessionChanged={refreshAuthentication} onSignOutAll={logout} />
      </ModalDialog>}


      {drawer === "request" && operation && (
        <Drawer title="Governed operation" onClose={() => setDrawer(null)}>
          <div className={`request-status${operation.state === "succeeded" ? " complete" : ""}`}>
            {operation.state === "succeeded" ? <CheckmarkCircle24Regular aria-hidden="true" /> : <Clock24Regular aria-hidden="true" />}
            <span><strong>{operationStateLabels[operation.state]}</strong><small>Requested today at {operationTime(operation.requestedAt)}</small></span>
          </div>
          <dl className="request-details">
            <div><dt>Action</dt><dd>{operation.action}</dd></div>
            <div><dt>File</dt><dd>{operation.resourceName}</dd></div>
            <div><dt>Location</dt><dd>{operation.resourceLocation}</dd></div>
            <div><dt>Requested by</dt><dd>{session.user.displayName}</dd></div>
            {operation.agentId && <div><dt>Agent</dt><dd><code>{operation.agentId.slice(0, 16)}…</code></dd></div>}
            {operation.policyVersionId && <div><dt>Policy version</dt><dd><code>{operation.policyVersionId.slice(0, 12)}…</code></dd></div>}
            <div><dt>Tool</dt><dd><code>{operation.toolName}</code></dd></div>
            <div><dt>Operation binding</dt><dd><code>{operation.operationDigest.slice(0, 12)}…</code></dd></div>
          </dl>
          {operation.receipt && (
            <div className="gateway-response">
              <strong>Execution receipt</strong>
              <p>{operation.receipt.resultSummary}</p>
            </div>
          )}
          {operationAudit?.events?.length > 0 && (
            <div className="audit-trail">
              <strong>Audit trail</strong>
              <ol>
                {operationAudit.events.map((event, index) => (
                  <li key={`${event.createdAt}-${index}`}>
                    <span>{event.eventType.replaceAll("_", " ")}</span>
                    <small>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(event.createdAt))}</small>
                    <code>{event.correlationId.slice(0, 12)}…</code>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="drawer-note"><ShieldCheckmark24Regular aria-hidden="true" /><p>{
            operation.state === "approval_required"
              ? operation.requiredApprovalChannel === "openvtc-task-consent"
                ? "The exact action is stored and bound to this request. The tool has not run. Review its signed effects with your approval device."
                : "The exact action is stored and bound to this request. The tool has not run. Use the temporary local fixture below to test approval or denial."
              : operation.state === "succeeded"
                ? "The bound operation was approved, executed once, and recorded with a receipt."
                : operation.state === "denied"
                  ? "The request was denied and the tool was not called."
                  : "LemmaComputer is preserving the authoritative operation state."
          }</p></div>
          {operation.state === "approval_required" && operation.requiredApprovalChannel === "local-fixture" ? (
            <div className="approval-actions">
              <button className="primary-button" type="button" onClick={() => decideGovernedOperation("approve")} disabled={operationBusy}>
                <ShieldCheckmark24Regular aria-hidden="true" />{operationBusy ? "Applying decision" : "Approve with local fixture"}
              </button>
              <button className="secondary-button danger-button" type="button" onClick={() => decideGovernedOperation("deny")} disabled={operationBusy}>Deny</button>
            </div>
          ) : operation.state === "approval_required" && approvalRequestState === "ready" ? (
            <div className="approval-review drawer-approval-review" aria-live="polite">
              <div className="approval-review-heading">
                <span>Signed approval request</span>
                <strong>{approvalRequest.payload.sideEffects}</strong>
              </div>
              <h3>{approvalRequest.payload.effects?.[0]?.summary ?? operation.safeSummary}</h3>
              <dl>
                <div><dt>Signed by</dt><dd>LemmaComputer Control</dd></div>
                <div><dt>Approval binding</dt><dd>{approvalRequest.payload.payloadDigest.slice(0, 16)}…</dd></div>
              </dl>
              <p className="approval-warning">One device confirmation signs your decision for only this exact operation.</p>
              {approvalRequestMessage && <p className="approval-device-message" role="status">{approvalRequestMessage}</p>}
              <div className="approval-review-actions">
                <button className="primary-button" type="button" onClick={() => decideWithApprovalDevice("approve")} disabled={operationBusy}>
                  <ShieldCheckmark24Regular aria-hidden="true" />{operationBusy ? "Verifying device" : "Verify and approve"}
                </button>
                <button className="secondary-button danger-button" type="button" onClick={() => decideWithApprovalDevice("deny")} disabled={operationBusy}>Deny</button>
              </div>
            </div>
          ) : operation.state === "approval_required" && approvalRequestState === "setup" ? (
            <div className="approval-actions approval-state-actions">
              <p className="approval-device-message" role="status">{approvalRequestMessage}</p>
              <button className="primary-button" type="button" onClick={() => { setDrawer(null); selectNav("Connections"); }}>
                <ShieldCheckmark24Regular aria-hidden="true" />Set up approval device
              </button>
              <button className="secondary-button" type="button" onClick={() => setDrawer(null)}>Close</button>
            </div>
          ) : operation.state === "approval_required" ? (
            <div className="approval-actions approval-state-actions">
              <p className="approval-device-message" role="status">{approvalRequestState === "loading" ? "Verifying the signed approval request…" : approvalRequestMessage}</p>
              {approvalRequestState !== "loading" && (
                <button className="secondary-button" type="button" onClick={() => setApprovalReload((value) => value + 1)}>Try again</button>
              )}
              <button className="secondary-button" type="button" onClick={() => setDrawer(null)}>Close</button>
            </div>
          ) : (
            <button className="secondary-button full-width" type="button" onClick={() => setDrawer(null)}>Close</button>
          )}
        </Drawer>
      )}

      {connectorDialogOpen && <AddConnectorDialog onCreated={connectorCreated} onClose={() => setConnectorDialogOpen(false)} />}
      {toast && <div className="toast" role="status" aria-live="polite"><CheckmarkCircle24Regular aria-hidden="true" />{toast}</div>}
    </div>
  );
}
