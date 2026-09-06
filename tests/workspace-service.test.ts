import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError, type IdentityContext, type Launch, type RuntimePolicy, type Sandbox, type SignedPolicyBundle } from "@lemmacomputer/contracts";
import { MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import type { GatewayClient, GatewayGrant } from "@lemmacomputer/litellm-adapter";
import { EgressProxyGrantAuthority, PolicyBundleAuthority, WORKSPACE_OPERATION_TIMEOUT_MS, WorkspaceService, toView, type ControllerClient, type EgressProxyGrant } from "../apps/control-api/src/service.js";
import { WorkspaceIngressAuthority, workspaceIngressAccessParameter } from "@lemmacomputer/workspace-ingress-auth";
import { policyFixture } from "./policy-fixture.js";

class FakeController implements ControllerClient {
  creates = 0;
  destroys = 0;
  purges = 0;
  lastGateway: GatewayGrant | undefined;
  lastAgentBridge: { baseUrl: string; token: string } | undefined;
  lastPolicy: RuntimePolicy | undefined;
  lastPolicyBundle: SignedPolicyBundle | undefined;
  lastAccessGeneration: number | undefined;
  lastEgressProxy: EgressProxyGrant | undefined;
  lastCreateInput: Parameters<ControllerClient["create"]>[0] | undefined;
  async create(input: Parameters<ControllerClient["create"]>[0]): Promise<Sandbox> {
    this.creates += 1;
    this.lastCreateInput = input;
    this.lastGateway = input.gateway;
    this.lastAgentBridge = input.agentBridge;
    this.lastPolicy = input.policy;
    this.lastPolicyBundle = input.policyBundle;
    this.lastAccessGeneration = input.accessGeneration;
    this.lastEgressProxy = input.egressProxy;
    return { providerId: `sandbox-${input.workspaceId}`, state: "ready", failureCode: null };
  }
  async status(_workspaceId: string, providerId: string): Promise<Sandbox> { return { providerId, state: "ready", failureCode: null }; }
  async open(_workspaceId: string, _providerId: string): Promise<Launch> { return { launchUrl: "https://kasm.example/session", expiresAt: new Date(Date.now() + 60_000).toISOString() }; }
  async destroyWorkspace(_workspaceId: string, _providerId: string) { this.destroys += 1; }
  async purgeWorkspace(workspaceId: string, accessGeneration: number) {
    this.purges += 1;
    return { nodeId: "test-node", workspaceId, maximumPurgedGeneration: accessGeneration, completedAt: new Date().toISOString(), verified: true as const };
  }
}

class FakeGateway implements GatewayClient {
  grants = 0;
  revocations = 0;
  workspaceRevocations = 0;
  revokedGenerations: Array<number | undefined> = [];
  lastPolicy: RuntimePolicy | undefined;
  lastAccessGeneration: number | undefined;
  lastReadinessOptions: { includeTools?: boolean } | undefined;
  async ensureGrant(input: Parameters<GatewayClient["ensureGrant"]>[0]): Promise<GatewayGrant> {
    this.grants += 1;
    this.lastPolicy = input.policy;
    this.lastAccessGeneration = input.accessGeneration;
    return { baseUrl: "http://litellm:4000", credential: `sk-${input.workspaceId}`, modelAlias: "lemmacomputer-assistant", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
  async modelCapabilities() { return { vision: true }; }
  async readiness(
    _workspaceId?: string,
    _agentId?: string,
    _policy?: RuntimePolicy,
    _accessGeneration?: number,
    options?: { includeTools?: boolean },
  ) {
    this.lastReadinessOptions = options;
    return {
      models: "ready" as const,
      tools: options?.includeTools === false ? "unavailable" as const : "ready" as const,
      modelRoute: fakeModelRoute,
    };
  }
  async test() {
    return {
      model: "lemmacomputer-assistant",
      availability: "ready" as const,
      modelRoute: fakeModelRoute,
      tools: [{ name: "search_files", description: "Search files" }],
      apiBaseUrl: "http://litellm:4000/v1",
      mcpUrl: "http://litellm:4000/mcp",
    };
  }
  async revoke() { this.revocations += 1; }
  async revokeWorkspace(_workspaceId?: string, maximumGeneration?: number) {
    this.revocations += 1; this.workspaceRevocations += 1; this.revokedGenerations.push(maximumGeneration);
  }
}

const fakeModelRoute = {
  alias: "lemmacomputer-assistant",
  status: "ready" as const,
  fallback: "none" as const,
  capabilities: { vision: true },
  limits: { requestsPerMinute: 30, tokensPerMinute: 50_000, maxParallelRequests: 4 },
};

const alex: IdentityContext = { tenantId: "acme", subjectId: "alex", audience: "lemmacomputer-control" };
const policy: RuntimePolicy = {
  schemaVersion: 1,
  policyVersionId: "policy-version-1",
  policyVersion: 1,
  policyHash: "a".repeat(64),
  workspaceProfile: "kasm-persistent-standard",
  agentId: "agent-alex",
  agentProfile: "lemmacomputer-default-agent",
  networkProfile: "controlled-egress-v1",
  modelAlias: "lemmacomputer-assistant",
  mcpServer: "lemmacomputer_ms365",
  allowedTools: ["list-mail-folders", "list-calendars", "list-drives"],
  toolPolicies: {},
};

test("concurrent create calls reuse one workspace and one sandbox", async () => {
  const controller = new FakeController();
  const service = new WorkspaceService(new MemoryWorkspaceStore(), controller);
  const [first, second] = await Promise.all([
    service.create(alex, policy, "personal", "same-key-0001", "correlation-1"),
    service.create(alex, policy, "personal", "same-key-0001", "correlation-2"),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(controller.creates, 1);
  assert.equal(first.state, "ready");
});

test("workspace identifiers do not confer cross-tenant access", async () => {
  const controller = new FakeController();
  const service = new WorkspaceService(new MemoryWorkspaceStore(), controller);
  const workspace = await service.create(alex, policy, "personal", "tenant-key-0001", "correlation-1");
  const outsider = { tenantId: "other", subjectId: "alex", audience: "lemmacomputer-control" } as const;
  const denial = async (workspaceId: string) => {
    try {
      await service.open(outsider, policy, workspaceId);
      assert.fail("workspace access should be denied");
    } catch (error) {
      assert.ok(error instanceof LemmaComputerError);
      return { code: error.code, message: error.message, statusCode: error.statusCode, retryable: error.retryable };
    }
  };

  assert.deepEqual(
    await denial(workspace.id),
    await denial("00000000-0000-4000-8000-000000000000"),
    "a foreign workspace must be indistinguishable from a nonexistent workspace",
  );
});

test("workspace identifiers do not confer cross-subject access", async () => {
  const service = new WorkspaceService(new MemoryWorkspaceStore(), new FakeController());
  const workspace = await service.create(alex, policy, "personal", "subject-key-001", "correlation-1");
  await assert.rejects(
    service.open({ tenantId: "acme", subjectId: "mallory", audience: "lemmacomputer-control" }, policy, workspace.id),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "WORKSPACE_NOT_FOUND"),
  );
});

test("local controller targets become signed same-origin workspace launch URLs", async () => {
  const controller = new FakeController();
  controller.open = async () => ({
    launchUrl: "https://127.0.0.1:16920/?clipboard_up=true&clipboard_down=true",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ingressTarget: {
      protocol: "https",
      host: "lemma-ws-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508-relay",
      port: 16_920,
    },
  });
  const authority = new WorkspaceIngressAuthority("workspace-service-ingress-secret-at-least-32-characters");
  const service = new WorkspaceService(
    new MemoryWorkspaceStore(),
    controller,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      publicUrl: "https://lemmacomputer.example.test",
      authority,
    },
  );
  const workspace = await service.create(alex, policy, "personal", "ingress-launch-001", "correlation-ingress");
  const result = await service.open(alex, policy, workspace.id);
  const launch = new URL(result.launch.launchUrl);

  assert.equal(launch.origin, "https://lemmacomputer.example.test");
  assert.equal(launch.pathname, `/workspaces/${workspace.id}/`);
  assert.equal(launch.searchParams.get("clipboard_up"), "true");
  assert.equal(launch.searchParams.get("clipboard_down"), "true");
  assert.equal(launch.searchParams.get("path"), `workspaces/${workspace.id}/websockify`);
  const token = launch.searchParams.get(workspaceIngressAccessParameter);
  assert.ok(token);
  const exchanged = authority.exchangeLaunch(token, workspace.id);
  assert.equal(exchanged?.claims.host, "lemma-ws-b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508-relay");
  assert.equal(exchanged?.claims.port, 16_920);
});

test("sandbox inventory projects each sandbox using its own configuration policy", async () => {
  const service = new WorkspaceService(new MemoryWorkspaceStore(), new FakeController());
  await service.create(alex, policy, "personal", "inventory-personal-1", "correlation-1");
  await service.create(alex, policy, "research", "inventory-research-1", "correlation-2");
  const researchPolicy = { ...policy, workspaceProfile: "claude-desktop-standard-v1" as const, modelAlias: "lemmacomputer-claude" as const };

  const inventory = await service.list(alex, async (grantId) => grantId === "research" ? researchPolicy : policy);

  assert.equal(inventory.length, 2);
  assert.equal(inventory.find((workspace) => workspace.grantId === "research")?.profile?.modelAlias, "lemmacomputer-claude");
  assert.equal(inventory.find((workspace) => workspace.grantId === "personal")?.profile?.modelAlias, "lemmacomputer-assistant");
});

test("workspace inventory retains its creation order while polling multiple running workspaces", async () => {
  const service = new WorkspaceService(new MemoryWorkspaceStore(), new FakeController());
  await service.create(alex, policy, "personal", "stable-order-personal", "correlation-1");
  await service.create(alex, policy, "research", "stable-order-research", "correlation-2");

  const firstPoll = await service.list(alex, async () => policy);
  const secondPoll = await service.list(alex, async () => policy);

  assert.deepEqual(secondPoll.map((workspace) => workspace.id), firstPoll.map((workspace) => workspace.id));
  assert.deepEqual(
    secondPoll.map((workspace) => ({ id: workspace.id, updatedAt: workspace.updatedAt })),
    firstPoll.map((workspace) => ({ id: workspace.id, updatedAt: workspace.updatedAt })),
  );
});

test("workspace inventory quarantines one incompatible workspace without hiding the inventory", async () => {
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(new MemoryWorkspaceStore(), controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "policy-conflict-personal", "correlation-1");

  const inventory = await service.list(alex, async () => {
    throw new LemmaComputerError(
      "WORKSPACE_POLICY_SELECTION_REQUIRED",
      "The saved agent is no longer allowed",
      409,
    );
  });

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0]?.id, workspace.id);
  assert.equal(inventory[0]?.state, "stopped");
  assert.deepEqual(inventory[0]?.policyCompatibility, {
    state: "action_required",
    reasonCode: "WORKSPACE_POLICY_SELECTION_REQUIRED",
  });
  assert.equal(controller.destroys, 1);
  assert.equal(gateway.workspaceRevocations, 1);
});

test("one incompatible workspace does not hide compatible workspace records", async () => {
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(new MemoryWorkspaceStore(), controller, gateway);
  const incompatible = await service.create(alex, policy, "personal", "policy-conflict-mixed-personal", "correlation-1");
  const compatible = await service.create(alex, policy, "research", "policy-conflict-mixed-research", "correlation-2");

  const inventory = await service.list(alex, async (grantId) => {
    if (grantId === "personal") {
      throw new LemmaComputerError(
        "WORKSPACE_POLICY_SELECTION_REQUIRED",
        "The saved agent is no longer allowed",
        409,
      );
    }
    return policy;
  });

  assert.equal(inventory.length, 2);
  assert.equal(inventory.find((workspace) => workspace.id === incompatible.id)?.state, "stopped");
  assert.deepEqual(inventory.find((workspace) => workspace.id === incompatible.id)?.policyCompatibility, {
    state: "action_required",
    reasonCode: "WORKSPACE_POLICY_SELECTION_REQUIRED",
  });
  assert.equal(inventory.find((workspace) => workspace.id === compatible.id)?.state, "ready");
  assert.deepEqual(inventory.find((workspace) => workspace.id === compatible.id)?.policyCompatibility, {
    state: "current",
    reasonCode: null,
  });
  assert.equal(controller.destroys, 1);
  assert.equal(gateway.workspaceRevocations, 1);
});

test("a running workspace with an older projected policy is stopped and revoked before inventory returns", async () => {
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(new MemoryWorkspaceStore(), controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "policy-drift-personal", "correlation-1");
  controller.status = async (_workspaceId, providerId) => ({
    providerId,
    state: "ready",
    failureCode: null,
    policyIntegrity: {
      state: "drift",
      reasonCode: "POLICY_PROJECTION_DRIFT",
      expected: { version: 1, digest: "a".repeat(64) },
      projected: {
        version: 1,
        digest: "a".repeat(64),
        bundleDigest: "c".repeat(64),
        keyId: "psk_test_policy",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      enforced: null,
    },
  });
  const updatedPolicy = {
    ...policy,
    policyVersionId: "policy-version-2",
    policyVersion: 2,
    policyHash: "b".repeat(64),
  };

  const current = await service.current(alex, updatedPolicy);

  assert.equal(current?.id, workspace.id);
  assert.equal(current?.state, "stopped");
  assert.deepEqual(current?.policyCompatibility, {
    state: "restart_required",
    reasonCode: "WORKSPACE_POLICY_VERSION_CHANGED",
  });
  assert.equal(controller.destroys, 1);
  assert.equal(gateway.workspaceRevocations, 1);
});

test("workspace lifetime remains UI-managed while its gateway grant can renew", async () => {
  const controller = new FakeController();
  const store = new MemoryWorkspaceStore();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(store, controller, gateway);
  const created = await service.create(alex, policy, "personal", "persistent-create-1", "correlation-1");
  const current = await service.current(alex, policy);
  assert.equal(current?.id, created.id);
  assert.equal(current?.state, "ready");
  assert.equal(controller.creates, 1);
  assert.equal(gateway.grants, 2);
});

test("a base workspace creates, opens, and restarts without gateway or agent authority", async () => {
  const controller = new FakeController();
  const gateway = new FakeGateway();
  let bridgeIssues = 0;
  const basePolicy: RuntimePolicy = {
    ...policy,
    agents: [],
    applications: [],
    modelAlias: null,
  };
  const service = new WorkspaceService(
    new MemoryWorkspaceStore(),
    controller,
    gateway,
    {
      baseUrl: "http://lemmacomputer-control:4100",
      issue: () => {
        bridgeIssues += 1;
        return "base-workspace-must-not-receive-this-token";
      },
    },
  );

  const created = await service.create(alex, basePolicy, "base", "base-create-0001", "correlation-base-create");
  assert.equal(created.state, "ready");
  assert.deepEqual(created.applications, []);
  assert.deepEqual(created.agents, []);
  assert.equal(created.profile?.modelAlias, null);
  assert.equal(created.modelRoute, undefined);
  assert.equal(gateway.grants, 0);
  assert.equal(bridgeIssues, 0);
  assert.equal(controller.lastCreateInput?.gateway, undefined);
  assert.equal(controller.lastCreateInput?.agentBridge, undefined);
  assert.equal(controller.lastCreateInput?.agentGrants, undefined);
  assert.equal(controller.lastCreateInput?.chatRuntimes, undefined);

  await service.open(alex, basePolicy, created.id);
  await service.restart(alex, basePolicy, created.id, "correlation-base-restart");
  assert.equal(gateway.grants, 0);
  assert.equal(bridgeIssues, 0);
  assert.equal(controller.creates, 2);
  await assert.rejects(
    service.testGateway(alex, basePolicy, created.id),
    (error: unknown) => error instanceof LemmaComputerError && error.code === "WORKSPACE_AI_NOT_SELECTED",
  );
});

test("an active workspace grant can adopt a new policy without recreating the sandbox", async () => {
  const controller = new FakeController();
  const store = new MemoryWorkspaceStore();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(store, controller, gateway);
  const created = await service.create(alex, policy, "personal", "policy-refresh-create", "correlation-1");
  const updatedPolicy = {
    ...policy,
    policyVersionId: "policy-version-2",
    policyVersion: 2,
    policyHash: "b".repeat(64),
    toolPolicies: { ...policy.toolPolicies, "create-calendar-event": "allow" as const },
  };

  const refreshed = await service.refreshPolicyGrant(alex, updatedPolicy);

  assert.equal(refreshed, true);
  assert.equal(gateway.grants, 2);
  assert.equal(gateway.lastPolicy?.policyVersionId, "policy-version-2");
  assert.equal(gateway.lastPolicy?.toolPolicies["create-calendar-event"], "allow");
  assert.equal(controller.creates, 1);
  assert.equal(created.state, "ready");
});

for (const terminalState of ["ready", "stopped", "failed"] as const) {
  for (const completeRestart of [false, true]) {
    test(`delayed ${terminalState} observation cannot overwrite a ${completeRestart ? "completed" : "pending"} restart`, async () => {
      const store = new MemoryWorkspaceStore();
      const controller = new FakeController();
      const gateway = new FakeGateway();
      const service = new WorkspaceService(store, controller, gateway);
      const workspace = await service.create(alex, policy, "personal", "delayed-status", "create");
      const statusStarted = Promise.withResolvers<void>();
      const statusResult = Promise.withResolvers<Sandbox>();
      controller.status = async () => {
        statusStarted.resolve();
        return statusResult.promise;
      };
      const poll = service.current(alex, policy);
      await statusStarted.promise;
      const replacementStarted = Promise.withResolvers<void>();
      const replacementReady = Promise.withResolvers<void>();
      const create = controller.create.bind(controller);
      controller.create = async (input) => {
        replacementStarted.resolve();
        await replacementReady.promise;
        return create(input);
      };
      const restart = service.restart(alex, policy, workspace.id, "restart");
      await replacementStarted.promise;
      if (completeRestart) {
        replacementReady.resolve();
        await restart;
      }
      const before = await store.getOwned(alex, workspace.id);
      const grants = gateway.grants;
      const revocations = gateway.workspaceRevocations;
      try {
        statusResult.resolve({
          providerId: `sandbox-${workspace.id}`,
          state: terminalState,
          failureCode: terminalState === "failed" ? "WORKSPACE_STARTUP_TIMEOUT" : null,
          // Even an unchanged Ready response carries stale policy evidence.
          policyIntegrity: {
            state: "drift", reasonCode: "POLICY_PROJECTION_DRIFT", expected: null, enforced: null,
            projected: { version: 0, digest: "0".repeat(64), bundleDigest: "0".repeat(64),
              keyId: "old-key", expiresAt: new Date(Date.now() + 60_000).toISOString() },
          },
        });
        const view = await poll;
        assert.equal(view?.state, completeRestart ? "ready" : "restarting");
        assert.deepEqual(await store.getOwned(alex, workspace.id), before);
        assert.equal(gateway.grants, grants, "stale observations cannot renew grants");
        assert.equal(gateway.workspaceRevocations, revocations, "stale policy cannot revoke the new generation");
        assert.equal(controller.destroys, 1);
      } finally {
        replacementReady.resolve();
        await restart;
      }
    });
  }
}

test("current does not poll a provider while its lifecycle operation owns readiness", async () => {
  const store = new MemoryWorkspaceStore();
  const controller = new FakeController();
  const service = new WorkspaceService(store, controller);
  const workspace = await service.create(alex, policy, "personal", "active-status", "create");
  const claimed = await store.claim(workspace.id, ["ready"], "restarting");
  controller.status = async () => { throw new Error("must not poll during restart"); };
  assert.equal((await service.current(alex, policy))?.state, "restarting");
  assert.deepEqual(await store.getOwned(alex, workspace.id), claimed);
});

test("a restart between status reconciliation and policy cleanup cannot revoke the replacement", async () => {
  const store = new MemoryWorkspaceStore();
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(store, controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "policy-cleanup-race", "create");
  controller.status = async (_id, providerId) => ({
    providerId, state: "ready", failureCode: null,
    policyIntegrity: {
      state: "drift", reasonCode: "POLICY_PROJECTION_DRIFT", expected: null, enforced: null,
      projected: { version: 0, digest: "0".repeat(64), bundleDigest: "0".repeat(64),
        keyId: "old-key", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    },
  });
  const reconcile = store.reconcile.bind(store);
  store.reconcile = async (observed, patch) => {
    const result = await reconcile(observed, patch);
    await service.restart(alex, policy, workspace.id, "restart-before-cleanup");
    return result;
  };
  assert.equal((await service.current(alex, policy))?.state, "ready");
  assert.equal((await store.getOwned(alex, workspace.id))?.state, "ready");
  assert.equal(controller.destroys, 1);
  assert.equal(gateway.workspaceRevocations, 0, "stale policy cleanup cannot revoke the replacement");
  assert.equal((await store.getOwned(alex, workspace.id))?.accessGeneration, 2);
});

test("restart destroys the prior sandbox and retains product identity", async () => {
  const controller = new FakeController();
  const service = new WorkspaceService(new MemoryWorkspaceStore(), controller);
  const workspace = await service.create(alex, policy, "personal", "restart-key-01", "correlation-1");
  const restarted = await service.restart(alex, policy, workspace.id, "correlation-2");
  assert.equal(restarted.id, workspace.id);
  assert.equal(restarted.state, "ready");
  assert.equal(controller.creates, 2);
  assert.equal(controller.destroys, 1);
});

test("workspace restart rotates the persisted bridge generation before projecting a replacement grant", async () => {
  const controller = new FakeController();
  const store = new MemoryWorkspaceStore();
  const issuedGenerations: number[] = [];
  const gateway = new FakeGateway();
  const egressPolicy: RuntimePolicy = {
    ...policy,
    egressMode: "restricted",
    egress: {
      id: "egv_acme_restart_v1",
      securityGroupId: "esg_acme_restart",
      version: 1,
      name: "Restart access",
      description: "Restart generation regression fixture",
      defaultAction: "deny",
      documentHash: "e".repeat(64),
      rules: [],
    },
  };
  const service = new WorkspaceService(
    store,
    controller,
    gateway,
    {
      baseUrl: "http://lemmacomputer-control:4100",
      issue: (_identity, workspace) => {
        issuedGenerations.push(workspace.accessGeneration);
        return `v2-bridge-generation-${workspace.accessGeneration}`;
      },
    },
    new EgressProxyGrantAuthority("restart-egress-root-secret-at-least-32-characters"),
  );

  const workspace = await service.create(alex, egressPolicy, "personal", "bridge-generation-create", "correlation-1");
  assert.deepEqual(issuedGenerations, [1]);
  assert.equal(controller.lastAgentBridge?.token, "v2-bridge-generation-1");
  assert.equal(controller.lastAccessGeneration, 1);
  assert.equal(controller.lastEgressProxy?.expectedGrant.accessGeneration, 1);
  assert.equal(gateway.lastAccessGeneration, 1);

  await service.restart(alex, egressPolicy, workspace.id, "correlation-2");
  assert.deepEqual(issuedGenerations, [1, 2]);
  assert.equal(controller.lastAgentBridge?.token, "v2-bridge-generation-2");
  assert.equal(controller.lastAccessGeneration, 2);
  assert.equal(controller.lastEgressProxy?.expectedGrant.accessGeneration, 2);
  assert.equal(gateway.lastAccessGeneration, 2);

  await service.stop(alex, egressPolicy, workspace.id);
  assert.equal((await store.getOwned(alex, workspace.id))?.accessGeneration, 3);
});

test("stop removes provider authority while retaining an owned stopped record", async () => {
  const controller = new FakeController();
  const store = new MemoryWorkspaceStore();
  const service = new WorkspaceService(store, controller);
  const workspace = await service.create(alex, policy, "personal", "stop-key-00001", "correlation-1");
  const stopped = await service.stop(alex, policy, workspace.id);
  assert.equal(stopped.state, "stopped");
  assert.equal((await store.getOwned(alex, workspace.id))?.providerId, null);
  assert.equal(controller.destroys, 1);
  assert.equal(controller.purges, 0);
});

test("delete tombstones the workspace, preserves content by default, and recreates the same logical workspace", async () => {
  const controller = new FakeController();
  const store = new MemoryWorkspaceStore();
  const service = new WorkspaceService(store, controller);
  const workspace = await service.create(alex, policy, "personal", "delete-key-0001", "correlation-1");
  assert.deepEqual(await service.deletionImpact(alex, workspace.id), {
    conversations: 0,
    artifacts: 0,
    protectedConversations: 0,
    protectedArtifacts: 0,
  });
  await service.delete(alex, policy, workspace.id);
  assert.equal(controller.destroys, 1);
  assert.equal(controller.purges, 1);
  assert.equal(await store.getOwned(alex, workspace.id), null);

  const recreated = await service.create(alex, policy, "personal", "delete-key-0002", "correlation-2");
  assert.equal(recreated.id, workspace.id);
  assert.equal(recreated.state, "ready");
  assert.equal(controller.creates, 2);
});

test("workspace lifecycle provisions, reports, tests, and revokes a scoped gateway grant", async () => {
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(new MemoryWorkspaceStore(), controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "gateway-key-0001", "correlation-002");
  assert.equal(workspace.readiness.models, "ready");
  assert.equal(workspace.readiness.tools, "unavailable");
  assert.deepEqual(gateway.lastReadinessOptions, { includeTools: false });
  assert.equal(workspace.modelRoute?.limits.requestsPerMinute, 30);
  assert.equal(controller.lastGateway?.modelAlias, "lemmacomputer-assistant");
  assert.equal(gateway.grants, 1);
  assert.equal(controller.lastPolicy?.policyHash, policy.policyHash);
  assert.deepEqual(gateway.lastPolicy?.allowedTools, policy.allowedTools);
  assert.deepEqual((await service.testGateway(alex, policy, workspace.id)).tools.map((tool) => tool.name), ["search_files"]);
  await service.stop(alex, policy, workspace.id);
  assert.equal(gateway.revocations, 1);
});

test("connector failure stays capability-scoped for every selected agent", () => {
  const agentPolicies = [
    ["claude-desktop", "claude-desktop-managed-v1"],
    ["claude-cli", "claude-cli-managed-v1"],
    ["codex-cli", "codex-cli-managed-v1"],
    ["hermes-desktop", "hermes-desktop-managed-v1"],
    ["hermes-claw", "hermes-claw-managed-v1"],
  ].map(([catalogId, agentProfile]) => ({
    catalogId,
    agentId: `${catalogId}-agent`,
    agentProfile,
    displayName: catalogId,
    clientVersion: "test",
    modelAlias: "lemmacomputer-assistant",
    mcpServer: "lemmacomputer_optional",
    allowedTools: ["optional_tool"],
    toolPolicies: {},
  })) as NonNullable<RuntimePolicy["agents"]>;
  const view = toView({
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: alex.tenantId,
    subjectId: alex.subjectId,
    grantId: "personal",
    state: "ready",
    providerId: "sandbox-ready",
    failureCode: null,
    operationToken: null,
    accessGeneration: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }, {
    models: "ready",
    tools: "failed",
    modelRoute: fakeModelRoute,
  }, { ...policy, agents: agentPolicies });

  assert.equal(view.state, "ready");
  assert.equal(view.readiness.models, "ready");
  assert.equal(view.readiness.tools, "failed");
  assert.deepEqual(view.agents?.map((agent) => [agent.id, agent.state]), [
    ["claude-desktop", "ready"],
    ["claude-cli", "ready"],
    ["codex-cli", "ready"],
    ["hermes-desktop", "ready"],
    ["hermes-claw", "ready"],
  ]);
});

test("Control signs and self-verifies policy before issuing grants or calling the controller", async () => {
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const signed = policyFixture(policy, "b4a2ea8c-cc94-46e3-b6c8-59ae4ebee508");
  const authority = new PolicyBundleAuthority(
    signed.signer,
    signed.keys,
    { modelGateway: "http://litellm:4000", mcpControl: "http://lemmacomputer-control:4100" },
  );
  const service = new WorkspaceService(
    new MemoryWorkspaceStore(),
    controller,
    gateway,
    { baseUrl: "http://lemmacomputer-control:4100", issue: () => "agent-bridge-token-at-least-24-characters" },
    undefined,
    authority,
  );
  const workspace = await service.create(alex, policy, "personal", "signed-policy-create", "correlation-signed");
  assert.equal(workspace.state, "ready");
  assert.equal(controller.lastPolicyBundle?.keyId, "psk_test_policy");
  assert.equal(controller.lastPolicy?.policyHash, policy.policyHash);
  assert.equal(gateway.lastPolicy?.policyHash, policy.policyHash);
  assert.equal(workspace.policyIntegrity?.state, "unavailable");
  assert.equal(workspace.policyIntegrity?.enforced?.keyId, "psk_test_policy");
});


class FlakyRevokeGateway extends FakeGateway {
  override async revokeWorkspace() { await this.revoke(); }
  constructor(public remainingFailures: number) { super(); }
  override async revoke() {
    this.revocations += 1;
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new LemmaComputerError("GATEWAY_UNAVAILABLE", "Gateway is temporarily unavailable", 503, true);
    }
  }
}

test("stop retries transient grant revocation before completing", async () => {
  const controller = new FakeController();
  const store = new MemoryWorkspaceStore();
  const gateway = new FlakyRevokeGateway(2);
  const service = new WorkspaceService(store, controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "stop-retry-0001", "correlation-stop-retry");
  const stopped = await service.stop(alex, policy, workspace.id);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.failureCode, null);
  assert.equal(gateway.revocations, 3);
  assert.equal(controller.destroys, 1);
});

test("stop records the destroyed runtime and resumes pending access cleanup", async () => {
  const controller = new FakeController();
  const store = new MemoryWorkspaceStore();
  const gateway = new FlakyRevokeGateway(3);
  const service = new WorkspaceService(store, controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "stop-cleanup-001", "correlation-stop-cleanup");
  await assert.rejects(
    service.stop(alex, policy, workspace.id),
    (error: unknown) => (error as { code?: string }).code === "WORKSPACE_ACCESS_CLEANUP_FAILED",
  );
  const pending = await store.getOwned(alex, workspace.id);
  assert.equal(pending?.state, "stopped");
  assert.equal(pending?.providerId, null);
  assert.equal(pending?.failureCode, "WORKSPACE_ACCESS_CLEANUP_FAILED");
  assert.equal(controller.destroys, 1);

  gateway.remainingFailures = 0;
  const recovered = await service.stop(alex, policy, workspace.id);
  assert.equal(recovered.state, "stopped");
  assert.equal(recovered.failureCode, null);
  assert.equal(controller.destroys, 1);
});


test("abandoned restart expires safely and late failure cannot revoke its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = new MemoryWorkspaceStore();
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(store, controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "abandoned-restart", "create");
  let rejectOld!: (error: Error) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const create = controller.create.bind(controller);
  controller.create = async () => { started(); return new Promise((_resolve, reject) => { rejectOld = reject; }); };
  const oldRestart = service.restart(alex, policy, workspace.id, "abandoned");
  const oldRejected = assert.rejects(oldRestart);
  await entered;
  const active = await store.getOwned(alex, workspace.id);
  assert.ok(active);
  assert.equal((await service.current(alex, policy, "personal"))?.state, "restarting");
  t.mock.timers.tick(WORKSPACE_OPERATION_TIMEOUT_MS + 1);
  const expired = await service.current(alex, policy, "personal");
  assert.equal(expired?.state, "failed");
  assert.equal(expired?.failureCode, "WORKSPACE_OPERATION_INTERRUPTED");
  const recoveredRecord = await store.getOwned(alex, workspace.id);
  assert.equal(recoveredRecord?.operationToken, null);
  assert.equal(recoveredRecord?.providerId, active.providerId);
  assert.equal(recoveredRecord?.accessGeneration, active.accessGeneration + 1);
  assert.deepEqual(gateway.revokedGenerations, [active.accessGeneration]);
  controller.create = create;
  assert.equal((await service.restart(alex, policy, workspace.id, "retry")).state, "ready");
  const replacement = await store.getOwned(alex, workspace.id);
  const revocations = gateway.revocations;
  rejectOld(new Error("old transport failed"));
  await oldRejected;
  assert.deepEqual(await store.getOwned(alex, workspace.id), replacement);
  assert.equal(gateway.revocations, revocations);
});


