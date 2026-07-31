import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresTeamStore, PostgresUsageLedgerStore } from "@onecomputer/workspace-store";

const connectionString = process.env.USAGE_LEDGER_TEST_DATABASE_URL;
const hash = (character: string) => character.repeat(64);

test("PostgreSQL usage ledger preserves attribution, pricing, idempotency, and correction lineage", { skip:!connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const teams = PostgresTeamStore.fromConnectionString(connectionString!);
  const ledger = PostgresUsageLedgerStore.fromConnectionString(connectionString!);
  const suffix = crypto.randomUUID();
  const tenantId = `usage-tenant-${suffix}`;
  const outsiderTenantId = `usage-outsider-${suffix}`;
  const adminId = `usage-admin-${suffix}`;
  const userId = `usage-user-${suffix}`;
  const outsiderId = `usage-outsider-user-${suffix}`;
  const deployment = { provider:"openai", providerAccountId:"account-a", baseModel:"gpt-test", deploymentId:"deployment-a", region:"eastus", providerServiceTier:"standard" };
  const rate = (amountPerUnit: string) => [{ unit:"input_uncached_token" as const, amountPerUnit, unitScale:"1000000" },{ unit:"output_token" as const, amountPerUnit, unitScale:"1000000" }];
  try {
    await pool.query(`INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Usage tenant'),($3,$4,'Outsider')`, [tenantId,`external-${tenantId}`,outsiderTenantId,`external-${outsiderTenantId}`]);
    await pool.query(`INSERT INTO users (id,tenant_id,email,display_name) VALUES ($1,$3,$4,'Admin'),($2,$3,$5,'User'),($6,$7,$8,'Outsider')`, [adminId,userId,tenantId,`${adminId}@test.invalid`,`${userId}@test.invalid`,outsiderId,outsiderTenantId,`${outsiderId}@test.invalid`]);
    await pool.query(`INSERT INTO user_roles (user_id,role,assigned_by) VALUES ($1,'employee',$1),($1,'administrator',$1),($2,'employee',$1),($3,'employee',$3)`, [adminId,userId,outsiderId]);
    const finance = await teams.createTeam({ tenantId,createdBy:adminId,displayName:"Finance",description:"",ownerUserId:adminId,costCenterCode:"CC-100" });
    const engineering = await teams.createTeam({ tenantId,createdBy:adminId,displayName:"Engineering",description:"",ownerUserId:adminId,costCenterCode:"CC-200" });
    await teams.assignMembership({ tenantId,teamId:finance.id,userId,assignedBy:adminId,makeDefault:true });

    const january = new Date("2026-01-01T00:00:00.000Z");
    const february = new Date("2026-02-01T00:00:00.000Z");
    const pinnedId = await ledger.createRateCard({ tenantId,...deployment,currency:"USD",source:"pinned_catalogue",sourceVersion:"catalogue-v1",sourceHash:hash("a"),catalogueRelease:"onecomputer-test",effectiveFrom:january,effectiveTo:february,rates:rate("1") });
    await ledger.createRateCard({ tenantId,...deployment,currency:"USD",source:"conservative",sourceVersion:"conservative-v1",sourceHash:hash("b"),effectiveFrom:january,effectiveTo:february,rates:rate("9") });
    const overrideId = await ledger.createRateCard({ tenantId,...deployment,currency:"USD",source:"contract_override",sourceVersion:"contract-v1",sourceHash:hash("c"),effectiveFrom:new Date("2026-01-15T00:00:00.000Z"),effectiveTo:february,approvedBy:adminId,overrideReason:"Negotiated test contract",rates:rate("0.5") });
    assert.equal((await ledger.selectEffectiveRateCard({ tenantId,...deployment,at:new Date("2026-01-14T23:59:59.999Z") }))!.id,pinnedId);
    assert.equal((await ledger.selectEffectiveRateCard({ tenantId,...deployment,at:new Date("2026-01-15T00:00:00.000Z") }))!.id,overrideId);
    assert.equal(await ledger.selectEffectiveRateCard({ tenantId,...deployment,at:february }),null);
    assert.equal(await ledger.selectEffectiveRateCard({ tenantId,...deployment,region:undefined,providerServiceTier:undefined,at:new Date("2026-01-20T00:00:00.000Z") }),null);

    const teamSnapshot = (await teams.getCurrentDefaultSpendingTeam(tenantId,userId))!;
    const admittedAt = new Date("2026-01-20T10:00:00.000Z");
    const admissionInput = {
      tenantId,sourceSystem:"litellm",sourceAttemptId:`attempt-${suffix}`,subjectId:userId,team:teamSnapshot,
      workspaceId:`workspace-${suffix}`,agentId:"agent-a",sessionId:"session-a",taskId:"task-a",turnId:"turn-a",
      taskBindingProvenance:"explicit_signed" as const,policyVersionId:"policy-v1",policyHash:hash("d"),requestedAlias:"balanced",
      requestedServiceClass:"balanced" as const,selectedServiceClass:"balanced" as const,routeMappingVersion:"mapping-v1",
      attemptKind:"inference" as const,...deployment, resolvedProvider:deployment.provider,resolvedModel:deployment.baseModel,resolvedDeploymentId:deployment.deploymentId,admittedAt,
    };
    const admitted = await ledger.admitAttempt(admissionInput);
    assert.equal(admitted.status,"created");
    assert.equal((await ledger.admitAttempt(admissionInput)).status,"duplicate");
    assert.equal((await ledger.admitAttempt({ ...admissionInput,resolvedDeploymentId:"other" })).status,"conflict");
    assert.equal((await ledger.admitAttempt({ ...admissionInput,resolvedDeploymentId:"other" })).status,"conflict");
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_usage_ingestion_conflicts WHERE tenant_id=$1 AND source_event_id=$2`, [tenantId,admissionInput.sourceAttemptId])).rows[0].count,1);

    await teams.assignMembership({ tenantId,teamId:engineering.id,userId,assignedBy:adminId,makeDefault:true });
    const usageInput = {
      tenantId,admissionId:admitted.admissionId!,sourceSystem:"litellm",sourceEventId:`event-${suffix}`,eventType:"usage" as const,
      occurredAt:new Date("2026-01-20T10:00:01.000Z"),outcome:"success" as const,latencyMs:800,providerReportedTotalTokens:"1100",
      units:[{ unit:"input_uncached_token" as const,quantity:"1000" },{ unit:"output_token" as const,quantity:"100" }],
      costDrivers:{ conversationHistoryCount:8,attachmentCount:1,routingOverheadCount:1 },
    };
    const usage = await ledger.appendUsageEvent(usageInput);
    assert.equal(usage.status,"created");
    assert.equal(usage.providerCost,"0.000550000000");
    assert.equal(usage.currency,"USD");
    assert.equal((await ledger.appendUsageEvent(usageInput)).status,"duplicate");
    assert.equal((await ledger.appendUsageEvent({ ...usageInput,units:[{ unit:"output_token" as const,quantity:"999" }] })).status,"conflict");
    assert.equal((await ledger.appendUsageEvent({ ...usageInput,units:[{ unit:"output_token" as const,quantity:"999" }] })).status,"conflict");

    const snapshot = await pool.query(`SELECT admission.team_id,admission.team_display_name,admission.cost_center_code,event.provider_cost::text,event.rate_card_id,event.rate_card_source_version,event.conversation_history_count FROM ai_usage_events event JOIN ai_usage_attempt_admissions admission ON admission.tenant_id=event.tenant_id AND admission.id=event.admission_id WHERE event.tenant_id=$1 AND event.id=$2`, [tenantId,usage.eventId]);
    assert.equal(snapshot.rows[0].team_id,finance.id);
    assert.equal(snapshot.rows[0].team_display_name,"Finance");
    assert.equal(snapshot.rows[0].cost_center_code,"CC-100");
    assert.equal(snapshot.rows[0].rate_card_id,overrideId);
    assert.equal(snapshot.rows[0].rate_card_source_version,"contract-v1");
    assert.equal(snapshot.rows[0].conversation_history_count,8);

    await assert.rejects(ledger.appendUsageEvent({ ...usageInput,sourceEventId:`correction-before-${suffix}`,eventType:"correction",correctsEventId:crypto.randomUUID(),providerReportedTotalTokens:"-1",units:[{ unit:"output_token",quantity:"-1" }],costDrivers:{} }),/Correction target/);
    await assert.rejects(ledger.appendUsageEvent({ ...usageInput,sourceEventId:`correction-drivers-${suffix}`,eventType:"correction",correctsEventId:usage.eventId!,units:[{ unit:"output_token",quantity:"-1" }] }),/cannot repeat cost-driver/);
    await assert.rejects(ledger.appendUsageEvent({ ...usageInput,sourceEventId:`confirmed-pair-${suffix}`,providerConfirmedCost:"1.00" }),/cost and currency/);
    const correction = await ledger.appendUsageEvent({ ...usageInput,sourceEventId:`correction-${suffix}`,eventType:"correction",correctsEventId:usage.eventId!,occurredAt:new Date("2026-03-01T00:00:00.000Z"),providerReportedTotalTokens:"-10",units:[{ unit:"output_token",quantity:"-10" }],costDrivers:{} });
    assert.equal(correction.providerCost,"-0.000005000000");
    const total = await pool.query(`SELECT sum(provider_cost)::text AS total FROM ai_usage_events WHERE tenant_id=$1 AND admission_id=$2`, [tenantId,admitted.admissionId]);
    assert.equal(total.rows[0].total,"0.000545000000");

    const currentTeam = (await teams.getCurrentDefaultSpendingTeam(tenantId,userId))!;
    const retry = await ledger.admitAttempt({ ...admissionInput,sourceAttemptId:`retry-${suffix}`,team:currentTeam,taskId:"task-a",attemptKind:"retry",parentAttemptId:admitted.admissionId! });
    assert.equal(retry.status,"created");
    await assert.rejects(ledger.appendUsageEvent({ ...usageInput,admissionId:retry.admissionId!,sourceEventId:`bad-correction-${suffix}`,eventType:"correction",correctsEventId:usage.eventId!,units:[{ unit:"output_token",quantity:"-1" }],costDrivers:{} }),/same attempt/);

    const unknown = await ledger.admitAttempt({ ...admissionInput,sourceAttemptId:`unknown-${suffix}`,team:currentTeam,resolvedDeploymentId:"unpriced" });
    const unknownEvent = await ledger.appendUsageEvent({ ...usageInput,admissionId:unknown.admissionId!,sourceEventId:`unknown-event-${suffix}` });
    assert.equal(unknownEvent.priceStatus,"unknown");
    assert.equal(unknownEvent.providerCost,null);
    await assert.rejects(ledger.appendUsageEvent({ ...usageInput,tenantId:outsiderTenantId,admissionId:admitted.admissionId!,sourceEventId:`cross-${suffix}` }),/not found in tenant/);

    await assert.rejects(pool.query(`UPDATE ai_usage_events SET outcome='failure' WHERE tenant_id=$1 AND id=$2`, [tenantId,usage.eventId]),/immutable/);
    await assert.rejects(pool.query(`DELETE FROM ai_usage_events WHERE tenant_id=$1 AND id=$2`, [tenantId,usage.eventId]),/immutable/);
    await assert.rejects(pool.query(`UPDATE ai_deployment_rate_cards SET currency='EUR' WHERE tenant_id=$1 AND id=$2`, [tenantId,overrideId]),/immutable/);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_usage_events WHERE tenant_id=$1`, [outsiderTenantId])).rows[0].count,0);
  } finally {
    await Promise.all([pool.end(),teams.close(),ledger.close()]);
  }
});
