import assert from "node:assert/strict";
import test from "node:test";
import { OneComputerError, type IdentityContext } from "@onecomputer/contracts";
import {
  managedProviderModels,
  type GatewayClient,
  type ManagedProviderConfiguration,
  type ManagedProviderOperation,
  type ManagedProviderRoute,
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
const rawGlmKey = "sk-control-glm-never-returned-000000000002";
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
  configured: ManagedProviderConfiguration[] = [];
  deleted: Array<{ tenantId: string; provider: string; modelIds: string[] }> = [];
  tested: ManagedProviderOperation[] = [];
  failure: Error | null = null;

  async configureManagedProvider(input: ManagedProviderConfiguration): Promise<ManagedProviderRoute> {
    if (this.failure) throw this.failure;
    this.configured.push(input);
    return {
      modelIds: managedProviderModels[input.provider].map((model) => input.tenantId + "-" + input.provider + "-" + model.alias),
      credentialFingerprint: "fp_" + input.tenantId + "_" + input.provider,
      configuration: input.provider === "bedrock"
        ? { region: input.region, modelProfileId: input.modelProfileId }
        : input.provider === "openai"
        ? { modelId: input.modelId }
        : {},
    };
  }

  async testManagedProvider(input: ManagedProviderOperation) {
    this.tested.push({ ...input, existingModelIds: [...input.existingModelIds] });
  }

  async deleteManagedProvider(input: ManagedProviderOperation) {
    this.deleted.push({ tenantId: input.tenantId, provider: input.provider, modelIds: [...input.existingModelIds] });
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
      payload: { apiKey: rawOpenAiKey, modelId: "gpt-5.6-terra" },
    });
    assert.equal(configured.statusCode, 200);
    assert.equal(configured.json().provider.state, "active");
    assert.equal(configured.json().provider.fingerprint, "fp_acme_openai");
    assert.equal(configured.json().provider.modelId, "gpt-5.6-terra");
    assert.deepEqual(configured.json().provider.modelOptions, [
      { id: "gpt-5.6-sol", displayName: "OpenAI GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", displayName: "OpenAI GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", displayName: "OpenAI GPT-5.6 Luna" },
    ]);
    assert.equal(JSON.stringify(configured.json()).includes(rawOpenAiKey), false);
    assert.equal(providerAdministration.configured[0]!.apiKey, rawOpenAiKey);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/provider-settings",
      headers: testHeaders,
    });
    assert.deepEqual(listed.json().providers.map((provider: { provider: string }) => provider.provider), ["openai", "anthropic", "glm", "bedrock"]);
    assert.deepEqual(
      listed.json().providers.map((provider: {
        provider: string;
        primaryAlias: string;
        upstreamModelDisplayName: string;
      }) => ({
        provider: provider.provider,
        primaryAlias: provider.primaryAlias,
        upstreamModelDisplayName: provider.upstreamModelDisplayName,
      })),
      [
        { provider: "openai", primaryAlias: "onecomputer-openai", upstreamModelDisplayName: "OpenAI GPT-5.6 Terra" },
        { provider: "anthropic", primaryAlias: "onecomputer-claude", upstreamModelDisplayName: "Anthropic Claude Sonnet 4.6" },
        { provider: "glm", primaryAlias: "onecomputer-glm", upstreamModelDisplayName: "Z.ai GLM-5" },
        { provider: "bedrock", primaryAlias: "onecomputer-bedrock", upstreamModelDisplayName: "Amazon Bedrock Claude Sonnet 4.5" },
      ],
    );
    const listedGlm = listed.json().providers.find((provider: { provider: string }) => provider.provider === "glm");
    assert.deepEqual(listedGlm.aliases, ["onecomputer-glm", "claude-sonnet-4-5"]);

    const configuredGlm = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/glm",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-configure-glm-0001" },
      payload: { apiKey: rawGlmKey },
    });
    assert.equal(configuredGlm.statusCode, 200);
    assert.equal(configuredGlm.json().provider.provider, "glm");
    assert.equal(configuredGlm.json().provider.state, "active");
    assert.equal(configuredGlm.json().provider.primaryAlias, "onecomputer-glm");
    assert.equal(configuredGlm.json().provider.upstreamModelDisplayName, "Z.ai GLM-5");
    assert.equal(JSON.stringify(configuredGlm.json()).includes(rawGlmKey), false);
    assert.equal(providerAdministration.configured[1]!.provider, "glm");
    assert.equal(providerAdministration.configured[1]!.apiKey, rawGlmKey);

    const stored = await settingsStore.getProviderSetting(identity.tenantId, "openai");
    assert.ok(stored);
    assert.deepEqual(stored.configuration, { modelId: "gpt-5.6-terra" });
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
    assert.deepEqual(providerAdministration.tested[0]!.configuration, { modelId: "gpt-5.6-terra" });

    const rejectedModelChange = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/openai",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-model-change-0001" },
      payload: { apiKey: rawOpenAiKey, modelId: "gpt-5.6-sol" },
    });
    assert.equal(rejectedModelChange.statusCode, 409);
    assert.equal(rejectedModelChange.json().error.code, "PROVIDER_MODEL_RECONFIGURATION_REQUIRED");

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

