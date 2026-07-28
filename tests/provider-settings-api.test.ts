import assert from "node:assert/strict";
import test from "node:test";
import { OneComputerError, type IdentityContext } from "@onecomputer/contracts";
import {
  managedProviderModels,
  type GatewayClient,
  type ProviderAdministrationGateway,
} from "@onecomputer/litellm-adapter";
import {
  MemoryProviderSettingsStore,
  MemoryWorkspaceStore,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type SessionPrincipal,
} from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "provider-settings-proxy-token-at-least-24-characters";
const rawOpenAiKey = "sk-control-openai-never-returned-000000001";
const rawRejectedKey = "sk-control-rejected-never-returned-000002";

const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "alpha",
  audience: "onecomputer-control",
};
const administrator: SessionPrincipal = {
  userId: identity.subjectId,
  tenantId: identity.tenantId,
  email: "alpha@example.test",
  displayName: "Alpha",
  tenantDisplayName: "Acme",
  roles: ["employee", "administrator"],
  identity,
};
const employee: SessionPrincipal = {
  ...administrator,
  roles: ["employee"],
};
const testHeaders = {
  "x-onecomputer-proxy-token": proxyToken,
  "x-onecomputer-test-tenant-id": identity.tenantId,
  "x-onecomputer-test-user-id": identity.subjectId,
};

const effectivePolicy: EffectivePolicy = {
  assignmentId: "provider-assignment",
  policyBundleId: "provider-bundle",
  policyVersionId: "provider-policy-v1",
  version: 1,
  documentHash: "a".repeat(64),
  assignedBy: "administrator",
  assignedAt: new Date().toISOString(),
  agentId: "provider-agent",
  vendorUserId: "provider-user",
  document: {
    schemaVersion: 1,
    workspaceProfile: "claude-desktop-standard-v1",
    workspaceProfiles: ["claude-desktop-standard-v1"],
    agentProfile: "claude-desktop-managed-v1",
    modelAliases: ["onecomputer-assistant"],
    networkProfile: "controlled-egress-v1",
    mcp: {
      servers: {
        onecomputer_ms365: {
          tools: ["list-mail-folders"],
          toolPolicies: { "list-mail-folders": "allow" },
        },
      },
    },
  },
};

const identityPolicies = () => ({
  listUsers: async (tenantId: string) => tenantId === identity.tenantId ? [{
    userId: administrator.userId,
    email: administrator.email,
    displayName: administrator.displayName,
    status: "active" as const,
    roles: administrator.roles,
    effectivePolicy,
  }] : [],
  getPrincipal: async (userId: string) => userId === administrator.userId ? administrator : null,
  getEffectivePolicy: async (userId: string) => userId === administrator.userId ? effectivePolicy : null,
}) as unknown as IdentityPolicyStore;

const authentication = (principal: SessionPrincipal) => ({
  begin: async () => ({ location: "https://login.example.test", cookie: "state=opaque" }),
  complete: async () => { throw new Error("not used"); },
  authenticate: async () => principal,
  logout: async () => "onecomputer_session=; Max-Age=0",
});

class FakeProviderAdministration implements ProviderAdministrationGateway {
  configured: Array<{ tenantId: string; provider: string; apiKey: string }> = [];
  deleted: Array<{ tenantId: string; provider: string; modelIds: string[] }> = [];
  failure: Error | null = null;

  async configureManagedProvider(input: { tenantId: string; provider: "openai" | "anthropic"; apiKey: string }) {
    if (this.failure) throw this.failure;
    this.configured.push(input);
    return {
      modelIds: managedProviderModels[input.provider].map((model) => input.tenantId + "-" + input.provider + "-" + model.alias),
      credentialFingerprint: "fp_" + input.tenantId + "_" + input.provider,
    };
  }

  async testManagedProvider() {}

  async deleteManagedProvider(input: { tenantId: string; provider: "openai" | "anthropic"; existingModelIds: string[] }) {
    this.deleted.push({ ...input, modelIds: input.existingModelIds });
  }
}

