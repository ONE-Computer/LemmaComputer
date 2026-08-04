import React, { useEffect, useRef, useState } from "react";
import { Bot20Regular } from "@fluentui/react-icons/svg/bot";
import { CheckmarkCircle20Regular } from "@fluentui/react-icons/svg/checkmark-circle";
import { Desktop20Regular } from "@fluentui/react-icons/svg/desktop";
import { Dismiss20Regular } from "@fluentui/react-icons/svg/dismiss";
import { DocumentBulletList20Regular } from "@fluentui/react-icons/svg/document-bullet-list";
import { ErrorCircle20Regular } from "@fluentui/react-icons/svg/error-circle";
import { Globe20Regular } from "@fluentui/react-icons/svg/globe";
import { Info20Regular } from "@fluentui/react-icons/svg/info";
import { Link20Regular } from "@fluentui/react-icons/svg/link";
import { Pulse20Regular } from "@fluentui/react-icons/svg/pulse";
import { ShieldCheckmark20Regular } from "@fluentui/react-icons/svg/shield-checkmark";
import { Toolbox20Regular } from "@fluentui/react-icons/svg/toolbox";
import { chatApi } from "./workspace-api.js";

const stateLabel = {
  pending: "Pending",
  running: "In progress",
  requires_action: "Needs action",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const kindPresentation = {
  plan: { label: "Approach", Icon: DocumentBulletList20Regular },
  progress: { label: "Progress", Icon: Pulse20Regular },
  provider_summary: { label: "Why this approach", Icon: Bot20Regular },
  tool: { label: "Action", Icon: Toolbox20Regular },
  web_action: { label: "Web", Icon: Globe20Regular },
  source: { label: "Source", Icon: Link20Regular },
  approval: { label: "Approval", Icon: ShieldCheckmark20Regular },
  computer_action: { label: "Computer action", Icon: Desktop20Regular },
  notice: { label: "Notice", Icon: Info20Regular },
  error: { label: "Error", Icon: ErrorCircle20Regular },
  terminal: { label: "Complete", Icon: CheckmarkCircle20Regular },
};

const webActionLabel = {
  search: "Searched the web",
  open: "Opened a webpage",
  find: "Found text on a webpage",
};

const turnStateLabel = {
  needs_input: "Waiting for your reply",
  completed: "Turn completed",
  cancelled: "Turn cancelled",
  failed: "Turn failed",
};

export function safeActivityHref(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function mergeActivityEvents(current, incoming) {
  const merged = new Map();
  for (const event of [...current, ...incoming]) {
    if (!event || !Number.isInteger(event.sequence) || typeof event.kind !== "string") continue;
    merged.set(event.eventId || `sequence:${event.sequence}`, event);
  }
  return [...merged.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((event, index, events) => index === 0 || event.sequence !== events[index - 1].sequence);
}

export function humanizeToolName(value) {
  const name = String(value || "Workspace action").replace(/^mcp__onecomputer_connectors__/, "");
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_:.-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (character) => character.toUpperCase());
}

const isWebToolName = (value) => {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return (
    ["search", "web_search", "search_query", "websearch", "searchquery"].includes(normalized)
    || ["open", "open_url", "open_page", "web_fetch", "webfetch", "browser_navigate"].includes(normalized)
    || ["find", "find_text", "find_in_page", "browser_find"].includes(normalized)
  );
};

export function presentActivityEvents(events = []) {
  const presented = [];
  const keyed = new Map();

  for (const event of events) {
    const payload = event?.payload ?? {};
    const key = (
      event?.kind === "plan" ? "plan"
        : event?.kind === "provider_summary" ? "provider_summary"
          : event?.kind === "tool" && payload.toolCallId ? `tool:${payload.toolCallId}`
            : event?.kind === "progress" && payload.activityId ? `progress:${payload.activityId}`
              : event?.kind === "source" && payload.url ? `source:${payload.url}`
                : event?.kind === "web_action" ? `web:${payload.action}:${payload.label}:${payload.url || ""}`
                  : undefined
    );
    if (!key) {
      presented.push(event);
      continue;
    }
    const existingIndex = keyed.get(key);
    if (existingIndex === undefined) {
      keyed.set(key, presented.length);
      presented.push(event);
      continue;
    }
    const existing = presented[existingIndex];
    presented[existingIndex] = {
      ...existing,
      ...event,
      eventId: existing.eventId,
      sequence: existing.sequence,
      payload: { ...existing.payload, ...event.payload },
    };
  }
  const explicitWebLabels = new Set(
    presented.filter((event) => event.kind === "web_action").map((event) => event.payload?.label),
  );
  return presented
    .filter((event) => !(event.kind === "tool" && event.state === "completed" && isWebToolName(event.payload?.name) && explicitWebLabels.has(event.payload?.summary)))
    .sort((left, right) => left.sequence - right.sequence);
}

const eventCopy = (event) => {
  const payload = event.payload ?? {};
  if (event.kind === "plan") return { title: payload.title, detail: payload.summary };
  if (event.kind === "progress") return { title: payload.label };
  if (event.kind === "provider_summary") return { title: payload.summary, detail: payload.provider ? `Generated by ${payload.provider}` : "Generated by the selected provider" };
  if (event.kind === "tool") return { title: humanizeToolName(payload.name), detail: payload.summary };
  if (event.kind === "web_action") return { title: payload.label || webActionLabel[payload.action], detail: payload.url };
  if (event.kind === "source") return { title: payload.title, detail: payload.citation };
  if (event.kind === "approval") return { title: payload.summary };
  if (event.kind === "computer_action") return { title: payload.label };
  if (event.kind === "notice") return { title: payload.message };
  if (event.kind === "error") return { title: payload.message, detail: payload.retryable ? "You can try this turn again." : undefined };
  if (event.kind === "terminal") return { title: turnStateLabel[payload.turnState] ?? "Turn finished", detail: payload.message };
  return { title: kindPresentation[event.kind]?.label ?? "Activity update" };
};

const formatActivityTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
};

export function ActivityEventRow({ event }) {
  const presentation = kindPresentation[event.kind] ?? kindPresentation.notice;
  const { Icon } = presentation;
  const copy = eventCopy(event);
  const href = ["source", "web_action"].includes(event.kind)
    ? safeActivityHref(event.payload?.url)
    : undefined;
  const expandable = Boolean(copy.detail) && !["provider_summary", "source", "web_action", "terminal"].includes(event.kind);
  const heading = (
    <>
      <span className="activity-event-icon" aria-hidden="true"><Icon /></span>
      <span className="activity-event-copy">
        <span className="activity-event-kind">
          {presentation.label}
          {event.provenance === "provider_generated" && event.kind !== "plan" && <span className="activity-provider-label">Provider generated</span>}
        </span>
        <strong>{copy.title || presentation.label}</strong>
      </span>
      <span className={`activity-event-state ${event.state}`}>{stateLabel[event.state] ?? "Updated"}</span>
    </>
  );
  return (
    <li className={`activity-event ${event.kind} ${event.state}`} data-activity-sequence={event.sequence}>
      {expandable ? (
        <details open={event.state === "requires_action" || event.state === "failed"}>
          <summary>{heading}</summary>
          <p>{copy.detail}</p>
        </details>
      ) : (
        <div className="activity-event-body">
          {heading}
          {copy.detail && event.kind !== "web_action" && <p>{copy.detail}</p>}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {event.kind === "source" ? "Open source" : "Open webpage"}
            </a>
          )}
        </div>
      )}
      <time dateTime={event.timestamp}>{formatActivityTime(event.timestamp)}</time>
    </li>
  );
}

