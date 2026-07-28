import { OneComputerError, providerSettingMetadataSchema, type BedrockApiKeyModelProfileId, type BedrockApiKeyRegion } from "@onecomputer/contracts";
import { managedProviderForAlias, managedProviderModels, managedProviderNames, type ManagedProviderName, type ProviderAdministrationGateway } from "@onecomputer/litellm-adapter";
import type { ProviderSettingRecord, ProviderSettingsStore, SessionPrincipal } from "@onecomputer/workspace-store";

export type ProviderSettingInput =
  | { provider: "openai" | "anthropic" | "glm"; apiKey: string }
  | { provider: "bedrock"; apiKey: string; region: BedrockApiKeyRegion; modelProfileId: BedrockApiKeyModelProfileId };

type BedrockSelection = { region: BedrockApiKeyRegion; modelProfileId: BedrockApiKeyModelProfileId };

export type ProviderSettingView = {
  provider: ManagedProviderName;
  aliases: string[];
  state: "active" | "disabled" | "not-configured" | "needs-reconfiguration";
  fingerprint: string | null;
  region: BedrockApiKeyRegion | null;
  modelProfileId: BedrockApiKeyModelProfileId | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string | null;
};

const bedrockSelection = (provider: ManagedProviderName, record: ProviderSettingRecord | null): BedrockSelection | null => {
  if (provider !== "bedrock" || !record) return null;
  const parsed = providerSettingMetadataSchema.safeParse(record.configuration);
  if (!parsed.success || !parsed.data.region || !parsed.data.modelProfileId) return null;
  return { region: parsed.data.region, modelProfileId: parsed.data.modelProfileId };
};

const toView = (provider: ManagedProviderName, record: ProviderSettingRecord | null): ProviderSettingView => {
  const selection = bedrockSelection(provider, record);
  const needsReconfiguration = provider === "bedrock" && record?.state === "active" && !selection;
  return {
    provider,
    aliases: managedProviderModels[provider].map((model) => model.alias),
    state: !record ? "not-configured" : needsReconfiguration ? "needs-reconfiguration" : record.state,
    fingerprint: record?.credentialFingerprint ?? null,
    region: selection?.region ?? null,
    modelProfileId: selection?.modelProfileId ?? null,
    lastTestedAt: record?.lastTestedAt?.toISOString() ?? null,
    lastErrorCode: needsReconfiguration ? "PROVIDER_CONFIGURATION_INVALID" : record?.lastErrorCode ?? null,
    updatedAt: record?.updatedAt.toISOString() ?? null,
  };
};
const safeProviderErrorCodes = new Set([
  "PROVIDER_KEY_REQUIRED",
  "PROVIDER_ROUTE_INTEGRITY_FAILED",
  "PROVIDER_STATIC_CUTOVER_REQUIRED",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_CREDENTIAL_REJECTED",
  "PROVIDER_ROUTE_FAILED",
  "PROVIDER_GATEWAY_UNAVAILABLE",
  "PROVIDER_CONFIGURATION_FAILED",
  "PROVIDER_TEST_FAILED",
  "PROVIDER_CONFIGURATION_INVALID",
  "BEDROCK_ROUTE_UNAPPROVED",
  "BEDROCK_ROUTE_RECONFIGURATION_REQUIRED",
  "BEDROCK_API_KEY_INVALID",
  "BEDROCK_MODEL_ACCESS_REQUIRED",
  "BEDROCK_REGION_UNSUPPORTED",
  "BEDROCK_ACCESS_DENIED",
  "BEDROCK_THROTTLED",
  "BEDROCK_TIMEOUT",
  "BEDROCK_ROUTE_UNAVAILABLE",
  "BEDROCK_ROUTE_REJECTED",
]);

