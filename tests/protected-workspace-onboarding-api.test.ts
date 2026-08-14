import assert from "node:assert/strict";
import test from "node:test";
import type { EgressSecurityGroupVersion, IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import { resolveProtectedBaselinePolicy } from "@lemmacomputer/policy-integrity";
import {
  MemoryWorkspaceStore,
  mvpPolicyDocument,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import { loadProductPolicyRelease, type ProtectedWorkspacePolicyAdministrationBoundary } from "../apps/control-api/src/protected-workspace-policy.js";
import type { ControllerClient, EgressProxyGrant } from "../apps/control-api/src/service.js";

const proxyToken = "protected-onboarding-proxy-token-at-least-24-characters";
const identity: IdentityContext = {
  tenantId: "protected-acme",
  subjectId: "assigned-admin",
  audience: "lemmacomputer-control",
};
const administrator: SessionPrincipal = {
  userId: identity.subjectId,
  tenantId: identity.tenantId,
  email: "assigned.admin@example.test",
  displayName: "Assigned Admin",
  tenantDisplayName: "Protected Acme",
  roles: ["administrator"],
  identity,
};
const headers = {
  "x-lemmacomputer-proxy-token": proxyToken,
  cookie: "lemmacomputer_session=valid",
};

const authentication = {
  begin: async () => ({ location: "https://login.example.test", cookie: "state=opaque" }),
  complete: async () => { throw new Error("unused"); },
  authenticate: async () => administrator,
  logout: async () => "",
};

test("a newly assigned protected administrator can reach workspace settings and create from a restricted egress ceiling", async () => {
  const release = await loadProductPolicyRelease(new Date("2026-08-12T08:00:00.000Z"));
  const protectedPolicy = resolveProtectedBaselinePolicy({
    baseline: release.verified,
    organizationPolicy: null,
    connectorPolicies: [{
      connectorId: "microsoft-365",
      version: 1,
      documentHash: release.verified.payload.documentHash,
      enabled: true,
      toolPolicies: release.verified.payload.document.constraints.connectors.toolPolicies["microsoft-365"],
    }],
    selection: {
      workspaceProfile: "kasm-persistent-standard",
      agentIds: ["claude-cli"],
      applicationIds: ["firefox"],
      modelAlias: "lemmacomputer-claude",
      serviceClass: "balanced",
      reasoningEffort: "medium",
      egressMode: "restricted",
      connectorIds: ["microsoft-365"],
    },
  });
  const fullWebFallback: EgressSecurityGroupVersion = {
    schemaVersion: 1,
    id: "egv_protected_acme_default_v1",
    securityGroupId: "esg_protected_acme_default",
    tenantId: identity.tenantId,
    version: 1,
    name: "Default security group",
    description: "The built-in network policy attached to new workspaces.",
    defaultAction: "allow-public-http-https",
    rules: [],
    documentHash: "e".repeat(64),
    createdBy: "organization-owner",
    createdAt: "2026-08-12T08:00:00.000Z",
    isDefault: true,
  };
  const legacyPolicy: EffectivePolicy = {
    assignmentId: "legacy-assignment",
    policyBundleId: "legacy-bundle",
    policyVersionId: "legacy-version",
    version: 1,
    documentHash: "a".repeat(64),
    assignedBy: "organization-owner",
    assignedAt: "2026-08-12T08:00:00.000Z",
    agentId: "legacy-agent",
    vendorUserId: "assigned-admin-vendor",
    document: mvpPolicyDocument(),
    egressSecurityGroup: fullWebFallback,
  };
  let egressLookups = 0;
  const identityPolicyStore = {
    getPrincipal: async (userId: string) => userId === administrator.userId ? administrator : null,
    getEffectivePolicy: async (userId: string) => userId === administrator.userId ? legacyPolicy : null,
    getWorkspaceEgressSecurityGroup: async () => {
      egressLookups += 1;
      return fullWebFallback;
    },
    listEgressSecurityGroups: async () => [fullWebFallback],
  } as unknown as IdentityPolicyStore;
  const protectedWorkspacePolicy = {
    effectiveMemberPolicy: async (tenantId: string, subjectId: string) => tenantId === identity.tenantId && subjectId === identity.subjectId
      ? { state: "assigned" as const, policy: protectedPolicy }
      : { state: "unassigned" as const },
  } as unknown as ProtectedWorkspacePolicyAdministrationBoundary;
  let createdPolicy: RuntimePolicy | null = null;
  let createdEgressProxy: EgressProxyGrant | undefined;
  const controller = {
    create: async (input: Parameters<ControllerClient["create"]>[0]) => {
      createdPolicy = input.policy;
      createdEgressProxy = input.egressProxy;
      return { providerId: `sandbox-${input.workspaceId}`, state: "ready" as const, failureCode: null };
    },
    updateEgressPolicy: async () => undefined,
    status: async (providerId: string) => ({ providerId, state: "ready" as const, failureCode: null }),
    open: async () => ({ launchUrl: "http://gateway/workspace", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    destroy: async () => undefined,
    destroyWorkspace: async () => undefined,
    purgeWorkspace: async () => undefined,
  } satisfies ControllerClient;
  const store = new MemoryWorkspaceStore();
  const app = createControlServer(store, controller, proxyToken, undefined, undefined, {}, {
    authentication,
    identityPolicyStore,
    protectedWorkspacePolicy,
    agentBridgeSecret: "protected-onboarding-agent-bridge-secret-at-least-32-characters",
    egressGrantSecret: "protected-onboarding-egress-secret-at-least-32-characters",
  });

  try {
    const current = await app.inject({ method: "GET", url: "/v1/workspaces/current", headers });
    assert.equal(current.statusCode, 404);
    assert.equal(current.json().error.code, "WORKSPACE_NOT_FOUND");
    assert.equal(egressLookups, 0, "absence is resolved before runtime egress policy");

    const listed = await app.inject({ method: "GET", url: "/v1/workspaces", headers });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().workspaces, []);
    assert.equal(egressLookups, 0, "an empty inventory does not require a workspace runtime policy");

    const settings = await app.inject({ method: "GET", url: "/v1/sandbox-settings?grantId=personal", headers });
    assert.equal(settings.statusCode, 200);
    assert.equal(settings.json().manifest.sandbox.egressMode, "restricted");
    assert.equal(settings.json().securityGroup.defaultAction, "deny");
    assert.equal(settings.json().securityGroup.id, fullWebFallback.id);
    assert.notEqual(settings.json().securityGroup.documentHash, fullWebFallback.documentHash);
    assert.equal(settings.json().availableSecurityGroups[0].id, fullWebFallback.id);
    assert.equal(settings.json().availableSecurityGroups[0].defaultAction, "deny");

    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "protected-admin-create-0001" },
      payload: { grantId: "personal" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().state, "ready");
    assert.equal(createdPolicy?.egressMode, "restricted");
    assert.equal(createdPolicy?.egress?.defaultAction, "deny");
    assert.equal(createdEgressProxy?.expectedGrant.egressMode, "restricted");
    assert.equal(createdEgressProxy?.expectedGrant.securityGroupVersionId, fullWebFallback.id);

    const lookupsBeforeCurrent = egressLookups;
    const currentAfterCreate = await app.inject({ method: "GET", url: "/v1/workspaces/current", headers });
    assert.equal(currentAfterCreate.statusCode, 200);
    assert.ok(egressLookups > lookupsBeforeCurrent, "an existing workspace still evaluates its current runtime policy");
    assert.equal(currentAfterCreate.json().profile.egressMode, "restricted");
  } finally {
    await app.close();
  }
});
