import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  approvedBedrockApiKeyModelProfiles,
  bedrockApiKeyModelProfileIdSchema,
  bedrockApiKeyRegionSchema,
  bedrockApiKeyRouteAlias,
  OneComputerError,
  type AnthropicProviderModelId,
  type BedrockApiKeyModelProfile,
  type BedrockApiKeyModelProfileId,
  type BedrockApiKeyRegion,
  type GlmProviderModelId,
  type OpenAiProviderModelId,
  type ProviderModelId,
  type ProviderSettingMetadata,
} from "@onecomputer/contracts";

export const managedProviderNames = ["openai", "anthropic", "glm", "bedrock"] as const;
export type ManagedProviderName = typeof managedProviderNames[number];
type SelectableProviderName = Exclude<ManagedProviderName, "bedrock">;
export type ManagedProviderOperation = {
  tenantId: string;
  provider: ManagedProviderName;
  existingModelIds: string[];
  configuration?: ProviderSettingMetadata;
};
type DirectProviderSelection<T extends ProviderModelId> =
  | { modelId: T; modelIds?: never }
  | { modelId?: never; modelIds: T[] };
export type ManagedProviderConfiguration =
  | (ManagedProviderOperation & { provider: "openai"; apiKey: string } & DirectProviderSelection<OpenAiProviderModelId>)
  | (ManagedProviderOperation & { provider: "anthropic"; apiKey: string } & DirectProviderSelection<AnthropicProviderModelId>)
  | (ManagedProviderOperation & { provider: "glm"; apiKey: string } & DirectProviderSelection<GlmProviderModelId>)
  | (ManagedProviderOperation & { provider: "bedrock"; apiKey: string; region: BedrockApiKeyRegion; modelProfileId: BedrockApiKeyModelProfileId });
export type ManagedProviderModelCapabilities = {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
};
export type ManagedProviderDeploymentDescriptor = {
  id: string;
  provider: ManagedProviderName;
  providerAccountId: string;
  modelId: ProviderModelId | null;
  displayName: string;
  aliases: string[];
  providerModel: string;
  providerDeployment: string;
  region: BedrockApiKeyRegion | null;
  providerServiceTier: "standard";
  accessGroup: string;
  primary: boolean;
  legacyAlias: boolean;
  vision: boolean;
  modelCapabilities?: ManagedProviderModelCapabilities;
};
export type ManagedProviderRoute = {
  modelIds: string[];
  deployments: ManagedProviderDeploymentDescriptor[];
  credentialFingerprint: string;
  configuration: ProviderSettingMetadata;
};
export interface ProviderAdministrationGateway {
  configureManagedProvider(input: ManagedProviderConfiguration): Promise<ManagedProviderRoute>;
  testManagedProvider(input: ManagedProviderOperation): Promise<void>;
  deleteManagedProvider(input: ManagedProviderOperation): Promise<void>;
}

export type ManagedProviderModel = {
  alias: string;
  model: string;
  vision: boolean;
  modelCapabilities?: ManagedProviderModelCapabilities;
  bedrock?: { region: BedrockApiKeyRegion; profile: BedrockApiKeyModelProfile };
};

export type ManagedProviderDisplayMetadata = {
  primaryAlias: string;
  upstreamModelDisplayName: string;
};

type ProviderModelProfile = {
  id: ProviderModelId;
  displayName: string;
  model: string;
  vision: boolean;
  modelCapabilities?: ManagedProviderModelCapabilities;
};

const toolCapableVisionModelCapabilities: ManagedProviderModelCapabilities = Object.freeze({
  vision: true,
  tools: true,
  streaming: true,
});

const toolCapableTextModelCapabilities: ManagedProviderModelCapabilities = Object.freeze({
  vision: false,
  tools: true,
  streaming: true,
});

