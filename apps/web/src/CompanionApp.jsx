import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise24Regular } from "@fluentui/react-icons/svg/arrow-clockwise";
import { CheckmarkCircle24Regular } from "@fluentui/react-icons/svg/checkmark-circle";
import { ChevronRight16Regular } from "@fluentui/react-icons/svg/chevron-right";
import { Clock24Regular } from "@fluentui/react-icons/svg/clock";
import { History24Regular } from "@fluentui/react-icons/svg/history";
import { Info24Regular } from "@fluentui/react-icons/svg/info";
import { ShieldCheckmark24Regular } from "@fluentui/react-icons/svg/shield-checkmark";
import { SignOut24Regular } from "@fluentui/react-icons/svg/sign-out";
import { ChatScreen } from "./App.jsx";
import { approvalApi, authApi, workspaceApi } from "./workspace-api.js";
import {
  clearBrowserApprover,
  enrollBrowserApprover,
  getBrowserApproverIdentity,
  loadPendingApproval,
  signApprovalDecision,
} from "./openvtc-browser-agent.js";
import {
  companionPushSupport,
  enableCompanionPush,
  removeCompanionPush,
} from "./companion-push.js";
import { ConfirmDialog } from "./ui.jsx";
import { reconcileWorkspaceInventory, replaceWorkspaceInInventory } from "./workspace-inventory.js";
import "./companion.css";

const PROTOCOL_VERSION = "lemmacomputer-companion-push-0.1";
const workspacePreferenceKey = "lemmacomputer.active-workspace-id";
const chatAgentPreferenceKey = (workspaceId) => `lemmacomputer.active-chat-agent:${workspaceId}`;

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
    // A blocked storage area must not prevent Companion chat from being used.
  }
};

const companionViewFromLocation = () => (
  new URLSearchParams(window.location.search).get("view") === "chat" ? "chat" : "companion"
);

const companionChatSessionFromLocation = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "chat" ? params.get("chat") ?? "" : "";
};

const companionTabFromLocation = () => (
  new URLSearchParams(window.location.search).get("tab") === "activity" ? "activity" : "approvals"
);

const companionLoginUrl = () => {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  return `/api/v1/auth/login?return=${encodeURIComponent(returnTo)}`;
};

const formatTime = (value) => value
  ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "Not yet";

