import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { IdentityContext } from "@lemmacomputer/contracts";
import {
  MemorySiteStore,
  MemoryWorkspaceStore,
  runtimePolicyFor,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { AgentBridgeAuthority } from "../apps/control-api/src/agent-bridge.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "sites-api-proxy-token-at-least-24-characters";
const agentBridgeSecret = "sites-api-bridge-secret-at-least-32-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
const principal: SessionPrincipal = {
  userId: identity.subjectId,
  tenantId: identity.tenantId,
  email: "alex@acme.example",
  displayName: "Alex",
  tenantDisplayName: "Acme",
  roles: ["employee"],
  identity,
};
const effectivePolicy: EffectivePolicy = {
  assignmentId: "sites-assignment",
  policyBundleId: "sites-bundle",
  policyVersionId: "sites-policy",
  version: 1,
  documentHash: "a".repeat(64),
  assignedBy: "administrator",
  assignedAt: new Date().toISOString(),
  agentId: "agent-alex",
  vendorUserId: "vendor-alex",
  document: {
    schemaVersion: 1,
    workspaceProfile: "kasm-persistent-standard",
    workspaceProfiles: ["kasm-persistent-standard"],
    agentProfile: "hermes-claw-managed-v1",
    agents: ["hermes-claw"],
    defaultAgents: ["hermes-claw"],
    applications: ["firefox"],
    defaultApplications: ["firefox"],
    modelAliases: ["lemmacomputer-assistant"],
    networkProfile: "controlled-egress-v1",
    mcp: {
      servers: {
        lemmacomputer_fixture: {
          tools: ["search_files"],
          toolPolicies: { search_files: "allow" },
        },
      },
    },
  },
};
const identityPolicies = {
  getPrincipal: async (userId: string) => userId === principal.userId ? principal : null,
  getEffectivePolicy: async (userId: string) => userId === principal.userId ? effectivePolicy : null,
} as unknown as IdentityPolicyStore;
const browserHeaders = {
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": identity.tenantId,
  "x-lemmacomputer-test-user-id": identity.subjectId,
};
const html = Buffer.from("<!doctype html><html><body>Hello world</body></html>");
const payload = {
  name: "Hello world",
  slug: "hello-world",
  htmlBase64: html.toString("base64"),
  artifactSha256: createHash("sha256").update(html).digest("hex"),
};

test("scoped agent publishing appears in the owner Sites API", async () => {
  const workspaceStore = new MemoryWorkspaceStore();
  const siteStore = new MemorySiteStore();
  const workspace = await workspaceStore.createOrGet(identity, "personal", "sites-workspace");
  await workspaceStore.update(workspace.id, { state: "ready" });
  const policy = runtimePolicyFor(effectivePolicy);
  const token = new AgentBridgeAuthority(agentBridgeSecret).issue(identity, workspace.id, policy, {
    workspaceGeneration: workspace.bridgeGrantGeneration,
  });
  const app = createControlServer(workspaceStore, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    identityPolicyStore: identityPolicies,
    siteStore,
    agentBridgeSecret,
  });

  try {
    const published = await app.inject({
      method: "POST",
      url: "/internal/v1/agent/sites",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { ...payload, sourceWorkspaceId: "22222222-2222-4222-8222-222222222222", sourceAgentId: "spoofed" },
    });
    assert.equal(published.statusCode, 201);
    assert.equal(published.json().sourceWorkspaceId, workspace.id);
    assert.equal(published.json().sourceAgentId, policy.agentId);

    const skills = await app.inject({ method: "GET", url: "/v1/skills", headers: browserHeaders });
    assert.equal(skills.statusCode, 200);
    assert.equal(skills.json().skills[0].id, "make-a-site");

    const listed = await app.inject({ method: "GET", url: "/v1/sites", headers: browserHeaders });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().sites[0].id, published.json().id);

    const preview = await app.inject({ method: "GET", url: `/v1/sites/${published.json().id}/preview`, headers: browserHeaders });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().html, html.toString());

    const content = await app.inject({ method: "GET", url: `/v1/sites/${published.json().id}/content`, headers: browserHeaders });
    assert.equal(content.statusCode, 200);
    assert.match(content.headers["content-type"] ?? "", /^text\/html/);
    assert.match(content.headers["content-security-policy"] ?? "", /sandbox allow-scripts/);
    assert.equal(content.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(content.body, html.toString());

    const staleToken = new AgentBridgeAuthority(agentBridgeSecret).issue(identity, workspace.id, { ...policy, policyHash: "b".repeat(64) }, {
      workspaceGeneration: workspace.bridgeGrantGeneration,
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/internal/v1/agent/sites",
      headers: { authorization: `Bearer ${staleToken}`, "content-type": "application/json" },
      payload,
    });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.json().error.code, "SITE_POLICY_BINDING_MISMATCH");

    const removed = await app.inject({ method: "DELETE", url: `/v1/sites/${published.json().id}`, headers: browserHeaders });
    assert.equal(removed.statusCode, 204);
    assert.deepEqual((await siteStore.listOwnedSites(identity)), []);
  } finally {
    await app.close();
  }
});
