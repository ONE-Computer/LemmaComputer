import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ActivityEventRow,
  ActivityTimeline,
  humanizeToolName,
  mergeActivityEvents,
  presentActivityEvents,
  safeActivityHref,
} from "../apps/web/src/ActivityPanel.jsx";

const timestamp = "2026-07-29T08:00:00.000Z";
const turnId = "turn-panel-1";
const base = {
  version: 1,
  eventId: "10000000-0000-4000-8000-000000000001",
  turnId,
  sequence: 0,
  timestamp,
  state: "completed",
  provenance: "deterministic_system",
  visibility: "user",
};

const fixtures = [
  { ...base, kind: "plan", state: "running", payload: { title: "Review the request", summary: "Check the safe details" } },
  { ...base, kind: "progress", payload: { activityId: "progress-1", label: "Workspace checked" } },
  { ...base, kind: "provider_summary", provenance: "provider_generated", payload: { summary: "The provider summarized the visible result", provider: "Hermes" } },
  { ...base, kind: "tool", provenance: "tool", payload: { toolCallId: "tool-1", name: "get-drive-item", summary: "Metadata checked" } },
  { ...base, kind: "web_action", provenance: "tool", payload: { action: "search", label: "Searched the web", url: "https://example.com/search?q=safe" } },
  { ...base, kind: "source", provenance: "provider_generated", payload: { title: "Retention guide", url: "https://example.com/guide", citation: "[1]" } },
  { ...base, kind: "approval", state: "requires_action", provenance: "tool", payload: { approvalId: "approval-1", toolCallId: "tool-1", operationId: "20000000-0000-4000-8000-000000000001", summary: "Approval required" } },
  { ...base, kind: "computer_action", provenance: "tool", payload: { actionId: "computer-1", label: "Opened the workspace", viewerRef: "viewer-1" } },
  { ...base, kind: "notice", payload: { message: "The file remains unchanged" } },
  { ...base, kind: "error", state: "failed", payload: { code: "SOURCE_FAILED", message: "One source could not refresh", retryable: true } },
  { ...base, kind: "terminal", payload: { turnState: "completed", message: "Visible activity recorded" } },
].map((event, sequence) => ({
  ...event,
  eventId: `10000000-0000-4000-8000-${String(sequence + 1).padStart(12, "0")}`,
  sequence,
}));

test("Activity component fixtures render every ActivityEventV1 kind", () => {
  for (const fixture of fixtures) {
    const html = renderToStaticMarkup(createElement(ActivityEventRow, { event: fixture }));
    assert.match(html, new RegExp(`class="activity-event ${fixture.kind}`), fixture.kind);
    assert.match(html, new RegExp(`data-activity-sequence="${fixture.sequence}"`), fixture.kind);
    assert.doesNotMatch(html, /\[object Object\]/, fixture.kind);
  }
  const provider = renderToStaticMarkup(createElement(ActivityEventRow, { event: fixtures[2] }));
  assert.match(provider, /Why this approach/);
  assert.match(provider, /Provider generated/);
  assert.doesNotMatch(provider, /chain-of-thought|full reasoning trace|internal reasoning/i);
});

test("Activity component renders loading, empty, disconnected, expired, unavailable, and error states", () => {
  const expectations = {
    loading: "Loading activity",
    empty: "No activity yet",
    expired: "Activity is no longer available",
    unavailable: "Activity history isn’t available",
    error: "Activity could not load",
  };
  for (const [feedState, copy] of Object.entries(expectations)) {
    const html = renderToStaticMarkup(createElement(ActivityTimeline, { events: [], feedState }));
    assert.match(html, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), feedState);
  }
  const disconnected = renderToStaticMarkup(createElement(ActivityTimeline, { events: [fixtures[0]], feedState: "disconnected" }));
  assert.match(disconnected, /Reconnecting/);
  assert.match(disconnected, /Review the request/);
});

test("Activity rows render hostile text inertly and allow only safe HTTP(S) links", () => {
  const hostile = {
    ...fixtures[0],
    payload: {
      title: '<img src=x onerror="window.pwned=true">',
      summary: "<script>window.pwned=true</script>",
    },
  };
  const html = renderToStaticMarkup(createElement(ActivityEventRow, { event: hostile }));
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);

  assert.equal(safeActivityHref("javascript:alert(1)"), undefined);
  assert.equal(safeActivityHref("data:text/html,unsafe"), undefined);
  assert.equal(safeActivityHref("https://user:password@example.com/private"), undefined);
  assert.equal(safeActivityHref("https://example.com/source"), "https://example.com/source");

  const unsafeSource = { ...fixtures[5], payload: { title: "Unsafe", url: "javascript:alert(1)" } };
  const unsafeHtml = renderToStaticMarkup(createElement(ActivityEventRow, { event: unsafeSource }));
  assert.doesNotMatch(unsafeHtml, /href=/);
  const safeHtml = renderToStaticMarkup(createElement(ActivityEventRow, { event: fixtures[5] }));
  assert.match(safeHtml, /target="_blank"/);
  assert.match(safeHtml, /rel="noopener noreferrer"/);
});

