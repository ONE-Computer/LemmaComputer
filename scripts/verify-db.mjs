import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";

const image = "postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const container = `lemmacomputer-migration-test-${suffix}`;
const password = `test-${suffix}`;
const exec = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
const must = (command, args, options = {}) => {
  const result = exec(command, args, options);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
};
const migrate = (database, expectedSuccess = true) => {
  const result = exec("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${hostPort}/${database}`, LEMMACOMPUTER_INSTALLATION_KIND: "migration-test" },
  });
  if ((result.status === 0) !== expectedSuccess) throw new Error(result.stderr || result.stdout || "unexpected migration result");
  return `${result.stdout}${result.stderr}`;
};
const migrateAuth = (database, expectedSuccess = true) => {
  const result = exec("npm", ["run", "auth:db:migrate"], {
    env: { ...process.env, AUTH_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${hostPort}/${database}`, LEMMACOMPUTER_INSTALLATION_KIND: "auth-migration-test" },
  });
  if ((result.status === 0) !== expectedSuccess) throw new Error(result.stderr || result.stdout || "unexpected authentication migration result");
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
const expectedAuthMigrationCount = (await readdir("packages/auth-store/migrations")).filter((name) => name.endsWith(".sql")).length;
let hostPort;
try {
  must("docker", ["run", "--rm", "-d", "--name", container, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432", image]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (exec("docker", ["exec", container, "pg_isready", "-U", "postgres"]).status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (attempt === 59) throw new Error("PostgreSQL test container did not become ready");
  }
  hostPort = JSON.parse(must("docker", ["inspect", container, "--format", "{{json (index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}"]));

  sql("postgres", "CREATE DATABASE authentication");
  const firstAuth = migrateAuth("authentication");
  if (!firstAuth.includes("Applied authentication migrations")) throw new Error("fresh authentication database did not report applied migrations");
  if (sql("authentication", "SELECT count(*) FROM lemmacomputer_auth_schema_migrations") !== String(expectedAuthMigrationCount)) {
    throw new Error("fresh authentication migration ledger does not contain every discovered migration");
  }
  if (sql("authentication", "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('user','account','session','verification','twoFactor','passkey')") !== "6") {
    throw new Error("fresh authentication schema is incomplete");
  }
  const authSchemaCheck = exec("npm", ["run", "auth:db:check"], {
    env: { ...process.env, AUTH_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${hostPort}/authentication` },
  });
  if (authSchemaCheck.status !== 0 || !authSchemaCheck.stdout.includes("schema is compatible")) {
    throw new Error(authSchemaCheck.stderr || "authentication schema compatibility check failed");
  }
  if (!migrateAuth("authentication").includes("no migrations applied")) throw new Error("second authentication migration run was not a no-op");

  sql("authentication", `
    INSERT INTO "user" (id,name,email,"emailVerified")
    VALUES ('11111111-1111-4111-8111-111111111111','Restore Test','restore@example.test',true);
    INSERT INTO "account" (id,"accountId","providerId","userId",password,"updatedAt")
    VALUES ('22222222-2222-4222-8222-222222222222','restore@example.test','credential','11111111-1111-4111-8111-111111111111','test-hash-not-a-secret',now())
  `);
  const authenticationBackup = must("docker", [
    "exec", "-i", container, "pg_dump", "-U", "postgres", "-d", "authentication",
    "--format=plain", "--no-owner", "--no-privileges",
  ]);
  sql("postgres", "CREATE DATABASE auth_restore");
  must("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "auth_restore"], {
    input: authenticationBackup,
  });
  if (sql("auth_restore", `SELECT count(*) FROM "user" u JOIN "account" a ON a."userId"=u.id WHERE u.email='restore@example.test'`) !== "1") {
    throw new Error("authentication backup/restore did not preserve the account relationship");
  }
  const restoredAuthSchemaCheck = exec("npm", ["run", "auth:db:check"], {
    env: { ...process.env, AUTH_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${hostPort}/auth_restore` },
  });
  if (restoredAuthSchemaCheck.status !== 0 || !restoredAuthSchemaCheck.stdout.includes("schema is compatible")) {
    throw new Error(restoredAuthSchemaCheck.stderr || "restored authentication schema compatibility check failed");
  }
  sql("postgres", "CREATE DATABASE auth_future TEMPLATE auth_restore");
  sql("auth_future", `INSERT INTO lemmacomputer_auth_schema_migrations
    (id,name,checksum_sha256,depends_on,duration_ms,app_version,installation_kind)
    VALUES ('999','future_upgrade',repeat('f',64),ARRAY['002'],0,'future-test','dependency-upgrade-test')`);
  const incompatibleRollbackCheck = exec("npm", ["run", "auth:db:check"], {
    env: { ...process.env, AUTH_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${hostPort}/auth_future` },
  });
  if (incompatibleRollbackCheck.status === 0 || !`${incompatibleRollbackCheck.stdout}${incompatibleRollbackCheck.stderr}`.includes("unknown migration 999")) {
    throw new Error("authentication dependency rollback did not fail closed against a future schema ledger");
  }

  sql("postgres", "CREATE DATABASE auth_concurrent");
  const authConcurrentUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/auth_concurrent`;
  const authChildren = [0, 1].map(() => spawn("npm", ["run", "auth:db:migrate"], {
    env: { ...process.env, AUTH_DATABASE_URL: authConcurrentUrl, LEMMACOMPUTER_INSTALLATION_KIND: "auth-concurrency-test" },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  await Promise.all(authChildren.map(waitFor));
  if (sql("auth_concurrent", "SELECT count(*) FROM lemmacomputer_auth_schema_migrations") !== String(expectedAuthMigrationCount)) {
    throw new Error("concurrent authentication migration ledger does not contain every discovered migration");
  }

  sql("postgres", "CREATE DATABASE auth_incompatible");
  sql("auth_incompatible", "CREATE TABLE unknown_auth_data(id uuid PRIMARY KEY)");
  if (!migrateAuth("auth_incompatible", false).includes("refusing to baseline unknown schema")) {
    throw new Error("unknown authentication schema did not fail closed");
  }
  if (sql("auth_incompatible", "SELECT to_regclass('public.lemmacomputer_auth_schema_migrations') IS NULL") !== "t") {
    throw new Error("failed authentication schema verification mutated the database");
  }

  const first = migrate("postgres");
  if (!first.includes("Applied migrations")) throw new Error("fresh database did not report applied migrations");
  if (sql("postgres", "SELECT count(*) FROM lemmacomputer_schema_migrations") !== String(expectedMigrationCount)) {
    throw new Error("fresh migration ledger does not contain every discovered migration");
  }
  if (!sql("postgres", "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='connector_registry'::regclass AND conname='connector_registry_category_check'").includes("'Search'::text")) {
    throw new Error("connector registry category constraint does not accept Search");
  }
  const schemaCheck = exec("npm", ["run", "db:check"], { env: { ...process.env, DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${hostPort}/postgres` } });
  if (schemaCheck.status !== 0 || !schemaCheck.stdout.includes("schema is compatible")) throw new Error(schemaCheck.stderr || "schema compatibility check failed");
  if (!migrate("postgres").includes("no migrations applied")) throw new Error("second migration run was not a no-op");
  const postgresUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/postgres`;
  sql("postgres", "CREATE DATABASE migration_ledger_legacy");
  sql("postgres", "CREATE DATABASE migration_ledger_fresh");
  const migrationLedgerLegacyUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/migration_ledger_legacy`;
  const migrationLedgerFreshUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/migration_ledger_fresh`;
  sql("postgres", "CREATE DATABASE organization_rbac");
  migrate("organization_rbac");
  const organizationRbacUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/organization_rbac`;
  sql("postgres", "CREATE DATABASE organization_onboarding");
  migrate("organization_onboarding");
  const organizationOnboardingUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/organization_onboarding`;
  sql("postgres", "CREATE DATABASE better_auth_invitation");
  migrate("better_auth_invitation");
  const betterAuthInvitationUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/better_auth_invitation`;
  const featureTests = exec(process.execPath, [
    "--import", "tsx", "--test",
    "tests/activity-events-postgres.test.ts",
    "tests/agent-instances-postgres.test.ts",
    "tests/tool-audit-postgres.test.ts",
    "tests/teams-postgres.test.ts",
    "tests/team-budgets-postgres.test.ts",
    "tests/schedules-postgres.test.ts",
    "tests/usage-ledger-postgres.test.ts",
    "tests/routing-postgres.test.ts",
    "tests/governed-operation-retention-postgres.test.ts",
    "tests/openvtc-companion-push-postgres.test.ts",
    "tests/provider-settings-postgres.test.ts",
    "tests/spend-cost-coverage-postgres.test.ts",
    "tests/workspace-settings-postgres.test.ts",
    "tests/connector-policy-evidence.test.ts",
    "tests/workspace-administration-postgres.test.ts",
    "tests/protected-workspace-policy-postgres.test.ts",
    "tests/organization-rbac-postgres.test.ts",
    "tests/organization-onboarding-postgres.test.ts",
    "tests/better-auth-invitation-postgres.test.ts",
    "tests/tenant-iam-postgres.test.ts",
    "tests/tenant-sso-postgres.test.ts",
    "tests/platform-operator-postgres.test.ts",
    "tests/workspace-node-placement-postgres.test.ts",
    "tests/telegram-token-intake-postgres.test.ts",
    "tests/migration-ledger-baseline-postgres.test.ts",
  ], {
    env: {
      ...process.env,
      ACTIVITY_TEST_DATABASE_URL: postgresUrl,
      AGENT_INSTANCE_TEST_DATABASE_URL: postgresUrl,
      TEAM_TEST_DATABASE_URL: postgresUrl,
      USAGE_LEDGER_TEST_DATABASE_URL: postgresUrl,
      ROUTING_TEST_DATABASE_URL: postgresUrl,
      BUDGET_TEST_DATABASE_URL: postgresUrl,
      SCHEDULE_TEST_DATABASE_URL: postgresUrl,
      OPENVTC_PUSH_TEST_DATABASE_URL: postgresUrl,
      PROVIDER_SETTINGS_TEST_DATABASE_URL: postgresUrl,
      SPEND_COVERAGE_TEST_DATABASE_URL: postgresUrl,
      WORKSPACE_SETTINGS_TEST_DATABASE_URL: postgresUrl,
      POLICY_TEST_DATABASE_URL: postgresUrl,
      ORGANIZATION_RBAC_TEST_DATABASE_URL: organizationRbacUrl,
      ORGANIZATION_ONBOARDING_TEST_DATABASE_URL: organizationOnboardingUrl,
      BETTER_AUTH_INVITATION_TEST_DATABASE_URL: betterAuthInvitationUrl,
      PLATFORM_OPERATOR_TEST_DATABASE_URL: postgresUrl,
      WORKSPACE_NODE_PLACEMENT_TEST_DATABASE_URL: postgresUrl,
      TELEGRAM_INTAKE_TEST_DATABASE_URL: postgresUrl,
      MIGRATION_LEDGER_LEGACY_TEST_DATABASE_URL: migrationLedgerLegacyUrl,
      MIGRATION_LEDGER_FRESH_TEST_DATABASE_URL: migrationLedgerFreshUrl,
    },
  });
  if (featureTests.status !== 0) throw new Error(featureTests.stderr || featureTests.stdout || "PostgreSQL feature tests failed");

  sql("postgres", "CREATE DATABASE concurrent");
  const concurrentUrl = `postgres://postgres:${password}@127.0.0.1:${hostPort}/concurrent`;
  const children = [0, 1].map(() => spawn("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: concurrentUrl, LEMMACOMPUTER_INSTALLATION_KIND: "concurrency-test" },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  await Promise.all(children.map(waitFor));
  if (sql("concurrent", "SELECT count(*) FROM lemmacomputer_schema_migrations") !== String(expectedMigrationCount)) {
    throw new Error("concurrent migration ledger does not contain every discovered migration");
  }

  sql("postgres", "CREATE DATABASE legacy");
  const legacySql = (await Promise.all(legacyMigrationFiles.map((name) => readFile(`packages/workspace-store/migrations/${name}`, "utf8")))).join("\n");
  must("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "legacy"], { input: legacySql });
  if (!migrate("legacy").includes("baselined legacy schema")) throw new Error("legacy schema was not verified and baselined");
  if (sql("legacy", "SELECT count(*) FROM lemmacomputer_schema_migrations WHERE installation_kind='verified-legacy-baseline'") !== String(legacyMigrationIds.size)) {
    throw new Error("legacy baseline ledger is invalid");
  }
  if (sql("legacy", "SELECT count(*) FROM lemmacomputer_schema_migrations") !== String(expectedMigrationCount)) {
    throw new Error("legacy cutover did not apply every later migration");
  }

  sql("postgres", "CREATE DATABASE incompatible");
  sql("incompatible", "CREATE TABLE workspaces(id uuid PRIMARY KEY)");
  const failure = migrate("incompatible", false);
  if (!failure.includes("cannot be safely baselined")) throw new Error("incompatible legacy schema did not fail closed");
  if (sql("incompatible", "SELECT to_regclass('public.lemmacomputer_schema_migrations') IS NULL") !== "t") {
    throw new Error("failed legacy verification mutated the database");
  }

  sql("postgres", "UPDATE lemmacomputer_schema_migrations SET checksum_sha256=repeat('0',64) WHERE id='028'");
  if (!migrate("postgres", false).includes("historical migrations are immutable")) throw new Error("checksum drift did not fail closed");
  sql("authentication", "UPDATE lemmacomputer_auth_schema_migrations SET checksum_sha256=repeat('0',64) WHERE id='001'");
  if (!migrateAuth("authentication", false).includes("historical migrations are immutable")) throw new Error("authentication checksum drift did not fail closed");
  process.stdout.write("Database gate passed: product and authentication fresh, no-op, concurrent, mismatch, checksum, backup/restore, and dependency-rollback cases; product legacy baseline, organization RBAC, platform operator authority, agent instances, Activity, Teams, provider settings, usage ledger, spend cost coverage, schedule, Companion push, connector policy evidence, and Telegram intake replay cases.\n");
} finally {
  exec("docker", ["rm", "-f", container]);
}
