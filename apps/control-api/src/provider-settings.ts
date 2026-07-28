import { OneComputerError } from "@onecomputer/contracts";
import { managedProviderModels, managedProviderNames, type ManagedProviderName, type ProviderAdministrationGateway } from "@onecomputer/litellm-adapter";
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
