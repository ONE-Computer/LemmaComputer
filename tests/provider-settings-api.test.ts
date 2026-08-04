import assert from "node:assert/strict";
import test from "node:test";
import { LemmaComputerError, type IdentityContext } from "@lemmacomputer/contracts";
import {
  managedProviderModels,
  managedProviderDeploymentDescriptors,
  managedProviderModelAlias,
  type GatewayClient,
  type ManagedProviderConfiguration,
  type ManagedProviderOperation,
  type ManagedProviderRoute,
  type ProviderAdministrationGateway,
} from "@lemmacomputer/litellm-adapter";
import {
  MemoryProviderSettingsStore,
  MemoryWorkspaceStore,
  type EffectivePolicy,
  type IdentityPolicyStore,
  type SessionPrincipal,
} from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import { ProviderSettingsService } from "../apps/control-api/src/provider-settings.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken = "provider-settings-proxy-token-at-least-24-characters";
const rawOpenAiKey = "sk-control-openai-never-returned-000000001";
const rawAnthropicKey = "sk-control-anthropic-never-returned-00001";
const rawGlmKey = "sk-control-glm-never-returned-000000000002";
const rawRejectedKey = "sk-control-rejected-never-returned-000002";

const identity: IdentityContext = {
  tenantId: "acme",
  subjectId: "alpha",
  audience: "lemmacomputer-control",
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
  "x-lemmacomputer-proxy-token": proxyToken,
  "x-lemmacomputer-test-tenant-id": identity.tenantId,
  "x-lemmacomputer-test-user-id": identity.subjectId,
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
    modelAliases: ["lemmacomputer-assistant"],
    networkProfile: "controlled-egress-v1",
    mcp: {
      servers: {
        lemmacomputer_ms365: {
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
  logout: async () => "lemmacomputer_session=; Max-Age=0",
});

class FakeProviderAdministration implements ProviderAdministrationGateway {
  configured: ManagedProviderConfiguration[] = [];
  deleted: Array<{ tenantId: string; provider: string; modelIds: string[] }> = [];
  tested: ManagedProviderOperation[] = [];
  failure: Error | null = null;

  async configureManagedProvider(input: ManagedProviderConfiguration): Promise<ManagedProviderRoute> {
    if (this.failure) throw this.failure;
    this.configured.push(input);
    const configuration = input.provider === "bedrock"
      ? { region: input.region, modelProfileId: input.modelProfileId }
      : input.modelIds ? { modelIds: input.modelIds } : { modelId: input.modelId };
    const additionalModelIds = input.provider !== "bedrock" && input.modelIds
      ? input.modelIds.map((modelId) => input.tenantId + "-" + managedProviderModelAlias(input.provider, modelId))
      : [];
    const modelIds = [
      ...managedProviderModels[input.provider].map((model) => input.tenantId + "-" + input.provider + "-" + model.alias),
      ...additionalModelIds,
    ];
    return {
      modelIds,
      deployments: managedProviderDeploymentDescriptors(input.tenantId, input.provider, configuration),
      credentialFingerprint: "fp_" + input.tenantId + "_" + input.provider,
      configuration,
    };
  }

  async testManagedProvider(input: ManagedProviderOperation) {
    this.tested.push({ ...input, existingModelIds: [...input.existingModelIds] });
  }

  async deleteManagedProvider(input: ManagedProviderOperation) {
    if (this.failure) throw this.failure;
    this.deleted.push({ tenantId: input.tenantId, provider: input.provider, modelIds: [...input.existingModelIds] });
  }
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const deferred = (): Deferred => {
  let resolve = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

class DelayedProviderAdministration extends FakeProviderAdministration {
  configureGate: Deferred | null = null;
  deleteGate: Deferred | null = null;
  configureStarted: Deferred | null = null;
  deleteStarted: Deferred | null = null;

  override async configureManagedProvider(input: ManagedProviderConfiguration) {
    if (this.configureGate) {
      this.configureStarted?.resolve();
      await this.configureGate.promise;
    }
    return super.configureManagedProvider(input);
  }

  override async deleteManagedProvider(input: ManagedProviderOperation) {
    if (this.deleteGate) {
      this.deleteStarted?.resolve();
      await this.deleteGate.promise;
    }
    return super.deleteManagedProvider(input);
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
      payload: { apiKey: rawOpenAiKey, modelId: "gpt-5.6-terra", emissionsRegion: "sg" },
    });
    assert.equal(configured.statusCode, 200);
    assert.equal(configured.json().provider.state, "active");
    assert.equal(configured.json().provider.fingerprint, "fp_acme_openai");
    assert.equal(configured.json().provider.modelId, "gpt-5.6-terra");
    assert.equal(configured.json().provider.emissionsRegion, "sg");
    assert.deepEqual(configured.json().provider.modelOptions, [
      { id: "gpt-5.6-sol", displayName: "OpenAI GPT-5.6 Sol", modelCapabilities: { vision: true, tools: true, streaming: true } },
      { id: "gpt-5.6-terra", displayName: "OpenAI GPT-5.6 Terra", modelCapabilities: { vision: true, tools: true, streaming: true } },
      { id: "gpt-5.6-luna", displayName: "OpenAI GPT-5.6 Luna", modelCapabilities: { vision: true, tools: true, streaming: true } },
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
        { provider: "openai", primaryAlias: "lemmacomputer-openai", upstreamModelDisplayName: "OpenAI GPT-5.6 Terra" },
        { provider: "anthropic", primaryAlias: "lemmacomputer-claude", upstreamModelDisplayName: "Anthropic Claude Sonnet 4.6" },
        { provider: "glm", primaryAlias: "lemmacomputer-glm", upstreamModelDisplayName: "Z.ai GLM-5" },
        { provider: "bedrock", primaryAlias: "lemmacomputer-bedrock", upstreamModelDisplayName: "Amazon Bedrock Claude Sonnet 4.5" },
      ],
    );
    const listedGlm = listed.json().providers.find((provider: { provider: string }) => provider.provider === "glm");
    assert.deepEqual(listedGlm.aliases, ["lemmacomputer-glm", "claude-sonnet-4-5"]);

    const configuredGlm = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/glm",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-configure-glm-0001" },
      payload: { apiKey: rawGlmKey, modelId: "glm-5.2" },
    });
    assert.equal(configuredGlm.statusCode, 200);
    assert.equal(configuredGlm.json().provider.provider, "glm");
    assert.equal(configuredGlm.json().provider.state, "active");
    assert.equal(configuredGlm.json().provider.primaryAlias, "lemmacomputer-glm");
    assert.equal(configuredGlm.json().provider.upstreamModelDisplayName, "Z.ai GLM-5.2");
    assert.equal(configuredGlm.json().provider.modelId, "glm-5.2");
    assert.deepEqual(configuredGlm.json().provider.modelOptions, [
      { id: "glm-5", displayName: "Z.ai GLM-5", modelCapabilities: { vision: false, tools: true, streaming: true } },
      { id: "glm-5.2", displayName: "Z.ai GLM-5.2", modelCapabilities: { vision: false, tools: true, streaming: true } },
    ]);
    assert.equal(JSON.stringify(configuredGlm.json()).includes(rawGlmKey), false);
    assert.equal(providerAdministration.configured[1]!.provider, "glm");
    assert.equal(providerAdministration.configured[1]!.apiKey, rawGlmKey);

    const configuredAnthropic = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/anthropic",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-configure-anthropic-0001" },
      payload: { apiKey: rawAnthropicKey, modelId: "claude-opus-4-8" },
    });
    assert.equal(configuredAnthropic.statusCode, 200);
    assert.equal(configuredAnthropic.json().provider.modelId, "claude-opus-4-8");
    assert.equal(configuredAnthropic.json().provider.upstreamModelDisplayName, "Anthropic Claude Opus 4.8");
    assert.deepEqual(configuredAnthropic.json().provider.modelOptions, [
      { id: "claude-sonnet-4-6", displayName: "Anthropic Claude Sonnet 4.6", modelCapabilities: { vision: true, tools: true, streaming: true } },
      { id: "claude-opus-4-8", displayName: "Anthropic Claude Opus 4.8", modelCapabilities: { vision: true, tools: true, streaming: true } },
    ]);
    assert.equal(JSON.stringify(configuredAnthropic.json()).includes(rawAnthropicKey), false);

    const stored = await settingsStore.getProviderSetting(identity.tenantId, "openai");
    assert.ok(stored);
    assert.deepEqual(stored.configuration, { modelId: "gpt-5.6-terra", emissionsRegion: "sg" });
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
    assert.deepEqual(providerAdministration.tested[0]!.configuration, { modelId: "gpt-5.6-terra", emissionsRegion: "sg" });

    const changedModel = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/openai",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-model-change-0001" },
      payload: { apiKey: rawOpenAiKey, modelId: "gpt-5.6-sol" },
    });
    assert.equal(changedModel.statusCode, 200);
    assert.equal(changedModel.json().provider.modelId, "gpt-5.6-sol");
    assert.equal(changedModel.json().provider.upstreamModelDisplayName, "OpenAI GPT-5.6 Sol");
    assert.deepEqual(providerAdministration.configured.at(-1)!.configuration, { modelId: "gpt-5.6-terra", emissionsRegion: "sg" });
    assert.equal(changedModel.json().provider.emissionsRegion, "sg");

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

    providerAdministration.failure = new LemmaComputerError(
      "PROVIDER_CREDENTIAL_REJECTED",
      "upstream reflected " + rawRejectedKey,
      422,
    );
    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/anthropic",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-configure-0002" },
      payload: { apiKey: rawRejectedKey, modelId: "claude-opus-4-8" },
    });
    assert.equal(rejected.statusCode, 422);
    assert.equal(rejected.json().error.code, "PROVIDER_CREDENTIAL_REJECTED");
    assert.equal(JSON.stringify(rejected.json()).includes(rawRejectedKey), false);
    assert.match(rejected.json().error.message, /provider rejected the API key or selected upstream model/);
  } finally {
    await app.close();
  }
});

