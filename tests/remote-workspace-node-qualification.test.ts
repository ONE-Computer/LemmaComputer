import assert from "node:assert/strict";
import test from "node:test";
import {
  qualificationNames,
  renderControlOverride,
  renderNodeCompose,
  replaceEnvironment,
} from "../scripts/qualify-remote-workspace-node.mjs";

test("remote workspace-node qualification names remain scoped to the worktree project", () => {
  assert.deepEqual(qualificationNames("LemmaComputer-Issue_74"), {
    nodeProject: "lemmacomputer-issue_74-remote-node",
    nodeId: "lemmacomputer-issue_74-remote-node-1",
    nodeTransportNetwork: "lemmacomputer-issue_74-remote-node-transport",
    applicationNetwork: "lemmacomputer-issue_74-remote-application",
    relayNetwork: "lemmacomputer-issue_74-remote-relay-ingress",
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
  assert.match(control, /WORKSPACE_NODE_TOPOLOGY: remote/);
  assert.match(control, /artifact-data-init: \{ condition: service_completed_successfully \}/);
  assert.match(control, /platform-auth-db-migrate: \{ condition: service_completed_successfully \}/);
  assert.match(control, /LITELLM_WORKSPACE_URL: https:\/\/application-tls:4444/);
  assert.match(control, /AGENT_BRIDGE_URL: https:\/\/application-tls:4443/);
  assert.match(control, /WORKSPACE_INGRESS_VERIFY_UPSTREAM_TLS: "true"/);
  assert.match(control, /QUALIFICATION_NODE_CLIENT_KEY_B64/);
  assert.match(control, /QUALIFICATION_INGRESS_CLIENT_CERT_B64/);
  assert.match(control, /QUALIFICATION_INGRESS_CLIENT_KEY_B64/);
  assert.match(control, /user: "\$\{QUALIFICATION_HOST_UID:\?set qualification host UID\}:\$\{QUALIFICATION_HOST_GID:\?set qualification host GID\}"/);
  assert.doesNotMatch(control, /BEGIN (?:RSA )?PRIVATE KEY/);
  assert.match(node, /QUALIFICATION_NODE_TRANSPORT_NETWORK/);
  assert.match(control, /QUALIFICATION_APPLICATION_NETWORK/);
  assert.doesNotMatch(node, /tmpfs:\s*\[/);
  assert.doesNotMatch(control, /tmpfs:\s*\[/);
  assert.match(node, /tmpfs:\s*\n\s+- \/tmp:rw,noexec,nosuid,size=64m/);
  assert.match(control, /tmpfs:\s*\n\s+- \/tmp:rw,noexec,nosuid,size=16m/);
});

test("qualification application forwarders authenticate node-local relays", async () => {
  const forwarder = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../scripts/remote-workspace-node-tls-forwarder.mjs", import.meta.url),
    "utf8",
  ));
  assert.match(forwarder, /requestCert:\s*true/);
  assert.match(forwarder, /rejectUnauthorized:\s*true/);
  assert.match(forwarder, /lemmacomputer-workspace-application-gateway/);
  assert.match(forwarder, /getPeerCertificate/);
});

test("qualification recovery scopes orphan-network cleanup to its Compose project", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../scripts/qualify-remote-workspace-node.mjs", import.meta.url),
    "utf8",
  ));
  assert.match(source, /label=com\.docker\.compose\.project=\$\{projectName\}/);
  assert.match(source, /Object\.keys\(containers\)\.length/);
  assert.match(source, /"rm", "-s", "-f", "workspace-controller"/);
  assert.doesNotMatch(source, /docker[^\n]*system[^\n]*prune|network[^\n]*prune/);
});
