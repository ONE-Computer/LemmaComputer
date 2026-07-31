import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { BudgetUsageAttemptAdmission, MemoryWorkspaceStore, PostgresTeamBudgetStore, PostgresTeamStore, PostgresUsageLedgerStore, usageFingerprint, type AttemptAdmissionInput } from "@onecomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const connectionString=process.env.BUDGET_TEST_DATABASE_URL;

test("PostgreSQL Team budgets reserve atomically, fail closed, and preserve immutable tenant-local history",{skip:!connectionString},async()=>{
  const pool=new pg.Pool({connectionString});
  const first=PostgresTeamBudgetStore.fromConnectionString(connectionString!);
  const second=PostgresTeamBudgetStore.fromConnectionString(connectionString!);
  const teams=PostgresTeamStore.fromConnectionString(connectionString!);
  const ledger=PostgresUsageLedgerStore.fromConnectionString(connectionString!);
  const suffix=crypto.randomUUID();
  const tenantId=`budget-tenant-${suffix}`;
  const outsiderTenantId=`budget-outsider-${suffix}`;
  const administratorId=`budget-admin-${suffix}`;
  const outsiderId=`budget-outsider-user-${suffix}`;
  const now=new Date("2026-03-10T12:00:00Z");
  try{
    await pool.query(`INSERT INTO tenants(id,external_tenant_id,display_name) VALUES($1,$2,'Budget tenant'),($3,$4,'Outsider tenant')`,[tenantId,`external-${tenantId}`,outsiderTenantId,`external-${outsiderTenantId}`]);
    await pool.query(`INSERT INTO users(id,tenant_id,email,display_name) VALUES($1,$2,$3,'Budget admin'),($4,$5,$6,'Outsider')`,[administratorId,tenantId,`${administratorId}@example.test`,outsiderId,outsiderTenantId,`${outsiderId}@example.test`]);
    const team=await teams.createTeam({tenantId,createdBy:administratorId,displayName:"Engineering",description:"",ownerUserId:administratorId,costCenterCode:"ENG"});
    await teams.assignMembership({tenantId,teamId:team.id,userId:administratorId,assignedBy:administratorId,effectiveFrom:now,makeDefault:true});
    const otherTeam=await teams.createTeam({tenantId,createdBy:administratorId,displayName:"Finance",description:"",ownerUserId:administratorId,costCenterCode:"FIN"});
    const softTeam=await teams.createTeam({tenantId,createdBy:administratorId,displayName:"Research",description:"",ownerUserId:administratorId,costCenterCode:null});
    const pinnedCard=await ledger.createRateCard({tenantId,provider:"openai",providerAccountId:"primary",baseModel:"gpt-concrete",deploymentId:"deployment-a",currency:"USD",source:"pinned_catalogue",sourceVersion:"2026-03",sourceHash:"1".repeat(64),effectiveFrom:new Date("2026-01-01T00:00:00Z"),rates:[{unit:"input_uncached_token",amountPerUnit:"1",unitScale:"1"},{unit:"output_token",amountPerUnit:"1",unitScale:"1"}]});
    await ledger.createRateCard({tenantId,provider:"openai",providerAccountId:"primary",baseModel:"gpt-concrete",deploymentId:"deployment-a",currency:"USD",source:"conservative",sourceVersion:"fallback",sourceHash:"2".repeat(64),effectiveFrom:new Date("2026-02-01T00:00:00Z"),rates:[{unit:"input_uncached_token",amountPerUnit:"100",unitScale:"1"},{unit:"output_token",amountPerUnit:"100",unitScale:"1"}]});
    const budget=await first.createBudgetVersion({tenantId,teamId:team.id,limitAmount:"2.5",currency:"USD",periodType:"calendar_month",timezone:"America/New_York",mode:"hard",thresholds:["50","80","100"],effectiveFrom:new Date("2026-03-01T05:00:00Z"),createdBy:administratorId});
    await first.createBudgetVersion({tenantId,teamId:softTeam.id,limitAmount:"1",currency:"USD",periodType:"calendar_month",timezone:"UTC",mode:"soft",thresholds:["50"],effectiveFrom:new Date("2026-01-01T00:00:00Z"),createdBy:administratorId});

    const attempt=(id:string,requestedAlias="Auto",targetTeam=team):AttemptAdmissionInput=>({tenantId,sourceSystem:"litellm",sourceAttemptId:id,subjectId:administratorId,team:{id:targetTeam.id,displayName:targetTeam.displayName,costCenterCode:targetTeam.costCenterCode},taskId:`task-${id}`,taskBindingProvenance:"explicit_signed",contextKind:"chat",requestedAlias,requestedServiceClass:"auto",selectedServiceClass:"lite",routeMappingVersion:"mapping-1",attemptKind:"inference",resolvedProvider:"openai",providerAccountId:"primary",resolvedModel:"gpt-concrete",resolvedDeploymentId:"deployment-a",admittedAt:now,budgetBounds:{inputTokens:"1",maximumOutputTokens:"1",cacheStatus:"unknown",maxRetries:0,maxFallbacks:0,maxAgentSteps:1,reservationTtlSeconds:30,providerDeadlineAt:new Date(now.getTime()+120_000)}});

    const internalToken="budget-test-internal-token-with-at-least-32-characters";
    const app=createControlServer(new MemoryWorkspaceStore(),{} as ControllerClient,"proxy-token-with-at-least-24-characters",undefined,undefined,{},
      {testIdentityMode:true,teamStore:teams,usageLedgerStore:ledger,usageInternalToken:internalToken,usageTaskBindingSecret:"budget-test-task-binding-secret-with-at-least-32-characters",budgetStore:first,usageAdmissionHook:new BudgetUsageAttemptAdmission(first)});
    const apiAttempt=(sourceAttemptId:string)=>({schemaVersion:1,sourceSystem:"litellm",sourceAttemptId,tenantId,subjectId:administratorId,
      requestedAlias:"balanced",requestedServiceClass:"balanced",selectedServiceClass:"lite",routeMappingVersion:"mapping-1",attemptKind:"inference",
      resolvedProvider:"openai",providerAccountId:"primary",resolvedModel:"gpt-concrete",resolvedDeploymentId:"deployment-a",admittedAt:now.toISOString(),
      budgetBounds:{inputTokens:"1",maximumOutputTokens:"1",cacheStatus:"unknown",maxRetries:0,maxFallbacks:0,maxAgentSteps:1,reservationTtlSeconds:30,providerDeadlineAt:new Date(now.getTime()+120_000).toISOString()}});
    const simultaneous=await Promise.all(["parallel-a","parallel-b"].map((sourceAttemptId)=>app.inject({method:"POST",url:"/internal/v1/ai-usage/attempts/admit",headers:{"x-onecomputer-ai-usage-token":internalToken},payload:apiAttempt(sourceAttemptId)})));
    assert.deepEqual(simultaneous.map((response)=>response.statusCode).sort(),[201,429]);
    const acceptedIndex=simultaneous.findIndex((response)=>response.statusCode===201);
    const acceptedAttempt=acceptedIndex===0?"parallel-a":"parallel-b";
    const accepted=simultaneous[acceptedIndex]!.json<{admissionId:string}>();
    assert.match(simultaneous.find((response)=>response.statusCode===429)!.body,/TEAM_BUDGET_EXHAUSTED/);
    assert.equal((await first.getBudgetStatus(tenantId,team.id,now)).outstandingReservations,"2.000000000000");
    const completion={schemaVersion:1,tenantId,admissionId:accepted.admissionId,sourceSystem:"litellm",sourceEventId:`event-${acceptedAttempt}`,eventType:"usage",occurredAt:new Date(now.getTime()+1_000).toISOString(),outcome:"success",units:[{unit:"input_uncached_token",quantity:"0.1"},{unit:"output_token",quantity:"0.1"}]};
    assert.equal((await app.inject({method:"POST",url:"/internal/v1/ai-usage/events",headers:{"x-onecomputer-ai-usage-token":internalToken},payload:completion})).statusCode,201);
    assert.equal((await app.inject({method:"POST",url:"/internal/v1/ai-usage/events",headers:{"x-onecomputer-ai-usage-token":internalToken},payload:completion})).statusCode,200);
    const completedStatus=await first.getBudgetStatus(tenantId,team.id,new Date(now.getTime()+1_000));
    assert.equal(completedStatus.settledProviderCost,"0.200000000000");
    assert.equal(completedStatus.outstandingReservations,"0.000000000000");
    assert.equal(Number((await pool.query("SELECT count(*) count FROM team_budget_reservation_settlements WHERE tenant_id=$1",[tenantId])).rows[0].count),1);
    await app.close();

    // The operational deadline does not silently refund an in-flight request.
    assert.equal((await first.reserveAttempt(attempt("expiry-reservation"))).decision,"allow");
    const afterExpiry=await first.getBudgetStatus(tenantId,team.id,new Date(now.getTime()+3_600_000));
    assert.equal(afterExpiry.outstandingReservations,"2.000000000000");
    assert.equal(await first.releaseReservation({tenantId,sourceSystem:"litellm",sourceAttemptId:"expiry-reservation",reason:"provider_not_dispatched",evidence:"gateway rejected before dispatch",releasedAt:new Date(now.getTime()+3_600_000)}),"released");
    assert.equal((await first.getBudgetStatus(tenantId,team.id,new Date(now.getTime()+3_600_000))).outstandingReservations,"0.000000000000");

    // Pinned catalogue beats a later conservative fallback; alias remapping is irrelevant.
    const settledAttempt=attempt("settled","Lite");
    assert.equal((await first.reserveAttempt(settledAttempt)).quotedAmount,"2.000000000000");
    const admission=await ledger.admitAttempt(settledAttempt);
    assert.equal(admission.status,"created");
    const eventId=crypto.randomUUID();
    await pool.query(`INSERT INTO ai_usage_events(id,tenant_id,admission_id,source_system,source_event_id,source_fingerprint,event_type,occurred_at,outcome,price_status,cost_status,currency,provider_cost,rate_card_id,rate_card_source,rate_card_source_version,rate_card_source_hash,rate_card_effective_from) VALUES($1,$2,$3,'litellm',$4,$5,'usage',$6,'success','priced','estimated','USD','1.5',$7,'pinned_catalogue','2026-03',$8,$9)`,[eventId,tenantId,admission.admissionId,"event-original",usageFingerprint({event:"original"}),now,pinnedCard,"1".repeat(64),new Date("2026-01-01T00:00:00Z")]);
    const failureFunction=`budget_alert_failure_${suffix.replaceAll("-","")}`;
    await pool.query(`CREATE FUNCTION ${failureFunction}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${tenantId}' THEN RAISE EXCEPTION 'forced alert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${failureFunction} BEFORE INSERT ON team_budget_alerts FOR EACH ROW EXECUTE FUNCTION ${failureFunction}()`);
    await assert.rejects(first.settleReservation({tenantId,sourceSystem:"litellm",sourceAttemptId:"settled",usageEventId:eventId,settledAt:now}),/forced alert failure/);
    assert.equal(Number((await pool.query("SELECT count(*) count FROM team_budget_reservation_settlements WHERE tenant_id=$1",[tenantId])).rows[0].count),1);
    await pool.query(`DROP TRIGGER ${failureFunction} ON team_budget_alerts; DROP FUNCTION ${failureFunction}()`);
    assert.equal((await first.settleReservation({tenantId,sourceSystem:"litellm",sourceAttemptId:"settled",usageEventId:eventId,settledAt:now})).status,"settled");
    assert.equal((await first.settleReservation({tenantId,sourceSystem:"litellm",sourceAttemptId:"settled",usageEventId:eventId,settledAt:now})).status,"duplicate");
    assert.equal(Number((await pool.query("SELECT count(*) count FROM team_budget_alerts WHERE tenant_id=$1",[tenantId])).rows[0].count),1);
    const correctionId=crypto.randomUUID();
    await pool.query(`INSERT INTO ai_usage_events(id,tenant_id,admission_id,source_system,source_event_id,source_fingerprint,event_type,corrects_event_id,correction_semantics,occurred_at,outcome,price_status,cost_status,currency,provider_cost,rate_card_id,rate_card_source,rate_card_source_version,rate_card_source_hash,rate_card_effective_from) VALUES($1,$2,$3,'litellm',$4,$5,'correction',$6,'delta',$7,'success','priced','estimated','USD','0.5',$8,'pinned_catalogue','2026-03',$9,$10)`,[correctionId,tenantId,admission.admissionId,"event-correction",usageFingerprint({event:"correction"}),eventId,now,pinnedCard,"1".repeat(64),new Date("2026-01-01T00:00:00Z")]);
    const corrected=await first.getBudgetStatus(tenantId,team.id,now);
    assert.equal(corrected.settledProviderCost,"2.200000000000");
    assert.equal(corrected.outstandingReservations,"0.000000000000");
    assert.deepEqual(corrected.alerts.map((alert)=>alert.thresholdPercent),["50.000"]);
    const beforeReadAlerts=Number((await pool.query("SELECT count(*) count FROM team_budget_alerts WHERE tenant_id=$1",[tenantId])).rows[0].count);
    await first.getBudgetStatus(tenantId,team.id,now);
    assert.equal(Number((await pool.query("SELECT count(*) count FROM team_budget_alerts WHERE tenant_id=$1",[tenantId])).rows[0].count),beforeReadAlerts);
    await first.recordGatewayReconciliation({tenantId,teamId:team.id,budgetVersionId:budget.id,projectionKey:"test",limitAmount:"2.5",mode:"hard",expectedFingerprint:"a".repeat(64),observedFingerprint:"a".repeat(64),status:"matched",detail:null,startedBy:administratorId,checkedAt:now});
    assert.deepEqual((await first.getBudgetStatus(tenantId,team.id,now)).alerts.map((alert)=>alert.thresholdPercent),["50.000","80.000"]);

    // A correction cannot be used as the original terminal settlement.
    const correctionAttempt=attempt("correction-settlement");
    await first.createOverride({tenantId,teamId:team.id,overrideType:"limit_increase",newLimitAmount:"5",actorUserId:administratorId,reason:"Approved incident capacity",expiresAt:new Date(now.getTime()+3_600_000),now});
    await first.reserveAttempt(correctionAttempt);
    await ledger.admitAttempt(correctionAttempt);
    await assert.rejects(first.settleReservation({tenantId,sourceSystem:"litellm",sourceAttemptId:"correction-settlement",usageEventId:correctionId,settledAt:now}),/original attempt/);

    // Unknown ledger cost is visible and hard admission fails closed.
    const unknownEvent=crypto.randomUUID();
    await pool.query(`INSERT INTO ai_usage_events(id,tenant_id,admission_id,source_system,source_event_id,source_fingerprint,event_type,occurred_at,outcome,price_status,cost_status) VALUES($1,$2,$3,'litellm',$4,$5,'usage',$6,'success','unknown','unpriced')`,[unknownEvent,tenantId,admission.admissionId,"event-unknown",usageFingerprint({event:"unknown"}),now]);
    assert.equal((await first.reserveAttempt(attempt("stale-ledger"))).code,"BUDGET_LEDGER_STALE");

    // Soft mode visibly warns but does not block an unmatched deployment.
    const softAttempt={...attempt("soft-unpriced","Auto",softTeam),resolvedDeploymentId:"missing-deployment"};
    const noBudgetAttempt=attempt("no-budget","Auto",otherTeam);const noBudgetAdmission=await ledger.admitAttempt(noBudgetAttempt);
    const noBudgetEvent=await ledger.appendUsageEvent({tenantId,admissionId:noBudgetAdmission.admissionId!,sourceSystem:"litellm",sourceEventId:"no-budget-event",eventType:"usage",occurredAt:now,outcome:"success",units:[{unit:"input_uncached_token",quantity:"0.1"}]});
    assert.equal((await first.settleUsageEvent({tenantId,usageEventId:noBudgetEvent.eventId!,settledAt:now})).status,"not_reserved");
    const softAdmission=await ledger.admitAttempt(softAttempt);
    const softEvent=await ledger.appendUsageEvent({tenantId,admissionId:softAdmission.admissionId!,sourceSystem:"litellm",sourceEventId:"soft-unpriced-event",eventType:"usage",occurredAt:now,outcome:"success",units:[{unit:"input_uncached_token",quantity:"0.1"}]});
    assert.equal(softEvent.priceStatus,"unknown");
    assert.equal((await first.settleUsageEvent({tenantId,usageEventId:softEvent.eventId!,settledAt:now})).status,"not_reserved");

    assert.deepEqual(await first.reserveAttempt(softAttempt),{decision:"allow",warning:"unpriced"});

    const secondOverrideAt=new Date(now.getTime()+1_000);
    await first.createOverride({tenantId,teamId:team.id,overrideType:"limit_increase",newLimitAmount:"7",actorUserId:administratorId,reason:"Second approved increase",expiresAt:new Date(now.getTime()+3_600_000),now:secondOverrideAt});
    const overrideHistory=await pool.query("SELECT old_limit_amount::text,new_limit_amount::text FROM team_budget_overrides WHERE tenant_id=$1 AND team_id=$2 ORDER BY effective_from",[tenantId,team.id]);
    assert.deepEqual(overrideHistory.rows,[{old_limit_amount:"2.500000000000",new_limit_amount:"5.000000000000"},{old_limit_amount:"5.000000000000",new_limit_amount:"7.000000000000"}]);
    assert.equal((await first.getBudgetStatus(tenantId,team.id,new Date(now.getTime()+3_600_001))).effectiveLimitAmount,"2.500000000000");

    // Delayed settlement stays attached to the reservation's snapped period/version.
    const crossTeam=await teams.createTeam({tenantId,createdBy:administratorId,displayName:"Cross-period",description:"",ownerUserId:administratorId,costCenterCode:"CROSS"});
    const oldCrossBudget=await first.createBudgetVersion({tenantId,teamId:crossTeam.id,limitAmount:"3",currency:"USD",periodType:"calendar_month",timezone:"UTC",mode:"hard",thresholds:["20"],effectiveFrom:new Date("2026-03-01T00:00:00Z"),effectiveTo:new Date("2026-04-01T00:00:00Z"),createdBy:administratorId});
    await first.createBudgetVersion({tenantId,teamId:crossTeam.id,limitAmount:"100",currency:"USD",periodType:"calendar_month",timezone:"UTC",mode:"hard",thresholds:["90"],effectiveFrom:new Date("2026-04-01T00:00:00Z"),createdBy:administratorId});
    const crossAttempt=attempt("cross-period","Auto",crossTeam);
    await first.reserveAttempt(crossAttempt);const crossAdmission=await ledger.admitAttempt(crossAttempt);const crossEvent=crypto.randomUUID();
    await pool.query(`INSERT INTO ai_usage_events(id,tenant_id,admission_id,source_system,source_event_id,source_fingerprint,event_type,occurred_at,outcome,price_status,cost_status,currency,provider_cost,rate_card_id,rate_card_source,rate_card_source_version,rate_card_source_hash,rate_card_effective_from) VALUES($1,$2,$3,'litellm',$4,$5,'usage',$6,'success','priced','estimated','USD','0.75',$7,'pinned_catalogue','2026-03',$8,$9)`,[crossEvent,tenantId,crossAdmission.admissionId,"cross-period-event",usageFingerprint({event:"cross-period"}),new Date("2026-03-31T23:59:00Z"),pinnedCard,"1".repeat(64),new Date("2026-01-01T00:00:00Z")]);
    await first.settleUsageEvent({tenantId,usageEventId:crossEvent,settledAt:new Date("2026-04-05T00:00:00Z")});
    const crossAlerts=await pool.query(`SELECT budget_version_id,period_start FROM team_budget_alerts WHERE tenant_id=$1 AND team_id=$2`,[tenantId,crossTeam.id]);
    assert.equal(crossAlerts.rows[0].budget_version_id,oldCrossBudget.id);assert.equal(new Date(crossAlerts.rows[0].period_start).toISOString(),"2026-03-01T00:00:00.000Z");
    const negativeAttempt=attempt("negative-original","Auto",crossTeam);await first.reserveAttempt(negativeAttempt);const negativeAdmission=await ledger.admitAttempt(negativeAttempt);const negativeEvent=crypto.randomUUID();
    await pool.query(`INSERT INTO ai_usage_events(id,tenant_id,admission_id,source_system,source_event_id,source_fingerprint,event_type,occurred_at,outcome,price_status,cost_status,currency,provider_cost,rate_card_id,rate_card_source,rate_card_source_version,rate_card_source_hash,rate_card_effective_from) VALUES($1,$2,$3,'litellm',$4,$5,'usage',$6,'success','priced','estimated','USD','-0.1',$7,'pinned_catalogue','2026-03',$8,$9)`,[negativeEvent,tenantId,negativeAdmission.admissionId,"negative-original-event",usageFingerprint({event:"negative"}),now,pinnedCard,"1".repeat(64),new Date("2026-01-01T00:00:00Z")]);
    await assert.rejects(first.settleUsageEvent({tenantId,usageEventId:negativeEvent,settledAt:now}),/cannot be negative/);

    // Foreign-currency facts never enter configured-budget arithmetic and force hard admission stale.
    const mixedTeam=await teams.createTeam({tenantId,createdBy:administratorId,displayName:"Mixed currency",description:"",ownerUserId:administratorId,costCenterCode:"MIX"});
    await first.createBudgetVersion({tenantId,teamId:mixedTeam.id,limitAmount:"10",currency:"USD",periodType:"calendar_month",timezone:"UTC",mode:"hard",thresholds:["50"],effectiveFrom:new Date("2026-03-01T00:00:00Z"),createdBy:administratorId});
    await ledger.createRateCard({tenantId,provider:"openai",providerAccountId:"euro",baseModel:"gpt-euro",deploymentId:"deployment-euro",currency:"EUR",source:"contract_override",sourceVersion:"eur-v1",sourceHash:"e".repeat(64),effectiveFrom:new Date("2026-01-01T00:00:00Z"),approvedBy:administratorId,overrideReason:"Test EUR contract",rates:[{unit:"input_uncached_token",amountPerUnit:"1",unitScale:"1"},{unit:"output_token",amountPerUnit:"1",unitScale:"1"}]});
    const euroAttempt={...attempt("mixed-eur","Auto",mixedTeam),providerAccountId:"euro",resolvedModel:"gpt-euro",resolvedDeploymentId:"deployment-euro"};
    const euroAdmission=await ledger.admitAttempt(euroAttempt);
    const euroEvent=await ledger.appendUsageEvent({tenantId,admissionId:euroAdmission.admissionId!,sourceSystem:"litellm",sourceEventId:"mixed-eur-event",eventType:"usage",occurredAt:now,outcome:"success",units:[{unit:"input_uncached_token",quantity:"1"}]});
    assert.equal(euroEvent.currency,"EUR");
    const mixedStatus=await first.getBudgetStatus(tenantId,mixedTeam.id,now);
    assert.equal(mixedStatus.settledProviderCost,"0.000000000000");
    assert.equal(mixedStatus.priceStatus,"unknown");
    assert.equal((await first.reserveAttempt(attempt("mixed-usd","Auto",mixedTeam))).code,"BUDGET_LEDGER_STALE");

    // A hard budget can materialize a supported pinned Bedrock card on its first request.
    const catalogueNow=new Date("2026-07-31T12:00:00Z");
    const bedrockTeam=await teams.createTeam({tenantId,createdBy:administratorId,displayName:"Bedrock first use",description:"",ownerUserId:administratorId,costCenterCode:"BRK"});
    await first.createBudgetVersion({tenantId,teamId:bedrockTeam.id,limitAmount:"1",currency:"USD",periodType:"calendar_month",timezone:"UTC",mode:"hard",thresholds:["50"],effectiveFrom:new Date("2026-07-31T00:00:00Z"),createdBy:administratorId});
    const bedrockModel="bedrock/converse/global.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const bedrockDeployment="global.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const bedrockAttempt:AttemptAdmissionInput={
      ...attempt("bedrock-first","Auto",bedrockTeam),admittedAt:catalogueNow,resolvedProvider:"bedrock",providerAccountId:"bedrock-first-account",
      resolvedModel:bedrockModel,resolvedDeploymentId:bedrockDeployment,region:"ap-southeast-1",providerServiceTier:"standard",
      budgetBounds:{inputTokens:"1",maximumOutputTokens:"1",cacheStatus:"unknown",maxRetries:0,maxFallbacks:0,maxAgentSteps:1,reservationTtlSeconds:30,providerDeadlineAt:new Date(catalogueNow.getTime()+120_000)},
    };
    assert.equal(Number((await pool.query("SELECT count(*) count FROM ai_deployment_rate_cards WHERE tenant_id=$1 AND provider_account_id=$2",[tenantId,bedrockAttempt.providerAccountId])).rows[0].count),0);
    const firstBedrockReservation=await first.reserveAttempt(bedrockAttempt,catalogueNow);
    assert.equal(firstBedrockReservation.decision,"allow");
    assert.equal(firstBedrockReservation.quotedAmount,"0.000018000000");
    assert.equal(Number((await pool.query("SELECT count(*) count FROM ai_deployment_rate_cards WHERE tenant_id=$1 AND provider_account_id=$2 AND source='pinned_catalogue'",[tenantId,bedrockAttempt.providerAccountId])).rows[0].count),1);
    const unsupportedBedrock={...bedrockAttempt,sourceAttemptId:"bedrock-unsupported",taskId:"task-bedrock-unsupported",resolvedModel:"bedrock/converse/future-model",resolvedDeploymentId:"future-model"};
    assert.equal((await first.reserveAttempt(unsupportedBedrock,catalogueNow)).code,"BUDGET_PRICE_UNAVAILABLE");

    // Composite keys reject same-tenant Team/version mismatches; tenant queries do not leak.
    await assert.rejects(pool.query(`INSERT INTO team_budget_reservations(id,tenant_id,budget_version_id,team_id,source_system,source_attempt_id,source_fingerprint,period_start,period_end,quoted_amount,currency,rate_card_id,rate_card_source_hash,cache_assumption,max_attempts,max_agent_steps,expires_at) VALUES($1,$2,$3,$4,'test','mismatch',$5,$6,$7,'1','USD',$8,$9,'known_miss',1,1,$10)`,[crypto.randomUUID(),tenantId,budget.id,otherTeam.id,"a".repeat(64),new Date("2026-03-01T05:00:00Z"),new Date("2026-04-01T04:00:00Z"),pinnedCard,"1".repeat(64),new Date(Date.now()+60_000)]),(error)=>error instanceof Error&&"code" in error&&error.code==="23503");
    assert.equal((await first.getBudgetStatus(outsiderTenantId,team.id,now)).budget,null);
    await assert.rejects(pool.query("UPDATE team_budget_versions SET limit_amount=999 WHERE tenant_id=$1 AND id=$2",[tenantId,budget.id]),/immutable/);
  }finally{await Promise.all([first.close(),second.close(),teams.close(),ledger.close(),pool.end()]);}
});
