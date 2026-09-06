import { dynamicProviderModelIdSchema, providerModelCatalogSchema, type ProviderModelCatalog, type ProviderModelMetadata } from "@lemmacomputer/contracts";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  approvedBedrockApiKeyModelProfiles,
  providerSettingMetadataSchema,
  type FoundryProviderModelId, type VertexProviderModelId,
  type FoundryConfiguration, type VertexConfiguration,
  bedrockApiKeyModelProfileIdSchema,
  bedrockApiKeyRegionSchema,
  bedrockApiKeyRouteAlias,
  LemmaComputerError,
  type AnthropicProviderModelId,
  type BedrockApiKeyModelProfile,
  type BedrockApiKeyModelProfileId,
  type BedrockApiKeyRegion,
  type GlmProviderModelId,
  type OpenAiProviderModelId,
  type ProviderModelId,
  type ProviderSettingMetadata,
} from "@lemmacomputer/contracts";
import type { FetchLike } from "./mtls-fetch.js";

export const managedProviderNames = ["openai", "anthropic", "glm", "bedrock", "foundry", "vertex"] as const;
export type ManagedProviderName = typeof managedProviderNames[number];
type SelectableProviderName = Exclude<ManagedProviderName, "bedrock">;
export type ManagedProviderOperation = {
  tenantId: string;
  provider: ManagedProviderName;
  existingModelIds: string[];
  configuration?: ProviderSettingMetadata;
  credentialFingerprint?: string;
  useSavedCredential?: boolean;
  modelMetadata?: Record<string, ProviderModelMetadata>;
};
type DirectProviderSelection<T extends ProviderModelId> =
  | { modelId: T; modelIds?: never }
  | { modelId?: never; modelIds: T[] };
export type ManagedProviderConfiguration =
  | (ManagedProviderOperation & { provider: "openai"; apiKey?: string } & DirectProviderSelection<OpenAiProviderModelId>)
  | (ManagedProviderOperation & { provider: "anthropic"; apiKey?: string } & DirectProviderSelection<AnthropicProviderModelId>)
  | (ManagedProviderOperation & { provider: "glm"; apiKey?: string } & DirectProviderSelection<GlmProviderModelId>)
  | (ManagedProviderOperation & { provider: "foundry"; apiKey?: string; modelIds: FoundryProviderModelId[]; foundry: FoundryConfiguration })
  | (ManagedProviderOperation & { provider: "vertex"; apiKey?: string; modelIds: VertexProviderModelId[]; vertex: VertexConfiguration })
  | (ManagedProviderOperation & { provider: "bedrock"; apiKey?: string; region: BedrockApiKeyRegion; modelProfileId?: BedrockApiKeyModelProfileId; modelIds?: string[] });
export type ManagedProviderModelCapabilities = {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
};
export type ManagedProviderDeploymentDescriptor = {
  modelLimits?: { contextTokens: number; outputTokens: number };
  metadata?: ProviderModelMetadata;
  id: string;
  provider: ManagedProviderName;
  providerAccountId: string;
  modelId: ProviderModelId | null;
  displayName: string;
  aliases: string[];
  providerModel: string;
  providerDeployment: string;
  region: string | null;
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
  discoverModels?(input: ManagedProviderOperation & { apiKey?: string; modelIds?: string[] }): Promise<ProviderModelCatalog>;
  configureManagedProvider(input: ManagedProviderConfiguration): Promise<ManagedProviderRoute>;
  testManagedProvider(input: ManagedProviderOperation): Promise<void>;
  deleteManagedProvider(input: ManagedProviderOperation): Promise<void>;
}

