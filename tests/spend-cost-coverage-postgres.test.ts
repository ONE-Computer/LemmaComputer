import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresSpendObservabilityStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.SPEND_COVERAGE_TEST_DATABASE_URL;

test("PostgreSQL cost-coverage acknowledgements are append-only, monotonic, and tenant-scoped", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString });
  const store = PostgresSpendObservabilityStore.fromConnectionString(connectionString!);
  const suffix = crypto.randomUUID();
  const tenantId = `coverage-tenant-${suffix}`;
  const otherTenantId = `coverage-other-${suffix}`;
  const administratorId = `coverage-admin-${suffix}`;
  const otherAdministratorId = `coverage-other-admin-${suffix}`;
  try {
    await pool.query(
      `INSERT INTO tenants(id,external_tenant_id,display_name)
       VALUES ($1,$2,'Coverage tenant'),($3,$4,'Other coverage tenant')`,
      [tenantId, `external-${tenantId}`, otherTenantId, `external-${otherTenantId}`],
    );
    await pool.query(
      `INSERT INTO users(id,tenant_id,email,display_name)
       VALUES ($1,$2,$3,'Coverage administrator'),($4,$5,$6,'Other coverage administrator')`,
      [
        administratorId, tenantId, `${administratorId}@example.test`,
        otherAdministratorId, otherTenantId, `${otherAdministratorId}@example.test`,
      ],
    );
    const january = new Date("2026-01-01T00:00:00.000Z");
    const february = new Date("2026-02-01T00:00:00.000Z");
    const first = await store.acknowledgeUnpricedUsage({
      tenantId, receivedBefore: january, acknowledgedBy: administratorId,
    });
    assert.equal(first.receivedBefore, january.toISOString());

    const repeated = await store.acknowledgeUnpricedUsage({
      tenantId, receivedBefore: new Date("2025-12-01T00:00:00.000Z"), acknowledgedBy: administratorId,
    });
    assert.equal(repeated.receivedBefore, january.toISOString());

    const advanced = await store.acknowledgeUnpricedUsage({
      tenantId, receivedBefore: february, acknowledgedBy: administratorId,
    });
    assert.equal(advanced.receivedBefore, february.toISOString());

    await store.acknowledgeUnpricedUsage({
      tenantId: otherTenantId, receivedBefore: january, acknowledgedBy: otherAdministratorId,
    });
    const counts = await pool.query(
      `SELECT tenant_id,count(*)::integer AS count
       FROM ai_cost_coverage_acknowledgements
       WHERE tenant_id IN ($1,$2)
       GROUP BY tenant_id
       ORDER BY tenant_id`,
      [tenantId, otherTenantId],
    );
    assert.deepEqual(
      Object.fromEntries(counts.rows.map((row) => [String(row.tenant_id), Number(row.count)])),
      { [otherTenantId]: 1, [tenantId]: 2 },
    );
  } finally {
    await pool.query("DELETE FROM ai_cost_coverage_acknowledgements WHERE tenant_id IN ($1,$2)", [tenantId, otherTenantId]);
    await pool.query("DELETE FROM users WHERE tenant_id IN ($1,$2)", [tenantId, otherTenantId]);
    await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantId, otherTenantId]);
    await Promise.all([store.close(), pool.end()]);
  }
});
