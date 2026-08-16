import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformOperatorStore, PostgresWorkspaceStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.WORKSPACE_NODE_PLACEMENT_TEST_DATABASE_URL;
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

test("hosted placement is tenant-assigned, workspace-sticky, cleanup-sticky, and fail closed", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const operators = new PostgresPlatformOperatorStore(pool);
  const workspaces = new PostgresWorkspaceStore(pool);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const tenantId = `placement-${suffix}`;
  const subjectId = `subject-${suffix}`;
  const nodeA = `node-a-${suffix}`;
  const nodeB = `node-b-${suffix}`;
  const now = new Date("2026-08-16T03:00:00.000Z");
  try {
    await pool.query(
      "INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Placement tenant')",
      [tenantId, `external-${suffix}`],
    );
    await pool.query(
      "INSERT INTO organizations (id,display_name) VALUES ($1,'Placement tenant')",
      [tenantId],
    );
    const administrator = await operators.provisionOperator({
      issuer: "https://login.microsoftonline.com/workforce/v2.0",
      subject: `placement-admin-${suffix}`,
      workforceTenantId: "workforce-directory",
      email: `placement-admin-${suffix}@example.test`,
      displayName: "Placement Administrator",
      roles: ["platform-administrator"],
    });
    const session = await operators.createSession({
      operatorId: administrator.id,
      tokenHash: tokenHash(`placement-session-${suffix}`),
      assurance: { level: "aal2", factors: ["federated", "totp"] },
      authenticatedAt: new Date("2026-08-16T02:55:00.000Z"),
      recentStepUpAt: new Date("2026-08-16T02:59:00.000Z"),
      expiresAt: new Date("2026-08-16T12:00:00.000Z"),
      correlationId: `placement-login-${suffix}`,
    });

    await operators.registerWorkspaceNode(session, {
      id: nodeA,
      endpointUrl: `https://${nodeA}.nodes.internal:4101`,
      tlsServerName: `${nodeA}.nodes.internal`,
      reason: "Register the first hosted workspace node",
      correlationId: `register-a-${suffix}`,
      now,
    });
    await operators.registerWorkspaceNode(session, {
      id: nodeB,
      endpointUrl: `https://${nodeB}.nodes.internal:4101`,
      tlsServerName: `${nodeB}.nodes.internal`,
      reason: "Register the second hosted workspace node",
      correlationId: `register-b-${suffix}`,
      now,
    });
    await operators.assignTenantWorkspaceNode(session, {
      tenantId,
      workspaceNodeId: nodeA,
      reason: "Place this tenant on the first workspace node",
      correlationId: `assign-a-${suffix}`,
      now,
    });

    const identity = { tenantId, subjectId, audience: "lemmacomputer-control" } as const;
    const first = await workspaces.createOrGet(identity, `grant-a-${suffix}`, `idempotency-a-${suffix}`);
    assert.equal((await operators.resolveWorkspaceNode(first.id)).id, nodeA);

    await operators.assignTenantWorkspaceNode(session, {
      tenantId,
      workspaceNodeId: nodeB,
      reason: "Move only future workspaces to the second node",
      correlationId: `assign-b-${suffix}`,
      now: new Date("2026-08-16T03:01:00.000Z"),
    });
    const second = await workspaces.createOrGet(identity, `grant-b-${suffix}`, `idempotency-b-${suffix}`);
    assert.equal((await operators.resolveWorkspaceNode(first.id)).id, nodeA, "existing workspace placement is immutable");
    assert.equal((await operators.resolveWorkspaceNode(second.id)).id, nodeB, "new workspace uses the current tenant assignment");
    await assert.rejects(
      () => operators.resolveWorkspaceNode(first.id, nodeB),
      { code: "WORKSPACE_NODE_PLACEMENT_MISMATCH" },
    );

    await workspaces.update(first.id, { state: "open", providerId: "sandbox-a" });
    await workspaces.update(second.id, { state: "open", providerId: "sandbox-b" });
    await operators.updateTenantLifecycle(session, {
      tenantId,
      lifecycleState: "suspended",
      reason: "Suspend the tenant to verify cleanup placement snapshots",
      correlationId: `suspend-${suffix}`,
      now: new Date("2026-08-16T03:02:00.000Z"),
    });
    const cleanup = (await operators.listTenantCleanupJobs()).filter((job) => job.tenantId === tenantId);
    assert.deepEqual(
      cleanup.map((job) => [job.workspaceId, job.workspaceNodeId]).sort(),
      [[first.id, nodeA], [second.id, nodeB]].sort(),
    );

    await operators.updateWorkspaceNodeState(session, {
      workspaceNodeId: nodeA,
      state: "disabled",
      reason: "Disable the node to prove routing fails closed",
      correlationId: `disable-a-${suffix}`,
      now: new Date("2026-08-16T03:03:00.000Z"),
    });
    await assert.rejects(
      () => operators.resolveWorkspaceNode(first.id),
      { code: "WORKSPACE_NODE_DISABLED" },
    );
  } finally {
    await pool.end();
  }
});
