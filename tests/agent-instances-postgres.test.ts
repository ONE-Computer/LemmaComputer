import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { LemmaComputerError } from "@lemmacomputer/contracts";
import { PostgresAgentInstanceStore } from "@lemmacomputer/workspace-store";

const connectionString = process.env.AGENT_INSTANCE_TEST_DATABASE_URL;

test("PostgreSQL agent instances are tenant scoped, server allocated, idempotent, and evidence preserving", {
  skip: !connectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString });
  const store = PostgresAgentInstanceStore.fromConnectionString(connectionString!);
  const secondStore = PostgresAgentInstanceStore.fromConnectionString(connectionString!);
  const suffix = crypto.randomUUID();
  const tenantId = `agent-instance-tenant-${suffix}`;
  const outsiderTenantId = `agent-instance-outsider-${suffix}`;
  const subjectId = `agent-instance-subject-${suffix}`;
  const outsiderSubjectId = `agent-instance-outsider-subject-${suffix}`;
  const workspaceId = crypto.randomUUID();
  const secondWorkspaceId = crypto.randomUUID();
  const forgedInstanceId = crypto.randomUUID();
  const policyHash = "a".repeat(64);
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const registration = {
    tenantId,
    ownerSubjectId: subjectId,
    workspaceId,
    agentCatalogId: "claude-cli" as const,
    logicalAgentId: `logical-agent:${suffix}:claude-cli`,
    accessGeneration: 1,
    policyVersionId: `policy-${suffix}`,
    policyVersion: 1,
    policyHash,
    launchIdempotencyKey: `trusted-launch-${suffix}`,
  };

  try {
    await pool.query(
      `INSERT INTO tenants (id,external_tenant_id,display_name)
       VALUES ($1,$2,'Agent instance tenant'),($3,$4,'Agent instance outsider')`,
      [tenantId, `external-${tenantId}`, outsiderTenantId, `external-${outsiderTenantId}`],
    );
    await pool.query(
      `INSERT INTO users (id,tenant_id,email,display_name)
       VALUES ($1,$2,$3,'Agent owner'),($4,$5,$6,'Outsider')`,
      [
        subjectId,
        tenantId,
        `${subjectId}@example.test`,
        outsiderSubjectId,
        outsiderTenantId,
        `${outsiderSubjectId}@example.test`,
      ],
    );
    await pool.query(
      `INSERT INTO workspaces (
         id,tenant_id,subject_id,grant_id,state,provider_id,failure_code,operation_token,
         access_generation,created_at,updated_at
       ) VALUES
         ($1,$2,$3,$4,'ready','provider-one',NULL,NULL,1,now(),now()),
         ($5,$2,$3,$6,'ready','provider-two',NULL,NULL,1,now(),now())`,
      [workspaceId, tenantId, subjectId, `grant-${suffix}`, secondWorkspaceId, `grant-two-${suffix}`],
    );

    const created = await store.registerLaunch({
      ...registration,
      id: forgedInstanceId,
    } as typeof registration & { id: string });
    assert.equal(created.disposition, "created");
    assert.notEqual(created.instance.id, forgedInstanceId, "the registration caller cannot select the authoritative UUID");
    assert.match(created.instance.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.instance.status, "starting");
    assert.equal(created.instance.startedAt, null);
    assert.equal(created.instance.endReason, null);
    assert.equal(created.instance.cleanupStatus, "not_required");

    const replay = await store.registerLaunch(registration);
    assert.equal(replay.disposition, "existing");
    assert.equal(replay.instance.id, created.instance.id);

    await assert.rejects(
      store.registerLaunch({ ...registration, logicalAgentId: `${registration.logicalAgentId}:changed` }),
      (error) => error instanceof LemmaComputerError && error.code === "AGENT_INSTANCE_IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      store.registerLaunch({ ...registration, accessGeneration: 2, launchIdempotencyKey: `stale-${suffix}` }),
      (error) => error instanceof LemmaComputerError && error.code === "AGENT_INSTANCE_WORKSPACE_INVALID",
    );
    await assert.rejects(
      store.registerLaunch({
        ...registration,
        tenantId: outsiderTenantId,
        ownerSubjectId: outsiderSubjectId,
        launchIdempotencyKey: `cross-tenant-${suffix}`,
      }),
      (error) => error instanceof LemmaComputerError && error.code === "AGENT_INSTANCE_WORKSPACE_INVALID",
    );
    assert.equal(await store.get({
      tenantId: outsiderTenantId,
      ownerSubjectId: outsiderSubjectId,
      workspaceId,
      agentInstanceId: created.instance.id,
    }), null);

    const locator = {
      tenantId,
      ownerSubjectId: subjectId,
      workspaceId,
      agentInstanceId: created.instance.id,
    };
    const running = await store.markRunning({
      ...locator,
      providerRuntimeId: `process-${suffix}-1`,
      imageDigest,
      imageVersion: "workspace-image-v1",
    });
    assert.equal(running?.status, "running");
    assert.ok(running?.startedAt);
    assert.equal(running?.providerRuntimeId, `process-${suffix}-1`);
    assert.equal(running?.imageDigest, imageDigest);
    assert.equal((await store.markRunning({
      ...locator,
      providerRuntimeId: `process-${suffix}-1`,
      imageDigest,
      imageVersion: "workspace-image-v1",
    }))?.id, created.instance.id, "an exact running transition replay is idempotent");
    await assert.rejects(
      store.markRunning({ ...locator, providerRuntimeId: `process-${suffix}-changed` }),
      (error) => error instanceof LemmaComputerError && error.code === "AGENT_INSTANCE_LIFECYCLE_CONFLICT",
    );

    const ended = await store.end({
      ...locator,
      reason: "provider_failed",
      cleanupStatus: "incomplete",
      cleanupFailureCode: "PROVIDER_CLEANUP_TIMEOUT",
    });
    assert.equal(ended?.status, "ended");
    assert.equal(ended?.endReason, "provider_failed");
    assert.ok(ended?.endedAt);
    assert.equal(ended?.cleanupStatus, "incomplete");
    assert.equal(ended?.cleanupFailureCode, "PROVIDER_CLEANUP_TIMEOUT");
    assert.ok(ended?.cleanupFailureAt);

    const terminalReplay = await store.end({
      ...locator,
      reason: "workspace_terminated",
      cleanupStatus: "confirmed",
    });
    assert.equal(terminalReplay?.endReason, "provider_failed", "the first terminal evidence wins");
    assert.equal(terminalReplay?.endedAt?.toISOString(), ended?.endedAt?.toISOString());

    const cleanupConfirmed = await store.recordCleanupOutcome({
      ...locator,
      status: "confirmed",
    });
    assert.equal(cleanupConfirmed?.cleanupStatus, "confirmed");
    assert.ok(cleanupConfirmed?.cleanupConfirmedAt);
    assert.equal(
      cleanupConfirmed?.cleanupFailureCode,
      "PROVIDER_CLEANUP_TIMEOUT",
      "later confirmation must preserve evidence of the earlier incomplete cleanup",
    );
    assert.ok(cleanupConfirmed?.cleanupFailureAt);

    const secondLaunch = await store.registerLaunch({
      ...registration,
      launchIdempotencyKey: `trusted-launch-second-${suffix}`,
    });
    assert.notEqual(secondLaunch.instance.id, created.instance.id, "a distinct actual process launch receives a distinct UUID");

    const concurrentRegistration = {
      ...registration,
      launchIdempotencyKey: `trusted-launch-concurrent-${suffix}`,
    };
    const concurrent = await Promise.all([
      store.registerLaunch(concurrentRegistration),
      secondStore.registerLaunch(concurrentRegistration),
    ]);
    assert.deepEqual(concurrent.map(({ disposition }) => disposition).sort(), ["created", "existing"]);
    assert.equal(concurrent[0]!.instance.id, concurrent[1]!.instance.id);

    await store.markRunning({ ...locator, agentInstanceId: secondLaunch.instance.id, providerRuntimeId: `process-${suffix}-2` });
    assert.equal(await store.endActiveForWorkspace({
      tenantId, ownerSubjectId: subjectId, workspaceId, reason: "workspace_stopped",
    }), 2, "all still-active launches close together at a workspace lifecycle boundary");
    assert.equal((await store.get({ ...locator, agentInstanceId: secondLaunch.instance.id }))?.endReason, "workspace_stopped");

    for (const reason of ["workspace_restarted", "workspace_terminated"] as const) {
      const lifecycleLaunch = await store.registerLaunch({
        ...registration,
        launchIdempotencyKey: `trusted-launch-${reason}-${suffix}`,
      });
      await store.markRunning({
        ...locator,
        agentInstanceId: lifecycleLaunch.instance.id,
        providerRuntimeId: `process-${suffix}-${reason}`,
      });
      assert.equal(await store.endActiveForWorkspace({
        tenantId, ownerSubjectId: subjectId, workspaceId, reason,
      }), 1);
      assert.equal((await store.get({
        ...locator,
        agentInstanceId: lifecycleLaunch.instance.id,
      }))?.endReason, reason);
    }

    const abandoned = await store.registerLaunch({
      ...registration,
      launchIdempotencyKey: `trusted-launch-abandoned-${suffix}`,
    });
    await pool.query("UPDATE agent_instances SET launch_requested_at=now()-interval '10 minutes',created_at=now()-interval '10 minutes' WHERE id=$1", [abandoned.instance.id]);
    assert.equal(await store.reconcileAbandoned(new Date(Date.now() - 5 * 60_000)), 1);
    assert.equal((await store.get({ ...locator, agentInstanceId: abandoned.instance.id }))?.endReason, "reconciled_abandoned");

    await pool.query("DELETE FROM workspaces WHERE id=$1 AND tenant_id=$2", [workspaceId, tenantId]);
    const retained = await store.get(locator);
    assert.equal(retained?.id, created.instance.id, "workspace removal must not erase process evidence");

    await assert.rejects(
      pool.query(
        `INSERT INTO agent_instances (
           id,tenant_id,owner_subject_id,workspace_id,agent_catalog_id,logical_agent_id,
           access_generation,policy_version_id,policy_version,policy_hash,launch_idempotency_key
         ) VALUES ($1,$2,$3,$4,'claude-cli','logical-cross-tenant',1,'policy-cross-tenant',1,$5,$6)`,
        [crypto.randomUUID(), tenantId, outsiderSubjectId, secondWorkspaceId, policyHash, `direct-cross-tenant-${suffix}`],
      ),
      (error) => error instanceof Error && "code" in error && error.code === "23503",
    );
  } finally {
    await pool.query("DELETE FROM agent_instances WHERE tenant_id IN ($1,$2)", [tenantId, outsiderTenantId]).catch(() => undefined);
    await pool.query("DELETE FROM workspaces WHERE tenant_id IN ($1,$2)", [tenantId, outsiderTenantId]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE tenant_id IN ($1,$2)", [tenantId, outsiderTenantId]).catch(() => undefined);
    await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantId, outsiderTenantId]).catch(() => undefined);
    await Promise.all([store.close(), secondStore.close(), pool.end()]);
  }
});
