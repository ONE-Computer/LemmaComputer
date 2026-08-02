import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresWorkspaceStore } from "@onecomputer/workspace-store";

const connectionString = process.env.TELEGRAM_INTAKE_TEST_DATABASE_URL;

test("PostgreSQL Telegram intake grants are expiry-bound and single-use under concurrent redemption", {
  skip: !connectionString,
}, async () => {
  const store = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const tenantId = `telegram-intake-test-${randomUUID()}`;
  const baseGrant = {
    tenantId,
    subjectId: "owner",
    action: "create" as const,
    credentialId: randomUUID(),
    idempotencyKey: `telegram-intake-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  };
  try {
    await store.migrate();
    const grantId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consumeTelegramTokenIntakeGrant({ ...baseGrant, grantId })),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(
      await store.consumeTelegramTokenIntakeGrant({ ...baseGrant, grantId: randomUUID(), expiresAt: new Date(Date.now() - 1) }),
      false,
    );
  } finally {
    await pool.query("DELETE FROM telegram_token_intake_grants WHERE tenant_id=$1", [tenantId]);
    await Promise.all([store.close(), pool.end()]);
  }
});
