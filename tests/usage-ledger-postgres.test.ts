import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresTeamStore, PostgresUsageLedgerStore, type UsageAttemptAdmissionHook } from "@onecomputer/workspace-store";
import { UsageLedgerService, UsageTaskBindingAuthority, internalUsageAdmissionSchema, type InternalUsageAdmission } from "../apps/control-api/src/usage-ledger.js";

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
    const outsiderTeam = await teams.createTeam({ tenantId:outsiderTenantId,createdBy:outsiderId,displayName:"Outside",description:"",ownerUserId:outsiderId,costCenterCode:"OUT-100" });
    await teams.assignMembership({ tenantId,teamId:finance.id,userId,assignedBy:adminId,makeDefault:true });
    await teams.assignMembership({ tenantId:outsiderTenantId,teamId:outsiderTeam.id,userId:outsiderId,assignedBy:outsiderId,makeDefault:true });

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
      taskBindingProvenance:"explicit_signed" as const,contextKind:"chat" as const,policyVersionId:"policy-v1",policyHash:hash("d"),requestedAlias:"balanced",
      requestedServiceClass:"balanced" as const,selectedServiceClass:"balanced" as const,routeMappingVersion:"mapping-v1",
      attemptKind:"inference" as const,...deployment, resolvedProvider:deployment.provider,resolvedModel:deployment.baseModel,resolvedDeploymentId:deployment.deploymentId,admittedAt,
    };
    const admitted = await ledger.admitAttempt(admissionInput);
    assert.equal(admitted.status,"created");
    assert.equal((await ledger.admitAttempt(admissionInput)).status,"duplicate");
    assert.equal((await ledger.admitAttempt({ ...admissionInput,resolvedDeploymentId:"other" })).status,"conflict");
    assert.equal((await ledger.admitAttempt({ ...admissionInput,resolvedDeploymentId:"other" })).status,"conflict");
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_usage_ingestion_conflicts WHERE tenant_id=$1 AND source_event_id=$2`, [tenantId,admissionInput.sourceAttemptId])).rows[0].count,1);
    const outsiderSnapshot = (await teams.getCurrentDefaultSpendingTeam(outsiderTenantId,outsiderId))!;
    const outsiderAdmission = await ledger.admitAttempt({
      ...admissionInput,tenantId:outsiderTenantId,sourceAttemptId:`outsider-attempt-${suffix}`,
      subjectId:outsiderId,team:outsiderSnapshot,workspaceId:`outsider-workspace-${suffix}`,
    });
    assert.equal(outsiderAdmission.status,"created");

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

    const missingTargetId = crypto.randomUUID();
    const pendingInput = { ...usageInput,sourceEventId:`correction-before-${suffix}`,eventType:"correction" as const,correctsEventId:missingTargetId,providerReportedTotalTokens:"-1",units:[{ unit:"output_token" as const,quantity:"-1" }],costDrivers:{} };
    assert.equal((await ledger.appendUsageEvent(pendingInput)).status,"pending");
    assert.equal((await ledger.appendUsageEvent(pendingInput)).status,"pending");
    assert.equal((await ledger.appendUsageEvent({ ...pendingInput,units:[{ unit:"output_token",quantity:"-2" }] })).status,"conflict");
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_usage_pending_corrections WHERE tenant_id=$1 AND source_event_id=$2`, [tenantId,pendingInput.sourceEventId])).rows[0].count,1);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_usage_pending_corrections WHERE tenant_id=$1`, [outsiderTenantId])).rows[0].count,0);
    await assert.rejects(ledger.appendUsageEvent({ ...usageInput,sourceEventId:`correction-drivers-${suffix}`,eventType:"correction",correctsEventId:usage.eventId!,units:[{ unit:"output_token",quantity:"-1" }] }),/cannot repeat cost-driver/);
    await assert.rejects(ledger.appendUsageEvent({ ...usageInput,sourceEventId:`confirmed-pair-${suffix}`,providerConfirmedCost:"1.00" }),/cost and currency/);
    await assert.rejects(ledger.appendUsageEvent({ ...usageInput,sourceEventId:`confirmed-currency-${suffix}`,providerConfirmedCost:"1.00",providerConfirmedCurrency:"EUR" }),/must match the selected rate-card currency/);
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
    await assert.rejects(ledger.appendUsageEvent({ ...pendingInput,tenantId:outsiderTenantId,sourceEventId:`cross-pending-${suffix}` }),/not found in tenant/);

    const reconciliation = await ledger.reconcile({
      tenantId,sourceSystem:"litellm",windowStart:january,windowEnd:february,startedBy:adminId,expected:[],
    });
    const missingSourceIds = reconciliation.findings.filter((finding) => finding.findingType === "missing").map((finding) => finding.sourceEventId);
    assert.ok(missingSourceIds.includes(`${retry.admissionId}:completion`));
    assert.ok(missingSourceIds.includes(pendingInput.sourceEventId));
    assert.equal(missingSourceIds.includes(`${outsiderAdmission.admissionId}:completion`),false);

    await assert.rejects(pool.query(`UPDATE ai_usage_events SET outcome='failure' WHERE tenant_id=$1 AND id=$2`, [tenantId,usage.eventId]),/immutable/);
    await assert.rejects(pool.query(`DELETE FROM ai_usage_events WHERE tenant_id=$1 AND id=$2`, [tenantId,usage.eventId]),/immutable/);
    await assert.rejects(pool.query(`UPDATE ai_deployment_rate_cards SET currency='EUR' WHERE tenant_id=$1 AND id=$2`, [tenantId,overrideId]),/immutable/);
    await assert.rejects(pool.query(`DELETE FROM ai_usage_pending_corrections WHERE tenant_id=$1 AND source_event_id=$2`, [tenantId,pendingInput.sourceEventId]),/immutable/);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_usage_events WHERE tenant_id=$1`, [outsiderTenantId])).rows[0].count,0);
  } finally {
    await Promise.all([pool.end(),teams.close(),ledger.close()]);
  }
});