export type ManagedProviderModel = {
  alias: string;
  model: string;
  vision: boolean;
  modelCapabilities?: ManagedProviderModelCapabilities;
  foundry?: FoundryConfiguration;
  vertex?: VertexConfiguration;
  baseModel?: string;
  bedrockRegion?: string;
  metadata?: ProviderModelMetadata;
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
  foundry: Object.freeze([
    { id: "gpt-4.1", displayName: "Azure GPT-4.1", model: "openai/gpt-4.1", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
    { id: "gpt-4.1-mini", displayName: "Azure GPT-4.1 mini", model: "openai/gpt-4.1-mini", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
  ]),
  vertex: Object.freeze([
    { id: "gemini-2.5-flash", displayName: "Vertex AI Gemini 2.5 Flash", model: "vertex_ai/gemini-2.5-flash", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
    { id: "gemini-2.5-pro", displayName: "Vertex AI Gemini 2.5 Pro", model: "vertex_ai/gemini-2.5-pro", vision: true, modelCapabilities: toolCapableVisionModelCapabilities },
  ]),
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
  foundry: "gpt-4.1-mini",
  vertex: "gemini-2.5-flash",
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

export const managedProviderModel = (provider: ManagedProviderName, modelId: unknown, metadata?: ProviderModelMetadata): ProviderModelProfile | null => {
  if (!dynamicProviderModelIdSchema.safeParse(modelId).success) return null;
  const id = modelId as string;
  const legacy = provider === "bedrock" ? undefined : managedProviderModelProfiles[provider].find((candidate) => candidate.id === id);
  if (legacy && !metadata) return legacy;
  const prefix = ({ glm: "zai", vertex: "vertex_ai", foundry: "openai", bedrock: "bedrock/converse" } as Record<string, string>)[provider] ?? provider;
  return { id, displayName: metadata?.displayName ?? legacy?.displayName ?? id, model: `${prefix}/${id}`,
    vision: metadata?.capabilities.vision ?? legacy?.vision ?? false,
    modelCapabilities: {
      vision: metadata?.capabilities.vision ?? legacy?.vision ?? false,
      tools: metadata?.capabilities.tools ?? legacy?.modelCapabilities?.tools ?? false,
      streaming: metadata?.capabilities.streaming ?? legacy?.modelCapabilities?.streaming ?? false,
    } };
};

export const managedProviderDisplayMetadata: Record<ManagedProviderName, ManagedProviderDisplayMetadata> = {
  foundry: { primaryAlias: "", upstreamModelDisplayName: "Azure AI Foundry deployments" },
  vertex: { primaryAlias: "", upstreamModelDisplayName: "Google Vertex AI models" },
  openai: {
    primaryAlias: "lemmacomputer-openai",
    upstreamModelDisplayName: managedProviderModel("openai", defaultManagedProviderModelIds.openai)!.displayName,
  },
  anthropic: {
    primaryAlias: "lemmacomputer-claude",
    upstreamModelDisplayName: managedProviderModel("anthropic", defaultManagedProviderModelIds.anthropic)!.displayName,
  },
  glm: {
    primaryAlias: "lemmacomputer-glm",
    upstreamModelDisplayName: managedProviderModel("glm", defaultManagedProviderModelIds.glm)!.displayName,
  },
  bedrock: {
    primaryAlias: bedrockApiKeyRouteAlias,
    upstreamModelDisplayName: "Amazon Bedrock Claude Sonnet 4.5",
  },
};

export const managedProviderModels: Record<ManagedProviderName, readonly ManagedProviderModel[]> = {
  foundry: [],
  vertex: [],
  openai: [
    { alias: "lemmacomputer-assistant", model: "openai/gpt-5.6-luna", vision: true },
    { alias: "lemmacomputer-openai", model: "openai/gpt-5.6-luna", vision: true },
    { alias: "claude-opus-4-6", model: "openai/gpt-5.6-luna", vision: true },
  ],
  anthropic: [
    { alias: "lemmacomputer-claude", model: "anthropic/claude-sonnet-4-6", vision: true },
    { alias: "claude-sonnet-4-6", model: "anthropic/claude-sonnet-4-6", vision: true },
  ],
  glm: [
    { alias: "lemmacomputer-glm", model: "zai/glm-5", vision: false },
    { alias: "claude-sonnet-4-5", model: "zai/glm-5", vision: false },
  ],
  bedrock: [
    { alias: bedrockApiKeyRouteAlias, model: approvedBedrockApiKeyModelProfiles[0]!.litellmModel, vision: true },
  ],
};

export const managedProviderModelAlias = (provider: ManagedProviderName, modelId: ProviderModelId) => {
  const legacy = provider !== "bedrock" && managedProviderModelProfiles[provider].some((model) => model.id === modelId);
  const slug = modelId.replaceAll(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 80);
  return `lemmacomputer-${provider}-${slug}${legacy ? "" : `-${createHash("sha256").update(modelId).digest("hex").slice(0, 16)}`}`;
};

export const managedProviderForAlias = (alias: string) => managedProviderNames.find((provider) => {
  if (managedProviderModels[provider].some((model) => model.alias === alias)) return true;
  if (alias.startsWith(`lemmacomputer-${provider}-`) && /^[a-z0-9-]+-[a-f0-9]{16}$/.test(alias.slice(`lemmacomputer-${provider}-`.length))) return true;
  if (provider === "bedrock") return false;
  return managedProviderModelProfiles[provider].some((profile) => {
    const base = managedProviderModelAlias(provider, profile.id);
    return base === alias || ((provider === "foundry" || provider === "vertex")
      && alias.startsWith(`${base}-`) && /^[a-f0-9]{16}$/.test(alias.slice(base.length + 1)));
  });
});

const validatedVertexCredentials = (raw: string): string => {
  try {
    if (raw.length > 16384) throw new Error();
    const value = JSON.parse(raw);
    const allowed = new Set(["type", "project_id", "private_key_id", "private_key", "client_email", "client_id", "auth_uri", "token_uri", "auth_provider_x509_cert_url", "client_x509_cert_url", "universe_domain"]);
    if (!value || value.type !== "service_account" || Object.keys(value).some((key) => !allowed.has(key))
      || typeof value.private_key !== "string" || !value.private_key.startsWith("-----BEGIN PRIVATE KEY-----")
      || typeof value.client_email !== "string" || !/^[a-zA-Z0-9._-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(value.client_email)
      || value.token_uri !== "https://oauth2.googleapis.com/token"
      || (value.universe_domain !== undefined && value.universe_domain !== "googleapis.com")) throw new Error();
    return JSON.stringify(value);
  } catch {
    throw new LemmaComputerError("PROVIDER_CREDENTIAL_REJECTED", "A valid Google service account JSON credential is required", 400);
  }
};

const tenantRouteHash = (tenantId: string) => createHash("sha256")
  .update(`lemmacomputer:provider-route:${tenantId}`)
  .digest("base64url")
  .slice(0, 18);

export const tenantManagedModelAccessGroup = (tenantId: string, alias: string) => {
  if (!managedProviderForAlias(alias)) return alias;
  return `ocp-${tenantRouteHash(tenantId)}-${alias}`;
};

const managedProviderAliases = [
  ...managedProviderNames.flatMap((provider) => managedProviderModels[provider].map(({ alias }) => alias)),
  ...(["openai", "anthropic", "glm", "foundry", "vertex"] as const).flatMap((provider) =>
    managedProviderModelProfiles[provider].map(({ id }) => managedProviderModelAlias(provider, id)),
  ),
];

export const managedProviderAliasForAccessGroup = (tenantId: string, accessGroup: string) => {
  const known = managedProviderAliases.find((alias) => tenantManagedModelAccessGroup(tenantId, alias) === accessGroup);
  if (known) return known;
  const prefix = `ocp-${tenantRouteHash(tenantId)}-`;
  if (!accessGroup.startsWith(prefix)) return null;
  const alias = accessGroup.slice(prefix.length);
  const provider = managedProviderForAlias(alias);
  return provider ? alias : null;
};

const tenantCredentialName = (tenantId: string, provider: ManagedProviderName) => `lemmacomputer-provider-${tenantRouteHash(tenantId)}-${provider}`;
const tenantModelId = (tenantId: string, provider: ManagedProviderName, alias: string) => `lemmacomputer-provider-${tenantRouteHash(tenantId)}-${provider}-${alias}`;

export type LiteLLMProviderAdministrationConfig = { adminUrl: string; masterKey: string; credentialSecret: string; requestTimeoutMs?: number; bedrockRuntimeEndpoint?: string; adminFetch?: FetchLike };
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
  if (requested.length < 1 || requested.length > 64 || new Set(requested).size !== requested.length
    || requested.some((id) => !dynamicProviderModelIdSchema.safeParse(id).success)) {
    throw new LemmaComputerError("PROVIDER_MODEL_UNAPPROVED", "Invalid provider model selection", 400);
  }
  return requested;

};

const templatesFor = (
  provider: ManagedProviderName,
  configuration: ProviderSettingMetadata,
): ProviderModelTemplate[] => {
  if (provider === "foundry" || provider === "vertex") {
    const parsed = providerSettingMetadataSchema.safeParse(configuration);
    if (!parsed.success || !configuration[provider]) return [];
    return managedProviderSelectedModelIds(provider, configuration).map((id, index) => {
      const profile = managedProviderModel(provider, id, configuration.modelMetadata?.[id])!;
      // A new cloud target must not inherit an old deployment's pricing or
      // routing approval even when the base model and credential slot match.
      const binding = provider === "foundry"
        ? [configuration.foundry!.endpoint.replace(/\/$/, ""), configuration.foundry!.deployments[id as FoundryProviderModelId], ...(configuration.foundry!.protocols?.[id] === "anthropic" ? ["anthropic"] : [])]
        : [configuration.vertex!.projectId, configuration.vertex!.location, ...(configuration.vertex!.authMethod === "api-key" ? ["api-key"] : [])];
      const bindingHash = createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 16);
      const alias = `${managedProviderModelAlias(provider, id)}-${bindingHash}`;
      return {
        alias, upstreamModelId: id, displayName: profile.displayName,
        primary: index === 0, legacyAlias: false,
        model: {
          alias, vision: profile.vision, modelCapabilities: profile.modelCapabilities,
          model: provider === "foundry" ? `${configuration.foundry!.protocols?.[id] === "anthropic" ? "anthropic" : "azure"}/${configuration.foundry!.deployments[id]}`
            : configuration.vertex!.authMethod === "api-key" ? `gemini/${id}` : profile.model,
          metadata: configuration.modelMetadata?.[id],
          baseModel: provider === "foundry" ? `foundry/${id}` : profile.model,
          ...(provider === "foundry" ? { foundry: { ...configuration.foundry!, endpoint: configuration.foundry!.protocols?.[id] === "anthropic" ? configuration.foundry!.endpoint.replace(/\/openai\/v1\/?$/, "/anthropic") : configuration.foundry!.endpoint } } : { vertex: configuration.vertex }),
        },
      };
    });
  }
  if (provider === "bedrock" && configuration.modelIds && configuration.region) {
    const selected = configuration.modelIds.map((id, index) => {
      const profile = managedProviderModel(provider, id, configuration.modelMetadata?.[id])!;
      const alias = `${managedProviderModelAlias(provider, id)}-${createHash("sha256").update(configuration.region!).digest("hex").slice(0, 16)}`;
      return { alias, upstreamModelId: id, displayName: profile.displayName, primary: index === 0, legacyAlias: false,
        model: { alias, model: profile.model, vision: profile.vision, modelCapabilities: profile.modelCapabilities,
          metadata: configuration.modelMetadata?.[id], bedrockRegion: configuration.region } };
    });
    // Preserve the old configured deployment when expanding a legacy account.
    const legacy = approvedBedrockApiKeyModelProfiles[0]!;
    if (configuration.modelIds.includes(legacy.litellmModel.replace("bedrock/converse/", ""))) {
      const previous = templatesFor(provider, { region: configuration.region, modelProfileId: legacy.id });
      selected.splice(configuration.modelIds.indexOf(legacy.litellmModel.replace("bedrock/converse/", "")), 1);
      return [...previous, ...selected];
    }
    return selected;
  }
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
  const profiles = selectedIds.map((id) => managedProviderModel(provider, id, configuration.modelMetadata?.[id])!);
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
        model: { alias, model: profile.model, vision: profile.vision, modelCapabilities: profile.modelCapabilities, metadata: configuration.modelMetadata?.[profile.id] },
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
    ? templates.filter((template) => !template.legacyAlias || provider === "bedrock")
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
      providerModel: template.model.baseModel ?? template.model.model,
      providerDeployment: accessGroup,
      ...(configuration.modelLimits?.[accessGroup] ? { modelLimits: configuration.modelLimits[accessGroup] } : {}),
      ...(template.model.metadata ? { metadata: template.model.metadata } : {}),
      region: template.model.bedrockRegion ?? template.model.bedrock?.region ?? template.model.vertex?.location ?? null,
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
  private readonly adminFetch: FetchLike;

  constructor(config: LiteLLMProviderAdministrationConfig) {
    this.adminUrl = config.adminUrl.replace(/\/$/, "");
    this.masterKey = config.masterKey;
    this.credentialSecret = config.credentialSecret;
    this.timeoutMs = config.requestTimeoutMs ?? 15_000;
    this.bedrockRuntimeEndpoint = config.bedrockRuntimeEndpoint?.replace(/[/]$/, "");
    this.adminFetch = config.adminFetch ?? fetch;
  }

  async discoverModels(input: ManagedProviderOperation & { apiKey?: string; modelIds?: string[] }): Promise<ProviderModelCatalog> {
    const apiKey = input.apiKey && input.provider === "vertex" && input.configuration?.vertex?.authMethod !== "api-key" ? validatedVertexCredentials(input.apiKey) : input.apiKey;
    const result = await this.call("/lemmacomputer/model-catalog", { method: "POST", body: {
      tenantId: input.tenantId, provider: input.provider, configuration: { ...(input.configuration?.foundry ? { foundry: { endpoint: input.configuration.foundry.endpoint } } : {}), ...(input.configuration?.vertex ? { vertex: input.configuration.vertex } : {}), ...(input.configuration?.region ? { region: input.configuration.region } : {}) }, useSavedCredential: input.useSavedCredential === true,
      ...(apiKey ? { apiKey } : {}), ...(input.modelIds ? { modelIds: input.modelIds } : {}),
    } });
    const parsed = providerModelCatalogSchema.safeParse(result.payload);
    if (!result.ok || !parsed.success) throw new LemmaComputerError("PROVIDER_CATALOG_UNAVAILABLE", "Model discovery is unavailable; add an exact model ID or retry", 503, true);
    return parsed.data;
  }

  async configureManagedProvider(input: ManagedProviderConfiguration): Promise<ManagedProviderRoute> {
    const apiKey = input.apiKey ? (input.provider === "vertex" && input.vertex.authMethod !== "api-key" ? validatedVertexCredentials(input.apiKey) : input.apiKey.trim()) : "";
    if (!apiKey && (!input.existingModelIds.length || !input.credentialFingerprint)) throw new LemmaComputerError("PROVIDER_KEY_REQUIRED", "A provider API key is required", 400);
    const configuration = this.configurationFor(input);
    if (input.modelMetadata) configuration.modelMetadata = input.modelMetadata;
    const models = templatesFor(input.provider, configuration);
    if (models.length === 0) {
      throw new LemmaComputerError("PROVIDER_MODEL_UNAPPROVED", "The selected provider models are not approved", 400);
    }
    const descriptors = managedProviderDeploymentDescriptors(input.tenantId, input.provider, configuration);
    for (const deployment of descriptors) {
      const metadata = deployment.metadata;
      if (metadata?.contextTokens && metadata.outputTokens && metadata.contextTokens >= 1024 && metadata.outputTokens < metadata.contextTokens) {
        configuration.modelLimits = { ...configuration.modelLimits, [deployment.providerDeployment]: { contextTokens: metadata.contextTokens, outputTokens: metadata.outputTokens } };
      }
    }
    const credentialName = tenantCredentialName(input.tenantId, input.provider);
    const deploymentFor = (template: ProviderModelTemplate, candidate = false): ProviderModelDeployment => {
      const suffix = candidate ? `-candidate-${randomBytes(8).toString("hex")}` : "";
      const alias = `${tenantManagedModelAccessGroup(input.tenantId, template.alias)}${suffix}`;
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
      throw new LemmaComputerError("PROVIDER_ROUTE_INTEGRITY_FAILED", "The existing provider route cannot be safely changed", 409);
    }

    await this.ensureRetiringAliasesAreGone(input.provider);
    const candidateCredentialName = apiKey ? `${credentialName}-candidate-${randomBytes(12).toString("hex")}` : credentialName;
    const candidates: Array<{ id: string; alias: string }> = [];
    try {
      if (apiKey) await this.createCredential(candidateCredentialName, input, apiKey);
      for (const model of models) {
        const deployment = deploymentFor(model, true);
        deployment.credentialName = candidateCredentialName;
        candidates.push({ id: await this.createModel(deployment), alias: deployment.alias });
      }
      for (const [index, candidate] of candidates.entries()) {
        const template = models[index]!;
        if (models.findIndex((model) => model.upstreamModelId === template.upstreamModelId) !== index) continue;
        const legacy = Boolean(template.model.bedrock) || input.provider !== "bedrock" && managedProviderModelProfiles[input.provider].some((profile) => profile.id === template.upstreamModelId);
        await this.probe(candidate.alias, undefined, input.provider, !legacy ? template.model.modelCapabilities : undefined);
      }

      if (existing.length > 0) {
        if (apiKey) await this.replaceCredential(credentialName, input, apiKey);
        try {
          for (const deployment of targetDeployments) {
            const updated = await this.upsertModel(deployment);
            if (updated.id !== deployment.id) {
              throw new LemmaComputerError("PROVIDER_ROUTE_INTEGRITY_FAILED", "The provider route identity changed unexpectedly", 409);
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
          credentialFingerprint: apiKey ? this.fingerprint(apiKey) : input.credentialFingerprint!,
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
            throw new LemmaComputerError("PROVIDER_ROUTE_INTEGRITY_FAILED", "The provider route identity changed unexpectedly", 409);
          }
          if (updated.created) createdModelIds.push(updated.id);
        }
        const primary = targetDeployments[0]!;
        await this.probe(primary.alias, primary.accessGroups[0], input.provider);
        return {
          modelIds: targetIds,
          deployments: descriptors,
          credentialFingerprint: apiKey ? this.fingerprint(apiKey) : input.credentialFingerprint!,
          configuration,
        };
      } catch (error) {
        await Promise.all(createdModelIds.map((id) => this.deleteModel(id, input.provider).catch(() => undefined)));
        if (stableCredentialCreated) await this.deleteCredential(credentialName, input.provider).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof LemmaComputerError) throw error;
      throw new LemmaComputerError("PROVIDER_CONFIGURATION_FAILED", "The provider configuration could not be validated", 502, true);
    } finally {
      await Promise.all(candidates.map(({ id }) => this.deleteModel(id, input.provider).catch(() => undefined)));
      if (apiKey) await this.deleteCredential(candidateCredentialName, input.provider).catch(() => undefined);
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
      throw new LemmaComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 409);
    }
    await this.ensureRetiringAliasesAreGone(input.provider);
    for (const selected of models.filter((item) => !item.legacyAlias || !input.configuration?.modelIds || input.provider === "bedrock")) {
      const accessGroup = tenantManagedModelAccessGroup(input.tenantId, selected.alias);
      await this.probe(accessGroup, accessGroup, input.provider);
    }
  }

  async deleteManagedProvider(input: ManagedProviderOperation) {
    await this.ensureRetiringAliasesAreGone(input.provider);
    for (const id of [...new Set(input.existingModelIds)]) await this.deleteModel(id);
    await this.deleteCredential(tenantCredentialName(input.tenantId, input.provider));
  }

  private configurationFor(input: ManagedProviderConfiguration): ProviderSettingMetadata {
    if (input.provider === "foundry" || input.provider === "vertex") {
      const parsed = providerSettingMetadataSchema.safeParse({
        modelIds: input.modelIds,
        ...(input.provider === "foundry" ? { foundry: input.foundry } : { vertex: input.vertex }),
      });
      if (!parsed.success) throw new LemmaComputerError("PROVIDER_CONFIGURATION_INVALID", "The provider configuration is invalid", 400);
      return parsed.data;
    }
    if (input.provider !== "bedrock") {
      if (input.modelIds) {
        return { modelIds: managedProviderSelectedModelIds(input.provider, { modelIds: input.modelIds }) };
      }
      const selected = managedProviderSelectedModelIds(input.provider, { modelId: input.modelId });
      return { modelId: selected[0]! };
    }
    if (input.modelIds) return providerSettingMetadataSchema.parse({ region: input.region, modelIds: input.modelIds });
    const region = bedrockApiKeyRegionSchema.safeParse(input.region);
    const modelProfileId = bedrockApiKeyModelProfileIdSchema.safeParse(input.modelProfileId);
    if (!region.success || !modelProfileId.success) {
      throw new LemmaComputerError("BEDROCK_ROUTE_UNAPPROVED", "The selected Bedrock region or inference profile is not approved", 400);
    }
    const profile = approvedBedrockApiKeyModelProfiles.find((candidate) => candidate.id === modelProfileId.data);
    if (!profile || !profile.regions.includes(region.data)) {
      throw new LemmaComputerError("BEDROCK_ROUTE_UNAPPROVED", "The selected Bedrock region or inference profile is not approved", 400);
    }
    return { region: region.data, modelProfileId: modelProfileId.data };
  }

  private async createModel(deployment: ProviderModelDeployment) {
    const result = await this.call("/model/new", { method: "POST", body: this.modelDocument(deployment) });
    if (!result.ok) throw this.providerFailure(result.status, "route", deployment.provider, result.payload);
    const id = this.modelId(result.payload);
    if (!id) throw new LemmaComputerError("PROVIDER_ROUTE_FAILED", "The model gateway did not confirm a provider route", 502, true);
    return id;
  }

  private async upsertModel(deployment: ProviderModelDeployment) {
    const updated = await this.call(`/model/${encodeURIComponent(deployment.id)}/update`, { method: "PATCH", body: this.modelDocument(deployment) });
    if (updated.ok) return { id: deployment.id, created: false };
    if (updated.status !== 404 || updated.embeddedError) throw this.providerFailure(updated.status, "route", deployment.provider, updated.payload);
    return { id: await this.createModel(deployment), created: true };
  }

  private async probeRequest(model: string, accessGroup: string | undefined, provider: ManagedProviderName, path: string, body: JsonObject) {
    const credential = `sk-ocp-${randomBytes(24).toString("base64url")}`;
    try {
      const grant = await this.call("/key/generate", {
        method: "POST",
        body: {
          key: credential,
          key_alias: `lemmacomputer-provider-probe-${randomBytes(12).toString("hex")}`,
          key_type: "llm_api",
          duration: "60s",
          models: [accessGroup ?? model],
          rpm_limit: 2,
          max_parallel_requests: 1,
          metadata: {
            lemmacomputer_purpose: "provider-route-test",
            lemmacomputer_non_billable_exemption: "provider-route-test-v1",
            lemmacomputer_provider: provider,
            lemmacomputer_deployment_id: accessGroup ?? model,
          },
        },
      });
      if (!grant.ok) throw this.providerFailure(grant.status, "route", provider, grant.payload);
      return await this.call(path, { method: "POST", credential, body });
    } finally {
      await this.call("/key/delete", { method: "POST", body: { keys: [credential] } }).catch(() => undefined);
    }
  }

  private async probe(model: string, accessGroup: string | undefined, provider: ManagedProviderName, capabilities?: ManagedProviderModelCapabilities) {
    const result = await this.probeRequest(model, accessGroup, provider, provider === "openai" ? "/responses" : "/chat/completions",
      provider === "openai" ? { model, input: "Reply with OK." }
        : { model, messages: [{ role: "user", content: "Reply with OK." }] });
    if (!result.ok) throw this.providerFailure(result.status, "credential", provider, result.payload);
    if (capabilities?.tools || capabilities?.streaming) {
      // LiteLLM releases concurrency asynchronously after returning a response.
      // Each check owns a separate bounded key so consecutive requests cannot
      // collide with the previous check's still-pending accounting callback.
      const features = await this.probeRequest(model, accessGroup, provider, "/chat/completions", {
        model, stream: true, messages: [{ role: "user", content: capabilities.tools ? "Call record_ok once with an empty object." : "Reply with OK." }],
        ...(capabilities.tools ? { tools: [{ type: "function", function: { name: "record_ok", description: "Record a successful connection check", parameters: { type: "object", properties: {}, additionalProperties: false } } }], tool_choice: "required" } : {}),
      });
      if (!features.ok) throw this.providerFailure(features.status, "credential", provider, features.payload);
      const events = asObject(features.payload).events;
      const choices = Array.isArray(events) ? events.flatMap((event) => Array.isArray(asObject(event).choices) ? asObject(event).choices as unknown[] : []) : [];
      const completed = choices.some((choice) => typeof asObject(choice).finish_reason === "string");
      const toolCalled = choices.some((choice) => (asObject(asObject(choice).delta).tool_calls as unknown[] | undefined)?.some((call) => asObject(asObject(call).function).name === "record_ok"));
      if (!completed || (capabilities.tools && !toolCalled)) throw new LemmaComputerError("PROVIDER_TEST_REQUEST_REJECTED", "The model did not pass its streaming or tool-call compatibility check", 422);
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
        && !(typeof info.id === "string" && info.id.startsWith("lemmacomputer-provider-") && Array.isArray(info.access_groups) && info.access_groups.length > 0 && info.access_groups.every((group) => typeof group === "string" && group.startsWith("ocp-")));
    });
    if (retiring) throw new LemmaComputerError("PROVIDER_STATIC_CUTOVER_REQUIRED", "Restart the installation with retired provider routes removed before configuring this provider", 409);
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
      credential_info: { provider: input.provider, managed_by: "lemmacomputer", ...bedrock },
      credential_values: input.provider === "vertex" && input.vertex.authMethod !== "api-key" ? { vertex_credentials: apiKey } : { api_key: apiKey },
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
        // Azure v1 uses LiteLLM's Azure transport. Labeling this as OpenAI
        // incorrectly opts Azure into the gateway's OpenAI-only Responses
        // bridge, whose nested probe has no authenticated key identity.
        ...(deployment.model.foundry ? deployment.model.model.startsWith("azure/") ? {
          api_base: deployment.model.foundry.endpoint.replace(/\/openai\/v1\/?$/, ""),
          api_version: "v1",
        } : { api_base: deployment.model.foundry.endpoint } : {}),
        ...(deployment.model.vertex?.authMethod === "api-key" ? {
          // Use Gemini's API-key transport with a fixed Google Cloud endpoint,
          // never the Google AI Studio default or an administrator-supplied URL.
          api_base: "https://aiplatform.googleapis.com/v1/publishers/google",
        } : deployment.model.vertex ? {
          vertex_project: deployment.model.vertex.projectId,
          vertex_location: deployment.model.vertex.location,
        } : {}),
        ...(deployment.model.bedrockRegion ? { aws_region_name: deployment.model.bedrockRegion } : {}),
        ...(bedrock ? {
          aws_region_name: bedrock.region,
          timeout: 60,
          max_retries: 2,
          ...(this.bedrockRuntimeEndpoint ? { aws_bedrock_runtime_endpoint: this.bedrockRuntimeEndpoint } : {}),
        } : {}),
      },
      model_info: {
        id: deployment.id,
        lemmacomputer_provider: deployment.provider,
        lemmacomputer_provider_account_id: deployment.credentialName,
        lemmacomputer_base_model: deployment.model.baseModel ?? deployment.model.model,
        lemmacomputer_deployment_id: deployment.accessGroups[0],
        lemmacomputer_provider_service_tier: "standard",
        ...(deployment.model.bedrockRegion ? { lemmacomputer_region: deployment.model.bedrockRegion } : bedrock ? { lemmacomputer_region: bedrock.region } : deployment.model.vertex ? { lemmacomputer_region: deployment.model.vertex.location } : {}),
        ...(deployment.upstreamModelId ? { lemmacomputer_upstream_model_id: deployment.upstreamModelId } : {}),
        lemmacomputer_primary_deployment: deployment.primary,
        lemmacomputer_legacy_alias: deployment.legacyAlias,
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
      .update(`lemmacomputer:provider-fingerprint:${apiKey}`)
      .digest("base64url")
      .slice(0, 20);
    return `fp_${digest}`;
  }

  private async call(path: string, input: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: JsonObject; credential?: string }): Promise<GatewayResult> {
    try {
      const response = await this.adminFetch(`${this.adminUrl}${path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.credential ?? this.masterKey}`,
          "content-type": "application/json",
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        signal: AbortSignal.timeout(path === "/lemmacomputer/model-catalog" ? Math.max(this.timeoutMs, 60000) : this.timeoutMs),
      });
      let payload: unknown;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let wire = "";
        try {
          if (!reader) throw new Error();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            wire += decoder.decode(chunk.value, { stream: true });
            if (wire.length > 262144) throw new Error();
          }
          wire += decoder.decode();
          payload = { events: wire.split(/\r?\n/).filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]").map((line) => JSON.parse(line.slice(5))) };
        } finally { await reader?.cancel().catch(() => undefined); }
      } else payload = await response.json().catch(() => ({}));
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
      throw new LemmaComputerError("PROVIDER_GATEWAY_UNAVAILABLE", "The provider gateway is unavailable", 503, true);
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
      return new LemmaComputerError("PROVIDER_CREDENTIAL_REJECTED", "The provider API key or approved model access was rejected", 422);
    }
    if (kind === "credential" && status === 429) {
      return new LemmaComputerError("PROVIDER_THROTTLED", "The provider throttled the route test; retry shortly", 429, true);
    }
    if (kind === "credential" && status >= 400 && status < 500) {
      return new LemmaComputerError("PROVIDER_TEST_REQUEST_REJECTED", "The provider rejected the route test request", 422);
    }
    return new LemmaComputerError("PROVIDER_ROUTE_FAILED", "The provider route could not be configured", 502, true);
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
      return new LemmaComputerError("BEDROCK_THROTTLED", "Bedrock is throttling this route; retry shortly", 429, true);
    }
    if (status === 408 || status === 504 || /timeout|timed out/.test(diagnostic)) {
      return new LemmaComputerError("BEDROCK_TIMEOUT", "Bedrock did not respond before the route timeout", 504, true);
    }
    if (/marketplace|eula|subscription|model access|access to (?:the )?model|enable.*model/.test(diagnostic)) {
      return new LemmaComputerError(
        "BEDROCK_MODEL_ACCESS_REQUIRED",
        "Enable the approved model and accept its applicable Bedrock terms before retrying",
        403,
      );
    }
    if (/unsupported.*region|region.*(?:unsupported|not supported|invalid)/.test(diagnostic)) {
      return new LemmaComputerError("BEDROCK_REGION_UNSUPPORTED", "The approved Bedrock inference profile is not available in that region", 422);
    }
    if (/invalid.*(?:api|bearer).*key|(?:api|bearer).*key.*invalid|authentication/.test(diagnostic) || status === 401) {
      return new LemmaComputerError("BEDROCK_API_KEY_INVALID", "Bedrock rejected the API key", 401);
    }
    if (/accessdenied|access denied|not authorized|permission/.test(diagnostic)) {
      return new LemmaComputerError("BEDROCK_ACCESS_DENIED", "Bedrock denied access to the approved route", 403);
    }
    if (status >= 500) {
      return new LemmaComputerError("BEDROCK_ROUTE_UNAVAILABLE", "The Bedrock route is temporarily unavailable", 503, true);
    }
    return new LemmaComputerError("BEDROCK_ROUTE_REJECTED", "Bedrock rejected the route configuration or test request", status || 502);
  }
}