const activityState = {
  approval_required: { label: "Awaiting approval", tone: "attention" },
  approved: { label: "Approved", tone: "progress" },
  executing: { label: "In progress", tone: "progress" },
  succeeded: { label: "Completed", tone: "success" },
  denied: { label: "Denied", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  failed: { label: "Couldn’t complete", tone: "danger" },
};

function Brand() {
  return <div className="companion-brand" aria-label="LemmaComputer"><strong>Lemma</strong><span>Computer</span><em>Companion</em></div>;
}

function CompanionSignIn({ error }) {
  return (
    <main className="companion-auth">
      <section>
        <Brand />
        <div className="companion-auth-icon"><ShieldCheckmark24Regular aria-hidden="true" /></div>
        <p>Approval companion</p>
        <h1>Review protected actions without opening your workspace.</h1>
        <span>Sign in with your work account. Notifications contain no task details and can never approve an action.</span>
        {error && <div className="companion-message error" role="alert">{error}</div>}
        <a className="companion-primary" href={companionLoginUrl()}>Sign in to Companion</a>
      </section>
    </main>
  );
}

function ReadinessItem({ ready, label, detail }) {
  return (
    <li className={ready ? "ready" : "attention"}>
      {ready ? <CheckmarkCircle24Regular aria-hidden="true" /> : <Info24Regular aria-hidden="true" />}
      <span><strong>{label}</strong><small>{detail}</small></span>
    </li>
  );
}

function ApprovalCard({ request, busy, message, onDecision }) {
  const effect = request.payload.effects?.[0];
  return (
    <section className="companion-task" aria-labelledby="companion-task-title">
      <div className="companion-task-kicker"><span>Approval needed</span><Clock24Regular aria-hidden="true" /></div>
      <h2 id="companion-task-title">{effect?.summary ?? "Review protected operation"}</h2>
      <p>The action has not run. Verify the signed request below before deciding.</p>
      <dl>
        <div><dt>Effect</dt><dd>{request.payload.sideEffects}</dd></div>
        <div><dt>Requested by</dt><dd>{request.payload.requester}</dd></div>
        <div><dt>Expires</dt><dd>{formatTime(request.payload.expiresAt)}</dd></div>
        <div><dt>Exact binding</dt><dd><code>{request.payload.payloadDigest.slice(0, 18)}…</code></dd></div>
      </dl>
      {request.payload.consequences?.[0] && <div className="companion-warning"><Info24Regular aria-hidden="true" /><span>{request.payload.consequences[0]}</span></div>}
      {message && <div className="companion-message error" role="alert">{message}</div>}
      <div className="companion-decision-actions">
        <button className="companion-primary" type="button" disabled={busy} onClick={() => onDecision("approve")}>
          <ShieldCheckmark24Regular aria-hidden="true" />{busy ? "Verifying device" : "Verify and approve"}
        </button>
        <button className="companion-secondary danger" type="button" disabled={busy} onClick={() => onDecision("deny")}>Deny request</button>
      </div>
      <small className="companion-gesture-note">Each decision requires your device PIN, biometric, or security key and applies only to this exact signed request.</small>
    </section>
  );
}

function ActivityStatus({ state }) {
  const status = activityState[state] ?? { label: "Updated", tone: "neutral" };
  return <span className={`companion-status ${status.tone}`}>{status.label}</span>;
}

function ActivityView({
  activities,
  loading,
  error,
  nextCursor,
  selectedId,
  detail,
  detailLoading,
  onRefresh,
  onLoadMore,
  onSelect,
  onReviewPending,
}) {
  return (
    <section className="companion-activity-card" aria-labelledby="companion-activity-title">
      <div className="companion-activity-header">
        <div>
          <p>Request history</p>
          <h2 id="companion-activity-title">Protected activity</h2>
          <span>Expand a request to review what was requested and its lifecycle evidence. Historical entries are always read-only.</span>
        </div>
        <button className="companion-secondary compact" type="button" disabled={loading} onClick={onRefresh}>
          <ArrowClockwise24Regular aria-hidden="true" />Refresh
        </button>
      </div>

      {error && <div className="companion-message error" role="alert">{error}</div>}
      {!loading && activities.length === 0 ? (
        <div className="companion-activity-empty">
          <History24Regular aria-hidden="true" />
          <strong>No protected requests yet</strong>
          <span>Requests that require approval will appear here when your workspace agent makes them.</span>
        </div>
      ) : (
        <div className="companion-activity-list" aria-busy={loading && activities.length === 0}>
          {activities.map((item) => (
            <article className={`companion-activity-item${selectedId === item.id ? " selected" : ""}`} key={item.id}>
              <button type="button" onClick={() => onSelect(item.id)} aria-expanded={selectedId === item.id}>
                <div className="companion-activity-item-main">
                  <div className="companion-activity-item-heading">
                    <strong>{item.request.action}</strong>
                    <ActivityStatus state={item.state} />
                  </div>
                  <span>{item.request.target.name}{item.request.target.context ? ` · ${item.request.target.context}` : ""}</span>
                  <small>{formatTime(item.audit.requestedAt)} · {item.audit.requestedBy}</small>
                </div>
                <ChevronRight16Regular aria-hidden="true" />
              </button>

              {selectedId === item.id && (
                <div className="companion-activity-detail">
                  {detailLoading ? (
                    <span className="companion-detail-loading">Loading request timeline…</span>
                  ) : detail ? (
                    <>
                      <section className="companion-request-details" aria-labelledby={`request-details-${item.id}`}>
                        <h3 id={`request-details-${item.id}`}>Request details</h3>
                        <dl>
                          <div><dt>Action</dt><dd>{detail.activity.request.action}</dd></div>
                          <div><dt>{detail.activity.request.target.label}</dt><dd>{detail.activity.request.target.name}{detail.activity.request.target.context ? ` · ${detail.activity.request.target.context}` : ""}</dd></div>
                          {detail.activity.request.details.map((field, index) => (
                            <div className={field.format === "long-text" ? "long-text" : ""} key={`${field.label}-${index}`}>
                              <dt>{field.label}</dt><dd>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                      <section className="companion-audit-details" aria-labelledby={`audit-details-${item.id}`}>
                        <h3 id={`audit-details-${item.id}`}>Audit details</h3>
                        <dl>
                          <div><dt>Requested by</dt><dd>{detail.activity.audit.requestedBy}</dd></div>
                          <div><dt>Requested</dt><dd>{formatTime(detail.activity.audit.requestedAt)}</dd></div>
                          <div><dt>Last updated</dt><dd>{formatTime(detail.activity.audit.updatedAt)}</dd></div>
                          <div><dt>Decision</dt><dd>{detail.activity.audit.decision ? `${detail.activity.audit.decision.value === "approve" ? "Approved" : "Denied"} · ${formatTime(detail.activity.audit.decision.decidedAt)}` : "No decision recorded"}</dd></div>
                          <div><dt>Outcome</dt><dd>{detail.activity.audit.outcome ? `${detail.activity.audit.outcome.status === "succeeded" ? "Completed" : "Couldn’t complete"} · ${formatTime(detail.activity.audit.outcome.completedAt)}` : "Not completed"}</dd></div>
                        </dl>
                      </section>
                      <div className="companion-timeline">
                        <strong>Timeline</strong>
                        <ol>
                          {detail.timeline.map((event, index) => (
                            <li key={`${event.createdAt}-${index}`}>
                              <span aria-hidden="true" />
                              <div><strong>{event.label}</strong><small>{formatTime(event.createdAt)}</small></div>
                            </li>
                          ))}
                        </ol>
                      </div>
                      {item.state === "approval_required" && (
                        <button className="companion-secondary compact" type="button" onClick={onReviewPending}>Open live approval</button>
                      )}
                    </>
                  ) : null}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {loading && activities.length === 0 && <div className="companion-activity-loading">Loading your request history…</div>}
      {nextCursor && (
        <button className="companion-secondary companion-load-more" type="button" disabled={loading} onClick={onLoadMore}>
          {loading ? "Loading more" : "Load older requests"}
        </button>
      )}
    </section>
  );
}

function CompanionChatView({
  workspace,
  workspaces,
  workspaceState,
  workspaceError,
  onWorkspaceChange,
  onStartWorkspace,
  onRestartWorkspace,
  sessions,
  activeSessionId,
  onSessionChange,
  onSessionsChange,
  preferredAgentId,
  onAgentChange,
  historyHasMore,
  historyLoadingMore,
  historyLoadRequest,
  onLoadOlder,
  onHistoryMetadataChange,
}) {
  return (
    <section className="companion-chat-shell" aria-label="Chat with your workspace agent">
      {workspaceError && <div className="companion-message error companion-chat-error" role="alert">{workspaceError}</div>}
      <ChatScreen
        workspace={workspace}
        workspaces={workspaces}
        workspaceState={workspaceState}
        onWorkspaceChange={onWorkspaceChange}
        onStartWorkspace={onStartWorkspace}
        onRestartWorkspace={onRestartWorkspace}
        activeSessionId={activeSessionId}
        onSessionsChange={onSessionsChange}
        onSessionChange={onSessionChange}
        preferredAgentId={preferredAgentId}
        onAgentChange={onAgentChange}
        historyLoadRequest={historyLoadRequest}
        onHistoryMetadataChange={onHistoryMetadataChange}
        sessions={sessions}
        companionComposer
        historyHasMore={historyHasMore}
        historyLoadingMore={historyLoadingMore}
        onLoadOlder={onLoadOlder}
      />
    </section>
  );
}

export function CompanionApp() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [config, setConfig] = useState(null);
  const [localApprover, setLocalApprover] = useState(null);
  const [approverStatus, setApproverStatus] = useState(null);
  const [companion, setCompanion] = useState(null);
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [decisionMessage, setDecisionMessage] = useState("");
  const [terminal, setTerminal] = useState(null);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [activeView, setActiveView] = useState(companionViewFromLocation);
  const [activeTab, setActiveTab] = useState(companionTabFromLocation);
  const [activities, setActivities] = useState([]);
  const [activityCursor, setActivityCursor] = useState(null);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [selectedActivityId, setSelectedActivityId] = useState(null);
  const [activityDetail, setActivityDetail] = useState(null);
  const [activityDetailLoading, setActivityDetailLoading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [workspaceState, setWorkspaceState] = useState("loading");
  const [workspaceError, setWorkspaceError] = useState("");
  const [chatSessions, setChatSessions] = useState([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState(companionChatSessionFromLocation);
  const [chatAgentPreferences, setChatAgentPreferences] = useState({});
  const [chatHistoryHasMore, setChatHistoryHasMore] = useState(false);
  const [chatHistoryLoadingMore, setChatHistoryLoadingMore] = useState(false);
  const [chatHistoryLoadRequest, setChatHistoryLoadRequest] = useState(0);
  const activityDetailRequest = useRef(0);
  const support = useMemo(() => companionPushSupport(), [config]);

  useEffect(() => {
    document.title = "LemmaComputer Companion";
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = "/companion.webmanifest";
    document.head.append(manifest);
    const onInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    return () => {
      manifest.remove();
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
    };
  }, []);

  useEffect(() => {
    authApi.session()
      .then((value) => {
        setSession(value);
        setDisplayName(`${value.user.displayName}’s companion`);
      })
      .catch((error) => {
        if (error.code !== "UNAUTHENTICATED") setAuthError(error.message);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setActiveView(companionViewFromLocation());
      setActiveTab(companionTabFromLocation());
      setActiveChatSessionId(companionChatSessionFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!session) return undefined;
    let active = true;
    setWorkspaceError("");
    Promise.all([
      workspaceApi.current().catch((error) => {
        if (error.code === "WORKSPACE_NOT_FOUND") return null;
        throw error;
      }),
      workspaceApi.list(),
    ])
      .then(([current, result]) => {
        if (!active) return;
        const listed = result.workspaces ?? [];
        const nextWorkspaces = current && !listed.some((item) => item.id === current.id)
          ? [current, ...listed]
          : listed;
        const preferredId = readPreference(workspacePreferenceKey);
        const selected = nextWorkspaces.find((item) => item.id === preferredId)
          ?? current
          ?? nextWorkspaces[0]
          ?? null;
        setWorkspaces((current) => reconcileWorkspaceInventory(current, nextWorkspaces));
        setWorkspace(selected);
        setWorkspaceState(selected?.state ?? "not_created");
        writePreference(workspacePreferenceKey, selected?.id ?? "");
      })
      .catch((error) => {
        if (!active) return;
        setWorkspace(null);
        setWorkspaces([]);
        setWorkspaceState("failed");
        setWorkspaceError(error.message);
      });
    return () => { active = false; };
  }, [session]);

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [nextConfig, local, companionList] = await Promise.all([
        approvalApi.companionConfig(),
        getBrowserApproverIdentity(),
        approvalApi.companions(),
      ]);
      setConfig(nextConfig);
      setLocalApprover(local);
      if (local) {
        const remote = await approvalApi.status(local.did);
        setApproverStatus(remote);
        setCompanion(companionList.companions.find((item) => item.approverDid === local.did && item.status === "active") ?? null);
      } else {
        setApproverStatus(null);
        setCompanion(null);
      }
      setMessage("");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshPending = useCallback(async () => {
    if (!localApprover || !approverStatus?.connected) {
      setRequest(null);
      return;
    }
    try {
      const next = await loadPendingApproval(
        () => approvalApi.pending(localApprover.did),
        approverStatus.executorDid,
      );
      setRequest(next);
      setDecisionMessage("");
    } catch (error) {
      setRequest(null);
      setDecisionMessage(error.message);
    }
  }, [localApprover?.did, approverStatus?.connected, approverStatus?.executorDid]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    const openApproval = (event) => {
      if (event.data?.type !== "lemmacomputer-open-approvals") return;
      setActiveView("companion");
      setActiveTab("approvals");
      setTerminal(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      url.searchParams.delete("chat");
      url.searchParams.delete("tab");
      url.searchParams.set("from", "notification");
      window.history.replaceState({}, "", `${url.pathname}${url.search}`);
      refreshPending();
    };
    navigator.serviceWorker.addEventListener("message", openApproval);
    return () => navigator.serviceWorker.removeEventListener("message", openApproval);
  }, [refreshPending]);

  useEffect(() => {
    if (!session || !localApprover || !approverStatus?.connected) return undefined;
    refreshPending();
    const interval = window.setInterval(refreshPending, 5_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshPending();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, localApprover?.did, approverStatus?.connected, refreshPending]);

  const loadActivity = useCallback(async (cursor = null, append = false) => {
    if (!session) return;
    setActivityLoading(true);
    setActivityError("");
    try {
      const page = await approvalApi.companionActivity(cursor);
      setActivities((current) => append ? [...current, ...page.activities] : page.activities);
      setActivityCursor(page.nextCursor);
      setActivityLoaded(true);
    } catch (error) {
      setActivityError(error.message);
    } finally {
      setActivityLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (activeTab === "activity" && !activityLoaded && !activityLoading) loadActivity();
  }, [activeTab, activityLoaded, activityLoading, loadActivity]);

  const selectActivity = async (id) => {
    const requestNumber = activityDetailRequest.current + 1;
    activityDetailRequest.current = requestNumber;
    if (selectedActivityId === id) {
      setSelectedActivityId(null);
      setActivityDetail(null);
      setActivityDetailLoading(false);
      return;
    }
    setSelectedActivityId(id);
    setActivityDetail(null);
    setActivityDetailLoading(true);
    try {
      const nextDetail = await approvalApi.companionActivityDetail(id);
      if (activityDetailRequest.current === requestNumber) setActivityDetail(nextDetail);
    } catch (error) {
      if (activityDetailRequest.current === requestNumber) setActivityError(error.message);
    } finally {
      if (activityDetailRequest.current === requestNumber) setActivityDetailLoading(false);
    }
  };

  const refreshActivity = () => {
    activityDetailRequest.current += 1;
    setSelectedActivityId(null);
    setActivityDetail(null);
    setActivityDetailLoading(false);
    return loadActivity();
  };

  const subscribeCurrentBrowser = async (approver = localApprover) => {
    if (!config?.enabled || !config.vapidPublicKey) throw new Error("Web Push is not configured by your LemmaComputer administrator.");
    if (!approver) throw new Error("Enroll this browser’s approval key first.");
    const push = await enableCompanionPush(config.vapidPublicKey);
    return approvalApi.subscribeCompanion({
      version: PROTOCOL_VERSION,
      approverDid: approver.did,
      installationId: approver.installationId,
      ...push,
    });
  };

  const setup = async () => {
    setBusy("setup");
    setMessage("");
    try {
      if (!config?.enabled) throw new Error("Web Push is not configured by your LemmaComputer administrator.");
      const push = await enableCompanionPush(config.vapidPublicKey);
      const challenge = await approvalApi.challenge();
      await enrollBrowserApprover(
        challenge,
        displayName.trim() || `${session.user.displayName}’s companion`,
        (document) => approvalApi.enroll(challenge.id, document),
        (approverDid) => approvalApi.revoke(approverDid),
      );
      const local = await getBrowserApproverIdentity();
      if (!local) throw new Error("The browser approval key was not saved.");
      await approvalApi.subscribeCompanion({
        version: PROTOCOL_VERSION,
        approverDid: local.did,
        installationId: local.installationId,
        ...push,
      });
      setMessage("Companion is ready. This browser can now receive approval alerts.");
      await refresh();
    } catch (error) {
      setMessage(error.name === "NotAllowedError" ? "Device or notification permission was cancelled." : error.message);
    } finally {
      setBusy("");
    }
  };

  const enableNotifications = async () => {
    setBusy("notifications");
    setMessage("");
    try {
      await subscribeCurrentBrowser();
      setMessage("Notifications are enabled for this companion.");
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const decide = async (decision) => {
    if (!request) return;
    setBusy("decision");
    setDecisionMessage("");
    try {
      const signed = await signApprovalDecision(request, decision);
      const response = await approvalApi.decide(signed.transportToken, signed.document);
      setRequest(null);
      setTerminal({
        decision,
        state: response.operation.state,
        summary: decision === "approve"
          ? "Approved. LemmaComputer released one exact execution path."
          : "Denied. LemmaComputer will not release this operation.",
      });
      setActivityLoaded(false);
    } catch (error) {
      setDecisionMessage(error.name === "NotAllowedError" ? "Device verification was cancelled." : error.message);
      await refreshPending();
    } finally {
      setBusy("");
    }
  };

  const testNotification = async () => {
    if (!companion) return;
    setBusy("test");
    setMessage("");
    try {
      await approvalApi.testCompanion(companion.id);
      setMessage("Test alert sent. Delivery timing is controlled by your browser and operating system.");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!companion) return;
    setConfirmRemove(false);
    setBusy("remove");
    setMessage("");
    try {
      await approvalApi.revokeCompanion(companion.id);
      await clearBrowserApprover(localApprover?.did);
      await removeCompanionPush();
      setRequest(null);
      setTerminal(null);
      setMessage("This companion browser was removed.");
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy("");
    }
  };

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const logout = async () => {
    try { await authApi.logout(); } finally { window.location.assign("/companion"); }
  };

  const updateWorkspace = (next) => {
    if (!next) return;
    setWorkspace(next);
    setWorkspaceState(next.state);
    setWorkspaces((current) => replaceWorkspaceInInventory(current, next));
  };

  const selectWorkspace = (workspaceId) => {
    const next = workspaces.find((item) => item.id === workspaceId);
    if (!next || next.id === workspace?.id) return;
    setWorkspace(next);
    setWorkspaceState(next.state);
    setWorkspaceError("");
    setChatSessions([]);
    setChatHistoryHasMore(false);
    setActiveChatSessionId("");
    writePreference(workspacePreferenceKey, next.id);
  };

  const startWorkspaceForChat = async () => {
    setWorkspaceError("");
    setWorkspaceState(workspace?.state === "not_created" ? "provisioning" : "loading");
    try {
      if (!workspace || ["not_created", "stopped", "failed"].includes(workspace.state)) {
        updateWorkspace(await workspaceApi.create(workspace?.grantId ?? "personal"));
        return;
      }
      const result = await workspaceApi.open(workspace.id);
      updateWorkspace(result.workspace);
    } catch (error) {
      setWorkspaceState(workspace?.state ?? "failed");
      setWorkspaceError(error.message);
    }
  };

  const restartWorkspaceForChat = async () => {
    if (!workspace) return;
    setWorkspaceError("");
    setWorkspaceState("restarting");
    try {
      updateWorkspace(await workspaceApi.restart(workspace.id));
    } catch (error) {
      setWorkspaceState(workspace.state);
      setWorkspaceError(error.message);
    }
  };

  const saveChatAgentPreference = (workspaceId, agentId) => {
    if (!workspaceId || !agentId) return;
    writePreference(chatAgentPreferenceKey(workspaceId), agentId);
    setChatAgentPreferences((current) => ({ ...current, [workspaceId]: agentId }));
  };

  const selectChatSession = (sessionId, historyMode = "push") => {
    setActiveChatSessionId(sessionId);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "chat");
    if (sessionId) url.searchParams.set("chat", sessionId);
    else url.searchParams.delete("chat");
    window.history[historyMode === "replace" ? "replaceState" : "pushState"]({}, "", `${url.pathname}${url.search}`);
  };

  const selectView = (view) => {
    if (view === activeView) return;
    setActiveView(view);
    const url = new URL(window.location.href);
    if (view === "chat") {
      url.searchParams.set("view", "chat");
      if (activeChatSessionId) url.searchParams.set("chat", activeChatSessionId);
      url.searchParams.delete("tab");
    } else {
      url.searchParams.delete("view");
      url.searchParams.delete("chat");
    }
    url.searchParams.delete("from");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
  };

  const selectTab = (tab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    if (tab === "activity") url.searchParams.set("tab", "activity");
    else url.searchParams.delete("tab");
    url.searchParams.delete("from");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
  };

  if (authLoading) return <main className="companion-loading">Checking your work account…</main>;
  if (!session) return <CompanionSignIn error={authError} />;

  const enrolled = Boolean(localApprover && approverStatus?.connected);
  const ready = enrolled && Boolean(companion) && support.supported && support.permission === "granted";

  return (
    <div className="companion-root">
      <a className="skip-link" href="#companion-main">Skip to main content</a>
      <header className="companion-topbar" inert={confirmRemove ? true : undefined}>
        <Brand />
        <div className="companion-topbar-actions">
          {installPrompt && <button className="companion-quiet" type="button" onClick={install}>Install app</button>}
          <nav className="companion-mode-switch" aria-label="Primary navigation">
            <button className={activeView === "chat" ? "active" : ""} type="button" aria-current={activeView === "chat" ? "page" : undefined} onClick={() => selectView("chat")}>Chat</button>
            <button className={activeView === "companion" ? "active" : ""} type="button" aria-current={activeView === "companion" ? "page" : undefined} onClick={() => selectView("companion")} aria-label="Companion">
              <span className="companion-mode-shield"><ShieldCheckmark24Regular aria-hidden="true" />{request && <em aria-label="1 pending approval">1</em>}</span>
            </button>
          </nav>
          <button className="companion-account" type="button" onClick={logout} aria-label={`Sign out ${session.user.displayName}`}><SignOut24Regular aria-hidden="true" /></button>
        </div>
      </header>

      <main id="companion-main" className={`companion-main${activeView === "chat" ? " companion-chat-main" : ""}`} inert={confirmRemove ? true : undefined}>
        {activeView === "chat" ? (
          <CompanionChatView
            workspace={workspace}
            workspaces={workspaces}
            workspaceState={workspaceState}
            workspaceError={workspaceError}
            onWorkspaceChange={selectWorkspace}
            onStartWorkspace={startWorkspaceForChat}
            onRestartWorkspace={restartWorkspaceForChat}
            sessions={chatSessions}
            activeSessionId={activeChatSessionId}
            onSessionChange={(sessionId) => selectChatSession(sessionId, "replace")}
            onSessionsChange={setChatSessions}
            preferredAgentId={workspace ? chatAgentPreferences[workspace.id] ?? readPreference(chatAgentPreferenceKey(workspace.id)) : ""}
            onAgentChange={saveChatAgentPreference}
            historyHasMore={chatHistoryHasMore}
            historyLoadingMore={chatHistoryLoadingMore}
            historyLoadRequest={chatHistoryLoadRequest}
            onLoadOlder={() => setChatHistoryLoadRequest((value) => value + 1)}
            onHistoryMetadataChange={({ hasMore, loading }) => {
              setChatHistoryHasMore(hasMore);
              setChatHistoryLoadingMore(loading);
            }}
          />
        ) : <>
          <header className="companion-heading">
          <p>{activeTab === "approvals" ? "Approval companion" : "Your activity"}</p>
          <h1>{activeTab === "approvals"
            ? ready ? "You’re ready for protected actions." : "Set up this browser for approvals."
            : "See what your workspace has requested."}</h1>
          <span>{activeTab === "approvals"
            ? "Approval alerts work independently of your managed workspace. Every decision still requires this device and the exact live signed request."
            : "Review what was requested, who or what it targeted, who requested it, and how the protected action concluded."}</span>
        </header>

        <nav className="companion-tabs" aria-label="Companion sections">
          <button className={activeTab === "approvals" ? "active" : ""} type="button" aria-current={activeTab === "approvals" ? "page" : undefined} onClick={() => selectTab("approvals")}>
            Approvals{request && <span aria-label="pending approval">1</span>}
          </button>
          <button className={activeTab === "activity" ? "active" : ""} type="button" aria-current={activeTab === "activity" ? "page" : undefined} onClick={() => selectTab("activity")}>
            Activity
          </button>
        </nav>

        {message && <div className={`companion-message${message.includes("ready") || message.includes("sent") || message.includes("enabled") ? " success" : ""}`} role="status">{message}</div>}

        {activeTab === "activity" ? (
          <ActivityView
            activities={activities}
            loading={activityLoading}
            error={activityError}
            nextCursor={activityCursor}
            selectedId={selectedActivityId}
            detail={activityDetail}
            detailLoading={activityDetailLoading}
            onRefresh={refreshActivity}
            onLoadMore={() => loadActivity(activityCursor, true)}
            onSelect={selectActivity}
            onReviewPending={() => {
              selectTab("approvals");
              refreshPending();
            }}
          />
        ) : <div className={`companion-layout${request ? " has-live-approval" : ""}`}>
          <div className="companion-primary-column">
            {request ? (
              <ApprovalCard request={request} busy={busy === "decision"} message={decisionMessage} onDecision={decide} />
            ) : terminal ? (
              <section className="companion-empty terminal">
                <CheckmarkCircle24Regular aria-hidden="true" />
                <p>{terminal.decision === "approve" ? "Decision signed" : "Request denied"}</p>
                <h2>{terminal.summary}</h2>
                <button className="companion-secondary" type="button" onClick={() => { setTerminal(null); refreshPending(); }}>Return to approvals</button>
              </section>
            ) : (
              <section className="companion-empty">
                <ShieldCheckmark24Regular aria-hidden="true" />
                <p>Pending approvals</p>
                <h2>{loading ? "Checking for a live signed request…" : ready ? "You’re all caught up." : "Finish setup to receive approval alerts."}</h2>
                <span>{ready ? "You can close this app. A generic notification will let you know when there is something to review." : "No action can run from a notification alone."}</span>
                {ready && <button className="companion-secondary" type="button" onClick={refreshPending}><ArrowClockwise24Regular aria-hidden="true" />Check again</button>}
              </section>
            )}
          </div>

          <aside className="companion-side-column">
            <section className="companion-setup-card">
              <div className="companion-card-heading">
                <div><p>This browser</p><h2>{ready ? "Companion ready" : enrolled ? "Approval key enrolled" : "Not enrolled"}</h2></div>
                <span className={ready ? "ready" : "attention"}>{ready ? "Ready" : "Needs attention"}</span>
              </div>
              <ul className="companion-readiness">
                <ReadinessItem ready={enrolled} label="Device-signed decisions" detail={enrolled ? approverStatus.approver.displayName : "Requires WebAuthn PRF and a platform authenticator"} />
                <ReadinessItem ready={support.supported} label="Browser support" detail={support.supported ? `${support.browserFamily} on ${support.platform}` : support.reason} />
                <ReadinessItem ready={Boolean(companion) && support.permission === "granted"} label="Push notifications" detail={!config?.enabled ? "Not configured by the administrator" : support.permission === "denied" ? "Blocked in browser settings" : companion ? "Subscription is active" : "Permission and subscription required"} />
              </ul>

              {!enrolled ? (
                <div className="companion-setup-form">
                  <label htmlFor="companion-name">Browser name</label>
                  <input id="companion-name" value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} />
                  <button className="companion-primary" type="button" disabled={Boolean(busy) || !config?.enabled || !support.supported} onClick={setup}>
                    <ShieldCheckmark24Regular aria-hidden="true" />{busy === "setup" ? "Waiting for device" : "Set up companion"}
                  </button>
                </div>
              ) : !companion ? (
                <button className="companion-primary full" type="button" disabled={Boolean(busy) || !config?.enabled || !support.supported} onClick={enableNotifications}>
                  {busy === "notifications" ? "Enabling notifications" : "Enable approval alerts"}
                </button>
              ) : (
                <div className="companion-card-actions">
                  <button className="companion-secondary" type="button" disabled={Boolean(busy)} onClick={testNotification}>{busy === "test" ? "Sending test" : "Send test alert"}</button>
                  <button className="companion-quiet danger" type="button" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}>{busy === "remove" ? "Removing" : "Remove companion"}</button>
                </div>
              )}

              {companion && (
                <dl className="companion-health">
                  <div><dt>Last successful push</dt><dd>{formatTime(companion.lastSuccessfulDeliveryAt)}</dd></div>
                  <div><dt>Subscription health</dt><dd>{companion.lastFailureCode ? "Needs attention" : "Healthy"}</dd></div>
                  <div><dt>Protocol</dt><dd>{companion.protocolVersion}</dd></div>
                </dl>
              )}
            </section>

            <section className="companion-privacy">
              <ShieldCheckmark24Regular aria-hidden="true" />
              <div><strong>Notifications reveal no task details.</strong><span>The alert is only a wake-up hint. Authentication, signed request verification, and a deliberate device gesture are still required.</span></div>
            </section>
          </aside>
        </div>}
        </>}
      </main>
      {confirmRemove && (
        <ConfirmDialog
          title="Remove this companion browser?"
          description="Pending protected actions will remain blocked unless another enrolled companion can decide them."
          confirmLabel="Remove companion"
          danger
          onConfirm={remove}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}
