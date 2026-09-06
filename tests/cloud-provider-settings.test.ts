import assert from "node:assert/strict";
import test from "node:test";
import { providerSettingMetadataSchema } from "@lemmacomputer/contracts";
import { LiteLLMProviderAdministration, managedProviderDeploymentDescriptors, tenantManagedModelAccessGroup } from "@lemmacomputer/litellm-adapter";

const foundry = { endpoint: "https://example-resource.openai.azure.com/openai/v1/", deployments: { "gpt-4.1": "company-gpt" } };
const vertex = { projectId: "example-project", location: "global" as const };
const serviceAccountJson = JSON.stringify({ type: "service_account", project_id: "example-project", client_email: "model-access@example-project.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nfixture-not-real\n-----END PRIVATE KEY-----", token_uri: "https://oauth2.googleapis.com/token" });
const mockGateway = (rejectModel?: string) => {
  const requests: Array<{ path: string; body: any }> = [];
  const gateway = new LiteLLMProviderAdministration({ adminUrl: "https://private-gateway.invalid", masterKey: "fixture-master", credentialSecret: "fixture-fingerprint-secret", adminFetch: async (url, options) => {
    const path = new URL(String(url)).pathname;
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    requests.push({ path, body });
    if (path.endsWith("/update")) return new Response("{}", { status: 404 });
    if (path === "/model/info") return Response.json({ data: [] });
    if (path === "/model/new") return Response.json({ model_info: { id: body.model_info.id } });
    if (path === "/chat/completions" && rejectModel && body.model.includes(rejectModel)) return Response.json({ error: "rejected fixture secret" }, { status: 401 });
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  } });
  return { gateway, requests };
};

test("Foundry deploys to the Azure v1 endpoint with a separate base model and tenant-scoped credential", async () => {
  const { gateway, requests } = mockGateway();
  const route = await gateway.configureManagedProvider({ tenantId: "alpha", provider: "foundry", apiKey: "azure-fixture-secret", modelIds: ["gpt-4.1"], foundry, existingModelIds: [] });
  const models = requests.filter((r) => r.path === "/model/new");
  assert.equal(models.length, 2);
  for (const { body } of models) {
    assert.equal(body.litellm_params.model, "openai/company-gpt");
    assert.equal(body.litellm_params.api_base, foundry.endpoint);
    assert.equal(body.model_info.lemmacomputer_base_model, "foundry/gpt-4.1");
    assert.equal(JSON.stringify(body).includes("azure-fixture-secret"), false);
    assert.ok(body.litellm_params.litellm_credential_name);
  }
  assert.equal(route.deployments[0]?.providerModel, "foundry/gpt-4.1");
  assert.notEqual(route.deployments[0]?.accessGroup, tenantManagedModelAccessGroup("beta", "lemmacomputer-foundry-gpt-4-1"));
  assert.equal(JSON.stringify(route).includes("azure-fixture-secret"), false);
  await gateway.testManagedProvider({ tenantId: "alpha", provider: "foundry", existingModelIds: route.modelIds, configuration: route.configuration });
  await gateway.deleteManagedProvider({ tenantId: "alpha", provider: "foundry", existingModelIds: route.modelIds, configuration: route.configuration });
});

test("Vertex credentials go only to encrypted credential intake, with project/location on the model", async () => {
  const { gateway, requests } = mockGateway();
  const route = await gateway.configureManagedProvider({ tenantId: "alpha", provider: "vertex", apiKey: serviceAccountJson, modelIds: ["gemini-2.5-flash", "gemini-2.5-pro"], vertex, existingModelIds: [] });
  assert.equal(route.deployments.length, 2);
  assert.equal(route.deployments[0]?.region, "global");
  for (const request of requests) {
    if (request.path === "/credentials") {
      assert.deepEqual(request.body.credential_values, { vertex_credentials: serviceAccountJson });
    } else assert.equal(JSON.stringify(request.body).includes("fixture-not-real"), false);
  }
  const model = requests.find((r) => r.path === "/model/new")!.body;
  assert.equal(model.litellm_params.model, "vertex_ai/gemini-2.5-flash");
  assert.equal(model.litellm_params.vertex_project, "example-project");
  assert.equal(model.litellm_params.vertex_location, "global");
  assert.equal(requests.filter((r) => r.path === "/chat/completions" && r.body.model.includes("candidate")).length, 2);
  const beta = managedProviderDeploymentDescriptors("beta", "vertex", route.configuration);
  assert.notEqual(beta[0]?.providerAccountId, route.deployments[0]?.providerAccountId);
});

