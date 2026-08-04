import assert from "node:assert/strict";
import test from "node:test";
import { LiteLlmTeamBudgetProjector, type GatewayBudgetProjection } from "@lemmacomputer/litellm-adapter";

const input:GatewayBudgetProjection={tenantId:"customer-sensitive-tenant",teamId:"00000000-0000-4000-8000-000000000001",budgetVersionId:"00000000-0000-4000-8000-000000000002",limitAmount:"123.450000000000",currency:"USD",mode:"hard",periodStart:new Date("2026-03-01T00:00:00Z"),periodEnd:new Date("2026-04-01T00:00:00Z")};
const response=(status:number,payload:unknown)=>new Response(JSON.stringify(payload),{status,headers:{"content-type":"application/json"}});

test("LiteLLM projection uses supported Team APIs and sends only opaque identifiers and limits",async()=>{
  const calls:Array<{url:string;body:Record<string,unknown>;authorization:string}>=[];
  const projector=new LiteLlmTeamBudgetProjector({adminUrl:"http://litellm.internal:4000/",masterKey:"master-secret",fetch:async(url,init)=>{
    const body=init?.body?JSON.parse(String(init.body)):{};
    calls.push({url:String(url),body,authorization:String((init?.headers as Record<string,string>).authorization)});
    return response(calls.length===1?409:200,{ok:true});
  }});
  const projected=await projector.project(input);
  assert.match(projected.projectionKey,/^oc-budget-[a-f0-9]{24}$/);
  assert.deepEqual(calls.map((call)=>new URL(call.url).pathname),["/team/new","/team/update"]);
  assert.ok(calls.every((call)=>call.authorization==="Bearer master-secret"));
  assert.equal(calls[1]!.body.team_alias,projected.projectionKey);
  assert.equal(calls[1]!.body.team_id,projected.projectionKey);
  assert.equal(calls[1]!.body.max_budget,123.45);
  assert.equal((calls[1]!.body.metadata as Record<string,unknown>).lemmacomputer_limit_amount,"123.450000000000");
  const serialized=JSON.stringify(calls);
  assert.equal(serialized.includes(input.tenantId),false);
  assert.equal(serialized.includes("prompt"),false);
  assert.equal(serialized.includes("api_key"),false);
});

test("reconciliation detects drift, repairs through APIs, and reports gateway unavailability",async()=>{
  let expected:Record<string,unknown>|undefined;
  const bootstrap=new LiteLlmTeamBudgetProjector({adminUrl:"http://litellm",masterKey:"secret",fetch:async(_url,init)=>{
    expected=JSON.parse(String(init!.body));return response(200,{ok:true});
  }});
  await bootstrap.project(input);

  const matched=new LiteLlmTeamBudgetProjector({adminUrl:"http://litellm",masterKey:"secret",fetch:async()=>response(200,expected)});
  assert.equal((await matched.reconcile(input)).status,"matched");

  const paths:string[]=[];
  const drifted=new LiteLlmTeamBudgetProjector({adminUrl:"http://litellm",masterKey:"secret",fetch:async(url,init)=>{
    const path=new URL(String(url)).pathname;paths.push(path);
    if(init?.method==="GET")return response(200,{...expected,max_budget:999});
    return response(200,{ok:true});
  }});
  assert.equal((await drifted.reconcile(input)).status,"drifted");
  assert.equal((await drifted.reconcile(input,true)).status,"repaired");
  assert.ok(paths.includes("/team/update")||paths.includes("/team/new"));

  const unavailable=new LiteLlmTeamBudgetProjector({adminUrl:"http://litellm",masterKey:"secret",fetch:async()=>{throw new Error("offline");}});
  const result=await unavailable.reconcile(input);
  assert.equal(result.status,"unavailable");
  assert.match(result.detail!,/hard admission remains fail closed/);
});

test("soft budgets project observability metadata without a blocking LiteLLM max budget",async()=>{
  let body:Record<string,unknown>={};
  const projector=new LiteLlmTeamBudgetProjector({adminUrl:"http://litellm",masterKey:"secret",fetch:async(_url,init)=>{body=JSON.parse(String(init!.body));return response(200,{ok:true});}});
  await projector.project({...input,mode:"soft"});
  assert.equal(body.max_budget,null);
  assert.equal((body.metadata as Record<string,unknown>).lemmacomputer_mode,"soft");
});
