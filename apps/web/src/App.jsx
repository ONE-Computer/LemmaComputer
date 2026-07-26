import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Home24Filled, Home24Regular } from "@fluentui/react-icons/svg/home";
import { Clock24Regular } from "@fluentui/react-icons/svg/clock";
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
import { Bot24Regular } from "@fluentui/react-icons/svg/bot";
import { PlugConnected24Regular } from "@fluentui/react-icons/svg/plug-connected";
import { Settings24Regular } from "@fluentui/react-icons/svg/settings";
import { SignOut24Regular } from "@fluentui/react-icons/svg/sign-out";
import { operationApi, workspaceApi, sandboxApi, connectionApi, approvalApi, authApi, adminApi, chatApi } from "./workspace-api.js";
import { clipboardStatusForBrowser } from "./clipboard-status.js";
import {
  clearBrowserApprover,
  enrollBrowserApprover,
  getBrowserApproverIdentity,
  hasBrowserApprover,
  loadPendingApproval,
  signApprovalDecision,
} from "./openvtc-browser-agent.js";
import { ConfirmDialog, ModalDialog, NoticeDialog, SelectMenu, TextPromptDialog } from "./ui.jsx";

const busyStates = new Set(["loading", "provisioning", "restarting", "stopping"]);
const gatewayAdminUrl = import.meta.env.VITE_LITELLM_ADMIN_URL ?? "http://127.0.0.1:4000/ui";
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
  chat: "Chat",
  trail: "Trail",
  firewall: "Firewall",
  connections: "Connections",
  settings: "Settings",
});
const viewByNav = Object.freeze(Object.fromEntries(
  Object.entries(navByView).map(([view, name]) => [name, view]),
));
const chatAttachmentMaxFiles = 4;
const chatAttachmentMaxBytes = 8 * 1024 * 1024;
const chatAttachmentMaxTotalBytes = 16 * 1024 * 1024;
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
  OIDC_FAILED: "ONEComputer could not finish the sign-in bootstrap.",
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
  const view = new URLSearchParams(window.location.search).get("view") ?? "home";
  return navByView[view] ?? "Workspace";
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