test("provider administration is write-only, blocks unconfigured workspaces, and revokes affected grants", async () => {
  const workspaceStore = new MemoryWorkspaceStore();
  const existing = await workspaceStore.createOrGet(identity, "personal", "provider-existing-workspace");
  await workspaceStore.update(existing.id, { state: "ready" });
  const settingsStore = new MemoryProviderSettingsStore();
  const providerAdministration = new FakeProviderAdministration();
  const revoked: string[] = [];
  const gateway = {
    revoke: async (workspaceId: string, agentId?: string) => { revoked.push(workspaceId + ":" + (agentId ?? "")); },
  } as GatewayClient;
  const app = createControlServer(
    workspaceStore,
    {} as ControllerClient,
    proxyToken,
    gateway,
    undefined,
    {},
    {
      testIdentityMode: true,
      identityPolicyStore: identityPolicies(),
      providerSettingsStore: settingsStore,
      providerAdministration,
    },
  );

  try {
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-preflight-0001" },
      payload: { grantId: "workspace-provider-preflight" },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, "PROVIDER_NOT_CONFIGURED");

    const configured = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/openai",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-configure-0001" },
      payload: { apiKey: rawOpenAiKey },
    });
    assert.equal(configured.statusCode, 200);
    assert.equal(configured.json().provider.state, "active");
    assert.equal(configured.json().provider.fingerprint, "fp_acme_openai");
    assert.equal(JSON.stringify(configured.json()).includes(rawOpenAiKey), false);
    assert.equal(providerAdministration.configured[0]!.apiKey, rawOpenAiKey);

    const stored = await settingsStore.getProviderSetting(identity.tenantId, "openai");
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes(rawOpenAiKey), false);
    assert.equal("apiKey" in stored, false);

    const tested = await app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/openai/test",
      headers: { ...testHeaders, "idempotency-key": "provider-test-0001" },
    });
    assert.equal(tested.statusCode, 200);
    assert.equal(tested.json().provider.lastErrorCode, null);
    assert.ok(tested.json().provider.lastTestedAt);

    const disabled = await app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/openai/disable",
      headers: { ...testHeaders, "idempotency-key": "provider-disable-0001" },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().provider.state, "disabled");
    assert.deepEqual(disabled.json().workspaceGrants, { revoked: 1, failed: 0 });
    assert.equal(disabled.json().restartRequired, true);
    assert.deepEqual(providerAdministration.deleted[0]!.modelIds, managedProviderModels.openai.map((model) => "acme-openai-" + model.alias));
    assert.deepEqual(revoked, [existing.id + ":provider-agent:claude-desktop"]);

    const blockedAgain = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-preflight-0002" },
      payload: { grantId: "workspace-provider-preflight-retry" },
    });
    assert.equal(blockedAgain.statusCode, 409);
    assert.equal(blockedAgain.json().error.code, "PROVIDER_NOT_CONFIGURED");

    providerAdministration.failure = new OneComputerError(
      "PROVIDER_CREDENTIAL_REJECTED",
      "upstream reflected " + rawRejectedKey,
      422,
    );
    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/anthropic",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-configure-0002" },
      payload: { apiKey: rawRejectedKey },
    });
    assert.equal(rejected.statusCode, 422);
    assert.equal(rejected.json().error.code, "PROVIDER_CREDENTIAL_REJECTED");
    assert.equal(JSON.stringify(rejected.json()).includes(rawRejectedKey), false);
    assert.match(rejected.json().error.message, /provider API key or approved model access was rejected/);
  } finally {
    await app.close();
  }
});

test("provider settings do not expose an administrator endpoint to an employee session", async () => {
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    {},
    {
      authentication: authentication(employee),
      providerSettingsStore: new MemoryProviderSettingsStore(),
      providerAdministration: new FakeProviderAdministration(),
    },
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/provider-settings",
      headers: { "x-onecomputer-proxy-token": proxyToken, cookie: "onecomputer_session=employee" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "FORBIDDEN");
  } finally {
    await app.close();
  }
});
