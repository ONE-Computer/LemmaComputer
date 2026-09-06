import type { FoundryConfiguration, VertexConfiguration, FoundryProviderModelId, VertexProviderModelId } from "@lemmacomputer/contracts";
import { LemmaComputerError, providerSettingMetadataSchema, type AnthropicProviderModelId, type BedrockApiKeyModelProfileId, type BedrockApiKeyRegion, type GlmProviderModelId, type OpenAiProviderModelId, type ProviderEmissionsRegion, type ProviderModelId } from "@lemmacomputer/contracts";
import { managedProviderDeploymentDescriptors, managedProviderDisplayMetadata, managedProviderForAlias, managedProviderModel, managedProviderModelOptions, managedProviderModels, managedProviderNames, managedProviderSelectedModelIds, type ManagedProviderConfiguration, type ManagedProviderDeploymentDescriptor, type ManagedProviderModelCapabilities, type ManagedProviderName, type ProviderAdministrationGateway } from "@lemmacomputer/litellm-adapter";
import type { ProviderLifecycleExpectation, ProviderLifecycleRecord, ProviderSettingRecord, ProviderSettingsStore, SessionPrincipal } from "@lemmacomputer/workspace-store";
import { modelLimitsSchema } from "@lemmacomputer/contracts";

type EmissionsSelection = { emissionsRegion?: ProviderEmissionsRegion };
type DirectProviderInput<T extends ProviderModelId> = { apiKey: string } & EmissionsSelection & (
  | { modelId: T; modelIds?: never }
  | { modelId?: never; modelIds: T[] }
);

export type ProviderSettingInput =
  | ({ provider: "openai" } & DirectProviderInput<OpenAiProviderModelId>)
  | ({ provider: "anthropic" } & DirectProviderInput<AnthropicProviderModelId>)
  | ({ provider: "glm" } & DirectProviderInput<GlmProviderModelId>)
  | ({ provider: "foundry"; apiKey: string; modelIds: FoundryProviderModelId[]; foundry: FoundryConfiguration } & EmissionsSelection)
  | ({ provider: "vertex"; apiKey: string; modelIds: VertexProviderModelId[]; vertex: VertexConfiguration } & EmissionsSelection)
  | ({ provider: "bedrock"; apiKey: string; region: BedrockApiKeyRegion; modelProfileId: BedrockApiKeyModelProfileId } & EmissionsSelection);

type BedrockSelection = { region: BedrockApiKeyRegion; modelProfileId: BedrockApiKeyModelProfileId };