test("Activity merge keeps monotonic order and suppresses event and sequence duplicates", () => {
  const replay = mergeActivityEvents([], [fixtures[0], fixtures[1], fixtures[2]]);
  const reconnected = mergeActivityEvents(replay, [fixtures[1], { ...fixtures[2], eventId: "30000000-0000-4000-8000-000000000001" }, fixtures[3]]);
  assert.deepEqual(reconnected.map((event) => event.sequence), [0, 1, 2, 3]);
  assert.equal(new Set(reconnected.map((event) => event.eventId)).size, reconnected.length);
});

test("work trace collapses lifecycle updates and replaces raw web tools with explicit actions", () => {
  const event = (sequence, kind, state, payload, provenance = "tool") => ({
    ...base,
    eventId: `40000000-0000-4000-8000-${String(sequence + 1).padStart(12, "0")}`,
    sequence,
    kind,
    state,
    provenance,
    payload,
  });
  const presented = presentActivityEvents([
    event(0, "plan", "running", { title: "Agent started work" }, "deterministic_system"),
    event(1, "plan", "completed", { title: "Approach", summary: "Compare reputable recipes." }, "provider_generated"),
    event(2, "tool", "running", { toolCallId: "tool-file", name: "get-drive-item", summary: "Target: plan.docx" }),
    event(3, "tool", "completed", { toolCallId: "tool-file", name: "get-drive-item", summary: "Target: plan.docx" }),
    event(4, "tool", "running", { toolCallId: "tool-web", name: "WebSearch", summary: "Searched for “traditional rösti recipe”" }),
    event(5, "tool", "completed", { toolCallId: "tool-web", name: "WebSearch", summary: "Searched for “traditional rösti recipe”" }),
    event(6, "web_action", "completed", { action: "search", label: "Searched for “traditional rösti recipe”" }),
    event(7, "source", "completed", { title: "BBC Good Food", url: "https://www.bbcgoodfood.com/recipes/rosti" }, "provider_generated"),
    event(8, "source", "completed", { title: "BBC rösti", url: "https://www.bbcgoodfood.com/recipes/rosti" }, "provider_generated"),
  ]);

  assert.deepEqual(presented.map((item) => [item.kind, item.state]), [
    ["plan", "completed"],
    ["tool", "completed"],
    ["web_action", "completed"],
    ["source", "completed"],
  ]);
  assert.equal(presented[0]?.payload.summary, "Compare reputable recipes.");
  assert.equal(humanizeToolName("get-drive-item"), "Get drive item");
  const html = renderToStaticMarkup(createElement(ActivityTimeline, { events: presented, feedState: "ready" }));
  assert.match(html, /Searched for “traditional rösti recipe”/);
  assert.doesNotMatch(html, />WebSearch</);
});

test("employee Activity hides recovered tool failures but preserves terminal errors", () => {
  const event = (sequence, kind, state, payload, provenance = "tool") => ({
    ...base,
    eventId: `50000000-0000-4000-8000-${String(sequence + 1).padStart(12, "0")}`,
    sequence,
    kind,
    state,
    provenance,
    payload,
  });
  const presented = presentActivityEvents([
    event(0, "tool", "failed", { toolCallId: "failed-attempt", name: "Terminal", summary: "Tool failed" }),
    event(1, "tool", "completed", { toolCallId: "fallback", name: "Write", summary: "Presentation created" }),
    event(2, "error", "failed", { code: "TURN_FAILED", message: "The turn could not be completed", retryable: true }, "deterministic_system"),
    event(3, "terminal", "failed", { turnState: "failed", message: "Turn failed" }, "deterministic_system"),
  ]);

  assert.deepEqual(presented.map((item) => [item.kind, item.state]), [
    ["tool", "completed"],
    ["error", "failed"],
    ["terminal", "failed"],
  ]);
  const html = renderToStaticMarkup(createElement(ActivityTimeline, { events: presented, feedState: "ready" }));
  assert.match(html, /Presentation created/);
  assert.match(html, /The turn could not be completed/);
  assert.doesNotMatch(html, /Tool failed/);
});

test("Activity panel source preserves keyboard dialog behavior, focus return, live announcements, and the viewer extension slot", async () => {
  const source = await readFile(new URL("../apps/web/src/ActivityPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /returnFocusRef\?\.current\?\.focus\(\)/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /data-activity-extension-slot="computer-viewer"/);
});