test("a disable fences an in-flight provider rotation and revokes workspace grants before gateway cleanup", async () => {
  const workspaceStore = new MemoryWorkspaceStore();
  const existing = await workspaceStore.createOrGet(identity, "personal", "provider-disable-race-workspace");
  await workspaceStore.update(existing.id, { state: "ready" });
  const settingsStore = new MemoryProviderSettingsStore();
  const providerAdministration = new DelayedProviderAdministration();
  const revoked: string[] = [];
  const revokeStarted = deferred();
  const gateway = {
    revoke: async (workspaceId: string, agentId?: string) => {
      revoked.push(workspaceId + ":" + (agentId ?? ""));
      revokeStarted.resolve();
    },
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
    const initial = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/openai",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-race-initial-0001" },
      payload: { apiKey: rawOpenAiKey, modelId: "gpt-5.6-terra" },
    });
    assert.equal(initial.statusCode, 200);

    providerAdministration.configureGate = deferred();
    providerAdministration.configureStarted = deferred();
    const rotate = app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/openai",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-race-rotate-0001" },
      payload: { apiKey: rawOpenAiKey, modelId: "gpt-5.6-sol" },
    });
    await providerAdministration.configureStarted.promise;

    providerAdministration.deleteGate = deferred();
    providerAdministration.deleteStarted = deferred();
    const disable = app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/openai/disable",
      headers: { ...testHeaders, "idempotency-key": "provider-race-disable-0001" },
    });
    await revokeStarted.promise;

    const fencedBeforeCleanup = await settingsStore.getProviderSetting(identity.tenantId, "openai");
    assert.equal(fencedBeforeCleanup?.state, "disabled");
    assert.deepEqual(fencedBeforeCleanup?.modelIds, []);
    assert.deepEqual(revoked, [existing.id + ":provider-agent:claude-desktop"]);

    providerAdministration.configureGate.resolve();
    await providerAdministration.deleteStarted.promise;
    providerAdministration.deleteGate.resolve();
    const [disabled, rotated] = await Promise.all([disable, rotate]);
    assert.equal(disabled.statusCode, 200);
    assert.equal(rotated.statusCode, 409);
    assert.equal(rotated.json().error.code, "PROVIDER_LIFECYCLE_FENCED");

    const final = await settingsStore.getProviderSetting(identity.tenantId, "openai");
    assert.equal(final?.state, "disabled");
    assert.deepEqual(final?.modelIds, []);
  } finally {
    await app.close();
  }
});

