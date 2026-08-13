import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { IdentityContext, RuntimePolicy } from "@lemmacomputer/contracts";
import {
  AgentBridgeAuthority,
  agentBridgeAudience,
} from "../apps/control-api/src/agent-bridge.js";

const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "example-user",
  audience: "lemmacomputer-control",
};

const runtimePolicy: RuntimePolicy = {
  schemaVersion: 1,
  policyVersionId: randomUUID(),
  policyHash: "a".repeat(64),
  workspaceProfile: "claude-desktop-v1",
  agentProfile: "lemmacomputer-default-agent",
  agentId: randomUUID(),
  modelAliases: ["lemmacomputer-assistant"],
  networkProfile: "controlled-egress-v1",
  mcpServer: "lemmacomputer_ms365",
  allowedTools: ["list-drives"],
  toolPolicies: { "list-drives": "allow" },
  capabilities: ["m365-read"],
  protectedOperations: {},
};

test("agent bridge grants are scoped and reject mutation", () => {
  const authority = new AgentBridgeAuthority("agent-bridge-test-secret-at-least-32-characters");
  const workspaceId = randomUUID();
  const token = authority.issue(identity, workspaceId, runtimePolicy, { workspaceGeneration: 1 });

  const grant = authority.verify(token);
  assert.equal(grant.version, 2);
  assert.equal(grant.tenantId, identity.tenantId);
  assert.equal(grant.subjectId, identity.subjectId);
  assert.equal(grant.workspaceId, workspaceId);
  assert.equal(grant.agentId, runtimePolicy.agentId);
  assert.equal(grant.policyHash, runtimePolicy.policyHash);
  assert.equal(grant.workspaceGeneration, 1);
  assert.equal(grant.audience, agentBridgeAudience);
  assert.deepEqual(grant.scopes, [
    "agent:usage-bindings",
    "agent:mcp-discovery",
    "agent:sites",
    "agent:operations:read",
    "agent:uploads",
    "agent:deletions",
    "agent:renew",
    "agent:instances",
    "agent:tool-audit",
  ]);
  assert.match(grant.jti, /^[0-9a-f-]{36}$/);
  assert.ok(grant.expiresAt > grant.issuedAt);

  const mutated = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => authority.verify(mutated), /authentication is invalid/);
  assert.throws(() => authority.verify("not-a-grant"), /authentication is required/);
});

test("v2 agent bridge grants enforce expiry, intended audience, and endpoint scope", () => {
  const authority = new AgentBridgeAuthority("agent-bridge-test-secret-at-least-32-characters", 60);
  const workspaceId = randomUUID();
  const issuedAt = new Date("2026-08-02T00:00:00.000Z");
  const token = authority.issue(identity, workspaceId, runtimePolicy, {
    workspaceGeneration: 7,
    now: issuedAt,
  });

  const grant = authority.verify(token, {
    audience: agentBridgeAudience,
    scope: "agent:sites",
    now: new Date("2026-08-02T00:00:30.000Z"),
  });
  assert.equal(grant.workspaceGeneration, 7);
  assert.match(grant.jti, /^[0-9a-f-]{36}$/);
  assert.equal(grant.issuedAt, Math.floor(issuedAt.getTime() / 1000));
  assert.equal(grant.expiresAt, Math.floor(issuedAt.getTime() / 1000) + 60);

  assert.throws(
    () => authority.verify(token, { audience: agentBridgeAudience, scope: "agent:sites", now: new Date("2026-08-02T00:01:01.000Z") }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "AGENT_BRIDGE_GRANT_EXPIRED"),
  );
  assert.throws(
    () => authority.verify(token, { audience: "other-control", scope: "agent:sites", now: issuedAt }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "AGENT_BRIDGE_GRANT_AUDIENCE_INVALID"),
  );

  const renewalOnly = authority.issue(identity, workspaceId, runtimePolicy, {
    workspaceGeneration: 7,
    scopes: ["agent:renew"],
    now: issuedAt,
  });
  assert.throws(
    () => authority.verify(renewalOnly, { audience: agentBridgeAudience, scope: "agent:sites", now: issuedAt }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "AGENT_BRIDGE_GRANT_SCOPE_DENIED"),
  );
});

test("renewed v2 agent bridge grants retain their exact capability boundary and receive a new ID", () => {
  const authority = new AgentBridgeAuthority("agent-bridge-test-secret-at-least-32-characters", 60);
  const workspaceId = randomUUID();
  const issuedAt = new Date("2026-08-02T00:00:00.000Z");
  const original = authority.verify(authority.issue(identity, workspaceId, runtimePolicy, {
    workspaceGeneration: 3,
    scopes: ["agent:usage-bindings", "agent:renew"],
    now: issuedAt,
  }), { audience: agentBridgeAudience, scope: "agent:renew", now: issuedAt });

  const renewed = authority.verify(authority.renew(original, { now: new Date("2026-08-02T00:00:30.000Z") }), {
    audience: agentBridgeAudience,
    scope: "agent:usage-bindings",
    now: new Date("2026-08-02T00:00:30.000Z"),
  });
  assert.notEqual(renewed.jti, original.jti);
  assert.deepEqual(renewed.scopes, original.scopes);
  assert.equal(renewed.workspaceGeneration, original.workspaceGeneration);
  assert.equal(renewed.policyHash, original.policyHash);
});