const safeProviderMessage = (code: string, fallback: string) => ({
  PROVIDER_KEY_REQUIRED: "A provider API key is required",
  PROVIDER_ROUTE_INTEGRITY_FAILED: "The existing provider route cannot be safely rotated",
  PROVIDER_STATIC_CUTOVER_REQUIRED: "Restart the installation with retired provider routes removed before configuring this provider",
  PROVIDER_NOT_CONFIGURED: "That provider is not configured",
  PROVIDER_CREDENTIAL_REJECTED: "The provider API key or approved model access was rejected",
  PROVIDER_ROUTE_FAILED: "The provider route could not be configured",
  PROVIDER_GATEWAY_UNAVAILABLE: "The provider gateway is unavailable",
  PROVIDER_CONFIGURATION_FAILED: "The provider configuration could not be validated",
  PROVIDER_TEST_FAILED: "The provider test could not be completed",
  PROVIDER_CONFIGURATION_INVALID: "The Bedrock selection metadata is invalid; disable and reconnect the provider",
  BEDROCK_ROUTE_UNAPPROVED: "The selected Bedrock region or inference profile is not approved",
  BEDROCK_ROUTE_RECONFIGURATION_REQUIRED: "Disable and reconnect Bedrock to change its approved region or inference profile",
  BEDROCK_API_KEY_INVALID: "Bedrock rejected the API key",
  BEDROCK_MODEL_ACCESS_REQUIRED: "Enable the approved model and accept its applicable Bedrock terms before retrying",
  BEDROCK_REGION_UNSUPPORTED: "The approved Bedrock inference profile is not available in that region",
  BEDROCK_ACCESS_DENIED: "Bedrock denied access to the approved route",
  BEDROCK_THROTTLED: "Bedrock is throttling this route; retry shortly",
  BEDROCK_TIMEOUT: "Bedrock did not respond before the route timeout",
  BEDROCK_ROUTE_UNAVAILABLE: "The Bedrock route is temporarily unavailable",
  BEDROCK_ROUTE_REJECTED: "Bedrock rejected the route configuration or test request",
}[code] ?? fallback);

const safeProviderError = (
  error: unknown,
  fallbackCode: "PROVIDER_CONFIGURATION_FAILED" | "PROVIDER_TEST_FAILED",
  message: string,
) => {
  if (error instanceof OneComputerError && safeProviderErrorCodes.has(error.code)) {
    return new OneComputerError(
      error.code,
      safeProviderMessage(error.code, message),
      error.statusCode,
      error.retryable,
    );
  }
  return new OneComputerError(fallbackCode, message, 502, true);
};

const safeErrorCode = (error: unknown) => {
  const normalized = safeProviderError(error, "PROVIDER_TEST_FAILED", "The provider test could not be completed");
  return normalized.code;
};

export class ProviderSettingsService {
  constructor(
    private readonly store: ProviderSettingsStore,
    private readonly gateway: ProviderAdministrationGateway,
  ) {}

  async list(actor: Pick<SessionPrincipal, "tenantId">) {
    const records = new Map((await this.store.listProviderSettings(actor.tenantId))
      .map((record) => [record.provider, record] as const));
    return {
      providers: managedProviderNames.map((provider) => toView(provider, records.get(provider) ?? null)),
    };
  }

  async assertConfigured(actor: Pick<SessionPrincipal, "tenantId">, modelAlias: string) {
    const provider = managedProviderForAlias(modelAlias);
    if (!provider) return;
    await this.activeRecord(actor, provider);
  }

  async configure(actor: SessionPrincipal, input: ProviderSettingInput) {
    const provider = input.provider;
    const current = await this.store.getProviderSetting(actor.tenantId, provider);
    if (input.provider === "bedrock" && current?.state === "active") {
      const existing = this.requireBedrockSelection(current);
      if (existing.region !== input.region || existing.modelProfileId !== input.modelProfileId) {
        throw new OneComputerError(
          "BEDROCK_ROUTE_RECONFIGURATION_REQUIRED",
          "Disable and reconnect Bedrock to change its approved region or inference profile",
          409,
        );
      }
    }
    const existingModelIds = current?.state === "active" ? current.modelIds : [];
    let route;
    try {
      route = await this.gateway.configureManagedProvider(input.provider === "bedrock"
        ? {
          tenantId: actor.tenantId,
          provider: input.provider,
          apiKey: input.apiKey,
          region: input.region,
          modelProfileId: input.modelProfileId,
          existingModelIds,
        }
        : {
          tenantId: actor.tenantId,
          provider: input.provider,
          apiKey: input.apiKey,
          existingModelIds,
        });
    } catch (error) {
      throw safeProviderError(error, "PROVIDER_CONFIGURATION_FAILED", "The provider configuration could not be validated");
    }

    try {
      const saved = await this.store.saveProviderSetting({
        tenantId: actor.tenantId,
        provider,
        modelIds: route.modelIds,
        configuration: route.configuration,
        state: "active",
        credentialFingerprint: route.credentialFingerprint,
        lastTestedAt: new Date(),
        lastErrorCode: null,
        updatedBy: actor.userId,
      });
      return toView(provider, saved);
    } catch {
      if (current?.state !== "active") {
        await this.gateway.deleteManagedProvider({
          tenantId: actor.tenantId,
          provider,
          existingModelIds: route.modelIds,
        }).catch(() => undefined);
      }
      throw new OneComputerError(
        "PROVIDER_CONFIGURATION_RECONCILIATION_REQUIRED",
        "The provider route changed but its settings could not be recorded. Reopen Provider settings before retrying.",
        503,
        true,
      );
    }
  }

