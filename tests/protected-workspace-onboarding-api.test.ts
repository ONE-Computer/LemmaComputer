import assert from "node:assert/strict";
import test from "node:test";
import type { EgressSecurityGroupVersion, IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import {
  MemoryWorkspaceStore,
  mvpPolicyDocument,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type RoutingStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ProtectedWorkspacePolicyAdministrationBoundary } from "../apps/control-api/src/protected-workspace-policy.js";
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
  resolve: async () => ({ status: "authorized" as const, principal: administrator }),
};

test("a new organization has no policy ceiling and its administrator can create a workspace", async () => {
  const fullWebFallback: EgressSecurityGroupVersion = {
    schemaVersion: 1,
    id: "egv_protected_acme_default_v1",
    securityGroupId: "esg_protected_acme_default",
    tenantId: identity.tenantId,
    version: 1,
    name: "Internet workspace default",
    description: "The built-in public-web policy inherited by Internet workspaces.",
    defaultAction: "allow-public-http-https",
    rules: [],
    documentHash: "e".repeat(64),
    createdBy: "organization-owner",
    createdAt: "2026-08-12T08:00:00.000Z",
    isDefault: true,
    defaultFor: "internet",
    assignmentSource: "workspace-type",
  };
  const managedFallback: EgressSecurityGroupVersion = {
    ...fullWebFallback,
    id: "egv_protected_acme_managed_default_v1",
    securityGroupId: "esg_protected_acme_managed_default",
    name: "Managed workspace default",
    description: "The built-in deny-by-default policy inherited by Managed workspaces.",
    defaultAction: "deny",
    defaultFor: "managed",
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
    listUsers: async () => [{
      userId: administrator.userId,
      email: administrator.email,
      displayName: administrator.displayName,
      roles: administrator.roles,
      status: "active",
      effectivePolicy: legacyPolicy,
    }],
    getWorkspaceEgressSecurityGroup: async ({ profileId }: { profileId: string }) => {
      egressLookups += 1;
      return profileId === "disposable-open-v1" ? fullWebFallback : managedFallback;
    },
    listEgressSecurityGroups: async () => [managedFallback, fullWebFallback],
  } as unknown as IdentityPolicyStore;
  const protectedWorkspacePolicy = {
    currentOrganizationPolicy: async () => null,
  } as unknown as ProtectedWorkspacePolicyAdministrationBoundary;
  let routeVersion = 1;
  let currentMapping = {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: identity.tenantId,
    revisionNote: "Initial Lite route",
    createdBy: administrator.userId,
    createdAt: new Date("2026-08-12T08:00:00.000Z"),
    deployments: [{ serviceClass: "lite" as const, capabilities: { contextTokens: 128000, outputTokens: 32768, vision: true, tools: true, streaming: true, residency: [] as string[] } }],
  };
  const routingStore = {
    latestMappingVersion: async () => currentMapping,
    createMappingVersion: async (input: Parameters<RoutingStore["createMappingVersion"]>[0]) => {
      routeVersion += 1;
      currentMapping = {
        id: `11111111-1111-4111-8111-${String(routeVersion).padStart(12, "0")}`,
        tenantId: input.tenantId,
        revisionNote: input.revisionNote,
        createdBy: input.createdBy,
        createdAt: new Date("2026-08-12T09:00:00.000Z"),
        deployments: input.deployments.map((deployment, index) => ({
          ...deployment,
          id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
          providerAccountId: deployment.providerAccountId ?? null,
          region: deployment.region ?? null,
          providerServiceTier: deployment.providerServiceTier ?? null,
          rateCardId: deployment.rateCardId ?? null,
        })),
      };
      return currentMapping;
    },
    createPolicy: async () => "33333333-3333-4333-8333-333333333333",
    createRollout: async () => ({}),
  } as unknown as RoutingStore;
  const createdPolicies: RuntimePolicy[] = [];
  let createdEgressProxy: EgressProxyGrant | undefined;
  let destroyedWorkspaces = 0;
  const controller = {
    create: async (input: Parameters<ControllerClient["create"]>[0]) => {
      createdPolicies.push(input.policy);
      createdEgressProxy = input.egressProxy;
      return { providerId: `sandbox-${input.workspaceId}`, state: "ready" as const, failureCode: null };
    },
    updateEgressPolicy: async () => undefined,
    status: async (providerId: string) => ({ providerId, state: "ready" as const, failureCode: null }),
    open: async () => ({ launchUrl: "http://gateway/workspace", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    destroy: async () => undefined,
    destroyWorkspace: async () => { destroyedWorkspaces += 1; },
    purgeWorkspace: async () => undefined,
  } satisfies ControllerClient;
  const store = new MemoryWorkspaceStore();
  (store as MemoryWorkspaceStore & { saveSandboxSettings: (...args: unknown[]) => Promise<never> }).saveSandboxSettings = async () => {
    throw new Error("Unqualified selections must be rejected before persistence");
  };
  const app = createControlServer(store, controller, proxyToken, undefined, undefined, {}, {
    customerProductAuthentication: authentication,
    identityPolicyStore,
    protectedWorkspacePolicy,
    routingStore,
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
    assert.deepEqual(settings.json().availableProfiles.map((profile: { id: string }) => profile.id), [
      "claude-desktop-standard-v1", "disposable-open-v1",
    ]);
    assert.deepEqual(settings.json().availableAgents.map((agent: { id: string }) => agent.id), [
      "claude-desktop", "claude-cli", "hermes-desktop", "hermes-claw",
    ]);
    assert.deepEqual(settings.json().availableApplications.map((application: { id: string }) => application.id), [
      "firefox", "google-chrome", "visual-studio-code", "obsidian",
    ]);
    assert.deepEqual(settings.json().availableServiceClasses.map((entry: { value: string }) => entry.value), ["lite"]);
    assert.equal(settings.json().requestedServiceClass, "lite", "the first published route becomes the safe workspace default when Balanced is unavailable");
    assert.equal(settings.json().manifest.sandbox.egressMode, "restricted");
    assert.equal(settings.json().securityGroup.defaultAction, "deny");
    assert.equal(settings.json().securityGroup.id, managedFallback.id);
    assert.equal(settings.json().securityGroup.documentHash, managedFallback.documentHash);
    assert.equal(settings.json().availableSecurityGroups[0].id, managedFallback.id);
    assert.equal(settings.json().availableSecurityGroups[0].defaultAction, "deny");

    const unqualifiedCodexSelection = await app.inject({
      method: "PUT",
      url: "/v1/sandbox-settings",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        grantId: "personal",
        profileId: settings.json().profileId,
        applicationIds: settings.json().applicationIds,
        modelAlias: settings.json().modelAlias,
        requestedServiceClass: settings.json().requestedServiceClass,
        agentIds: ["codex-cli"],
      },
    });
    assert.equal(unqualifiedCodexSelection.statusCode, 403);
    assert.equal(unqualifiedCodexSelection.json().error.code, "AGENT_NOT_ASSIGNED");

    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "protected-admin-create-0001" },
      payload: { grantId: "personal" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().state, "ready");
    assert.equal(createdPolicies[0]?.egressMode, "restricted");
    assert.equal(createdPolicies[0]?.requestedServiceClass, "lite");
    assert.deepEqual(createdPolicies[0]?.allowedServiceClasses, ["lite"]);
    assert.deepEqual(createdPolicies[0]?.modelLimits, { lite: { contextTokens: 128000, outputTokens: 32768 } });
    assert.equal(createdPolicies[0]?.egress?.defaultAction, "deny");
    assert.equal(createdEgressProxy?.expectedGrant.egressMode, "restricted");
    assert.equal(createdEgressProxy?.expectedGrant.securityGroupVersionId, managedFallback.id);

    const lookupsBeforeCurrent = egressLookups;
    const currentAfterCreate = await app.inject({ method: "GET", url: "/v1/workspaces/current", headers });
    assert.equal(currentAfterCreate.statusCode, 200);
    assert.ok(egressLookups > lookupsBeforeCurrent, "an existing workspace still evaluates its current runtime policy");
    assert.equal(currentAfterCreate.json().profile.egressMode, "restricted");

    const savedRoutes = await app.inject({
      method: "POST",
      url: "/v1/admin/routing/mappings",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        revisionNote: "Add Pro while retaining Lite",
        billingCurrency: "USD",
        deployments: ["lite", "pro"].map((serviceClass, index) => ({
          serviceClass,
          provider: "openai",
          providerAccountId: "primary",
          providerModel: serviceClass === "lite" ? "gpt-5.6-luna" : "gpt-5.6-sol",
          providerDeployment: `openai/${serviceClass}`,
          rateCardId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
          capabilities: { vision: true, tools: true, streaming: true, contextTokens: 128000, outputTokens: 16000, residency: ["sg"] },
          approved: true,
          evaluationPassed: true,
        })),
      },
    });
    assert.equal(savedRoutes.statusCode, 201);
    assert.deepEqual(savedRoutes.json().workspaceActivation, {
      restarted: 1,
      restartFailed: 0,
      appliesOnNextStart: 0,
      actionRequired: 0,
    });
    assert.equal(destroyedWorkspaces, 1);
    assert.equal(createdPolicies.length, 2);
    assert.deepEqual(createdPolicies[1]?.allowedServiceClasses, ["lite", "pro"]);
  } finally {
    await app.close();
  }
});