test("Bedrock provider settings persist only approved selection metadata and fail closed when it is malformed", async () => {
  const settingsStore = new MemoryProviderSettingsStore();
  const providerAdministration = new FakeProviderAdministration();
  const app = createControlServer(
    new MemoryWorkspaceStore(),
    {} as ControllerClient,
    proxyToken,
    undefined,
    undefined,
    {},
    {
      testIdentityMode: true,
      identityPolicyStore: identityPolicies(),
      providerSettingsStore: settingsStore,
      providerAdministration,
    },
  );
  const rawBedrockKey = "bedrock-control-key-never-returned-00000001";
  const rawRejectedBedrockKey = "bedrock-control-rejected-never-returned-0002";
  const selection = { region: "ap-southeast-1", modelProfileId: "claude-sonnet-4-5-global" };

  try {
    const invalidSelection = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/bedrock",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "bedrock-invalid-selection-0001" },
      payload: { apiKey: rawBedrockKey, region: "us-east-2", modelProfileId: selection.modelProfileId },
    });
    assert.equal(invalidSelection.statusCode, 400);
    assert.equal(JSON.stringify(invalidSelection.json()).includes(rawBedrockKey), false);

    const configured = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/bedrock",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "bedrock-configure-0001" },
      payload: { apiKey: rawBedrockKey, ...selection },
    });
    assert.equal(configured.statusCode, 200);
    assert.equal(configured.json().provider.provider, "bedrock");
    assert.equal(configured.json().provider.state, "active");
    assert.equal(configured.json().provider.region, selection.region);
    assert.equal(configured.json().provider.modelProfileId, selection.modelProfileId);
    assert.equal(JSON.stringify(configured.json()).includes(rawBedrockKey), false);
    assert.equal(providerAdministration.configured[0]!.apiKey, rawBedrockKey);

    const stored = await settingsStore.getProviderSetting(identity.tenantId, "bedrock");
    assert.ok(stored);
    assert.deepEqual(stored.configuration, selection);
    assert.equal(JSON.stringify(stored).includes(rawBedrockKey), false);

    const tested = await app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/bedrock/test",
      headers: { ...testHeaders, "idempotency-key": "bedrock-test-0001" },
    });
    assert.equal(tested.statusCode, 200);
    assert.equal(providerAdministration.tested[0]!.provider, "bedrock");

    const beforeRejectedRotation = await settingsStore.getProviderSetting(identity.tenantId, "bedrock");
    assert.ok(beforeRejectedRotation);
    providerAdministration.failure = new OneComputerError(
      "BEDROCK_API_KEY_INVALID",
      "upstream reflected " + rawRejectedBedrockKey,
      422,
    );
    const rejectedRotation = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/bedrock",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "bedrock-rotation-rejected-0001" },
      payload: { apiKey: rawRejectedBedrockKey, ...selection },
    });
    assert.equal(rejectedRotation.statusCode, 422);
    assert.equal(rejectedRotation.json().error.code, "BEDROCK_API_KEY_INVALID");
    assert.equal(JSON.stringify(rejectedRotation.json()).includes(rawRejectedBedrockKey), false);
    const afterRejectedRotation = await settingsStore.getProviderSetting(identity.tenantId, "bedrock");
    assert.ok(afterRejectedRotation);
    assert.deepEqual(afterRejectedRotation.modelIds, beforeRejectedRotation.modelIds);
    assert.deepEqual(afterRejectedRotation.configuration, beforeRejectedRotation.configuration);
    assert.equal(afterRejectedRotation.credentialFingerprint, beforeRejectedRotation.credentialFingerprint);
    providerAdministration.failure = null;

    const disabled = await app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/bedrock/disable",
      headers: { ...testHeaders, "idempotency-key": "bedrock-disable-0001" },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().provider.state, "disabled");
    assert.equal(disabled.json().provider.region, selection.region);
    assert.equal(disabled.json().provider.modelProfileId, selection.modelProfileId);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/admin/provider-settings/bedrock",
      headers: { ...testHeaders, "idempotency-key": "bedrock-delete-0001" },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(await settingsStore.getProviderSetting(identity.tenantId, "bedrock"), null);

    await settingsStore.saveProviderSetting({
      tenantId: identity.tenantId,
      provider: "bedrock",
      modelIds: managedProviderModels.bedrock.map((model) => identity.tenantId + "-bedrock-" + model.alias),
      configuration: {},
      state: "active",
      credentialFingerprint: "fp_malformed_bedrock",
      lastTestedAt: null,
      lastErrorCode: null,
      updatedBy: administrator.userId,
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/provider-settings",
      headers: testHeaders,
    });
    const malformedView = listed.json().providers.find((provider: { provider: string }) => provider.provider === "bedrock");
    assert.equal(malformedView.state, "needs-reconfiguration");
    assert.equal(malformedView.region, null);
    assert.equal(malformedView.modelProfileId, null);

    const malformedTest = await app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/bedrock/test",
      headers: { ...testHeaders, "idempotency-key": "bedrock-malformed-test-0001" },
    });
    assert.equal(malformedTest.statusCode, 409);
    assert.equal(malformedTest.json().error.code, "PROVIDER_CONFIGURATION_INVALID");

    const recovered = await app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/bedrock/disable",
      headers: { ...testHeaders, "idempotency-key": "bedrock-malformed-disable-0001" },
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().provider.state, "disabled");
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
