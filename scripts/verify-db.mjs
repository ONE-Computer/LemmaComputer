import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";

const image = "postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const container = `oc-migration-test-${suffix}`;
const password = `test-${suffix}`;
const exec = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
const must = (command, args, options = {}) => {
  const result = exec(command, args, options);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
};
const migrate = (database, expectedSuccess = true) => {
  const result = exec("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${hostPort}/${database}`, ONECOMPUTER_INSTALLATION_KIND: "migration-test" },
  });
  if ((result.status === 0) !== expectedSuccess) throw new Error(result.stderr || result.stdout || "unexpected migration result");
  return `${result.stdout}${result.stderr}`;
};
const sql = (database, statement, options = {}) => must(
  "docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-Atqc", statement], options,
);
const waitFor = (child) => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`concurrent migrator exited ${code}`)));
});
const migrationFiles = (await readdir("packages/workspace-store/migrations")).filter((name) => name.endsWith(".sql")).sort();
const legacyMigrationIds = new Set(Array.from({ length: 28 }, (_, index) => String(index + 1).padStart(3, "0")));
const legacyMigrationFiles = migrationFiles.filter((name) => legacyMigrationIds.has(name.slice(0, 3)));
if (legacyMigrationFiles.length !== legacyMigrationIds.size) {
  throw new Error("the immutable 001-028 legacy migration chain is incomplete");
}
const expectedMigrationCount = migrationFiles.length;
let hostPort;
try {
  must("docker", ["run", "--rm", "-d", "--name", container, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432", image]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (exec("docker", ["exec", container, "pg_isready", "-U", "postgres"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (attempt === 59) throw new Error("PostgreSQL test container did not become ready");
  }
  hostPort = JSON.parse(must("docker", ["inspect", container, "--format", "{{json (index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}"]));

  const first = migrate("postgres");
  if (!first.includes("Applied migrations")) throw new Error("fresh database did not report applied migrations");
  if (sql("postgres", "SELECT count(*) FROM onecomputer_schema_migrations") !== String(expectedMigrationCount)) {
    throw new Error("fresh migration ledger does not contain every discovered migration");
  }
  const schemaCheck = exec("npm", ["run", "db:check"], { env: { ...process.env, DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${hostPort}/postgres` } });
  if (schemaCheck.status !== 0 || !schemaCheck.stdout.includes("schema is compatible")) throw new Error(schemaCheck.stderr || "schema compatibility check failed");
  if (!migrate("postgres").includes("no migrations applied")) throw new Error("second migration run was not a no-op");
  const postgresUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/postgres`;
  sql("postgres", "CREATE DATABASE migration_ledger_legacy");
  sql("postgres", "CREATE DATABASE migration_ledger_fresh");
  const migrationLedgerLegacyUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/migration_ledger_legacy`;
  const migrationLedgerFreshUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/migration_ledger_fresh`;
  const featureTests = exec(process.execPath, [
    "--import", "tsx", "--test",
    "tests/activity-events-postgres.test.ts",
    "tests/teams-postgres.test.ts",
    "tests/team-budgets-postgres.test.ts",
    "tests/schedules-postgres.test.ts",
    "tests/usage-ledger-postgres.test.ts",
    "tests/routing-postgres.test.ts",
    "tests/openvtc-companion-push-postgres.test.ts",
    "tests/migration-ledger-baseline-postgres.test.ts",
  ], {
    env: {
      ...process.env,
      ACTIVITY_TEST_DATABASE_URL: postgresUrl,
      TEAM_TEST_DATABASE_URL: postgresUrl,
      USAGE_LEDGER_TEST_DATABASE_URL: postgresUrl,
      ROUTING_TEST_DATABASE_URL: postgresUrl,
      BUDGET_TEST_DATABASE_URL: postgresUrl,
      SCHEDULE_TEST_DATABASE_URL: postgresUrl,
      OPENVTC_PUSH_TEST_DATABASE_URL: postgresUrl,
      MIGRATION_LEDGER_LEGACY_TEST_DATABASE_URL: migrationLedgerLegacyUrl,
      MIGRATION_LEDGER_FRESH_TEST_DATABASE_URL: migrationLedgerFreshUrl,
    },
  });
  if (featureTests.status !== 0) throw new Error(featureTests.stderr || featureTests.stdout || "PostgreSQL feature tests failed");

  sql("postgres", "CREATE DATABASE concurrent");
  const concurrentUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/concurrent`;
  const children = [0, 1].map(() => spawn("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: concurrentUrl, ONECOMPUTER_INSTALLATION_KIND: "concurrency-test" },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  await Promise.all(children.map(waitFor));
  if (sql("concurrent", "SELECT count(*) FROM onecomputer_schema_migrations") !== String(expectedMigrationCount)) {
    throw new Error("concurrent migration ledger does not contain every discovered migration");
  }

  sql("postgres", "CREATE DATABASE legacy");
  const legacySql = (await Promise.all(legacyMigrationFiles.map((name) => readFile(`packages/workspace-store/migrations/${name}`, "utf8")))).join("\n");
  must("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "legacy"], { input: legacySql });
  if (!migrate("legacy").includes("baselined legacy schema")) throw new Error("legacy schema was not verified and baselined");
  if (sql("legacy", "SELECT count(*) FROM onecomputer_schema_migrations WHERE installation_kind='verified-legacy-baseline'") !== String(legacyMigrationIds.size)) {
    throw new Error("legacy baseline ledger is invalid");
  }
  if (sql("legacy", "SELECT count(*) FROM onecomputer_schema_migrations") !== String(expectedMigrationCount)) {
    throw new Error("legacy cutover did not apply every later migration");
  }

  sql("postgres", "CREATE DATABASE incompatible");
  sql("incompatible", "CREATE TABLE workspaces(id uuid PRIMARY KEY)");
  const failure = migrate("incompatible", false);
  if (!failure.includes("cannot be safely baselined")) throw new Error("incompatible legacy schema did not fail closed");
  if (sql("incompatible", "SELECT to_regclass('public.onecomputer_schema_migrations') IS NULL") !== "t") {
    throw new Error("failed legacy verification mutated the database");
  }

  sql("postgres", "UPDATE onecomputer_schema_migrations SET checksum_sha256=repeat('0',64) WHERE id='028'");
  if (!migrate("postgres", false).includes("historical migrations are immutable")) throw new Error("checksum drift did not fail closed");
  process.stdout.write("Database gate passed: fresh, no-op, concurrent, legacy baseline, mismatch, checksum, Activity, Teams, usage ledger, schedule, and Companion push cases.\n");
} finally {
  exec("docker", ["rm", "-f", container]);
}
