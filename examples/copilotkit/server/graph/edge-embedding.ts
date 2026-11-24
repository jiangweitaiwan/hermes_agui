import { digest, namespaceKey } from "./wiki-store";
import { terms } from "./markdown";
import { boundedEmbedding, validVector, type Encoder } from "./embedding";
import { decode, type V2RetrievalStore } from "./v2-retrieval-store";
import { type FactEdge } from "./v2-types";
import type { Namespace } from "./types";
export function edgeEmbeddingText(edge: FactEdge) {
  // Subject IDs are stable and names remain in the evidence-backed description.
  return JSON.stringify({relation:edge.relation,description:edge.description,from:edge.fromSubjectId,to:edge.toSubjectId,time:{
    occurredFrom:edge.time.occurredFrom,occurredTo:edge.time.occurredTo,timePrecision:edge.time.timePrecision,
    originalTimeText:edge.time.originalTimeText,timezone:edge.time.timezone,anchor:edge.time.anchor,confidence:edge.time.confidence}});
}
export function queryEmbeddingTextV3(description:string,time:{from?:string;to?:string;timezone?:string;originalText?:string}) {
  return [`Narrative: ${description}`,time.from ? `Occurred: ${time.from}${time.to ? ` / ${time.to}`:""}`:"",time.timezone ? `Timezone: ${time.timezone}`:"",time.originalText ? `Time expression: ${time.originalText}`:""].filter(Boolean).join("\n");
}
export function edgeEmbeddingTextV3(edge:FactEdge,names:string[]) {
  return [queryEmbeddingTextV3(edge.description,{from:edge.time.occurredFrom,to:edge.time.occurredTo,timezone:edge.time.timezone,originalText:edge.time.originalTimeText}),`Subjects: ${names.join("; ")}`,edge.relationLabel ? `Relation background: ${edge.relationLabel}`:""].filter(Boolean).join("\n");
}
export class EdgeVectorIndex {
  readonly key: string;
  readonly metrics = {indexed:0,failures:0,queries:0,lexical:0};
  constructor(readonly store: V2RetrievalStore, readonly encoder: Encoder, readonly template: "v2" | "v3" = "v2") {
    this.key = encoder.fingerprint ? JSON.stringify([encoder.fingerprint,template === "v3" ? "edge-narrative-v3":"edge-v2"]) : JSON.stringify([encoder.model,encoder.dimension,encoder.version,...(template === "v3" ? ["edge-narrative-v3"]:[])]);
  }
  async update(ns: Namespace, signal: AbortSignal) {
    signal.throwIfAborted();
    const key = namespaceKey(ns);
    const rows = await this.store.connection(db => db.rows(`SELECT f.edge_id,f.data FROM graph_fact_edges f
      LEFT JOIN graph_edge_embeddings v ON v.ns=f.ns AND v.edge_id=f.edge_id AND v.model=$1
      WHERE f.ns=$2 AND v.edge_id IS NULL AND EXISTS (SELECT 1 FROM graph_edge_evidence e JOIN document_sources d
      ON d.ns=e.ns AND d.id=e.source_id AND d.version=e.source_version WHERE e.ns=f.ns AND e.edge_id=f.edge_id AND NOT d.deleted)
      ORDER BY f.edge_id LIMIT 32`,[this.key,key]));
    if (!rows.length) return;
    const edges: FactEdge[] = [];
    for (const row of rows) { const read = await this.store.read(ns,String(row.edge_id)); if (read) edges.push(read.edge); }
    if (!edges.length) return;
    const texts = await Promise.all(edges.map(edge=>this.text(ns,edge)));
    try {
      const vectors = await boundedEmbedding(this.encoder,texts,signal);
      if (vectors.length !== edges.length || vectors.some(v => !validVector(v,this.encoder.dimension))) throw new Error("Invalid edge vectors");
      for (let i=0;i<edges.length;i++) {
        signal.throwIfAborted();
        // Recheck source validity after the remote encoder; revoked edges never receive an index row.
        if (!await this.store.read(ns,edges[i].edgeId)) continue;
        await this.store.connection(db => db.rows(`INSERT INTO graph_edge_embeddings (ns,edge_id,model,dimension,vector,content_hash,indexed_at)
          SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS (SELECT 1 FROM graph_edge_evidence e JOIN document_sources d
          ON d.ns=e.ns AND d.id=e.source_id AND d.version=e.source_version WHERE e.ns=$8 AND e.edge_id=$9 AND NOT d.deleted)
          ON CONFLICT (ns,edge_id,model) DO UPDATE SET vector=excluded.vector,dimension=excluded.dimension,content_hash=excluded.content_hash,indexed_at=excluded.indexed_at`,
          [key,edges[i].edgeId,this.key,this.encoder.dimension,JSON.stringify(vectors[i]),digest(texts[i]),new Date().toISOString(),key,edges[i].edgeId]));
        this.metrics.indexed++;
      }
    } catch { this.metrics.failures++; signal.throwIfAborted(); }
  }
  async encode(text:string,signal:AbortSignal):Promise<number[]> {
    try {
      const vectors=await boundedEmbedding(this.encoder,[text],signal);
      return validVector(vectors[0],this.encoder.dimension) ? vectors[0] : [];
    } catch { this.metrics.failures++;signal.throwIfAborted();return []; }
  }
  async search(ns: Namespace,text: string,signal: AbortSignal,prepared?:number[]) {
    this.metrics.queries++;
    try {
      const query=prepared ?? await this.encode(text,signal);
      if (!validVector(query,this.encoder.dimension)) return [];
      const rows = await this.store.connection(db => db.rows(`SELECT v.*,f.data FROM graph_edge_embeddings v JOIN graph_fact_edges f ON f.ns=v.ns AND f.edge_id=v.edge_id
        WHERE v.ns=$1 AND v.model=$2 AND v.dimension=$3 ORDER BY v.edge_id LIMIT 4097`,[namespaceKey(ns),this.key,this.encoder.dimension]));
      if (rows.length > 4096) throw new Error("Edge vector scan budget exceeded");
      const matches: {id:string;score:number}[] = [];
      for (const row of rows) {
        const edge = decode(row.data), vector = decode(row.vector);
        if (digest(await this.text(ns,edge)) !== row.content_hash || !validVector(vector,this.encoder.dimension)) continue;
        const norm = (v:number[]) => Math.sqrt(v.reduce((s,n)=>s+n*n,0));
        const score = vector.reduce((s,n,i)=>s+n*query[i],0)/(norm(vector)*norm(query));
        if(score>0)matches.push({id:String(row.edge_id),score});
      }
      return matches.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)).slice(0,32);
    } catch { this.metrics.failures++; signal.throwIfAborted(); return []; }
  }
  private async text(ns:Namespace,edge:FactEdge) {
    if(this.template === "v2")return edgeEmbeddingText(edge);
    const from=await this.store.subject(ns,edge.fromSubjectId),to=await this.store.subject(ns,edge.toSubjectId);
    return edgeEmbeddingTextV3(edge,[from?.canonicalName ?? "",to?.canonicalName ?? ""]);
  }
  async rebuild(ns: Namespace) {
    await this.store.connection(db => db.rows("DELETE FROM graph_edge_embeddings WHERE ns=$1 AND model=$2",[namespaceKey(ns),this.key]));
  }
}
/** Bounded backfill for Part 1 facts; safe to repeat after restart, independent of embedding availability. */
export async function backfillEdgeLexical(store: V2RetrievalStore, ns: Namespace) {
  return store.connection(async db => {
    const rows = await db.rows(`SELECT f.edge_id,f.data FROM graph_fact_edges f WHERE f.ns=$1 AND NOT EXISTS
      (SELECT 1 FROM graph_fact_tokens t WHERE t.ns=f.ns AND t.edge_id=f.edge_id) ORDER BY f.edge_id LIMIT 32`,[namespaceKey(ns)]);
    for (const row of rows) for (const token of terms(`${decode(row.data).description} ${decode(row.data).relation}`))
      await db.rows("INSERT INTO graph_fact_tokens VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",[namespaceKey(ns),row.edge_id,token]);
    return rows.length;
  });
}