test("late stop cleanup is limited to the abandoned generation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = new MemoryWorkspaceStore();
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(store, controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "abandoned-stop", "create");
  const original = await store.getOwned(alex, workspace.id);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  controller.destroyWorkspace = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); };
  const stopRejected = assert.rejects(service.stop(alex, policy, workspace.id));
  await started;
  t.mock.timers.tick(WORKSPACE_OPERATION_TIMEOUT_MS + 1);
  await service.current(alex, policy, "personal");
  controller.destroyWorkspace = async () => {};
  await service.restart(alex, policy, workspace.id, "retry");
  const replacement = await store.getOwned(alex, workspace.id);
  release();
  await stopRejected;
  assert.deepEqual(await store.getOwned(alex, workspace.id), replacement);
  assert.equal(gateway.revokedGenerations.at(-1), original?.accessGeneration);
  assert.ok(gateway.revokedGenerations.every((generation) => generation !== undefined && generation < replacement!.accessGeneration));
});

test("host recovery replaces an unhealthy runtime with freshly issued grants and preserves workspace identity", async () => {
  const store = new MemoryWorkspaceStore();
  const controller = new FakeController();
  let grants = 0;
  const service = new WorkspaceService(store, controller, undefined, {
    baseUrl: "http://control", issue: () => `fresh-grant-${++grants}`,
  });
  const created = await service.create(alex, policy, "personal", "recovery-create", "recovery");
  const original = (await store.getOwned(alex, created.id))!;
  const originalToken = controller.lastAgentBridge?.token;
  controller.status = async (_id, providerId) => ({ providerId, state: "failed", failureCode: "WORKSPACE_HEALTHCHECK_FAILED" });
  await service.recover(original, alex, policy);
  const recovered = (await store.getOwned(alex, created.id))!;
  assert.equal(recovered.id, original.id);
  assert.equal(recovered.desiredState, "running");
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.accessGeneration, original.accessGeneration + 1);
  assert.equal(recovered.operationToken, null);
  assert.equal(controller.destroys, 1);
  assert.equal(controller.purges, 0, "recovery must preserve persistent home");
  assert.notEqual(controller.lastAgentBridge?.token, originalToken);
});

