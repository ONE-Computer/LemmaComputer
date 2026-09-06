import assert from "node:assert/strict";
import test from "node:test";
import { dynamicProviderModelIdSchema, providerSettingMetadataSchema, type ProviderModelCatalog } from "@lemmacomputer/contracts";
import { managedProviderDeploymentDescriptors, managedProviderModelAlias, tenantManagedModelAccessGroup, managedProviderAliasForAccessGroup, type ProviderAdministrationGateway } from "@lemmacomputer/litellm-adapter";
import { MemoryProviderSettingsStore } from "@lemmacomputer/workspace-store";
import { ProviderSettingsService } from "../apps/control-api/src/provider-settings.js";

test("dynamic model IDs preserve versioned provider identities and reject credential or URL syntax", () => {
  for (const id of ["gpt-5.6-sol", "claude-sonnet-5", "deepseek-ai/deepseek-v4-maas", "claude-opus-5@20260901", "global.anthropic.claude-opus-5-v1:0"]) assert.equal(dynamicProviderModelIdSchema.safeParse(id).success, true);
  for (const id of ["https://attacker.test", "../key.json", "/etc/key.json", "__proto__", "x//y", "a".repeat(181)]) {
    assert.equal(dynamicProviderModelIdSchema.safeParse(id).success, false, id);
  }
  assert.notEqual(managedProviderModelAlias("vertex", "deepseek-ai/a.b"), managedProviderModelAlias("vertex", "deepseek-ai/a-b"));
  const alias = managedProviderModelAlias("vertex", "deepseek-ai/a.b");
  const scoped = tenantManagedModelAccessGroup("tenant-a", alias);
  assert.equal(managedProviderAliasForAccessGroup("tenant-a", scoped), alias);
  assert.equal(managedProviderAliasForAccessGroup("tenant-b", scoped), null);
});

test("dynamic selections project exact cloud transport and tenant targets without an allowlist", () => {
  const foundry = providerSettingMetadataSchema.parse({ modelIds: ["claude-opus-5"], foundry: {
    endpoint: "https://company-resource.services.ai.azure.com/openai/v1/", deployments: { "claude-opus-5": "company-claude" }, protocols: { "claude-opus-5": "anthropic" },
  } });
  const azure = managedProviderDeploymentDescriptors("tenant-a", "foundry", foundry)[0]!;
  assert.equal(azure.providerModel, "foundry/claude-opus-5");
  assert.match(azure.providerDeployment, /^ocp-/);
  const google = providerSettingMetadataSchema.parse({ modelIds: ["claude-sonnet-5", "deepseek-ai/deepseek-v4-maas"], vertex: { projectId: "example-project", location: "us-east5" } });
  assert.equal(managedProviderDeploymentDescriptors("tenant-a", "vertex", google).length, 2);
  assert.equal(managedProviderDeploymentDescriptors("tenant-a", "vertex", google)[1]!.providerModel, "vertex_ai/deepseek-ai/deepseek-v4-maas");
  const bedrock = providerSettingMetadataSchema.parse({ modelIds: ["us.anthropic.claude-opus-5-v1:0"], region: "us-east-2" });
  assert.equal(managedProviderDeploymentDescriptors("tenant-a", "bedrock", bedrock)[0]!.providerModel, "bedrock/converse/us.anthropic.claude-opus-5-v1:0");
});

test("catalog refresh is tenant and connection scoped, preserves selections, and does not persist preview credentials", async () => {
  const store = new MemoryProviderSettingsStore();
  const persisted: unknown[] = [];
  const saveCatalog = store.saveModelCatalog.bind(store);
  store.saveModelCatalog = async (...args) => { persisted.push(args); return saveCatalog(...args); };
  const calls: any[] = [];
  const catalog: ProviderModelCatalog = { models: [{ id: "future-model", displayName: "Future model", source: "litellm", capabilities: {} }], source: "litellm", fetchedAt: new Date().toISOString() };
  const gateway = { discoverModels: async (input: any) => { calls.push(input); return catalog; } } as unknown as ProviderAdministrationGateway;
  const service = new ProviderSettingsService(store, gateway);
  await service.catalog({ tenantId: "alpha" }, "openai");
  await service.catalog({ tenantId: "alpha" }, "openai");
  assert.equal(calls.length, 1);
  await service.catalog({ tenantId: "beta" }, "openai");
  assert.equal(calls.length, 2);
  await service.catalog({ tenantId: "alpha" }, "openai", { refresh: true });
  assert.equal(calls.length, 3);
  await service.catalog({ tenantId: "alpha" }, "openai", { apiKey: "preview-secret" });
  assert.equal(calls.at(-1).apiKey, "preview-secret");
  assert.equal(persisted.length, 3, "preview credentials must bypass persisted catalog caching");
  assert.equal((await store.listProviderSettings("alpha")).length, 0);
  assert.equal(JSON.stringify(persisted).includes("preview-secret"), false);
});