function WorkspaceScreen({ userName, workspaces, loading, apiError, actionWorkspaceId, onOpen, onRestart, onStop, onDelete, onCreate, onManage }) {
  return (
    <div className="home-screen workspace-overview">
      <header className="page-heading workspace-overview-heading">
        <div>
          <p>Good morning, {userName}</p>
          <h1>Your workspaces</h1>
          <span>See what is running and the apps, agents, model, and policy assigned to each workspace.</span>
        </div>
        <button className="primary-button create-workspace-button" type="button" onClick={onCreate}>
          <Add24Regular aria-hidden="true" />Create workspace
        </button>
      </header>

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
            const model = workspace.modelRoute?.alias ?? workspace.profile?.modelAlias ?? "Not assigned";
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
                  <button className="workspace-manage-button" type="button" onClick={() => onManage(workspace.grantId)}>Manage configuration <ChevronRight16Regular aria-hidden="true" /></button>
                  {workspace.state === "stopped" ? (
                    <button className="secondary-button danger-button" type="button" onClick={() => onDelete(workspace)} disabled={busy}><Delete24Regular aria-hidden="true" />Delete</button>
                  ) : (
                    <div className="workspace-secondary-actions">
                      <button className="secondary-button" type="button" onClick={() => onRestart(workspace)} disabled={busy}><ArrowClockwise24Regular aria-hidden="true" />Restart</button>
                      <button className="secondary-button" type="button" onClick={() => onStop(workspace)} disabled={busy}><Dismiss24Regular aria-hidden="true" />Stop</button>
                    </div>
                  )}
                </footer>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

function SignInScreen({ error }) {
  return (
    <main className="signin-screen">
      <section className="signin-card">
        <div className="brand signin-brand" aria-label="ONEComputer"><strong>ONE</strong><span>Computer</span></div>
        <p>Your managed work computer</p>
        <h1>Sign in to continue</h1>
        <span>Use your ME TECH Microsoft account. Your organization’s workspace and agent policy will be applied after sign-in.</span>
        {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Sign-in was not completed</strong>{error}</span></div>}
        <a className="primary-button signin-button" href={authApi.loginUrl}><Person24Regular aria-hidden="true" />Sign in with Microsoft</a>
        <small><ShieldCheckmark24Regular aria-hidden="true" />ONEComputer uses a secure server session. Microsoft tokens are not stored in your browser.</small>
      </section>
    </main>
  );
}

function ToolPolicyEditor({ mcpPolicy, loading, policySaving, onPolicyChange, onPolicySave }) {
  const serviceLabels = { mail: "Outlook Mail", calendar: "Calendar", onedrive: "OneDrive", teams: "Teams" };
  const groupedTools = Object.entries(serviceLabels).map(([service, label]) => ({ service, label, tools: mcpPolicy?.tools.filter((tool) => tool.service === service) ?? [] }));
  if (loading && !mcpPolicy) return <div className="tool-policy-loading">Loading Microsoft 365 tools…</div>;
  return (
      <section className="tool-policy-card connector-tool-policy" aria-labelledby="tool-policy-heading">
        <div className="tool-policy-heading">
          <div><p>Organization tool policy</p><h2 id="tool-policy-heading">Tools &amp; approvals</h2></div>
          {mcpPolicy && <span>Version {mcpPolicy.version} · {mcpPolicy.documentHash.slice(0, 12)}…</span>}
        </div>
        <p className="tool-policy-intro">Choose what assigned workspace agents may run immediately, what requires a signed approval, and what is blocked. Saving creates an immutable policy version and refreshes running workspace grants.</p>
        <div className="tool-policy-groups">
          {groupedTools.map((group) => <section key={group.service} className="tool-policy-group">
            <h3>{group.label}<span>{group.tools.length} tools</span></h3>
            <div className="tool-policy-list">
              {group.tools.map((tool) => (
                <label key={tool.name}>
                  <span><strong>{tool.displayName}</strong><small>{tool.description}</small><code>{tool.name}</code></span>
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

function AdminScreen({ users, loading, busyUserId, onAssign, onRevoke, onVersion, mcpPolicy, onConfigureConnector, onBack }) {
  return (
    <div className="secondary-screen admin-screen">
      <button className="settings-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />Back to Settings</button>
      <header className="page-heading compact">
        <p>Organization administration</p>
        <h1>Workspace policy</h1>
        <span>Manage policy versions and who receives workspace authority. Connector-specific controls live with each connection.</span>
      </header>
      <div className="admin-toolbar">
        <div><strong>MVP standard workspace</strong><small>Workspace, agent, model, network, connector, and protected-operation rules</small></div>
        <button className="secondary-button" type="button" onClick={onVersion}>Create new version</button>
      </div>
      <section className="admin-connector-summary" aria-labelledby="admin-connector-heading">
        <span className="connection-logo compact"><PlugConnected24Regular aria-hidden="true" /></span>
        <div>
          <p>Microsoft 365 connector</p>
          <h2 id="admin-connector-heading">Tool controls are configured with the connection</h2>
          <small>{mcpPolicy ? `Active policy version ${mcpPolicy.version} · ${mcpPolicy.tools.length} tools` : "Open the connector to review its tools and approval rules."}</small>
        </div>
        <button className="secondary-button" type="button" onClick={onConfigureConnector}>Open connector settings<ChevronRight16Regular aria-hidden="true" /></button>
      </section>
      <section className="admin-user-list" aria-label="Organization users">
        {loading ? <p>Loading organization users…</p> : users.map((item) => (
          <article key={item.userId}>
            <div className="admin-user-copy">
              <strong>{item.displayName}</strong><small>{item.email}</small>
              <span>{item.roles.includes("administrator") ? "Administrator" : "Employee"}</span>
            </div>
            <div className="admin-policy-copy">
              {item.effectivePolicy ? <>
                <strong>Version {item.effectivePolicy.version} assigned</strong>
                <small>Immutable policy {item.effectivePolicy.documentHash.slice(0, 12)}…</small>
              </> : <><strong>No active policy</strong><small>Workspace and agent authority is revoked.</small></>}
            </div>
            {item.effectivePolicy
              ? <button className="secondary-button danger-button" type="button" disabled={busyUserId === item.userId} onClick={() => onRevoke(item.userId)}>Revoke</button>
              : <button className="primary-button compact-button" type="button" disabled={busyUserId === item.userId} onClick={() => onAssign(item.userId)}>Assign policy</button>}
          </article>
        ))}
      </section>
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

function SettingsScreen({ view, isAdmin, gatewayUrl, onOpenAdmin, onOpenCredentials, onBack, credentials, workspaces, credentialsLoading, credentialsBusy, credentialsError, onCreateCredential, onRotateCredential, onDeleteCredential, users, loading, busyUserId, onAssign, onRevoke, onVersion, mcpPolicy, onConfigureConnector }) {
  if (view === "admin" && isAdmin) {
    return <AdminScreen
      users={users}
      loading={loading}
      busyUserId={busyUserId}
      onAssign={onAssign}
      onRevoke={onRevoke}
      onVersion={onVersion}
      mcpPolicy={mcpPolicy}
      onConfigureConnector={onConfigureConnector}
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
        <span>Manage the local tools and workspace controls available to you.</span>
      </header>
      <section className="settings-list" aria-label="Settings">
        <button className="settings-item" type="button" onClick={onOpenCredentials}>
          <span className="settings-item-icon"><ShieldCheckmark24Regular aria-hidden="true" /></span>
          <span className="settings-item-copy"><strong>Credentials</strong><small>Manage write-only credentials for official workspace channels.</small></span>
          <ChevronRight16Regular aria-hidden="true" />
        </button>
        <a className="settings-item" href={gatewayUrl} target="_blank" rel="noreferrer">
          <span className="settings-item-icon"><Bot24Regular aria-hidden="true" /></span>
          <span className="settings-item-copy"><strong>Gateway</strong><small>Open the local gateway control surface in a separate tab.</small></span>
          <Open24Regular aria-hidden="true" />
        </a>
        {isAdmin && <button className="settings-item" type="button" onClick={onOpenAdmin}>
          <span className="settings-item-icon"><Settings24Regular aria-hidden="true" /></span>
          <span className="settings-item-copy"><strong>Administration</strong><small>Manage workspace policy versions, assignments, and organization controls.</small></span>
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

const workspacePreferenceKey = "onecomputer.active-workspace-id";
const chatAgentPreferenceKey = (workspaceId) => `onecomputer.active-chat-agent:${workspaceId}`;

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

function WorkspaceConfigurationScreen({ settings, workspaces, loading, saving, error, selectedGrantId, onBack, onSave, onAssignSecurityGroup, canManageFirewall, telegram, credentials, channelLoading, channelBusy, channelError, onSaveTelegram, onDisconnectTelegram, onCreateCredential }) {
  const [profileId, setProfileId] = useState("");
  const [applicationIds, setApplicationIds] = useState([]);
  const [modelAlias, setModelAlias] = useState("");
  const [agentIds, setAgentIds] = useState([]);
  const [securityGroupVersionId, setSecurityGroupVersionId] = useState("");

  useEffect(() => {
    if (!settings) return;
    setProfileId(settings.profileId);
    setApplicationIds(settings.applicationIds);
    setModelAlias(settings.modelAlias);
    setAgentIds(settings.agentIds);
    setSecurityGroupVersionId(settings.securityGroup?.id ?? settings.availableSecurityGroups?.find((group) => group.isDefault)?.id ?? "");
  }, [settings?.profileId, settings?.applicationIds, settings?.modelAlias, settings?.agentIds, settings?.securityGroup?.id, settings?.availableSecurityGroups]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.grantId === selectedGrantId);
  const creatingWorkspace = !selectedWorkspace;
  const canChange = !["provisioning", "ready", "open", "restarting", "stopping"].includes(selectedWorkspace?.state);
  const dirty = settings && (
    profileId !== settings.profileId
    || applicationIds.join(",") !== settings.applicationIds.join(",")
    || modelAlias !== settings.modelAlias
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
      <button className="text-button sandbox-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />All workspaces</button>
      <header className="sandbox-detail-heading">
        <div>
          <p>{creatingWorkspace ? "Create workspace" : "Workspace configuration"}</p>
          <h1>{workspaceName(selectedWorkspace ?? { grantId: selectedGrantId })}</h1>
          <span>{creatingWorkspace ? "Choose the profile, applications, agents, and model before ONEComputer starts this workspace." : "Changes are recorded as a policy-bounded configuration document and apply the next time this workspace starts."}</span>
        </div>
        <span className={`sandbox-state ${creatingWorkspace ? "not_created" : selectedWorkspace?.state}`}>{creatingWorkspace ? "Not created" : workspaceConfigurationStatus(selectedWorkspace?.state)}</span>
      </header>
      {error && <div className="workspace-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Workspace configuration unavailable</strong>{error}</span></div>}
      {loading || !settings ? <p className="sandbox-loading">Loading workspace configuration…</p> : (
        <form className="sandbox-management-form" onSubmit={(event) => { event.preventDefault(); onSave({ grantId: settings.grantId, profileId, applicationIds, modelAlias, agentIds, securityGroupVersionId }); }}>
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

          <TelegramChannelSection
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
          />

          <section className="sandbox-management-section" aria-labelledby="sandbox-model-heading">
            <div className="sandbox-management-heading"><span className="sandbox-section-icon"><Bot24Regular aria-hidden="true" /></span><span><h2 id="sandbox-model-heading">AI model</h2><p>The selected model route is delivered through each agent’s own LiteLLM grant. Provider credentials remain outside the workspace.</p></span></div>
            <div className="model-options sandbox-model-options" role="radiogroup" aria-labelledby="sandbox-model-heading">{settings.availableModels.map((model) => <label className={modelAlias === model.alias ? "selected" : ""} key={model.alias}><input type="radio" name="model" value={model.alias} checked={modelAlias === model.alias} onChange={() => setModelAlias(model.alias)} /><span><strong>{model.displayName}</strong><small>{model.provider} through ONEComputer</small></span>{modelAlias === model.alias && <CheckmarkCircle24Regular aria-hidden="true" />}</label>)}</div>
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
  M365_OAUTH_DENIED: "Microsoft 365 access was not granted. You can try again when you’re ready.",
  M365_OAUTH_STATE_INVALID: "That connection attempt expired or was already used. Please start again.",
  M365_OAUTH_STATE_EXPIRED: "That connection attempt expired. Please start again.",
  M365_OAUTH_IDENTITY_MISMATCH: "That connection attempt belongs to another signed-in user.",
  M365_TOKEN_EXCHANGE_FAILED: "Microsoft 365 could not complete the connection. Please try again.",
};

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

function Microsoft365Detail({ connection, loading, busy, onConnect, onDisconnect, displayName, isAdmin, activeTab, onTabChange, onBack, mcpPolicy, policyLoading, policySaving, onPolicyChange, onPolicySave }) {
  const connected = connection?.state === "connected";
  const expired = connection?.state === "expired";
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
          {loading ? "Checking" : connected ? "Connected" : expired ? "Reconnect required" : "Not connected"}
        </span>
      </header>

      <nav className="connector-tabs" aria-label="Microsoft 365 settings">
        <button className={activeTab === "overview" ? "active" : ""} type="button" onClick={() => onTabChange("overview")}>Overview</button>
        {isAdmin && <button className={activeTab === "tools" ? "active" : ""} type="button" onClick={() => onTabChange("tools")}>Tools &amp; approvals</button>}
      </nav>

      {activeTab === "tools" && isAdmin ? (
        <ToolPolicyEditor mcpPolicy={mcpPolicy} loading={policyLoading} policySaving={policySaving} onPolicyChange={onPolicyChange} onPolicySave={onPolicySave} />
      ) : (
        <div className="connector-overview">
          <section className="connector-overview-card">
            <div>
              <p>Connection status</p>
              <h2>{connected ? "Ready for assigned workspaces" : expired ? "Microsoft access needs attention" : "Connect your work account"}</h2>
              <span>{connected ? "Your workspace agent can use the tools your organization has allowed." : "Connect once to make approved Microsoft 365 tools available to your workspace."}</span>
              <div className="connection-services" aria-label="Included services"><span>Outlook Mail</span><span>Calendar</span><span>OneDrive</span><span>Teams</span></div>
              {connected && <Microsoft365AccountMetadata account={connection?.account} />}
              {connectedAt && <p className="connection-metadata">Connected {connectedAt}</p>}
            </div>
            <div className="connection-actions">
              {connected ? (
                <button className="secondary-button" type="button" onClick={onDisconnect} disabled={busy || loading}>{busy ? "Disconnecting" : "Disconnect"}</button>
              ) : (
                <button className="primary-button" type="button" onClick={onConnect} disabled={busy || loading}><PlugConnected24Regular aria-hidden="true" />{busy ? "Opening Microsoft" : expired ? "Reconnect" : "Connect Microsoft 365"}</button>
              )}
            </div>
          </section>
          <div className="connection-privacy-note"><ShieldCheckmark24Regular aria-hidden="true" /><p>Microsoft tokens stay in the MCP gateway. Your Microsoft credentials are never sent to the workspace.</p></div>
        </div>
      )}
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
          <p>Add a messaging channel only if you want to reach this workspace outside ONEComputer.</p>
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

function ConnectionsScreen({ connection, loading, busy, error, onConnect, onDisconnect, displayName, isAdmin, view, onViewChange, mcpPolicy, policyLoading, policySaving, onPolicyChange, onPolicySave }) {
  const connected = connection?.state === "connected";
  const expired = connection?.state === "expired";
  const connectedAt = connection?.connectedAt
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(connection.connectedAt))
    : null;
  if (view !== "list") {
    return <Microsoft365Detail connection={connection} loading={loading} busy={busy} onConnect={onConnect} onDisconnect={onDisconnect} displayName={displayName} isAdmin={isAdmin} activeTab={view === "microsoft365-tools" ? "tools" : "overview"} onTabChange={(tab) => onViewChange(`microsoft365-${tab}`)} onBack={() => onViewChange("list")} mcpPolicy={mcpPolicy} policyLoading={policyLoading} policySaving={policySaving} onPolicyChange={onPolicyChange} onPolicySave={onPolicySave} />;
  }
  return (
    <div className="secondary-screen connections-screen">
      <header className="page-heading compact">
        <p>Your connected services</p>
        <h1>Connections</h1>
        <span>Connect approved work services here. Official messaging channels are attached separately from each workspace’s configuration.</span>
      </header>

      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Microsoft 365 was not connected</strong>{error}</span></div>}

      <section className="connection-card" aria-labelledby="microsoft-365-title">
        <div className="connection-logo"><PlugConnected24Regular aria-hidden="true" /></div>
        <div className="connection-copy">
          <div className="connection-heading">
            <h2 id="microsoft-365-title">Microsoft 365</h2>
            <span className={`connection-status ${connected ? "connected" : expired ? "expired" : "disconnected"}`}>
              {loading ? "Checking" : connected ? "Connected" : expired ? "Reconnect required" : "Not connected"}
            </span>
          </div>
          <p className="connection-service-summary">Outlook Mail, Calendar, OneDrive, and Teams</p>
          <p className="connection-description">Use approved Microsoft 365 tools through the ONEComputer AI gateway. Protected actions require approval.</p>
          <div className="connection-services" aria-label="Included services">
            <span>Outlook Mail</span><span>Calendar</span><span>OneDrive</span><span>Teams</span>
          </div>
          {connected && <Microsoft365AccountMetadata account={connection?.account} />}
          {connectedAt && <p className="connection-metadata">Connected {connectedAt}</p>}
        </div>
        <div className="connection-actions">
          {connected ? (
            <>
              <button className="primary-button connection-manage-button" type="button" onClick={() => onViewChange(isAdmin ? "microsoft365-tools" : "microsoft365-overview")}>Manage<ChevronRight16Regular aria-hidden="true" /></button>
              <button className="connection-quiet-button" type="button" onClick={onDisconnect} disabled={busy || loading}>{busy ? "Disconnecting" : "Disconnect"}</button>
            </>
          ) : (
            <button className="primary-button" type="button" onClick={onConnect} disabled={busy || loading}>
              <PlugConnected24Regular aria-hidden="true" />
              {busy ? "Opening Microsoft" : expired ? "Reconnect" : "Connect Microsoft 365"}
            </button>
          )}
        </div>
      </section>

      <div className="connection-privacy-note"><ShieldCheckmark24Regular aria-hidden="true" /><p>Microsoft tokens stay in LiteLLM. Messaging channels are attached from each workspace’s configuration and remain outside its runtime.</p></div>
    </div>
  );
}

function ChatPart({ part }) {
  if (part.type === "text") return <p className="chat-message-text">{part.text}</p>;
  if (part.type === "file") {
    const image = part.mediaType.startsWith("image/");
    return (
      <div className={`chat-file-part${image ? " image" : ""}`}>
        {image
          ? <img src={part.url} alt={part.filename || "Attached image"} />
          : <Document24Regular aria-hidden="true" />}
        <span>{part.filename || "Attached file"}</span>
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
    const stateLabel = part.data.state === "running" ? "Running" : part.data.state === "completed" ? "Completed" : "Failed";
    return (
      <details className={`chat-tool ${part.data.state}`} open={part.data.state !== "completed"}>
        <summary><span>{part.data.name}</span><small>{stateLabel}</small></summary>
        {part.data.summary && <p>{part.data.summary}</p>}
      </details>
    );
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
    return <div className={`chat-terminal ${part.data.state}`} role="status">{part.data.message || `Turn ${part.data.state}`}</div>;
  }
  return null;
}

function ChatConversation({
  workspaceId,
  agentId,
  agentName,
  supportsVision,
  activeSessionId,
  onSessionsChange,
  onSessionChange,
  onRefreshSessions,
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [historyState, setHistoryState] = useState("ready");
  const [historyError, setHistoryError] = useState("");
  const transcriptRef = useRef(null);
  const fileInputRef = useRef(null);
  const sessionRef = useRef(activeSessionId);
  const loadedSessionRef = useRef("");

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
        body: { message: messages.at(-1) },
      };
    },
  }), [workspaceId, agentId]);
  const {
    messages,
    sendMessage,
    setMessages,
    status,
    error,
    stop,
    clearError,
  } = useChat({
    id: `${workspaceId}:${agentId}`,
    transport,
    onFinish: () => { void refreshSessions(); },
  });
  const busy = status === "submitted" || status === "streaming";
  const pendingApprovalKey = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "data-approval"
      && ["approval_required", "approved", "executing"].includes(part.data.state))
    .map((part) => part.data.operationId)
    .sort()
    .join(":");

  useEffect(() => {
    sessionRef.current = activeSessionId;
    if (!activeSessionId) {
      loadedSessionRef.current = "";
      setMessages([]);
      setAttachments([]);
      setAttachmentError("");
      setHistoryState("ready");
      setHistoryError("");
      clearError();
      return undefined;
    }
    if (loadedSessionRef.current === activeSessionId) return undefined;
    let active = true;
    setHistoryState("loading");
    setHistoryError("");
    setMessages([]);
    chatApi.messages(workspaceId, agentId, activeSessionId)
      .then((result) => {
        if (!active) return;
        loadedSessionRef.current = activeSessionId;
        setMessages(result.messages);
        setHistoryState("ready");
      })
      .catch((requestError) => {
        if (!active) return;
        setHistoryError(requestError.message);
        setHistoryState("error");
      });
    return () => { active = false; };
  }, [activeSessionId, workspaceId, agentId, setMessages, clearError]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    if (busy || !activeSessionId || !pendingApprovalKey) return undefined;
    let active = true;
    const refresh = () => chatApi.messages(workspaceId, agentId, activeSessionId)
      .then((result) => {
        if (active && sessionRef.current === activeSessionId) setMessages(result.messages);
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
  }, [activeSessionId, agentId, busy, pendingApprovalKey, setMessages, workspaceId]);

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
    if ((!text && !attachments.length) || busy || attachmentBusy) return;
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
        onSessionChange(sessionId);
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

  const visibleMessages = messages.filter((item) => item.role === "user" || item.role === "assistant");
  return (
    <section className={`chat-conversation${visibleMessages.length === 0 ? " is-empty" : ""}`} aria-label="Current conversation">
      <div className="chat-transcript" ref={transcriptRef} aria-live="polite" aria-busy={busy || historyState === "loading"}>
        {visibleMessages.length === 0 ? (
          <div className="chat-welcome">
            <h1>How can {agentName} help?</h1>
            <p>Ask about the files, approved tools, and connections in your managed workspace.</p>
          </div>
        ) : visibleMessages.map((message) => (
          <article className={`chat-message ${message.role}`} key={message.id}>
            <span>{message.role === "assistant" ? agentName : "You"}</span>
            <div className="chat-message-parts">
              {message.parts.map((part, index) => <ChatPart key={part.id || `${part.type}-${index}`} part={part} />)}
            </div>
          </article>
        ))}
      </div>
      {(error || historyError) && <div className="workspace-error chat-error" role="alert"><Info24Regular aria-hidden="true" /><span>{error?.message || historyError}</span></div>}
      <form className="chat-composer" onSubmit={submit}>
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
        <button
          className="chat-attach-button"
          type="button"
          aria-label="Attach files"
          title="Attach files"
          disabled={busy || attachmentBusy || historyState === "loading"}
          onClick={() => fileInputRef.current?.click()}
        >
          <Attach24Regular aria-hidden="true" />
        </button>
        <label className="sr-only" htmlFor="chat-message">Message {agentName}</label>
        <textarea
          id="chat-message"
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
          placeholder={`Message ${agentName}`}
          rows="1"
          maxLength="16000"
          disabled={historyState === "loading"}
        />
        {busy ? (
          <button className="chat-stop-button" type="button" aria-label={`Stop ${agentName}`} onClick={() => { void stop(); }}><Dismiss24Regular aria-hidden="true" /></button>
        ) : (
          <button className="chat-send-button" type="submit" aria-label="Send message" disabled={(!input.trim() && !attachments.length) || attachmentBusy || historyState === "loading"}><ArrowUp24Regular aria-hidden="true" /></button>
        )}
      </form>
    </section>
  );
}

function ChatScreen({
  workspace,
  workspaces,
  workspaceState,
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
}) {
  const [agents, setAgents] = useState([]);
  const [activeAgentId, setActiveAgentId] = useState("");
  const [status, setStatus] = useState("loading");
  const [reasonCode, setReasonCode] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [sessionNextCursor, setSessionNextCursor] = useState(null);
  const [sessionLoadingMore, setSessionLoadingMore] = useState(false);
  const handledHistoryLoadRequest = useRef(historyLoadRequest);

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

  useEffect(() => {
    let active = true;
    setError("");
    onSessionsChange([]);
    setSessionNextCursor(null);
    onHistoryMetadataChange?.({ hasMore: false, loading: false });
    setAgents([]);
    setActiveAgentId("");
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
  const workspaceOptions = workspaces?.length ? workspaces : workspace ? [workspace] : [];
  const contextSelector = (workspaceOptions.length || agents.length > 1) ? (
    <div className="chat-context-selectors">
      {workspaceOptions.length > 0 && <div className="chat-agent-selector">
        <span>Workspace</span>
        <SelectMenu
          value={workspace?.id ?? ""}
          onValueChange={onWorkspaceChange}
          ariaLabel="Choose workspace"
          options={workspaceOptions.map((item) => ({ value: item.id, label: workspaceName(item) }))}
        />
      </div>}
      {agents.length > 1 && <div className="chat-agent-selector">
        <span>Agent</span>
        <SelectMenu
          value={activeAgentId}
          onValueChange={selectAgent}
          ariaLabel="Choose chat agent"
          options={agentOptions}
        />
      </div>}
    </div>
  ) : null;
  if (status !== "ready") {
    const workspaceCanRetry = workspace && ["ready", "open"].includes(workspaceState);
    const workspaceBusy = ["loading", "provisioning", "restarting", "stopping"].includes(workspaceState);
    const restartRequired = offline && reasonCode === "CHAT_RUNTIME_UNAVAILABLE" && workspaceCanRetry;
    return (
      <div className="secondary-screen chat-screen">
        <header className="page-heading">
          <p>Workspace agent</p>
          <h1>Chat</h1>
          <span>Work with any selected agent in your managed workspace. Files, tools, and app connections stay with that workspace.</span>
        </header>
        {contextSelector}
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
    );
  }

  return (
    <div className="secondary-screen chat-screen">
      {contextSelector}
      <ChatConversation
        key={`${workspace.id}:${activeAgentId}`}
        workspaceId={workspace.id}
        agentId={activeAgentId}
        agentName={agentName}
        supportsVision={workspace.modelRoute?.capabilities?.vision === true}
        activeSessionId={activeSessionId}
        onSessionsChange={onSessionsChange}
        onSessionChange={onSessionChange}
        onRefreshSessions={() => loadSessionPage()}
      />
    </div>
  );
}

export function App() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [activeNav, setActiveNav] = useState(navFromLocation);
  const [workspace, setWorkspace] = useState(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => readPreference(workspacePreferenceKey));
  const [workspaceState, setWorkspaceState] = useState("loading");
  const [homeWorkspaces, setHomeWorkspaces] = useState([]);
  const [homeWorkspacesLoading, setHomeWorkspacesLoading] = useState(true);
  const [workspaceActionId, setWorkspaceActionId] = useState("");
  const [apiError, setApiError] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
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
  const [m365Connection, setM365Connection] = useState(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [telegramConnection, setTelegramConnection] = useState(null);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [telegramError, setTelegramError] = useState("");
  const [credentials, setCredentials] = useState([]);
  const [credentialsLoading, setCredentialsLoading] = useState(false);
  const [credentialsBusy, setCredentialsBusy] = useState(false);
  const [credentialsError, setCredentialsError] = useState("");
  const [connectionsView, setConnectionsView] = useState("list");
  const [settingsView, setSettingsView] = useState("overview");
  const [chatSessions, setChatSessions] = useState([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState(chatSessionFromLocation);
  const [chatAgentPreferences, setChatAgentPreferences] = useState({});
  const [chatHistoryHasMore, setChatHistoryHasMore] = useState(false);
  const [chatHistoryLoadingMore, setChatHistoryLoadingMore] = useState(false);
  const [chatHistoryLoadRequest, setChatHistoryLoadRequest] = useState(0);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminBusyUserId, setAdminBusyUserId] = useState("");
  const [egressVersions, setEgressVersions] = useState([]);
  const [egressSaving, setEgressSaving] = useState(false);
  const [mcpPolicy, setMcpPolicy] = useState(null);
  const [mcpPolicyLoading, setMcpPolicyLoading] = useState(false);
  const [mcpPolicySaving, setMcpPolicySaving] = useState(false);
  const [sandboxSettings, setSandboxSettings] = useState(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxSaving, setSandboxSaving] = useState(false);
  const [sandboxCreateOpen, setSandboxCreateOpen] = useState(false);
  const [restartNoticeOpen, setRestartNoticeOpen] = useState(false);
  const [selectedSandboxGrantId, setSelectedSandboxGrantId] = useState(null);
  const [sandboxError, setSandboxError] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [revisionPromptOpen, setRevisionPromptOpen] = useState(false);
  const [revisionSaving, setRevisionSaving] = useState(false);
  const surfacedApprovalIds = useRef(new Set());
  const mainContentRef = useRef(null);
  const sidebarRef = useRef(null);

  const requestConfirmation = (options) => new Promise((resolve) => {
    setConfirmation({ ...options, resolve });
  });

  const settleConfirmation = (accepted) => {
    const pending = confirmation;
    setConfirmation(null);
    pending?.resolve(accepted);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("signin") === "error") {
      const reason = params.get("reason") ?? "OIDC_FAILED";
      setAuthError(signInErrorByReason[reason] ?? "Microsoft could not verify this sign-in. Please try again.");
    }
    authApi.session()
      .then((value) => { setSession(value); setAuthError(""); })
      .catch((error) => { if (error.code !== "UNAUTHENTICATED") setAuthError(error.message); })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const onPopState = () => {
      const name = navFromLocation();
      setActiveNav(name);
      setActiveChatSessionId(chatSessionFromLocation());
      if (name === "Connections") setConnectionsView("list");
      if (name === "Settings") setSettingsView("overview");
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
    setHomeWorkspaces((current) => [next, ...current.filter((item) => item.id !== next.id)]);
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
        setHomeWorkspaces(workspaces);
        applyWorkspace(selected);
        setActiveWorkspaceId(selected?.id ?? "");
        writePreference(workspacePreferenceKey, selected?.id ?? "");
      })
      .catch((error) => { setWorkspaceState("failed"); showApiError(error); })
      .finally(() => setHomeWorkspacesLoading(false));
    operationApi.recent().then(setOperation).catch(showApiError);
    operationApi.list().then((value) => setOperationHistory(value.operations)).catch(showApiError);
    connectionApi.microsoft365()
      .then(setM365Connection)
      .catch((error) => setConnectionError(error.message))
      .finally(() => setConnectionLoading(false));
    connectionApi.credentials()
      .then((value) => setCredentials(value.credentials))
      .catch((error) => setCredentialsError(error.message));
  }, [session?.user.id]);

  useEffect(() => {
    if (!session || activeNav !== "Settings" || settingsView !== "credentials") return;
    setCredentialsLoading(true);
    connectionApi.credentials()
      .then((value) => { setCredentials(value.credentials); setCredentialsError(""); })
      .catch((error) => setCredentialsError(error.message))
      .finally(() => setCredentialsLoading(false));
  }, [activeNav, settingsView, session?.user.id]);

  useEffect(() => {
    if (!session || activeNav !== "Workspace") return undefined;
    let active = true;
    const refresh = () => workspaceApi.list()
      .then((value) => {
        if (!active) return;
        setHomeWorkspaces(value.workspaces);
        const refreshed = value.workspaces.find((item) => item.id === workspace?.id);
        if (refreshed) applyWorkspace(refreshed);
        setHomeWorkspacesLoading(false);
      })
      .catch((error) => { if (active) showApiError(error); });
    refresh();
    const interval = window.setInterval(refresh, 10_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [activeNav, session?.user.id, workspace?.id]);

  useEffect(() => {
    if (!session) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "connections") return;
    const result = params.get("m365");
    if (!result) return;
    setActiveNav("Connections");
    setConnectionsView("microsoft365-overview");
    if (result === "connected") {
      setToast("Microsoft 365 is connected.");
      setConnectionLoading(true);
      connectionApi.microsoft365()
        .then((status) => { setM365Connection(status); setConnectionError(""); })
        .catch((error) => setConnectionError(error.message))
        .finally(() => setConnectionLoading(false));
    } else if (result === "error") {
      const reason = params.get("reason");
      setConnectionError(connectionReason[reason] ?? "Microsoft 365 could not complete the connection. Please try again.");
    }
    params.delete("m365");
    params.delete("reason");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [session?.user.id]);

  useEffect(() => {
    if (!session || session.roles.includes("administrator") || activeNav !== "Firewall") return;
    setActiveNav("Workspace");
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  }, [activeNav, session?.user.id]);

  useEffect(() => {
    if (activeNav !== "Settings" || settingsView !== "admin" || !session?.roles.includes("administrator")) return;
    setAdminLoading(true);
    Promise.all([adminApi.users(), adminApi.mcpPolicy()])
      .then(([users, policy]) => {
        setAdminUsers(users.users);
        setMcpPolicy(policy);
      })
      .catch(showApiError)
      .finally(() => setAdminLoading(false));
  }, [activeNav, settingsView, session?.user.id]);

  useEffect(() => {
    if (activeNav !== "Firewall" || !session?.roles.includes("administrator")) return;
    setAdminLoading(true);
    adminApi.egressSecurityGroups()
      .then((egress) => setEgressVersions(egress.securityGroups))
      .catch(showApiError)
      .finally(() => setAdminLoading(false));
  }, [activeNav, session?.user.id]);

  useEffect(() => {
    if (activeNav !== "Connections" || !session?.roles.includes("administrator") || connectionsView !== "microsoft365-tools") return;
    setMcpPolicyLoading(true);
    adminApi.mcpPolicy()
      .then(setMcpPolicy)
      .catch(showApiError)
      .finally(() => setMcpPolicyLoading(false));
  }, [activeNav, connectionsView, session?.user.id]);

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
    const delay = ["provisioning", "restarting", "stopping"].includes(workspaceState)
      ? 2000
      : ["ready", "open"].includes(workspaceState)
        ? 10000
        : null;
    if (!delay) return undefined;
    const interval = window.setInterval(() => workspaceApi.list()
      .then((value) => {
        setHomeWorkspaces(value.workspaces);
        const refreshed = value.workspaces.find((item) => item.id === workspace?.id);
        if (refreshed) applyWorkspace(refreshed);
      })
      .catch(showApiError), delay);
    return () => window.clearInterval(interval);
  }, [workspace?.id, workspaceState]);

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
    const sessionWindow = window.open("about:blank", "onecomputer-workspace");
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
      if (targetWorkspace.id === workspace?.id) setWorkspaceState(targetWorkspace.state);
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

  const connectMicrosoft365 = () => {
    setConnectionBusy(true);
    setConnectionError("");
    window.location.assign(connectionApi.microsoft365AuthorizeUrl);
  };

  const disconnectMicrosoft365 = async () => {
    if (!await requestConfirmation({
      title: "Disconnect Microsoft 365?",
      description: "ONEComputer will revoke this connection. Your Microsoft account and Microsoft 365 data will not be deleted.",
      confirmLabel: "Disconnect",
      danger: true,
    })) return;
    setConnectionBusy(true);
    setConnectionError("");
    try {
      const status = await connectionApi.disconnectMicrosoft365();
      setM365Connection(status);
      setToast("Microsoft 365 was disconnected.");
    } catch (error) {
      setConnectionError(error.message);
    } finally {
      setConnectionBusy(false);
    }
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
        : "The encrypted credential will be permanently removed from ONEComputer.",
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

  const saveWorkspaceSettings = async (configuration) => {
    setSandboxSaving(true);
    setSandboxError("");
    try {
      const { securityGroupVersionId, ...sandboxConfiguration } = configuration;
      if (securityGroupVersionId && securityGroupVersionId !== sandboxSettings?.securityGroup?.id) {
        await adminApi.assignWorkspaceEgressSecurityGroup(configuration.grantId, securityGroupVersionId);
      }
      const saved = await sandboxApi.save(sandboxConfiguration);
      const creatingWorkspace = !homeWorkspaces.some((item) => item.grantId === configuration.grantId);
      if (creatingWorkspace) {
        const created = await workspaceApi.create(configuration.grantId);
        updateWorkspaceInventory(created);
        setSelectedSandboxGrantId(null);
        setSandboxSettings(null);
        setToast(`${workspaceName(created)} is being prepared with your configuration.`);
      } else {
        setSandboxSettings(saved);
        workspaceApi.list().then((value) => setHomeWorkspaces(value.workspaces)).catch(() => undefined);
        setToast("Workspace configuration saved.");
        setRestartNoticeOpen(true);
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
    const url = new URL(window.location.href);
    if (name === "Workspace") url.searchParams.delete("view");
    else url.searchParams.set("view", viewByNav[name]);
    if (name === "Chat" && activeChatSessionId) url.searchParams.set("chat", activeChatSessionId);
    else url.searchParams.delete("chat");
    const nextLocation = `${url.pathname}${url.search}`;
    if (historyMode === "replace") window.history.replaceState({}, "", nextLocation);
    else if (nextLocation !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState({}, "", nextLocation);
    }
    if (name === "Connections") setConnectionsView("list");
    if (name === "Settings") setSettingsView("overview");
    if (name === "Workspace") { setSelectedSandboxGrantId(null); setSandboxSettings(null); setSandboxError(""); }
    setProfileOpen(false);
    setMobileNavOpen(false);
    window.requestAnimationFrame(() => mainContentRef.current?.focus());
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

  const refreshAdminUsers = () => adminApi.users().then((value) => setAdminUsers(value.users));
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
    try {
      const saved = await adminApi.saveMcpPolicy(Object.fromEntries(mcpPolicy.tools.map((tool) => [tool.name, tool.decision])));
      const refreshed = await adminApi.mcpPolicy();
      setMcpPolicy(refreshed);
      await refreshAdminUsers();
      setToast(saved.workspaceGrants?.failed
        ? `Microsoft 365 tool policy version ${saved.version} is active. ${saved.workspaceGrants.failed} running workspace grant could not refresh; restart that workspace before retrying.`
        : `Microsoft 365 tool policy version ${saved.version} is active for new calls${saved.workspaceGrants?.refreshed ? ` in ${saved.workspaceGrants.refreshed} running workspace` : ""}.`);
    } catch (error) { showApiError(error); }
    finally { setMcpPolicySaving(false); }
  };
  const logout = async () => {
    try { await authApi.logout(); } finally { window.location.assign("/"); }
  };

  if (authLoading) return <main className="signin-screen"><div className="signin-loading">Checking your work account…</div></main>;
  if (!session) return <SignInScreen error={authError} />;
  const firstName = session.user.displayName.split(" ")[0] || session.user.displayName;
  const modalActive = Boolean(drawer || confirmation || revisionPromptOpen || sandboxCreateOpen || restartNoticeOpen);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside ref={sidebarRef} id="primary-navigation" className={`sidebar${mobileNavOpen ? " mobile-open" : ""}`} aria-label="Application navigation" inert={modalActive ? true : undefined}>
        <div className="brand" aria-label="ONEComputer">
          <strong>ONE</strong><span>Computer</span>
        </div>
        <nav aria-label="Primary navigation">
          <NavButton active={activeNav === "Workspace"} icon={activeNav === "Workspace" ? Home24Filled : Home24Regular} label="Workspace" onClick={() => selectNav("Workspace")} />
          <NavButton active={activeNav === "Trail"} icon={Clock24Regular} label="Trail" onClick={() => selectNav("Trail")} />
          {session.roles.includes("administrator") && <NavButton active={activeNav === "Firewall"} icon={ShieldCheckmark24Regular} label="Firewall" onClick={() => selectNav("Firewall")} />}
          <NavButton active={activeNav === "Connections"} icon={PlugConnected24Regular} label="Connections" onClick={() => selectNav("Connections")} />
          <NavButton active={activeNav === "Chat"} icon={Bot24Regular} label="Chat" onClick={() => selectNav("Chat")} />
          {activeNav === "Chat" && <div className="sidebar-chat-history" aria-label="Recent chat threads">
            <div className="sidebar-chat-history-heading"><span>Recent</span><button type="button" aria-label="Start a new chat" title="Start a new chat" onClick={() => { selectChatSession(""); setMobileNavOpen(false); }}><Add24Regular aria-hidden="true" /></button></div>
            {chatSessions.length === 0
              ? <p>No recent chats</p>
              : chatSessions.map((item, index) => <button key={item.id} className={activeChatSessionId === item.id ? "active" : ""} type="button" onClick={() => { selectChatSession(item.id); setMobileNavOpen(false); }} aria-current={activeChatSessionId === item.id ? "true" : undefined}>{item.title || `Conversation ${chatSessions.length - index}`}</button>)}
            {chatHistoryHasMore && <button className="sidebar-chat-load-more" type="button" disabled={chatHistoryLoadingMore} onClick={() => setChatHistoryLoadRequest((value) => value + 1)}>{chatHistoryLoadingMore ? "Loading chats…" : "Load older chats"}</button>}
          </div>}
        </nav>
        <div className="sidebar-account">
          <button
            className="sidebar-profile"
            type="button"
            onClick={() => setProfileOpen((value) => !value)}
            aria-expanded={profileOpen}
            aria-controls="sidebar-account-menu"
          >
            <Person24Regular aria-hidden="true" />
            <span><strong>{session.user.displayName}</strong><small>{session.tenant.displayName}</small></span>
            <ChevronDown16Regular aria-hidden="true" />
          </button>
          {profileOpen && (
            <div id="sidebar-account-menu" className="sidebar-account-menu" role="group" aria-label="Account menu">
              <div className="sidebar-menu-profile">
                <span className="sidebar-menu-avatar"><Person24Regular aria-hidden="true" /></span>
                <span><strong>{session.user.displayName}</strong><small>{session.user.email}</small></span>
              </div>
              <div className="sidebar-account-menu-actions">
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
          <div className="mobile-brand"><strong>ONE</strong><span>Computer</span></div>
        </header>

        {activeNav === "Workspace" && !selectedSandboxGrantId && (
          <WorkspaceScreen
            userName={firstName}
            workspaces={homeWorkspaces}
            loading={homeWorkspacesLoading}
            apiError={apiError}
            actionWorkspaceId={workspaceActionId}
            onOpen={openWorkspace}
            onRestart={restartWorkspace}
            onStop={stopWorkspace}
            onDelete={deleteWorkspace}
            onCreate={() => setSandboxCreateOpen(true)}
            onManage={selectWorkspaceConfiguration}
          />
        )}
        {activeNav === "Trail" && <ActivityScreen displayName={session.user.displayName} operations={operationHistory} onOpenOperation={(selected) => { setOperation(selected); setDrawer("request"); }} />}
        {activeNav === "Chat" && <ChatScreen
          workspace={workspace}
          workspaces={homeWorkspaces}
          workspaceState={workspaceState}
          onWorkspaceChange={selectActiveWorkspace}
          onStartWorkspace={openWorkspace}
          onRestartWorkspace={restartWorkspace}
          activeSessionId={activeChatSessionId}
          onSessionsChange={setChatSessions}
          onSessionChange={(sessionId) => selectChatSession(sessionId, "replace")}
          preferredAgentId={workspace ? chatAgentPreferences[workspace.id] ?? readPreference(chatAgentPreferenceKey(workspace.id)) : ""}
          onAgentChange={saveChatAgentPreference}
          historyLoadRequest={chatHistoryLoadRequest}
          onHistoryMetadataChange={({ hasMore, loading }) => {
            setChatHistoryHasMore(hasMore);
            setChatHistoryLoadingMore(loading);
          }}
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
          canManageFirewall={session.roles.includes("administrator")}
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
            connection={m365Connection}
            loading={connectionLoading}
            busy={connectionBusy}
            error={connectionError}
            onConnect={connectMicrosoft365}
            onDisconnect={disconnectMicrosoft365}
            displayName={session.user.displayName}
            isAdmin={session.roles.includes("administrator")}
            view={connectionsView}
            onViewChange={setConnectionsView}
            mcpPolicy={mcpPolicy}
            policyLoading={mcpPolicyLoading}
            policySaving={mcpPolicySaving}
            onPolicyChange={changeMcpPolicy}
            onPolicySave={saveMcpPolicy}
          />
        )}
        {activeNav === "Firewall" && session.roles.includes("administrator") && <FirewallScreen loading={adminLoading} versions={egressVersions} saving={egressSaving} onSave={saveEgressSecurityGroup} />}
        {activeNav === "Settings" && <SettingsScreen
          view={settingsView}
          isAdmin={session.roles.includes("administrator")}
          gatewayUrl={gatewayAdminUrl}
          onOpenAdmin={() => setSettingsView("admin")}
          onOpenCredentials={() => setSettingsView("credentials")}
          onBack={() => setSettingsView("overview")}
          credentials={credentials}
          workspaces={homeWorkspaces}
          credentialsLoading={credentialsLoading}
          credentialsBusy={credentialsBusy}
          credentialsError={credentialsError}
          onCreateCredential={createTelegramCredential}
          onRotateCredential={rotateTelegramCredential}
          onDeleteCredential={deleteTelegramCredential}
          users={adminUsers}
          loading={adminLoading}
          busyUserId={adminBusyUserId}
          onAssign={assignPolicy}
          onRevoke={revokePolicy}
          onVersion={createPolicyVersion}
          mcpPolicy={mcpPolicy}
          onConfigureConnector={configureMicrosoft365}
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
          description="Choose a clear name first. You’ll review the profile, applications, agents, and model before ONEComputer starts anything."
          label="Workspace name"
          defaultValue="Project workspace"
          confirmLabel="Continue to configuration"
          onConfirm={createAdditionalWorkspace}
          onCancel={() => setSandboxCreateOpen(false)}
        />
      )}

      {restartNoticeOpen && (
        <NoticeDialog
          title="Restart required"
          description="Your changes are saved. Restart this workspace before using it again; its next launch will expose the selected applications and AI agent clients."
          onClose={() => setRestartNoticeOpen(false)}
        />
      )}

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
                  : "ONEComputer is preserving the authoritative operation state."
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
                <div><dt>Signed by</dt><dd>ONEComputer Control</dd></div>
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

      {toast && <div className="toast" role="status" aria-live="polite"><CheckmarkCircle24Regular aria-hidden="true" />{toast}</div>}
    </div>
  );
}
