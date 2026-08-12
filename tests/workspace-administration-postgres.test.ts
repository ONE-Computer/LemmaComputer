import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import { PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.WORKSPACE_SETTINGS_TEST_DATABASE_URL;

test("PostgreSQL workspace administration commands are tenant scoped, idempotent, and immutable", {
  skip: !connectionString,
}, async () => {
  const store = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const suffix = crypto.randomUUID();
  const tenantId = `workspace-admin-${suffix}`;
  const ownerSubjectId = `owner-${suffix}`;
  const actorUserId = `admin-${suffix}`;
  const workspaceId = crypto.randomUUID();
  const input = {
    tenantId,
    workspaceId,
    ownerSubjectId,
    actorUserId,
    action: "restart" as const,
    idempotencyKeyHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    correlationId: `correlation-${suffix}`,
    requestedAt: new Date(),
  };
  try {
    await store.migrate();
    await pool.query(
      `INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Workspace administration')`,
      [tenantId, `external-${tenantId}`],
    );
    await pool.query(
      `INSERT INTO organizations (id,display_name) VALUES ($1,'Workspace administration')`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,display_name) VALUES ($1,$2,$3,'Workspace owner')`,
      [ownerSubjectId, tenantId, `${ownerSubjectId}@example.test`],
    );
    await pool.query(
      `INSERT INTO workspaces (id,tenant_id,subject_id,grant_id,state,created_at,updated_at)
       VALUES ($1,$2,$3,'personal','ready',now(),now())`,
      [workspaceId, tenantId, ownerSubjectId],
    );

    const created = await store.beginWorkspaceAdministrationCommand(input);
    assert.equal(created.replayed, false);
    assert.equal(created.command.status, "pending");
    const replay = await store.beginWorkspaceAdministrationCommand(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.command.id, created.command.id);
    await assert.rejects(
      store.beginWorkspaceAdministrationCommand({ ...input, action: "stop" }),
      (error) => error instanceof LemmaComputerError && error.code === "IDEMPOTENCY_KEY_REUSED",
    );
    await assert.rejects(
      store.beginWorkspaceAdministrationCommand({ ...input, tenantId: `foreign-${tenantId}`, idempotencyKeyHash: "c".repeat(64) }),
      (error) => error instanceof LemmaComputerError && error.code === "WORKSPACE_NOT_FOUND",
    );

    const completed = await store.completeWorkspaceAdministrationCommand({
      tenantId,
      commandId: created.command.id,
      status: "succeeded",
      workspaceState: "ready",
      completedAt: new Date(),
    });
    assert.equal(completed.status, "succeeded");
    assert.equal((await store.completeWorkspaceAdministrationCommand({
      tenantId,
      commandId: created.command.id,
      status: "succeeded",
      workspaceState: "ready",
      completedAt: new Date(),
    })).id, completed.id);

    const audit = await store.listWorkspaceAdministrationAuditEvents(tenantId, workspaceId);
    assert.deepEqual(audit.map((event) => event.outcome), ["requested", "succeeded"]);
    assert.ok(audit.every((event) => event.actorUserId === actorUserId && event.ownerSubjectId === ownerSubjectId));
    await assert.rejects(
      pool.query("UPDATE workspace_administration_audit_events SET actor_user_id='mutated' WHERE command_id=$1", [completed.id]),
      /Workspace administration audit events are immutable/,
    );
    await assert.rejects(
      pool.query("DELETE FROM workspace_administration_commands WHERE id=$1", [completed.id]),
      /Workspace administration command evidence cannot be deleted/,
    );
  } finally {
    await Promise.all([store.close(), pool.end()]);
  }
});
