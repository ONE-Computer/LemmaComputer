import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError, type IdentityContext, type Launch, type RuntimePolicy, type Sandbox, type SignedPolicyBundle } from "@lemmacomputer/contracts";
import { MemoryWorkspaceStore } from "@lemmacomputer/workspace-store";
import type { GatewayClient, GatewayGrant } from "@lemmacomputer/litellm-adapter";
import { EgressProxyGrantAuthority, PolicyBundleAuthority, WorkspaceService, type ControllerClient, type EgressProxyGrant } from "../apps/control-api/src/service.js";
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
  async create(input: Parameters<ControllerClient["create"]>[0]): Promise<Sandbox> {
    this.creates += 1;
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
  lastPolicy: RuntimePolicy | undefined;
  lastAccessGeneration: number | undefined;
  async ensureGrant(input: Parameters<GatewayClient["ensureGrant"]>[0]): Promise<GatewayGrant> {
    this.grants += 1;
    this.lastPolicy = input.policy;
    this.lastAccessGeneration = input.accessGeneration;
    return { baseUrl: "http://litellm:4000", credential: `sk-${input.workspaceId}`, modelAlias: "lemmacomputer-assistant", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }
  async modelCapabilities() { return { vision: true }; }
  async readiness() { return { models: "ready" as const, tools: "ready" as const, modelRoute: fakeModelRoute }; }
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
  async revokeWorkspace() { this.revocations += 1; }
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

test("delete purges persistent storage after removing the runtime", async () => {
  const controller = new FakeController();
  const store = new MemoryWorkspaceStore();
  const service = new WorkspaceService(store, controller);
  const workspace = await service.create(alex, policy, "personal", "delete-key-0001", "correlation-1");
  await service.delete(alex, policy, workspace.id);
  assert.equal(controller.destroys, 1);
  assert.equal(controller.purges, 1);
  assert.equal(await store.getOwned(alex, workspace.id), null);
});

test("workspace lifecycle provisions, reports, tests, and revokes a scoped gateway grant", async () => {
  const controller = new FakeController();
  const gateway = new FakeGateway();
  const service = new WorkspaceService(new MemoryWorkspaceStore(), controller, gateway);
  const workspace = await service.create(alex, policy, "personal", "gateway-key-0001", "correlation-002");
  assert.equal(workspace.readiness.models, "ready");
  assert.equal(workspace.readiness.tools, "ready");
  assert.equal(workspace.modelRoute?.limits.requestsPerMinute, 30);
  assert.equal(controller.lastGateway?.modelAlias, "lemmacomputer-assistant");
  assert.equal(gateway.grants, 1);
  assert.equal(controller.lastPolicy?.policyHash, policy.policyHash);
  assert.deepEqual(gateway.lastPolicy?.allowedTools, policy.allowedTools);
  assert.deepEqual((await service.testGateway(alex, policy, workspace.id)).tools.map((tool) => tool.name), ["search_files"]);
  await service.stop(alex, policy, workspace.id);
  assert.equal(gateway.revocations, 1);
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