const statusCopy = {
  loading: { title: "Loading activity", detail: "Replaying visible updates for this turn." },
  empty: { title: "No activity yet", detail: "Visible agent and tool updates will appear here." },
  expired: { title: "Activity is no longer available", detail: "This turn’s retained activity may have expired or been removed." },
  unavailable: { title: "Activity history isn’t available", detail: "This deployment is keeping the conversation without a persisted activity feed." },
  error: { title: "Activity could not load", detail: "The conversation is still available. Try loading its activity again." },
};

export function ActivityTimeline({ events = [], feedState = "empty", onRetry }) {
  const visibleEvents = presentActivityEvents(events);
  const emptyState = visibleEvents.length === 0 ? statusCopy[feedState] : undefined;
  return (
    <div className="activity-timeline-wrap">
      {feedState === "disconnected" && (
        <div className="activity-connection-notice" role="status">
          <Info20Regular aria-hidden="true" />
          <span><strong>Reconnecting</strong><small>Saved updates remain visible while LemmaComputer catches up.</small></span>
        </div>
      )}
      {emptyState ? (
        <div className={`activity-empty-state ${feedState}`} role={feedState === "error" ? "alert" : "status"}>
          {feedState === "loading" ? <span className="activity-loading-mark" aria-hidden="true" /> : <Info20Regular aria-hidden="true" />}
          <h3>{emptyState.title}</h3>
          <p>{emptyState.detail}</p>
          {feedState === "error" && <button type="button" onClick={onRetry}>Try again</button>}
        </div>
      ) : (
        <ol className="activity-timeline" aria-label="Turn activity">
          {visibleEvents.map((event) => <ActivityEventRow event={event} key={event.eventId || event.sequence} />)}
        </ol>
      )}
    </div>
  );
}

const persistenceUnavailable = (error) => error?.code === "ACTIVITY_PERSISTENCE_DISABLED"
  || error?.code === "ACTIVITY_NOT_SUPPORTED"
  || [501, 503].includes(error?.status);

