import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MemoryArtifactStore } from "@lemmacomputer/artifact-store";
import type { IdentityContext } from "@lemmacomputer/contracts";
import { MemorySiteStore, MemoryWorkspaceStore, runtimePolicyFor, type EffectivePolicy, type IdentityPolicyStore, type SessionPrincipal } from "@lemmacomputer/workspace-store";
import { AgentBridgeAuthority } from "../apps/control-api/src/agent-bridge.js";
import { createDeterministicSiteZip, validateSiteBundle } from "../apps/control-api/src/site-bundle.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "sites-api-proxy-token-at-least-24-characters";
const agentBridgeSecret = "sites-api-bridge-secret-at-least-32-characters";
const identity: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
const principal: SessionPrincipal = { userId: "alex", accountUserId: "11111111-1111-4111-8111-111111111111", tenantId: "acme", role: "owner", email: "alex@acme.example", displayName: "Alex", tenantDisplayName: "Acme", roles: ["owner", "administrator"], identity };
const effectivePolicy: EffectivePolicy = {
  assignmentId: "sites-assignment", policyBundleId: "sites-bundle", policyVersionId: "sites-policy", version: 1,
  documentHash: "a".repeat(64), assignedBy: "administrator", assignedAt: new Date().toISOString(), agentId: "agent-alex", vendorUserId: "vendor-alex",
  document: { schemaVersion: 1, workspaceProfile: "kasm-persistent-standard", workspaceProfiles: ["kasm-persistent-standard"], agentProfile: "hermes-claw-managed-v1", agents: ["hermes-claw"], defaultAgents: ["hermes-claw"], applications: ["firefox"], defaultApplications: ["firefox"], modelAliases: ["lemmacomputer-assistant"], networkProfile: "controlled-egress-v1", mcp: { servers: { lemmacomputer_fixture: { tools: ["search_files"], toolPolicies: { search_files: "allow" } } } } },
};
const identityPolicies = { getPrincipal: async (userId: string) => userId === principal.userId ? principal : null, getEffectivePolicy: async (userId: string) => userId === principal.userId ? effectivePolicy : null } as unknown as IdentityPolicyStore;
const browserHeaders = { "x-lemmacomputer-proxy-token": proxyToken, "x-lemmacomputer-test-tenant-id": "acme", "x-lemmacomputer-test-user-id": "alex", "x-lemmacomputer-test-account-user-id": principal.accountUserId! };
const archive = createDeterministicSiteZip(new Map([
  ["index.html", Buffer.from("<!doctype html><html><link rel=\"stylesheet\" href=\"./assets/app.css\"><body>Hello world</body></html>")],
  ["assets/app.css", Buffer.from("body{color:#123}")],
]));
const checked = validateSiteBundle(archive);
const payload = { name: "Hello world", slug: "hello-world", bundleBase64: archive.toString("base64"), archiveSha256: checked.archiveSha256, archiveSizeBytes: archive.length, manifestSha256: checked.manifestSha256, idempotencyKey: createHash("sha256").update(archive).digest("hex"), sourceProjectPath: "Sites/hello-world" };