test("a configure that arrives during a disable epoch cannot reactivate the provider", async () => {
  const settingsStore = new MemoryProviderSettingsStore();
  const providerAdministration = new FakeProviderAdministration();
  const revocationStarted = deferred();
  const releaseRevocation = deferred();
  const service = new ProviderSettingsService(settingsStore, providerAdministration, {
    revokeWorkspaceGrants: async () => {
      revocationStarted.resolve();
      await releaseRevocation.promise;
      return { revoked: 0, failed: 0 };
    },
  });
  await service.configure(administrator, {
    provider: "openai",
    apiKey: rawOpenAiKey,
    modelId: "gpt-5.6-terra",
  });

  const disabling = service.disable(administrator, "openai");
  await revocationStarted.promise;
  const fenced = await settingsStore.getProviderSetting(identity.tenantId, "openai");
  assert.equal(fenced?.state, "disabled");

  const reconfigure = service.configure(administrator, {
    provider: "openai",
    apiKey: rawOpenAiKey,
    modelId: "gpt-5.6-sol",
  });
  try {
    await assert.rejects(
      reconfigure,
      (error: unknown) => error instanceof LemmaComputerError && error.code === "PROVIDER_LIFECYCLE_FENCED",
    );
  } finally {
    releaseRevocation.resolve();
    await disabling;
  }

  const final = await settingsStore.getProviderSetting(identity.tenantId, "openai");
  assert.equal(final?.state, "disabled");
  assert.deepEqual(final?.modelIds, []);
  assert.equal(providerAdministration.configured.length, 1, "the post-fence configure must not reach LiteLLM");

  const explicitReenable = await service.configure(administrator, {
    provider: "openai",
    apiKey: rawOpenAiKey,
    modelId: "gpt-5.6-sol",
  });
  assert.equal(explicitReenable.state, "active");
  assert.equal(providerAdministration.configured.length, 2);
});

