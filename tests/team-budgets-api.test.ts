import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorkspaceStore, type BudgetStatus, type CreateBudgetOverrideInput, type CreateBudgetVersionInput, type IdentityPolicyStore, type RecordBudgetReconciliationInput, type SessionPrincipal, type TeamBudgetStore } from "@lemmacomputer/workspace-store";
import { createControlServer } from "../apps/control-api/src/server.js";
import type { ControllerClient } from "../apps/control-api/src/service.js";

const proxyToken="budget-api-proxy-token-at-least-24-characters";
const teamId="1b5f0aa2-e2e2-4ca4-86ca-8f1ea74a5b61";
const administrator:SessionPrincipal={userId:"budget-admin",tenantId:"acme",email:"admin@example.test",displayName:"Budget Administrator",tenantDisplayName:"Acme",roles:["employee","administrator"],identity:{tenantId:"acme",subjectId:"budget-admin",audience:"lemmacomputer-control"}};
const employee:SessionPrincipal={...administrator,userId:"budget-user",roles:["employee"],identity:{tenantId:"acme",subjectId:"budget-user",audience:"lemmacomputer-control"}};
const period={start:new Date("2026-07-01T00:00:00Z"),end:new Date("2026-08-01T00:00:00Z")};

class FakeBudgetStore implements TeamBudgetStore{
  calls:Array<{method:string;tenantId:string;[key:string]:unknown}>=[];
  status:BudgetStatus={budget:null,period:null,effectiveLimitAmount:null,settledProviderCost:null,outstandingReservations:null,remainingAmount:null,percentConsumed:null,priceStatus:"unknown",enforcement:"none",alerts:[],lastReconciliation:null};
  async createBudgetVersion(input:CreateBudgetVersionInput){
    this.calls.push({method:"create",...input});
    const budget={id:"3c46ce1d-f2a9-42d6-a0d9-bd2bb7a0dc90",tenantId:input.tenantId,teamId:input.teamId,limitAmount:input.limitAmount,currency:input.currency,periodType:input.periodType,timezone:input.timezone,mode:input.mode,thresholds:input.thresholds,effectiveFrom:input.effectiveFrom,effectiveTo:input.effectiveTo??null,createdBy:input.createdBy,createdAt:new Date("2026-07-01T00:00:00Z")};
    this.status={budget,period,effectiveLimitAmount:input.limitAmount,settledProviderCost:"25.000000000000",outstandingReservations:"5.000000000000",remainingAmount:"70.000000000000",percentConsumed:"25.000000000000",priceStatus:"priced",enforcement:input.mode,alerts:[],lastReconciliation:null};
    return budget;
  }
  async getBudgetStatus(tenantId:string,requestedTeamId:string){this.calls.push({method:"get",tenantId,teamId:requestedTeamId});return this.status;}
  async reserveAttempt(){return{decision:"allow" as const};}
  async settleReservation(){return{status:"settled" as const,actualProviderCost:"0.000000000000"};}
  async releaseReservation(){return"released" as const;}
  async createOverride(input:CreateBudgetOverrideInput){this.calls.push({method:"override",...input});if(this.status.budget&&input.newLimitAmount)this.status={...this.status,effectiveLimitAmount:input.newLimitAmount,remainingAmount:input.newLimitAmount,enforcement:"override"};return"override-id";}
  async recordGatewayReconciliation(input:RecordBudgetReconciliationInput){this.calls.push({method:"reconcile",...input});this.status={...this.status,lastReconciliation:{status:input.status==="matched"?"current":input.status,checkedAt:input.checkedAt,detail:input.detail}};}
  async reserveAttemptInTransaction(){return{decision:"allow" as const};}
}

const authentication=(actor:SessionPrincipal)=>({begin:async()=>({location:"https://login.example.test",cookie:"state=opaque"}),complete:async()=>{throw new Error("unused");},authenticate:async()=>actor,logout:async()=>""});
const identityPolicies={getEffectivePolicy:async()=>null,listUsers:async()=>[]} as unknown as IdentityPolicyStore;
const appFor=(actor:SessionPrincipal,budgetStore:TeamBudgetStore)=>createControlServer(new MemoryWorkspaceStore(),{} as ControllerClient,proxyToken,undefined,undefined,{}, {authentication:authentication(actor),identityPolicyStore:identityPolicies,budgetStore,agentBridgeSecret:"team-budgets-agent-bridge-secret-at-least-32-characters"});
const headers={"x-lemmacomputer-proxy-token":proxyToken,cookie:"lemmacomputer_session=valid"};

test("Team budget API is administrator-only, tenant-derived, validated, and returns current period state",async()=>{
  const store=new FakeBudgetStore();const admin=appFor(administrator,store);const user=appFor(employee,store);
  try{
    assert.equal((await user.inject({method:"GET",url:`/v1/admin/teams/${teamId}/budget`,headers})).statusCode,403);
    assert.equal(store.calls.length,0);
    const invalid=await admin.inject({method:"PUT",url:`/v1/admin/teams/${teamId}/budget`,headers,payload:{limitAmount:"100",currency:"usd",periodType:"calendar_month",timezone:"UTC",mode:"hard",thresholds:["0"]}});
    assert.equal(invalid.statusCode,400);
    const saved=await admin.inject({method:"PUT",url:`/v1/admin/teams/${teamId}/budget`,headers,payload:{limitAmount:"100.000000000000",currency:"USD",periodType:"calendar_month",timezone:"America/New_York",mode:"hard",thresholds:["50","80","100"]}});
    assert.equal(saved.statusCode,200);
    assert.equal(saved.json().status.remainingAmount,"70.000000000000");
    assert.equal(saved.json().status.enforcement,"hard");
    assert.equal(saved.json().reconciliation.status,"unavailable");
    const create=store.calls.find((call)=>call.method==="create")!;
    assert.equal(create.tenantId,"acme");assert.equal(create.teamId,teamId);assert.equal(create.createdBy,"budget-admin");
    const evidence=store.calls.find((call)=>call.method==="reconcile")!;
    assert.equal(evidence.tenantId,"acme");assert.equal(evidence.startedBy,"budget-admin");

    const status=await admin.inject({method:"GET",url:`/v1/admin/teams/${teamId}/budget`,headers});
    assert.equal(status.statusCode,200);assert.equal(status.json().status.period.start,"2026-07-01T00:00:00.000Z");
    const override=await admin.inject({method:"POST",url:`/v1/admin/teams/${teamId}/budget/override`,headers,payload:{overrideType:"limit_increase",newLimitAmount:"150",reason:"Approved campaign capacity",expiresAt:"2026-08-01T00:00:00.000Z"}});
    assert.equal(override.statusCode,200);assert.equal(override.json().status.effectiveLimitAmount,"150");
    assert.equal((store.calls.find((call)=>call.method==="override")!).tenantId,"acme");
    const reconciled=await admin.inject({method:"POST",url:`/v1/admin/teams/${teamId}/budget/reconcile`,headers});
    assert.equal(reconciled.statusCode,200);assert.equal(reconciled.json().reconciliation.status,"unavailable");
  }finally{await Promise.all([admin.close(),user.close()]);}
});
