import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { defaultManagedProviderModelIds, LiteLLMGatewayAdapter, LiteLLMProviderAdministration, managedProviderModels, tenantManagedModelAccessGroup } from "@lemmacomputer/litellm-adapter";
import { MemoryWorkspaceStore, PostgresProviderSettingsStore, PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";
import { resolve } from "node:path";
import { ProviderSettingsService } from "../apps/control-api/src/provider-settings.js";
import { createControlServer } from "../apps/control-api/src/server.js";

type JsonObject = Record<string, unknown>;
type HttpResult = { response: Response; payload: JsonObject };

const availablePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("Could not reserve a Provider Settings qualification port"));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const waitFor = async (url: string, label: string) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // The isolated Compose services are still starting.
    }
    await delay(500);
  }
  throw new Error(`${label} did not become ready`);
};

const json = async (url: string, init: RequestInit): Promise<HttpResult> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({})) as JsonObject;
  return { response, payload };
};

const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value)
  ? value as JsonObject
  : {};

const stringified = (value: unknown) => JSON.stringify(value);

const main = async () => {
  const transport = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "python",
    "--mount", `type=bind,src=${resolve("scripts/qualify-cloud-provider-transports.py")},dst=/qualification.py,readonly`,
    "-e", "LITELLM_LOCAL_MODEL_COST_MAP=True",
    "ghcr.io/berriai/litellm:v1.93.0@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e", "/qualification.py"], { stdio: "inherit" });
  if (transport.status !== 0) throw new Error("Pinned cloud provider wire-format qualification failed");
  const catalogCheck = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "python",
    "--mount", `type=bind,src=${resolve("scripts/qualify-model-catalog.py")},dst=/qualification.py,readonly`,
    "--mount", `type=bind,src=${resolve("integrations/litellm")},dst=/catalog,readonly`,
    "-e", "LITELLM_LOCAL_MODEL_COST_MAP=True",
    "ghcr.io/berriai/litellm:v1.93.0@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e", "/qualification.py"], { stdio: "inherit" });
  if (catalogCheck.status !== 0) throw new Error("Pinned model catalog qualification failed");
  const runId = randomBytes(8).toString("hex");
  const [litellmPort, providerProbePort, fixturePort, controlPostgresPort] = await Promise.all([
    availablePort(), availablePort(), availablePort(), availablePort(),
  ]);
  const project = `lemmacomputer-provider-${process.pid}-${runId}`;
  const masterKey = `sk-provider-qualification-master-${randomBytes(24).toString("base64url")}`;
  const credentialSecret = randomBytes(32).toString("base64url");
  const litellmPostgresPassword = randomBytes(24).toString("hex");
  const providerProbeMasterKey = `sk-provider-probe-qualification-master-${randomBytes(24).toString("base64url")}`;
  const providerProbeCredentialSecret = randomBytes(32).toString("base64url");
  const providerProbePostgresPassword = randomBytes(24).toString("hex");
  const providerProbeUsageToken = randomBytes(32).toString("base64url");
  const controlPostgresPassword = randomBytes(24).toString("hex");
  const proxyToken = `provider-qualification-proxy-${randomBytes(24).toString("base64url")}`;
  const alphaTenant = `tenant-alpha-${runId}`;
  const betaTenant = `tenant-beta-${runId}`;
  const alphaKey = `sk-provider-qualification-alpha-${randomBytes(18).toString("hex")}`;
  const alphaRotatedKey = `sk-provider-qualification-alpha-rotated-${randomBytes(18).toString("hex")}`;
  const alphaReconfiguredKey = `sk-provider-qualification-alpha-reconfigured-${randomBytes(18).toString("hex")}`;
  const betaKey = `sk-provider-qualification-beta-${randomBytes(18).toString("hex")}`;
  const rejectedKey = "sk-provider-qualification-rejected-" + randomBytes(18).toString("hex");
  const providerProbeKey = "sk-provider-probe-qualification-" + randomBytes(18).toString("hex");
  const bedrockKey = "bedrock-provider-qualification-alpha-" + randomBytes(18).toString("hex");
  const bedrockRotatedKey = "bedrock-provider-qualification-alpha-rotated-" + randomBytes(18).toString("hex");
  const bedrockReconfiguredKey = "bedrock-provider-qualification-alpha-reconfigured-" + randomBytes(18).toString("hex");
  const rejectedBedrockKey = "bedrock-provider-qualification-rejected-" + randomBytes(18).toString("hex");
  const azureKey = "azure-qualification-" + randomBytes(18).toString("hex");
  const googleKey = "google-qualification-" + randomBytes(18).toString("hex");
  const googleJson = JSON.stringify({ type: "service_account", client_email: "fixture@example-project.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${googleKey}\n-----END PRIVATE KEY-----`, token_uri: "https://oauth2.googleapis.com/token" });
  const sentinels = [azureKey, googleKey,
    alphaKey, alphaRotatedKey, alphaReconfiguredKey, betaKey, rejectedKey, providerProbeKey,
    bedrockKey, bedrockRotatedKey, bedrockReconfiguredKey, rejectedBedrockKey,
  ];
  const environment = {
    ...process.env,
    LEMMACOMPUTER_PROVIDER_QUALIFICATION_PROJECT: project,
    LEMMACOMPUTER_PROVIDER_QUALIFICATION_MASTER_KEY: masterKey,
    LEMMACOMPUTER_PROVIDER_QUALIFICATION_SALT_KEY: randomBytes(32).toString("hex"),
    LEMMACOMPUTER_PROVIDER_QUALIFICATION_LITELLM_POSTGRES_PASSWORD: litellmPostgresPassword,
    LEMMACOMPUTER_PROVIDER_PROBE_QUALIFICATION_MASTER_KEY: providerProbeMasterKey,
    LEMMACOMPUTER_PROVIDER_PROBE_QUALIFICATION_SALT_KEY: randomBytes(32).toString("hex"),
    LEMMACOMPUTER_PROVIDER_PROBE_QUALIFICATION_POSTGRES_PASSWORD: providerProbePostgresPassword,
    LEMMACOMPUTER_PROVIDER_PROBE_QUALIFICATION_USAGE_TOKEN: providerProbeUsageToken,
    LEMMACOMPUTER_PROVIDER_PROBE_QUALIFICATION_LITELLM_PORT: String(providerProbePort),
    LEMMACOMPUTER_PROVIDER_QUALIFICATION_CONTROL_POSTGRES_PASSWORD: controlPostgresPassword,
    LEMMACOMPUTER_PROVIDER_QUALIFICATION_LITELLM_PORT: String(litellmPort),
    LEMMACOMPUTER_PROVIDER_QUALIFICATION_FIXTURE_PORT: String(fixturePort),
    LEMMACOMPUTER_PROVIDER_QUALIFICATION_CONTROL_POSTGRES_PORT: String(controlPostgresPort),
  };
  const compose = (args: string[]) => {
    const result = spawnSync("docker", [
      "compose",
      "--project-name", project,
      "--file", "compose.provider-qualification.yaml",
      ...args,
    ], { cwd: process.cwd(), encoding: "utf8", env: environment });
    if (result.status !== 0) throw new Error(`Provider Settings qualification Docker command failed: ${args[0] ?? "compose"}`);
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  };
  const litellmUrl = `http://127.0.0.1:${litellmPort}`;
  const providerProbeUrl = `http://127.0.0.1:${providerProbePort}`;
  const controlDatabaseUrl = `postgres://lemmacomputer:${controlPostgresPassword}@127.0.0.1:${controlPostgresPort}/lemmacomputer`;
  const providerGateway = new LiteLLMGatewayAdapter({
    adminUrl: litellmUrl,
    workspaceUrl: litellmUrl,
    masterKey,
    credentialSecret,
    requestTimeoutMs: 30_000,
  });
  const workspaceStore = new MemoryWorkspaceStore();
  const providerAdministration = new LiteLLMProviderAdministration({
    adminUrl: litellmUrl,
    masterKey,
    credentialSecret,
    requestTimeoutMs: 30_000,
    bedrockRuntimeEndpoint: "http://gateway-fixture:4200",
  });
  const callbackProviderAdministration = new LiteLLMProviderAdministration({
    adminUrl: providerProbeUrl,
    masterKey: providerProbeMasterKey,
    credentialSecret: providerProbeCredentialSecret,
    requestTimeoutMs: 30_000,
  });
  const providerSettingsStore = PostgresProviderSettingsStore.fromConnectionString(controlDatabaseUrl);
  const control = createControlServer(
    workspaceStore,
    {} as never,
    proxyToken,
    providerGateway,
    undefined,
    {},
    { testIdentityMode: true, providerSettingsStore, providerAdministration },
  );
  const admin = (path: string, method: "GET" | "POST" = "GET", body?: JsonObject) => json(`${litellmUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${masterKey}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const headersFor = (tenantId: string, operation: string, json = false) => ({
    "x-lemmacomputer-proxy-token": proxyToken,
    "x-lemmacomputer-test-tenant-id": tenantId,
    "x-lemmacomputer-test-user-id": "administrator",
    ...(json ? { "content-type": "application/json" } : {}),
    "idempotency-key": `provider-qualification-${operation}-${runId}`,
  });
  const configure = async (tenantId: string, apiKey: string, operation: string) => {
    const result = await control.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/openai",
      headers: headersFor(tenantId, operation, true),
      payload: { apiKey, modelId: defaultManagedProviderModelIds.openai },
    });
    return { statusCode: result.statusCode, payload: result.json() as JsonObject };
  };
  const configureBedrock = async (tenantId: string, apiKey: string, operation: string) => {
    const result = await control.inject({
      method: "PUT",
      url: "/v1/admin/provider-settings/bedrock",
      headers: headersFor(tenantId, operation, true),
      payload: {
        apiKey,
        region: "ap-southeast-1",
        modelProfileId: "claude-sonnet-4-5-global",
      },
    });
    return { statusCode: result.statusCode, payload: result.json() as JsonObject };
  };
  const providerRead = async (tenantId: string) => {
    const result = await control.inject({
      method: "GET",
      url: "/v1/admin/provider-settings",
      headers: headersFor(tenantId, "read"),
    });
    assert.equal(result.statusCode, 200, "Provider Settings read must succeed for the qualification administrator");
    return result.json() as JsonObject;
  };
  const issueScopedKey = async (accessGroup: string, label: string) => {
    const key = `sk-provider-qualification-workspace-${randomBytes(24).toString("base64url")}`;
    const generated = await admin("/key/generate", "POST", {
      key,
      key_alias: `provider-qualification-${label}-${randomBytes(8).toString("hex")}`,
      key_type: "llm_api",
      duration: "5m",
      models: [accessGroup],
      rpm_limit: 5,
      tpm_limit: 16_000,
      max_parallel_requests: 1,
      metadata: { lemmacomputer_purpose: "provider-settings-qualification" },
    });
    assert.equal(generated.response.ok, true, "LiteLLM must issue a group-scoped virtual key");
    return key;
  };
  const modelCall = async (key: string, model: string) => json(`${litellmUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
      temperature: 0,
    }),
  });
  const processSignature = () => {
    const container = compose(["ps", "-q", "litellm"]).trim();
    assert.ok(container, "The pinned LiteLLM container must be present");
    const result = spawnSync("docker", ["inspect", "--format", "{{.State.StartedAt}}:{{.RestartCount}}", container], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("Could not inspect the pinned LiteLLM qualification container");
    return result.stdout.trim();
  };

  let attempted = false;
  try {
    attempted = true;
    compose(["up", "-d", "--build", "--wait", "--wait-timeout", "300"]);
    await waitFor(`${litellmUrl}/health/liveliness`, "Pinned LiteLLM");
    await waitFor(`${providerProbeUrl}/health/liveliness`, "Callback-enabled provider-probe LiteLLM");
    await waitFor(`http://127.0.0.1:${fixturePort}/healthz`, "Provider fixture");

    const callbackProbeRoute = await callbackProviderAdministration.configureManagedProvider({
      tenantId: `tenant-provider-probe-${runId}`,
      provider: "openai",
      apiKey: providerProbeKey,
      modelId: defaultManagedProviderModelIds.openai,
      existingModelIds: [],
    });
    assert.equal(
      callbackProbeRoute.modelIds.length,
      managedProviderModels.openai.length,
      "OpenAI Provider Settings must qualify through the production callback and direct Responses entry point",
    );

    const migrationStore = PostgresWorkspaceStore.fromConnectionString(controlDatabaseUrl);
    try {
      await migrationStore.migrate();
    } finally {
      await migrationStore.close();
    }
    const controlPool = new pg.Pool({ connectionString: controlDatabaseUrl, max: 2 });
    try {
      await Promise.all([alphaTenant, betaTenant].map(async (tenantId) => {
        await controlPool.query(
          "INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
          [tenantId, `external-${tenantId}`, `Qualification ${tenantId}`],
        );
      }));
    } finally {
      await controlPool.end();
    }

    // Cloud custody uses real pinned LiteLLM credential/model administration
    // and PostgreSQL encryption. Inference probes are mocked: wire translation
    // is checked independently above and real cloud authorization is not claimed.
    const cloudAdministration = new LiteLLMProviderAdministration({ adminUrl: litellmUrl, masterKey, credentialSecret, requestTimeoutMs: 30000,
      adminFetch: async (url, init) => new URL(String(url)).pathname === "/chat/completions"
        ? Response.json({ choices: [{ message: { content: "OK" } }] }) : fetch(url, init),
    });
    const cloudService = new ProviderSettingsService(providerSettingsStore, cloudAdministration);
    for (const tenantId of [alphaTenant, betaTenant]) {
      const actor = { tenantId, userId: "administrator", roles: ["admin" as const], email: "admin@example.test", displayName: "Qualification", tenantDisplayName: "Qualification", tenantKind: "organization" as const, identity: { tenantId, subjectId: "administrator", audience: "lemmacomputer-control" } };
      await cloudService.configure(actor, { provider: "foundry", apiKey: azureKey, modelIds: ["gpt-4.1"], foundry: { endpoint: "https://example-resource.openai.azure.com/openai/v1/", deployments: { "gpt-4.1": "company-gpt" } } });
      await cloudService.configure(actor, { provider: "vertex", apiKey: googleJson, modelIds: ["gemini-2.5-flash"], vertex: { projectId: "example-project", location: "global" } });
    }

    const alphaConfigured = await configure(alphaTenant, alphaKey, "alpha-configure");
    assert.equal(alphaConfigured.statusCode, 200, "A valid alpha key must create a dynamic route through Control");
    const betaConfigured = await configure(betaTenant, betaKey, "beta-configure");
    assert.equal(betaConfigured.statusCode, 200, "A valid beta key must create an independent dynamic route through Control");
    const alphaTested = await control.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/openai/test",
      headers: headersFor(alphaTenant, "alpha-test"),
    });
    assert.equal(alphaTested.statusCode, 200, "Control must test an active dynamic provider route without restart");

    const bedrockSelection = { region: "ap-southeast-1", modelProfileId: "claude-sonnet-4-5-global" } as const;
    const alphaBedrockConfigured = await configureBedrock(alphaTenant, bedrockKey, "bedrock-alpha-configure");
    assert.equal(alphaBedrockConfigured.statusCode, 200, "A valid Bedrock API key must create a tenant-scoped dynamic route through Control");
    assert.equal(asObject(alphaBedrockConfigured.payload.provider).region, bedrockSelection.region);
    assert.equal(asObject(alphaBedrockConfigured.payload.provider).modelProfileId, bedrockSelection.modelProfileId);
    assert.equal(stringified(alphaBedrockConfigured.payload).includes(bedrockKey), false, "Control must not reflect a submitted Bedrock API key");
    const alphaBedrockTested = await control.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/bedrock/test",
      headers: headersFor(alphaTenant, "bedrock-alpha-test"),
    });
    assert.equal(alphaBedrockTested.statusCode, 200, "Control must test an active Bedrock route without restart");

    const alphaRecord = await providerSettingsStore.getProviderSetting(alphaTenant, "openai");
    const betaRecord = await providerSettingsStore.getProviderSetting(betaTenant, "openai");
    const alphaBedrockRecord = await providerSettingsStore.getProviderSetting(alphaTenant, "bedrock");
    assert.ok(alphaRecord && betaRecord && alphaBedrockRecord, "Control must persist only safe metadata for every tenant provider route");
    assert.notDeepEqual(alphaRecord.modelIds, betaRecord.modelIds, "Each tenant must receive distinct LiteLLM model identifiers");
    assert.notDeepEqual(alphaBedrockRecord.modelIds, alphaRecord.modelIds, "Bedrock must not share OpenAI route identifiers");
    assert.equal(alphaRecord.modelIds.length, managedProviderModels.openai.length);
    assert.equal(betaRecord.modelIds.length, managedProviderModels.openai.length);
    assert.equal(alphaBedrockRecord.modelIds.length, managedProviderModels.bedrock.length);
    assert.deepEqual(alphaBedrockRecord.configuration, bedrockSelection, "Control may persist only the approved Bedrock selection metadata");
    assert.equal(stringified(alphaRecord).includes(alphaKey), false, "Control provider metadata must not contain alpha raw key");
    assert.equal(stringified(betaRecord).includes(betaKey), false, "Control provider metadata must not contain beta raw key");
    assert.equal(stringified(alphaBedrockRecord).includes(bedrockKey), false, "Control Bedrock metadata must not contain its raw key");

    const modelInfo = await admin("/model/info");
    assert.equal(modelInfo.response.ok, true, "Pinned LiteLLM model inspection must succeed");
    const routes = Array.isArray(modelInfo.payload.data) ? modelInfo.payload.data.map(asObject) : [];
    const alphaGroup = tenantManagedModelAccessGroup(alphaTenant, "lemmacomputer-assistant");
    const betaGroup = tenantManagedModelAccessGroup(betaTenant, "lemmacomputer-assistant");
    const alphaBedrockGroup = tenantManagedModelAccessGroup(alphaTenant, "lemmacomputer-bedrock");
    assert.notEqual(alphaGroup, betaGroup, "Tenant model access groups must be unique");
    assert.notEqual(alphaBedrockGroup, alphaGroup, "Bedrock must have its own tenant-scoped model group");
    for (const [tenantId, record] of [[alphaTenant, alphaRecord], [betaTenant, betaRecord]] as const) {
      const tenantRoutes = routes.filter((route) => record.modelIds.includes(String(asObject(route.model_info).id)));
      assert.equal(tenantRoutes.length, managedProviderModels.openai.length, "Pinned LiteLLM must hold each tenant's complete approved model set");
      assert.ok(tenantRoutes.every((route) => {
        const groups = asObject(route.model_info).access_groups;
        const alias = route.model_name;
        return typeof alias === "string" && Array.isArray(groups) && groups.includes(tenantManagedModelAccessGroup(tenantId, alias));
      }), "Every tenant model route must be restricted to its generated access group");
    }
    const alphaBedrockRoutes = routes.filter((route) => alphaBedrockRecord.modelIds.includes(String(asObject(route.model_info).id)));
    assert.equal(alphaBedrockRoutes.length, managedProviderModels.bedrock.length, "Pinned LiteLLM must hold the tenant Bedrock route");
    assert.equal(alphaBedrockRoutes[0]!.model_name, alphaBedrockGroup);
    assert.deepEqual(asObject(alphaBedrockRoutes[0]!.model_info).access_groups, [alphaBedrockGroup]);

    const alphaVirtualKey = await issueScopedKey(alphaGroup, "alpha");
    const betaVirtualKey = await issueScopedKey(betaGroup, "beta");
    const alphaBedrockVirtualKey = await issueScopedKey(alphaBedrockGroup, "bedrock-alpha");
    assert.equal((await modelCall(alphaVirtualKey, alphaGroup)).response.ok, true, "An alpha scoped virtual key must reach alpha dynamic model route");
    assert.equal((await modelCall(betaVirtualKey, betaGroup)).response.ok, true, "A beta scoped virtual key must reach beta dynamic model route");
    assert.equal((await modelCall(alphaVirtualKey, betaGroup)).response.ok, false, "An alpha scoped key must not address beta tenant route");
    assert.equal((await modelCall(alphaVirtualKey, betaRecord.modelIds[0]!)).response.ok, false, "An alpha scoped key must not address beta internal model identifier");
    assert.equal((await modelCall(alphaBedrockVirtualKey, alphaBedrockGroup)).response.ok, true, "A Bedrock scoped virtual key must reach only its tenant Bedrock route");
    assert.equal((await modelCall(alphaVirtualKey, alphaBedrockGroup)).response.ok, false, "An OpenAI scoped key must not reach the Bedrock route");
    assert.equal((await modelCall(alphaBedrockVirtualKey, alphaGroup)).response.ok, false, "A Bedrock scoped key must not reach an OpenAI route");

    const beforeRejectedRotation = processSignature();
    const rejected = await configure(alphaTenant, rejectedKey, "alpha-rejected-rotation");
    assert.equal(rejected.statusCode, 422, "A rejected candidate key must fail through Control with a safe credential error");
    assert.equal(stringified(rejected.payload).includes(rejectedKey), false, "A rejected key must not be reflected by Control");
    assert.equal(processSignature(), beforeRejectedRotation, "Rejected rotation must not restart the pinned LiteLLM process");
    const alphaAfterRejectedRotation = await providerSettingsStore.getProviderSetting(alphaTenant, "openai");
    assert.deepEqual(alphaAfterRejectedRotation?.modelIds, alphaRecord.modelIds, "Rejected rotation must preserve the prior active route metadata");
    assert.equal((await modelCall(alphaVirtualKey, alphaGroup)).response.ok, true, "Rejected rotation must preserve the prior working scoped route");

    const beforeAcceptedRotation = processSignature();
    const acceptedRotation = await configure(alphaTenant, alphaRotatedKey, "alpha-accepted-rotation");
    assert.equal(acceptedRotation.statusCode, 200, "A valid replacement key must rotate an active provider route through Control");
    assert.equal(stringified(acceptedRotation.payload).includes(alphaRotatedKey), false, "A rotated key must not be reflected by Control");
    assert.equal(processSignature(), beforeAcceptedRotation, "Accepted rotation must not restart the pinned LiteLLM process");
    const alphaAfterAcceptedRotation = await providerSettingsStore.getProviderSetting(alphaTenant, "openai");
    assert.deepEqual(alphaAfterAcceptedRotation?.modelIds, alphaRecord.modelIds, "Accepted rotation must preserve the tenant's stable public model identifiers");
    assert.equal((await modelCall(alphaVirtualKey, alphaGroup)).response.ok, true, "Accepted rotation must preserve the existing scoped virtual key route");

    const disabled = await control.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/openai/disable",
      headers: headersFor(alphaTenant, "alpha-disable"),
    });
    assert.equal(disabled.statusCode, 200, "Control must disable an active provider route without restart");
    assert.equal((await modelCall(alphaVirtualKey, alphaGroup)).response.ok, false, "A disabled provider must fail the old scoped virtual key closed");
    assert.equal((await modelCall(betaVirtualKey, betaGroup)).response.ok, true, "Disabling alpha must not affect beta's isolated provider route");

    const alphaReconfigured = await configure(alphaTenant, alphaReconfiguredKey, "alpha-reconfigure");
    assert.equal(alphaReconfigured.statusCode, 200, "Control must reconfigure a disabled provider route without restart");
    const alphaReconfiguredVirtualKey = await issueScopedKey(alphaGroup, "alpha-reconfigured");
    assert.equal((await modelCall(alphaReconfiguredVirtualKey, alphaGroup)).response.ok, true, "A reconfigured provider must issue a working scoped route");
    const deleted = await control.inject({
      method: "DELETE",
      url: "/v1/admin/provider-settings/openai",
      headers: headersFor(alphaTenant, "alpha-delete"),
    });
    assert.equal(deleted.statusCode, 200, "Control must delete an active provider route without restart");
    assert.equal((await modelCall(alphaReconfiguredVirtualKey, alphaGroup)).response.ok, false, "A deleted provider must fail the scoped virtual key closed");

    const beforeRejectedBedrockRotation = processSignature();
    const rejectedBedrock = await configureBedrock(alphaTenant, rejectedBedrockKey, "bedrock-alpha-rejected-rotation");
    assert.equal(rejectedBedrock.statusCode, 401, "A rejected Bedrock candidate key must fail through Control with a safe API-key error");
    assert.equal(asObject(rejectedBedrock.payload.error).code, "BEDROCK_API_KEY_INVALID");
    assert.equal(stringified(rejectedBedrock.payload).includes(rejectedBedrockKey), false, "A rejected Bedrock key must not be reflected by Control");
    assert.equal(processSignature(), beforeRejectedBedrockRotation, "Rejected Bedrock rotation must not restart the pinned LiteLLM process");
    const alphaBedrockAfterRejectedRotation = await providerSettingsStore.getProviderSetting(alphaTenant, "bedrock");
    assert.deepEqual(alphaBedrockAfterRejectedRotation?.modelIds, alphaBedrockRecord.modelIds, "Rejected Bedrock rotation must preserve the prior active route metadata");
    assert.deepEqual(alphaBedrockAfterRejectedRotation?.configuration, alphaBedrockRecord.configuration, "Rejected Bedrock rotation must preserve its approved selection");
    assert.equal((await modelCall(alphaBedrockVirtualKey, alphaBedrockGroup)).response.ok, true, "Rejected Bedrock rotation must preserve the prior scoped route");

    const beforeAcceptedBedrockRotation = processSignature();
    const acceptedBedrockRotation = await configureBedrock(alphaTenant, bedrockRotatedKey, "bedrock-alpha-accepted-rotation");
    assert.equal(acceptedBedrockRotation.statusCode, 200, "A valid Bedrock replacement key must rotate the active route through Control");
    assert.equal(stringified(acceptedBedrockRotation.payload).includes(bedrockRotatedKey), false, "A rotated Bedrock key must not be reflected by Control");
    assert.equal(processSignature(), beforeAcceptedBedrockRotation, "Accepted Bedrock rotation must not restart the pinned LiteLLM process");
    const alphaBedrockAfterAcceptedRotation = await providerSettingsStore.getProviderSetting(alphaTenant, "bedrock");
    assert.deepEqual(alphaBedrockAfterAcceptedRotation?.modelIds, alphaBedrockRecord.modelIds, "Accepted Bedrock rotation must preserve stable model identifiers");
    assert.deepEqual(alphaBedrockAfterAcceptedRotation?.configuration, bedrockSelection, "Accepted Bedrock rotation must preserve the approved selection");
    assert.equal((await modelCall(alphaBedrockVirtualKey, alphaBedrockGroup)).response.ok, true, "Accepted Bedrock rotation must preserve the scoped virtual key route");

    const bedrockDisabled = await control.inject({
      method: "POST",
      url: "/v1/admin/provider-settings/bedrock/disable",
      headers: headersFor(alphaTenant, "bedrock-alpha-disable"),
    });
    assert.equal(bedrockDisabled.statusCode, 200, "Control must disable an active Bedrock route without restart");
    assert.equal((await modelCall(alphaBedrockVirtualKey, alphaBedrockGroup)).response.ok, false, "A disabled Bedrock provider must fail the old scoped virtual key closed");
    assert.equal((await modelCall(betaVirtualKey, betaGroup)).response.ok, true, "Disabling Bedrock must not affect another tenant provider route");

    const alphaBedrockReconfigured = await configureBedrock(alphaTenant, bedrockReconfiguredKey, "bedrock-alpha-reconfigure");
    assert.equal(alphaBedrockReconfigured.statusCode, 200, "Control must reconfigure a disabled Bedrock provider route without restart");
    const alphaBedrockReconfiguredVirtualKey = await issueScopedKey(alphaBedrockGroup, "bedrock-alpha-reconfigured");
    assert.equal((await modelCall(alphaBedrockReconfiguredVirtualKey, alphaBedrockGroup)).response.ok, true, "A reconfigured Bedrock provider must issue a working scoped route");
    const bedrockDeleted = await control.inject({
      method: "DELETE",
      url: "/v1/admin/provider-settings/bedrock",
      headers: headersFor(alphaTenant, "bedrock-alpha-delete"),
    });
    assert.equal(bedrockDeleted.statusCode, 200, "Control must delete an active Bedrock route without restart");
    assert.equal((await modelCall(alphaBedrockReconfiguredVirtualKey, alphaBedrockGroup)).response.ok, false, "A deleted Bedrock provider must fail the scoped virtual key closed");

    const reads = [
      alphaConfigured.payload,
      betaConfigured.payload,
      alphaTested.json(),
      alphaBedrockConfigured.payload,
      alphaBedrockTested.json(),
      alphaBedrockRecord,
      rejected.payload,
      acceptedRotation.payload,
      disabled.json(),
      alphaReconfigured.payload,
      deleted.json(),
      rejectedBedrock.payload,
      alphaBedrockAfterRejectedRotation,
      acceptedBedrockRotation.payload,
      alphaBedrockAfterAcceptedRotation,
      bedrockDisabled.json(),
      alphaBedrockReconfigured.payload,
      bedrockDeleted.json(),
      await providerRead(alphaTenant),
      await providerRead(betaTenant),
      await providerSettingsStore.listProviderSettings(alphaTenant),
      await providerSettingsStore.listProviderSettings(betaTenant),
      modelInfo.payload,
    ];
    const litellmLogs = compose(["logs", "--no-color"]);
    const litellmDump = compose(["exec", "-T", "litellm-postgres", "pg_dump", "-U", "litellm", "--data-only", "--inserts", "litellm"]);
    const providerProbeDump = compose(["exec", "-T", "provider-probe-postgres", "pg_dump", "-U", "litellm", "--data-only", "--inserts", "litellm"]);
    const controlDump = compose(["exec", "-T", "control-postgres", "pg_dump", "-U", "lemmacomputer", "--data-only", "--inserts", "lemmacomputer"]);
    for (const sentinel of sentinels) {
      assert.equal(stringified(reads).includes(sentinel), false, "Control reads or safe provider metadata exposed a submitted API key");
      assert.equal(litellmLogs.includes(sentinel), false, "Pinned LiteLLM logs exposed a submitted API key");
      assert.equal(litellmDump.includes(sentinel), false, "Pinned LiteLLM PostgreSQL data exposed a submitted API key in plaintext");
      assert.equal(providerProbeDump.includes(sentinel), false, "Callback-enabled provider-probe PostgreSQL exposed a submitted API key in plaintext");
      assert.equal(controlDump.includes(sentinel), false, "Control PostgreSQL metadata exposed a submitted API key");
    }
    const counters = await json(`http://127.0.0.1:${fixturePort}/counters`, { method: "GET" });
    assert.ok(Number(counters.payload.model) >= 6, "Pinned LiteLLM must route lifecycle probes and scoped calls to the local provider fixture");
    assert.ok(Number(counters.payload.bedrockModel) >= 8, "Pinned LiteLLM must route the Bedrock lifecycle to the local Bedrock runtime fixture");
    process.stdout.write("Pinned LiteLLM Provider Settings qualification passed.\n");
  } finally {
    await control.close().catch(() => undefined);
    await providerSettingsStore.close().catch(() => undefined);
    if (attempted) {
      try {
        compose(["down", "--volumes", "--remove-orphans"]);
      } catch {
        process.stderr.write("Provider Settings qualification teardown failed for its isolated Compose project.\n");
      }
    }
  }
};

await main();
