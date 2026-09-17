import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const configurator = "docker/workspace/lemmacomputer-codex-config.py";

test("Codex projects only assigned organization modes and per-route context limits", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-profile-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "history.jsonl"), "saved session\n");
  execFileSync("python3", [configurator, home, "balanced", "balanced,pro", "managed"], {
    env: { ...process.env, LEMMACOMPUTER_MODEL_LIMITS: JSON.stringify({
      balanced: { contextTokens: 1050000, outputTokens: 128000 },
      pro: { contextTokens: 2000000, outputTokens: 128000 },
    }) },
  });
  const { models } = JSON.parse(await readFile(path.join(home, "lemmacomputer-models.json"), "utf8"));
  assert.deepEqual(models.map((m: { slug: string }) => m.slug), ["lemmacomputer-balanced", "lemmacomputer-pro"]);
  assert.equal(models[0].context_window, 1050000);
  assert.equal(models[0].auto_compact_token_limit, 922000);
  assert.equal(models[1].context_window, 2000000);
  assert.equal(models[0].default_reasoning_level, "medium");
  assert.deepEqual(models[0].supported_reasoning_levels, [
    { effort: "low", description: "Faster responses with lighter analysis" },
    { effort: "medium", description: "Balanced analysis for everyday work" },
    { effort: "high", description: "More thorough analysis for complex work" },
  ]);
  const config = await readFile(path.join(home, "config.toml"), "utf8");
  assert.match(config, /model = "lemmacomputer-balanced"/);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /enable_request_compression = false/);
  assert.match(config, /supports_websockets = false/);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /env_http_headers = \{ "x-lemmacomputer-agent-instance-id" = "LEMMACOMPUTER_AGENT_INSTANCE_ID" \}/);
  assert.match(config, /\[mcp_servers\.lemmacomputer_connectors\][\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(config, /env_vars = \["LEMMACOMPUTER_AGENT_INSTANCE_ID"\]/);
  assert.match(config, /LEMMACOMPUTER_CONNECTORS_BROKER = "http:\/\/127.0.0.1:4317"/);
  assert.equal(await readFile(path.join(home, "history.jsonl"), "utf8"), "saved session\n");
  execFileSync("python3", [configurator, home, "auto", "balanced", "disposable-open"]);
  assert.match(await readFile(path.join(home, "config.toml"), "utf8"), /sandbox_mode = "danger-full-access"/);
  assert.equal(JSON.parse(await readFile(path.join(home, "lemmacomputer-models.json"), "utf8")).models.length, 1);
});

test("Codex rejects invalid or unassigned model modes before writing a profile", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-invalid-profile-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [selected, allowed, mode] of [
    ["pro", "balanced", "managed"], ["balanced", "balanced,gpt-6-astra", "managed"],
    ["balanced", "", "managed"], ["balanced", "balanced", "hosted"],
  ]) {
    assert.notEqual(spawnSync("python3", [configurator, home, selected!, allowed!, mode!]).status, 0);
  }
  assert.notEqual(spawnSync("python3", [configurator, home, "balanced", "balanced", "managed"], {
    env: { ...process.env, LEMMACOMPUTER_MODEL_LIMITS: '{"balanced":{"contextTokens":32000,"outputTokens":128000}}' },
  }).status, 0);
  await assert.rejects(readFile(path.join(home, "config.toml")));
});
