import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import { LiteLLMProviderAdministration, managedProviderAliasForAccessGroup, managedProviderModelOptions, tenantManagedModelAccessGroup } from "@lemmacomputer/litellm-adapter";

const alphaKey = "sk-provider-alpha-never-log-000000000001";
const betaKey = "sk-provider-beta-never-log-000000000002";
const anthropicKey = "sk-provider-anthropic-never-log-000000003";
const glmKey = "sk-provider-glm-never-log-00000000000004";
const rotatedKey = "sk-provider-alpha-rotated-never-log-000003";
const rejectedKey = "sk-provider-rejected-never-log-000000003";

type GatewayRequest = {
  method: string;
  url: string;
  authorization: string;
  body: Record<string, unknown>;
};

const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => (
  server.close((error) => error ? reject(error) : resolve())
));

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
};

const gatewayFor = (port: number) => new LiteLLMProviderAdministration({
  adminUrl: "http://127.0.0.1:" + port,
  masterKey: "sk-provider-admin-key-never-exposed-00001",
  credentialSecret: "provider-fingerprint-secret-never-exposed-00001",
});

const modelDocument = (request: GatewayRequest) => request.body as {
  model_name: string;
  litellm_params: Record<string, unknown>;
  model_info: Record<string, unknown>;
};

test("all selectable provider models declare their routing capabilities", () => {
  assert.deepEqual(managedProviderModelOptions("anthropic").map((model) => model.modelCapabilities), [
    { vision: true, tools: true, streaming: true },
    { vision: true, tools: true, streaming: true },
  ]);
  assert.deepEqual(managedProviderModelOptions("glm").map((model) => model.modelCapabilities), [
    { vision: false, tools: true, streaming: true },
    { vision: false, tools: true, streaming: true },
  ]);
});

