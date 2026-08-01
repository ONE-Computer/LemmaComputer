import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import { Bot24Regular } from "@fluentui/react-icons/svg/bot";
import { PlugConnected24Regular } from "@fluentui/react-icons/svg/plug-connected";
import { Settings24Regular } from "@fluentui/react-icons/svg/settings";
import { SignOut24Regular } from "@fluentui/react-icons/svg/sign-out";
import { operationApi, workspaceApi, sandboxApi, connectionApi, approvalApi, authApi, adminApi, chatApi, oneVibeApi, scheduleApi, siteApi, skillApi } from "./workspace-api.js";
import { clipboardStatusForBrowser } from "./clipboard-status.js";
import {
  clearBrowserApprover,
  enrollBrowserApprover,
  getBrowserApproverIdentity,
  hasBrowserApprover,
  loadPendingApproval,
  signApprovalDecision,
} from "./openvtc-browser-agent.js";
import { ConfirmDialog, ModalDialog, NoticeDialog, SelectMenu, TextPromptDialog, useDismissOnOutside } from "./ui.jsx";
import { ActivityPanel, ActivityToggle } from "./ActivityPanel.jsx";

const busyStates = new Set(["loading", "provisioning", "restarting", "stopping"]);
const providerTitle = (provider) => ({
  openai: "OpenAI",
  anthropic: "Anthropic",
  glm: "GLM (Z.ai)",
  bedrock: "Amazon Bedrock",
}[provider] ?? provider);
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
  cowork: "Cowork",
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
      description="ONEComputer will re-check the workspace, agent, and current policy before every run."
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
  const serviceLabels = mcpPolicy?.connectorId
    ? { tools: `${mcpPolicy.connectorName} tools` }
    : { mail: "Outlook Mail", calendar: "Calendar", onedrive: "OneDrive", teams: "Teams" };
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

