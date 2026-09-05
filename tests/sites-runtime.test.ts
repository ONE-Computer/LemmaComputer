import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("the reviewed site skill and scoped publisher reach every supported agent surface", async () => {
  const [dockerfile, entrypoint, chatAdapter, claudeDesktop, claude, codex, hermes, hermesDesktop, hermesConfig, viteConfig] = await Promise.all([
    readFile("docker/Dockerfile.workspace", "utf8"),
    readFile("docker/workspace/lemmacomputer-workspace-entrypoint.sh", "utf8"),
    readFile("docker/workspace/lemmacomputer-agent-chat.py", "utf8"),
    readFile("docker/workspace/lemmacomputer-claude-desktop", "utf8"),
    readFile("docker/workspace/lemmacomputer-claude", "utf8"),
    readFile("docker/workspace/lemmacomputer-codex", "utf8"),
    readFile("docker/workspace/lemmacomputer-hermes", "utf8"),
    readFile("docker/workspace/lemmacomputer-hermes-desktop", "utf8"),
    readFile("docker/workspace/lemmacomputer-hermes-config.py", "utf8"),
    readFile("skills/site/assets/vite-static/vite.config.js", "utf8"),
  ]);

  assert.match(dockerfile, /COPY skills\/site \/opt\/lemmacomputer\/skills\/site/);
  assert.match(dockerfile, /COPY docker\/workspace\/lemmacomputer-sites\.py \/usr\/local\/bin\/lemmacomputer-sites/);
  for (const home of [".claude", ".claude-cli", ".claude-chat-sdk", ".codex-cli", ".codex-chat-sdk", ".hermes", ".hermes-desktop"]) {
    assert.ok(entrypoint.includes(`install_agent_skill /home/kasm-user/${home}`));
  }
  assert.match(entrypoint, /LEMMACOMPUTER_SITES_BROKER=http:\/\/127\.0\.0\.1:4314/);
  assert.match(chatAdapter, /"LEMMACOMPUTER_SITES_BROKER": BROKER/);
  for (const launcher of [claudeDesktop, claude, codex, hermes, hermesDesktop]) {
    assert.match(launcher, /LEMMACOMPUTER_SITES_BROKER=http:\/\/127\.0\.0\.1:43(?:14|15|16|17)/);
  }
  assert.match(hermesConfig, /REVIEWED_DEFAULT_SKILLS = OFFICE_DEFAULT_SKILLS \| frozenset\(\{"site"}\)/);
  assert.match(viteConfig, /modulePreload: \{ polyfill: false \}/);
});

test("the publisher keeps Control authority out of the agent process", async () => {
  const [publisher, broker] = await Promise.all([
    readFile("docker/workspace/lemmacomputer-sites.py", "utf8"),
    readFile("docker/workspace/lemmacomputer-gateway-proxy.py", "utf8"),
  ]);

  assert.doesNotMatch(publisher, /AGENT_BRIDGE_TOKEN|CONTROL_UPSTREAM/);
  assert.match(publisher, /\/lemmacomputer\/sites/);
  assert.match(broker, /AGENT_BRIDGE_TOKEN = os\.environ\["LEMMACOMPUTER_AGENT_BRIDGE_TOKEN"\]/);
  assert.doesNotMatch(broker, /distPath|os\.walk\(resolved/);
  assert.match(broker, /base64\.b64decode\(bundle_base64, validate=True\)/);
  assert.match(broker, /hashlib\.sha256\(content\)\.hexdigest\(\) != archive_sha256/);
  assert.match(broker, /\/internal\/v1\/agent\/sites/);
  assert.match(publisher, /MAX_ARCHIVE_BYTES = 20 \* 1024 \* 1024/);
  assert.match(publisher, /\.lemmacomputer.*site\.json/s);
  assert.match(publisher, /UncertainRequestError if error\.code == 429 or error\.code >= 500/);
  assert.match(publisher, /zipfile\.ZipFile/);
  assert.match(publisher, /def restore/);
});

test("the publisher retains its retry key after a transient broker response", () => {
  const script = [
    "import importlib.util,io,sys,urllib.error",
    "sys.dont_write_bytecode=True",
    "spec=importlib.util.spec_from_file_location('site_publisher',sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "module.broker_url=lambda:'http://127.0.0.1:4314'",
    "def unavailable(*args,**kwargs): raise urllib.error.HTTPError('',503,'unavailable',{},io.BytesIO(b'{\"error\":{\"message\":\"retry later\"}}'))",
    "module.urllib.request.urlopen=unavailable",
    "try: module.request_json('/lemmacomputer/sites')",
    "except module.UncertainRequestError as error: print(str(error))",
    "else: raise SystemExit(1)",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, resolve("docker/workspace/lemmacomputer-sites.py")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "retry later");
});
