import { providerSettingMetadataSchema, type ProviderSettingMetadata } from "@onecomputer/contracts";
import pg from "pg";

export const managedProviderNames = ["openai", "anthropic", "bedrock"] as const;
export type ManagedProviderName = typeof managedProviderNames[number];
export type ProviderSettingState = "active" | "disabled";

export type ProviderSettingRecord = {
  tenantId: string;
  provider: ManagedProviderName;
  modelIds: string[];
  configuration: ProviderSettingMetadata;
  state: ProviderSettingState;
  credentialFingerprint: string | null;
  lastTestedAt: Date | null;
  lastErrorCode: string | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SaveProviderSetting = Omit<ProviderSettingRecord, "createdAt" | "updatedAt">;

export interface ProviderSettingsStore {
  listProviderSettings(tenantId: string): Promise<ProviderSettingRecord[]>;
  getProviderSetting(tenantId: string, provider: ManagedProviderName): Promise<ProviderSettingRecord | null>;
  saveProviderSetting(record: SaveProviderSetting): Promise<ProviderSettingRecord>;
  deleteProviderSetting(tenantId: string, provider: ManagedProviderName): Promise<boolean>;
}

const asStringArray = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];

const asConfiguration = (value: unknown): ProviderSettingMetadata => {
  const parsed = providerSettingMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
};

const mapRow = (row: Record<string, unknown>): ProviderSettingRecord => ({
  tenantId: String(row.tenant_id),
  provider: row.provider as ManagedProviderName,
  modelIds: asStringArray(row.model_ids),
  configuration: asConfiguration(row.configuration),
  state: row.state as ProviderSettingState,
  credentialFingerprint: typeof row.credential_fingerprint === "string" ? row.credential_fingerprint : null,
  lastTestedAt: row.last_tested_at ? new Date(String(row.last_tested_at)) : null,
  lastErrorCode: typeof row.last_error_code === "string" ? row.last_error_code : null,
  updatedBy: String(row.updated_by),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const values = (record: SaveProviderSetting) => [
  record.tenantId,
  record.provider,
  JSON.stringify(record.modelIds),
  JSON.stringify(record.configuration),
  record.state,
  record.credentialFingerprint,
  record.lastTestedAt,
  record.lastErrorCode,
  record.updatedBy,
];

export class PostgresProviderSettingsStore implements ProviderSettingsStore {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresProviderSettingsStore(new pg.Pool({ connectionString, max: 5 }));
  }

  async close() { await this.pool.end(); }

  async listProviderSettings(tenantId: string) {
    const result = await this.pool.query(
      "SELECT * FROM provider_settings WHERE tenant_id=$1 ORDER BY provider",
      [tenantId],
    );
    return result.rows.map(mapRow);
  }

  async getProviderSetting(tenantId: string, provider: ManagedProviderName) {
    const result = await this.pool.query(
      "SELECT * FROM provider_settings WHERE tenant_id=$1 AND provider=$2",
      [tenantId, provider],
    );
    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async saveProviderSetting(record: SaveProviderSetting) {
    const result = await this.pool.query(
      `INSERT INTO provider_settings (
         tenant_id,provider,model_ids,configuration,state,credential_fingerprint,last_tested_at,last_error_code,updated_by
       ) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id,provider) DO UPDATE SET
         model_ids=EXCLUDED.model_ids,
         configuration=EXCLUDED.configuration,
         state=EXCLUDED.state,
         credential_fingerprint=EXCLUDED.credential_fingerprint,
         last_tested_at=EXCLUDED.last_tested_at,
         last_error_code=EXCLUDED.last_error_code,
         updated_by=EXCLUDED.updated_by,
         updated_at=now()
       RETURNING *`,
      values(record),
    );
    return mapRow(result.rows[0]);
  }

  async deleteProviderSetting(tenantId: string, provider: ManagedProviderName) {
    const result = await this.pool.query(
      "DELETE FROM provider_settings WHERE tenant_id=$1 AND provider=$2",
      [tenantId, provider],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export class MemoryProviderSettingsStore implements ProviderSettingsStore {
  private readonly records = new Map<string, ProviderSettingRecord>();

  private key(tenantId: string, provider: ManagedProviderName) {
    return `${tenantId}:${provider}`;
  }

  async listProviderSettings(tenantId: string) {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }

  async getProviderSetting(tenantId: string, provider: ManagedProviderName) {
    return this.records.get(this.key(tenantId, provider)) ?? null;
  }

  async saveProviderSetting(record: SaveProviderSetting) {
    const key = this.key(record.tenantId, record.provider);
    const current = this.records.get(key);
    const now = new Date();
    const saved: ProviderSettingRecord = {
      ...record,
      modelIds: [...record.modelIds],
      configuration: { ...record.configuration },
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(key, saved);
    return saved;
  }

  async deleteProviderSetting(tenantId: string, provider: ManagedProviderName) {
    return this.records.delete(this.key(tenantId, provider));
  }
}
