import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  approvedBedrockApiKeyModelProfiles,
  bedrockApiKeyModelProfileIdSchema,
  bedrockApiKeyRegionSchema,
  bedrockApiKeyRouteAlias,
  OneComputerError,
  type BedrockApiKeyModelProfile,
  type BedrockApiKeyModelProfileId,
  type BedrockApiKeyRegion,
  type ProviderSettingMetadata,
} from "@onecomputer/contracts";

export const managedProviderNames = ["openai", "anthropic", "glm", "bedrock"] as const;
export type ManagedProviderName = typeof managedProviderNames[number];
export type ManagedProviderOperation = { tenantId: string; provider: ManagedProviderName; existingModelIds: string[] };
export type ManagedProviderConfiguration =
  | (ManagedProviderOperation & { provider: "openai" | "anthropic" | "glm"; apiKey: string })
  | (ManagedProviderOperation & { provider: "bedrock"; apiKey: string; region: BedrockApiKeyRegion; modelProfileId: BedrockApiKeyModelProfileId });
export type ManagedProviderRoute = { modelIds: string[]; credentialFingerprint: string; configuration: ProviderSettingMetadata };
export interface ProviderAdministrationGateway {
  configureManagedProvider(input: ManagedProviderConfiguration): Promise<ManagedProviderRoute>;
  testManagedProvider(input: ManagedProviderOperation): Promise<void>;
  deleteManagedProvider(input: ManagedProviderOperation): Promise<void>;
}

export type ManagedProviderModel = {
  alias: string;
  model: string;
  vision: boolean;
  bedrock?: { region: BedrockApiKeyRegion; profile: BedrockApiKeyModelProfile };
};

export type ManagedProviderDisplayMetadata = {
  primaryAlias: string;
  upstreamModelDisplayName: string;
};

