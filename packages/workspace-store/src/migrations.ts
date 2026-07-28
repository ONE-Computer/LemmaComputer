import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

const migrationFile = /^((?:\d{3})|(?:[0-9A-HJKMNP-TV-Z]{26}))_([a-z0-9][a-z0-9_-]*)\.sql$/;
const ledgerTable = "onecomputer_schema_migrations";
const lockKeys: [number, number] = [1_326_843_779, 1];
const legacyMigrationIds = Array.from({ length: 28 }, (_, index) => String(index + 1).padStart(3, "0"));
const legacyMigrationIdSet = new Set(legacyMigrationIds);

const requiredLegacyTables = [
  "agent_identities", "browser_sessions", "capabilities", "capability_assignments", "channel_connections",
  "channel_credentials", "channel_sender_routes", "channel_sessions", "channel_updates", "connector_registry",
  "egress_security_group_versions", "egress_security_groups", "external_identities", "governed_approvals",
  "governed_operation_events", "governed_operations", "governed_receipts", "oidc_login_attempts",
  "openvtc_approvers", "openvtc_companion_push_deliveries", "openvtc_companion_subscriptions",
  "openvtc_consent_tasks", "openvtc_delivery_attempts", "openvtc_delivery_outbox", "openvtc_enrollment_challenges",
  "policy_assignments", "policy_bundles", "policy_signing_keys", "policy_versions", "sandbox_settings",
  "schedule_runs", "schedules", "tenants", "user_roles", "users", "vendor_identity_mappings",
  "workspace_egress_security_group_assignments", "workspace_idempotency", "workspaces",
] as const;

const requiredLegacyColumns = [
  ["channel_updates", "response_chat_id"], ["channel_updates", "response_text"],
  ["channel_updates", "response_offset"], ["channel_updates", "final_state"],
  ["channel_updates", "final_failure_code"], ["connector_registry", "enabled"],
  ["connector_registry", "members_can_manage"], ["connector_registry", "access_policy_version"],
  ["governed_operations", "failure_summary"], ["governed_operations", "policy_hash"],
  ["governed_operations", "policy_version_id"], ["openvtc_consent_tasks", "request_proof_hash"],
  ["workspace_egress_security_group_assignments", "security_group_id"],
] as const;

const forbiddenLegacyObjects = [
  ["table", "workspace_identities", ""], ["column", "workspaces", "expires_at"],
  ["column", "policy_assignments", "workspace_identity_id"],
  ["column", "workspace_egress_security_group_assignments", "security_group_version_id"],
] as const;

export type WorkspaceMigration = {
  id: string;
  name: string;
  fileName: string;
  checksumSha256: string;
  dependsOn: string[];
  sql: string;
};

export type MigrationRunReport = { applied: string[]; baselined: boolean };
type AppliedMigration = { id: string; name: string; checksum_sha256: string; depends_on: string[] };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const metadata = (sql: string, key: string) => sql.match(new RegExp(`^--\\s*${key}:\\s*(.+?)\\s*$`, "mi"))?.[1]?.trim();

export async function discoverWorkspaceMigrations(
  directory: URL = new URL("../migrations/", import.meta.url),
): Promise<WorkspaceMigration[]> {
  const fileNames = (await readdir(directory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => {
      const leftLegacy = /^\d{3}_/.test(left);
      const rightLegacy = /^\d{3}_/.test(right);
      return leftLegacy === rightLegacy ? left.localeCompare(right) : leftLegacy ? -1 : 1;
    });
  const migrations: WorkspaceMigration[] = [];
  for (const fileName of fileNames) {
    const match = fileName.match(migrationFile);
    if (!match) throw new Error(`Invalid migration filename "${fileName}"; use NNN_name.sql or ULID_name.sql`);
    const sql = await readFile(new URL(fileName, directory), "utf8");
    const id = metadata(sql, "id") ?? match[1]!;
    if (id !== match[1]) throw new Error(`Migration ${fileName} declares id ${id}, which does not match its filename`);
    const dependencyMetadata = metadata(sql, "depends-on");
    const dependsOn = dependencyMetadata
      ? dependencyMetadata.split(",").map((value) => value.trim()).filter(Boolean)
      : migrations.length ? [migrations.at(-1)!.id] : [];
    migrations.push({ id, name: match[2]!, fileName, checksumSha256: sha256(sql), dependsOn, sql });
  }
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) throw new Error(`Duplicate migration id ${migration.id}`);
    for (const dependency of migration.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Migration ${migration.fileName} depends on missing or later migration ${dependency}`);
    }
    ids.add(migration.id);
  }
  return migrations;
}

const createLedgerSql = `CREATE TABLE ${ledgerTable} (
  id text PRIMARY KEY,
  name text NOT NULL,
  checksum_sha256 char(64) NOT NULL,
  depends_on text[] NOT NULL DEFAULT '{}',
  applied_at timestamptz NOT NULL DEFAULT now(),
  duration_ms bigint NOT NULL,
  app_version text NOT NULL,
  installation_kind text NOT NULL
)`;

async function relationExists(client: pg.PoolClient, relation: string) {
  const result = await client.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${relation}`]);
  return result.rows[0]?.exists === true;
}

async function columnExists(client: pg.PoolClient, table: string, column: string) {
  const result = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS exists",
    [table, column],
  );
  return result.rows[0]?.exists === true;
}

