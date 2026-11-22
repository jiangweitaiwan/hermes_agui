import { MemoryRetriever } from "./retriever";
import type { createGraphMemory, GraphScope, GraphHit } from "../graph-memory";
import type { MemoryNet } from "../graph/memory-net";
import { assembleStory } from "./story-context";
import { ContextAssembler } from "./assembler";
import { Storyteller } from "./storyteller";
import { groundedStory } from "./story-validator";
import type { MemoryStory } from "./story-types";
function hits(net:MemoryNet,story:MemoryStory,scope:GraphScope):GraphHit[] {
  const canonical=groundedStory(net).claims,items=[...net.edges,...net.wikiSections],used=new Set<number>();
  return story.claims.flatMap((claim,i)=>{
    const index=canonical.findIndex((c,j)=>!used.has(j)&&JSON.stringify(c)===JSON.stringify(claim));
    used.add(index);
    const item=items[index];
    if(!item)return [];
    const refs=net.provenance.filter(p=>item.evidenceRefs.includes(p.ref));
    const sources=[...new Map(refs.map(p=>[JSON.stringify(p.source),p.source])).values()];
    if(!sources.length||sources.length>20||sources.some(s=>s.botId!==sources[0].botId))return [];
    const edge="edgeId" in item?item:undefined;
    return [{recordId:`story:${i}`,content:`${claim.text}\n${JSON.stringify({confidence:claim.confidence,...(edge?{eventId:edge.eventId,edgeId:edge.edgeId,attribution:edge.attribution,view:edge.view,time:edge.time}:{}),evidence:refs.map(p=>({ref:p.ref,quote:p.evidence?.quote}))})}`,
      source:sources[0],sources,visibility:item.namespace.visibility,principal:scope.principal,projectId:scope.projectId}];
  });
}
export class V3Orchestrator {
  constructor(readonly graph:ReturnType<typeof createGraphMemory>,readonly storyteller=new Storyteller(),readonly deadlineMs=8000, readonly observe?:(trace:{status:string;durationMs:number;inputBytes:number;outputBytes:number})=>void) {
    if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>15000)throw new Error("Invalid runtime deadline");
  }
  async prepare(scope:GraphScope,query:string,assembler:ContextAssembler) {
    const start=performance.now();
    const finish=(status:string,context:ReturnType<ContextAssembler["assemble"]>)=>{this.observe?.({status,durationMs:performance.now()-start,inputBytes:Buffer.byteLength(query),outputBytes:Buffer.byteLength(JSON.stringify(context))});return context;};
    const signal=AbortSignal.timeout(this.deadlineMs);
    const fallback=async(status:string)=>finish(status,assembler.assemble(await new MemoryRetriever(this.graph).retrieve(scope,query,signal)));
    const result=await this.graph.structuredQuery(scope,query,undefined,signal);
    if(result.status==="rejected")throw new Error(`Graph request rejected: ${result.reason}`);
    if(result.status==="disabled")return undefined;
    if(result.status==="fallback")return fallback("v2_parser_fallback");
    if(result.status!=="ok")return finish("unavailable",{version:2,records:[]});
    if(!result.net.edges.length&&!result.net.wikiSections.length)return fallback("v2_empty_net");
    const told=await this.storyteller.tell(result.net,signal);
    const refreshed=await this.graph.validateNet(scope,result.net,signal);
    if(refreshed.status==="rejected")throw new Error(`Graph request rejected: ${refreshed.reason}`);
    if(refreshed.status!=="ok"||signal.aborted)return finish("revalidation_unavailable",{version:2,records:[]});
    // A changed view invalidates all generated prose, including the summary.
    const story=JSON.stringify(refreshed.net)===JSON.stringify(result.net)?told.story:groundedStory(refreshed.net);
    const records=hits(refreshed.net,story,scope);
    return finish(`v3_${told.status}`,assembleStory(records,assembler,refreshed.net.partial||records.length<story.claims.length));
  }
}
