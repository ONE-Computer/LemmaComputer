import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the reviewed site skill and scoped publisher reach every supported agent surface", async () => {
  const [dockerfile, entrypoint, chatAdapter, claudeDesktop, claude, codex, hermes, hermesDesktop, hermesConfig] = await Promise.all([
    readFile("docker/Dockerfile.workspace", "utf8"),
    readFile("docker/workspace/lemmacomputer-workspace-entrypoint.sh", "utf8"),
    readFile("docker/workspace/lemmacomputer-agent-chat.py", "utf8"),
    readFile("docker/workspace/lemmacomputer-claude-desktop", "utf8"),
    readFile("docker/workspace/lemmacomputer-claude", "utf8"),
    readFile("docker/workspace/lemmacomputer-codex", "utf8"),
    readFile("docker/workspace/lemmacomputer-hermes", "utf8"),
    readFile("docker/workspace/lemmacomputer-hermes-desktop", "utf8"),
    readFile("docker/workspace/lemmacomputer-hermes-config.py", "utf8"),
  ]);

  assert.match(dockerfile, /COPY skills\/make-a-site \/opt\/lemmacomputer\/skills\/make-a-site/);
  assert.match(dockerfile, /COPY docker\/workspace\/lemmacomputer-sites\.py \/usr\/local\/bin\/lemmacomputer-sites/);
  for (const home of [".claude", ".claude-cli", ".claude-chat-sdk", ".codex-cli", ".codex-chat-sdk"]) {
    assert.ok(entrypoint.includes(`install_agent_skill /home/kasm-user/${home}`));
  }
  assert.match(entrypoint, /LEMMACOMPUTER_SITES_BROKER=http:\/\/127\.0\.0\.1:4314/);
  assert.match(chatAdapter, /"LEMMACOMPUTER_SITES_BROKER": BROKER/);
  for (const launcher of [claudeDesktop, claude, codex, hermes, hermesDesktop]) {
    assert.match(launcher, /LEMMACOMPUTER_SITES_BROKER=http:\/\/127\.0\.0\.1:43(?:14|15|16|17)/);
  }
  assert.match(hermesConfig, /REVIEWED_DEFAULT_SKILLS = OFFICE_DEFAULT_SKILLS \| frozenset\(\{"make-a-site"}\)/);
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
  assert.match(broker, /base64\.b64decode\(html_base64, validate=True\)/);
  assert.match(broker, /hashlib\.sha256\(content\)\.hexdigest\(\) != artifact_sha256/);
  assert.match(broker, /\/internal\/v1\/agent\/sites/);
  assert.match(publisher, /files != \["index\.html"\]/);
  assert.match(publisher, /len\(content\) > 512 \* 1024/);
});