test("reconciliation retries gateway cleanup without re-enabling a disabled provider", async () => {
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

  try {
    const configured = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/openai",
      headers: { ...testHeaders, "content-type": "application/json", "idempotency-key": "provider-reconcile-initial-0001" },
      payload: { apiKey: rawOpenAiKey, modelId: "gpt-5.6-terra" },
    });
    assert.equal(configured.statusCode, 200);

    providerAdministration.failure = new LemmaComputerError("PROVIDER_GATEWAY_UNAVAILABLE", "gateway unavailable", 503, true);
    const disabled = await app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/openai/disable",
      headers: { ...testHeaders, "idempotency-key": "provider-reconcile-disable-0001" },
    });
    assert.equal(disabled.statusCode, 503);
    assert.equal(disabled.json().error.code, "PROVIDER_LIFECYCLE_RECONCILIATION_REQUIRED");
    const fenced = await settingsStore.getProviderSetting(identity.tenantId, "openai");
    const pending = await settingsStore.getProviderLifecycle(identity.tenantId, "openai");
    assert.equal(fenced?.state, "disabled");
    assert.deepEqual(fenced?.modelIds, []);
    assert.equal(pending?.desiredState, "disabled");
    assert.equal(pending?.reconciliationStatus, "pending");

    providerAdministration.failure = null;
    const reconciled = await app.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/openai/reconcile",
      headers: { ...testHeaders, "idempotency-key": "provider-reconcile-retry-0001" },
    });
    assert.equal(reconciled.statusCode, 200);
    assert.equal(reconciled.json().provider.state, "disabled");
    const completed = await settingsStore.getProviderLifecycle(identity.tenantId, "openai");
    assert.equal(completed?.desiredState, "disabled");
    assert.equal(completed?.reconciliationStatus, "not_required");
    assert.deepEqual(completed?.pendingCleanupModelIds, []);
  } finally {
    await app.close();
  }
});

