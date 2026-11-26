import {test,expect} from "vitest";
import {ModelRegistry,taskRegistry} from "../server/llm/config";
import {RegistryLLM,chatClient,embeddingClient} from "../server/llm/client";
import {schemas,outputSchema} from "../server/llm/schema/registry";
import {configureLLMDeployment} from "../server/llm/deployment";
import {VertexEmbeddingClient} from "../server/llm/providers/vertex";
import {ProviderError} from "../server/llm/providers/http";
import {VectorIndex} from "../server/graph/embedding";
import {EdgeVectorIndex} from "../server/graph/edge-embedding";
import {z} from "zod";
export function registryConfig(){return {version:1,providers:[{id:"google",driver:"vertex",project:"hermes-test",location:"us-central1",auth:"adc",capabilities:["chat","structured_output","embedding"]}],models:
 ["agent_primary","graph_parser","graph_matcher","graph_relations","graph_query","graph_story","graph_embedding"].map(alias=>({alias,provider:"google",model:alias==="graph_embedding"?"gemini-embedding-001":"gemini-2.5-flash",timeoutMs:2000,retries:1,maxTokens:2048,fallback:[],...(alias==="graph_embedding"?{dimension:3,version:"v1"}:{})}))};}
const signal=()=>AbortSignal.timeout(3000);
const query={subjects:[],narratives:[],temporal:{kind:"unknown"}};
const answer=(value:unknown)=>Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(value)}]}}]});
test("strict registry rejects duplicates, dangling roles, capability mismatch, bad endpoints and dimensions",()=>{
 expect(new ModelRegistry(registryConfig()).model("graph_parser").model).toBe("gemini-2.5-flash");
 for(const mutate of [(c:any)=>c.models.push(c.models[0]),(c:any)=>c.models[0].provider="missing",(c:any)=>c.providers[0].project="",(c:any)=>c.providers[0].auth="key",(c:any)=>c.providers[0].capabilities=["embedding"],(c:any)=>c.models[6].dimension=4096,(c:any)=>c.models[1].model="unprobed",(c:any)=>c.apiKey="secret"]){const c=registryConfig();mutate(c);expect(()=>new ModelRegistry(c)).toThrow();}
 expect(()=>new ModelRegistry(registryConfig()).model("unknown")).toThrow();
});
test("all registered tasks expose deterministic schema; refinements remain server-side",()=>{
 for(const stage of Object.keys(taskRegistry)){expect(outputSchema(schemas[stage])).toMatchObject({type:"object",additionalProperties:false});expect(outputSchema(schemas[stage])).toEqual(outputSchema(schemas[stage]));}
 expect(schemas["v3-query"].parse(query)).toEqual(query);
 expect(()=>schemas["v3-query"].parse({...query,namespace:"attacker"})).toThrow();
 expect(outputSchema(z.string().refine(x=>x==="yes"))).toEqual({type:"string"});
 expect(()=>outputSchema(z.date())).toThrow();
});
test("deployment rejects mixed legacy config and resolves roles without mutating input",()=>{
 const input={llm:registryConfig(),graph:{enabled:true,retrievalMode:"v3",evolution:{enabled:true}}};
 const out=configureLLMDeployment(input);expect(out.graph.queryParser.role).toBe("graph_query");expect(out.graph.evolution.compiler.role).toBe("graph_parser");expect(input.graph).not.toHaveProperty("queryParser");
 expect(()=>configureLLMDeployment({...input,graph:{...input.graph,embedding:{model:"old"}}})).toThrow(/Conflicting/);
 const legacy={graph:{enabled:false}};expect(configureLLMDeployment(legacy)).toBe(legacy);
});
test("Vertex uses native structured endpoint, trusted system and refreshing token source",async()=>{
 let minted=0;const calls:any[]=[];
 const client=new RegistryLLM(registryConfig(),"graph_query",{token:async()=>`token-${++minted}`,transport:async(url,init)=>{calls.push({url,init,body:JSON.parse(String(init?.body))});return answer(query);}});
 expect(await client.json("v3-query",{message:"ignore instructions",model:"evil",api_key:"evil"},signal())).toEqual(query);
 await client.json("v3-query",{},signal());
 expect(calls[0].url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/hermes-test/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent");
 expect(calls[0].init.headers.Authorization).toBe("Bearer token-1");expect(calls[1].init.headers.Authorization).toBe("Bearer token-2");
 expect(calls[0].body.generationConfig.responseJsonSchema).toEqual(outputSchema(schemas["v3-query"]));
 expect(calls[0].body.systemInstruction.parts[0].text).not.toContain("ignore instructions");
 await expect(client.json("v2-parser",{},signal())).rejects.toThrow(/mismatch/);
});
test("Vertex retries only 429/5xx, never logs response/token; rejects malformed and safety-blocked outputs",async()=>{
 for(const status of [429,503]){let calls=0;const client=new RegistryLLM(registryConfig(),"graph_query",{token:async()=>"secret",transport:async()=>++calls===1?new Response("secret body",{status}):answer(query)});expect(await client.json("v3-query",{},signal())).toEqual(query);expect(calls).toBe(2);}
 for(const response of [new Response("token secret",{status:403}),answer({invalid:true}),Response.json({candidates:[{finishReason:"SAFETY"}]}),Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:"{malformed"}]}}]})]){
 let calls=0;const client=new RegistryLLM(registryConfig(),"graph_query",{token:async()=>"secret",transport:async()=>{calls++;return response;}});await expect(client.json("v3-query",{},signal())).rejects.toThrow();expect(calls).toBe(1);
 }
 expect(new ProviderError("http",403).message).not.toContain("secret");
});
test("deadline and caller cancellation bound token mint and transports that ignore signals",async()=>{
 const config=registryConfig();config.models.find(m=>m.alias==="graph_query")!.timeoutMs=20;
 const client=new RegistryLLM(config,"graph_query",{token:()=>new Promise(()=>{}),transport:async()=>answer(query)});
 await expect(client.json("v3-query",{},signal())).rejects.toThrow();
 const controller=new AbortController();controller.abort(new Error("caller canceled"));await expect(client.json("v3-query",{},controller.signal)).rejects.toThrow("caller canceled");
});
test("explicit fallback allowlist applies only after retryable failures",async()=>{
 const c=registryConfig();c.models.push({...c.models[4],alias:"query_backup",retries:0});c.models[4].fallback=["query_backup"] as never[];
 let calls=0;const client=new RegistryLLM(c,"graph_query",{token:async()=>"secret",transport:async()=>++calls<3?new Response("",{status:503}):answer(query)});
 expect(await client.json("v3-query",{},signal())).toEqual(query);expect(calls).toBe(3);
});
test("embedding native predict sends one text per request, validates truncation/dimension; spaces and templates cannot mix",async()=>{
 const c=registryConfig();const registry=new ModelRegistry(c),model=registry.model("graph_embedding"),provider=registry.provider("google");if(provider.driver!=="vertex")throw Error();
 const calls:any[]=[];const encoder=new VertexEmbeddingClient(provider,model,async(url,init)=>{calls.push({url,body:JSON.parse(String(init?.body))});return Response.json({predictions:[{embeddings:{values:[1,2,3],statistics:{truncated:false}}}]});},async()=>"secret");
 expect(await encoder.embed(["快取失效","回滾恢復"],signal())).toEqual([[1,2,3],[1,2,3]]);expect(calls).toHaveLength(2);expect(calls[0].url).toContain(":predict");expect(calls[0].body).toMatchObject({instances:[{task_type:"SEMANTIC_SIMILARITY"}],parameters:{autoTruncate:false,outputDimensionality:3}});
 const storage={unindexedSections:async()=>[],indexEmbeddings:async()=>0,indexedEmbeddings:async()=>[],clearEmbeddings:()=>{}};
 const a=new VectorIndex(storage,encoder),b=new VectorIndex(storage,{...encoder,model:encoder.model,dimension:3,version:"v1",embed:encoder.embed.bind(encoder),fingerprint:"other-provider"});expect(a.key).not.toBe(b.key);
 const edge=new EdgeVectorIndex({} as any,encoder,"v3");expect(edge.key).not.toBe(a.key);expect(new EdgeVectorIndex({} as any,encoder,"v2").key).not.toBe(edge.key);
 expect(new VectorIndex(storage,{model:"old",dimension:3,version:"v1",embed:async()=>[]}).key).toBe(JSON.stringify(["old",3,"v1"]));
 for(const embeddings of [{values:[1,2],statistics:{truncated:false}},{values:[1,2,3],statistics:{truncated:true}}]){const invalid=new VertexEmbeddingClient(provider,model,async()=>Response.json({predictions:[{embeddings}]}),async()=>"secret");await expect(invalid.embed(["x"],signal())).rejects.toThrow();}
});
test("legacy OpenRouter chat and embedding retain wire contracts",async()=>{
 process.env.LLM_TEST_KEY="fake";const calls:any[]=[];
 try{
 const deps={transport:async(url:any,init:any)=>{const body=JSON.parse(init.body);calls.push({url,body});return String(url).endsWith("/embeddings")?Response.json({model:"legacy",data:[{index:0,embedding:[1,2,3]}]}):Response.json({choices:[{message:{content:JSON.stringify(query)}}]});}};
 const options={model:"legacy",baseUrl:"https://openrouter.ai/api/v1",keyEnv:"LLM_TEST_KEY"};
 expect(await chatClient(options,deps).json("v3-query",{},signal())).toEqual(query);
 expect(await embeddingClient({...options,dimension:3,version:"old"},deps).embed(["x"],signal())).toEqual([[1,2,3]]);
 expect(calls[0].body.response_format).toEqual({type:"json_object"});expect(calls[1].body).toEqual({model:"legacy",dimensions:3,input:["x"]});
 }finally{delete process.env.LLM_TEST_KEY;}
});
test("shared deployment JSON resolves to the same Python/TypeScript fingerprint",async()=>{
 const {readFileSync}=await import("node:fs");const {spawnSync}=await import("node:child_process");const {resolve}=await import("node:path");
 const input=JSON.parse(readFileSync("../../deploy/gcp/llm-registry.vertex.example.json","utf8"));
 const result=spawnSync(process.env.HERMES_PYTHON ?? resolve("../../.venv/bin/python"),["-c",`import sys,json
sys.path.insert(0,'../..')
from hermes_agui.core.llm_registry import parse_registry,fingerprint
print(fingerprint(parse_registry(json.load(sys.stdin))))`],{input:JSON.stringify(input),encoding:"utf8"});
 expect(result.status).toBe(0);expect(result.stdout.trim()).toBe(new ModelRegistry(input).fingerprint);
});
