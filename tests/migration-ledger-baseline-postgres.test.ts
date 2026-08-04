import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  assertWorkspaceSchemaCompatible,
  discoverWorkspaceMigrations,
  runWorkspaceMigrations,
} from "@lemmacomputer/workspace-store";

const legacyConnectionString = process.env.MIGRATION_LEDGER_LEGACY_TEST_DATABASE_URL;
const freshConnectionString = process.env.MIGRATION_LEDGER_FRESH_TEST_DATABASE_URL;
const legacyMigrationFile = /^\d{3}_/;
const forwardMigrationId = `01H${"0".repeat(23)}`;
const forwardMigrationFile = `${forwardMigrationId}_ledger_baseline_probe.sql`;
const forwardMigrationSql = `-- id: ${forwardMigrationId}
-- depends-on: 028
CREATE TABLE migration_ledger_baseline_probe (
  id integer PRIMARY KEY
);
`;

type LedgerRow = {
  id: string;
  checksum_sha256: string;
  installation_kind: string;
};

async function createMigrationFixture() {
  const sourceDirectory = new URL("../packages/workspace-store/migrations/", import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-migration-ledger-"));
  const legacyMigrationNames = (await readdir(sourceDirectory))
    .filter((fileName) => legacyMigrationFile.test(fileName))
    .sort();
  await Promise.all(legacyMigrationNames.map((fileName) =>
    copyFile(new URL(fileName, sourceDirectory), join(directory, fileName)),
  ));
  const forwardMigrationPath = join(directory, forwardMigrationFile);
  await writeFile(forwardMigrationPath, forwardMigrationSql);
  return {
    directory,
    forwardMigrationPath,
    legacyMigrationNames,
    migrationDirectory: pathToFileURL(`${directory}/`),
  };
}

async function applyRawLegacySchema(pool: pg.Pool, directory: string, migrationNames: string[]) {
  for (const migrationName of migrationNames) {
    await pool.query(await readFile(join(directory, migrationName), "utf8"));
  }
}

async function readLedger(pool: pg.Pool) {
  return (await pool.query<LedgerRow>(
    "SELECT id,checksum_sha256,installation_kind FROM lemmacomputer_schema_migrations ORDER BY id",
  )).rows;
}

test("migration discovery rejects a forward migration that depends on a later migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lemmacomputer-forward-dependency-"));
  const firstId = "01H" + "0".repeat(23);
  const laterId = "01J" + "0".repeat(23);
  try {
    await writeFile(join(directory, firstId + "_first.sql"), "-- id: " + firstId + "\n-- depends-on: " + laterId + "\nSELECT 1;\n");
    await writeFile(join(directory, laterId + "_later.sql"), "-- id: " + laterId + "\nSELECT 1;\n");
    await assert.rejects(
      discoverWorkspaceMigrations(pathToFileURL(directory + "/")),
      /depends on missing or later migration/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-ledger 028 databases baseline only legacy migrations and execute later migrations", {
  skip: !legacyConnectionString || !freshConnectionString,
}, async () => {
  const fixture = await createMigrationFixture();
  const legacyPool = new pg.Pool({ connectionString: legacyConnectionString! });
  const freshPool = new pg.Pool({ connectionString: freshConnectionString! });
  try {
    const plan = await discoverWorkspaceMigrations(fixture.migrationDirectory);
    const legacyPlan = plan.filter((migration) => legacyMigrationFile.test(migration.fileName));
    assert.deepEqual(legacyPlan.map((migration) => migration.id),
      Array.from({ length: 28 }, (_, index) => String(index + 1).padStart(3, "0")));
    assert.deepEqual(plan.at(-1)?.id, forwardMigrationId);

    await applyRawLegacySchema(legacyPool, fixture.directory, fixture.legacyMigrationNames);
    const legacyFirstRun = await runWorkspaceMigrations(legacyPool, {
      installationKind: "migration-ledger-baseline-test",
      migrationDirectory: fixture.migrationDirectory,
    });
    assert.equal(legacyFirstRun.baselined, true);
    assert.deepEqual(legacyFirstRun.applied, [forwardMigrationId]);
    assert.equal((await legacyPool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.migration_ledger_baseline_probe') IS NOT NULL AS exists",
    )).rows[0]?.exists, true);

    const freshFirstRun = await runWorkspaceMigrations(freshPool, {
      installationKind: "migration-ledger-baseline-test",
      migrationDirectory: fixture.migrationDirectory,
    });
    assert.equal(freshFirstRun.baselined, false);
    assert.deepEqual(freshFirstRun.applied, plan.map((migration) => migration.id));

    const [legacyLedger, freshLedger] = await Promise.all([readLedger(legacyPool), readLedger(freshPool)]);
    assert.equal(legacyLedger.filter((row) => row.installation_kind === "verified-legacy-baseline").length, 28);
    assert.equal(legacyLedger.find((row) => row.id === forwardMigrationId)?.installation_kind,
      "migration-ledger-baseline-test");
    assert.ok(freshLedger.every((row) => row.installation_kind === "migration-ledger-baseline-test"));
    assert.deepEqual(
      legacyLedger.map((row) => [row.id, row.checksum_sha256]),
      freshLedger.map((row) => [row.id, row.checksum_sha256]),
    );

    await Promise.all([
      assertWorkspaceSchemaCompatible(legacyPool, { migrationDirectory: fixture.migrationDirectory }),
      assertWorkspaceSchemaCompatible(freshPool, { migrationDirectory: fixture.migrationDirectory }),
    ]);
    assert.deepEqual(await runWorkspaceMigrations(legacyPool, {
      installationKind: "migration-ledger-baseline-test",
      migrationDirectory: fixture.migrationDirectory,
    }), { applied: [], baselined: false });
    assert.deepEqual(await runWorkspaceMigrations(freshPool, {
      installationKind: "migration-ledger-baseline-test",
      migrationDirectory: fixture.migrationDirectory,
    }), { applied: [], baselined: false });

    await legacyPool.query(
      "UPDATE lemmacomputer_schema_migrations SET depends_on=ARRAY['027']::text[] WHERE id=$1",
      [forwardMigrationId],
    );
    await assert.rejects(
      runWorkspaceMigrations(legacyPool, { migrationDirectory: fixture.migrationDirectory }),
      /dependencies differ from the applied ledger/,
    );
    await legacyPool.query(
      "UPDATE lemmacomputer_schema_migrations SET depends_on=ARRAY['028']::text[] WHERE id=$1",
      [forwardMigrationId],
    );

    await writeFile(fixture.forwardMigrationPath, `${forwardMigrationSql}-- checksum mutation fixture\n`);
    await assert.rejects(
      runWorkspaceMigrations(legacyPool, { migrationDirectory: fixture.migrationDirectory }),
      /changed after it was applied/,
    );
  } finally {
    await Promise.all([legacyPool.end(), freshPool.end()]);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
