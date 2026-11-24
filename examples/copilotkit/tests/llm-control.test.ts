import { expect, test,vi } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { candidate, hash, verifySnapshot } from "../server/llm/control-contract";
import { ModelRegistry } from "../server/llm/config";
import { RegistryLLM,embeddingClient } from "../server/llm/client";
import { withRelease, executionRelease } from "../server/llm/execution-release";
import { managedRunPreparation } from "../server/llm/run-pinning";
import { controlFixture } from "./fixtures/llm-control";
import type { ControlStore } from "../server/llm/control-store";
import { publicIPv4,managedTransport } from "../server/llm/managed-transport";
import golden from "../../../tests/fixtures/llm-control-golden.json";
import { controlApi } from "../server/llm/control-api";
import { databaseTarget } from "../server/llm/database-target";

test("embedding logs retain release/selector fingerprints without input or credential values",async()=>{
  const {llm,policy}=controlFixture(),snapshot=candidate(llm,policy);
  const release={release_id:"embedding-run",snapshot,release_fingerprint:hash(snapshot),model_fingerprint:snapshot.modelFingerprint,task_fingerprint:snapshot.taskFingerprint};
  const records:unknown[]=[];const spy=vi.spyOn(console,"error").mockImplementation(value=>{records.push(JSON.parse(value));});
  try{
    const encoder=embeddingClient({registry:llm,role:"graph_embedding"},{token:async()=>"private-token",transport:async()=>Response.json({predictions:[{embeddings:{values:[1,2,3],statistics:{truncated:false}}}]})});
    const selector=encoder.fingerprint;
    expect(await withRelease(release,()=>encoder.embed(["private-source"],AbortSignal.timeout(2000)))).toEqual([[1,2,3]]);
    expect(records[0]).toMatchObject({event:"llm_embedding_execution",releaseId:"embedding-run",releaseFingerprint:release.release_fingerprint,
      embeddingFingerprint:selector,configHash:snapshot.modelFingerprint,outcome:"succeeded"});
    expect(JSON.stringify(records)).not.toMatch(/private-source|private-token/);
  }finally{spy.mockRestore();}
});

test("database destination binding ignores credentials and rejects different ledgers",()=>{
  expect(databaseTarget("postgresql://runtime:execution-secret@db:5432/runtime")).toBe(databaseTarget("postgres://admin:admin-secret@db/runtime"));
  expect(databaseTarget("postgresql://runtime@db/runtime")).not.toBe(databaseTarget("postgresql://runtime@db/foreign"));
  expect(()=>databaseTarget("postgresql://runtime@db/")).toThrow();
});

test("approved provider selection uses the existing compatible adapter without accepting an endpoint override",async()=>{
  const {llm,policy}=controlFixture();
  const provider={id:"approved-compatible",driver:"openai-compatible" as const,baseUrl:"https://approved.example/v1",
    keyEnv:"LLM_CONTROL_FIXTURE_KEY",capabilities:["structured_output" as const]};
  policy.approved.providers.push(provider);policy.approved.models[2]={...policy.approved.models[2],provider:provider.id,model:"approved-chat"};
  const config:any=structuredClone(llm);config.providers.push(provider);config.models[4]={...config.models[4],provider:provider.id,model:"approved-chat"};
  const snapshot=candidate(config,policy);
  const previous=process.env.LLM_CONTROL_FIXTURE_KEY;process.env.LLM_CONTROL_FIXTURE_KEY="synthetic-only";
  const calls:string[]=[];
  try{
    const client=new RegistryLLM(llm,"graph_query",{transport:async(url)=>{calls.push(String(url));return Response.json({choices:[{message:{content:JSON.stringify({subjects:[],narratives:[],temporal:{kind:"unknown"}})},finish_reason:"stop"}]});}},true);
    await withRelease({release_id:"provider-switch",snapshot,release_fingerprint:hash(snapshot),model_fingerprint:snapshot.modelFingerprint,task_fingerprint:snapshot.taskFingerprint},
      ()=>client.json("v3-query",{},AbortSignal.timeout(2000)));
    expect(calls).toEqual(["https://approved.example/v1/chat/completions"]);
  }finally{if(previous===undefined)delete process.env.LLM_CONTROL_FIXTURE_KEY;else process.env.LLM_CONTROL_FIXTURE_KEY=previous;}
});

test("probe concurrency reserves capacity before an asynchronous draft read",async()=>{
  const {policy}=controlFixture();
  const rejectors:((error:Error)=>void)[]=[];
  let ready!:()=>void;const entered=new Promise<void>(r=>{ready=r;});
  const store={policy,draft:()=>new Promise((_resolve,reject)=>{rejectors.push(reject);if(rejectors.length===2)ready();})} as unknown as ControlStore;
  const handle=controlApi(store,{authenticate:()=>({principal:"deployment-admin",ownerId:"owner",projectId:"project"})});
  const request=()=>new Request("http://localhost/api/admin/llm/providers/test",{method:"POST",body:JSON.stringify({providerId:"google",draftRevision:1})});
  const first=handle(request()),second=handle(request());
  try{await entered;expect((await handle(request())).status).toBe(429);}
  finally{for(const reject of rejectors)reject(new Error("controlled database failure"));}
  expect((await Promise.all([first,second])).map(response=>response.status)).toEqual([503,503]);
});

