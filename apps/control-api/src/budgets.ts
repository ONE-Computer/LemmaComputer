import { createHash } from "node:crypto";
import { z } from "zod";
import type { GatewayBudgetProjection, GatewayBudgetReconciliation, LiteLlmTeamBudgetProjector } from "@onecomputer/litellm-adapter";
import { usageFingerprint, type TeamBudgetStore } from "@onecomputer/workspace-store";
import type { InternalUsageCompletion, UsageEventRecordedHook } from "./usage-ledger.js";

const money=z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/);
export const saveTeamBudgetSchema=z.strictObject({
  limitAmount:money,
  currency:z.string().regex(/^[A-Z]{3}$/),
  periodType:z.enum(["calendar_month","calendar_week"]),
  timezone:z.string().trim().min(1).max(100),
  mode:z.enum(["soft","hard"]),
  thresholds:z.array(z.string().regex(/^(?:0|[1-9]\d?)(?:\.\d{1,3})?$|^100(?:\.0{1,3})?$/)).min(1).max(10),
  effectiveFrom:z.iso.datetime().optional(),
  effectiveTo:z.iso.datetime().optional(),
});
export const budgetOverrideSchema=z.strictObject({
  overrideType:z.enum(["limit_increase","hard_limit_bypass"]),
  newLimitAmount:money.optional(),
  reason:z.string().trim().min(3).max(1000),
  expiresAt:z.iso.datetime(),
}).superRefine((value,context)=>{
  if(value.overrideType==="limit_increase"&&!value.newLimitAmount)context.addIssue({code:"custom",path:["newLimitAmount"],message:"A limit increase requires a new limit"});
  if(value.overrideType==="hard_limit_bypass"&&value.newLimitAmount)context.addIssue({code:"custom",path:["newLimitAmount"],message:"A hard-limit bypass does not change the limit"});
});

type Actor={tenantId:string;userId:string};
export class TeamBudgetAdministrationService{
  constructor(private readonly store:TeamBudgetStore,private readonly projector?:LiteLlmTeamBudgetProjector){}

  get(actor:Actor,teamId:string,now=new Date()){return this.store.getBudgetStatus(actor.tenantId,teamId,now);}

  async save(actor:Actor,teamId:string,input:z.infer<typeof saveTeamBudgetSchema>,now=new Date()){
    const effectiveFrom=input.effectiveFrom?new Date(input.effectiveFrom):now;
    const effectiveTo=input.effectiveTo?new Date(input.effectiveTo):undefined;
    await this.store.createBudgetVersion({tenantId:actor.tenantId,teamId,limitAmount:input.limitAmount,currency:input.currency,periodType:input.periodType,timezone:input.timezone,mode:input.mode,thresholds:input.thresholds,effectiveFrom,effectiveTo,createdBy:actor.userId});
    const reconciliation=await this.sync(actor,teamId,now);
    return{status:await this.get(actor,teamId,now),reconciliation};
  }

  async override(actor:Actor,teamId:string,input:z.infer<typeof budgetOverrideSchema>,now=new Date()){
    await this.store.createOverride({tenantId:actor.tenantId,teamId,overrideType:input.overrideType,newLimitAmount:input.newLimitAmount,actorUserId:actor.userId,reason:input.reason,expiresAt:new Date(input.expiresAt),now});
    const reconciliation=await this.sync(actor,teamId,now);
    return{status:await this.get(actor,teamId,now),reconciliation};
  }

  async sync(actor:Actor,teamId:string,now=new Date()):Promise<GatewayBudgetReconciliation>{
    const status=await this.store.getBudgetStatus(actor.tenantId,teamId,now);
    if(!status.budget||!status.period||!status.effectiveLimitAmount)throw new Error("Active Team budget not found");
    const projection:GatewayBudgetProjection={tenantId:actor.tenantId,teamId,budgetVersionId:status.budget.id,limitAmount:status.effectiveLimitAmount,currency:status.budget.currency,mode:status.budget.mode,periodStart:status.period.start,periodEnd:status.period.end};
    let result:GatewayBudgetReconciliation;
    if(this.projector){
      try{await this.projector.project(projection);result=await this.projector.reconcile(projection);}
      catch{result={status:"unavailable",projectionKey:this.projector.projectionKey(projection),expectedFingerprint:usageFingerprint(projection),observedFingerprint:null,detail:"LiteLLM Team projection is unavailable; hard admission remains fail closed"};}
    }else{
      result={status:"unavailable",projectionKey:`oc-budget-${createHash("sha256").update(`${actor.tenantId}\0${teamId}`).digest("hex").slice(0,24)}`,expectedFingerprint:usageFingerprint(projection),observedFingerprint:null,detail:"LiteLLM Team projection is not configured; ONEComputer admission remains authoritative"};
    }
    await this.store.recordGatewayReconciliation({tenantId:actor.tenantId,teamId,budgetVersionId:status.budget.id,projectionKey:result.projectionKey,limitAmount:status.effectiveLimitAmount,mode:status.budget.mode,expectedFingerprint:result.expectedFingerprint,observedFingerprint:result.observedFingerprint,status:result.status,detail:result.detail,startedBy:actor.userId,checkedAt:now});
    return result;
  }
}

export class BudgetUsageEventRecordedHook implements UsageEventRecordedHook{
  constructor(private readonly store:Pick<TeamBudgetStore,"settleUsageEvent">){}
  async recorded(input:InternalUsageCompletion,result:{status:"created"|"duplicate";eventId:string}){
    if(input.eventType==="correction")return;
    await this.store.settleUsageEvent({tenantId:input.tenantId,usageEventId:result.eventId,settledAt:new Date(input.occurredAt)});
  }
}