export type ProviderSettingView = {
  provider: ManagedProviderName;
  aliases: string[];
  primaryAlias: string;
  upstreamModelDisplayName: string;
  state: "active" | "disabled" | "not-configured" | "needs-reconfiguration";
  fingerprint: string | null;
  modelId: ProviderModelId | null;
  modelOptions: Array<{ id: ProviderModelId; displayName: string; modelCapabilities?: ManagedProviderModelCapabilities }>;
  selectedModelIds: ProviderModelId[];
  deployments: ManagedProviderDeploymentDescriptor[];
  region: string | null;
  foundry: FoundryConfiguration | null;
  vertex: VertexConfiguration | null;
  emissionsRegion: ProviderEmissionsRegion | null;
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

const providerModelSelection = (provider: ManagedProviderName, record: ProviderSettingRecord | null): ProviderModelId[] => {
  if (provider === "bedrock") return [];
  if (!record) return [];
  const parsed = providerSettingMetadataSchema.safeParse(record?.configuration ?? {});
  if (!parsed.success) return [];
  try {
    return managedProviderSelectedModelIds(provider, parsed.data);
  } catch {
    return [];
  }
};

const toView = (provider: ManagedProviderName, record: ProviderSettingRecord | null): ProviderSettingView => {
  const selection = bedrockSelection(provider, record);
  const selectedModelIds = providerModelSelection(provider, record);
  const modelId = selectedModelIds[0] ?? null;
  const providerModel = provider !== "bedrock" && modelId ? managedProviderModel(provider, modelId) : null;
  const needsReconfiguration = record?.state === "active" && (
    provider === "bedrock" ? !selection : selectedModelIds.length === 0
      || ((provider === "foundry" || provider === "vertex") && !record.configuration[provider])
  );
  const configuration = providerSettingMetadataSchema.safeParse(record?.configuration ?? {});
  const deployments = record?.state === "active" && !needsReconfiguration && configuration.success
    ? managedProviderDeploymentDescriptors(record.tenantId, provider, configuration.data)
    : [];
  return {
    provider,
    aliases: managedProviderModels[provider].map((model) => model.alias),
    primaryAlias: managedProviderDisplayMetadata[provider].primaryAlias,
    upstreamModelDisplayName: providerModel?.displayName ?? managedProviderDisplayMetadata[provider].upstreamModelDisplayName,
    state: !record ? "not-configured" : needsReconfiguration ? "needs-reconfiguration" : record.state,
    fingerprint: record?.credentialFingerprint ?? null,
    modelId,
    modelOptions: provider === "bedrock" ? [] : managedProviderModelOptions(provider),
    region: selection?.region ?? (configuration.success ? configuration.data.vertex?.location : null) ?? null,
    foundry: configuration.success ? configuration.data.foundry ?? null : null,
    vertex: configuration.success ? configuration.data.vertex ?? null : null,
    emissionsRegion: configuration.success ? configuration.data.emissionsRegion ?? null : null,
    selectedModelIds,
    deployments,
    modelProfileId: selection?.modelProfileId ?? null,
    lastTestedAt: record?.lastTestedAt?.toISOString() ?? null,
    lastErrorCode: needsReconfiguration ? "PROVIDER_CONFIGURATION_INVALID" : record?.lastErrorCode ?? null,
    updatedAt: record?.updatedAt.toISOString() ?? null,
  };
};
const safeProviderErrorCodes = new Set([
  "PROVIDER_KEY_REQUIRED",
  "PROVIDER_RECONNECTION_REQUIRED",
  "PROVIDER_ROUTE_INTEGRITY_FAILED",
  "PROVIDER_STATIC_CUTOVER_REQUIRED",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_CREDENTIAL_REJECTED",
  "PROVIDER_TEST_REQUEST_REJECTED",
  "PROVIDER_THROTTLED",
  "PROVIDER_MODEL_UNAPPROVED",
  "PROVIDER_ROUTE_FAILED",
  "PROVIDER_GATEWAY_UNAVAILABLE",
  "PROVIDER_CONFIGURATION_FAILED",
  "PROVIDER_TEST_FAILED",
  "PROVIDER_CONFIGURATION_INVALID",
  "PROVIDER_LIFECYCLE_FENCED",
  "PROVIDER_LIFECYCLE_RECONCILIATION_REQUIRED",
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
  PROVIDER_RECONNECTION_REQUIRED: "Disconnect and reconnect the provider before changing its endpoint, project, location, or existing deployment names",
  PROVIDER_KEY_REQUIRED: "A provider API key is required",
  PROVIDER_ROUTE_INTEGRITY_FAILED: "The existing provider route cannot be safely rotated",
  PROVIDER_STATIC_CUTOVER_REQUIRED: "Restart the installation with retired provider routes removed before configuring this provider",
  PROVIDER_NOT_CONFIGURED: "That provider is not configured",
  PROVIDER_CREDENTIAL_REJECTED: "The provider rejected the API key or selected upstream model",
  PROVIDER_TEST_REQUEST_REJECTED: "The provider rejected the route test request",
  PROVIDER_THROTTLED: "The provider throttled the route test; retry shortly",
  PROVIDER_MODEL_UNAPPROVED: "The selected provider model is not approved",
  PROVIDER_ROUTE_FAILED: "The provider route could not be configured",
  PROVIDER_GATEWAY_UNAVAILABLE: "The provider gateway is unavailable",
  PROVIDER_CONFIGURATION_FAILED: "The provider configuration could not be validated",
  PROVIDER_TEST_FAILED: "The provider test could not be completed",
  PROVIDER_CONFIGURATION_INVALID: "The provider selection metadata is invalid; disable and reconnect the provider",
  PROVIDER_LIFECYCLE_FENCED: "The provider changed state while this operation was running",
  PROVIDER_LIFECYCLE_RECONCILIATION_REQUIRED: "The provider is disabled, but gateway cleanup needs reconciliation",
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
  if (error instanceof LemmaComputerError && safeProviderErrorCodes.has(error.code)) {
    return new LemmaComputerError(
      error.code,
      safeProviderMessage(error.code, message),
      error.statusCode,
      error.retryable,
    );
  }
  return new LemmaComputerError(fallbackCode, message, 502, true);
};

const safeErrorCode = (error: unknown) => {
  const normalized = safeProviderError(error, "PROVIDER_TEST_FAILED", "The provider test could not be completed");
  return normalized.code;
};

const lifecycleErrorCode = (error: unknown) => (
  error instanceof LemmaComputerError ? error.code : "PROVIDER_ROUTE_FAILED"
);

type WorkspaceGrantRevocation = { revoked: number; failed: number };
type ProviderLifecycleOptions = {
  revokeWorkspaceGrants?: (tenantId: string, provider: ManagedProviderName) => Promise<WorkspaceGrantRevocation>;
};

export class ProviderSettingsService {
  constructor(
    private readonly store: ProviderSettingsStore,
    private readonly gateway: ProviderAdministrationGateway,
    private readonly lifecycleOptions: ProviderLifecycleOptions = {},
  ) {}

  async list(actor: Pick<SessionPrincipal, "tenantId">) {
    const records = new Map((await this.store.listProviderSettings(actor.tenantId))
      .map((record) => [record.provider, record] as const));
    return {
      providers: managedProviderNames.map((provider) => toView(provider, records.get(provider) ?? null)),
    };
  }

  async saveModelLimits(actor: SessionPrincipal, provider: ManagedProviderName, deploymentId: string, limits: { contextTokens: number; outputTokens: number }) {
    limits = modelLimitsSchema.parse(limits);
    return this.store.withProviderLifecycleLock(actor.tenantId, provider, async () => {
      const current = await this.activeRecord(actor, provider);
      const deployment = toView(provider, current).deployments.find((item) => item.id === deploymentId);
      if (!deployment) throw new LemmaComputerError("MODEL_DEPLOYMENT_NOT_FOUND", "Model deployment not found", 404);
      const lifecycle = await this.store.ensureProviderLifecycle({ tenantId: actor.tenantId, provider, updatedBy: actor.userId });
      const saved = await this.store.saveProviderSettingIfCurrent({
        expected: this.expectation(lifecycle),
        record: {
          ...current,
          updatedBy: actor.userId,
          configuration: {
            ...current.configuration,
            modelLimits: { ...current.configuration.modelLimits, [deployment.providerDeployment]: limits },
          },
        },
      });
      if (!saved) throw new LemmaComputerError("PROVIDER_LIFECYCLE_FENCED", "Provider changed; reload before retrying", 409);
      await this.recordLifecycleEvent(lifecycle, "model-limits-updated", actor.userId, { deploymentId, ...limits });
      return toView(provider, saved);
    });
  }

  async assertConfigured(actor: Pick<SessionPrincipal, "tenantId">, modelAlias: string) {
    const provider = managedProviderForAlias(modelAlias);
    if (!provider) return;
    const lifecycle = await this.store.getProviderLifecycle(actor.tenantId, provider);
    if (lifecycle && lifecycle.desiredState !== "active") {
      throw new LemmaComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 409);
    }
    await this.activeRecord(actor, provider);
  }

  async configure(actor: SessionPrincipal, input: ProviderSettingInput) {
    const provider = input.provider;
    return this.store.withProviderLifecycleLock(actor.tenantId, provider, async () => {
      const lifecycle = await this.store.beginProviderLifecycle({
        tenantId: actor.tenantId,
        provider,
        updatedBy: actor.userId,
      });
      if (!lifecycle) {
        throw new LemmaComputerError(
          "PROVIDER_LIFECYCLE_FENCED",
          "The provider is still being disabled; reconcile it before configuring again",
          409,
          true,
        );
      }
      const current = await this.store.getProviderSetting(actor.tenantId, provider);
      if (input.provider === "bedrock" && current?.state === "active") {
        const existing = this.requireBedrockSelection(current);
        if (existing.region !== input.region || existing.modelProfileId !== input.modelProfileId) {
          throw new LemmaComputerError(
            "BEDROCK_ROUTE_RECONFIGURATION_REQUIRED",
            "Disable and reconnect Bedrock to change its approved region or inference profile",
            409,
          );
        }
      }
      if (current?.state === "active" && (input.provider === "foundry" || input.provider === "vertex")) {
        const previous = providerSettingMetadataSchema.safeParse(current.configuration);
        const unchanged = previous.success && (input.provider === "vertex"
          ? previous.data.vertex?.projectId === input.vertex.projectId && previous.data.vertex?.location === input.vertex.location
          : previous.data.foundry?.endpoint === input.foundry.endpoint
            && input.modelIds.every((id) => !previous.data.foundry?.deployments[id]
              || previous.data.foundry.deployments[id] === input.foundry.deployments[id]));
        if (!unchanged) throw new LemmaComputerError("PROVIDER_RECONNECTION_REQUIRED", "Disconnect and reconnect the provider before changing its endpoint, project, location, or existing deployment names", 409);
      }
      const existingModelIds = current?.state === "active" ? current.modelIds : [];
      let route;
      try {
        const gatewayInput: ManagedProviderConfiguration = input.provider === "foundry" || input.provider === "vertex"
          ? { ...input, tenantId: actor.tenantId, existingModelIds, configuration: current?.configuration }
          : input.provider === "bedrock"
          ? {
            tenantId: actor.tenantId,
            provider: input.provider,
            apiKey: input.apiKey,
            region: input.region,
            modelProfileId: input.modelProfileId,
            existingModelIds,
            configuration: current?.configuration,
          }
          : input.provider === "openai"
          ? {
            tenantId: actor.tenantId,
            provider: input.provider,
            apiKey: input.apiKey,
            ...(input.modelIds ? { modelIds: input.modelIds } : { modelId: input.modelId }),
            existingModelIds,
            configuration: current?.configuration,
          }
          : input.provider === "anthropic"
          ? {
            tenantId: actor.tenantId,
            provider: input.provider,
            apiKey: input.apiKey,
            ...(input.modelIds ? { modelIds: input.modelIds } : { modelId: input.modelId }),
            existingModelIds,
            configuration: current?.configuration,
          }
          : {
            tenantId: actor.tenantId,
            provider: input.provider,
            apiKey: input.apiKey,
            ...(input.modelIds ? { modelIds: input.modelIds } : { modelId: input.modelId }),
            existingModelIds,
            configuration: current?.configuration,
          };
        route = await this.gateway.configureManagedProvider(gatewayInput);
      } catch (error) {
        await this.recordLifecycleEvent(lifecycle, "configuration-failed", actor.userId, {
          errorCode: lifecycleErrorCode(error),
        });
        throw safeProviderError(error, "PROVIDER_CONFIGURATION_FAILED", "The provider configuration could not be validated");
      }

      const currentMetadata = providerSettingMetadataSchema.safeParse(current?.configuration ?? {});
      const emissionsRegion = input.emissionsRegion
        ?? (currentMetadata.success ? currentMetadata.data.emissionsRegion : undefined);
      let saved: ProviderSettingRecord | null;
      try {
        saved = await this.store.saveProviderSettingIfCurrent({
          record: {
            tenantId: actor.tenantId,
            provider,
            modelIds: route.modelIds,
            configuration: {
              ...route.configuration,
              ...(currentMetadata.success && currentMetadata.data.modelLimits ? { modelLimits: currentMetadata.data.modelLimits } : {}),
              ...(emissionsRegion ? { emissionsRegion } : {}),
            },
            state: "active",
            credentialFingerprint: route.credentialFingerprint,
            lastTestedAt: new Date(),
            lastErrorCode: null,
            updatedBy: actor.userId,
          },
          expected: this.expectation(lifecycle),
        });
      } catch {
        await this.cleanupFencedRoute(actor, provider, lifecycle, route.modelIds);
        throw new LemmaComputerError(
          "PROVIDER_CONFIGURATION_RECONCILIATION_REQUIRED",
          "The provider route changed but its settings could not be recorded. Reopen Provider settings before retrying.",
          503,
          true,
        );
      }
      if (!saved) {
        await this.cleanupFencedRoute(actor, provider, lifecycle, route.modelIds);
        throw new LemmaComputerError(
          "PROVIDER_LIFECYCLE_FENCED",
          "The provider changed state while this operation was running",
          409,
          true,
        );
      }
      await this.recordLifecycleEvent(lifecycle, "configuration-recorded", actor.userId);
      return toView(provider, saved);
    });
  }

  async test(actor: SessionPrincipal, provider: ManagedProviderName) {
    return this.store.withProviderLifecycleLock(actor.tenantId, provider, async () => {
      const lifecycle = await this.store.ensureProviderLifecycle({
        tenantId: actor.tenantId,
        provider,
        updatedBy: actor.userId,
      });
      if (lifecycle.desiredState !== "active") {
        throw new LemmaComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 409);
      }
      const current = await this.activeRecord(actor, provider);
      try {
        await this.gateway.testManagedProvider({
          tenantId: actor.tenantId,
          provider,
          existingModelIds: current.modelIds,
          configuration: current.configuration,
        });
      } catch (error) {
        const normalized = safeProviderError(error, "PROVIDER_TEST_FAILED", "The provider test could not be completed");
        const saved = await this.store.saveProviderSettingIfCurrent({
          record: {
            tenantId: current.tenantId,
            provider,
            modelIds: current.modelIds,
            configuration: current.configuration,
            state: current.state,
            credentialFingerprint: current.credentialFingerprint,
            lastTestedAt: current.lastTestedAt,
            lastErrorCode: safeErrorCode(normalized),
            updatedBy: actor.userId,
          },
          expected: this.expectation(lifecycle),
        }).catch(() => null);
        await this.recordLifecycleEvent(lifecycle, saved ? "test-failed" : "test-fenced", actor.userId, {
          errorCode: safeErrorCode(normalized),
        });
        throw normalized;
      }

      let saved: ProviderSettingRecord | null;
      try {
        saved = await this.store.saveProviderSettingIfCurrent({
          record: {
            tenantId: current.tenantId,
            provider,
            modelIds: current.modelIds,
            configuration: current.configuration,
            state: current.state,
            credentialFingerprint: current.credentialFingerprint,
            lastTestedAt: new Date(),
            lastErrorCode: null,
            updatedBy: actor.userId,
          },
          expected: this.expectation(lifecycle),
        });
      } catch {
        throw new LemmaComputerError(
          "PROVIDER_TEST_RECONCILIATION_REQUIRED",
          "The provider test completed but its status could not be recorded.",
          503,
          true,
        );
      }
      if (!saved) {
        await this.recordLifecycleEvent(lifecycle, "test-fenced", actor.userId);
        throw new LemmaComputerError(
          "PROVIDER_LIFECYCLE_FENCED",
          "The provider changed state while this operation was running",
          409,
          true,
        );
      }
      await this.recordLifecycleEvent(lifecycle, "test-recorded", actor.userId);
      return toView(provider, saved);
    });
  }

  async disable(actor: SessionPrincipal, provider: ManagedProviderName) {
    const fenced = await this.store.fenceProviderDisabled({
      tenantId: actor.tenantId,
      provider,
      updatedBy: actor.userId,
    });
    const workspaceGrants = await this.revokeWorkspaceGrants(actor.tenantId, provider);
    // The fence and grant revocation deliberately happen before this wait. The
    // lock only serializes the subsequent upstream cleanup with an explicit
    // later configure, so old cleanup cannot delete a newly enabled route.
    await this.store.withProviderLifecycleLock(actor.tenantId, provider, async () => {
      await this.reconcileFencedLifecycle(actor, provider, fenced.lifecycle);
    });
    return {
      provider: toView(provider, fenced.setting),
      workspaceGrants,
    };
  }

  async remove(actor: SessionPrincipal, provider: ManagedProviderName) {
    return this.store.withProviderLifecycleLock(actor.tenantId, provider, async () => {
      const [current, lifecycle] = await Promise.all([
        this.store.getProviderSetting(actor.tenantId, provider),
        this.store.getProviderLifecycle(actor.tenantId, provider),
      ]);
      // Keep the established API contract for a provider that has never had
      // either local state or a lifecycle fence. A pre-existing fence is
      // intentionally retryable: it may still carry gateway cleanup work.
      if (!current && !lifecycle) {
        throw new LemmaComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 404);
      }
      const fenced = await this.store.fenceProviderDeleted({
        tenantId: actor.tenantId,
        provider,
        updatedBy: actor.userId,
      });
      const workspaceGrants = await this.revokeWorkspaceGrants(actor.tenantId, provider);
      await this.reconcileFencedLifecycle(actor, provider, fenced.lifecycle);
      return { workspaceGrants };
    });
  }

  async reconcile(actor: SessionPrincipal, provider: ManagedProviderName) {
    return this.store.withProviderLifecycleLock(actor.tenantId, provider, async () => {
      const lifecycle = await this.store.getProviderLifecycle(actor.tenantId, provider);
      if (!lifecycle || lifecycle.desiredState === "active") {
        throw new LemmaComputerError("PROVIDER_LIFECYCLE_NOT_RECONCILABLE", "That provider does not require lifecycle reconciliation", 409);
      }
      const workspaceGrants = await this.revokeWorkspaceGrants(actor.tenantId, provider);
      await this.reconcileFencedLifecycle(actor, provider, lifecycle);
      const setting = await this.store.getProviderSetting(actor.tenantId, provider);
      return { provider: toView(provider, setting), workspaceGrants };
    });
  }

  private expectation(lifecycle: ProviderLifecycleRecord): ProviderLifecycleExpectation {
    return {
      tenantId: lifecycle.tenantId,
      provider: lifecycle.provider,
      generation: lifecycle.generation,
      desiredState: lifecycle.desiredState,
    };
  }

  private async cleanupFencedRoute(
    actor: SessionPrincipal,
    provider: ManagedProviderName,
    source: ProviderLifecycleRecord,
    modelIds: string[],
  ) {
    const current = await this.store.getProviderLifecycle(actor.tenantId, provider);
    if (!current || current.generation === source.generation || current.desiredState === "active") return;
    const expected = this.expectation(current);
    const appended = await this.store.appendProviderLifecycleCleanup({
      ...expected,
      modelIds,
      updatedBy: actor.userId,
    });
    if (!appended) return;
    try {
      await this.gateway.deleteManagedProvider({
        tenantId: actor.tenantId,
        provider,
        existingModelIds: modelIds,
        configuration: undefined,
      });
      await this.store.completeProviderLifecycleCleanup({
        ...expected,
        modelIds,
        updatedBy: actor.userId,
      });
    } catch (error) {
      await this.store.markProviderLifecycleReconciliationPending({
        ...expected,
        errorCode: lifecycleErrorCode(error),
        updatedBy: actor.userId,
      }).catch(() => undefined);
    }
  }

  private async reconcileFencedLifecycle(actor: SessionPrincipal, provider: ManagedProviderName, lifecycle: ProviderLifecycleRecord) {
    const current = await this.store.getProviderLifecycle(actor.tenantId, provider);
    if (!current || current.desiredState === "active" || !this.matchesLifecycle(current, lifecycle)) return;
    const expected = this.expectation(current);
    const pending = current.pendingCleanupModelIds;
    if (!pending.length) {
      await this.store.completeProviderLifecycleCleanup({
        ...expected,
        modelIds: [],
        updatedBy: actor.userId,
      }).catch(() => undefined);
      return;
    }
    try {
      await this.gateway.deleteManagedProvider({
        tenantId: actor.tenantId,
        provider,
        existingModelIds: pending,
      });
    } catch (error) {
      await this.store.markProviderLifecycleReconciliationPending({
        ...expected,
        errorCode: lifecycleErrorCode(error),
        updatedBy: actor.userId,
      }).catch(() => undefined);
      throw new LemmaComputerError(
        "PROVIDER_LIFECYCLE_RECONCILIATION_REQUIRED",
        "The provider is disabled, but gateway cleanup needs reconciliation",
        503,
        true,
      );
    }
    await this.store.completeProviderLifecycleCleanup({
      ...expected,
      modelIds: pending,
      updatedBy: actor.userId,
    });
  }

  private async revokeWorkspaceGrants(tenantId: string, provider: ManagedProviderName) {
    try {
      return await this.lifecycleOptions.revokeWorkspaceGrants?.(tenantId, provider) ?? { revoked: 0, failed: 0 };
    } catch {
      return { revoked: 0, failed: 1 };
    }
  }

  private async recordLifecycleEvent(
    lifecycle: ProviderLifecycleRecord,
    eventKey: string,
    actorUserId: string,
    details?: Record<string, unknown>,
  ) {
    await this.store.recordProviderLifecycleEvent({
      ...this.expectation(lifecycle),
      eventKey,
      actorUserId,
      ...(details ? { details } : {}),
    }).catch(() => undefined);
  }

  private matchesLifecycle(current: ProviderLifecycleRecord, expected: ProviderLifecycleRecord) {
    return current.tenantId === expected.tenantId
      && current.provider === expected.provider
      && current.generation === expected.generation
      && current.desiredState === expected.desiredState;
  }

  private requireBedrockSelection(record: ProviderSettingRecord): BedrockSelection {
    const selection = bedrockSelection(record.provider, record);
    if (selection) return selection;
    throw new LemmaComputerError(
      "PROVIDER_CONFIGURATION_INVALID",
      "The provider selection metadata is invalid; disable and reconnect the provider",
      409,
    );
  }

  private async activeRecord(actor: Pick<SessionPrincipal, "tenantId">, provider: ManagedProviderName, requireValidBedrock = true) {
    const current = await this.store.getProviderSetting(actor.tenantId, provider);
    if (
      current?.state !== "active"
      || current.modelIds.length === 0
    ) {
      throw new LemmaComputerError("PROVIDER_NOT_CONFIGURED", "That provider is not configured", 409);
    }
    if (requireValidBedrock && provider === "bedrock") this.requireBedrockSelection(current);
    return current;
  }
}
