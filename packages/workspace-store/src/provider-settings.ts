import { providerModelCatalogSchema, type ProviderModelCatalog } from "@lemmacomputer/contracts";
import { providerSettingMetadataSchema, type ProviderSettingMetadata } from "@lemmacomputer/contracts";
import pg from "pg";

export const managedProviderNames = ["openai", "anthropic", "glm", "bedrock", "foundry", "vertex"] as const;
export type ManagedProviderName = typeof managedProviderNames[number];
export type ProviderSettingState = "active" | "disabled";
export type ProviderLifecycleDesiredState = "active" | "disabled" | "deleted";
export type ProviderLifecycleReconciliationStatus = "not_required" | "pending";

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

export type ProviderLifecycleRecord = {
  tenantId: string;
  provider: ManagedProviderName;
  generation: number;
  desiredState: ProviderLifecycleDesiredState;
  pendingCleanupModelIds: string[];
  reconciliationStatus: ProviderLifecycleReconciliationStatus;
  reconciliationErrorCode: string | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ProviderLifecycleExpectation = Pick<ProviderLifecycleRecord, "tenantId" | "provider" | "generation" | "desiredState">;
export type SaveProviderSetting = Omit<ProviderSettingRecord, "createdAt" | "updatedAt">;
export type ProviderLifecycleFenceResult = {
  lifecycle: ProviderLifecycleRecord;
  setting: ProviderSettingRecord | null;
};

export interface ProviderSettingsStore {
  getModelCatalog(tenantId: string, provider: ManagedProviderName, targetHash: string): Promise<ProviderModelCatalog | null>;
  saveModelCatalog(tenantId: string, provider: ManagedProviderName, targetHash: string, catalog: ProviderModelCatalog): Promise<void>;
  listProviderSettings(tenantId: string): Promise<ProviderSettingRecord[]>;
  getProviderSetting(tenantId: string, provider: ManagedProviderName): Promise<ProviderSettingRecord | null>;
  saveProviderSetting(record: SaveProviderSetting): Promise<ProviderSettingRecord>;
  deleteProviderSetting(tenantId: string, provider: ManagedProviderName): Promise<boolean>;
  withProviderLifecycleLock<T>(tenantId: string, provider: ManagedProviderName, operation: () => Promise<T>): Promise<T>;
  ensureProviderLifecycle(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }): Promise<ProviderLifecycleRecord>;
  beginProviderLifecycle(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }): Promise<ProviderLifecycleRecord | null>;
  getProviderLifecycle(tenantId: string, provider: ManagedProviderName): Promise<ProviderLifecycleRecord | null>;
  fenceProviderDisabled(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }): Promise<ProviderLifecycleFenceResult>;
  fenceProviderDeleted(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }): Promise<ProviderLifecycleFenceResult>;
  saveProviderSettingIfCurrent(input: { record: SaveProviderSetting; expected: ProviderLifecycleExpectation }): Promise<ProviderSettingRecord | null>;
  deleteProviderSettingIfCurrent(expected: ProviderLifecycleExpectation): Promise<boolean>;
  appendProviderLifecycleCleanup(input: ProviderLifecycleExpectation & { modelIds: string[]; updatedBy: string }): Promise<boolean>;
  completeProviderLifecycleCleanup(input: ProviderLifecycleExpectation & { modelIds: string[]; updatedBy: string }): Promise<boolean>;
  markProviderLifecycleReconciliationPending(input: ProviderLifecycleExpectation & { errorCode: string; updatedBy: string }): Promise<boolean>;
  recordProviderLifecycleEvent(input: ProviderLifecycleExpectation & { eventKey: string; actorUserId: string; details?: Record<string, unknown> }): Promise<void>;
}

const asStringArray = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];

const uniqueModelIds = (modelIds: string[]) => [...new Set(modelIds)].slice(0, 256);

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

