import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  PostgresScheduleStore,
  PostgresWorkspaceStore,
} from "@lemmacomputer/workspace-store";
import type { IdentityContext } from "@lemmacomputer/contracts";

const connectionString = process.env.SCHEDULE_TEST_DATABASE_URL;

test("PostgreSQL schedule claims are exclusive and workspace deletion cascades", {
  skip: !connectionString,
}, async () => {
  const workspaceStore = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const pool = new pg.Pool({ connectionString });
  const first = PostgresScheduleStore.fromConnectionString(connectionString!);
  const second = PostgresScheduleStore.fromConnectionString(connectionString!);
  const identity: IdentityContext = {
    tenantId: `schedule-test-${crypto.randomUUID()}`,
    subjectId: "owner",
    audience: "lemmacomputer-control",
  };
  try {
    await workspaceStore.migrate();
    await pool.query(
      `INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Schedule tenant')`,
      [identity.tenantId, `external-${identity.tenantId}`],
    );
    await pool.query("INSERT INTO organizations(id,display_name) VALUES($1,'Schedule tenant')", [identity.tenantId]);
    const workspace = await workspaceStore.createOrGet(identity, "schedule-test", crypto.randomUUID());
    const scheduleId = crypto.randomUUID();
    const created = await first.createSchedule(identity, {
      id: scheduleId,
      workspaceId: workspace.id,
      agentCatalogId: "codex-cli",
      requestedServiceClass: "pro",
      reasoningEffort: "high",
      title: "PostgreSQL schedule",
      promptCiphertext: "encrypted-fixture",
      cronExpression: "0 9 * * *",
      timeZone: "UTC",
      state: "enabled",
      nextRunAt: new Date(Date.now() + 86_400_000),
    });
    assert.equal(created?.id, scheduleId);
    assert.equal(created?.requestedServiceClass, "pro");
    assert.equal(created?.reasoningEffort, "high");
    assert.equal((await first.updateSchedule(identity, scheduleId, { title: "Updated schedule" }))?.title, "Updated schedule");

    const queued = await first.queueScheduleRun(identity, scheduleId, new Date());
    assert.ok(queued);
    const claims = await Promise.all([
      first.claimDueScheduleRuns(new Date(), 10, 120_000),
      second.claimDueScheduleRuns(new Date(), 10, 120_000),
    ]);
    const ownedClaims = claims.flat().filter((claim) => claim.run.scheduleId === scheduleId);
    assert.equal(ownedClaims.length, 1);
    const claim = ownedClaims[0]!;
    assert.ok(claim.run.leaseToken);
    assert.ok(await first.beginScheduleRun(claim.run.id, claim.run.leaseToken!, new Date()));
    const retryAt = new Date(Date.now() + 30_000);
    assert.equal((await first.deferScheduleRun(claim.run.id, {
      retryAt,
      failureCode: "WORKSPACE_POLICY_TRANSITION_IN_PROGRESS",
      failureSummary: "Waiting for updated guardrails",
    }))?.state, "claimed");
    assert.equal((await second.claimDueScheduleRuns(new Date(), 10, 120_000)).length, 0);
    const [retried] = await second.claimDueScheduleRuns(new Date(retryAt.getTime() + 1), 10, 120_000);
    assert.ok(retried?.run.leaseToken);
    assert.ok(await second.beginScheduleRun(retried.run.id, retried.run.leaseToken!, new Date(retryAt.getTime() + 2)));
    assert.equal((await second.finishScheduleRun(retried.run.id, {
      state: "succeeded",
      sessionId: "session-postgres-test",
      completedAt: new Date(retryAt.getTime() + 3),
    }))?.state, "succeeded");

    const credentialId = crypto.randomUUID();
    await workspaceStore.saveChannelCredential(identity, {
      id: credentialId,
      kind: "telegram_bot_token",
      credentialCiphertext: "encrypted-telegram-fixture",
      credentialKeyVersion: 1,
      version: 1,
      fingerprint: `channel-${crypto.randomUUID()}`,
      displayName: "Lifecycle fixture",
      botUsername: "lifecycle_fixture_bot",
    });
    await workspaceStore.saveChannelConnection(identity, {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      adapter: "telegram",
      credentialId,
      allowedUserIds: ["123456"],
      defaultAgentId: "codex-cli",
      allowAgentSwitch: false,
      telegramUpdateOffset: "0",
    });
    assert.ok(await workspaceStore.getOwnedChannelConnection(identity, "telegram", workspace.id));
    assert.ok((await workspaceStore.listActiveChannelConnections("telegram"))
      .some((connection) => connection.workspaceId === workspace.id));

    const raceQueued = await first.queueScheduleRun(identity, scheduleId, new Date(retryAt.getTime() + 4));
    assert.ok(raceQueued);
    const raceClaim = (await first.claimDueScheduleRuns(new Date(retryAt.getTime() + 5), 100, 120_000))
      .find((candidate) => candidate.run.id === raceQueued.id);
    assert.ok(raceClaim?.run.leaseToken);
    const operatorId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO platform_operators (
         id,workforce_issuer,workforce_subject,workforce_tenant_id,email,display_name
       ) VALUES ($1,'fixture',$2,'fixture',$3,'Fixture')`,
      [operatorId, `fixture-${operatorId}`, `fixture-${operatorId}@example.test`],
    );
    await pool.query(
      `INSERT INTO platform_tenant_lifecycle (
         tenant_id,lifecycle_state,reason,updated_by_operator_id,updated_at
       ) VALUES ($1,'suspended','Lifecycle execution gate test',$2,now())`,
      [identity.tenantId, operatorId],
    );

    assert.equal(await first.beginScheduleRun(
      raceClaim!.run.id,
      raceClaim!.run.leaseToken!,
      new Date(retryAt.getTime() + 6),
    ), null, "a suspension that wins after claim still blocks execution");
    const queuedWhileSuspended = await first.queueScheduleRun(identity, scheduleId, new Date(retryAt.getTime() + 7));
    assert.ok(queuedWhileSuspended);
    assert.equal(
      (await second.claimDueScheduleRuns(new Date(retryAt.getTime() + 8), 100, 120_000))
        .some((candidate) => candidate.run.id === queuedWhileSuspended.id),
      false,
      "suspended tenant runs are not claimed",
    );
    assert.equal(await workspaceStore.getOwnedChannelConnection(identity, "telegram", workspace.id), null);
    assert.equal(
      (await workspaceStore.listActiveChannelConnections("telegram"))
        .some((connection) => connection.workspaceId === workspace.id),
      false,
      "the channel broker cannot poll a suspended tenant",
    );

    assert.equal(await workspaceStore.remove(identity, workspace.id), true);
    assert.equal(await first.getSchedule(identity, scheduleId), null);
  } finally {
    await pool.end();
    await Promise.all([workspaceStore.close(), first.close(), second.close()]);
  }
});