test("PostgreSQL admission replay preserves the original Team and runs hard reservation once", { skip:!connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const teams = PostgresTeamStore.fromConnectionString(connectionString!);
  const secondTeams = PostgresTeamStore.fromConnectionString(connectionString!);
  const ledger = PostgresUsageLedgerStore.fromConnectionString(connectionString!);
  const secondLedger = PostgresUsageLedgerStore.fromConnectionString(connectionString!);
  const suffix = crypto.randomUUID();
  const tenantId = `replay-tenant-${suffix}`;
  const administratorId = `replay-admin-${suffix}`;
  const userId = `replay-user-${suffix}`;
  const reservationTable = `test_usage_replay_${suffix.replaceAll("-","")}`;
  let concurrentSource = "";
  let signalConcurrent = () => undefined;
  let releaseConcurrent = () => undefined;
  const concurrentEntered = new Promise<void>((resolve) => { signalConcurrent = resolve; });
  const concurrentRelease = new Promise<void>((resolve) => { releaseConcurrent = resolve; });
  const hook: UsageAttemptAdmissionHook = {
    admit: async (input,transaction) => {
      await transaction.query(`INSERT INTO ${reservationTable} (source_attempt_id,team_id,enforcement) VALUES ($1,$2,'hard')`, [input.sourceAttemptId,input.team.id]);
      if (input.sourceAttemptId === concurrentSource) {
        signalConcurrent();
        await concurrentRelease;
      }
      return { decision:"allow" };
    },
  };
  try {
    await pool.query(`CREATE TABLE ${reservationTable} (source_attempt_id text NOT NULL,team_id uuid NOT NULL,enforcement text NOT NULL)`);
    await pool.query(`INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Replay tenant')`, [tenantId,`external-${tenantId}`]);
    await pool.query(`INSERT INTO users (id,tenant_id,email,display_name) VALUES ($1,$2,$3,'Replay admin'),($4,$2,$5,'Replay user')`, [administratorId,tenantId,`${administratorId}@test.invalid`,userId,`${userId}@test.invalid`]);
    await pool.query(`INSERT INTO user_roles (user_id,role,assigned_by) VALUES ($1,'employee',$1),($1,'administrator',$1),($2,'employee',$1)`, [administratorId,userId]);
    const teamA = await teams.createTeam({ tenantId,createdBy:administratorId,displayName:"Team A",description:"",ownerUserId:administratorId,costCenterCode:"A-100" });
    const teamB = await teams.createTeam({ tenantId,createdBy:administratorId,displayName:"Team B",description:"",ownerUserId:administratorId,costCenterCode:"B-200" });
    const teamC = await teams.createTeam({ tenantId,createdBy:administratorId,displayName:"Team C",description:"",ownerUserId:administratorId,costCenterCode:"C-300" });
    await teams.assignMembership({ tenantId,teamId:teamA.id,userId,assignedBy:administratorId,makeDefault:true });
    await teams.assignMembership({ tenantId,teamId:teamB.id,userId,assignedBy:administratorId });
    await teams.assignMembership({ tenantId,teamId:teamC.id,userId,assignedBy:administratorId });
    const bindingSecret = `replay-binding-${suffix}-at-least-32-characters`;
    const service = new UsageLedgerService(ledger,teams,new UsageTaskBindingAuthority(bindingSecret),hook);
    const secondService = new UsageLedgerService(secondLedger,secondTeams,new UsageTaskBindingAuthority(bindingSecret),hook);
    const payload = (sourceAttemptId:string,overrides:Partial<InternalUsageAdmission>={}) => internalUsageAdmissionSchema.parse({
      schemaVersion:1,sourceSystem:"litellm",sourceAttemptId,tenantId,subjectId:userId,workspaceId:`workspace-${suffix}`,agentId:"agent-replay",
      policyVersionId:"policy-v1",policyHash:hash("a"),requestedAlias:"balanced",requestedServiceClass:"balanced",selectedServiceClass:"balanced",routeMappingVersion:"mapping-v1",
      attemptKind:"inference",resolvedProvider:"openai",providerAccountId:"account-a",resolvedModel:"gpt-test",resolvedDeploymentId:"deployment-a",region:"eastus",providerServiceTier:"standard",
      budgetBounds:{ inputTokens:"128",maximumOutputTokens:"256",maximumReasoningTokens:"64",cacheStatus:"unknown",maxRetries:1,maxFallbacks:1,maxAgentSteps:2,reservationTtlSeconds:300,providerDeadlineAt:"2026-07-31T10:05:00.000Z" },
      admittedAt:"2026-07-31T10:00:00.000Z",...overrides,
    });

    const sourceAttemptId = `sequential-${suffix}`;
    const first = await service.admit(payload(sourceAttemptId));
    await teams.setDefaultSpendingTeam({ tenantId,teamId:teamB.id,userId,assignedBy:administratorId });
    await teams.archiveTeam({ tenantId,teamId:teamA.id,archivedBy:administratorId });
    const replay = await secondService.admit(payload(sourceAttemptId,{
      admittedAt:"2026-07-31T10:02:00.000Z",
      budgetBounds:{ ...payload(sourceAttemptId).budgetBounds!,reservationTtlSeconds:900,providerDeadlineAt:"2026-07-31T10:17:00.000Z" },
    }));
    assert.equal(first.status,"created");
    assert.equal(replay.status,"duplicate");
    assert.deepEqual(first.team,replay.team);
    assert.equal(replay.team.id,teamA.id);
    await assert.rejects(() => secondService.admit(payload(sourceAttemptId,{ resolvedDeploymentId:"deployment-b" })),/reused with different facts/);
    await assert.rejects(() => secondService.admit(payload(sourceAttemptId,{ budgetBounds:{ ...payload(sourceAttemptId).budgetBounds!,maximumOutputTokens:"257" } })),/reused with different facts/);
    const sequentialReservations = await pool.query(`SELECT team_id,count(*)::integer count FROM ${reservationTable} WHERE source_attempt_id=$1 GROUP BY team_id`, [sourceAttemptId]);
    assert.deepEqual(sequentialReservations.rows,[{ team_id:teamA.id,count:1 }]);
    assert.equal((await pool.query(`SELECT count(*)::integer count FROM ai_usage_attempt_admissions WHERE tenant_id=$1 AND source_attempt_id=$2`, [tenantId,sourceAttemptId])).rows[0].count,1);

    concurrentSource = `concurrent-${suffix}`;
    const concurrentFirstPromise = service.admit(payload(concurrentSource));
    await concurrentEntered;
    await teams.setDefaultSpendingTeam({ tenantId,teamId:teamC.id,userId,assignedBy:administratorId });
    const concurrentReplayPromise = secondService.admit(payload(concurrentSource,{
      admittedAt:"2026-07-31T10:04:00.000Z",
      budgetBounds:{ ...payload(concurrentSource).budgetBounds!,reservationTtlSeconds:1200,providerDeadlineAt:"2026-07-31T10:24:00.000Z" },
    }));
    releaseConcurrent();
    const concurrentResults = await Promise.all([concurrentFirstPromise,concurrentReplayPromise]);
    assert.deepEqual(concurrentResults.map((result) => result.status).sort(),["created","duplicate"]);
    assert.ok(concurrentResults.every((result) => result.team.id === teamB.id));
    const concurrentReservations = await pool.query(`SELECT team_id,count(*)::integer count FROM ${reservationTable} WHERE source_attempt_id=$1 GROUP BY team_id`, [concurrentSource]);
    assert.deepEqual(concurrentReservations.rows,[{ team_id:teamB.id,count:1 }]);
    assert.equal((await pool.query(`SELECT count(*)::integer count FROM ${reservationTable} WHERE team_id=$1`, [teamC.id])).rows[0].count,0);
    assert.equal((await pool.query(`SELECT count(*)::integer count FROM ai_usage_attempt_admissions WHERE tenant_id=$1`, [tenantId])).rows[0].count,2);
  } finally {
    releaseConcurrent();
    await pool.query(`DROP TABLE IF EXISTS ${reservationTable}`).catch(() => undefined);
    await Promise.all([pool.end(),teams.close(),secondTeams.close(),ledger.close(),secondLedger.close()]);
  }
});