export const managedProviderModelProfiles = Object.freeze({
  openai: Object.freeze([
    { id: "gpt-5.6-sol", displayName: "OpenAI GPT-5.6 Sol", model: "openai/gpt-5.6-sol", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
    { id: "gpt-5.6-terra", displayName: "OpenAI GPT-5.6 Terra", model: "openai/gpt-5.6-terra", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
    { id: "gpt-5.6-luna", displayName: "OpenAI GPT-5.6 Luna", model: "openai/gpt-5.6-luna", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
  ]),
  anthropic: Object.freeze([
    { id: "claude-sonnet-4-6", displayName: "Anthropic Claude Sonnet 4.6", model: "anthropic/claude-sonnet-4-6", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
    { id: "claude-opus-4-8", displayName: "Anthropic Claude Opus 4.8", model: "anthropic/claude-opus-4-8", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
  ]),
  glm: Object.freeze([
    { id: "glm-5", displayName: "Z.ai GLM-5", model: "zai/glm-5", vision: false, modelCapabilities: toolCapableTextModelCapabilities },
    { id: "glm-5.2", displayName: "Z.ai GLM-5.2", model: "zai/glm-5.2", vision: false, modelCapabilities: toolCapableTextModelCapabilities },
  ]),
} satisfies Record<SelectableProviderName, ReadonlyArray<ProviderModelProfile>>) as Readonly<Record<SelectableProviderName, ReadonlyArray<ProviderModelProfile>>>;

export const defaultManagedProviderModelIds = Object.freeze({
  openai: "gpt-5.6-luna",
  anthropic: "claude-sonnet-4-6",
  glm: "glm-5",
} satisfies Record<SelectableProviderName, ProviderModelId>);

export const managedProviderModelOptions = (provider: SelectableProviderName) =>
  managedProviderModelProfiles[provider].map(({ id, displayName, modelCapabilities }) => ({
    id,
    displayName,
    ...(modelCapabilities ? { modelCapabilities } : {}),
  }));

export const managedProviderModel = (provider: SelectableProviderName, modelId: unknown) =>
  managedProviderModelProfiles[provider].find((candidate) => candidate.id === modelId) ?? null;

export const managedProviderDisplayMetadata: Record<ManagedProviderName, ManagedProviderDisplayMetadata> = {
  openai: {
    primaryAlias: "onecomputer-openai",
    upstreamModelDisplayName: managedProviderModel("openai", defaultManagedProviderModelIds.openai)!.displayName,
  },
  anthropic: {
    primaryAlias: "onecomputer-claude",
    upstreamModelDisplayName: managedProviderModel("anthropic", defaultManagedProviderModelIds.anthropic)!.displayName,
  },
  glm: {
    primaryAlias: "onecomputer-glm",
    upstreamModelDisplayName: managedProviderModel("glm", defaultManagedProviderModelIds.glm)!.displayName,
  },
  bedrock: {
    primaryAlias: bedrockApiKeyRouteAlias,
    upstreamModelDisplayName: "Amazon Bedrock Claude Sonnet 4.5",
  },
};

export const managedProviderModels: Record<ManagedProviderName, readonly ManagedProviderModel[]> = {
  openai: [
    { alias: "onecomputer-assistant", model: "openai/gpt-5.6-luna", vision: true },
    { alias: "onecomputer-openai", model: "openai/gpt-5.6-luna", vision: true },
    { alias: "claude-opus-4-6", model: "openai/gpt-5.6-luna", vision: true },
  ],
  anthropic: [
    { alias: "onecomputer-claude", model: "anthropic/claude-sonnet-4-6", vision: true },
    { alias: "claude-sonnet-4-6", model: "anthropic/claude-sonnet-4-6", vision: true },
  ],
  glm: [
    { alias: "onecomputer-glm", model: "zai/glm-5", vision: false },
    { alias: "claude-sonnet-4-5", model: "zai/glm-5", vision: false },
  ],
  bedrock: [
    { alias: bedrockApiKeyRouteAlias, model: approvedBedrockApiKeyModelProfiles[0]!.litellmModel, vision: true },
  ],
};

export const managedProviderModelAlias = (provider: SelectableProviderName, modelId: ProviderModelId) =>
  `onecomputer-${provider}-${modelId.replaceAll(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;

export const managedProviderForAlias = (alias: string) => managedProviderNames.find((provider) => {
  if (managedProviderModels[provider].some((model) => model.alias === alias)) return true;
  if (provider === "bedrock") return false;
  return managedProviderModelProfiles[provider].some((profile) => managedProviderModelAlias(provider, profile.id) === alias);
});

const tenantRouteHash = (tenantId: string) => createHash("sha256")
  .update(`onecomputer:provider-route:${tenantId}`)
  .digest("base64url")
  .slice(0, 18);

export const tenantManagedModelAccessGroup = (tenantId: string, alias: string) => {
  if (!managedProviderForAlias(alias)) return alias;
  return `ocp-${tenantRouteHash(tenantId)}-${alias}`;
};

const managedProviderAliases = [
  ...managedProviderNames.flatMap((provider) => managedProviderModels[provider].map(({ alias }) => alias)),
  ...(["openai", "anthropic", "glm"] as const).flatMap((provider) =>
    managedProviderModelProfiles[provider].map(({ id }) => managedProviderModelAlias(provider, id)),
  ),
];

export const managedProviderAliasForAccessGroup = (tenantId: string, accessGroup: string) =>
  managedProviderAliases.find((alias) => tenantManagedModelAccessGroup(tenantId, alias) === accessGroup) ?? null;

const tenantCredentialName = (tenantId: string, provider: ManagedProviderName) => `onecomputer-provider-${tenantRouteHash(tenantId)}-${provider}`;
const tenantModelId = (tenantId: string, provider: ManagedProviderName, alias: string) => `onecomputer-provider-${tenantRouteHash(tenantId)}-${provider}-${alias}`;

export type LiteLLMProviderAdministrationConfig = { adminUrl: string; masterKey: string; credentialSecret: string; requestTimeoutMs?: number; bedrockRuntimeEndpoint?: string };
type JsonObject = Record<string, unknown>;

type ProviderModelTemplate = {
  alias: string;
  model: ManagedProviderModel;
  upstreamModelId: ProviderModelId | null;
  displayName: string;
  primary: boolean;
  legacyAlias: boolean;
};

export const managedProviderSelectedModelIds = (
  provider: SelectableProviderName,
  configuration: ProviderSettingMetadata = {},
): ProviderModelId[] => {
  const requested = configuration.modelIds
    ?? (configuration.modelId ? [configuration.modelId] : [defaultManagedProviderModelIds[provider]]);
  const requestedSet = new Set(requested);
  const selected = managedProviderModelProfiles[provider].filter((profile) => requestedSet.has(profile.id));
  if (selected.length !== requested.length || selected.length !== requestedSet.size || selected.length === 0) {
    throw new OneComputerError("PROVIDER_MODEL_UNAPPROVED", "The selected provider models are not approved", 400);
  }
  return selected.map((profile) => profile.id);
};

const templatesFor = (
  provider: ManagedProviderName,
  configuration: ProviderSettingMetadata,
): ProviderModelTemplate[] => {
  if (provider === "bedrock") {
    const profile = approvedBedrockApiKeyModelProfiles.find((candidate) => (
      candidate.id === configuration.modelProfileId
      && configuration.region
      && candidate.regions.includes(configuration.region)
    ));
    if (!profile || !configuration.region) return [];
    return [{
      alias: bedrockApiKeyRouteAlias,
      model: {
        alias: bedrockApiKeyRouteAlias,
        model: profile.litellmModel,
        vision: profile.capabilities.vision,
        modelCapabilities: {
          vision: profile.capabilities.vision,
          tools: profile.capabilities.toolCalls,
          streaming: profile.capabilities.streaming,
        },
        bedrock: { region: configuration.region, profile },
      },
      upstreamModelId: null,
      displayName: "Amazon Bedrock Claude Sonnet 4.5",
      primary: true,
      legacyAlias: true,
    }];
  }
  const selectedIds = managedProviderSelectedModelIds(provider, configuration);
  const profiles = selectedIds.map((id) => managedProviderModel(provider, id)!);
  const primary = profiles[0]!;
  const legacy = managedProviderModels[provider].map((model) => ({
    alias: model.alias,
    model: { ...model, model: primary.model, vision: primary.vision, modelCapabilities: primary.modelCapabilities },
    upstreamModelId: primary.id,
    displayName: primary.displayName,
    primary: true,
    legacyAlias: true,
  }));
  if (!configuration.modelIds) return legacy;
  return [
    ...legacy,
    ...profiles.map((profile) => {
      const alias = managedProviderModelAlias(provider, profile.id);
      return {
        alias,
        model: { alias, model: profile.model, vision: profile.vision, modelCapabilities: profile.modelCapabilities },
        upstreamModelId: profile.id,
        displayName: profile.displayName,
        primary: profile.id === primary.id,
        legacyAlias: false,
      };
    }),
  ];
};

export const managedProviderDeploymentDescriptors = (
  tenantId: string,
  provider: ManagedProviderName,
  configuration: ProviderSettingMetadata,
): ManagedProviderDeploymentDescriptor[] => {
  const accountId = tenantCredentialName(tenantId, provider);
  const templates = templatesFor(provider, configuration);
  const concrete = configuration.modelIds
    ? templates.filter((template) => !template.legacyAlias)
    : [templates.find((template) => template.alias === managedProviderDisplayMetadata[provider].primaryAlias) ?? templates[0]]
      .filter((template): template is ProviderModelTemplate => Boolean(template));
  return concrete.map((template) => {
    const accessGroup = tenantManagedModelAccessGroup(tenantId, template.alias);
    const compatibilityAliases = template.primary
      ? templates.filter((candidate) => candidate.legacyAlias).map((candidate) => candidate.alias)
      : [];
    return {
      id: tenantModelId(tenantId, provider, template.alias),
      provider,
      providerAccountId: accountId,
      modelId: template.upstreamModelId,
      displayName: template.displayName,
      aliases: [...new Set([template.alias, ...compatibilityAliases])],
      providerModel: template.model.model,
      providerDeployment: accessGroup,
      region: template.model.bedrock?.region ?? null,
      providerServiceTier: "standard",
      accessGroup,
      primary: template.primary,
      legacyAlias: template.legacyAlias,
      vision: template.model.vision,
      ...(template.model.modelCapabilities ? { modelCapabilities: template.model.modelCapabilities } : {}),
    };
  });
};
type GatewayResult = { ok: boolean; status: number; payload: unknown; embeddedError: boolean };
const asObject = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
type ProviderModelDeployment = {
  id: string;
  provider: ManagedProviderName;
  alias: string;
  model: ManagedProviderModel;
  upstreamModelId: ProviderModelId | null;
  primary: boolean;
  legacyAlias: boolean;
  credentialName: string;
  accessGroups: string[];
};

export class LiteLLMProviderAdministration implements ProviderAdministrationGateway {
  private readonly adminUrl: string;
  private readonly masterKey: string;
  private readonly credentialSecret: string;
  private readonly timeoutMs: number;
  private readonly bedrockRuntimeEndpoint: string | undefined;

  constructor(config: LiteLLMProviderAdministrationConfig) {
    this.adminUrl = config.adminUrl.replace(/\/$/, "");
    this.masterKey = config.masterKey;
    this.credentialSecret = config.credentialSecret;
    this.timeoutMs = config.requestTimeoutMs ?? 15_000;
    this.bedrockRuntimeEndpoint = config.bedrockRuntimeEndpoint?.replace(/[/]$/, "");
  }

  async configureManagedProvider(input: ManagedProviderConfiguration): Promise<ManagedProviderRoute> {
    const apiKey = input.apiKey.trim();
    if (!apiKey) throw new OneComputerError("PROVIDER_KEY_REQUIRED", "A provider API key is required", 400);
    const configuration = this.configurationFor(input);
    const models = templatesFor(input.provider, configuration);
    if (models.length === 0) {
      throw new OneComputerError("PROVIDER_MODEL_UNAPPROVED", "The selected provider models are not approved", 400);
    }
    const descriptors = managedProviderDeploymentDescriptors(input.tenantId, input.provider, configuration);
    const credentialName = tenantCredentialName(input.tenantId, input.provider);
    const deploymentFor = (template: ProviderModelTemplate, candidate = false): ProviderModelDeployment => {
      const suffix = candidate ? `-candidate-${randomBytes(8).toString("hex")}` : "";
      const alias = candidate
        ? `${tenantManagedModelAccessGroup(input.tenantId, template.alias)}${suffix}`
        : template.alias;
      return {
        id: `${tenantModelId(input.tenantId, input.provider, template.alias)}${suffix}`,
        provider: input.provider,
        alias,
        model: template.model,
        upstreamModelId: template.upstreamModelId,
        primary: template.primary,
        legacyAlias: template.legacyAlias,
        credentialName: candidate
          ? `${credentialName}-candidate`
          : credentialName,
        accessGroups: candidate ? [] : [tenantManagedModelAccessGroup(input.tenantId, template.alias)],
      };
    };
    const targetDeployments = models.map((model) => deploymentFor(model));
    const targetIds = targetDeployments.map((deployment) => deployment.id);
    const targetIdSet = new Set(targetIds);
    const existing = [...new Set(input.existingModelIds)];
    const previousConfiguration = input.configuration ?? configuration;
    const previousModels = existing.length ? templatesFor(input.provider, previousConfiguration) : [];
    const previousDeployments = previousModels.map((model) => deploymentFor(model));
    const previousIds = previousDeployments.map((deployment) => deployment.id);
    const previousIdSet = new Set(previousIds);
    if (existing.length !== input.existingModelIds.length || (
      existing.length > 0
      && (existing.length !== previousIds.length || existing.some((id) => !previousIdSet.has(id)))
    )) {
      throw new OneComputerError("PROVIDER_ROUTE_INTEGRITY_FAILED", "The existing provider route cannot be safely changed", 409);
    }

    await this.ensureRetiringAliasesAreGone(input.provider);
    const candidateCredentialName = `${credentialName}-candidate-${randomBytes(12).toString("hex")}`;
    const candidates: Array<{ id: string; alias: string }> = [];
    try {
      await this.createCredential(candidateCredentialName, input, apiKey);
      for (const model of models) {
        const deployment = deploymentFor(model, true);
        deployment.credentialName = candidateCredentialName;
        candidates.push({ id: await this.createModel(deployment), alias: deployment.alias });
      }
      await this.probe(candidates[0]!.alias, undefined, input.provider);

      if (existing.length > 0) {
        await this.replaceCredential(credentialName, input, apiKey);
        try {
          for (const deployment of targetDeployments) {
            const updated = await this.upsertModel(deployment);
            if (updated.id !== deployment.id) {
              throw new OneComputerError("PROVIDER_ROUTE_INTEGRITY_FAILED", "The provider route identity changed unexpectedly", 409);
            }
          }
          const primary = targetDeployments[0]!;
          await this.probe(primary.alias, primary.accessGroups[0], input.provider);
          for (const retiredId of existing.filter((id) => !targetIdSet.has(id))) {
            await this.deleteModel(retiredId, input.provider);
          }
        } catch (error) {
          for (const previous of previousDeployments) {
            await this.upsertModel(previous).catch(() => undefined);
          }
          for (const addedId of targetIds.filter((id) => !previousIdSet.has(id))) {
            await this.deleteModel(addedId, input.provider).catch(() => undefined);
          }
          throw error;
        }
        return {
          modelIds: targetIds,
          deployments: descriptors,
          credentialFingerprint: this.fingerprint(apiKey),
          configuration,
        };
      }

      let stableCredentialCreated = false;
      const createdModelIds: string[] = [];
      try {
        await this.createCredential(credentialName, input, apiKey);
        stableCredentialCreated = true;
        for (const deployment of targetDeployments) {
          const updated = await this.upsertModel(deployment);
          if (updated.id !== deployment.id) {
            throw new OneComputerError("PROVIDER_ROUTE_INTEGRITY_FAILED", "The provider route identity changed unexpectedly", 409);
          }
          if (updated.created) createdModelIds.push(updated.id);
        }
        const primary = targetDeployments[0]!;
        await this.probe(primary.alias, primary.accessGroups[0], input.provider);
        return {
          modelIds: targetIds,
          deployments: descriptors,
          credentialFingerprint: this.fingerprint(apiKey),
          configuration,
        };
      } catch (error) {
        await Promise.all(createdModelIds.map((id) => this.deleteModel(id, input.provider).catch(() => undefined)));
        if (stableCredentialCreated) await this.deleteCredential(credentialName, input.provider).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof OneComputerError) throw error;
      throw new OneComputerError("PROVIDER_CONFIGURATION_FAILED", "The provider configuration could not be validated", 502, true);
    } finally {
      await Promise.all(candidates.map(({ id }) => this.deleteModel(id, input.provider).catch(() => undefined)));
      await this.deleteCredential(candidateCredentialName, input.provider).catch(() => undefined);
    }
  }

  async testManagedProvider(input: ManagedProviderOperation) {
    const configuration = input.configuration ?? (input.provider === "bedrock"
      ? {
        region: approvedBedrockApiKeyModelProfiles[0]!.regions[0],
        modelProfileId: approvedBedrockApiKeyModelProfiles[0]!.id,
      }
      : {});
    const models = templatesFor(input.provider, configuration);
    const model = models[0];
    const expectedIds = models.map((item) => tenantModelId(input.tenantId, input.provider, item.alias));
    if (!model || input.existingModelIds.length !== expectedIds.length
      || input.existingModelIds.some((id) => !expectedIds.includes(id))) {
      throw new OneComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 409);
    }
    await this.ensureRetiringAliasesAreGone(input.provider);
    await this.probe(model.alias, tenantManagedModelAccessGroup(input.tenantId, model.alias), input.provider);
  }

  async deleteManagedProvider(input: ManagedProviderOperation) {
    await this.ensureRetiringAliasesAreGone(input.provider);
    for (const id of [...new Set(input.existingModelIds)]) await this.deleteModel(id);
    await this.deleteCredential(tenantCredentialName(input.tenantId, input.provider));
  }

  private configurationFor(input: ManagedProviderConfiguration): ProviderSettingMetadata {
    if (input.provider !== "bedrock") {
      if (input.modelIds) {
        return { modelIds: managedProviderSelectedModelIds(input.provider, { modelIds: input.modelIds }) };
      }
      const selected = managedProviderSelectedModelIds(input.provider, { modelId: input.modelId });
      return { modelId: selected[0]! };
    }
    const region = bedrockApiKeyRegionSchema.safeParse(input.region);
    const modelProfileId = bedrockApiKeyModelProfileIdSchema.safeParse(input.modelProfileId);
    if (!region.success || !modelProfileId.success) {
      throw new OneComputerError("BEDROCK_ROUTE_UNAPPROVED", "The selected Bedrock region or inference profile is not approved", 400);
    }
    const profile = approvedBedrockApiKeyModelProfiles.find((candidate) => candidate.id === modelProfileId.data);
    if (!profile || !profile.regions.includes(region.data)) {
      throw new OneComputerError("BEDROCK_ROUTE_UNAPPROVED", "The selected Bedrock region or inference profile is not approved", 400);
    }
    return { region: region.data, modelProfileId: modelProfileId.data };
  }

  private async createModel(deployment: ProviderModelDeployment) {
    const result = await this.call("/model/new", { method: "POST", body: this.modelDocument(deployment) });
    if (!result.ok) throw this.providerFailure(result.status, "route", deployment.provider, result.payload);
    const id = this.modelId(result.payload);
    if (!id) throw new OneComputerError("PROVIDER_ROUTE_FAILED", "The model gateway did not confirm a provider route", 502, true);
    return id;
  }

  private async upsertModel(deployment: ProviderModelDeployment) {
    const updated = await this.call(`/model/${encodeURIComponent(deployment.id)}/update`, { method: "PATCH", body: this.modelDocument(deployment) });
    if (updated.ok) return { id: deployment.id, created: false };
    if (updated.status !== 404 || updated.embeddedError) throw this.providerFailure(updated.status, "route", deployment.provider, updated.payload);
    return { id: await this.createModel(deployment), created: true };
  }

  private async probe(model: string, accessGroup: string | undefined, provider: ManagedProviderName) {
    const credential = `sk-ocp-${randomBytes(24).toString("base64url")}`;
    try {
      const grant = await this.call("/key/generate", {
        method: "POST",
        body: {
          key: credential,
          key_alias: `onecomputer-provider-probe-${randomBytes(12).toString("hex")}`,
          key_type: "llm_api",
          duration: "60s",
          models: [accessGroup ?? model],
          rpm_limit: 2,
          max_parallel_requests: 1,
          metadata: {
            onecomputer_purpose: "provider-route-test",
            onecomputer_non_billable_exemption: "provider-route-test-v1",
          },
        },
      });
      if (!grant.ok) throw this.providerFailure(grant.status, "route", provider, grant.payload);
      const result = await this.call("/chat/completions", {
        method: "POST",
        credential,
        body: {
          model,
          messages: [{ role: "user", content: "Reply with OK." }],
        },
      });
      if (!result.ok) throw this.providerFailure(result.status, "credential", provider, result.payload);
    } finally {
      await this.call("/key/delete", { method: "POST", body: { keys: [credential] } }).catch(() => undefined);
    }
  }

  private async ensureRetiringAliasesAreGone(provider: ManagedProviderName) {
    const result = await this.call("/model/info", { method: "GET" });
    if (!result.ok) throw this.providerFailure(result.status, "route", provider, result.payload);
    const routes = Array.isArray(asObject(result.payload).data) ? asObject(result.payload).data as unknown[] : [];
    const aliases = new Set(managedProviderModels[provider].map((model) => model.alias));
    const retiring = routes.some((route) => {
      const deployment = asObject(route);
      const alias = deployment.model_name;
      const info = asObject(deployment.model_info);
      return typeof alias === "string" && aliases.has(alias)
        && !(typeof info.id === "string" && info.id.startsWith("onecomputer-provider-") && Array.isArray(info.access_groups) && info.access_groups.length > 0 && info.access_groups.every((group) => typeof group === "string" && group.startsWith("ocp-")));
    });
    if (retiring) throw new OneComputerError("PROVIDER_STATIC_CUTOVER_REQUIRED", "Restart the installation with retired provider routes removed before configuring this provider", 409);
  }

  private async createCredential(name: string, input: ManagedProviderConfiguration, apiKey: string) {
    const result = await this.call("/credentials", { method: "POST", body: this.credentialDocument(name, input, apiKey) });
    if (!result.ok) throw this.providerFailure(result.status, "route", input.provider, result.payload);
  }

  private async replaceCredential(name: string, input: ManagedProviderConfiguration, apiKey: string) {
    const result = await this.call(`/credentials/${encodeURIComponent(name)}`, { method: "PATCH", body: this.credentialDocument(name, input, apiKey) });
    if (result.ok) return false;
    if (result.status !== 404 || result.embeddedError) throw this.providerFailure(result.status, "route", input.provider, result.payload);
    await this.createCredential(name, input, apiKey);
    return true;
  }

  private async deleteCredential(name: string, provider?: ManagedProviderName) {
    const result = await this.call(`/credentials/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!result.ok && result.status !== 404) throw this.providerFailure(result.status, "route", provider, result.payload);
  }

  private credentialDocument(name: string, input: ManagedProviderConfiguration, apiKey: string): JsonObject {
    const bedrock = input.provider === "bedrock"
      ? { route_alias: bedrockApiKeyRouteAlias, region: input.region, model_profile_id: input.modelProfileId }
      : {};
    return {
      credential_name: name,
      credential_info: { provider: input.provider, managed_by: "onecomputer", ...bedrock },
      credential_values: { api_key: apiKey },
    };
  }

  private async deleteModel(id: string, provider?: ManagedProviderName) {
    const result = await this.call("/model/delete", { method: "POST", body: { id } });
    if (!result.ok && result.status !== 404) throw this.providerFailure(result.status, "route", provider, result.payload);
  }

  private modelDocument(deployment: ProviderModelDeployment): JsonObject {
    const bedrock = deployment.model.bedrock;
    return {
      model_name: deployment.alias,
      litellm_params: {
        model: deployment.model.model,
        litellm_credential_name: deployment.credentialName,
        ...(bedrock ? {
          aws_region_name: bedrock.region,
          timeout: 60,
          max_retries: 2,
          ...(this.bedrockRuntimeEndpoint ? { aws_bedrock_runtime_endpoint: this.bedrockRuntimeEndpoint } : {}),
        } : {}),
      },
      model_info: {
        id: deployment.id,
        onecomputer_provider: deployment.provider,
        onecomputer_provider_account_id: deployment.credentialName,
        onecomputer_base_model: deployment.model.model,
        onecomputer_deployment_id: deployment.accessGroups[0],
        onecomputer_provider_service_tier: "standard",
        ...(bedrock ? { onecomputer_region: bedrock.region } : {}),
        ...(deployment.upstreamModelId ? { onecomputer_upstream_model_id: deployment.upstreamModelId } : {}),
        onecomputer_primary_deployment: deployment.primary,
        onecomputer_legacy_alias: deployment.legacyAlias,
        supports_vision: deployment.model.vision,
        ...(deployment.model.modelCapabilities ? {
          supports_function_calling: deployment.model.modelCapabilities.tools,
          supports_streaming: deployment.model.modelCapabilities.streaming,
        } : {}),
        ...(bedrock ? {
          supports_function_calling: bedrock.profile.capabilities.toolCalls,
          supports_response_schema: bedrock.profile.capabilities.structuredOutput,
          supports_streaming: bedrock.profile.capabilities.streaming,
          max_input_tokens: bedrock.profile.limits.contextWindowTokens,
          max_output_tokens: bedrock.profile.limits.maxOutputTokens,
          input_cost_per_token: bedrock.profile.pricing.inputUsdPerMillionTokens / 1_000_000,
          output_cost_per_token: bedrock.profile.pricing.outputUsdPerMillionTokens / 1_000_000,
        } : {}),
        access_groups: deployment.accessGroups,
      },
    };
  }

  private modelId(payload: unknown) {
    const value = payload && typeof payload === "object" ? payload as JsonObject : {};
    const modelInfo = value.model_info && typeof value.model_info === "object" ? value.model_info as JsonObject : {};
    const data = value.data && typeof value.data === "object" ? value.data as JsonObject : {};
    const id = modelInfo.id ?? value.id ?? data.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  private fingerprint(apiKey: string) {
    const digest = createHmac("sha256", this.credentialSecret)
      .update(`onecomputer:provider-fingerprint:${apiKey}`)
      .digest("base64url")
      .slice(0, 20);
    return `fp_${digest}`;
  }

  private async call(path: string, input: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: JsonObject; credential?: string }): Promise<GatewayResult> {
    try {
      const response = await fetch(`${this.adminUrl}${path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.credential ?? this.masterKey}`,
          "content-type": "application/json",
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      // LiteLLM v1.93.0's credential update endpoint can encode a not-found
      // error as a JSON OpenAI error document while retaining HTTP 200. Treat
      // its embedded numeric status as authoritative, rather than treating a
      // semantically failed administration request as successful.
      const embeddedStatus = response.ok ? this.embeddedErrorStatus(payload) : undefined;
      return {
        ok: response.ok && embeddedStatus === undefined,
        status: embeddedStatus ?? response.status,
        payload,
        embeddedError: embeddedStatus !== undefined,
      };
    } catch {
      throw new OneComputerError("PROVIDER_GATEWAY_UNAVAILABLE", "The provider gateway is unavailable", 503, true);
    }
  }

  private embeddedErrorStatus(payload: unknown) {
    const document = asObject(payload);
    for (const candidate of [document.openai_code, document.status_code, document.code]) {
      const value = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
      if (Number.isInteger(value) && value >= 400 && value < 600) return value;
    }
    if (Object.keys(asObject(document.error)).length > 0) return 502;
    if (typeof document.message === "string" && (
      typeof document.type === "string"
      || Object.prototype.hasOwnProperty.call(document, "param")
      || Object.prototype.hasOwnProperty.call(document, "code")
    )) return 502;
    return undefined;
  }

  private providerFailure(
    status: number,
    kind: "credential" | "route" = "route",
    provider?: ManagedProviderName,
    payload?: unknown,
  ) {
    if (provider === "bedrock") return this.bedrockFailure(status, payload);
    if (kind === "credential" && [401, 403, 404].includes(status)) {
      return new OneComputerError("PROVIDER_CREDENTIAL_REJECTED", "The provider API key or approved model access was rejected", 422);
    }
    if (kind === "credential" && status === 429) {
      return new OneComputerError("PROVIDER_THROTTLED", "The provider throttled the route test; retry shortly", 429, true);
    }
    if (kind === "credential" && status >= 400 && status < 500) {
      return new OneComputerError("PROVIDER_TEST_REQUEST_REJECTED", "The provider rejected the route test request", 422);
    }
    return new OneComputerError("PROVIDER_ROUTE_FAILED", "The provider route could not be configured", 502, true);
  }

  private bedrockFailure(status: number, payload: unknown) {
    const body = asObject(payload);
    const detail = asObject(body.detail);
    const error = asObject(body.error);
    const diagnostic = [
      typeof body.error === "string" ? body.error : undefined,
      typeof body.message === "string" ? body.message : undefined,
      typeof body.detail === "string" ? body.detail : undefined,
      typeof detail.error === "string" ? detail.error : undefined,
      typeof detail.message === "string" ? detail.message : undefined,
      typeof error.message === "string" ? error.message : undefined,
      typeof error.code === "string" ? error.code : undefined,
    ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();

    if (status === 429 || /throttl|rate.?limit/.test(diagnostic)) {
      return new OneComputerError("BEDROCK_THROTTLED", "Bedrock is throttling this route; retry shortly", 429, true);
    }
    if (status === 408 || status === 504 || /timeout|timed out/.test(diagnostic)) {
      return new OneComputerError("BEDROCK_TIMEOUT", "Bedrock did not respond before the route timeout", 504, true);
    }
    if (/marketplace|eula|subscription|model access|access to (?:the )?model|enable.*model/.test(diagnostic)) {
      return new OneComputerError(
        "BEDROCK_MODEL_ACCESS_REQUIRED",
        "Enable the approved model and accept its applicable Bedrock terms before retrying",
        403,
      );
    }
    if (/unsupported.*region|region.*(?:unsupported|not supported|invalid)/.test(diagnostic)) {
      return new OneComputerError("BEDROCK_REGION_UNSUPPORTED", "The approved Bedrock inference profile is not available in that region", 422);
    }
    if (/invalid.*(?:api|bearer).*key|(?:api|bearer).*key.*invalid|authentication/.test(diagnostic) || status === 401) {
      return new OneComputerError("BEDROCK_API_KEY_INVALID", "Bedrock rejected the API key", 401);
    }
    if (/accessdenied|access denied|not authorized|permission/.test(diagnostic)) {
      return new OneComputerError("BEDROCK_ACCESS_DENIED", "Bedrock denied access to the approved route", 403);
    }
    if (status >= 500) {
      return new OneComputerError("BEDROCK_ROUTE_UNAVAILABLE", "The Bedrock route is temporarily unavailable", 503, true);
    }
    return new OneComputerError("BEDROCK_ROUTE_REJECTED", "Bedrock rejected the route configuration or test request", status || 502);
  }
}