const mapLifecycleRow = (row: Record<string, unknown>): ProviderLifecycleRecord => ({
  tenantId: String(row.tenant_id),
  provider: row.provider as ManagedProviderName,
  generation: Number(row.generation),
  desiredState: row.desired_state as ProviderLifecycleDesiredState,
  pendingCleanupModelIds: asStringArray(row.pending_cleanup_model_ids),
  reconciliationStatus: row.reconciliation_status as ProviderLifecycleReconciliationStatus,
  reconciliationErrorCode: typeof row.reconciliation_error_code === "string" ? row.reconciliation_error_code : null,
  updatedBy: String(row.updated_by),
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

const cloneSetting = (record: ProviderSettingRecord): ProviderSettingRecord => ({
  ...record,
  modelIds: [...record.modelIds],
  configuration: { ...record.configuration },
  lastTestedAt: record.lastTestedAt ? new Date(record.lastTestedAt) : null,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

const cloneLifecycle = (record: ProviderLifecycleRecord): ProviderLifecycleRecord => ({
  ...record,
  pendingCleanupModelIds: [...record.pendingCleanupModelIds],
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
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

const saveProviderSettingSql = `INSERT INTO provider_settings (
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
RETURNING *`;

export class PostgresProviderSettingsStore implements ProviderSettingsStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly lifecycleLockPool: pg.Pool = pool,
  ) {}

  static fromConnectionString(connectionString: string) {
    return new PostgresProviderSettingsStore(
      new pg.Pool({ connectionString, max: 5 }),
      new pg.Pool({ connectionString, max: 5 }),
    );
  }

  async close() {
    if (this.lifecycleLockPool === this.pool) {
      await this.pool.end();
      return;
    }
    await Promise.all([this.pool.end(), this.lifecycleLockPool.end()]);
  }

  async getModelCatalog(tenantId: string, provider: ManagedProviderName, targetHash: string) {
    const result = await this.pool.query("SELECT catalog FROM provider_model_catalogs WHERE tenant_id=$1 AND provider=$2 AND target_hash=$3", [tenantId, provider, targetHash]);
    const parsed = providerModelCatalogSchema.safeParse(result.rows[0]?.catalog);
    return parsed.success ? parsed.data : null;
  }
  async saveModelCatalog(tenantId: string, provider: ManagedProviderName, targetHash: string, catalog: ProviderModelCatalog) {
    await this.pool.query("INSERT INTO provider_model_catalogs(tenant_id,provider,target_hash,catalog) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(tenant_id,provider) DO UPDATE SET target_hash=EXCLUDED.target_hash,catalog=EXCLUDED.catalog,updated_at=now()", [tenantId,provider,targetHash,JSON.stringify(providerModelCatalogSchema.parse(catalog))]);
  }

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
    const result = await this.pool.query(saveProviderSettingSql, values(record));
    return mapRow(result.rows[0]);
  }

  async deleteProviderSetting(tenantId: string, provider: ManagedProviderName) {
    const result = await this.pool.query(
      "DELETE FROM provider_settings WHERE tenant_id=$1 AND provider=$2",
      [tenantId, provider],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async withProviderLifecycleLock<T>(tenantId: string, provider: ManagedProviderName, operation: () => Promise<T>) {
    // A separate small pool prevents long-lived session advisory locks from
    // consuming every data-operation connection under concurrent tenants.
    const client = await this.lifecycleLockPool.connect();
    const key = this.lifecycleLockKey(tenantId, provider);
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      locked = true;
      return await operation();
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => undefined);
      client.release();
    }
  }

  async ensureProviderLifecycle(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    return this.transaction(async (client) => this.lifecycleForUpdate(client, input));
  }

  async beginProviderLifecycle(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    return this.transaction(async (client) => {
      const current = await this.lifecycleForUpdate(client, input);
      // A pending fence is an incomplete incident-response epoch. Do not let
      // a configuration started during that epoch make the provider active;
      // the administrator may explicitly configure again after cleanup (or
      // reconciliation) has completed.
      if (current.reconciliationStatus === "pending") return null;
      const result = await client.query(
        `UPDATE provider_lifecycle_fences
         SET generation=$3,
             desired_state='active',
             pending_cleanup_model_ids='[]'::jsonb,
             reconciliation_status='not_required',
             reconciliation_error_code=NULL,
             updated_by=$4,
             updated_at=now()
         WHERE tenant_id=$1 AND provider=$2
         RETURNING *`,
        [input.tenantId, input.provider, current.generation + 1, input.updatedBy],
      );
      const lifecycle = mapLifecycleRow(result.rows[0]);
      await this.insertEvent(client, {
        ...lifecycle,
        eventKey: "configuration-started",
        actorUserId: input.updatedBy,
      });
      return lifecycle;
    });
  }

  async getProviderLifecycle(tenantId: string, provider: ManagedProviderName) {
    const result = await this.pool.query(
      "SELECT * FROM provider_lifecycle_fences WHERE tenant_id=$1 AND provider=$2",
      [tenantId, provider],
    );
    return result.rowCount ? mapLifecycleRow(result.rows[0]) : null;
  }

  async fenceProviderDisabled(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    return this.transaction(async (client) => {
      const lifecycle = await this.lifecycleForUpdate(client, input);
      const settingResult = await client.query(
        "SELECT * FROM provider_settings WHERE tenant_id=$1 AND provider=$2 FOR UPDATE",
        [input.tenantId, input.provider],
      );
      const current = settingResult.rowCount ? mapRow(settingResult.rows[0]) : null;
      const desiredState = lifecycle.desiredState === "deleted" ? "deleted" : "disabled";
      const pendingCleanupModelIds = uniqueModelIds([
        ...lifecycle.pendingCleanupModelIds,
        ...(current?.modelIds ?? []),
      ]);
      const nextResult = await client.query(
        `UPDATE provider_lifecycle_fences
         SET generation=$3,
             desired_state=$4,
             pending_cleanup_model_ids=$5::jsonb,
             reconciliation_status=$6,
             reconciliation_error_code=NULL,
             updated_by=$7,
             updated_at=now()
         WHERE tenant_id=$1 AND provider=$2
         RETURNING *`,
        [
          input.tenantId,
          input.provider,
          lifecycle.generation + 1,
          desiredState,
          JSON.stringify(pendingCleanupModelIds),
          // "pending" covers the whole disable epoch, not only model deletion.
          // That closes the gap between the durable fence and acquiring the
          // long-lived lifecycle lock for upstream cleanup.
          "pending",
          input.updatedBy,
        ],
      );
      const next = mapLifecycleRow(nextResult.rows[0]);
      let setting: ProviderSettingRecord | null = null;
      if (desiredState !== "deleted") {
        const saved = await client.query(saveProviderSettingSql, values({
          tenantId: input.tenantId,
          provider: input.provider,
          modelIds: [],
          configuration: current?.configuration ?? {},
          state: "disabled",
          credentialFingerprint: null,
          lastTestedAt: current?.lastTestedAt ?? null,
          lastErrorCode: null,
          updatedBy: input.updatedBy,
        }));
        setting = mapRow(saved.rows[0]);
      }
      await this.insertEvent(client, {
        ...next,
        eventKey: "disable-fenced",
        actorUserId: input.updatedBy,
        details: { cleanupModelCount: pendingCleanupModelIds.length },
      });
      return { lifecycle: next, setting };
    });
  }

  async fenceProviderDeleted(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    return this.transaction(async (client) => {
      const lifecycle = await this.lifecycleForUpdate(client, input);
      const settingResult = await client.query(
        "SELECT * FROM provider_settings WHERE tenant_id=$1 AND provider=$2 FOR UPDATE",
        [input.tenantId, input.provider],
      );
      const current = settingResult.rowCount ? mapRow(settingResult.rows[0]) : null;
      const pendingCleanupModelIds = uniqueModelIds([
        ...lifecycle.pendingCleanupModelIds,
        ...(current?.modelIds ?? []),
      ]);
      const nextResult = await client.query(
        `UPDATE provider_lifecycle_fences
         SET generation=$3,
             desired_state='deleted',
             pending_cleanup_model_ids=$4::jsonb,
             reconciliation_status=$5,
             reconciliation_error_code=NULL,
             updated_by=$6,
             updated_at=now()
         WHERE tenant_id=$1 AND provider=$2
         RETURNING *`,
        [
          input.tenantId,
          input.provider,
          lifecycle.generation + 1,
          JSON.stringify(pendingCleanupModelIds),
          pendingCleanupModelIds.length ? "pending" : "not_required",
          input.updatedBy,
        ],
      );
      const next = mapLifecycleRow(nextResult.rows[0]);
      await client.query(
        "DELETE FROM provider_settings WHERE tenant_id=$1 AND provider=$2",
        [input.tenantId, input.provider],
      );
      await this.insertEvent(client, {
        ...next,
        eventKey: "delete-fenced",
        actorUserId: input.updatedBy,
        details: { cleanupModelCount: pendingCleanupModelIds.length },
      });
      return { lifecycle: next, setting: null };
    });
  }

  async saveProviderSettingIfCurrent(input: { record: SaveProviderSetting; expected: ProviderLifecycleExpectation }) {
    return this.transaction(async (client) => {
      const lifecycle = await this.lifecycleForUpdate(client, {
        tenantId: input.expected.tenantId,
        provider: input.expected.provider,
        updatedBy: input.record.updatedBy,
      });
      if (!this.matchesExpectation(lifecycle, input.expected)) return null;
      const saved = await client.query(saveProviderSettingSql, values(input.record));
      return mapRow(saved.rows[0]);
    });
  }

  async deleteProviderSettingIfCurrent(expected: ProviderLifecycleExpectation) {
    return this.transaction(async (client) => {
      const lifecycle = await this.lifecycleForUpdate(client, {
        tenantId: expected.tenantId,
        provider: expected.provider,
        updatedBy: "provider-lifecycle",
      });
      if (!this.matchesExpectation(lifecycle, expected)) return false;
      const result = await client.query(
        "DELETE FROM provider_settings WHERE tenant_id=$1 AND provider=$2",
        [expected.tenantId, expected.provider],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async appendProviderLifecycleCleanup(input: ProviderLifecycleExpectation & { modelIds: string[]; updatedBy: string }) {
    return this.transaction(async (client) => {
      const lifecycle = await this.lifecycleForUpdate(client, input);
      if (!this.matchesExpectation(lifecycle, input)) return false;
      const pendingCleanupModelIds = uniqueModelIds([...lifecycle.pendingCleanupModelIds, ...input.modelIds]);
      await client.query(
        `UPDATE provider_lifecycle_fences
         SET pending_cleanup_model_ids=$3::jsonb,
             reconciliation_status=$4,
             reconciliation_error_code=NULL,
             updated_by=$5,
             updated_at=now()
         WHERE tenant_id=$1 AND provider=$2`,
        [
          input.tenantId,
          input.provider,
          JSON.stringify(pendingCleanupModelIds),
          pendingCleanupModelIds.length ? "pending" : "not_required",
          input.updatedBy,
        ],
      );
      await this.insertEvent(client, {
        ...lifecycle,
        eventKey: "cleanup-pending",
        actorUserId: input.updatedBy,
        details: { cleanupModelCount: pendingCleanupModelIds.length },
      });
      return true;
    });
  }

  async completeProviderLifecycleCleanup(input: ProviderLifecycleExpectation & { modelIds: string[]; updatedBy: string }) {
    return this.transaction(async (client) => {
      const lifecycle = await this.lifecycleForUpdate(client, input);
      if (!this.matchesExpectation(lifecycle, input)) return false;
      const cleaned = new Set(input.modelIds);
      const pendingCleanupModelIds = lifecycle.pendingCleanupModelIds.filter((modelId) => !cleaned.has(modelId));
      await client.query(
        `UPDATE provider_lifecycle_fences
         SET pending_cleanup_model_ids=$3::jsonb,
             reconciliation_status=$4,
             reconciliation_error_code=NULL,
             updated_by=$5,
             updated_at=now()
         WHERE tenant_id=$1 AND provider=$2`,
        [
          input.tenantId,
          input.provider,
          JSON.stringify(pendingCleanupModelIds),
          pendingCleanupModelIds.length ? "pending" : "not_required",
          input.updatedBy,
        ],
      );
      await this.insertEvent(client, {
        ...lifecycle,
        eventKey: "cleanup-completed",
        actorUserId: input.updatedBy,
        details: { remainingCleanupModelCount: pendingCleanupModelIds.length },
      });
      return true;
    });
  }

  async markProviderLifecycleReconciliationPending(input: ProviderLifecycleExpectation & { errorCode: string; updatedBy: string }) {
    return this.transaction(async (client) => {
      const lifecycle = await this.lifecycleForUpdate(client, input);
      if (!this.matchesExpectation(lifecycle, input)) return false;
      await client.query(
        `UPDATE provider_lifecycle_fences
         SET reconciliation_status='pending',
             reconciliation_error_code=$3,
             updated_by=$4,
             updated_at=now()
         WHERE tenant_id=$1 AND provider=$2`,
        [input.tenantId, input.provider, input.errorCode.slice(0, 96), input.updatedBy],
      );
      await this.insertEvent(client, {
        ...lifecycle,
        eventKey: "cleanup-failed",
        actorUserId: input.updatedBy,
        details: { errorCode: input.errorCode.slice(0, 96) },
      });
      return true;
    });
  }

  async recordProviderLifecycleEvent(input: ProviderLifecycleExpectation & { eventKey: string; actorUserId: string; details?: Record<string, unknown> }) {
    await this.pool.query(
      `INSERT INTO provider_lifecycle_events (
         tenant_id,provider,generation,event_key,desired_state,actor_user_id,details
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (tenant_id,provider,generation,event_key) DO NOTHING`,
      [
        input.tenantId,
        input.provider,
        input.generation,
        input.eventKey.slice(0, 96),
        input.desiredState,
        input.actorUserId,
        JSON.stringify(input.details ?? {}),
      ],
    );
  }

  private lifecycleLockKey(tenantId: string, provider: ManagedProviderName) {
    return `provider-lifecycle:${tenantId}:${provider}`;
  }

  private matchesExpectation(lifecycle: ProviderLifecycleRecord, expected: ProviderLifecycleExpectation) {
    return lifecycle.tenantId === expected.tenantId
      && lifecycle.provider === expected.provider
      && lifecycle.generation === expected.generation
      && lifecycle.desiredState === expected.desiredState;
  }

  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    let started = false;
    try {
      await client.query("BEGIN");
      started = true;
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (started) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lifecycleForUpdate(client: pg.PoolClient, input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    await client.query(
      `INSERT INTO provider_lifecycle_fences (
         tenant_id,provider,generation,desired_state,updated_by
       ) VALUES ($1,$2,0,'active',$3)
       ON CONFLICT (tenant_id,provider) DO NOTHING`,
      [input.tenantId, input.provider, input.updatedBy],
    );
    const result = await client.query(
      "SELECT * FROM provider_lifecycle_fences WHERE tenant_id=$1 AND provider=$2 FOR UPDATE",
      [input.tenantId, input.provider],
    );
    return mapLifecycleRow(result.rows[0]);
  }

  private async insertEvent(
    client: pg.PoolClient,
    input: ProviderLifecycleExpectation & { eventKey: string; actorUserId: string; details?: Record<string, unknown> },
  ) {
    await client.query(
      `INSERT INTO provider_lifecycle_events (
         tenant_id,provider,generation,event_key,desired_state,actor_user_id,details
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (tenant_id,provider,generation,event_key) DO NOTHING`,
      [
        input.tenantId,
        input.provider,
        input.generation,
        input.eventKey.slice(0, 96),
        input.desiredState,
        input.actorUserId,
        JSON.stringify(input.details ?? {}),
      ],
    );
  }
}

export class MemoryProviderSettingsStore implements ProviderSettingsStore {
  private readonly catalogs = new Map<string, { targetHash: string; catalog: ProviderModelCatalog }>();
  async getModelCatalog(tenantId: string, provider: ManagedProviderName, targetHash: string) {
    const entry = this.catalogs.get(this.key(tenantId, provider));
    return entry?.targetHash === targetHash ? structuredClone(entry.catalog) : null;
  }
  async saveModelCatalog(tenantId: string, provider: ManagedProviderName, targetHash: string, catalog: ProviderModelCatalog) {
    this.catalogs.set(this.key(tenantId, provider), { targetHash, catalog: providerModelCatalogSchema.parse(catalog) });
  }
  private readonly records = new Map<string, ProviderSettingRecord>();
  private readonly lifecycleRecords = new Map<string, ProviderLifecycleRecord>();
  private readonly lifecycleLocks = new Map<string, Promise<void>>();
  private readonly lifecycleEvents = new Set<string>();

  private key(tenantId: string, provider: ManagedProviderName) {
    return `${tenantId}:${provider}`;
  }

  async listProviderSettings(tenantId: string) {
    return [...this.records.values()]
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => left.provider.localeCompare(right.provider))
      .map(cloneSetting);
  }

  async getProviderSetting(tenantId: string, provider: ManagedProviderName) {
    const record = this.records.get(this.key(tenantId, provider));
    return record ? cloneSetting(record) : null;
  }

  async saveProviderSetting(record: SaveProviderSetting) {
    const key = this.key(record.tenantId, record.provider);
    const current = this.records.get(key);
    const now = new Date();
    const saved: ProviderSettingRecord = {
      ...record,
      modelIds: [...record.modelIds],
      configuration: { ...record.configuration },
      lastTestedAt: record.lastTestedAt ? new Date(record.lastTestedAt) : null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(key, saved);
    return cloneSetting(saved);
  }

  async deleteProviderSetting(tenantId: string, provider: ManagedProviderName) {
    return this.records.delete(this.key(tenantId, provider));
  }

  async withProviderLifecycleLock<T>(tenantId: string, provider: ManagedProviderName, operation: () => Promise<T>) {
    const key = this.key(tenantId, provider);
    const previous = this.lifecycleLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => completion);
    this.lifecycleLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleLocks.get(key) === queued) this.lifecycleLocks.delete(key);
    }
  }

  async ensureProviderLifecycle(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    return cloneLifecycle(this.ensureLifecycle(input));
  }

  async beginProviderLifecycle(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    const current = this.ensureLifecycle(input);
    if (current.reconciliationStatus === "pending") return null;
    const next: ProviderLifecycleRecord = {
      ...current,
      generation: current.generation + 1,
      desiredState: "active",
      pendingCleanupModelIds: [],
      reconciliationStatus: "not_required",
      reconciliationErrorCode: null,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    this.lifecycleRecords.set(this.key(input.tenantId, input.provider), next);
    await this.recordProviderLifecycleEvent({
      ...next,
      eventKey: "configuration-started",
      actorUserId: input.updatedBy,
    });
    return cloneLifecycle(next);
  }

  async getProviderLifecycle(tenantId: string, provider: ManagedProviderName) {
    const record = this.lifecycleRecords.get(this.key(tenantId, provider));
    return record ? cloneLifecycle(record) : null;
  }

  async fenceProviderDisabled(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    const key = this.key(input.tenantId, input.provider);
    const lifecycle = this.ensureLifecycle(input);
    const current = this.records.get(key) ?? null;
    const desiredState = lifecycle.desiredState === "deleted" ? "deleted" : "disabled";
    const pendingCleanupModelIds = uniqueModelIds([
      ...lifecycle.pendingCleanupModelIds,
      ...(current?.modelIds ?? []),
    ]);
    const next: ProviderLifecycleRecord = {
      ...lifecycle,
      generation: lifecycle.generation + 1,
      desiredState,
      pendingCleanupModelIds,
      reconciliationStatus: "pending",
      reconciliationErrorCode: null,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    this.lifecycleRecords.set(key, next);
    let setting: ProviderSettingRecord | null = null;
    if (desiredState !== "deleted") {
      setting = await this.saveProviderSetting({
        tenantId: input.tenantId,
        provider: input.provider,
        modelIds: [],
        configuration: current?.configuration ?? {},
        state: "disabled",
        credentialFingerprint: null,
        lastTestedAt: current?.lastTestedAt ?? null,
        lastErrorCode: null,
        updatedBy: input.updatedBy,
      });
    }
    await this.recordProviderLifecycleEvent({
      ...next,
      eventKey: "disable-fenced",
      actorUserId: input.updatedBy,
      details: { cleanupModelCount: pendingCleanupModelIds.length },
    });
    return { lifecycle: cloneLifecycle(next), setting };
  }

  async fenceProviderDeleted(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    const key = this.key(input.tenantId, input.provider);
    const lifecycle = this.ensureLifecycle(input);
    const current = this.records.get(key) ?? null;
    const pendingCleanupModelIds = uniqueModelIds([
      ...lifecycle.pendingCleanupModelIds,
      ...(current?.modelIds ?? []),
    ]);
    const next: ProviderLifecycleRecord = {
      ...lifecycle,
      generation: lifecycle.generation + 1,
      desiredState: "deleted",
      pendingCleanupModelIds,
      reconciliationStatus: pendingCleanupModelIds.length ? "pending" : "not_required",
      reconciliationErrorCode: null,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    this.lifecycleRecords.set(key, next);
    this.records.delete(key);
    await this.recordProviderLifecycleEvent({
      ...next,
      eventKey: "delete-fenced",
      actorUserId: input.updatedBy,
      details: { cleanupModelCount: pendingCleanupModelIds.length },
    });
    return { lifecycle: cloneLifecycle(next), setting: null };
  }

  async saveProviderSettingIfCurrent(input: { record: SaveProviderSetting; expected: ProviderLifecycleExpectation }) {
    const lifecycle = this.ensureLifecycle({
      tenantId: input.expected.tenantId,
      provider: input.expected.provider,
      updatedBy: input.record.updatedBy,
    });
    if (!this.matchesExpectation(lifecycle, input.expected)) return null;
    return this.saveProviderSetting(input.record);
  }

  async deleteProviderSettingIfCurrent(expected: ProviderLifecycleExpectation) {
    const lifecycle = this.ensureLifecycle({
      tenantId: expected.tenantId,
      provider: expected.provider,
      updatedBy: "provider-lifecycle",
    });
    if (!this.matchesExpectation(lifecycle, expected)) return false;
    return this.deleteProviderSetting(expected.tenantId, expected.provider);
  }

  async appendProviderLifecycleCleanup(input: ProviderLifecycleExpectation & { modelIds: string[]; updatedBy: string }) {
    const lifecycle = this.ensureLifecycle(input);
    if (!this.matchesExpectation(lifecycle, input)) return false;
    const pendingCleanupModelIds = uniqueModelIds([...lifecycle.pendingCleanupModelIds, ...input.modelIds]);
    const next: ProviderLifecycleRecord = {
      ...lifecycle,
      pendingCleanupModelIds,
      reconciliationStatus: pendingCleanupModelIds.length ? "pending" : "not_required",
      reconciliationErrorCode: null,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    this.lifecycleRecords.set(this.key(input.tenantId, input.provider), next);
    await this.recordProviderLifecycleEvent({
      ...next,
      eventKey: "cleanup-pending",
      actorUserId: input.updatedBy,
      details: { cleanupModelCount: pendingCleanupModelIds.length },
    });
    return true;
  }

  async completeProviderLifecycleCleanup(input: ProviderLifecycleExpectation & { modelIds: string[]; updatedBy: string }) {
    const lifecycle = this.ensureLifecycle(input);
    if (!this.matchesExpectation(lifecycle, input)) return false;
    const cleaned = new Set(input.modelIds);
    const pendingCleanupModelIds = lifecycle.pendingCleanupModelIds.filter((modelId) => !cleaned.has(modelId));
    const next: ProviderLifecycleRecord = {
      ...lifecycle,
      pendingCleanupModelIds,
      reconciliationStatus: pendingCleanupModelIds.length ? "pending" : "not_required",
      reconciliationErrorCode: null,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    this.lifecycleRecords.set(this.key(input.tenantId, input.provider), next);
    await this.recordProviderLifecycleEvent({
      ...next,
      eventKey: "cleanup-completed",
      actorUserId: input.updatedBy,
      details: { remainingCleanupModelCount: pendingCleanupModelIds.length },
    });
    return true;
  }

  async markProviderLifecycleReconciliationPending(input: ProviderLifecycleExpectation & { errorCode: string; updatedBy: string }) {
    const lifecycle = this.ensureLifecycle(input);
    if (!this.matchesExpectation(lifecycle, input)) return false;
    const next: ProviderLifecycleRecord = {
      ...lifecycle,
      reconciliationStatus: "pending",
      reconciliationErrorCode: input.errorCode.slice(0, 96),
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    };
    this.lifecycleRecords.set(this.key(input.tenantId, input.provider), next);
    await this.recordProviderLifecycleEvent({
      ...next,
      eventKey: "cleanup-failed",
      actorUserId: input.updatedBy,
      details: { errorCode: input.errorCode.slice(0, 96) },
    });
    return true;
  }

  async recordProviderLifecycleEvent(input: ProviderLifecycleExpectation & { eventKey: string; actorUserId: string; details?: Record<string, unknown> }) {
    this.lifecycleEvents.add(`${input.tenantId}:${input.provider}:${input.generation}:${input.eventKey}`);
  }

  private ensureLifecycle(input: { tenantId: string; provider: ManagedProviderName; updatedBy: string }) {
    const key = this.key(input.tenantId, input.provider);
    const current = this.lifecycleRecords.get(key);
    if (current) return current;
    const now = new Date();
    const created: ProviderLifecycleRecord = {
      tenantId: input.tenantId,
      provider: input.provider,
      generation: 0,
      desiredState: "active",
      pendingCleanupModelIds: [],
      reconciliationStatus: "not_required",
      reconciliationErrorCode: null,
      updatedBy: input.updatedBy,
      createdAt: now,
      updatedAt: now,
    };
    this.lifecycleRecords.set(key, created);
    return created;
  }

  private matchesExpectation(lifecycle: ProviderLifecycleRecord, expected: ProviderLifecycleExpectation) {
    return lifecycle.tenantId === expected.tenantId
      && lifecycle.provider === expected.provider
      && lifecycle.generation === expected.generation
      && lifecycle.desiredState === expected.desiredState;
  }
}