export const managedProviderDisplayMetadata: Record<ManagedProviderName, ManagedProviderDisplayMetadata> = {
  openai: {
    primaryAlias: "onecomputer-openai",
    upstreamModelDisplayName: "OpenAI GPT-5.6 Luna",
  },
  anthropic: {
    primaryAlias: "onecomputer-claude",
    upstreamModelDisplayName: "Anthropic Claude Sonnet 4.6",
  },
  glm: {
    primaryAlias: "onecomputer-glm",
    upstreamModelDisplayName: "Z.ai GLM-5",
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

export const managedProviderForAlias = (alias: string) => managedProviderNames.find((provider) => (
  managedProviderModels[provider].some((model) => model.alias === alias)
));

const tenantRouteHash = (tenantId: string) => createHash("sha256")
  .update(`onecomputer:provider-route:${tenantId}`)
  .digest("base64url")
  .slice(0, 18);

export const tenantManagedModelAccessGroup = (tenantId: string, alias: string) => {
  if (!managedProviderForAlias(alias)) return alias;
  return `ocp-${tenantRouteHash(tenantId)}-${alias}`;
};

const tenantCredentialName = (tenantId: string, provider: ManagedProviderName) => `onecomputer-provider-${tenantRouteHash(tenantId)}-${provider}`;
const tenantModelId = (tenantId: string, provider: ManagedProviderName, alias: string) => `onecomputer-provider-${tenantRouteHash(tenantId)}-${provider}-${alias}`;

export type LiteLLMProviderAdministrationConfig = { adminUrl: string; masterKey: string; credentialSecret: string; requestTimeoutMs?: number; bedrockRuntimeEndpoint?: string };
type JsonObject = Record<string, unknown>;
type GatewayResult = { ok: boolean; status: number; payload: unknown; embeddedError: boolean };
const asObject = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
type ProviderModelDeployment = {
  id: string;
  provider: ManagedProviderName;
  alias: string;
  model: ManagedProviderModel;
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
    const models = this.modelsFor(input);
    const expectedModelIds = models.map((model) => tenantModelId(input.tenantId, input.provider, model.alias));
    const existing = [...new Set(input.existingModelIds)];
    if (existing.length > 0 && (
      existing.length !== models.length
      || expectedModelIds.some((id) => !existing.includes(id))
    )) {
      throw new OneComputerError("PROVIDER_ROUTE_INTEGRITY_FAILED", "The existing provider route cannot be safely rotated", 409);
    }
    await this.ensureRetiringAliasesAreGone(input.provider);
    const credentialName = tenantCredentialName(input.tenantId, input.provider);
    const candidateCredentialName = `${credentialName}-candidate-${randomBytes(12).toString("hex")}`;
    const candidates: Array<{ id: string; alias: string }> = [];
    try {
      await this.createCredential(candidateCredentialName, input, apiKey);
      for (const model of models) {
        const alias = `${tenantManagedModelAccessGroup(input.tenantId, model.alias)}-candidate-${randomBytes(8).toString("hex")}`;
        candidates.push({
          id: await this.createModel({
            id: `${tenantModelId(input.tenantId, input.provider, model.alias)}-candidate-${randomBytes(8).toString("hex")}`,
            provider: input.provider,
            alias,
            model,
            credentialName: candidateCredentialName,
            accessGroups: [],
          }),
          alias,
        });
      }
      await this.probe(candidates[0]!.alias, undefined, input.provider);
      if (existing.length === models.length) {
        await this.probe(models[0]!.alias, tenantManagedModelAccessGroup(input.tenantId, models[0]!.alias), input.provider);
        await this.replaceCredential(credentialName, input, apiKey);
        return {
          modelIds: expectedModelIds,
          credentialFingerprint: this.fingerprint(apiKey),
          configuration: this.configurationFor(input),
        };
      }
      let stableCredentialCreated = false;
      const createdModelIds: string[] = [];
      try {
        await this.createCredential(credentialName, input, apiKey);
        stableCredentialCreated = true;
        const modelIds: string[] = [];
        for (const model of models) {
          const deployment = await this.upsertModel({
            id: tenantModelId(input.tenantId, input.provider, model.alias),
            provider: input.provider,
            alias: model.alias,
            model,
            credentialName,
            accessGroups: [tenantManagedModelAccessGroup(input.tenantId, model.alias)],
          });
          if (deployment.created) createdModelIds.push(deployment.id);
          modelIds.push(deployment.id);
        }
        await this.probe(models[0]!.alias, tenantManagedModelAccessGroup(input.tenantId, models[0]!.alias), input.provider);
        return {
          modelIds,
          credentialFingerprint: this.fingerprint(apiKey),
          configuration: this.configurationFor(input),
        };
      } catch (error) {
        await Promise.all(createdModelIds.map((id) => this.deleteModel(id).catch(() => undefined)));
        if (stableCredentialCreated) await this.deleteCredential(credentialName).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof OneComputerError) throw error;
      throw new OneComputerError("PROVIDER_CONFIGURATION_FAILED", "The provider configuration could not be validated", 502, true);
    } finally {
      await Promise.all(candidates.map(({ id }) => this.deleteModel(id).catch(() => undefined)));
      await this.deleteCredential(candidateCredentialName).catch(() => undefined);
    }
  }

  async testManagedProvider(input: ManagedProviderOperation) {
    const model = managedProviderModels[input.provider][0];
    if (!model || input.existingModelIds.length !== managedProviderModels[input.provider].length) {
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

  private modelsFor(input: ManagedProviderConfiguration): readonly ManagedProviderModel[] {
    if (input.provider !== "bedrock") return managedProviderModels[input.provider];
    const region = bedrockApiKeyRegionSchema.safeParse(input.region);
    const modelProfileId = bedrockApiKeyModelProfileIdSchema.safeParse(input.modelProfileId);
    if (!region.success || !modelProfileId.success) {
      throw new OneComputerError("BEDROCK_ROUTE_UNAPPROVED", "The selected Bedrock region or inference profile is not approved", 400);
    }
    const profile = approvedBedrockApiKeyModelProfiles.find((candidate) => candidate.id === modelProfileId.data);
    if (!profile || !profile.regions.includes(region.data)) {
      throw new OneComputerError("BEDROCK_ROUTE_UNAPPROVED", "The selected Bedrock region or inference profile is not approved", 400);
    }
    return [{
      alias: bedrockApiKeyRouteAlias,
      model: profile.litellmModel,
      vision: profile.capabilities.vision,
      bedrock: { region: region.data, profile },
    }];
  }

  private configurationFor(input: ManagedProviderConfiguration): ProviderSettingMetadata {
    return input.provider === "bedrock"
      ? { region: input.region, modelProfileId: input.modelProfileId }
      : {};
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
    const credential = accessGroup ? `sk-ocp-${randomBytes(24).toString("base64url")}` : this.masterKey;
    try {
      if (accessGroup) {
        const grant = await this.call("/key/generate", {
          method: "POST",
          body: {
            key: credential,
            key_alias: `onecomputer-provider-probe-${randomBytes(12).toString("hex")}`,
            key_type: "llm_api",
            duration: "60s",
            models: [accessGroup],
            rpm_limit: 2,
            tpm_limit: 4_096,
            max_parallel_requests: 1,
            metadata: { onecomputer_purpose: "provider-route-test" },
          },
        });
        if (!grant.ok) throw this.providerFailure(grant.status, "route", provider, grant.payload);
      }
      const result = await this.call("/chat/completions", {
        method: "POST",
        credential,
        body: {
          model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
          temperature: 0,
        },
      });
      if (!result.ok) throw this.providerFailure(result.status, "credential", provider, result.payload);
    } finally {
      if (accessGroup) await this.call("/key/delete", { method: "POST", body: { keys: [credential] } }).catch(() => undefined);
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
        supports_vision: deployment.model.vision,
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
    if (kind === "credential" && status >= 400 && status < 500) {
      return new OneComputerError("PROVIDER_CREDENTIAL_REJECTED", "The provider API key or approved model access was rejected", 422);
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
