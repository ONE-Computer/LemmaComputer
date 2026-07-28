import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { discoverWorkspaceMigrations } from "@onecomputer/workspace-store";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the migration plan preserves the immutable legacy chain and accepts later generated migrations", async () => {
  const migrations = await discoverWorkspaceMigrations();
  const legacyIds = Array.from({ length: 28 }, (_, index) => String(index + 1).padStart(3, "0"));
  assert.ok(migrations.length >= legacyIds.length);
  assert.deepEqual(migrations.slice(0, legacyIds.length).map((migration) => migration.id), legacyIds);

  const discoveredIds = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    assert.match(migration.checksumSha256, /^[0-9a-f]{64}$/);
    if (index === 0) {
      assert.deepEqual(migration.dependsOn, []);
    } else if (index < legacyIds.length) {
      assert.deepEqual(migration.dependsOn, [migrations[index - 1]?.id]);
    } else {
      assert.match(migration.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.ok(migration.dependsOn.length > 0);
      for (const dependency of migration.dependsOn) {
        assert.ok(discoveredIds.has(dependency), `${migration.id} must only depend on an earlier migration`);
      }
    }
    discoveredIds.add(migration.id);
  }
});

test("service startup only checks schema and Compose owns the migration job", async () => {
  const [server, compose] = await Promise.all([
    source("apps/control-api/src/server.ts"),
    source("compose.yaml"),
  ]);
  assert.match(server, /await store\.assertSchemaCompatible\(\)/);
  assert.doesNotMatch(server, /await store\.migrate\(\)/);
  assert.match(compose, /db-migrate:[\s\S]+command: \["npm", "run", "db:migrate"\]/);
  assert.match(compose, /control-api:[\s\S]+db-migrate:\s+condition: service_completed_successfully/);
});