  async test(actor: SessionPrincipal, provider: ManagedProviderName) {
    const current = await this.activeRecord(actor, provider);
    try {
      await this.gateway.testManagedProvider({
        tenantId: actor.tenantId,
        provider,
        existingModelIds: current.modelIds,
      });
    } catch (error) {
      const normalized = safeProviderError(error, "PROVIDER_TEST_FAILED", "The provider test could not be completed");
      await this.store.saveProviderSetting({
        tenantId: current.tenantId,
        provider,
        modelIds: current.modelIds,
        configuration: current.configuration,
        state: current.state,
        credentialFingerprint: current.credentialFingerprint,
        lastTestedAt: current.lastTestedAt,
        lastErrorCode: safeErrorCode(normalized),
        updatedBy: actor.userId,
      }).catch(() => undefined);
      throw normalized;
    }

    try {
      const saved = await this.store.saveProviderSetting({
        tenantId: current.tenantId,
        provider,
        modelIds: current.modelIds,
        configuration: current.configuration,
        state: current.state,
        credentialFingerprint: current.credentialFingerprint,
        lastTestedAt: new Date(),
        lastErrorCode: null,
        updatedBy: actor.userId,
      });
      return toView(provider, saved);
    } catch {
      throw new OneComputerError(
        "PROVIDER_TEST_RECONCILIATION_REQUIRED",
        "The provider test completed but its status could not be recorded.",
        503,
        true,
      );
    }
  }

  async disable(actor: SessionPrincipal, provider: ManagedProviderName) {
    const current = await this.activeRecord(actor, provider, false);
    try {
      await this.gateway.deleteManagedProvider({
        tenantId: actor.tenantId,
        provider,
        existingModelIds: current.modelIds,
      });
    } catch (error) {
      throw safeProviderError(error, "PROVIDER_CONFIGURATION_FAILED", "The provider could not be disabled");
    }
    try {
      const saved = await this.store.saveProviderSetting({
        tenantId: current.tenantId,
        provider,
        modelIds: [],
        configuration: current.configuration,
        state: "disabled",
        credentialFingerprint: null,
        lastTestedAt: current.lastTestedAt,
        lastErrorCode: null,
        updatedBy: actor.userId,
      });
      return toView(provider, saved);
    } catch {
      throw new OneComputerError(
        "PROVIDER_LIFECYCLE_RECONCILIATION_REQUIRED",
        "The provider route was removed but its settings could not be recorded.",
        503,
        true,
      );
    }
  }

  async remove(actor: SessionPrincipal, provider: ManagedProviderName) {
    const current = await this.store.getProviderSetting(actor.tenantId, provider);
    if (!current) throw new OneComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 404);
    if (current.state === "active") {
      try {
        await this.gateway.deleteManagedProvider({
          tenantId: actor.tenantId,
          provider,
          existingModelIds: current.modelIds,
        });
      } catch (error) {
        throw safeProviderError(error, "PROVIDER_CONFIGURATION_FAILED", "The provider could not be removed");
      }
    }
    const deleted = await this.store.deleteProviderSetting(actor.tenantId, provider);
    if (!deleted) {
      throw new OneComputerError(
        "PROVIDER_LIFECYCLE_RECONCILIATION_REQUIRED",
        "The provider route was removed but its settings could not be recorded.",
        503,
        true,
      );
    }
  }

  private requireBedrockSelection(record: ProviderSettingRecord): BedrockSelection {
    const selection = bedrockSelection(record.provider, record);
    if (selection) return selection;
    throw new OneComputerError(
      "PROVIDER_CONFIGURATION_INVALID",
      "The Bedrock selection metadata is invalid; disable and reconnect the provider",
      409,
    );
  }

  private async activeRecord(actor: Pick<SessionPrincipal, "tenantId">, provider: ManagedProviderName, requireValidBedrock = true) {
    const current = await this.store.getProviderSetting(actor.tenantId, provider);
    if (
      current?.state !== "active"
      || current.modelIds.length !== managedProviderModels[provider].length
    ) {
      throw new OneComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 409);
    }
    if (requireValidBedrock && provider === "bedrock") this.requireBedrockSelection(current);
    return current;
  }
}
