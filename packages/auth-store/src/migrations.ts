import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

const migrationFile = /^(\d{3})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const ledgerTable = "lemmacomputer_auth_schema_migrations";
const lockKeys: [number, number] = [1_326_843_779, 2];

export type AuthenticationMigration = {
  id: string;
  name: string;
  fileName: string;
  checksumSha256: string;
  dependsOn: string[];
  sql: string;
};

export type AuthenticationMigrationRunReport = { applied: string[] };
type AppliedMigration = { id: string; name: string; checksum_sha256: string; depends_on: string[] };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const metadata = (sql: string, key: string) => sql.match(new RegExp(`^--\\s*${key}:\\s*(.+?)\\s*$`, "mi"))?.[1]?.trim();

export async function discoverAuthenticationMigrations(
  directory: URL = new URL("../migrations/", import.meta.url),
): Promise<AuthenticationMigration[]> {
  const fileNames = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: AuthenticationMigration[] = [];
  for (const fileName of fileNames) {
    const match = fileName.match(migrationFile);
    if (!match) throw new Error(`Invalid authentication migration filename "${fileName}"; use NNN_name.sql`);
    const sql = await readFile(new URL(fileName, directory), "utf8");
    const id = metadata(sql, "id") ?? match[1]!;
    if (id !== match[1]) throw new Error(`Authentication migration ${fileName} declares id ${id}, which does not match its filename`);
    const declaredDependencies = metadata(sql, "depends-on");
    const dependsOn = declaredDependencies
      ? declaredDependencies.split(",").map((value) => value.trim()).filter(Boolean)
      : migrations.length ? [migrations.at(-1)!.id] : [];
    migrations.push({ id, name: match[2]!, fileName, checksumSha256: sha256(sql), dependsOn, sql });
  }
  const discovered = new Set<string>();
  for (const migration of migrations) {
    if (discovered.has(migration.id)) throw new Error(`Duplicate authentication migration id ${migration.id}`);
    for (const dependency of migration.dependsOn) {
      if (!discovered.has(dependency)) {
        throw new Error(`Authentication migration ${migration.fileName} depends on missing or later migration ${dependency}`);
      }
    }
    discovered.add(migration.id);
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

async function readApplied(client: pg.PoolClient) {
  return (await client.query<AppliedMigration>(
    `SELECT id,name,checksum_sha256,depends_on FROM ${ledgerTable} ORDER BY applied_at,id`,
  )).rows;
}

function validateApplied(migrations: AuthenticationMigration[], applied: AppliedMigration[]) {
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  const appliedIds = new Set(applied.map((migration) => migration.id));
  for (const row of applied) {
    const migration = known.get(row.id);
    if (!migration) throw new Error(`Authentication database contains unknown migration ${row.id}`);
    if (migration.name !== row.name) throw new Error(`Authentication migration ${row.id} name differs from the applied ledger`);
    if (migration.checksumSha256 !== row.checksum_sha256.trim()) {
      throw new Error(`Authentication migration ${migration.fileName} changed after it was applied; historical migrations are immutable`);
    }
    if (migration.dependsOn.join(",") !== row.depends_on.join(",")) {
      throw new Error(`Authentication migration ${migration.fileName} dependencies differ from the applied ledger`);
    }
    for (const dependency of migration.dependsOn) {
      if (!appliedIds.has(dependency)) throw new Error(`Applied authentication migration ${row.id} is missing dependency ${dependency}`);
    }
  }
  return appliedIds;
}

export async function runAuthenticationMigrations(
  pool: pg.Pool,
  options: { appVersion?: string; installationKind?: string; migrationDirectory?: URL } = {},
): Promise<AuthenticationMigrationRunReport> {
  const migrations = await discoverAuthenticationMigrations(options.migrationDirectory);
  const appVersion = options.appVersion ?? process.env.LEMMACOMPUTER_APP_VERSION ?? "development";
  const installationKind = options.installationKind ?? process.env.LEMMACOMPUTER_INSTALLATION_KIND ?? "managed";
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1,$2)", lockKeys);
    locked = true;
    if (!(await relationExists(client, ledgerTable))) {
      const existing = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      );
      if (Number(existing.rows[0]?.count ?? 0) > 0) {
        throw new Error("Authentication database is not empty and has no LemmaComputer authentication migration ledger; refusing to baseline unknown schema");
      }
      await client.query(createLedgerSql);
    }

    const appliedIds = validateApplied(migrations, await readApplied(client));
    const applied: string[] = [];
    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) continue;
      for (const dependency of migration.dependsOn) {
        if (!appliedIds.has(dependency)) throw new Error(`Cannot apply authentication migration ${migration.id}; dependency ${dependency} is not applied`);
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
        throw new Error(`Authentication migration ${migration.fileName} failed`, { cause: error });
      }
    }
    return { applied };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1,$2)", lockKeys);
    client.release();
  }
}

export async function assertAuthenticationSchemaCompatible(
  pool: pg.Pool,
  options: { migrationDirectory?: URL } = {},
) {
  const migrations = await discoverAuthenticationMigrations(options.migrationDirectory);
  const client = await pool.connect();
  try {
    if (!(await relationExists(client, ledgerTable))) {
      throw new Error("Authentication database schema is not initialized; run npm run auth:db:migrate before starting the service");
    }
    const appliedIds = validateApplied(migrations, await readApplied(client));
    const missing = migrations.filter((migration) => !appliedIds.has(migration.id));
    if (missing.length) {
      throw new Error(`Authentication database schema is behind by ${missing.length} migration(s): ${missing.map((item) => item.id).join(", ")}`);
    }
  } finally {
    client.release();
  }
}

export class PostgresAuthenticationStore {
  readonly #pool: pg.Pool;

  private constructor(pool: pg.Pool) { this.#pool = pool; }

  static async fromConnectionString(connectionString: string) {
    const { default: postgres } = await import("pg");
    return new PostgresAuthenticationStore(new postgres.Pool({ connectionString }));
  }

  migrate() { return runAuthenticationMigrations(this.#pool); }
  assertSchemaCompatible() { return assertAuthenticationSchemaCompatible(this.#pool); }
  close() { return this.#pool.end(); }
}
