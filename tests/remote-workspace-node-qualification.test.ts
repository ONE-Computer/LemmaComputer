import assert from "node:assert/strict";
import test from "node:test";
import {
  qualificationNames,
  renderControlOverride,
  renderNodeCompose,
  replaceEnvironment,
} from "../scripts/qualify-remote-workspace-node.mjs";

test("remote workspace-node qualification names remain scoped to the worktree project", () => {
  assert.deepEqual(qualificationNames("oc-Issue_74"), {
    nodeProject: "oc-issue_74-remote-node",
    nodeId: "oc-issue_74-remote-node-1",
    nodeTransportNetwork: "oc-issue_74-remote-node-transport",
    applicationNetwork: "oc-issue_74-remote-application",
    relayNetwork: "oc-issue_74-remote-relay-ingress",
  });
});

test("remote controller projection fails when the rendered environment contract is incomplete", () => {
  assert.throws(
    () => replaceEnvironment("A=1\n", new Map([["A", "2"], ["B", "3"]])),
    /missing: B/i,
  );
  assert.equal(replaceEnvironment("A=1\nB=2\n", new Map([["A", "remote"]])), "A=remote\nB=2\n");
});

test("qualification Compose separates Docker authority and uses variable-backed TLS material", () => {
  const node = renderNodeCompose();
  const control = renderControlOverride();
  assert.match(node, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.doesNotMatch(control, /docker\.sock/);
  assert.match(control, /CONTROLLER_URL: https:\/\/workspace-node:4101/);
  assert.match(control, /LITELLM_WORKSPACE_URL: https:\/\/application-tls:4444/);
  assert.match(control, /AGENT_BRIDGE_URL: https:\/\/application-tls:4443/);
  assert.match(control, /WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS: "true"/);
  assert.match(control, /QUALIFICATION_NODE_CLIENT_KEY_B64/);
  assert.doesNotMatch(control, /BEGIN (?:RSA )?PRIVATE KEY/);
});
