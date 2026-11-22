import type { GraphScope } from "../graph-memory";
import type { MemoryQueryPlan } from "./query-types";
import type { MemoryNet, NetResult } from "./memory-net";
import type { ReferenceTime } from "./temporal-resolver";
import { resolveQueryTime, queryTemporalView } from "./query-temporal-resolver";
import type { V2RetrievalStore, ReadEdge } from "./v2-retrieval-store";
import type { WikiRetriever } from "./retriever";
import type { EdgeVectorIndex } from "./edge-embedding";
import { queryEmbeddingTextV3 } from "./edge-embedding";
import type { QueryParser } from "./query-parser";
import { terms } from "./markdown";
import { digest, namespaceKey } from "./wiki-store";
import type { Namespace } from "./types";
import { addNetEdge, pruneNet } from "./net-builder";

/** Internal only. Access is exposed through the GraphMemory scope/ACL gate, never an HTTP route. */
export class StructuredRetriever {
  private issued = new WeakMap<MemoryNet,{scope:string; plan:MemoryQueryPlan; reference?:ReferenceTime}>();
  constructor(readonly store:V2RetrievalStore, readonly wiki:WikiRetriever, readonly parser:QueryParser, readonly vectors?:EdgeVectorIndex, readonly refresh:()=>void|Promise<void>=()=>{}) {}
  async query(scope:GraphScope, message:string, signal:AbortSignal, reference?:ReferenceTime):Promise<NetResult> {
    await this.refresh();
    const parsed=await this.parser.parse(message,signal);
    if(parsed.status!=="ok")return {status:"fallback"};
    return {status:"ok",net:await this.build(scope,parsed.plan,signal,reference)};
  }
  async validateNet(scope:GraphScope, net:MemoryNet, signal:AbortSignal):Promise<NetResult> {
    const issued=this.issued.get(net);
    if(!issued || issued.scope!==JSON.stringify(scope))return {status:"rejected",reason:"unauthorized"};
    // Rebuild from the private plan, never accept claim text, refs or scope supplied by a caller.
    return {status:"ok",net:await this.build(scope,issued.plan,signal,issued.reference)};
  }
  private async build(scope:GraphScope, plan:MemoryQueryPlan, signal:AbortSignal, reference?:ReferenceTime):Promise<MemoryNet> {
    const net:MemoryNet={query:structuredClone(plan),temporal:resolveQueryTime(plan.temporal,reference),subjects:[],wikiSections:[],edges:[],events:[],provenance:[],partial:false,warnings:[]};
    for(const visibility of ["bot_private","project_shared"] as const){
      signal.throwIfAborted();
      const ns:Namespace={principal:scope.principal,projectId:scope.projectId,botId:scope.botId,visibility};
      if(!await this.store.enabled(ns))continue;
      const {subjects,scores,querySeeds,narrativeIds}=await this.seeds(ns,plan,signal,reference);
      const ranked=[...scores].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,16);
      if(scores.size>16){net.partial=true;net.warnings.push("seed_limit");}
      const reads=new Map<string,ReadEdge>(),visited=new Set<string>();
      const add=async(id:string)=>{signal.throwIfAborted();if(visited.has(id))return;if(visited.size>=256)throw new Error("Expansion budget");visited.add(id);const row=await this.store.read(ns,id);if(row)reads.set(id,row);};
      for(const [id] of ranked)await add(id);
      for(const [id] of ranked){const row=reads.get(id);if(row)for(const sibling of await this.store.related(ns,row.edge))await add(sibling);}
      await this.refresh();
      // All remote embedding awaits have finished: refresh every contributing edge/subject before assembly.
      for(const id of reads.keys()){const fresh=await this.store.read(ns,id);if(fresh)reads.set(id,fresh);else reads.delete(id);}
      const anchors=(ref?:string)=>ref ? (narrativeIds.get(ref) ?? []).flatMap(id=>reads.has(id)?[reads.get(id)!.edge]:[]):[];
      net.temporal=resolveQueryTime(plan.temporal,reference,anchors(plan.temporal.anchorRef));
      const selected=this.select(plan,net.temporal,reads,narrativeIds,reference);
      const seeds=new Set(ranked.map(([id])=>id));
      for(const row of selected.sort((a,b)=>(scores.get(b.edge.edgeId) ?? 0)-(scores.get(a.edge.edgeId) ?? 0)))addNetEdge(net,ns,reads.get(row.edge.edgeId)!,row,scores.get(row.edge.edgeId) ?? 0,seeds.has(row.edge.edgeId) ? querySeeds.get(row.edge.edgeId) ?? ["subject"]:[]);
      for(const subject of subjects.values()){
        if(!await this.store.subject(ns,subject.subjectId))continue;
        if(!net.subjects.some(s=>namespaceKey(s.namespace)===namespaceKey(ns)&&s.subjectId===subject.subjectId))net.subjects.push({...subject,namespace:ns});
      }
      await this.sections(net,ns,signal);
    }
    signal.throwIfAborted();
    pruneNet(net);await this.revalidate(net,signal);pruneNet(net);this.issued.set(net,{scope:JSON.stringify(scope),plan:structuredClone(plan),reference});return net;
  }
  private select(plan:MemoryQueryPlan,time:MemoryNet["temporal"],reads:Map<string,ReadEdge>,ids:Map<string,string[]>,reference?:ReferenceTime) {
    const edges=[...reads.values()].map(r=>r.edge);
    if(!plan.narratives.length)return queryTemporalView(edges,time);
    const selected=new Map<string,ReturnType<typeof queryTemporalView>[number]>();
    for(const narrative of plan.narratives){
      const seeds=edges.filter(e=>ids.get(narrative.ref)?.includes(e.edgeId));
      const related=edges.filter(e=>seeds.some(s=>s.edgeId===e.edgeId || (s.factKind==="state" ? s.stateSlotKey===e.stateSlotKey : !!s.eventId && s.eventId===e.eventId)));
      const anchors=edges.filter(e=>ids.get(narrative.time.anchorRef ?? "")?.includes(e.edgeId));
      const resolved=narrative.time.kind==="unspecified"?time:resolveQueryTime(narrative.time,reference,anchors);
      for(const row of queryTemporalView(related,resolved))selected.set(row.edge.edgeId,row);
    }
    return [...selected.values()];
  }
  private async revalidate(net:MemoryNet,signal:AbortSignal) {
    await this.refresh();
    const edges:MemoryNet["edges"]=[];
    for(const edge of net.edges){
      signal.throwIfAborted();
      const row=await this.store.read(edge.namespace,edge.edgeId);
      if(!row)continue;
      const {namespace,evidenceRefs,view:_,seedScore:__,role:___,querySeeds:____,...claim}=edge;
      const {evidence,...fresh}=row.edge;
      const refs=evidence.map(e=>digest(JSON.stringify([namespaceKey(namespace),e])));
      if(JSON.stringify(claim)===JSON.stringify(fresh) && JSON.stringify(refs)===JSON.stringify(evidenceRefs))edges.push(edge);
    }
    net.edges=edges;
    const sections:MemoryNet["wikiSections"]=[];
    for(const section of net.wikiSections){
      signal.throwIfAborted();
      const ns=section.namespace;
      const sources=net.provenance.filter(p=>section.evidenceRefs.includes(p.ref));
      if(sources.every(p=>this.store.retained(ns,p.source.botId)) && this.store.retained(ns,ns.botId) && await this.store.wiki.validateRead(ns,section.revision,true))sections.push(section);
    }
    net.wikiSections=sections;
    const subjects:MemoryNet["subjects"]=[];
    for(const subject of net.subjects){
      const fresh=await this.store.subject(subject.namespace,subject.subjectId);
      if(fresh)subjects.push({...fresh,namespace:subject.namespace});
    }
    net.subjects=subjects;
  }
  private async seeds(ns:Namespace,plan:MemoryQueryPlan,signal:AbortSignal,reference?:ReferenceTime) {
      const subjects=new Map<string,NonNullable<Awaited<ReturnType<V2RetrievalStore["subject"]>>>>();
      for(const q of plan.subjects)for(const candidate of await this.store.subjects(ns,q.name)){
        const subject=await this.store.subject(ns,candidate.subjectId);if(subject)subjects.set(subject.subjectId,subject);
        if(subjects.size>64)throw new Error("Subject budget");
      }
      const scores=new Map<string,number>(), querySeeds=new Map<string,string[]>(), narrativeIds=new Map<string,string[]>();
      for(const narrative of plan.narratives){
        const time=resolveQueryTime(narrative.time,reference);
        const text=queryEmbeddingTextV3(narrative.text,time);
        const lexical=await this.store.lexical(ns,terms(narrative.text));
        const vector=await this.vectors?.search(ns,text,signal) ?? [];
        const lists=[lexical,vector.map(v=>v.id)];
        for(const list of lists)list.forEach((id,i)=>{scores.set(id,(scores.get(id) ?? 0)+1/(61+i));querySeeds.set(id,[...new Set([...querySeeds.get(id) ?? [],narrative.ref])]);});
        narrativeIds.set(narrative.ref,[...new Set(lists.flat())].slice(0,32));
      }
      const identityIds=await this.store.candidates(ns,[],[...subjects.keys()]);
      for(const id of identityIds)if(!plan.narratives.length || scores.has(id))scores.set(id,(scores.get(id) ?? 0)+1/120);
      return {subjects,scores,querySeeds,narrativeIds};
  }
  private async sections(net:MemoryNet, ns:Namespace, signal:AbortSignal){
    const pages=[...new Set(net.subjects.filter(s=>namespaceKey(s.namespace)===namespaceKey(ns)).map(s=>s.wikiPageId))];
    const names=net.subjects.filter(s=>namespaceKey(s.namespace)===namespaceKey(ns)).map(s=>s.canonicalName).sort((a,b)=>b.length-a.length);
    const semantic=(text:string)=>names.reduce((value,name)=>value.replaceAll(name," "),text);
    const tokens=terms([...net.query.narratives.map(n=>n.text),...net.edges.filter(e=>namespaceKey(e.namespace)===namespaceKey(ns)).map(e=>semantic(e.description))].join(" "));
    const relevant=(text:string)=>{
      const content=text.split("\n").filter(line=>line.startsWith("- ") && !names.includes(line.slice(2))).join(" ");
      return !!content && (!net.query.narratives.length || tokens.some(t=>content.normalize("NFKC").toLowerCase().includes(t)));
    };
    if(pages.length>16){net.partial=true;net.warnings.push("wiki_page_limit");}
    for(const pageId of pages.slice(0,16)){
      signal.throwIfAborted();
      const active=await this.wiki.storage.activePage(namespaceKey(ns),pageId);
      if(!active || !await this.store.wiki.validateRead(ns,active.revision,true))continue;
      const sections=active.page.sections.filter(relevant);
      if(sections.length>4){net.partial=true;net.warnings.push("wiki_section_limit");}
      for(const text of sections.slice(0,4)){
        if(net.wikiSections.length>=16){net.partial=true;net.warnings.push("wiki_limit");return;}
        if(/^# [^\n]+$/.test(text.trim()) || !text.includes("- "))continue;
        const evidenceRefs:string[]=[];
        for(const source of active.page.sources){
          // Wiki validation checks active version; additionally apply V2 owning-Bot policy.
          if(!this.store.retained(ns,source.botId) || !this.store.retained(ns,ns.botId) || (ns.visibility==="bot_private" && source.botId!==ns.botId))continue;
          const ref=digest(JSON.stringify([namespaceKey(ns),active.revision,source]));evidenceRefs.push(ref);
          if(!net.provenance.some(p=>p.ref===ref))net.provenance.push({ref,namespace:ns,source});
        }
        if(evidenceRefs.length!==active.page.sources.length)continue;
        net.wikiSections.push({pageId,sectionKey:digest(text),revision:active.revision,text,namespace:ns,evidenceRefs});
      }
    }
  }
}