function AdminScreen({ users, currentUserId, loading, busyUserId, onAssign, onRevoke, onStatusChange, onRevokeSessions, onManageWorkspace, onVersion, mcpPolicy, onConfigureConnector, onBack }) {
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
              <div className="admin-user-badges">
                <span>{item.roles.includes("administrator") ? "Administrator" : "Employee"}</span>
                {item.status === "disabled" && <span className="disabled">Suspended</span>}
              </div>
            </div>
            <div className="admin-policy-copy">
              {item.effectivePolicy ? <>
                <strong>Version {item.effectivePolicy.version} assigned</strong>
                <small>Immutable policy {item.effectivePolicy.documentHash.slice(0, 12)}…</small>
              </> : <><strong>No active policy</strong><small>Workspace and agent authority is revoked.</small></>}
              {item.workspaces?.length ? <div className="admin-user-workspaces">
                {item.workspaces.map((workspace) => <button className="connection-quiet-button" type="button" key={workspace.id} disabled={busyUserId === item.userId} onClick={() => onManageWorkspace(item, workspace)}>Manage {workspaceName(workspace)}</button>)}
              </div> : <small>No workspace has been created yet.</small>}
            </div>
            <div className="admin-user-actions">
              {item.effectivePolicy
                ? <button className="secondary-button danger-button" type="button" disabled={busyUserId === item.userId} onClick={() => onRevoke(item.userId)}>Revoke policy</button>
                : <button className="primary-button compact-button" type="button" disabled={busyUserId === item.userId || item.status === "disabled"} onClick={() => onAssign(item.userId)}>Assign policy</button>}
              <button className="secondary-button" type="button" disabled={busyUserId === item.userId} onClick={() => onRevokeSessions(item.userId)}>Sign out sessions</button>
              {item.userId !== currentUserId && <button className={`secondary-button${item.status === "disabled" ? "" : " danger-button"}`} type="button" disabled={busyUserId === item.userId} onClick={() => onStatusChange(item, item.status === "disabled" ? "active" : "disabled")}>{item.status === "disabled" ? "Reactivate" : "Suspend user"}</button>}
            </div>
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

function ProviderSettingsScreen({ providers, loading, busy, error, onSave, onTest, onDisable, onDelete, onBack }) {
  const [editor, setEditor] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const closeEditor = () => { setApiKey(""); setEditor(null); };
  const openEditor = (provider) => {
    setApiKey("");
    setEditor({
      ...provider,
      modelId: provider.modelId ?? provider.modelOptions?.[0]?.id ?? null,
      region: provider.region ?? "ap-southeast-1",
      modelProfileId: provider.modelProfileId ?? "claude-sonnet-4-5-global",
    });
  };
  const save = async () => {
    const submitted = apiKey.trim();
    if (!editor || !submitted) return;
    setApiKey("");
    const input = editor.provider === "bedrock"
      ? { apiKey: submitted, region: editor.region, modelProfileId: editor.modelProfileId }
      : editor.modelOptions?.length
      ? { apiKey: submitted, modelId: editor.modelId }
      : { apiKey: submitted };
    const saved = await onSave(editor.provider, input);
    if (saved) setEditor(null);
  };
  return (
    <div className="secondary-screen settings-screen provider-settings-screen">
      <button className="settings-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />Back to Settings</button>
      <header className="page-heading compact">
        <p>Model access</p>
        <h1>Provider settings</h1>
        <span>Connect a provider key and choose the upstream model routed by LiteLLM. ONEComputer stores only a safe fingerprint, route selection, and test status.</span>
      </header>
      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>Provider operation failed</strong>{error}</span></div>}
      <section className="credential-inventory provider-settings-inventory" aria-labelledby="provider-settings-heading">
        <div className="credential-inventory-heading"><div><p>Organization routes</p><h2 id="provider-settings-heading">Managed providers</h2></div><span>{providers.length}</span></div>
        {loading ? <p className="credential-empty">Loading provider settings…</p> : providers.map((provider) => {
          const needsRecovery = provider.state === "needs-reconfiguration";
          const stateLabel = provider.state === "active" ? "Active" : provider.state === "disabled" ? "Disabled" : needsRecovery ? "Needs reconfiguration" : "Not configured";
          return (
            <article key={provider.provider}>
              <span className="connection-logo compact"><Bot24Regular aria-hidden="true" /></span>
              <div className="credential-copy">
                <strong>{providerTitle(provider.provider)}</strong>
                <small>{provider.primaryAlias} · {provider.upstreamModelDisplayName}</small>
                <span>{stateLabel}{provider.fingerprint ? <> · {provider.fingerprint}</> : null}</span>
                {provider.provider === "bedrock" && provider.region && <span>Region {provider.region} · Profile {provider.modelProfileId}</span>}
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
      {editor && <ModalDialog title={(editor.state === "active" ? "Configure " : "Connect ") + providerTitle(editor.provider)} description={editor.provider === "bedrock" ? "Choose an approved Bedrock region and inference profile. The API key is submitted once to Control, encrypted by LiteLLM, and never displayed again." : "Choose the upstream model LiteLLM should route for this provider. Re-enter the provider key to validate and apply the route; the key is never displayed again."} eyebrow="Write-only provider key" labelledBy="provider-key-title" onClose={busy ? () => undefined : closeEditor}>
        {editor.modelOptions?.length > 0 && <label className="modal-field"><span>Upstream model</span><SelectMenu value={editor.modelId} options={editor.modelOptions.map((option) => ({ value: option.id, label: option.displayName }))} ariaLabel={`${providerTitle(editor.provider)} upstream model`} disabled={busy} onValueChange={(modelId) => setEditor((current) => ({ ...current, modelId }))} /></label>}
        {editor.provider === "bedrock" && <>
          <label className="modal-field"><span>Approved region</span><SelectMenu value={editor.region} options={bedrockRegionOptions} ariaLabel="Approved Bedrock region" disabled={busy || editor.state === "active"} onValueChange={(region) => setEditor((current) => ({ ...current, region }))} /></label>
          <label className="modal-field"><span>Approved inference profile</span><SelectMenu value={editor.modelProfileId} options={bedrockProfileOptions} ariaLabel="Approved Bedrock inference profile" disabled={busy || editor.state === "active"} onValueChange={(modelProfileId) => setEditor((current) => ({ ...current, modelProfileId }))} /></label>
        </>}
        <label className="modal-field"><span>{providerTitle(editor.provider)} API key</span><input name="provider-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste the provider API key" disabled={busy} /></label>
        <div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={closeEditor}>Cancel</button><button className="primary-button" type="button" disabled={busy || !apiKey.trim()} onClick={save}>{busy ? "Validating" : editor.state === "active" ? "Apply configuration" : "Connect provider"}</button></div>
      </ModalDialog>}
    </div>
  );
}

function SettingsScreen({ view, isAdmin, currentUserId, onOpenAdmin, onOpenCredentials, onOpenProviderSettings, onBack, credentials, workspaces, credentialsLoading, credentialsBusy, credentialsError, onCreateCredential, onRotateCredential, onDeleteCredential, providerSettings, providerSettingsLoading, providerSettingsBusy, providerSettingsError, onSaveProviderSetting, onTestProviderSetting, onDisableProviderSetting, onDeleteProviderSetting, users, loading, busyUserId, onAssign, onRevoke, onStatusChange, onRevokeSessions, onManageWorkspace, adminWorkspaceTarget, adminSandboxSettings, adminSandboxLoading, adminSandboxSaving, adminSandboxError, onSaveAdminSandbox, onAssignAdminSecurityGroup, onCloseAdminWorkspace, onVersion, mcpPolicy, onConfigureConnector }) {
  if (view === "admin-workspace" && isAdmin && adminWorkspaceTarget) {
    return <WorkspaceConfigurationScreen
      settings={adminSandboxSettings}
      workspaces={adminWorkspaceTarget.user.workspaces}
      loading={adminSandboxLoading}
      saving={adminSandboxSaving}
      error={adminSandboxError}
      selectedGrantId={adminWorkspaceTarget.workspace.grantId}
      onBack={onCloseAdminWorkspace}
      onSave={onSaveAdminSandbox}
      onAssignSecurityGroup={onAssignAdminSecurityGroup}
      canManageFirewall
      telegram={null}
      credentials={[]}
      channelLoading={false}
      channelBusy={false}
      channelError=""
      onSaveTelegram={() => undefined}
      onDisconnectTelegram={() => undefined}
      onCreateCredential={() => undefined}
      showChannels={false}
      ownerName={adminWorkspaceTarget.user.displayName}
      backLabel="Back to organization users"
    />;
  }
  if (view === "admin" && isAdmin) {
    return <AdminScreen
      users={users}
      currentUserId={currentUserId}
      loading={loading}
      busyUserId={busyUserId}
      onAssign={onAssign}
      onRevoke={onRevoke}
      onStatusChange={onStatusChange}
      onRevokeSessions={onRevokeSessions}
      onManageWorkspace={onManageWorkspace}
      onVersion={onVersion}
      mcpPolicy={mcpPolicy}
      onConfigureConnector={onConfigureConnector}
      onBack={onBack}
    />;
  }
  if (view === "credentials") {
    return <CredentialsScreen credentials={credentials} workspaces={workspaces} loading={credentialsLoading} busy={credentialsBusy} error={credentialsError} onCreate={onCreateCredential} onRotate={onRotateCredential} onDelete={onDeleteCredential} onBack={onBack} />;
  }
  if (view === "provider-settings" && isAdmin) {
    return <ProviderSettingsScreen providers={providerSettings} loading={providerSettingsLoading} busy={providerSettingsBusy} error={providerSettingsError} onSave={onSaveProviderSetting} onTest={onTestProviderSetting} onDisable={onDisableProviderSetting} onDelete={onDeleteProviderSetting} onBack={onBack} />;
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
        {isAdmin && <button className="settings-item" type="button" onClick={onOpenProviderSettings}>
          <span className="settings-item-icon"><Bot24Regular aria-hidden="true" /></span>
          <span className="settings-item-copy"><strong>Provider settings</strong><small>Configure encrypted organization model-provider keys and verify their routes.</small></span>
          <ChevronRight16Regular aria-hidden="true" />
        </button>}
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

function WorkspaceConfigurationScreen({ settings, workspaces, loading, saving, error, selectedGrantId, onBack, onSave, onAssignSecurityGroup, canManageFirewall, telegram, credentials, channelLoading, channelBusy, channelError, onSaveTelegram, onDisconnectTelegram, onCreateCredential, showChannels = true, ownerName = "", backLabel = "All workspaces" }) {
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
      <button className="text-button sandbox-back-button" type="button" onClick={onBack}><ArrowLeft24Regular aria-hidden="true" />{backLabel}</button>
      <header className="sandbox-detail-heading">
        <div>
          <p>{ownerName ? `${ownerName} · Workspace configuration` : creatingWorkspace ? "Create workspace" : "Workspace configuration"}</p>
          <h1>{workspaceName(selectedWorkspace ?? { grantId: selectedGrantId })}</h1>
          <span>{ownerName ? "Manage this member’s policy-bounded workspace configuration. Profile, application, agent, and model changes apply after the workspace restarts." : creatingWorkspace ? "Choose the profile, applications, agents, and model before ONEComputer starts this workspace." : "Changes are recorded as a policy-bounded configuration document and apply the next time this workspace starts."}</span>
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
  "asana", "atlassian", "box", "cloudflare", "figma", "github", "hubspot", "intercom",
  "linear", "microsoft", "neon", "notion", "slack", "stripe", "supabase", "vercel",
]);

function ConnectorMark({ connector, large = false }) {
  const brand = connector?.brand ?? "microsoft";
  if (connector?.iconDataUrl) {
    return <span className={`connector-mark uploaded${large ? " large" : ""}`} aria-hidden="true"><img src={connector.iconDataUrl} alt="" /></span>;
  }
  const iconBrand = connectorIconBrands.has(brand) ? brand : connectorIconBrands.has(connector?.id) ? connector.id : null;
  if (iconBrand) {
    return <span className={`connector-mark branded ${iconBrand}${large ? " large" : ""}`} aria-hidden="true"><img src={`/connector-icons/${iconBrand}.svg`} alt="" /></span>;
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
        <span>These controls apply to every ME TECH member and are enforced by Control.</span>
      </div>
      <label><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>Connector enabled</strong><small>Assigned workspaces may use approved tools from this service.</small></span></label>
      <label><input type="checkbox" checked={membersCanManage} disabled={busy || !enabled} onChange={(event) => setMembersCanManage(event.target.checked)} /><span><strong>Members can manage connections</strong><small>Members may connect and disconnect their own work account.</small></span></label>
      <button className="primary-button compact-button" type="button" disabled={busy || !dirty} onClick={() => onSave(connector.id, { enabled, membersCanManage })}>{busy ? "Saving policy" : "Save access policy"}</button>
    </section>
  );
}

function Microsoft365Detail({ connection, loading, busy, onConnect, onDisconnect, onAccessPolicySave, displayName, isAdmin, activeTab, onTabChange, onBack, mcpPolicy, policyLoading, policySaving, onPolicyChange, onPolicySave }) {
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
        {isAdmin && <button className={activeTab === "tools" ? "active" : ""} type="button" onClick={() => onTabChange("tools")}>Tools &amp; approvals</button>}
      </nav>

      {activeTab === "tools" && isAdmin ? (
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
          {isAdmin && <ConnectorAccessPolicyCard connector={connection} busy={busy} onSave={onAccessPolicySave} />}
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

function HostedConnectorDetail({ connector, loading, busy, onConnect, onDisconnect, onIconChange, onAccessPolicySave, onBack, isAdmin, activeTab, onTabChange, mcpPolicy, policyLoading, policySaving, onPolicyChange, onPolicySave }) {
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
        {isAdmin && connected && <button className={activeTab === "tools" ? "active" : ""} type="button" onClick={() => onTabChange("tools")}>Tools &amp; approvals</button>}
      </nav>

      {activeTab === "tools" && isAdmin && connected ? (
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
        {isAdmin && <ConnectorAccessPolicyCard connector={connector} busy={busy} onSave={onAccessPolicySave} />}
        <div className="connector-policy-note">
          <Info24Regular aria-hidden="true" />
          <p><strong>{connector.policySupport === "governed" ? "Approved tools available" : "Available to your workspace agents"}</strong>{connector.policySupport === "governed"
            ? "Your organization decides which tools each workspace can use."
            : "Once connected, this service and its available tools are added to your workspace agents automatically."}</p>
        </div>
        {isAdmin && connector.source === "custom" && <ConnectorIconEditor connector={connector} busy={busy} onSave={onIconChange} />}
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
        <label><span>Category</span><SelectMenu value={draft.category} onValueChange={(value) => update("category", value)} ariaLabel="Connector category" disabled={Boolean(busy)} options={["Productivity", "Developer tools", "Business", "Communication", "Data and analytics", "Other"].map((value) => ({ value, label: value }))} /></label>
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
      {checked && <div className="connector-discovery-result" role="status"><CheckmarkCircle24Regular aria-hidden="true" /><span><strong>Connection flow verified</strong>{checked.dynamicClientRegistration ? "Connection setup is automatic. No provider credentials are needed." : "The provider app is ready to use."}</span></div>}
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

function ConnectionsScreen({ connections, loading, busyConnectorId, error, onConnect, onDisconnect, onIconChange, onAccessPolicySave, onAddConnector, displayName, isAdmin, view, onViewChange, mcpPolicy, policyLoading, policySaving, onPolicyChange, onPolicySave }) {
  const microsoft = connections.find((connector) => connector.id === "microsoft-365");
  if (view !== "list") {
    if (view.startsWith("microsoft365-") && microsoft) {
      return <Microsoft365Detail connection={microsoft} loading={loading} busy={busyConnectorId === microsoft.id} onConnect={() => onConnect(microsoft.id)} onDisconnect={() => onDisconnect(microsoft)} onAccessPolicySave={onAccessPolicySave} displayName={displayName} isAdmin={isAdmin} activeTab={view === "microsoft365-tools" ? "tools" : "overview"} onTabChange={(tab) => onViewChange(`microsoft365-${tab}`)} onBack={() => onViewChange("list")} mcpPolicy={mcpPolicy} policyLoading={policyLoading} policySaving={policySaving} onPolicyChange={onPolicyChange} onPolicySave={onPolicySave} />;
    }
    const selected = connections.find((connector) => view === `connector-${connector.id}` || view === `connector-${connector.id}-tools`);
    if (selected) {
      return <HostedConnectorDetail connector={selected} loading={loading} busy={busyConnectorId === selected.id} onConnect={onConnect} onDisconnect={onDisconnect} onIconChange={onIconChange} onAccessPolicySave={onAccessPolicySave} onBack={() => onViewChange("list")} isAdmin={isAdmin} activeTab={view.endsWith("-tools") ? "tools" : "overview"} onTabChange={(tab) => onViewChange(tab === "tools" ? `connector-${selected.id}-tools` : `connector-${selected.id}`)} mcpPolicy={mcpPolicy?.connectorId === selected.id ? mcpPolicy : null} policyLoading={policyLoading} policySaving={policySaving} onPolicyChange={onPolicyChange} onPolicySave={onPolicySave} />;
    }
  }
  const categories = ["Productivity", "Developer tools", "Business", "Communication", "Data and analytics", "Other"];
  return (
    <div className="secondary-screen connections-screen">
      <div className="connections-page-intro">
        <header className="page-heading compact">
          <p>Your services</p>
          <h1>Connections</h1>
          <span>Connect the work services you want to use. Connected services become available to your workspace agents automatically.</span>
        </header>
        {isAdmin && <button className="primary-button connections-add-button" type="button" onClick={onAddConnector}><Add24Regular aria-hidden="true" />Add connector</button>}
      </div>

      {error && <div className="connection-error" role="alert"><Info24Regular aria-hidden="true" /><span><strong>The connection was not updated</strong>{error}</span></div>}

      {categories.map((category) => {
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
                      {isAdmin && connector.source === "custom" && !connected && <button className="connector-manage-link" type="button" onClick={() => onViewChange(`connector-${connector.id}`)}>Manage</button>}
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

function CoworkScreen({ workspace, workspaces, workspaceState, onWorkspaceChange, onStartWorkspace }) {
  const [title, setTitle] = useState("Executive update");
  const [body, setBody] = useState("Summarize the completed work and its next decisions.");
  const [task, setTask] = useState(() => {
    const id = new URL(window.location.href).searchParams.get("coworkTask");
    return id ? { id } : null;
  });
  const [events, setEvents] = useState([]);
  const [frames, setFrames] = useState([]);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);
  const [artifact, setArtifact] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshEvidence = async (taskId = task?.id) => {
    if (!workspace || !taskId) return;
    const [timeline, replay] = await Promise.all([
      oneVibeApi.events(workspace.id, taskId),
      oneVibeApi.vcr(workspace.id, taskId),
    ]);
    setEvents(timeline.events ?? []);
    setFrames(replay.frames ?? []);
  };

  const setActiveTask = (nextTask) => {
    setTask(nextTask);
    const url = new URL(window.location.href);
    if (nextTask?.id) url.searchParams.set("coworkTask", nextTask.id);
    else url.searchParams.delete("coworkTask");
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  };

  useEffect(() => {
    const taskId = new URL(window.location.href).searchParams.get("coworkTask");
    setTask(taskId ? { id: taskId } : null);
    setEvents([]);
    setFrames([]);
    setSelectedFrameIndex(0);
    setArtifact(null);
    setError("");
  }, [workspace?.id]);

  useEffect(() => {
    if (!task?.id || !workspace) return undefined;
    void refreshEvidence(task.id).catch((requestError) => setError(requestError.message));
    const timer = window.setInterval(() => { void refreshEvidence(task.id).catch(() => undefined); }, 2_500);
    return () => window.clearInterval(timer);
  }, [task?.id, workspace?.id]);

  useEffect(() => {
    setSelectedFrameIndex((current) => Math.min(current, Math.max(0, frames.length - 1)));
  }, [frames.length]);

  const startTask = async () => {
    if (!workspace) return;
    setBusy(true); setError(""); setArtifact(null);
    try {
      const created = await oneVibeApi.createTask(workspace.id);
      setActiveTask(created.task);
      await refreshEvidence(created.task.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };

  const generatePresentation = async () => {
    if (!workspace) return;
    setBusy(true); setError("");
    try {
      let currentTask = task;
      if (!currentTask) {
        const created = await oneVibeApi.createTask(workspace.id);
        currentTask = created.task;
        setActiveTask(currentTask);
      }
      const created = await oneVibeApi.createPresentation(workspace.id, currentTask.id, { title, body });
      setArtifact(created.artifact);
      await refreshEvidence(currentTask.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };

  const workspaceOptions = workspaces?.map((item) => ({ value: item.id, label: workspaceName(item) })) ?? [];
  const workspaceReady = workspace && ["ready", "open"].includes(workspaceState);
  const selectedFrame = frames[selectedFrameIndex];
  return (
    <section className="cowork-screen" aria-labelledby="cowork-heading">
      <header className="page-heading">
        <p>ONEVibe</p><h1 id="cowork-heading">Cowork</h1>
        <span>Direct a governed task, inspect its visual evidence, and collect its editable output.</span>
      </header>
      <div className="cowork-context">
        <SelectMenu value={workspace?.id ?? ""} onValueChange={onWorkspaceChange} ariaLabel="Choose Cowork workspace" options={workspaceOptions} />
        {!workspaceReady && workspace && <button className="secondary-button" type="button" onClick={onStartWorkspace} disabled={busy}>Start workspace</button>}
      </div>
      {!workspace && <div className="cowork-empty">Choose a workspace to begin a Cowork task.</div>}
      {workspace && <div className="cowork-grid">
        <section className="cowork-card cowork-task">
          <div><span className="cowork-eyebrow">Task output</span><h2>Create a PowerPoint</h2></div>
          <label>Slide title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength="180" disabled={busy || !workspaceReady} /></label>
          <label>Slide content<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength="4000" rows="7" disabled={busy || !workspaceReady} /></label>
          <div className="cowork-actions">
            <button className="secondary-button" type="button" onClick={startTask} disabled={busy || !workspaceReady}>{task ? "Start new task" : "Start task"}</button>
            <button className="primary-button" type="button" onClick={generatePresentation} disabled={busy || !workspaceReady}>{busy ? "Working…" : "Generate PowerPoint"}</button>
          </div>
          {artifact && <a className="cowork-artifact" href={`/api${artifact.downloadUrl}`}><Document24Regular aria-hidden="true" /><span><strong>{artifact.name}</strong><small>Editable PowerPoint · {Math.ceil(artifact.sizeBytes / 1024)} KB</small></span><ChevronRight16Regular aria-hidden="true" /></a>}
          {error && <p className="cowork-error" role="alert">{error}</p>}
        </section>
        <section className="cowork-card cowork-replay" aria-live="polite">
          <div><span className="cowork-eyebrow">VCR</span><h2>Execution replay</h2></div>
          {selectedFrame ? <div className="cowork-vcr-player">
            <img src={`/api${selectedFrame.frameUrl}`} alt={`${selectedFrame.sourceApplication} frame at event ${selectedFrame.eventSequence}`} />
            <div className="cowork-scrubber"><input aria-label="Scrub VCR timeline" type="range" min="0" max={Math.max(0, frames.length - 1)} value={selectedFrameIndex} onChange={(event) => setSelectedFrameIndex(Number(event.target.value))} /><span>Event {selectedFrame.eventSequence} · {selectedFrame.sourceApplication}</span></div>
            <div className="cowork-frame-strip">{frames.map((frame, index) => <button key={frame.eventSequence} className={index === selectedFrameIndex ? "active" : ""} type="button" onClick={() => setSelectedFrameIndex(index)}><img src={`/api${frame.frameUrl}`} alt="" /><small>Event {frame.eventSequence}</small></button>)}</div>
          </div> : <p className="cowork-muted">Visual evidence appears here when the task’s browser or desktop capture sidecar records an authorized frame.</p>}
          <ol className="cowork-timeline">{events.map((event) => <li key={event.sequence}><span>{event.sequence}</span><strong>{event.kind.replaceAll("-", " ")}</strong><time>{new Date(event.createdAt).toLocaleTimeString()}</time></li>)}</ol>
        </section>
      </div>}
    </section>
  );
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
  const sessionRef = useRef(activeSessionId);
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
  const activityTurns = messages
    .filter((message) => message.role === "assistant" && message.metadata?.turnId)
    .map((message) => message.metadata.turnId);
  const latestActivityTurnId = activityTurns.at(-1) ?? "";

  useEffect(() => {
    if (latestActivityTurnId) setSelectedActivityTurnId(latestActivityTurnId);
  }, [latestActivityTurnId]);

  useEffect(() => {
    sessionRef.current = activeSessionId;
    if (!activeSessionId) {
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
    if (loadedSessionRef.current === activeSessionId) return undefined;
    let active = true;
    setHistoryState("loading");
    setHistoryError("");
    setSelectedActivityTurnId("");
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
  }, [activeSessionId, workspaceId, agentId, historyReload, setMessages, clearError]);

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
  const awaitingAssistant = status === "submitted" && visibleMessages.at(-1)?.role === "user";
  const needsInput = !busy
    && visibleMessages.at(-1)?.role === "assistant"
    && visibleMessages.at(-1)?.metadata?.state === "needs_input";
  const messageField = (
    <>
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
        placeholder={needsInput ? `Reply to ${agentName}` : `Message ${agentName}`}
        rows="1"
        maxLength="16000"
        disabled={historyState === "loading"}
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
      <div className="chat-transcript" ref={transcriptRef} aria-live="polite" aria-busy={busy || historyState === "loading"}>
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
          <article className="chat-message system chat-acknowledgement" aria-label="ONEComputer received your message">
            <span>ONEComputer</span>
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
                disabled={busy || attachmentBusy || historyState === "loading"}
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
                      onSessionChange("");
                    }}
                  >
                    <Add24Regular aria-hidden="true" />New conversation
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
                        className={session.value === activeSessionId ? "active" : ""}
                        type="button"
                        key={session.value}
                        onClick={() => {
                          setChatActionsOpen(false);
                          onSessionChange(session.value);
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
            {busy ? (
              <button className="chat-stop-button" type="button" aria-label={`Stop ${agentName}`} onClick={() => { void stop(); }}><Dismiss24Regular aria-hidden="true" /></button>
            ) : (
              <button className="chat-send-button" type="submit" aria-label="Send message" disabled={(!input.trim() && !attachments.length) || attachmentBusy || historyState === "loading"}><ArrowUp24Regular aria-hidden="true" /></button>
            )}
          </div>
        ) : (
          <>
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
            {messageField}
            {busy ? (
              <button className="chat-stop-button" type="button" aria-label={`Stop ${agentName}`} onClick={() => { void stop(); }}><Dismiss24Regular aria-hidden="true" /></button>
            ) : (
              <button className="chat-send-button" type="submit" aria-label="Send message" disabled={(!input.trim() && !attachments.length) || attachmentBusy || historyState === "loading"}><ArrowUp24Regular aria-hidden="true" /></button>
            )}
          </>
        )}
      </form>
    </section>
      <ActivityPanel
        open={activityOpen}
        workspaceId={workspaceId}
        agentId={agentId}
        sessionId={activeSessionId}
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
  const hasContextControls = workspaceOptions.length > 0 || agents.length > 0;
  const contextControls = hasContextControls ? (
    <>
      {workspaceOptions.length > 0 && <div className="chat-agent-selector">
        <span className="chat-agent-selector-label">Workspace</span>
        <SelectMenu
          value={workspace?.id ?? ""}
          onValueChange={onWorkspaceChange}
          ariaLabel="Choose workspace"
          options={workspaceOptions.map((item) => ({ value: item.id, label: workspaceName(item) }))}
        />
      </div>}
      {agents.length > 0 && <div className="chat-agent-selector">
        <span className="chat-agent-selector-label">Agent</span>
        <SelectMenu
          value={activeAgentId}
          onValueChange={selectAgent}
          ariaLabel="Choose chat agent"
          options={agentOptions}
        />
      </div>}
    </>
  ) : null;
  const contextSelector = contextControls ? (
    <div className="chat-context-selectors">
      {contextControls}
    </div>
  ) : null;
  const contextSummary = [agentName, workspace ? workspaceName(workspace) : ""]
    .filter(Boolean)
    .join(" · ");
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
      {!companionComposer && contextSelector}
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
        companionComposer={companionComposer}
        composerContext={companionComposer && contextControls ? <div className="companion-chat-composer-context-fields">{contextControls}</div> : null}
        contextSummary={contextSummary}
        skills={skills}
        sessionOptions={[
          { value: "", label: "New conversation" },
          ...sessions.map((session, index) => ({
            value: session.id,
            label: session.title || `Conversation ${sessions.length - index}`,
          })),
        ]}
        historyHasMore={historyHasMore}
        historyLoadingMore={historyLoadingMore}
        onLoadOlder={onLoadOlder}
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
  const [adminWorkspaceTarget, setAdminWorkspaceTarget] = useState(null);
  const [adminSandboxSettings, setAdminSandboxSettings] = useState(null);
  const [adminSandboxLoading, setAdminSandboxLoading] = useState(false);
  const [adminSandboxSaving, setAdminSandboxSaving] = useState(false);
  const [adminSandboxError, setAdminSandboxError] = useState("");
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
  const profileRef = useRef(null);
  const profilePopoverRefs = useMemo(() => [profileRef], []);

  useDismissOnOutside(profileOpen, () => setProfileOpen(false), profilePopoverRefs);

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
      if (name === "Connections") {
        setConnectionsView("list");
        setConnectionCatalogRefresh((current) => current + 1);
      }
      if (name === "Settings") setSettingsView("overview");
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
    if (!session || activeNav !== "Settings" || settingsView !== "provider-settings" || !session.roles.includes("administrator")) return undefined;
    let active = true;
    setProviderSettingsLoading(true);
    adminApi.providerSettings()
      .then((value) => { if (active) { setProviderSettings(value.providers); setProviderSettingsError(""); } })
      .catch((error) => { if (active) setProviderSettingsError(error.message); })
      .finally(() => { if (active) setProviderSettingsLoading(false); });
    return () => { active = false; };
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
    if (activeNav !== "Connections" || !session?.roles.includes("administrator") || !connectionsView.endsWith("-tools")) return;
    const hosted = mcpConnections.find((connector) => connectionsView === `connector-${connector.id}-tools`);
    setMcpPolicyLoading(true);
    (connectionsView === "microsoft365-tools"
      ? adminApi.mcpPolicy()
      : hosted
        ? adminApi.connectorToolPolicy(hosted.id)
        : Promise.reject(new Error("That connector is unavailable.")))
      .then(setMcpPolicy)
      .catch(showApiError)
      .finally(() => setMcpPolicyLoading(false));
  }, [activeNav, connectionsView, session?.user.id, mcpConnections]);

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
      description: `ONEComputer will revoke this connection. Your ${connector.name} account and provider data will not be deleted.`,
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
      const failures = result.workspaceGrants?.failed ?? 0;
      setToast(failures
        ? `Connector access policy saved. ${failures} workspace grant refreshes failed and will retry automatically.`
        : "Connector access policy is active for the organization.");
      return result.connector;
    } catch (error) {
      setConnectionError(error.message);
      throw error;
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
    if (name === "Connections") {
      setConnectionsView("list");
      setConnectionCatalogRefresh((current) => current + 1);
    }
    if (name === "Settings") setSettingsView("overview");
    if (name === "Sites") setSitesError("");
    if (name === "Workspace") { setSelectedSandboxGrantId(null); setSandboxSettings(null); setSandboxError(""); }
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
  const changeUserStatus = async (user, status) => {
    const suspending = status === "disabled";
    if (!await requestConfirmation({
      title: suspending ? `Suspend ${user.displayName}?` : `Reactivate ${user.displayName}?`,
      description: suspending
        ? "Their browser sessions and active workspace gateway grants will be revoked immediately. Persistent workspace storage is retained."
        : "They will be able to sign in again. Workspace access will resume from their existing organization policy.",
      confirmLabel: suspending ? "Suspend user" : "Reactivate user",
      danger: suspending,
    })) return;
    setAdminBusyUserId(user.userId);
    try {
      await adminApi.setUserStatus(user.userId, status);
      await refreshAdminUsers();
      setToast(suspending ? `${user.displayName} was suspended.` : `${user.displayName} was reactivated.`);
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
  const manageAdminWorkspace = async (user, workspace) => {
    const target = { user, workspace };
    setAdminWorkspaceTarget(target);
    setSettingsView("admin-workspace");
    setAdminSandboxSettings(null);
    setAdminSandboxError("");
    setAdminSandboxLoading(true);
    try {
      setAdminSandboxSettings(await adminApi.sandboxSettings(user.userId, workspace.grantId));
    } catch (error) {
      setAdminSandboxError(error.message);
    } finally {
      setAdminSandboxLoading(false);
    }
  };
  const closeAdminWorkspace = () => {
    setSettingsView("admin");
    setAdminWorkspaceTarget(null);
    setAdminSandboxSettings(null);
    setAdminSandboxError("");
  };
  const saveAdminSandbox = async (configuration) => {
    if (!adminWorkspaceTarget) return;
    setAdminSandboxSaving(true);
    setAdminSandboxError("");
    try {
      const { securityGroupVersionId, ...sandboxConfiguration } = configuration;
      if (securityGroupVersionId && securityGroupVersionId !== adminSandboxSettings?.securityGroup?.id) {
        await adminApi.assignUserWorkspaceEgressSecurityGroup(
          adminWorkspaceTarget.user.userId,
          configuration.grantId,
          securityGroupVersionId,
        );
      }
      setAdminSandboxSettings(await adminApi.saveSandboxSettings(adminWorkspaceTarget.user.userId, sandboxConfiguration));
      await refreshAdminUsers();
      setToast(`${adminWorkspaceTarget.user.displayName}’s workspace configuration was saved. Restart it to apply profile, app, agent, or model changes.`);
    } catch (error) {
      setAdminSandboxError(error.message);
    } finally {
      setAdminSandboxSaving(false);
    }
  };
  const assignAdminWorkspaceSecurityGroup = async (grantId, securityGroupVersionId) => {
    if (!adminWorkspaceTarget) return;
    setAdminSandboxSaving(true);
    setAdminSandboxError("");
    try {
      const assigned = await adminApi.assignUserWorkspaceEgressSecurityGroup(
        adminWorkspaceTarget.user.userId,
        grantId,
        securityGroupVersionId,
      );
      setAdminSandboxSettings(await adminApi.sandboxSettings(adminWorkspaceTarget.user.userId, grantId));
      setToast(`${assigned.name} is now active for ${adminWorkspaceTarget.user.displayName}.`);
    } catch (error) {
      setAdminSandboxError(error.message);
    } finally {
      setAdminSandboxSaving(false);
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
    try {
      const decisions = Object.fromEntries(mcpPolicy.tools.map((tool) => [tool.name, tool.decision]));
      if (mcpPolicy.connectorId) {
        const refreshed = await adminApi.saveConnectorToolPolicy(mcpPolicy.connectorId, decisions);
        setMcpPolicy(refreshed);
        setToast(`${mcpPolicy.connectorName} tool and approval rules are active.`);
        return;
      }
      const saved = await adminApi.saveMcpPolicy(decisions);
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
          <NavButton active={activeNav === "Schedules"} icon={Calendar24Regular} label="Schedules" onClick={() => selectNav("Schedules")} />
          <NavButton active={activeNav === "Sites"} icon={activeNav === "Sites" ? Apps24Filled : Apps24Regular} label="Sites" onClick={() => selectNav("Sites")} />
          <NavButton active={activeNav === "Trail"} icon={Clock24Regular} label="Trail" onClick={() => selectNav("Trail")} />
          {session.roles.includes("administrator") && <NavButton active={activeNav === "Firewall"} icon={ShieldCheckmark24Regular} label="Firewall" onClick={() => selectNav("Firewall")} />}
          <NavButton active={activeNav === "Connections"} icon={PlugConnected24Regular} label="Connections" onClick={() => selectNav("Connections")} />
          <NavButton active={activeNav === "Cowork"} icon={Document24Regular} label="Cowork" onClick={() => selectNav("Cowork")} />
          <NavButton active={activeNav === "Chat"} icon={Bot24Regular} label="Chat" onClick={() => selectNav("Chat")} />
          {activeNav === "Chat" && <div className="sidebar-chat-history" aria-label="Recent chat threads">
            <div className="sidebar-chat-history-heading"><span>Recent</span><button type="button" aria-label="Start a new chat" title="Start a new chat" onClick={() => { selectChatSession(""); setMobileNavOpen(false); }}><Add24Regular aria-hidden="true" /></button></div>
            {chatSessions.length === 0
              ? <p>No recent chats</p>
              : chatSessions.map((item, index) => <button key={item.id} className={activeChatSessionId === item.id ? "active" : ""} type="button" onClick={() => { selectChatSession(item.id); setMobileNavOpen(false); }} aria-current={activeChatSessionId === item.id ? "true" : undefined}>{item.title || `Conversation ${chatSessions.length - index}`}</button>)}
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
        {activeNav === "Cowork" && <CoworkScreen
          workspace={workspace}
          workspaces={homeWorkspaces}
          workspaceState={workspaceState}
          onWorkspaceChange={selectActiveWorkspace}
          onStartWorkspace={openWorkspace}
        />}
        {activeNav === "Chat" && <ChatScreen
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
            connections={mcpConnections}
            loading={connectionLoading}
            busyConnectorId={connectionBusy}
            error={connectionError}
            onConnect={connectMcpConnector}
            onDisconnect={disconnectMcpConnector}
            onIconChange={saveConnectorIcon}
            onAccessPolicySave={saveConnectorAccessPolicy}
            onAddConnector={() => setConnectorDialogOpen(true)}
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
          currentUserId={session.user.id}
          onOpenAdmin={() => setSettingsView("admin")}
          onOpenCredentials={() => setSettingsView("credentials")}
          onOpenProviderSettings={() => setSettingsView("provider-settings")}
          onBack={() => setSettingsView("overview")}
          credentials={credentials}
          workspaces={homeWorkspaces}
          credentialsLoading={credentialsLoading}
          credentialsBusy={credentialsBusy}
          credentialsError={credentialsError}
          onCreateCredential={createTelegramCredential}
          onRotateCredential={rotateTelegramCredential}
          onDeleteCredential={deleteTelegramCredential}
          providerSettings={providerSettings}
          providerSettingsLoading={providerSettingsLoading}
          providerSettingsBusy={providerSettingsBusy}
          providerSettingsError={providerSettingsError}
          onSaveProviderSetting={saveProviderSetting}
          onTestProviderSetting={testProviderSetting}
          onDisableProviderSetting={disableProviderSetting}
          onDeleteProviderSetting={deleteProviderSetting}
          users={adminUsers}
          loading={adminLoading}
          busyUserId={adminBusyUserId}
          onAssign={assignPolicy}
          onRevoke={revokePolicy}
          onStatusChange={changeUserStatus}
          onRevokeSessions={revokeUserSessions}
          onManageWorkspace={manageAdminWorkspace}
          adminWorkspaceTarget={adminWorkspaceTarget}
          adminSandboxSettings={adminSandboxSettings}
          adminSandboxLoading={adminSandboxLoading}
          adminSandboxSaving={adminSandboxSaving}
          adminSandboxError={adminSandboxError}
          onSaveAdminSandbox={saveAdminSandbox}
          onAssignAdminSecurityGroup={assignAdminWorkspaceSecurityGroup}
          onCloseAdminWorkspace={closeAdminWorkspace}
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

      {connectorDialogOpen && <AddConnectorDialog onCreated={connectorCreated} onClose={() => setConnectorDialogOpen(false)} />}
      {toast && <div className="toast" role="status" aria-live="polite"><CheckmarkCircle24Regular aria-hidden="true" />{toast}</div>}
    </div>
  );
}
