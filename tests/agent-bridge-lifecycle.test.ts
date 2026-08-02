import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext, Launch, RuntimePolicy, Sandbox } from "@onecomputer/contracts";
import { MemoryWorkspaceStore } from "@onecomputer/workspace-store";
import {
  AgentBridgeAuthority,
  agentBridgeAudience,
} from "../apps/control-api/src/agent-bridge.js";
import { createControlServer } from "../apps/control-api/src/server.js";
import { WorkspaceService, type ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "agent-bridge-proxy-token-at-least-24-characters";
const mcpPolicyToken = "agent-bridge-policy-token-at-least-24-characters";
const bridgeSecret = "agent-bridge-dedicated-secret-at-least-32-characters";
const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "alex",
  audience: "onecomputer-control",
};
const policy: RuntimePolicy = {
  schemaVersion: 1,
  policyVersionId: "agent-bridge-policy-v1",
  policyVersion: 1,
  policyHash: "a".repeat(64),
  workspaceProfile: "kasm-persistent-standard",
  agentProfile: "onecomputer-default-agent",
  agentId: "agent-alex",
  networkProfile: "controlled-egress-v1",
  modelAlias: "onecomputer-assistant",
  mcpServer: "onecomputer_fixture",
  allowedTools: ["search_files"],
  toolPolicies: { search_files: "allow" },
};

class Controller implements ControllerClient {
  async create(input: Parameters<ControllerClient["create"]>[0]): Promise<Sandbox> {
    return { providerId: `sandbox-${input.workspaceId}`, state: "ready", failureCode: null };
  }
  async status(providerId: string): Promise<Sandbox> { return { providerId, state: "ready", failureCode: null }; }
  async open(): Promise<Launch> { return { launchUrl: "https://kasm.example.test", expiresAt: new Date(Date.now() + 60_000).toISOString() }; }
  async destroy() {}
  async purgeWorkspace() {}
}

const protectedOperation = (token: string) => ({
  method: "GET" as const,
  url: `/internal/v1/agent/operations/${randomUUID()}`,
  headers: { authorization: `Bearer ${token}` },
});

test("bridge grants fail closed for foreign signing secrets, lifecycle revocation, stopped workspaces, and deletion", async () => {
  const store = new MemoryWorkspaceStore();
  const service = new WorkspaceService(store, new Controller());
  const workspace = await service.create(identity, policy, "personal", "agent-bridge-lifecycle", "correlation-1");
  const initialRecord = await store.getOwned(identity, workspace.id);
  assert.ok(initialRecord);
  const authority = new AgentBridgeAuthority(bridgeSecret);
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    mcpPolicyToken,
    agentBridgeSecret: bridgeSecret,
  });
  const grantFor = (generation: number) => authority.issue(identity, workspace.id, policy, { workspaceGeneration: generation });

  try {
    const signedWithProxyToken = new AgentBridgeAuthority(proxyToken).issue(identity, workspace.id, policy, {
      workspaceGeneration: initialRecord.bridgeGrantGeneration,
    });
    assert.equal((await app.inject(protectedOperation(signedWithProxyToken))).statusCode, 401);

    const initial = grantFor(initialRecord.bridgeGrantGeneration);
    assert.equal((await app.inject(protectedOperation(initial))).statusCode, 404, "a valid grant reaches the protected route");

    const renewed = await app.inject({
      method: "POST",
      url: "/internal/v1/agent/grants/renew",
      headers: { authorization: `Bearer ${initial}` },
    });
    assert.equal(renewed.statusCode, 200);
    const renewedGrant = authority.verify(renewed.json().token, {
      audience: agentBridgeAudience,
      scope: "agent:operations:read",
    });
    assert.notEqual(renewedGrant.jti, authority.verify(initial).jti);
    assert.equal((await app.inject(protectedOperation(renewed.json().token))).statusCode, 404);

    const restarted = await service.restart(identity, policy, workspace.id, "correlation-2");
    assert.equal(restarted.state, "ready");
    assert.equal((await app.inject(protectedOperation(renewed.json().token))).statusCode, 403);

    const restartedRecord = await store.getOwned(identity, workspace.id);
    assert.ok(restartedRecord);
    const afterRestart = grantFor(restartedRecord.bridgeGrantGeneration);
    assert.equal((await app.inject(protectedOperation(afterRestart))).statusCode, 404);

    await service.stop(identity, policy, workspace.id);
    assert.equal((await app.inject(protectedOperation(afterRestart))).statusCode, 403);

    const restartedAgain = await service.create(identity, policy, "personal", "agent-bridge-start-again", "correlation-3");
    const current = await store.getOwned(identity, workspace.id);
    assert.ok(current);
    const afterStart = grantFor(current.bridgeGrantGeneration);
    assert.equal(restartedAgain.state, "ready");
    assert.equal((await app.inject(protectedOperation(afterStart))).statusCode, 404);

    await service.revokePolicyGrant(workspace.id, policy);
    assert.equal((await app.inject(protectedOperation(afterStart))).statusCode, 403, "policy revocation fences the active workspace grant");

    await service.delete(identity, policy, workspace.id);
    assert.equal((await app.inject(protectedOperation(afterStart))).statusCode, 403, "deleted workspaces cannot retain a bridge capability");
  } finally {
    await app.close();
  }
});

test("agent bridge server rejects endpoint scopes and refuses shared signing secrets", async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createOrGet(identity, "personal", "agent-bridge-scope");
  await store.update(workspace.id, { state: "ready" });
  const authority = new AgentBridgeAuthority(bridgeSecret);
  const app = createControlServer(store, {} as ControllerClient, proxyToken, undefined, undefined, {}, {
    testIdentityMode: true,
    mcpPolicyToken,
    agentBridgeSecret: bridgeSecret,
  });
  try {
    const renewalOnly = authority.issue(identity, workspace.id, policy, {
      workspaceGeneration: workspace.bridgeGrantGeneration,
      scopes: ["agent:renew"],
    });
    const denied = await app.inject(protectedOperation(renewalOnly));
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, "AGENT_BRIDGE_GRANT_SCOPE_DENIED");
  } finally {
    await app.close();
  }

  assert.throws(
    () => createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, {}, {
      testIdentityMode: true,
      agentBridgeSecret: proxyToken,
    }),
    /must differ from the web proxy token/,
  );
  assert.throws(
    () => createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, {}, {
      testIdentityMode: true,
      mcpPolicyToken,
      agentBridgeSecret: mcpPolicyToken,
    }),
    /must differ from the MCP policy token/,
  );
  assert.throws(
    () => createControlServer(new MemoryWorkspaceStore(), {} as ControllerClient, proxyToken, undefined, undefined, {}, {
      authentication: {
        begin: async () => ({ location: "https://example.test/login", cookie: "state=opaque" }),
        complete: async () => { throw new Error("not used"); },
        authenticate: async () => null,
        logout: async () => "",
      },
    }),
    /AGENT_BRIDGE_SECRET is required/,
  );
});