test("managed provider configuration isolates tenants, validates candidates, and rejects stale static routes", async () => {
  const requests: GatewayRequest[] = [];
  let rejectCandidate = false;
  let staticOpenAi = false;
  let semanticCredentialPatchFailure = true;
  let stableModelUpdatesExist = false;
  const server = createServer(async (request, response) => {
    const item: GatewayRequest = {
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: String(request.headers.authorization ?? ""),
      body: await readBody(request),
    };
    requests.push(item);
    response.setHeader("content-type", "application/json");

    if (item.method === "GET" && item.url === "/model/info") {
      response.end(JSON.stringify({
        data: staticOpenAi ? [{ model_name: "lemmacomputer-assistant", model_info: {} }] : [],
      }));
      return;
    }
    if (item.method === "PATCH" && item.url.startsWith("/credentials/")) {
      if (semanticCredentialPatchFailure) {
        response.end(JSON.stringify({
          message: "Credential record was not found",
          type: "internal_server_error",
          param: null,
          openai_code: 404,
          code: "404",
        }));
        return;
      }
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "PATCH" && /^\/model\/[^/]+\/update$/.test(item.url)) {
      response.statusCode = stableModelUpdatesExist ? 200 : 404;
      response.end(JSON.stringify(stableModelUpdatesExist ? { success: true } : {}));
      return;
    }
    if (item.method === "POST" && item.url === "/credentials") {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "DELETE" && item.url.startsWith("/credentials/")) {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "POST" && item.url === "/model/new") {
      response.end(JSON.stringify({ model_info: { id: (item.body.model_info as Record<string, unknown>).id } }));
      return;
    }
    if (item.method === "POST" && ["/model/delete", "/key/generate", "/key/delete"].includes(item.url)) {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "POST" && ["/chat/completions", "/responses"].includes(item.url)) {
      if (rejectCandidate) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { message: "provider rejected " + rejectedKey } }));
        return;
      }
      response.end(JSON.stringify(item.url === "/responses"
        ? { id: "resp-provider-probe", status: "completed", output: [] }
        : { choices: [{ message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: "Unexpected route" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const gateway = gatewayFor(address.port);

  try {
    const alpha = await gateway.configureManagedProvider({
      tenantId: "tenant-alpha",
      provider: "openai",
      apiKey: alphaKey,
      modelId: "gpt-5.6-sol",
      existingModelIds: [],
    });
    const beta = await gateway.configureManagedProvider({
      tenantId: "tenant-beta",
      provider: "openai",
      apiKey: betaKey,
      modelId: "gpt-5.6-terra",
      existingModelIds: [],
    });
    const anthropic = await gateway.configureManagedProvider({
      tenantId: "tenant-anthropic",
      provider: "anthropic",
      apiKey: anthropicKey,
      modelId: "claude-opus-4-8",
      existingModelIds: [],
    });
    const glm = await gateway.configureManagedProvider({
      tenantId: "tenant-glm",
      provider: "glm",
      apiKey: glmKey,
      modelId: "glm-5.2",
      existingModelIds: [],
    });

    assert.equal(alpha.modelIds.length, 3);
    assert.equal(beta.modelIds.length, 3);
    assert.notDeepEqual(alpha.modelIds, beta.modelIds);
    assert.notEqual(alpha.credentialFingerprint, beta.credentialFingerprint);
    assert.deepEqual(anthropic.configuration, { modelId: "claude-opus-4-8" });
    assert.deepEqual(glm.configuration, { modelId: "glm-5.2" });

    const stableModels = requests
      .filter((request) => request.url === "/model/new")
      .map(modelDocument)
      .filter((document) => Array.isArray(document.model_info.access_groups) && document.model_info.access_groups.length > 0);
    assert.equal(stableModels.length, 10);
    assert.equal(stableModels.filter((document) => document.litellm_params.model === "openai/gpt-5.6-sol").length, 3);
    assert.equal(stableModels.filter((document) => document.litellm_params.model === "openai/gpt-5.6-terra").length, 3);
    assert.equal(stableModels.filter((document) => document.litellm_params.model === "anthropic/claude-opus-4-8").length, 2);
    assert.equal(stableModels.filter((document) => document.litellm_params.model === "zai/glm-5.2").length, 2);
    for (const document of stableModels) {
      assert.match(document.model_name, /^ocp-[A-Za-z0-9_-]+-/);
      assert.equal("api_key" in document.litellm_params, false);
      assert.match(String(document.litellm_params.litellm_credential_name), /^lemmacomputer-provider-/);
      const groups = document.model_info.access_groups as unknown[];
      assert.equal(groups.length, 1);
      assert.match(String(groups[0]), /^ocp-[A-Za-z0-9_-]+-/);
      assert.equal(document.model_name, groups[0]);
      assert.equal(document.model_info.lemmacomputer_deployment_id, groups[0]);
    }
    const assistantRoutes = stableModels.filter((document) => String(document.model_name).endsWith("-lemmacomputer-assistant"));
    assert.equal(assistantRoutes.length, 2);
    assert.notEqual(assistantRoutes[0]!.model_info.id, assistantRoutes[1]!.model_info.id);
    assert.notEqual(
      (assistantRoutes[0]!.model_info.access_groups as unknown[])[0],
      (assistantRoutes[1]!.model_info.access_groups as unknown[])[0],
    );

    const credentials = requests.filter((request) => request.url === "/credentials");
    assert.ok(credentials.some((request) => (request.body.credential_values as Record<string, unknown>).api_key === alphaKey));
    assert.ok(credentials.some((request) => (request.body.credential_values as Record<string, unknown>).api_key === betaKey));
    assert.equal(requests.filter((request) => request.method === "PATCH" && request.url.startsWith("/credentials/")).length, 0, "First-use provider setup must create its stable credential instead of PATCHing a missing record");
    assert.equal(credentials.filter((request) => !String(request.body.credential_name).includes("-candidate-")).length, 4, "First-use provider setup must create one stable credential per tenant");
    const grants = requests.filter((request) => request.url === "/key/generate");
    assert.equal(grants.length, 8);
    for (const grant of grants) {
      assert.match(String((grant.body.models as unknown[])[0]), /^(?:ocp-|lemmacomputer-)/);
      assert.match(grant.authorization, /^Bearer sk-provider-admin-/);
      assert.equal(
        (grant.body.metadata as Record<string, unknown>).lemmacomputer_non_billable_exemption,
        "provider-route-test-v1",
      );
      assert.ok(["openai", "anthropic", "glm"].includes(String(
        (grant.body.metadata as Record<string, unknown>).lemmacomputer_provider,
      )));
      assert.equal(
        (grant.body.metadata as Record<string, unknown>).lemmacomputer_deployment_id,
        (grant.body.models as unknown[])[0],
      );
    }
    const stableProbes = requests.filter((request) => /^ocp-[A-Za-z0-9_-]+-lemmacomputer-(?:assistant|claude|glm)$/.test(String(request.body.model)));
    assert.equal(stableProbes.length, 4);
    for (const probe of stableProbes) assert.match(probe.authorization, /^Bearer sk-ocp-/);
    const openAiProbes = requests.filter((request) => request.url === "/responses");
    assert.equal(openAiProbes.length, 4);
    assert.ok(openAiProbes.every((probe) => typeof probe.body.input === "string" && !("messages" in probe.body)));
    const chatProbes = requests.filter((request) => request.url === "/chat/completions");
    assert.equal(chatProbes.length, 4);
    assert.ok(chatProbes.every((probe) => Array.isArray(probe.body.messages) && !("input" in probe.body)));
    for (const probe of [...openAiProbes, ...chatProbes]) {
      assert.equal("temperature" in probe.body, false, "Provider probes must use the model's default temperature");
    }
    for (const request of requests.filter((request) => !request.url.startsWith("/credentials"))) {
      assert.equal(JSON.stringify(request.body).includes(alphaKey), false);
      assert.equal(JSON.stringify(request.body).includes(betaKey), false);
      assert.equal(JSON.stringify(request.body).includes(anthropicKey), false);
      assert.equal(JSON.stringify(request.body).includes(glmKey), false);
    }

    const candidateStart = requests.length;
    rejectCandidate = true;
    await assert.rejects(
      gateway.configureManagedProvider({
        tenantId: "tenant-rejected",
        provider: "anthropic",
        apiKey: rejectedKey,
        modelId: "claude-sonnet-4-6",
        existingModelIds: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof LemmaComputerError);
        assert.equal(error.code, "PROVIDER_CREDENTIAL_REJECTED");
        assert.equal(error.message.includes(rejectedKey), false);
        return true;
      },
    );
    const candidateRequests = requests.slice(candidateStart);
    const candidateStableRoutes = candidateRequests
      .filter((request) => request.url === "/model/new")
      .map(modelDocument)
      .filter((document) => Array.isArray(document.model_info.access_groups) && document.model_info.access_groups.length > 0);
    assert.equal(candidateStableRoutes.length, 0);
    for (const request of candidateRequests.filter((request) => !request.url.startsWith("/credentials"))) {
      assert.equal(JSON.stringify(request.body).includes(rejectedKey), false);
    }

    rejectCandidate = false;
    const rotationStart = requests.length;
    await assert.rejects(
      gateway.configureManagedProvider({
        tenantId: "tenant-alpha",
        provider: "openai",
        apiKey: rotatedKey,
        modelId: "gpt-5.6-sol",
        existingModelIds: alpha.modelIds,
      }),
      (error: unknown) => {
        assert.ok(error instanceof LemmaComputerError);
        assert.equal(error.code, "PROVIDER_ROUTE_FAILED");
        assert.equal(error.message.includes(rotatedKey), false);
        return true;
      },
    );
    const rotationRequests = requests.slice(rotationStart);
    assert.equal(rotationRequests.filter((request) => request.method === "PATCH" && request.url.startsWith("/credentials/")).length, 1, "Rotation must attempt a single stable credential PATCH");
    assert.equal(rotationRequests.filter((request) => request.url === "/credentials" && !String(request.body.credential_name).includes("-candidate-")).length, 0, "A semantically failed stable credential PATCH must fail closed instead of creating a replacement route");
    assert.equal(rotationRequests.filter((request) => request.url === "/model/new").map(modelDocument).filter((document) => Array.isArray(document.model_info.access_groups) && document.model_info.access_groups.length > 0).length, 0, "A semantically failed stable credential PATCH must not alter stable model routes");

    semanticCredentialPatchFailure = false;
    stableModelUpdatesExist = true;
    const switchStart = requests.length;
    const switched = await gateway.configureManagedProvider({
      tenantId: "tenant-alpha",
      provider: "openai",
      apiKey: rotatedKey,
      modelId: "gpt-5.6-luna",
      existingModelIds: alpha.modelIds,
      configuration: alpha.configuration,
    });
    assert.deepEqual(switched.configuration, { modelId: "gpt-5.6-luna" });
    const switchRequests = requests.slice(switchStart);
    const stableUpdates = switchRequests
      .filter((request) => request.method === "PATCH" && request.url.startsWith("/model/"))
      .map(modelDocument);
    assert.equal(stableUpdates.length, 3);
    assert.ok(stableUpdates.every((document) => document.litellm_params.model === "openai/gpt-5.6-luna"));

    const modelSetStart = requests.length;
    const modelSet = await gateway.configureManagedProvider({
      tenantId: "tenant-alpha",
      provider: "openai",
      apiKey: rotatedKey,
      modelIds: ["gpt-5.6-luna", "gpt-5.6-sol"],
      existingModelIds: switched.modelIds,
      configuration: switched.configuration,
    });
    assert.deepEqual(modelSet.configuration, { modelIds: ["gpt-5.6-luna", "gpt-5.6-sol"] });
    assert.equal(modelSet.modelIds.length, 5);
    assert.deepEqual(modelSet.deployments.map((deployment) => deployment.modelId), [
      "gpt-5.6-luna",
      "gpt-5.6-sol",
    ]);
    assert.equal(modelSet.deployments[0]!.primary, true);
    assert.ok(modelSet.deployments[0]!.aliases.includes("lemmacomputer-assistant"));
    assert.match(modelSet.deployments[0]!.providerDeployment, /^ocp-/);
    assert.deepEqual(modelSet.deployments[1]!.modelCapabilities, {
      vision: true,
      tools: true,
      streaming: true,
    });
    assert.equal(
      managedProviderAliasForAccessGroup("tenant-alpha", modelSet.deployments[0]!.providerDeployment),
      "lemmacomputer-openai-gpt-5-6-luna",
    );
    assert.equal(managedProviderAliasForAccessGroup("tenant-beta", modelSet.deployments[0]!.providerDeployment), null);
    assert.notEqual(modelSet.deployments[0]!.id, modelSet.deployments[1]!.id);
    const modelSetUpdates = requests.slice(modelSetStart)
      .filter((request) => request.method === "PATCH" && request.url.startsWith("/model/"))
      .map(modelDocument);
    assert.equal(modelSetUpdates.length, 5);
    assert.equal(modelSetUpdates.filter((document) => document.model_info.lemmacomputer_legacy_alias === false).length, 2);
    assert.deepEqual(
      modelSetUpdates
        .filter((document) => document.model_info.lemmacomputer_legacy_alias === false)
        .map((document) => document.model_info.lemmacomputer_upstream_model_id),
      ["gpt-5.6-luna", "gpt-5.6-sol"],
    );
    assert.ok(modelSetUpdates
      .filter((document) => document.model_info.lemmacomputer_legacy_alias === false)
      .every((document) => document.model_info.supports_function_calling === true));

    const retireStart = requests.length;
    const retired = await gateway.configureManagedProvider({
      tenantId: "tenant-alpha",
      provider: "openai",
      apiKey: rotatedKey,
      modelIds: ["gpt-5.6-terra"],
      existingModelIds: modelSet.modelIds,
      configuration: modelSet.configuration,
    });
    assert.equal(retired.modelIds.length, 4);
    assert.deepEqual(retired.configuration, { modelIds: ["gpt-5.6-terra"] });
    assert.deepEqual(retired.deployments.map((deployment) => deployment.modelId), ["gpt-5.6-terra"]);
    const deletedModelIds = requests.slice(retireStart)
      .filter((request) => request.url === "/model/delete")
      .map((request) => request.body.id);
    assert.deepEqual(
      new Set(deletedModelIds.filter((id) => modelSet.modelIds.includes(String(id)))),
      new Set(modelSet.modelIds.filter((id) => !retired.modelIds.includes(id))),
    );
    assert.ok(stableUpdates.every((document) => Array.isArray(document.model_info.access_groups) && document.model_info.access_groups.length === 1));
    assert.ok(switchRequests.filter((request) => request.url === "/responses")
      .every((request) => !Object.hasOwn(request.body, "max_output_tokens")));
    assert.ok(switchRequests.filter((request) => request.url === "/key/generate")
      .every((request) => !Object.hasOwn(request.body, "tpm_limit")));

    staticOpenAi = true;
    const staticStart = requests.length;
    await assert.rejects(
      gateway.configureManagedProvider({
        tenantId: "tenant-static",
        provider: "openai",
        apiKey: alphaKey,
        modelId: "gpt-5.6-luna",
        existingModelIds: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof LemmaComputerError);
        assert.equal(error.code, "PROVIDER_STATIC_CUTOVER_REQUIRED");
        return true;
      },
    );
    assert.deepEqual(requests.slice(staticStart).map((request) => request.url), ["/model/info"]);
  } finally {
    await close(server);
  }
});

test("Bedrock managed provider routes are tenant-scoped, write-only, and reject replacement before stable cutover", async () => {
  const requests: GatewayRequest[] = [];
  let rejectCandidate = false;
  const server = createServer(async (request, response) => {
    const item: GatewayRequest = {
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: String(request.headers.authorization ?? ""),
      body: await readBody(request),
    };
    requests.push(item);
    response.setHeader("content-type", "application/json");

    if (item.method === "GET" && item.url === "/model/info") {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    if (item.method === "PATCH" && item.url.startsWith("/model/")) {
      response.statusCode = 404;
      response.end(JSON.stringify({}));
      return;
    }
    if (item.method === "PATCH" && item.url.startsWith("/credentials/")) {
      response.statusCode = 404;
      response.end(JSON.stringify({}));
      return;
    }
    if (item.method === "POST" && item.url === "/credentials") {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "DELETE" && item.url.startsWith("/credentials/")) {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "POST" && item.url === "/model/new") {
      response.end(JSON.stringify({ model_info: { id: (item.body.model_info as Record<string, unknown>).id } }));
      return;
    }
    if (item.method === "POST" && ["/model/delete", "/key/generate", "/key/delete"].includes(item.url)) {
      response.end(JSON.stringify({ success: true }));
      return;
    }
    if (item.method === "POST" && item.url === "/chat/completions") {
      if (rejectCandidate && item.authorization.includes("sk-ocp-")) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { message: "Authentication failed for " + rejectedKey } }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: "Unexpected route" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const gateway = gatewayFor(address.port);
  const selection = { region: "ap-southeast-1" as const, modelProfileId: "claude-sonnet-4-5-global" as const };

  try {
    const route = await gateway.configureManagedProvider({
      tenantId: "tenant-bedrock",
      provider: "bedrock",
      apiKey: alphaKey,
      ...selection,
      existingModelIds: [],
    });
    assert.equal(route.modelIds.length, 1);
    assert.deepEqual(route.configuration, selection);

    const stableModel = requests
      .filter((request) => request.url === "/model/new")
      .map(modelDocument)
      .find((document) => String(document.model_name).endsWith("-lemmacomputer-bedrock") && (document.model_info.access_groups as unknown[]).length > 0);
    assert.ok(stableModel);
    assert.equal(stableModel.litellm_params.model, "bedrock/converse/global.anthropic.claude-sonnet-4-5-20250929-v1:0");
    assert.equal(stableModel.litellm_params.aws_region_name, selection.region);
    assert.equal(stableModel.litellm_params.timeout, 60);
    assert.equal(stableModel.litellm_params.max_retries, 2);
    for (const key of ["api_key", "aws_access_key_id", "aws_secret_access_key", "aws_session_token", "aws_role_name"]) {
      assert.equal(key in stableModel.litellm_params, false);
    }
    assert.deepEqual(stableModel.model_info.access_groups, [tenantManagedModelAccessGroup("tenant-bedrock", "lemmacomputer-bedrock")]);
    assert.equal(stableModel.model_info.supports_vision, true);
    assert.equal(stableModel.model_info.supports_function_calling, true);
    assert.equal(stableModel.model_info.supports_response_schema, true);
    assert.equal(stableModel.model_info.supports_streaming, true);

    const stableCredential = requests
      .filter((request) => request.method === "POST" && request.url === "/credentials")
      .find((request) => !String(request.body.credential_name).includes("-candidate-"));
    assert.ok(stableCredential);
    assert.deepEqual(stableCredential.body.credential_info, {
      provider: "bedrock",
      managed_by: "lemmacomputer",
      route_alias: "lemmacomputer-bedrock",
      region: selection.region,
      model_profile_id: selection.modelProfileId,
    });
    assert.deepEqual(stableCredential.body.credential_values, { api_key: alphaKey });
    for (const request of requests.filter((request) => !request.url.startsWith("/credentials"))) {
      assert.equal((JSON.stringify(request.body) + request.authorization).includes(alphaKey), false);
    }

    await gateway.testManagedProvider({
      tenantId: "tenant-bedrock",
      provider: "bedrock",
      existingModelIds: route.modelIds,
    });

    const rotationStart = requests.length;
    rejectCandidate = true;
    await assert.rejects(
      gateway.configureManagedProvider({
        tenantId: "tenant-bedrock",
        provider: "bedrock",
        apiKey: rejectedKey,
        ...selection,
        existingModelIds: route.modelIds,
      }),
      (error: unknown) => {
        assert.ok(error instanceof LemmaComputerError);
        assert.equal(error.code, "BEDROCK_API_KEY_INVALID");
        assert.equal(error.message.includes(rejectedKey), false);
        return true;
      },
    );
    const rejectedRotation = requests.slice(rotationStart);
    assert.equal(rejectedRotation.filter((request) => request.method === "PATCH" && request.url.startsWith("/credentials/")).length, 0);
    assert.equal(rejectedRotation
      .filter((request) => request.url === "/model/new")
      .map(modelDocument)
      .filter((document) => Array.isArray(document.model_info.access_groups) && document.model_info.access_groups.length > 0).length, 0);
    for (const request of rejectedRotation.filter((request) => !request.url.startsWith("/credentials"))) {
      assert.equal((JSON.stringify(request.body) + request.authorization).includes(rejectedKey), false);
    }

    rejectCandidate = false;
    const deleteStart = requests.length;
    await gateway.deleteManagedProvider({
      tenantId: "tenant-bedrock",
      provider: "bedrock",
      existingModelIds: route.modelIds,
    });
    const deleted = requests.slice(deleteStart);
    assert.ok(deleted.some((request) => request.url === "/model/delete" && request.body.id === route.modelIds[0]));
    assert.ok(deleted.some((request) => request.method === "DELETE" && request.url.startsWith("/credentials/") && !request.url.includes("-candidate-")));
  } finally {
    await close(server);
  }
});
