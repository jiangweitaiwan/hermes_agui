import type { GraphHit, GraphQuery, GraphScope } from "../graph-memory";
import { terms } from "./markdown";
import type { Namespace } from "./types";
import { V2RetrievalStore, type ReadEdge } from "./v2-retrieval-store";
import { SubjectRetriever } from "./subject-retriever";
import { temporalIntent, temporalView, type TemporalRow } from "./temporal-view";
import type { EdgeVectorIndex } from "./edge-embedding";

export class EdgeRetriever {
  readonly subjects: SubjectRetriever;
  readonly metrics = {queries:0,candidates:0,hits:0,uncertain:0};
  constructor(readonly store: V2RetrievalStore, readonly vectors?: EdgeVectorIndex) { this.subjects = new SubjectRetriever(store); }
  async query(scope: GraphScope, query: GraphQuery, signal: AbortSignal): Promise<GraphHit[]> {
    this.metrics.queries++;
    const hits: GraphHit[] = [];
    const ranks=new Map<string,number>();
    let embedding:number[]|undefined;
    for (const visibility of ["bot_private","project_shared"] as const) {
      signal.throwIfAborted();
      const ns: Namespace = {principal:scope.principal,projectId:scope.projectId,botId:scope.botId,visibility};
      if (!await this.store.enabled(ns)) continue;
      const subjects = await this.subjects.resolve(ns,query.text);
      const ids = await this.store.candidates(ns,[],subjects.map(s=>s.subjectId));
      const lexical = await this.store.lexical(ns,terms(query.text));
      if (this.vectors && !embedding) embedding=await this.vectors.encode(query.text,signal);
      const vector = await this.vectors?.search(ns,query.text,signal,embedding) ?? [];
      // Reciprocal rank fusion; semantic recall cannot bypass the evidence read below.
      const scores = new Map<string,number>();
      for (const list of [ids,lexical,vector.map(v=>v.id)]) list.forEach((id,i)=>scores.set(id,(scores.get(id) ?? 0)+1/(60+i+1)));
      const ranked = [...scores].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,32).map(([id])=>id);
      const reads = await this.expand(ns,ranked,signal);
      this.metrics.candidates += reads.size;
      const intent = temporalIntent(query.text);
      const selectedRows = temporalView([...reads.values()].map(r=>r.edge),intent);
      if (intent.mode === "current") selectedRows.sort((a,b)=>(scores.get(b.edge.edgeId) ?? 0)-(scores.get(a.edge.edgeId) ?? 0));
      for (const selected of selectedRows) {
        const row = reads.get(selected.edge.edgeId)!;
        const hit=this.hit(scope,visibility,row,selected,reads,intent);
        hits.push(hit);ranks.set(`${visibility}:${hit.recordId}`,scores.get(selected.edge.edgeId) ?? 0);
        if (selected.view === "uncertain") this.metrics.uncertain++;

      }
    }
    this.order(hits,ranks,temporalIntent(query.text).mode);
    const result=hits.slice(0,query.limit);this.metrics.hits+=result.length;return result;
  }
  private order(hits:GraphHit[],ranks:Map<string,number>,mode:ReturnType<typeof temporalIntent>["mode"]) {
    if (mode === "history") hits.sort((a,b)=>
      (JSON.parse(a.content).time.occurredFrom ?? "9999").localeCompare(JSON.parse(b.content).time.occurredFrom ?? "9999") || a.recordId.localeCompare(b.recordId));
    else hits.sort((a,b)=>(ranks.get(`${b.visibility}:${b.recordId}`) ?? 0)-(ranks.get(`${a.visibility}:${a.recordId}`) ?? 0) || a.recordId.localeCompare(b.recordId));
  }
  private hit(scope:GraphScope,visibility:GraphHit["visibility"],row:ReadEdge,selected:TemporalRow,
    reads:Map<string,ReadEdge>,intent:ReturnType<typeof temporalIntent>):GraphHit {
    const changes=selected.changes.map(e=>reads.get(e.edgeId)!);
    const provenance=[...new Map([row,...changes].flatMap(r=>r.sources).map(s=>[JSON.stringify(s),s])).values()];
    const {fromSubject,toSubject,...display}=edgeDisplay(row,selected);
    const label=(s:ReturnType<typeof publicSubject>)=>({name:[...s.canonicalName].slice(0,160).join("")});
    // Every source is authorized; only the presentation window is bounded.
    const content=JSON.stringify({kind:"fact_edge",intent,...display,fromSubject:label(fromSubject),toSubject:label(toSubject),
      changes:changes.slice(0,2).map(r=>({edgeId:r.edge.edgeId,description:[...r.edge.description].slice(0,200).join(""),
        time:{occurredFrom:r.edge.time.occurredFrom,occurredTo:r.edge.time.occurredTo,timePrecision:r.edge.time.timePrecision}})),changeTotal:changes.length,
      evidence:row.edge.evidence.slice(0,1),evidenceWindow:{start:0,total:row.edge.evidence.length},provenanceTotal:provenance.length});
    if (Buffer.byteLength(content)>16384) throw new Error("Edge hit content budget exceeded");
    return {recordId:`fact:${row.edge.edgeId}:0`,content,visibility,principal:scope.principal,projectId:scope.projectId,
      source:provenance[0],sources:provenance.slice(0,20)};
  }
  private async expand(ns:Namespace,ranked:string[],signal:AbortSignal) {
    const reads = new Map<string,ReadEdge>(), visited = new Set<string>();
    const add = async (id:string) => {
      signal.throwIfAborted();
      if (visited.has(id)) return;
      if (visited.size >= 256) throw new Error("Edge retrieval work budget exceeded");
      visited.add(id);
      const row = await this.store.read(ns,id); if (row) reads.set(id,row);
    };
    for (const id of ranked) {
      await add(id); const row = reads.get(id);
      if (row) for (const sibling of await this.store.related(ns,row.edge)) await add(sibling);
    }
    return reads;
  }
  async validate(scope: GraphScope,hit: GraphHit) {
    const id = hit.recordId.split(":")[1], ns:Namespace={principal:scope.principal,projectId:scope.projectId,botId:scope.botId,visibility:hit.visibility};
    const row = await this.store.read(ns,id);
    if (!row) return false;
    // Rebuild the view after ACL refresh: prevents stale latest/change text when any contributing source is revoked.
    const payload = JSON.parse(hit.content);
    const group = [row.edge];
    for (const sibling of await this.store.related(ns,row.edge)) {
      if (sibling === id) continue;
      const read = await this.store.read(ns,sibling); if (read) group.push(read.edge);
    }
    const selected = temporalView(group,payload.intent).find(r=>r.edge.edgeId===id);
    if (!selected || selected.view !== payload.view || selected.changes.length !== payload.changeTotal) return false;
    for (const change of payload.changes ?? []) if (!await this.store.read(ns,change.edgeId)) return false;
    return JSON.stringify(row.edge.evidence.slice(payload.evidenceWindow.start,payload.evidenceWindow.start+1)) === JSON.stringify(payload.evidence);
  }
}
export function edgeDisplay(row: ReadEdge, selected: TemporalRow) {
  const {evidence:_,...edge}=row.edge;
  return {...edge,fromSubject:publicSubject(row.from),toSubject:publicSubject(row.to),view:selected.view,
    uncertainty:selected.view === "uncertain" ? "Unknown/overlapping effective time or conflicting claims; latest is not established" : undefined};
}

export function publicSubject(subject:ReadEdge["from"]) {
  const {subjectId,canonicalName,type,wikiPageId,parentSubjectId,sectionKey}=subject;
  return {subjectId,canonicalName,type,wikiPageId,parentSubjectId,sectionKey};
}