export function useActivityFeed({ workspaceId, agentId, sessionId, turnId, enabled }) {
  const [events, setEvents] = useState([]);
  const [feedState, setFeedState] = useState(turnId ? "loading" : "empty");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setEvents([]);
    if (!enabled || !workspaceId || !agentId || !sessionId || !turnId) {
      setFeedState("empty");
      return undefined;
    }
    let disposed = false;
    let source;
    let reconnectTimer;
    let reconnectDelay = 400;
    let cursor = -1;

    const stopSource = () => {
      source?.close();
      source = undefined;
    };

    const fail = (error) => {
      if (disposed) return;
      if (persistenceUnavailable(error)) setFeedState("unavailable");
      else if (["ACTIVITY_TURN_NOT_FOUND", "WORKSPACE_NOT_FOUND", "FORBIDDEN"].includes(error?.code) || error?.status === 404) setFeedState("expired");
      else setFeedState("error");
    };

    const connect = () => {
      if (disposed || typeof EventSource === "undefined") {
        if (!disposed) setFeedState("unavailable");
        return;
      }
      stopSource();
      source = new EventSource(chatApi.activityStreamUrl(workspaceId, agentId, sessionId, turnId, cursor));
      source.onopen = () => {
        reconnectDelay = 400;
        if (!disposed) setFeedState("live");
      };
      source.addEventListener("activity", (message) => {
        if (disposed) return;
        try {
          const event = JSON.parse(message.data);
          if (!Number.isInteger(event.sequence) || event.turnId !== turnId) return;
          cursor = Math.max(cursor, event.sequence);
          setEvents((current) => mergeActivityEvents(current, [event]));
          if (event.kind === "terminal") {
            setFeedState("complete");
            stopSource();
          }
        } catch {
          // Malformed event data is ignored and never rendered.
        }
      });
      source.onerror = () => {
        if (disposed) return;
        stopSource();
        setFeedState("disconnected");
        reconnectTimer = window.setTimeout(() => {
          void replay(cursor, true);
        }, reconnectDelay);
        reconnectDelay = Math.min(8_000, reconnectDelay * 2);
      };
    };

    const replay = async (after, reconnecting = false) => {
      try {
        const page = await chatApi.activity(workspaceId, agentId, sessionId, turnId, after);
        if (disposed) return;
        cursor = Math.max(cursor, page.events.at(-1)?.sequence ?? after);
        setEvents((current) => mergeActivityEvents(current, page.events));
        if (page.terminal) setFeedState("complete");
        else {
          setFeedState(reconnecting ? "disconnected" : page.events.length ? "live" : "empty");
          connect();
        }
      } catch (error) {
        fail(error);
      }
    };

    setFeedState("loading");
    void replay(-1);
    return () => {
      disposed = true;
      stopSource();
      window.clearTimeout(reconnectTimer);
    };
  }, [agentId, enabled, reload, sessionId, turnId, workspaceId]);

  return { events, feedState, retry: () => setReload((value) => value + 1) };
}


export function ActivityPanel({ open, workspaceId, agentId, sessionId, turnId, onClose, returnFocusRef }) {
  const closeRef = useRef(null);
  const panelRef = useRef(null);
  const { events, feedState, retry } = useActivityFeed({ workspaceId, agentId, sessionId, turnId, enabled: open });

  useEffect(() => {
    if (!open) return undefined;
    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        returnFocusRef?.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(panelRef.current?.querySelectorAll("a[href], button:not([disabled]), summary, [tabindex]:not([tabindex='-1'])") ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open, returnFocusRef]);

  if (!open) return null;
  const announcement = feedState === "disconnected"
    ? "Activity disconnected. Reconnecting."
    : feedState === "complete"
      ? "Activity complete."
      : events.length
        ? `${events.length} visible activity updates.`
        : statusCopy[feedState]?.title ?? "Activity is live.";
  return (
    <>
      <button className="activity-panel-scrim" type="button" aria-label="Close Activity" onClick={onClose} />
      <aside
        ref={panelRef}
        id="chat-activity-panel"
        className="activity-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-activity-title"
      >
        <header className="activity-panel-header">
          <div>
            <span>Visible turn updates</span>
            <h2 id="chat-activity-title">Activity</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close Activity"
            onClick={() => {
              onClose();
              returnFocusRef?.current?.focus();
            }}
          >
            <Dismiss20Regular aria-hidden="true" />
          </button>
        </header>
        <p className="activity-panel-intro">The approach, actions, and sources LemmaComputer recorded for this turn.</p>
        <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
        <ActivityTimeline events={events} feedState={feedState} onRetry={retry} />
        <div className="activity-viewer-slot" data-activity-extension-slot="computer-viewer" aria-label="Computer view extension slot">
          <Desktop20Regular aria-hidden="true" />
          <span><strong>Computer view</strong><small>Reserved for the live workspace viewer.</small></span>
        </div>
      </aside>
    </>
  );
}

export function ActivityToggle({ open, onClick, buttonRef }) {
  return (
    <button
      ref={buttonRef}
      className={`chat-activity-toggle${open ? " active" : ""}`}
      type="button"
      aria-expanded={open}
      aria-controls="chat-activity-panel"
      onClick={onClick}
    >
      <Pulse20Regular aria-hidden="true" />
      <span>Activity</span>
    </button>
  );
}
