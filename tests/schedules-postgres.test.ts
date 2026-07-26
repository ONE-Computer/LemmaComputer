import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresScheduleStore,
  PostgresWorkspaceStore,
} from "@onecomputer/workspace-store";
import type { IdentityContext } from "@onecomputer/contracts";

const connectionString = process.env.SCHEDULE_TEST_DATABASE_URL;

test("PostgreSQL schedule claims are exclusive and workspace deletion cascades", {
  skip: !connectionString,
}, async () => {
  const workspaceStore = PostgresWorkspaceStore.fromConnectionString(connectionString!);
  const first = PostgresScheduleStore.fromConnectionString(connectionString!);
  const second = PostgresScheduleStore.fromConnectionString(connectionString!);
  const identity: IdentityContext = {
    tenantId: `schedule-test-${crypto.randomUUID()}`,
    subjectId: "owner",
    audience: "onecomputer-control",
  };
  try {
    await workspaceStore.migrate();
    const workspace = await workspaceStore.createOrGet(identity, "schedule-test", crypto.randomUUID());
    const scheduleId = crypto.randomUUID();
    const created = await first.createSchedule(identity, {
      id: scheduleId,
      workspaceId: workspace.id,
      agentCatalogId: "codex-cli",
      title: "PostgreSQL schedule",
      promptCiphertext: "encrypted-fixture",
      cronExpression: "0 9 * * *",
      timeZone: "UTC",
      state: "enabled",
      nextRunAt: new Date(Date.now() + 86_400_000),
    });
    assert.equal(created?.id, scheduleId);
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
    assert.equal((await first.finishScheduleRun(claim.run.id, {
      state: "succeeded",
      sessionId: "session-postgres-test",
      completedAt: new Date(),
    }))?.state, "succeeded");

    assert.equal(await workspaceStore.remove(identity, workspace.id), true);
    assert.equal(await first.getSchedule(identity, scheduleId), null);
  } finally {
    await Promise.all([workspaceStore.close(), first.close(), second.close()]);
  }
});
