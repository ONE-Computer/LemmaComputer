import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxAdapter } from "@lemmacomputer/kasm-adapter";
import { createControllerServer } from "../apps/workspace-controller/src/server.js";
import { policyFixture } from "./policy-fixture.js";

const token = "controller-test-token-0000001";
const workspaceId = "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508";
const runtimePolicy = {
  schemaVersion: 1 as const,
  policyVersionId: "policy-version-1",
  policyVersion: 1,
  policyHash: "a".repeat(64),
  workspaceProfile: "kasm-persistent-standard" as const,
  agentId: "agent-alex",
  agentProfile: "lemmacomputer-default-agent" as const,
  networkProfile: "controlled-egress-v1" as const,
  modelAlias: "lemmacomputer-assistant",
  mcpServer: "lemmacomputer_ms365",
  allowedTools: ["list-mail-folders", "list-calendars", "list-drives"],
  toolPolicies: { "list-mail-folders": "allow" as const, "list-calendars": "allow" as const, "list-drives": "allow" as const },
};
const signedPolicy = policyFixture(runtimePolicy, workspaceId);
let lastGatewayCredential: string | undefined;
let lastAgentBridge: { baseUrl: string; token: string } | undefined;
let lastEgressUpdate: { providerId: string; versionId: string } | undefined;
let purgedWorkspace: { workspaceId: string; accessGeneration?: number } | undefined;
const adapter: SandboxAdapter = {
  async create({ workspaceId, gateway, agentBridge }) {
    lastGatewayCredential = gateway?.credential;
    lastAgentBridge = agentBridge;
    return { providerId: `provider-${workspaceId}`, state: "ready", failureCode: null };
  },
  async updateEgressPolicy(providerId, input) {
    lastEgressUpdate = { providerId, versionId: input.policy.egress!.id };
  },
  async status(providerId) { return { providerId, workspaceId, state: "ready", failureCode: null }; },
  async open() { return { launchUrl: "https://127.0.0.1:16920/", expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
  async destroy() {},
  async purgeWorkspace(workspaceId, accessGeneration) { purgedWorkspace = { workspaceId, accessGeneration }; },
};

test("controller applies a newly signed egress revision without replacing the sandbox", async () => {
  const egressPolicy = {
    ...runtimePolicy,
    policyHash: "c".repeat(64),
    egressMode: "full-web" as const,
    egress: {
      schemaVersion: 2 as const,
      mode: "full-web" as const,
      id: "egv_default_v3",
      securityGroupId: "esg_default",
      version: 3,
      name: "Default security group",
      description: "Default public web with explicit deny exceptions.",
      defaultAction: "allow-public-http-https" as const,
      rules: [{
        id: "deny-chatgpt",
        action: "deny" as const,
        protocol: "https" as const,
        host: "chatgpt.com",
        includeSubdomains: true,
        port: 443,
        purpose: "Block ChatGPT",
      }],
      documentHash: "d".repeat(64),
    },
  };
  const signedEgressPolicy = policyFixture(egressPolicy, workspaceId);
  const app = createControllerServer(adapter, token, signedEgressPolicy.keys);
  const response = await app.inject({
    method: "PUT",
    url: "/internal/v1/sandboxes/provider-existing/egress-policy",
    headers: { "x-controller-token": token },
    payload: {
      workspaceId,
      policy: egressPolicy,
      policyBundle: signedEgressPolicy.bundle,
      egressProxy: {
        token: "signed-workspace-egress-token-at-least-24-characters",
        verificationSecret: "workspace-derived-verification-secret-at-least-32-characters",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        expectedGrant: {
          tenantId: "acme",
          subjectId: "alex",
          workspaceId,
          accessGeneration: 1,
          agentId: egressPolicy.agentId,
          securityGroupVersionId: egressPolicy.egress.id,
          egressMode: egressPolicy.egressMode,
          policyHash: egressPolicy.policyHash,
        },
      },
    },
  });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(lastEgressUpdate, { providerId: "provider-existing", versionId: "egv_default_v3" });
  await app.close();
});

test("private controller hides routes without its internal token", async () => {
  const app = createControllerServer(adapter, token, signedPolicy.keys);
  const response = await app.inject({ method: "GET", url: "/internal/v1/sandboxes/guessed" });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("bodyless open and destroy commands work with internal authentication", async () => {
  const app = createControllerServer(adapter, token, signedPolicy.keys);
  const open = await app.inject({ method: "POST", url: "/internal/v1/sandboxes/provider-1/open", headers: { "x-controller-token": token } });
  assert.equal(open.statusCode, 200);
  assert.equal(open.json().launchUrl, "https://127.0.0.1:16920/");
  const destroy = await app.inject({ method: "DELETE", url: "/internal/v1/sandboxes/provider-1", headers: { "x-controller-token": token } });
  assert.equal(destroy.statusCode, 204);
  const purge = await app.inject({ method: "DELETE", url: "/internal/v1/workspaces/workspace-1/storage?accessGeneration=7", headers: { "x-controller-token": token } });
  assert.equal(purge.statusCode, 204);
  assert.deepEqual(purgedWorkspace, { workspaceId: "workspace-1", accessGeneration: 7 });
  await app.close();
});

test("controller passes a validated scoped gateway grant to the sandbox adapter", async () => {
  const app = createControllerServer(adapter, token, signedPolicy.keys);
  const response = await app.inject({
    method: "POST",
    url: "/internal/v1/sandboxes",
    headers: { "x-controller-token": token },
    payload: {
      workspaceId,
      accessGeneration: 1,
      correlationId: "correlation-002",
      policy: runtimePolicy,
      policyBundle: signedPolicy.bundle,
      gateway: {
        baseUrl: "http://litellm:4000",
        credential: "sk-scoped-controller-test-000001",
        modelAlias: "lemmacomputer-assistant",
        transportModelAlias: "lemmacomputer-assistant",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      agentBridge: {
        baseUrl: "http://lemmacomputer-control:4100",
        token: "scoped-agent-bridge-test-token-000001",
      },
    },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(lastGatewayCredential, "sk-scoped-controller-test-000001");
  assert.deepEqual(lastAgentBridge, {
    baseUrl: "http://lemmacomputer-control:4100",
    token: "scoped-agent-bridge-test-token-000001",
  });
  await app.close();
});

test("controller rejects unsigned, mutated, and route-substituted policy authority", async () => {
  const app = createControllerServer(adapter, token, signedPolicy.keys);
  const base = {
    workspaceId,
    accessGeneration: 1,
    correlationId: "correlation-policy-negative",
    policy: runtimePolicy,
    gateway: {
      baseUrl: "http://litellm:4000",
      credential: "sk-scoped-controller-test-000001",
      modelAlias: "lemmacomputer-assistant",
      transportModelAlias: "lemmacomputer-assistant",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    agentBridge: {
      baseUrl: "http://lemmacomputer-control:4100",
      token: "scoped-agent-bridge-test-token-000001",
    },
  };
  const unsigned = await app.inject({
    method: "POST",
    url: "/internal/v1/sandboxes",
    headers: { "x-controller-token": token },
    payload: base,
  });
  assert.equal(unsigned.statusCode, 403);
  assert.equal(unsigned.json().error.code, "POLICY_SIGNATURE_REQUIRED");

  const mutated = await app.inject({
    method: "POST",
    url: "/internal/v1/sandboxes",
    headers: { "x-controller-token": token },
    payload: {
      ...base,
      policyBundle: {
        ...signedPolicy.bundle,
        signature: `${signedPolicy.bundle.signature.startsWith("A") ? "B" : "A"}${signedPolicy.bundle.signature.slice(1)}`,
      },
    },
  });
  assert.equal(mutated.statusCode, 403);
  assert.equal(mutated.json().error.code, "POLICY_SIGNATURE_INVALID");

  const substituted = await app.inject({
    method: "POST",
    url: "/internal/v1/sandboxes",
    headers: { "x-controller-token": token },
    payload: {
      ...base,
      policyBundle: signedPolicy.bundle,
      gateway: { ...base.gateway, baseUrl: "https://api.anthropic.com" },
    },
  });
  assert.equal(substituted.statusCode, 403);
  assert.equal(substituted.json().error.code, "POLICY_BINDING_MISMATCH");
  await app.close();
});

test("controller destroys a sandbox only through its exact workspace binding", async () => {
  const app = createControllerServer(adapter, token, signedPolicy.keys);
  const denied = await app.inject({
    method: "DELETE",
    url: `/internal/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/sandboxes/provider-existing`,
    headers: { "x-controller-token": token },
  });
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error.code, "WORKSPACE_SANDBOX_BINDING_MISMATCH");
  const allowed = await app.inject({
    method: "DELETE",
    url: `/internal/v1/workspaces/${workspaceId}/sandboxes/provider-existing`,
    headers: { "x-controller-token": token },
  });
  assert.equal(allowed.statusCode, 204);
  await app.close();
});