test("fresh PostgreSQL ledger materializes supported catalogue cards exactly once", { skip:!connectionString }, async () => {
  const pool = new pg.Pool({ connectionString });
  const teams = PostgresTeamStore.fromConnectionString(connectionString!);
  const firstLedger = PostgresUsageLedgerStore.fromConnectionString(connectionString!);
  const secondLedger = PostgresUsageLedgerStore.fromConnectionString(connectionString!);
  const suffix = crypto.randomUUID();
  const tenantId = `catalogue-tenant-${suffix}`;
  const userId = `catalogue-user-${suffix}`;
  const model = "bedrock/converse/global.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const deploymentId = "global.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const concurrentDeployment = {
    tenantId,
    provider:"bedrock",
    providerAccountId:`bedrock-concurrent-${suffix}`,
    baseModel:model,
    deploymentId,
    region:"ap-southeast-1",
    providerServiceTier:"standard",
  };
  try {
    await pool.query(`INSERT INTO tenants (id,external_tenant_id,display_name) VALUES ($1,$2,'Catalogue tenant')`, [tenantId,`external-${tenantId}`]);
    await pool.query(`INSERT INTO users (id,tenant_id,email,display_name) VALUES ($1,$2,$3,'Catalogue user')`, [userId,tenantId,`${userId}@test.invalid`]);
    await pool.query(`INSERT INTO user_roles (user_id,role,assigned_by) VALUES ($1,'employee',$1),($1,'administrator',$1)`, [userId]);
    const team = await teams.createTeam({ tenantId,createdBy:userId,displayName:"Catalogue",description:"",ownerUserId:userId,costCenterCode:"CAT-100" });
    await teams.assignMembership({ tenantId,teamId:team.id,userId,assignedBy:userId,makeDefault:true });

    assert.equal(await firstLedger.selectEffectiveRateCard({
      ...concurrentDeployment,
      at:new Date("2026-07-30T23:59:59.999Z"),
    }),null);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_deployment_rate_cards WHERE tenant_id=$1`, [tenantId])).rows[0].count,0);

    const unsupported = await firstLedger.selectEffectiveRateCard({
      tenantId,provider:"openai",providerAccountId:"future-openai",baseModel:"gpt-5.6-luna",
      deploymentId:"future-luna",region:"eastus",providerServiceTier:"standard",
      at:new Date("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(unsupported,null);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_deployment_rate_cards WHERE tenant_id=$1`, [tenantId])).rows[0].count,0);

    const conservativeDeployment = { ...concurrentDeployment,providerAccountId:`bedrock-conservative-${suffix}` };
    await firstLedger.createRateCard({
      ...conservativeDeployment,currency:"USD",source:"conservative",sourceVersion:"conservative-v1",
      sourceHash:hash("a"),effectiveFrom:new Date("2026-07-01T00:00:00.000Z"),
      rates:[{ unit:"input_uncached_token",amountPerUnit:"99.000000000000",unitScale:"1000000" }],
    });
    assert.equal((await firstLedger.selectEffectiveRateCard({
      ...conservativeDeployment,at:new Date("2026-08-01T00:00:00.000Z"),
    }))?.sourceVersion,"onecomputer-product-rates-2026-07-31.1");
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_deployment_rate_cards
      WHERE tenant_id=$1 AND provider_account_id=$2 AND source='pinned_catalogue'`, [tenantId,conservativeDeployment.providerAccountId])).rows[0].count,1);

    const olderPinnedDeployment = { ...concurrentDeployment,providerAccountId:`bedrock-older-${suffix}` };
    await firstLedger.createRateCard({
      ...olderPinnedDeployment,currency:"USD",source:"pinned_catalogue",sourceVersion:"catalogue-old",
      sourceHash:hash("b"),catalogueRelease:"catalogue-old",effectiveFrom:new Date("2026-07-01T00:00:00.000Z"),
      rates:[{ unit:"input_uncached_token",amountPerUnit:"98.000000000000",unitScale:"1000000" }],
    });
    assert.equal((await firstLedger.selectEffectiveRateCard({
      ...olderPinnedDeployment,at:new Date("2026-08-01T00:00:00.000Z"),
    }))?.sourceVersion,"onecomputer-product-rates-2026-07-31.1");
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_deployment_rate_cards
      WHERE tenant_id=$1 AND provider_account_id=$2 AND source_version='onecomputer-product-rates-2026-07-31.1'`, [tenantId,olderPinnedDeployment.providerAccountId])).rows[0].count,1);

    const overrideDeployment = { ...concurrentDeployment,providerAccountId:`bedrock-override-${suffix}` };
    const existingOverrideId = await firstLedger.createRateCard({
      ...overrideDeployment,currency:"USD",source:"contract_override",sourceVersion:"contract-existing-v1",
      sourceHash:hash("c"),effectiveFrom:new Date("2026-07-01T00:00:00.000Z"),approvedBy:userId,
      overrideReason:"Existing contract must remain authoritative",
      rates:[{ unit:"input_uncached_token",amountPerUnit:"1.000000000000",unitScale:"1000000" }],
    });
    assert.equal((await firstLedger.selectEffectiveRateCard({
      ...overrideDeployment,at:new Date("2026-08-01T00:00:00.000Z"),
    }))?.id,existingOverrideId);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_deployment_rate_cards
      WHERE tenant_id=$1 AND provider_account_id=$2 AND source='pinned_catalogue'`, [tenantId,overrideDeployment.providerAccountId])).rows[0].count,0);

    const selections = await Promise.all(Array.from({ length:8 }, (_,index) =>
      (index % 2 === 0 ? firstLedger : secondLedger).selectEffectiveRateCard({
        ...concurrentDeployment,
        at:new Date("2026-08-01T00:00:00.000Z"),
      }),
    ));
    assert.ok(selections.every((selection) => selection?.id === selections[0]?.id));
    assert.equal(selections[0]?.currency,"USD");
    assert.equal(selections[0]?.source,"pinned_catalogue");
    assert.equal(selections[0]?.sourceVersion,"onecomputer-product-rates-2026-07-31.1");
    assert.deepEqual(selections[0]?.rates, [
      { unit:"input_uncached_token",amountPerUnit:"3.000000000000",unitScale:"1000000.000000" },
      { unit:"output_token",amountPerUnit:"15.000000000000",unitScale:"1000000.000000" },
      { unit:"reasoning_token",amountPerUnit:"15.000000000000",unitScale:"1000000.000000" },
      { unit:"request",amountPerUnit:"0.000000000000",unitScale:"1.000000" },
    ]);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_deployment_rate_cards
      WHERE tenant_id=$1 AND provider_account_id=$2 AND source='pinned_catalogue'`, [tenantId,concurrentDeployment.providerAccountId])).rows[0].count,1);

    const teamSnapshot = (await teams.getCurrentDefaultSpendingTeam(tenantId,userId))!;
    const eventOnlyDeployment = { ...concurrentDeployment,providerAccountId:`bedrock-event-${suffix}` };
    const admission = await firstLedger.admitAttempt({
      tenantId,sourceSystem:"litellm",sourceAttemptId:`catalogue-attempt-${suffix}`,subjectId:userId,team:teamSnapshot,
      taskId:"catalogue-task",taskBindingProvenance:"unbound_generated",contextKind:"background",
      requestedAlias:"balanced",requestedServiceClass:"balanced",selectedServiceClass:"balanced",
      attemptKind:"inference",resolvedProvider:eventOnlyDeployment.provider,
      providerAccountId:eventOnlyDeployment.providerAccountId,resolvedModel:eventOnlyDeployment.baseModel,
      resolvedDeploymentId:eventOnlyDeployment.deploymentId,region:eventOnlyDeployment.region,
      providerServiceTier:eventOnlyDeployment.providerServiceTier,admittedAt:new Date("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(admission.status,"created");
    const usage = await firstLedger.appendUsageEvent({
      tenantId,admissionId:admission.admissionId!,sourceSystem:"litellm",sourceEventId:`catalogue-event-${suffix}`,
      eventType:"usage",occurredAt:new Date("2026-08-01T00:00:01.000Z"),outcome:"success",
      units:[
        { unit:"input_uncached_token",quantity:"1000" },
        { unit:"output_token",quantity:"100" },
        { unit:"request",quantity:"1" },
      ],
    });
    assert.equal(usage.priceStatus,"priced");
    assert.equal(usage.providerCost,"0.004500000000");
    assert.equal(usage.currency,"USD");
    const eventEvidence = await pool.query(`SELECT rate_card_source,rate_card_source_version FROM ai_usage_events WHERE tenant_id=$1 AND id=$2`, [tenantId,usage.eventId]);
    assert.equal(eventEvidence.rows[0].rate_card_source,"pinned_catalogue");
    assert.equal(eventEvidence.rows[0].rate_card_source_version,"onecomputer-product-rates-2026-07-31.1");
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_deployment_rate_cards
      WHERE tenant_id=$1 AND provider_account_id=$2 AND source='pinned_catalogue'`, [tenantId,eventOnlyDeployment.providerAccountId])).rows[0].count,1);

    const overrideId = await firstLedger.createRateCard({
      ...concurrentDeployment,currency:"USD",source:"contract_override",sourceVersion:"catalogue-contract-v1",
      sourceHash:hash("f"),effectiveFrom:new Date("2026-08-02T00:00:00.000Z"),approvedBy:userId,
      overrideReason:"Contract precedence qualification",
      rates:[{ unit:"input_uncached_token",amountPerUnit:"1.000000000000",unitScale:"1000000" }],
    });
    assert.equal((await firstLedger.selectEffectiveRateCard({
      ...concurrentDeployment,
      at:new Date("2026-08-03T00:00:00.000Z"),
    }))?.id,overrideId);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ai_deployment_rate_cards
      WHERE tenant_id=$1 AND provider_account_id=$2 AND source='pinned_catalogue'`, [tenantId,concurrentDeployment.providerAccountId])).rows[0].count,1);
  } finally {
    await Promise.all([pool.end(),teams.close(),firstLedger.close(),secondLedger.close()]);
  }
});