test("a stopped provider retains running intent and recovers without a logged-in caller", async () => {
  const store = new MemoryWorkspaceStore();
  const controller = new FakeController();
  const service = new WorkspaceService(store, controller);
  const created = await service.create(alex, policy, "personal", "recovery-missing", "recovery");
  controller.status = async (_id, providerId) => ({ providerId, state: "stopped", failureCode: null });
  await service.current(alex, policy);
  const stopped = (await store.getOwned(alex, created.id))!;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.desiredState, "running", "a status observation cannot change user intent");
  await service.recover(stopped, alex, policy);
  assert.equal((await store.getOwned(alex, created.id))?.state, "ready");
  assert.equal(controller.creates, 2);
});

test("a delayed recovery health check cannot undo Stop or race another recovery", async () => {
  const store = new MemoryWorkspaceStore();
  const controller = new FakeController();
  const service = new WorkspaceService(store, controller);
  const created = await service.create(alex, policy, "personal", "recovery-stop-race", "recovery");
  const original = (await store.getOwned(alex, created.id))!;
  let observed!: () => void;
  const entered = new Promise<void>((resolve) => { observed = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  controller.status = async (_id, providerId) => {
    observed(); await blocked;
    return { providerId, state: "failed", failureCode: "WORKSPACE_HEALTHCHECK_FAILED" };
  };
  const recovering = service.recover(original, alex, policy);
  await entered;
  await service.stop(alex, policy, created.id);
  release();
  await assert.rejects(recovering, (error: unknown) => error instanceof LemmaComputerError && error.code === "WORKSPACE_BUSY");
  const stopped = (await store.getOwned(alex, created.id))!;
  await service.recover(stopped, alex, policy);
  assert.equal(controller.creates, 1);
  assert.equal(stopped.desiredState, "stopped");
  assert.deepEqual(await store.listRecoveryCandidates(), []);

  await service.create(alex, policy, "personal", "recovery-restart", "recovery");
  const running = (await store.getOwned(alex, created.id))!;
  const rounds = await Promise.allSettled([service.recover(running, alex, policy), service.recover(running, alex, policy)]);
  assert.equal(rounds.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(controller.creates, 3, "only one replacement may be created");
});

test("recovery waits for dependencies and bounds retries after a failed restart", async () => {
  const store = new MemoryWorkspaceStore();
  const controller = new FakeController();
  const service = new WorkspaceService(store, controller);
  const created = await service.create(alex, policy, "personal", "recovery-outage", "recovery");
  const original = (await store.getOwned(alex, created.id))!;
  controller.status = async () => { throw new Error("node unavailable"); };
  await assert.rejects(service.recover(original, alex, policy));
  assert.equal(controller.destroys, 0, "an unreachable node must not trigger destructive recovery");
  controller.status = async (_id, providerId) => ({ providerId, state: "failed", failureCode: "WORKSPACE_HEALTHCHECK_FAILED" });
  controller.create = async () => { controller.creates++; throw new Error("dependency unavailable"); };
  await assert.rejects(service.recover(original, alex, policy));
  const failed = (await store.getOwned(alex, created.id))!;
  await service.recover(failed, alex, policy);
  assert.equal(controller.creates, 2, "do not immediately retry a failed replacement");
  const clock = Date.now;
  Date.now = () => failed.updatedAt.getTime() + 60_001;
  try { await assert.rejects(service.recover(failed, alex, policy)); }
  finally { Date.now = clock; }
  assert.equal(controller.creates, 3);
});
