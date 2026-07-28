import { OneComputerError } from "@onecomputer/contracts";
import { managedProviderForAlias, managedProviderModels, managedProviderNames, type ManagedProviderName, type ProviderAdministrationGateway } from "@onecomputer/litellm-adapter";
import type { ProviderSettingRecord, ProviderSettingsStore, SessionPrincipal } from "@onecomputer/workspace-store";

export type ProviderSettingView = {
  provider: ManagedProviderName;
  aliases: string[];
  state: "active" | "disabled" | "not-configured";
  fingerprint: string | null;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string | null;
};

const toView = (provider: ManagedProviderName, record: ProviderSettingRecord | null): ProviderSettingView => ({
  provider,
  aliases: managedProviderModels[provider].map((model) => model.alias),
  state: record?.state ?? "not-configured",
  fingerprint: record?.credentialFingerprint ?? null,
  lastTestedAt: record?.lastTestedAt?.toISOString() ?? null,
  lastErrorCode: record?.lastErrorCode ?? null,
  updatedAt: record?.updatedAt.toISOString() ?? null,
});
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
    const record = await this.store.getProviderSetting(actor.tenantId, provider);
    if (
      record?.state !== "active"
      || record.modelIds.length !== managedProviderModels[provider].length
    ) {
      throw new OneComputerError(
        "PROVIDER_NOT_CONFIGURED",
        "The selected model provider is not configured for this organization",
        409,
      );
    }
  }

  async configure(actor: SessionPrincipal, provider: ManagedProviderName, apiKey: string) {
    const current = await this.store.getProviderSetting(actor.tenantId, provider);
    let route;
    try {
      route = await this.gateway.configureManagedProvider({
        tenantId: actor.tenantId,
        provider,
        apiKey,
        existingModelIds: current?.state === "active" ? current.modelIds : [],
      });
    } catch (error) {
      throw safeProviderError(error, "PROVIDER_CONFIGURATION_FAILED", "The provider configuration could not be validated");
    }

    try {
      const saved = await this.store.saveProviderSetting({
        tenantId: actor.tenantId,
        provider,
        modelIds: route.modelIds,
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
    const current = await this.activeRecord(actor, provider);
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

  private async activeRecord(actor: SessionPrincipal, provider: ManagedProviderName) {
    const current = await this.store.getProviderSetting(actor.tenantId, provider);
    if (
      current?.state !== "active"
      || current.modelIds.length !== managedProviderModels[provider].length
    ) {
      throw new OneComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 409);
    }
    return current;
  }
}
