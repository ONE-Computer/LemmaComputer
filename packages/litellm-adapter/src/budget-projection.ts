import { createHash, timingSafeEqual } from "node:crypto";

export type GatewayBudgetProjection = {
  tenantId:string;
  teamId:string;
  budgetVersionId:string;
  limitAmount:string;
  currency:string;
  mode:"soft"|"hard";
  periodStart:Date;
  periodEnd:Date;
};
export type GatewayBudgetReconciliation = {
  status:"matched"|"drifted"|"unavailable"|"repaired";
  projectionKey:string;
  expectedFingerprint:string;
  observedFingerprint:string|null;
  detail:string|null;
};

type FetchLike=(input:string|URL,init?:RequestInit)=>Promise<Response>;
const canonical=(value:unknown):string=>{
  if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
const fingerprint=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");

/**
 * Projects a non-authoritative enforcement mirror through LiteLLM's supported
 * Team API. LemmaComputer's exact ledger and reservation transaction remain the
 * source of truth; this adapter never reads a LiteLLM database.
 */
export class LiteLlmTeamBudgetProjector{
  private readonly baseUrl:string;
  constructor(config:{adminUrl:string;masterKey:string;timeoutMs?:number;fetch?:FetchLike}){
    this.baseUrl=config.adminUrl.replace(/\/$/,"");
    this.masterKey=config.masterKey;
    this.timeoutMs=config.timeoutMs??5_000;
    this.fetcher=config.fetch??fetch;
  }
  private readonly masterKey:string;
  private readonly timeoutMs:number;
  private readonly fetcher:FetchLike;

  projectionKey(input:Pick<GatewayBudgetProjection,"tenantId"|"teamId">){
    return`oc-budget-${createHash("sha256").update(`${input.tenantId}\0${input.teamId}`).digest("hex").slice(0,24)}`;
  }

  private expected(input:GatewayBudgetProjection){
    const numericLimit=Number(input.limitAmount);
    if(!Number.isFinite(numericLimit)||numericLimit<0)throw new Error("Budget limit is outside LiteLLM projection range");
    return{
      team_id:this.projectionKey(input),
      team_alias:this.projectionKey(input),
      // LiteLLM receives a blocking limit only in hard mode. Soft enforcement
      // remains an observable LemmaComputer warning.
      max_budget:input.mode==="hard"?numericLimit:null,
      metadata:{
        onecomputer_tenant_key:createHash("sha256").update(input.tenantId).digest("hex").slice(0,24),
        onecomputer_team_key:createHash("sha256").update(input.teamId).digest("hex").slice(0,24),
        onecomputer_budget_version_id:input.budgetVersionId,
        onecomputer_limit_amount:input.limitAmount,
        onecomputer_currency:input.currency,
        onecomputer_mode:input.mode,
        onecomputer_period_start:input.periodStart.toISOString(),
        onecomputer_period_end:input.periodEnd.toISOString(),
      },
    };
  }

  private async call(path:string,init:RequestInit){
    const response=await this.fetcher(`${this.baseUrl}${path}`,{
      ...init,
      headers:{authorization:`Bearer ${this.masterKey}`,"content-type":"application/json",...(init.headers??{})},
      signal:AbortSignal.timeout(this.timeoutMs),
    });
    const payload=await response.json().catch(()=>({}));
    return{ok:response.ok,status:response.status,payload};
  }

  async project(input:GatewayBudgetProjection){
    const expected=this.expected(input);
    try{
      const created=await this.call("/team/new",{method:"POST",body:JSON.stringify(expected)});
      if(created.ok)return{projectionKey:expected.team_id,fingerprint:fingerprint(expected)};
      if(created.status!==409)throw new Error(`LiteLLM Team projection failed (${created.status})`);
      const updated=await this.call("/team/update",{method:"POST",body:JSON.stringify(expected)});
      if(!updated.ok)throw new Error(`LiteLLM Team projection failed (${updated.status})`);
      return{projectionKey:expected.team_id,fingerprint:fingerprint(expected)};
    }catch(error){
      throw new Error("LiteLLM budget projection unavailable",{cause:error});
    }
  }

  async reconcile(input:GatewayBudgetProjection,repair=false):Promise<GatewayBudgetReconciliation>{
    const expected=this.expected(input);
    const expectedFingerprint=fingerprint(expected);
    try{
      const read=await this.call(`/team/info?team_id=${encodeURIComponent(expected.team_id)}`,{method:"GET"});
      if(!read.ok)throw new Error(`LiteLLM Team read failed (${read.status})`);
      const body=(read.payload&&typeof read.payload==="object"?read.payload:{}) as Record<string,unknown>;
      const metadata=(body.metadata&&typeof body.metadata==="object"?body.metadata:{}) as Record<string,unknown>;
      const observed={team_id:String(body.team_id??""),team_alias:String(body.team_alias??""),max_budget:body.max_budget??null,metadata:{
        onecomputer_tenant_key:metadata.onecomputer_tenant_key,
        onecomputer_team_key:metadata.onecomputer_team_key,
        onecomputer_budget_version_id:metadata.onecomputer_budget_version_id,
        onecomputer_limit_amount:metadata.onecomputer_limit_amount,
        onecomputer_currency:metadata.onecomputer_currency,
        onecomputer_mode:metadata.onecomputer_mode,
        onecomputer_period_start:metadata.onecomputer_period_start,
        onecomputer_period_end:metadata.onecomputer_period_end,
      }};
      const observedFingerprint=fingerprint(observed);
      const left=Buffer.from(expectedFingerprint,"hex");const right=Buffer.from(observedFingerprint,"hex");
      if(left.length===right.length&&timingSafeEqual(left,right))return{status:"matched",projectionKey:expected.team_id,expectedFingerprint,observedFingerprint,detail:null};
      if(!repair)return{status:"drifted",projectionKey:expected.team_id,expectedFingerprint,observedFingerprint,detail:"LiteLLM Team limit or LemmaComputer projection metadata differs"};
      await this.project(input);
      return{status:"repaired",projectionKey:expected.team_id,expectedFingerprint,observedFingerprint,detail:"Drift was repaired through the LiteLLM Team API"};
    }catch{
      return{status:"unavailable",projectionKey:expected.team_id,expectedFingerprint,observedFingerprint:null,detail:"LiteLLM Team state is unavailable; LemmaComputer hard admission remains fail closed"};
    }
  }
}
