import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  MemoryConnectorRegistryStore,
  PostgresConnectorRegistryStore,
  PostgresWorkspaceStore,
  type ConnectorRegistryStore,
  type SaveConnectorRegistryRecord,
} from "@lemmacomputer/workspace-store";

const connector = (tenantId: string, id = "reports"): SaveConnectorRegistryRecord => ({
  tenantId,
  id,
  serverId: `server-${tenantId}-${id}`,
  serverName: `lemmacomputer_${tenantId}_${id}`,
  name: "Reports",
  shortDescription: "Company reports",
  description: "Review company reports.",
  category: "Business",
  services: ["Reports"],
  endpointUrl: "https://mcp.reports.example/mcp",
  authorizationOrigins: ["https://auth.reports.example"],
  scopes: ["reports.read"],
  brand: "generic",
  policySupport: "automatic",
  source: "custom",
  createdBy: "admin-a",
});

const exercisePolicyEvidence = async (store: ConnectorRegistryStore, tenantId: string) => {
  const saved = await store.saveConnector(connector(tenantId));
  const applied = await store.applyAccessPolicyChange(tenantId, saved.id, {
    enabled: true,
    membersCanManage: false,
    updatedBy: "admin-a",
    expectedVersion: 1,
    correlationId: "access-save",
  });
  assert.equal(applied?.event.outcome, "applied");
  assert.deepEqual([applied?.event.oldVersion, applied?.event.newVersion], [1, 2]);
  assert.notEqual(applied?.event.oldPolicyHash, applied?.event.newPolicyHash);

  const conflict = await store.applyAccessPolicyChange(tenantId, saved.id, {
    enabled: false,
    membersCanManage: false,
    updatedBy: "admin-b",
    expectedVersion: 1,
    correlationId: "stale-access-save",
  });
  assert.equal(conflict?.event.outcome, "conflict");
  assert.equal(conflict?.event.failureCode, "CONNECTOR_POLICY_VERSION_CONFLICT");
  assert.equal(conflict?.connector.accessPolicyVersion, 2);

  const reviewedDefinitionHash = "d".repeat(64);
  const toolApplied = await store.applyToolPolicyChange(tenantId, saved.id, {
    toolPolicies: { read_report: "allow", delete_report: "deny" },
    toolDefinitionHashes: { read_report: "a".repeat(64), delete_report: "b".repeat(64) },
    updatedBy: "admin-a",
    expectedVersion: 2,
    reviewedDefinitionHash,
    correlationId: "tool-save",
  });
  assert.equal(toolApplied?.event.outcome, "applied");
  assert.deepEqual([toolApplied?.event.oldVersion, toolApplied?.event.newVersion], [2, 3]);
  assert.equal(toolApplied?.event.reviewedDefinitionHash, reviewedDefinitionHash);
  const driftConflict = await store.recordToolPolicyConflict(tenantId, saved.id, {
    actorUserId: "admin-a",
    reviewedDefinitionHash: "e".repeat(64),
    failureCode: "TOOL_SET_CHANGED_REVIEW_AGAIN",
    correlationId: "provider-drift",
  });
  assert.equal(driftConflict?.outcome, "conflict");
  assert.equal(driftConflict?.failureCode, "TOOL_SET_CHANGED_REVIEW_AGAIN");

  const workspaceId = crypto.randomUUID();
  await store.appendPolicyWorkspaceDeliveryReceipts([{
    tenantId,
    changeEventId: toolApplied!.event.id,
    workspaceId,
    ownerSubjectId: "member-a",
    grantId: "personal",
    workspaceState: "ready",
    outcome: "failed",
    failureCode: "CONNECTOR_GRANT_REFRESH_FAILED",
  }]);
  await store.appendPolicyWorkspaceDeliveryReceipts([{
    tenantId,
    changeEventId: toolApplied!.event.id,
    workspaceId,
    ownerSubjectId: "member-a",
    grantId: "personal",
    workspaceState: "ready",
    outcome: "refreshed",
    failureCode: null,
  }]);
  const latest = await store.latestPolicyDelivery(tenantId, saved.id);
  assert.equal(latest?.event.id, toolApplied?.event.id);
  assert.deepEqual(latest?.receipts.map((receipt) => receipt.outcome).sort(), ["failed", "refreshed"]);
  assert.equal(await store.latestPolicyDelivery(`${tenantId}-foreign`, saved.id), null);
  await assert.rejects(() => store.appendPolicyWorkspaceDeliveryReceipts([{
    tenantId: `${tenantId}-foreign`,
    changeEventId: toolApplied!.event.id,
    workspaceId: crypto.randomUUID(),
    ownerSubjectId: "foreign-member",
    grantId: "personal",
    workspaceState: "ready",
    outcome: "refreshed",
    failureCode: null,
  }]));
  return toolApplied!;
};

test("connector policy evidence is version checked, append only, and tenant scoped in memory", async () => {
  await exercisePolicyEvidence(new MemoryConnectorRegistryStore(), "tenant-memory");
});

const connectionString = process.env.WORKSPACE_SETTINGS_TEST_DATABASE_URL;

test("PostgreSQL persists immutable connector policy changes and workspace delivery receipts", {
  skip: !connectionString,
}, async () => {
  const migrationStore = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const store = PostgresConnectorRegistryStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const tenantId = `connector-evidence-${crypto.randomUUID()}`;
  try {
    await migrationStore.migrate();
    await pool.query("INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Connector evidence')", [tenantId, `external-${tenantId}`]);
    await pool.query("INSERT INTO organizations (id,display_name) VALUES ($1,'Connector evidence')", [tenantId]);
    const applied = await exercisePolicyEvidence(store, tenantId);
    await assert.rejects(
      pool.query("UPDATE connector_policy_change_events SET actor_user_id='tampered' WHERE tenant_id=$1 AND id=$2::uuid", [tenantId, applied.event.id]),
      /immutable/,
    );
    await assert.rejects(
      pool.query("DELETE FROM connector_policy_workspace_delivery_receipts WHERE tenant_id=$1", [tenantId]),
      /immutable/,
    );
  } finally {
    await pool.end();
    await store.close();
    await migrationStore.close();
  }
});