test("removing a provider that was never configured preserves the not-configured response", async () => {
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
      providerSettingsStore: new MemoryProviderSettingsStore(),
      providerAdministration: new FakeProviderAdministration(),
    },
  );

  try {
    const removed = await app.inject({
      method: "DELETE",
      url: "/v1/admin/provider-settings/openai",
      headers: { ...testHeaders, "idempotency-key": "provider-never-configured-delete-0001" },
    });
    assert.equal(removed.statusCode, 404);
    assert.equal(removed.json().error.code, "PROVIDER_NOT_CONFIGURED");
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
    providerAdministration.failure = new LemmaComputerError(
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

    await settingsStore.beginProviderLifecycle({
      tenantId: identity.tenantId,
      provider: "bedrock",
      updatedBy: administrator.userId,
    });
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
      agentBridgeSecret: "provider-settings-agent-bridge-secret-at-least-32-characters",
      providerSettingsStore: new MemoryProviderSettingsStore(),
      providerAdministration: new FakeProviderAdministration(),
    },
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/provider-settings",
      headers: { "x-lemmacomputer-proxy-token": proxyToken, cookie: "lemmacomputer_session=employee" },
    });
    assert.equal(response.statusCode, 403);

    assert.equal(response.json().error.code, "FORBIDDEN");
  } finally {
    await app.close();
  }
});

test("provider settings accept model sets and expose concrete deployment descriptors", async () => {
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

  try {
    const configured = await app.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/openai",
      headers: { ...testHeaders, "content-type": "application/json" },
      payload: { apiKey: rawOpenAiKey, modelIds: ["gpt-5.6-luna", "gpt-5.6-sol"] },
    });
    assert.equal(configured.statusCode, 200);
    const provider = configured.json().provider;
    assert.equal(provider.modelId, "gpt-5.6-sol");
    assert.deepEqual(provider.selectedModelIds, ["gpt-5.6-sol", "gpt-5.6-luna"]);
    assert.equal(provider.deployments.length, 2);
    assert.deepEqual(provider.deployments.map((deployment: { modelId: string }) => deployment.modelId), [
      "gpt-5.6-sol",
      "gpt-5.6-luna",
    ]);
    assert.equal(provider.deployments[0].primary, true);
    assert.ok(provider.deployments[0].aliases.includes("lemmacomputer-openai"));
    assert.match(provider.deployments[0].providerDeployment, /^ocp-/);
    assert.deepEqual(provider.deployments[1].modelCapabilities, { vision: true, tools: true, streaming: true });
    assert.notEqual(provider.deployments[0].id, provider.deployments[1].id);

    const invalidPayloads = [
      { apiKey: rawOpenAiKey, modelId: "gpt-5.6-sol", emissionsRegion: "eu" },
      { apiKey: rawOpenAiKey, modelIds: [] },
      { apiKey: rawOpenAiKey, modelIds: ["gpt-5.6-sol", "gpt-5.6-sol"] },
      { apiKey: rawOpenAiKey, modelIds: ["claude-opus-4-8"] },
      { apiKey: rawOpenAiKey, modelId: "gpt-5.6-sol", modelIds: ["gpt-5.6-sol"] },
    ];
    for (const payload of invalidPayloads) {
      const rejected = await app.inject({
        method: "PUT",
        url: "/v1/admin/provider-settings/openai",
        headers: { ...testHeaders, "content-type": "application/json" },
        payload,
      });
      assert.equal(rejected.statusCode, 400);
    }
  } finally {
    await app.close();
  }
});
