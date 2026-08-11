import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertAuthenticationSchemaCompatible,
  discoverAuthenticationMigrations,
} from "@lemmacomputer/auth-store";

test("authentication migrations are a distinct pinned Better Auth stream", async () => {
  const migrations = await discoverAuthenticationMigrations();
  assert.equal(migrations.length, 3);
  assert.equal(migrations[0]?.id, "001");
  assert.equal(migrations[0]?.name, "better_auth_1_6_26");
  assert.deepEqual(migrations[0]?.dependsOn, []);
  assert.equal(migrations[1]?.id, "002");
  assert.equal(migrations[1]?.name, "database_rate_limits");
  assert.deepEqual(migrations[1]?.dependsOn, ["001"]);
  assert.match(migrations[0]?.checksumSha256 ?? "", /^[0-9a-f]{64}$/);

  const sql = migrations[0]?.sql ?? "";
  for (const table of ["user", "account", "session", "verification", "twoFactor", "passkey"]) {
    assert.match(sql, new RegExp(`CREATE TABLE \\"${table}\\"`));
  }
  assert.doesNotMatch(sql, /account_users|organizations|organization_memberships|browser_sessions/);
  assert.match(migrations[1]?.sql ?? "", /CREATE TABLE "rateLimit"/);
  assert.equal(migrations[2]?.id, "003");
  assert.equal(migrations[2]?.name, "better_auth_sso_1_6_26");
  assert.deepEqual(migrations[2]?.dependsOn, ["002"]);
  assert.match(migrations[2]?.sql ?? "", /CREATE TABLE "ssoProvider"/);
  assert.match(migrations[2]?.sql ?? "", /"organizationId" text/);
  assert.match(migrations[2]?.sql ?? "", /"domainVerified" boolean/);
  assert.doesNotMatch(migrations[2]?.sql ?? "", /organizations|organization_memberships|role|permission/i);
});

test("authentication migration and compatibility commands are explicit and separate", async () => {
  const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(rootPackage.scripts["auth:db:migrate"], "tsx apps/control-api/src/migrate-auth.ts");
  assert.equal(rootPackage.scripts["auth:db:check"], "tsx apps/control-api/src/check-auth-schema.ts");
  assert.notEqual(rootPackage.scripts["auth:db:migrate"], rootPackage.scripts["db:migrate"]);
});

test("startup compatibility check never creates or mutates schema", async () => {
  const statements: string[] = [];
  const client = {
    async query(query: string) {
      statements.push(query);
      if (query.includes("to_regclass")) return { rows: [{ exists: false }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };

  await assert.rejects(
    assertAuthenticationSchemaCompatible(pool as never),
    /Authentication database schema is not initialized; run npm run auth:db:migrate/,
  );
  assert.equal(statements.some((statement) => /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(statement)), false);
});
