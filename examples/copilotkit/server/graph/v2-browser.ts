import type { Namespace } from "./types";
import type { BrowserQuery } from "./browser-query";
import { pagination } from "./browser-query";
import type { V2RetrievalStore, ReadEdge } from "./v2-retrieval-store";
import { edgeDisplay, publicSubject } from "./edge-retriever";
import { temporalView, type TemporalRow } from "./temporal-view";
import { terms } from "./markdown";
import { BotError } from "../bots/types";
import type { FactsResult } from "./browser-types";
interface Window {
  rows:FactsResult["edges"]; subjects:Map<string,FactsResult["subjects"][number]>;
  last:string; scanned:number; partial:boolean;
}
export class V2Browser {
  private subjectReads: {ns:Namespace;id:string;snapshot:string}[] = [];
  private reads: {ns:Namespace;id:string;snapshot:string}[] = [];
  constructor(readonly store:V2RetrievalStore,readonly namespaces:Namespace[],readonly query:BrowserQuery,
    readonly retained:(ns:Namespace,bot:string)=>boolean) {}
  async revalidate() {
    for (const row of this.subjectReads) {
      const subject=await this.store.subject(row.ns,row.id);
      if (!subject || JSON.stringify(subject)!==row.snapshot) throw new BotError(503,"Subject evidence changed");
    }
    for (const row of this.reads) {
      if (!this.retained(row.ns,row.ns.botId)) throw new BotError(404,"Memory access changed");
      const current=await this.store.read(row.ns,row.id);
      if (!current || current.sources.some(s=>!this.retained(row.ns,s.botId)) || JSON.stringify(current)!==row.snapshot)
        throw new BotError(503,"Fact evidence or authorization changed");
    }
  }
  async list(binding:string):Promise<FactsResult> {
    const cursor=pagination(this.query,binding);
    const window:Window={rows:[],subjects:new Map(),last:cursor.after,scanned:0,partial:false};
    for (const ns of this.namespaces.slice().sort((a,b)=>a.visibility.localeCompare(b.visibility))) {
      if (cursor.after && ns.visibility<cursor.after.split(":")[0]) continue;
      if (!await this.store.enabled(ns)) continue;
      if (!this.retained(ns,ns.botId)) throw new BotError(404,"Unknown Bot");
      await this.scan(ns,cursor.after,window);
    }
    return {subjects:[...window.subjects.values()],edges:window.rows,
      nextCursor:window.partial && window.last!==cursor.after ? cursor.encode(window.last):null,partial:window.partial};
  }
  private async candidateIds(ns:Namespace,after:string,window:Window) {
    const matched=await this.store.subjects(ns,this.query.q ?? "",this.query.pageId);
    if (this.query.pageId) for (const candidate of matched) {
      const subject=await this.store.subject(ns,candidate.subjectId);
      if (!subject) continue;
      this.subjectReads.push({ns,id:subject.subjectId,snapshot:JSON.stringify(subject)});
      window.subjects.set(`${ns.visibility}:${subject.subjectId}`,{...publicSubject(subject),visibility:ns.visibility});
    }
    if (this.query.edgeId) return [this.query.edgeId];
    if (this.query.eventId) return this.store.related(ns,{factKind:"event",eventId:this.query.eventId});
    const nsAfter=after.startsWith(`${ns.visibility}:`) ? after.slice(ns.visibility.length+1):"";
    return this.store.candidates(ns,this.query.q ? terms(this.query.q):[],
      this.query.subjectId ? [this.query.subjectId]:matched.map(s=>s.subjectId),nsAfter,301,
      !this.query.q && !this.query.subjectId && !this.query.pageId);
  }
  private async expand(ns:Namespace,ids:string[]) {
    const reads=new Map<string,ReadEdge>(),visited=new Set<string>();
    const add=async(id:string)=>{
      if (visited.has(id)) return;
      if (visited.size>=512) throw new BotError(503,"Fact browser scan budget exceeded");
      visited.add(id);
      const row=await this.store.read(ns,id);
      if (!row || row.sources.some(s=>!this.retained(ns,s.botId))) return;
      reads.set(id,row);this.reads.push({ns,id,snapshot:JSON.stringify(row)});
    };
    for (const id of ids.slice(0,300)) {
      await add(id);const row=reads.get(id);
      if (row?.edge.factKind === "state") for (const sibling of await this.store.related(ns,row.edge)) await add(sibling);
    }
    return reads;
  }
  private async scan(ns:Namespace,after:string,window:Window) {
    const ids=await this.candidateIds(ns,after,window),reads=await this.expand(ns,ids);
    if (ids.length>300) window.partial=true;
    const selected=new Map(temporalView([...reads.values()].map(r=>r.edge),{mode:this.query.view}).map(row=>[row.edge.edgeId,row]));
    // The cursor follows scanned candidates, never an expanded sibling beyond this window.
    for (const id of ids.slice(0,300)) {
      const key=`${ns.visibility}:${id}`;
      if (Buffer.compare(Buffer.from(key),Buffer.from(after))<=0) continue;
      if (window.scanned>=300 || window.rows.length>=this.query.limit) { window.partial=true;break; }
      window.scanned++;window.last=key;
      const item=selected.get(id);
      if (!item) continue;
      this.append(ns,reads.get(id)!,item,window);
    }
  }
  private append(ns:Namespace,row:ReadEdge,item:TemporalRow,window:Window) {
    for (const subject of [row.from,row.to].filter(s=>!this.query.pageId || s.wikiPageId===this.query.pageId))
      window.subjects.set(`${ns.visibility}:${subject.subjectId}`,{...publicSubject(subject),visibility:ns.visibility});
    const start=this.query.evidenceStart;
    window.rows.push({...edgeDisplay(row,item),visibility:ns.visibility,evidence:row.edge.evidence.slice(start,start+4),
      evidenceStart:start,evidenceTotal:row.edge.evidence.length,provenance:row.sources.slice(start,start+20),provenanceTotal:row.sources.length,
      changes:item.changes.map(e=>({edgeId:e.edgeId,description:e.description,time:e.time}))});
  }
}