test("shared golden snapshot is verifiable and private connection destinations fail closed",async()=>{
  const {policy}=controlFixture();
  expect(verifySnapshot(golden.snapshot,golden.releaseFingerprint,policy).modelFingerprint).toBe(golden.snapshot.modelFingerprint);
  for(const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","172.16.0.1","192.168.1.1","100.64.0.1","224.0.0.1","::1"])
    expect(publicIPv4(ip)).toBe(false);
  expect(publicIPv4("8.8.8.8")).toBe(true);
  await expect(managedTransport("https://127.0.0.1/metadata")).rejects.toThrow();
  await expect(managedTransport("https://localhost:9/metadata")).rejects.toThrow(/destination denied/);
});

test("managed candidate preserves embedding/model hashes and denies authority expansion", () => {
  const { llm, policy } = controlFixture();
  const snapshot = candidate(llm, policy);
  expect(snapshot.modelFingerprint).toBe(new ModelRegistry(llm).fingerprint);
  expect(verifySnapshot(snapshot, hash(snapshot), policy)).toEqual(snapshot);
  for (const mutate of [
    (value: any) => value.providers[0].project = "other-project",
    (value: any) => value.models[6].version = "v2",
    (value: any) => value.models[1].maxTokens = 100000,
    (value: any) => value.models[0].fallback = ["graph_query"],
    (value: any) => value.models[0].dimension = 3,
    (value: any) => value.apiKey = "secret",
    (value: any) => value.models[1].model = "unapproved-model",
    (value: any) => value.models.pop(),
  ]) { const value = structuredClone(llm); mutate(value); expect(() => candidate(value, policy)).toThrow(); }
  expect(() => verifySnapshot({ ...snapshot, contract: "future" }, hash(snapshot), policy)).toThrow();
});

test("exact endpoint and secret reference approval rejects private endpoints and overrides", () => {
  const { llm, policy } = controlFixture();
  for (const baseUrl of ["http://localhost:9999", "https://127.0.0.1", "https://169.254.169.254", "https://[::1]", "https://metadata.google.internal"]) {
    const value: any = structuredClone(llm);
    value.providers[0] = { id: "google", driver: "openai-compatible", baseUrl, keyEnv: "APPROVED_KEY", capabilities: ["chat", "structured_output", "embedding"] };
    expect(() => candidate(value, policy)).toThrow();
  }
});

test("same execution retains its release through publication while concurrent new execution changes route", async () => {
  const { llm, policy } = controlFixture(), snapshot = candidate(llm, policy);
  const second = structuredClone(llm); second.models[4].model = "gemini-2.5-pro";
  const next = candidate(second, policy);
  const release = (snapshot: typeof next, id: string) => ({ release_id: id, snapshot, release_fingerprint: hash(snapshot), model_fingerprint: snapshot.modelFingerprint, task_fingerprint: snapshot.taskFingerprint });
  const routes: string[] = [];
  const client = new RegistryLLM(llm, "graph_query", { token: async () => "synthetic-token", transport: async url => {
    routes.push(String(url));
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ subjects: [], narratives: [], temporal: { kind: "unknown" } }) }] } }] });
  } }, true);
  await expect(client.json("v3-query", {}, AbortSignal.timeout(2000))).rejects.toThrow(/pin/);
  let resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const first = withRelease(release(snapshot, "A"), async () => {
    await client.json("v3-query", {}, AbortSignal.timeout(2000));
    await paused;
    expect(executionRelease()?.release_id).toBe("A");
    await client.json("v3-query", {}, AbortSignal.timeout(2000));
  });
  await withRelease(release(next, "B"), () => client.json("v3-query", {}, AbortSignal.timeout(2000)));
  resume(); await first;
  expect(routes.filter(url => url.includes("gemini-2.5-pro"))).toHaveLength(1);
  expect(routes.filter(url => url.includes("gemini-2.5-flash"))).toHaveLength(2);
  expect(executionRelease()).toBeUndefined();
});

test("untrusted forwarded pin is rejected before resolving or retrieving", async () => {
  const prepare = managedRunPreparation({} as ControlStore);
  await expect(prepare("bot", { agentUrl: "http://localhost", token: "bot-token" },
    { threadId: "t", runId: "r", messages: [], tools: [], context: [], state: {}, forwardedProps: { llmRelease: { releaseId: "evil" } } },
    async input => input)).rejects.toThrow(/metadata/);
});

test("cross-language release canonical hash and trusted Host contract agree", () => {
  const { llm, policy } = controlFixture(), snapshot = candidate(llm, policy);
  const result = spawnSync(process.env.HERMES_PYTHON ?? resolve("../../.venv/bin/python"), ["-c", `
import json,sys
from hermes_agui.core.managed_llm import canonical_hash,validate_snapshot
v=json.load(sys.stdin)
validate_snapshot(v['snapshot'],v['hash'],v['policy'])
print(canonical_hash(v['snapshot']))
`], { cwd: "../..", input: JSON.stringify({ snapshot, hash: hash(snapshot), policy: { approved: policy.approved, taskFingerprint: snapshot.taskFingerprint } }), encoding: "utf8",
    env: { ...process.env, PYTHONPATH: process.cwd() + "/../.." } });
  expect(result.stderr).toBe(""); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe(hash(snapshot));
});
