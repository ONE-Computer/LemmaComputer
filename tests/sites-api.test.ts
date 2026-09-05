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
import { SitesService } from "../apps/control-api/src/sites.js";
import type { TransactionalEmailMessage } from "../apps/control-api/src/transactional-email.js";

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
    invitationDelivery: { mode: "copy-link", email: { send: async () => { assert.fail("copy-link invitations must not send email"); } } },
  });
  try {
    const published = await app.inject({ method: "POST", url: "/internal/v1/agent/sites", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { ...payload, sourceWorkspaceId: "22222222-2222-4222-8222-222222222222", sourceWorkspaceGeneration: 999, sourceAgentId: "spoofed" } });
    assert.equal(published.statusCode, 201, published.body);
    assert.equal(published.json().sourceWorkspaceId, workspace.id);
    assert.equal(published.json().sourceAgentId, policy.agentId);
    assert.match(published.json().stableUrl, /^https:\/\/lemma\.example\/s\//);

    const skills = await app.inject({ method: "GET", url: "/v1/skills", headers: browserHeaders });
    assert.equal(skills.json().skills[0].id, "site");
    assert.equal(skills.json().skills[0].displayName, "$site");
    assert.equal(skills.json().skills[0].defaultPrompt, "$site");
    const listed = await app.inject({ method: "GET", url: "/v1/sites", headers: browserHeaders });
    assert.equal(listed.json().sites[0].id, published.json().id);

    const viewer = await app.inject({ method: "GET", url: `/v1/sites/viewer/${published.json().handle}`, headers: browserHeaders });
    assert.equal(viewer.statusCode, 200, viewer.body);
    const assetUrl = viewer.json().entryUrl.replace(/^\/api/, "");
    const asset = await app.inject({ method: "GET", url: assetUrl, headers: { "x-lemmacomputer-proxy-token": proxyToken } });
    assert.equal(asset.statusCode, 200, asset.body);
    assert.equal(asset.headers["cache-control"], "private, no-store");
    assert.match(asset.headers["content-security-policy"] ?? "", /sandbox allow-scripts/);
    assert.match(asset.headers["content-security-policy"] ?? "", /navigate-to 'none'/);
    assert.match(asset.body, /Hello world/);
    assert.equal(asset.headers["access-control-allow-origin"], "null");
    assert.equal(asset.headers["access-control-allow-credentials"], "true");
    assert.equal((await app.inject({ method: "GET", url: assetUrl })).statusCode, 401, "proxy trust is still required");
    assert.equal((await app.inject({ method: "POST", url: assetUrl, headers: browserHeaders })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: assetUrl.replace("/versions/1/", "/versions/2/"), headers: browserHeaders })).statusCode, 404);

    const visibility = await app.inject({ method: "PATCH", url: `/v1/sites/${published.json().id}`, headers: { ...browserHeaders, "content-type": "application/json" }, payload: { visibility: "restricted" } });
    assert.equal(visibility.statusCode, 200, visibility.body);
    const invitation = await app.inject({ method: "POST", url: `/v1/sites/${published.json().id}/invitations`, headers: { ...browserHeaders, "content-type": "application/json", "idempotency-key": "invite-guest-test-0001" }, payload: { email: "guest@example.test" } });
    assert.equal(invitation.statusCode, 201, invitation.body);
    assert.equal(invitation.json().delivery.mode, "copy-link");
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
    assert.equal((await app.inject({ method: "GET", url: assetUrl, headers: browserHeaders })).statusCode, 404, "cached bytes do not bypass deletion");
  } finally { await app.close(); }
});

