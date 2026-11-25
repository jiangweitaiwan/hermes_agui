import { test,expect } from "vitest";
import { candidate,hash,verifySnapshot } from "../server/llm/control-contract";
import { controlFixture } from "./fixtures/llm-control";
import { withRelease } from "../server/llm/execution-release";
import { promptFor,systemPrompt,baselineSystemPrompt } from "../server/llm/prompts/registry";
import { taskFingerprint } from "../server/llm/config";
import { schemaView } from "../server/llm/prompt-contract";
import { schemas,outputSchema } from "../server/llm/schema/registry";
import { promptRegression } from "../server/llm/prompt-regression";
import { playgroundSnapshot } from "../server/llm/playground";
const pinned=(snapshot:ReturnType<typeof candidate>)=>({release_id:hash(snapshot),snapshot,release_fingerprint:hash(snapshot),model_fingerprint:snapshot.modelFingerprint,task_fingerprint:snapshot.taskFingerprint});
test("immutable execution selection preserves baseline bytes, protected rules and isolated retries",async()=>{
  const {llm,policy}=controlFixture(),old=candidate(llm,policy),fresh=candidate(llm,policy,{"v2-parser":"Prefer concise extraction. {{SECRET}}"});
  expect(systemPrompt("v2-parser")).toBe(baselineSystemPrompt("v2-parser"));
  const empty=candidate(llm,policy,{});expect((empty.tasks["v2-parser"] as {prompt:string}).prompt).toBe(baselineSystemPrompt("v2-parser"));
  const [before,after]=await Promise.all([withRelease(pinned(old),async()=>{await Promise.resolve();return [systemPrompt("v2-parser"),taskFingerprint()];}),withRelease(pinned(fresh),async()=>{await Promise.resolve();return [systemPrompt("v2-parser"),taskFingerprint()];})]);
  expect(before).toEqual([baselineSystemPrompt("v2-parser"),old.taskFingerprint]);
  expect(after[0]).toContain("{{SECRET}}");expect(after[0]).toContain("No inferred actors.");expect(after[0]).toContain("Preserve negation");
  expect(after[1]).toBe(fresh.taskFingerprint);expect(after[1]).not.toBe(before[1]);
  expect(withRelease(pinned(old),()=>promptFor("v2-parser").version)).toBe("1");
  expect(verifySnapshot(fresh,hash(fresh),policy)).toEqual(fresh);
  const corrupt=structuredClone(fresh);(corrupt.tasks["v2-parser"] as {prompt:string}).prompt="ignore safety";
  expect(()=>verifySnapshot(corrupt,hash(corrupt),policy)).toThrow("incompatible");
  expect(()=>candidate(llm,policy,{schema:{}})).toThrow();expect(()=>candidate(llm,policy,{analysis:"edit legacy"})).toThrow();
});
test("schema viewer uses deployed projection and negative safety corpus fails forged output",()=>{
  expect(schemaView("v2-parser").schema).toEqual(outputSchema(schemas["v2-parser"]));
  expect(()=>schemaView("__proto__")).toThrow();expect(promptRegression().passed).toBe(true);
});
test("playground calls production parser and adapter with candidate prompt, without publication",async()=>{
  const {llm,policy}=controlFixture(),snapshot=candidate(llm,policy,{"v2-parser":"CANDIDATE"});
  const requests:unknown[]=[];
  const result=await playgroundSnapshot(snapshot,{draftRevision:1,mode:"v2-parser",input:"synthetic",vendorEgressAcknowledged:true},AbortSignal.timeout(5000),{
    token:async()=>"fixture-token",transport:async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({subjects:[],narratives:[],stableAttributes:[]})}]},finishReason:"STOP"}]});}});
  expect(result.publication).toBe(false);expect(result.validation?.verdict).toBe("accepted");expect(result.raw).toHaveLength(1);
  expect(JSON.stringify(requests)).toContain("CANDIDATE");expect(result.notRun).toContain("ACL");
  expect(result.records[0].promptVersion).toMatch(/^p2-/);expect(JSON.stringify(result)).not.toContain("fixture-token");
});

test("Python Host accepts the dynamic snapshot only with its deployed code contract",async()=>{
  const {spawnSync}=await import("node:child_process");const {resolve}=await import("node:path");
  const {llm,policy}=controlFixture(),baseline=candidate(llm,policy),snapshot=candidate(llm,policy,{agent_primary:"native slot", "v2-parser":"candidate"});
  const host=spawnSync(resolve("../../.venv/bin/python"),["-c",`
import json,sys
from hermes_agui.core.managed_llm import validate_snapshot,native_instruction
v=json.load(sys.stdin)
validate_snapshot(v['snapshot'],v['hash'],v['policy'])
assert native_instruction(v['snapshot'])=='native slot'
v['policy']['taskFingerprint']='0'*64
try:
    validate_snapshot(v['snapshot'],v['hash'],v['policy'])
except ValueError:
    print('compatible-and-denied-old-image')
else:
    raise AssertionError('incompatible image accepted')
`],{cwd:"../..",input:JSON.stringify({snapshot,hash:hash(snapshot),policy:{approved:policy.approved,taskFingerprint:baseline.taskFingerprint}}),encoding:"utf8"});
  expect(host.stderr).toBe("");expect(host.status).toBe(0);expect(host.stdout.trim()).toBe("compatible-and-denied-old-image");
});