async function verifyLegacySchema(client: pg.PoolClient) {
  const failures: string[] = [];
  for (const table of requiredLegacyTables) {
    if (!(await relationExists(client, table))) failures.push(`missing table public.${table}`);
  }
  for (const [table, column] of requiredLegacyColumns) {
    if (!(await columnExists(client, table, column))) failures.push(`missing column public.${table}.${column}`);
  }
  for (const [kind, table, column] of forbiddenLegacyObjects) {
    const exists = kind === "table" ? await relationExists(client, table) : await columnExists(client, table, column);
    if (exists) failures.push(kind === "table" ? `obsolete table public.${table} still exists` : `obsolete column public.${table}.${column} still exists`);
  }
  const assignmentColumn = await client.query<{ is_nullable: string }>(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='workspace_egress_security_group_assignments' AND column_name='security_group_id'",
  );
  if (assignmentColumn.rows[0]?.is_nullable !== "NO") {
    failures.push("public.workspace_egress_security_group_assignments.security_group_id is not NOT NULL");
  }
  if (failures.length) throw new Error([
    "Existing database cannot be safely baselined at migration 028:",
    ...failures.map((failure) => `- ${failure}`),
    "Restore a compatible backup or reconcile the schema manually; no migration ledger was written.",
  ].join("\n"));
}

const legacyBaselineMigrations = (migrations: WorkspaceMigration[]) => {
  const baseline = migrations.filter((migration) => legacyMigrationIdSet.has(migration.id));
  if (baseline.length !== legacyMigrationIds.length || baseline.some((migration, index) => migration.id !== legacyMigrationIds[index])) {
    throw new Error("The immutable legacy migration chain 001–028 is incomplete or reordered");
  }
  return baseline;
};

async function initializeLedger(client: pg.PoolClient, migrations: WorkspaceMigration[], appVersion: string) {
  await client.query("BEGIN");
  try {
    if (await relationExists(client, ledgerTable)) {
      await client.query("COMMIT");
      return false;
    }
    const existing = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
    );
    const hasExistingSchema = Number(existing.rows[0]?.count ?? 0) > 0;
    if (hasExistingSchema) await verifyLegacySchema(client);
    await client.query(createLedgerSql);
    if (hasExistingSchema) {
      for (const migration of legacyBaselineMigrations(migrations)) await client.query(
        `INSERT INTO ${ledgerTable} (id,name,checksum_sha256,depends_on,duration_ms,app_version,installation_kind)
         VALUES ($1,$2,$3,$4,0,$5,'verified-legacy-baseline')`,
        [migration.id, migration.name, migration.checksumSha256, migration.dependsOn, appVersion],
      );
    }
    await client.query("COMMIT");
    return hasExistingSchema;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function readApplied(client: pg.PoolClient) {
  return (await client.query<AppliedMigration>(
    `SELECT id,name,checksum_sha256,depends_on FROM ${ledgerTable} ORDER BY applied_at,id`,
  )).rows;
}

function validateApplied(migrations: WorkspaceMigration[], applied: AppliedMigration[]) {
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  const appliedIds = new Set(applied.map((migration) => migration.id));
  for (const row of applied) {
    const migration = known.get(row.id);
    if (!migration) throw new Error(`Database contains unknown migration ${row.id}`);
    if (migration.name !== row.name) throw new Error(`Migration ${row.id} name differs from the applied ledger`);
    if (migration.checksumSha256 !== row.checksum_sha256.trim()) {
      throw new Error(`Migration ${migration.fileName} changed after it was applied; historical migrations are immutable`);
    }
    if (migration.dependsOn.join(",") !== row.depends_on.join(",")) {
      throw new Error(`Migration ${migration.fileName} dependencies differ from the applied ledger`);
    }
    for (const dependency of migration.dependsOn) {
      if (!appliedIds.has(dependency)) throw new Error(`Applied migration ${row.id} is missing dependency ${dependency}`);
    }
  }
  return appliedIds;
}

export async function runWorkspaceMigrations(
  pool: pg.Pool,
  options: { appVersion?: string; installationKind?: string; migrationDirectory?: URL } = {},
): Promise<MigrationRunReport> {
  const migrations = await discoverWorkspaceMigrations(options.migrationDirectory);
  const appVersion = options.appVersion ?? process.env.ONECOMPUTER_APP_VERSION ?? "development";
  const installationKind = options.installationKind ?? process.env.ONECOMPUTER_INSTALLATION_KIND ?? "managed";
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1,$2)", lockKeys);
    locked = true;
    const baselined = await initializeLedger(client, migrations, appVersion);
    const appliedIds = validateApplied(migrations, await readApplied(client));
    const applied: string[] = [];
    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) continue;
      for (const dependency of migration.dependsOn) {
        if (!appliedIds.has(dependency)) throw new Error(`Cannot apply ${migration.id}; dependency ${dependency} is not applied`);
      }
      const startedAt = performance.now();
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '5min'");
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${ledgerTable} (id,name,checksum_sha256,depends_on,duration_ms,app_version,installation_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [migration.id, migration.name, migration.checksumSha256, migration.dependsOn,
            Math.max(0, Math.round(performance.now() - startedAt)), appVersion, installationKind],
        );
        await client.query("COMMIT");
        appliedIds.add(migration.id);
        applied.push(migration.id);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.fileName} failed`, { cause: error });
      }
    }
    return { applied, baselined };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1,$2)", lockKeys);
    client.release();
  }
}

export async function assertWorkspaceSchemaCompatible(pool: pg.Pool, options: { migrationDirectory?: URL } = {}) {
  const migrations = await discoverWorkspaceMigrations(options.migrationDirectory);
  const client = await pool.connect();
  try {
    if (!(await relationExists(client, ledgerTable))) {
      throw new Error("Database schema is not initialized; run npm run db:migrate before starting the service");
    }
    const appliedIds = validateApplied(migrations, await readApplied(client));
    const missing = migrations.filter((migration) => !appliedIds.has(migration.id));
    if (missing.length) throw new Error(
      `Database schema is behind by ${missing.length} migration(s): ${missing.map((item) => item.id).join(", ")}`,
    );
  } finally {
    client.release();
  }
}