test("site roles authorize external accounts without org membership and email failures remain retryable", async () => {
  const siteStore = new MemorySiteStore(), artifacts = new MemoryArtifactStore();
  const service = new SitesService(siteStore, artifacts);
  const site = await service.publish(identity, { ...payload, sourceWorkspaceId: "22222222-2222-4222-8222-222222222222", sourceWorkspaceGeneration: 1, sourceAgentId: "hermes" });
  const guestId = "33333333-3333-4333-8333-333333333333";
  let current: "owner" | "guest" | "anonymous" = "owner", emailAccepted = false;
  const messages: TransactionalEmailMessage[] = [];
  const app = createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, { publicWebUrl: "https://lemma.example" }, {
    agentBridgeSecret,
    siteStore, artifactStore: artifacts,
    customerProductAuthentication: { resolve: async () => current === "anonymous" ? { status: "anonymous" } : current === "owner"
      ? { status: "authorized", principal, accountUserId: principal.accountUserId, authenticationSessionId: principal.accountUserId, user: { name: "Alex", email: principal.email } }
      : { status: "membership-required", accountUserId: guestId, authenticationSessionId: guestId, user: { name: "Guest", email: "guest@example.test" } } } as never,
    invitationDelivery: { mode: "email", email: { send: async (message) => { messages.push(message); return { accepted: emailAccepted, failure: emailAccepted ? null : "retryable", providerMessageId: emailAccepted ? "test-provider-id" : null }; } } },
  });
  const headers = { "x-lemmacomputer-proxy-token": proxyToken, "idempotency-key": "site-email-retry-001" };
  const url = `/v1/sites/${site.id}`;
  try {
    const failed = await app.inject({ method: "POST", url: `${url}/invitations`, headers, payload: { email: "guest@example.test" } });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error.code, "SITE_INVITATION_EMAIL_FAILED");
    emailAccepted = true;
    const sent = await app.inject({ method: "POST", url: `${url}/invitations`, headers, payload: { email: "guest@example.test" } });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().acceptancePath, null);
    assert.deepEqual(sent.json().delivery, { mode: "email", captured: false });
    assert.equal(messages.length, 2);
    assert.equal(messages[1]!.to, "guest@example.test");
    assert.equal(messages[1]!.kind, "site-invitation");
    const token = messages[1]!.text.match(/invite=(lsi_[A-Za-z0-9_-]+)/)![1];
    assert.notEqual(messages[0]!.text, messages[1]!.text, "retry rotates the first unsuccessful invitation token");
    current = "guest";
    assert.equal((await app.inject({ method: "POST", url: "/v1/sites/invitations/accept", headers, payload: { token } })).statusCode, 200);
    const listed = await app.inject({ method: "GET", url: "/v1/sites", headers });
    assert.equal(listed.json().sites[0].role, "member");
    for (const request of [
      { method: "GET" as const, url },
      { method: "PATCH" as const, url, payload: { visibility: "organization" } },
      { method: "POST" as const, url: `${url}/grants`, payload: { accountUserId: guestId, permission: "admin" } },
      { method: "POST" as const, url: `${url}/invitations`, payload: { email: "unwanted@example.test" } },
      { method: "POST" as const, url: `${url}/versions/1/restore`, payload: {} },
      { method: "DELETE" as const, url },
    ]) assert.equal((await app.inject({ ...request, headers })).statusCode, 404);
    assert.equal(messages.length, 2, "read access cannot trigger an email");
    await service.grant(identity, site.id, { accountUserId: guestId, permission: "admin" });
    assert.equal((await app.inject({ method: "GET", url, headers })).json().site.role, "admin");
    assert.equal((await app.inject({ method: "PATCH", url, headers, payload: { visibility: "organization" } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `${url}/versions/1/restore`, headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `${url}/invitations`, headers: { ...headers, "idempotency-key": "admin-email-test-001" }, payload: { email: "reader@example.test" } })).statusCode, 201);
    assert.equal(messages.length, 3);
    assert.equal((await app.inject({ method: "DELETE", url, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/v1/workspaces", headers })).statusCode, 403, "site Admin grants no organization access");
    current = "anonymous";
    assert.equal((await app.inject({ method: "GET", url, headers })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: `${url}/invitations`, headers, payload: { email: "unwanted@example.test" } })).statusCode, 401);
    current = "owner";
    assert.equal((await app.inject({ method: "DELETE", url, headers })).statusCode, 204);
  } finally { await app.close(); }
});
