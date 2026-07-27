import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { discoverWorkspaceMigrations } from "@onecomputer/workspace-store";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the migration plan discovers every immutable legacy migration in dependency order", async () => {
  const migrations = await discoverWorkspaceMigrations();
  assert.equal(migrations.length, 28);
  assert.deepEqual(migrations.map((migration) => migration.id),
    Array.from({ length: 28 }, (_, index) => String(index + 1).padStart(3, "0")));
  assert.equal(migrations[0]?.dependsOn.length, 0);
  for (let index = 1; index < migrations.length; index += 1) {
    assert.deepEqual(migrations[index]?.dependsOn, [migrations[index - 1]?.id]);
  }
  for (const migration of migrations) assert.match(migration.checksumSha256, /^[0-9a-f]{64}$/);
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
