import { z } from "zod";
import { candidate, hash, ControlError, type Snapshot } from "./control-contract";
import type { ControlStore, Release } from "./control-store";
import { RegistryLLM, type ClientDependencies } from "./client";
import { withRelease } from "./execution-release";
import { parseSource, type Parsed } from "../graph/parser";
import { resolveSubjects } from "../graph/subject-matcher";
import { abstractRelations } from "../graph/relation-abstractor";
import { QueryParser } from "../graph/query-parser";
import { Storyteller } from "../memory/storyteller";
import type { MemoryNet } from "../graph/memory-net";
import { failure, result, issue } from "./validation/pipeline";
import type { ExecutionRecord } from "./observability";
export const PlaygroundInput=z.object({draftRevision:z.number().int().positive(),
  mode:z.enum(["v2-parser","v2-subject-disambiguation","v2-relations","v3-query","v3-story","ingest","retrieval"]),
  input:z.string().min(1).max(4000),vendorEgressAcknowledged:z.literal(true)}).strict();
function release(snapshot:Snapshot):Release{return {snapshot,release_id:`playground-${hash(snapshot)}`,release_fingerprint:hash(snapshot),model_fingerprint:snapshot.modelFingerprint,task_fingerprint:snapshot.taskFingerprint};}
/** No store, queue, tools or publication capability is supplied to this runner. */
export async function playgroundSnapshot(snapshot:Snapshot,input:z.infer<typeof PlaygroundInput>,signal:AbortSignal,deps:ClientDependencies={}){
  const records:ExecutionRecord[]=[],raw:Array<{stage:string;output:unknown}>=[];
  const started=Date.now(),bounded=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  const config=structuredClone(snapshot.llm);
  config.models=config.models.map(m=>m.alias==="graph_embedding"?m:{...m,timeoutMs:Math.min(m.timeoutMs,3000),retries:0,maxTokens:Math.min(m.maxTokens,2048),fallback:[]});
  return withRelease(release(snapshot),async()=>{
    const client=new RegistryLLM(config,"graph_parser",{...deps,observe:r=>records.push(r)});
    const llm={json:async(stage:string,data:unknown,s:AbortSignal)=>{const output=await client.json(stage,data,s);if(Buffer.byteLength(JSON.stringify(output))>65536){throw new ControlError(422,"Playground output budget");}raw.push({stage,output});return output;}};
    const source={id:"synthetic",ns:"playground",version:1,hash:"synthetic",title:"Synthetic input",content:input.input,deleted:0};
    const emptyNet:MemoryNet={query:{subjects:[],narratives:[],temporal:{kind:"unknown"}},temporal:{kind:"unknown"},subjects:[],wikiSections:[],edges:[],events:[],provenance:[],partial:false,warnings:[]};
    try{
      let output:unknown;
      if(input.mode==="v3-query"||input.mode==="retrieval"){
        const query=await new QueryParser(llm,3000).parse(input.input,bounded);
        output=input.mode==="retrieval"?{query,story:await new Storyteller(llm,3000).tell({...emptyNet,query:query.plan},bounded)}:query;
      }else if(input.mode==="v3-story")output=await new Storyteller(llm,3000).tell(emptyNet,bounded);
      else {
        const parsed:Parsed=input.mode==="v2-parser"||input.mode==="ingest"?await parseSource(llm,source,bounded):{subjects:[],narratives:[],stableAttributes:[]};
        if(input.mode==="v2-parser")output=parsed;
        else if(input.mode==="v2-subject-disambiguation"){
          // Force the production matcher path with a bounded synthetic homonym collision.
          parsed.subjects=[{ref:"s",name:"Bob",identity:"Bob engineer",type:"person",aliases:[],grouping:"independent",quote:"Bob engineer",position:0}];
          output=await resolveSubjects(parsed,[{subjectId:"synthetic-bob",canonicalName:"Bob",type:"person",identityKey:"person:bob doctor",aliases:[],wikiPageId:"synthetic",sectionKey:"synthetic"}],llm,bounded);
        }else{
          const matches=await resolveSubjects(parsed,[],llm,bounded);
          output=await abstractRelations(llm,parsed,matches,source,undefined,bounded);
        }
      }
      if(Buffer.byteLength(JSON.stringify(raw))>65536)throw new ControlError(422,"Playground output budget");
      const serialized=output as {status?:string;query?:{status?:string};story?:{status?:string}};
      const fallback=serialized?.status==="fallback"||serialized?.status==="deterministic"||serialized?.query?.status==="fallback"||serialized?.story?.status==="deterministic";
      return envelope(output,result(input.mode,fallback?[issue(input.mode,"domain","SEMANTIC_UNCERTAIN","needs_review")]:[],["output","evidence","domain"]));
    }catch(error){return envelope(null,failure(input.mode,error,bounded.aborted));}
    function envelope(output:unknown,validation:ReturnType<typeof result>|null){
      return {output,raw,validation,records,latencyMs:Date.now()-started,candidateHash:hash(snapshot),
        taskFingerprint:snapshot.taskFingerprint,modelFingerprint:snapshot.modelFingerprint,
        checkedLayers:validation?.checkedLayers??[],
        notRun:["persistence","ACL","lease","publication","vector search","native agent harness"],publication:false,
        context:"synthetic upstream context; empty store / empty memory net",estimatedCost:null};
    }
  });
}
export async function playground(store:ControlStore,body:unknown,signal:AbortSignal,deps:ClientDependencies={}){
  const input=PlaygroundInput.parse(body),draft=await store.draft();
  if(input.draftRevision!==draft.revision)throw new ControlError(409,"Draft changed; reload");
  const active=await store.active(),snapshot=candidate(draft.config,store.policy,draft.prompts??undefined);
  // Sequential arms bound total inference concurrency. Both use the identical input and synthetic context.
  return {baseline:await playgroundSnapshot(active.snapshot,input,signal,{transport: (await import("./managed-transport")).managedTransport,...deps}),
    candidate:await playgroundSnapshot(snapshot,input,signal,{transport:(await import("./managed-transport")).managedTransport,...deps})};
}
