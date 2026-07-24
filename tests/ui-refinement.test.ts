import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the owned UI exposes signed policy state and workspace protections without implementation authority", async () => {
  const [app, ui] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/ui.jsx"),
  ]);
  assert.match(app, /<PolicyIntegrityCard integrity=\{workspace\?\.policyIntegrity\}/);
  assert.match(app, /Native copy and paste/);
  assert.match(app, /Controlled internet access/);
  assert.match(ui, /In workspace/);
  assert.match(ui, /Enforced/);
  assert.doesNotMatch(ui, /PRIVATE_KEY|SIGNING_PRIVATE|provider credential/i);
});

test("critical UI paths use owned accessible dialogs, skip targets, live state, and current dates", async () => {
  const [app, companion, ui] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/CompanionApp.jsx"),
    source("apps/web/src/ui.jsx"),
  ]);
  assert.doesNotMatch(`${app}\n${companion}`, /window\.(confirm|prompt)/);
  assert.match(app, /href="#main-content"/);
  assert.match(companion, /href="#companion-main"/);
  assert.match(app, /aria-controls="primary-navigation"/);
  assert.match(ui, /aria-modal="true"/);
  assert.match(ui, /event\.key !== "Tab"/);
  assert.match(app, /new Intl\.DateTimeFormat/);
  assert.doesNotMatch(app, /dateTime="2026-/);
});

test("sandbox options are editable, opt-in, and explain the required restart after save", async () => {
  const [app, ui] = await Promise.all([
    source("apps/web/src/App.jsx"),
    source("apps/web/src/ui.jsx"),
  ]);
  assert.match(app, /catalogId: "claude-cli"/);
  assert.match(app, /catalogId: "hermes-desktop"/);
  assert.doesNotMatch(app, /name: "Google Chrome"[\s\S]+Coming soon/);
  assert.match(app, /setRestartNoticeOpen\(true\)/);
  assert.match(app, /title="Restart required"/);
  assert.match(app, /next launch will expose the selected applications and AI agent clients/);
  assert.match(ui, /export function NoticeDialog/);
  assert.match(ui, /source of truth for the next sandbox launch/);
});

test("top-level navigation is URL-backed and follows browser history", async () => {
  const app = await source("apps/web/src/App.jsx");
  assert.match(app, /navFromLocation/);
  assert.match(app, /useState\(navFromLocation\)/);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /addEventListener\("popstate"/);
  assert.match(app, /searchParams\.set\("view", viewByNav\[name\]\)/);
});

test("Chat automatically recovers when Hermes becomes healthy after the workspace reports ready", async () => {
  const app = await source("apps/web/src/App.jsx");
  assert.match(app, /status !== "offline"/);
  assert.match(app, /reasonCode !== "HERMES_UNAVAILABLE"/);
  assert.match(app, /setTimeout\(\(\) => setReload\(\(value\) => value \+ 1\), 2000\)/);
  assert.match(app, /clearTimeout\(timeout\)/);
});
