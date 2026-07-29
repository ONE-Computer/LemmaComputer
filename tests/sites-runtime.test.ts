import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the reviewed site skill and scoped publisher reach every supported agent surface", async () => {
  const [dockerfile, entrypoint, chatAdapter, claude, codex, hermes, hermesDesktop, hermesConfig] = await Promise.all([
    readFile("docker/Dockerfile.workspace", "utf8"),
    readFile("docker/workspace/onecomputer-workspace-entrypoint.sh", "utf8"),
    readFile("docker/workspace/onecomputer-agent-chat.py", "utf8"),
    readFile("docker/workspace/onecomputer-claude", "utf8"),
    readFile("docker/workspace/onecomputer-codex", "utf8"),
    readFile("docker/workspace/onecomputer-hermes", "utf8"),
    readFile("docker/workspace/onecomputer-hermes-desktop", "utf8"),
    readFile("docker/workspace/onecomputer-hermes-config.py", "utf8"),
  ]);

  assert.match(dockerfile, /COPY skills\/make-a-site \/opt\/onecomputer\/skills\/make-a-site/);
  assert.match(dockerfile, /COPY docker\/workspace\/onecomputer-sites\.py \/usr\/local\/bin\/onecomputer-sites/);
  for (const home of [".claude", ".claude-cli", ".claude-chat-sdk", ".codex-cli", ".codex-chat-sdk"]) {
    assert.ok(entrypoint.includes(`install_agent_skill /home/kasm-user/${home}`));
  }
  assert.match(entrypoint, /ONECOMPUTER_SITES_BROKER=http:\/\/127\.0\.0\.1:4314/);
  assert.match(chatAdapter, /"ONECOMPUTER_SITES_BROKER": BROKER/);
  for (const launcher of [claude, codex, hermes, hermesDesktop]) {
    assert.match(launcher, /ONECOMPUTER_SITES_BROKER=http:\/\/127\.0\.0\.1:43(?:14|15|16|17)/);
  }
  assert.match(hermesConfig, /REVIEWED_DEFAULT_SKILLS = OFFICE_DEFAULT_SKILLS \| frozenset\(\{"make-a-site"}\)/);
});

test("the publisher keeps Control authority out of the agent process", async () => {
  const [publisher, broker] = await Promise.all([
    readFile("docker/workspace/onecomputer-sites.py", "utf8"),
    readFile("docker/workspace/onecomputer-gateway-proxy.py", "utf8"),
  ]);

  assert.doesNotMatch(publisher, /AGENT_BRIDGE_TOKEN|CONTROL_UPSTREAM/);
  assert.match(publisher, /\/onecomputer\/sites/);
  assert.match(broker, /AGENT_BRIDGE_TOKEN = os\.environ\["ONECOMPUTER_AGENT_BRIDGE_TOKEN"\]/);
  assert.doesNotMatch(broker, /distPath|os\.walk\(resolved/);
  assert.match(broker, /base64\.b64decode\(html_base64, validate=True\)/);
  assert.match(broker, /hashlib\.sha256\(content\)\.hexdigest\(\) != artifact_sha256/);
  assert.match(broker, /\/internal\/v1\/agent\/sites/);
  assert.match(publisher, /files != \["index\.html"\]/);
  assert.match(publisher, /len\(content\) > 512 \* 1024/);
});