test("cloud metadata rejects arbitrary destinations, incomplete selections, and persisted credentials", () => {
  const valid = { modelIds: ["gpt-4.1"], foundry };
  assert.equal(providerSettingMetadataSchema.safeParse(valid).success, true);
  for (const endpoint of ["http://localhost/openai/v1/", "https://example-resource.openai.azure.com.evil.test/openai/v1/", "https://user:secret@example-resource.openai.azure.com/openai/v1/", "https://example-resource.openai.azure.com/models"]) {
    assert.equal(providerSettingMetadataSchema.safeParse({ ...valid, foundry: { ...foundry, endpoint } }).success, false);
  }
  for (const invalid of [{ ...valid, apiKey: "secret" }, { ...valid, modelIds: ["gemini-2.5-pro"] }, { ...valid, foundry: { ...foundry, deployments: {} } }, { ...valid, vertex }, { modelIds: ["gemini-2.5-pro"], vertex: { ...vertex, credentials: "secret" } }]) {
    assert.equal(providerSettingMetadataSchema.safeParse(invalid).success, false);
  }
});

test("Vertex rejects files, ambient auth, executable federation, and attacker token endpoints before gateway calls", async () => {
  for (const apiKey of ["/tmp/key.json", "{}", JSON.stringify({ type: "external_account", credential_source: { executable: { command: "evil" } } }), serviceAccountJson.replace("https://oauth2.googleapis.com/token", "https://evil.test/token")]) {
    const { gateway, requests } = mockGateway();
    await assert.rejects(gateway.configureManagedProvider({ tenantId: "alpha", provider: "vertex", apiKey, vertex, modelIds: ["gemini-2.5-flash"], existingModelIds: [] }), { code: "PROVIDER_CREDENTIAL_REJECTED" });
    assert.equal(requests.length, 0);
  }
});

test("a rejected second cloud model never replaces a working credential or publishes candidate routes", async () => {
  const { gateway, requests } = mockGateway("gemini-2-5-pro");
  await assert.rejects(gateway.configureManagedProvider({ tenantId: "alpha", provider: "vertex", apiKey: serviceAccountJson, vertex, modelIds: ["gemini-2.5-flash", "gemini-2.5-pro"], existingModelIds: [] }));
  assert.equal(requests.filter((r) => r.path === "/credentials").length, 1);
  assert.equal(requests.filter((r) => r.path === "/model/new").every((r) => r.body.model_info.access_groups.length === 0), true);
  assert.equal(requests.filter((r) => r.path === "/model/delete").length, 2);
});

test("cloud target changes receive new deployment identities and cannot inherit old rate cards", () => {
  const original = managedProviderDeploymentDescriptors("alpha", "foundry", { modelIds: ["gpt-4.1"], foundry })[0]!;
  const changed = managedProviderDeploymentDescriptors("alpha", "foundry", { modelIds: ["gpt-4.1"], foundry: { ...foundry, deployments: { "gpt-4.1": "replacement" } } })[0]!;
  assert.notEqual(changed.providerDeployment, original.providerDeployment);
  const google = managedProviderDeploymentDescriptors("alpha", "vertex", { modelIds: ["gemini-2.5-flash"], vertex })[0]!;
  const changedProject = managedProviderDeploymentDescriptors("alpha", "vertex", { modelIds: ["gemini-2.5-flash"], vertex: { ...vertex, projectId: "other-project" } })[0]!;
  assert.notEqual(google.providerDeployment, changedProject.providerDeployment);
});