test("agent publication, stable authenticated viewing, sharing, and deletion use scoped authority", async () => {
  const workspaceStore = new MemoryWorkspaceStore();
  const siteStore = new MemorySiteStore();
  const workspace = await workspaceStore.createOrGet(identity, "personal", "sites-workspace");
  await workspaceStore.update(workspace.id, { state: "ready" });
  const policy = runtimePolicyFor(effectivePolicy);
  const token = new AgentBridgeAuthority(agentBridgeSecret).issue(identity, workspace.id, policy, { workspaceGeneration: workspace.accessGeneration });
  const app = createControlServer(workspaceStore, {} as ControllerClient, proxyToken, undefined, undefined, { publicWebUrl: "https://lemma.example" }, {
    testIdentityMode: true, identityPolicyStore: identityPolicies, siteStore, artifactStore: new MemoryArtifactStore(), agentBridgeSecret,
  });
  try {
    const published = await app.inject({ method: "POST", url: "/internal/v1/agent/sites", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { ...payload, sourceWorkspaceId: "22222222-2222-4222-8222-222222222222", sourceWorkspaceGeneration: 999, sourceAgentId: "spoofed" } });
    assert.equal(published.statusCode, 201, published.body);
    assert.equal(published.json().sourceWorkspaceId, workspace.id);
    assert.equal(published.json().sourceAgentId, policy.agentId);
    assert.match(published.json().stableUrl, /^https:\/\/lemma\.example\/s\//);

    const skills = await app.inject({ method: "GET", url: "/v1/skills", headers: browserHeaders });
    assert.equal(skills.json().skills[0].id, "site");
    const listed = await app.inject({ method: "GET", url: "/v1/sites", headers: browserHeaders });
    assert.equal(listed.json().sites[0].id, published.json().id);

    const viewer = await app.inject({ method: "GET", url: `/v1/sites/viewer/${published.json().handle}`, headers: browserHeaders });
    assert.equal(viewer.statusCode, 200, viewer.body);
    const asset = await app.inject({ method: "GET", url: viewer.json().entryUrl.replace(/^\/api/, ""), headers: browserHeaders });
    assert.equal(asset.statusCode, 200, asset.body);
    assert.equal(asset.headers["cache-control"], "private, no-store");
    assert.match(asset.headers["content-security-policy"] ?? "", /sandbox allow-scripts/);
    assert.match(asset.headers["content-security-policy"] ?? "", /navigate-to 'none'/);
    assert.match(asset.body, /Hello world/);

    const visibility = await app.inject({ method: "PATCH", url: `/v1/sites/${published.json().id}`, headers: { ...browserHeaders, "content-type": "application/json" }, payload: { visibility: "restricted" } });
    assert.equal(visibility.statusCode, 200, visibility.body);
    const invitation = await app.inject({ method: "POST", url: `/v1/sites/${published.json().id}/invitations`, headers: { ...browserHeaders, "content-type": "application/json", "idempotency-key": "invite-guest-test-0001" }, payload: { email: "guest@example.test" } });
    assert.equal(invitation.statusCode, 201, invitation.body);
    const replayedInvitation = await app.inject({ method: "POST", url: `/v1/sites/${published.json().id}/invitations`, headers: { ...browserHeaders, "content-type": "application/json", "idempotency-key": "invite-guest-test-0001" }, payload: { email: "guest@example.test" } });
    assert.equal(replayedInvitation.statusCode, 200, replayedInvitation.body);
    assert.equal(replayedInvitation.json().replayed, true);
    const invitationToken = new URL(replayedInvitation.json().acceptancePath, "https://lemma.example").searchParams.get("invite")!;
    const guestHeaders = { "x-lemmacomputer-proxy-token": proxyToken, "x-lemmacomputer-test-tenant-id": "globex", "x-lemmacomputer-test-user-id": "guest", "x-lemmacomputer-test-account-user-id": "33333333-3333-4333-8333-333333333333" };
    const denied = await app.inject({ method: "GET", url: `/v1/sites/viewer/${published.json().handle}`, headers: guestHeaders });
    assert.equal(denied.statusCode, 404);
    const accepted = await app.inject({ method: "POST", url: "/v1/sites/invitations/accept", headers: { ...guestHeaders, "content-type": "application/json" }, payload: { token: invitationToken } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const shared = await app.inject({ method: "GET", url: `/v1/sites/viewer/${published.json().handle}`, headers: guestHeaders });
    assert.equal(shared.statusCode, 200, shared.body);

    const removed = await app.inject({ method: "DELETE", url: `/v1/sites/${published.json().id}`, headers: browserHeaders });
    assert.equal(removed.statusCode, 204);
  } finally { await app.close(); }
});
