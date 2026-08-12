import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(path, "utf8");

test("every interactive agent launcher fails closed through the server-issued instance wrapper", () => {
  const launchers = {
    "claude-cli": "docker/workspace/lemmacomputer-claude",
    "codex-cli": "docker/workspace/lemmacomputer-codex",
    "hermes-claw": "docker/workspace/lemmacomputer-hermes",
    "claude-desktop": "docker/workspace/lemmacomputer-claude-desktop",
    "hermes-desktop": "docker/workspace/lemmacomputer-hermes-desktop",
  };
  for (const [catalogId, path] of Object.entries(launchers)) {
    assert.match(source(path), new RegExp(`lemmacomputer-agent-launch ${catalogId.replace("-", "\\-")}`));
  }
  const wrapper = source("docker/workspace/lemmacomputer-agent-launch.py");
  assert.match(wrapper, /"launchNonce": str\(uuid\.uuid4\(\)\)/);
  assert.match(wrapper, /env\["LEMMACOMPUTER_AGENT_INSTANCE_ID"\] = instance_id/);
  assert.match(wrapper, /workspace-pid:\{process\.pid\}/);
  assert.match(wrapper, /"reason": "process_exited"/);
  assert.match(wrapper, /"provider_failed" if process else "launch_failed"/);
});

test("model and connector transports inherit only the wrapper-issued instance identity", () => {
  const entrypoint = source("docker/workspace/lemmacomputer-workspace-entrypoint.sh");
  const connectors = source("docker/workspace/lemmacomputer-connectors-stdio.py");
  const broker = source("docker/workspace/lemmacomputer-gateway-proxy.py");
  const policyCallback = source("integrations/litellm/lemmacomputer_policy_callback.py");
  assert.match(entrypoint, /env_http_headers = \{ "x-lemmacomputer-agent-instance-id" = "LEMMACOMPUTER_AGENT_INSTANCE_ID" \}/);
  assert.match(connectors, /headers\["x-lemmacomputer-agent-instance-id"\] = agent_instance_id/);
  assert.match(broker, /AGENT_INSTANCE_PATTERN/);
  assert.match(broker, /\/internal\/v1\/agent\/instances/);
  assert.match(broker, /self\.headers\.get\("x-lemmacomputer-agent-instance-id"\)/);
  assert.match(entrypoint, /LEMMACOMPUTER_INFER_SINGLE_ACTIVE_AGENT_INSTANCE="\$infer_single_active_agent_instance"/);
  assert.match(broker, /if len\(ACTIVE_AGENT_INSTANCE_IDS\) != 1:/);
  assert.match(broker, /ACTIVE_AGENT_INSTANCE_IDS\.add\(instance_id\)/);
  assert.match(broker, /ACTIVE_AGENT_INSTANCE_IDS\.discard\(instance_id\)/);
  assert.match(policyCallback, /"agentInstanceId": _agent_instance_id\(data\)/);
  assert.match(policyCallback, /"agentInstanceId",[\s\S]*MCP_IDENTITY_CONTEXT_MISSING/);
});
