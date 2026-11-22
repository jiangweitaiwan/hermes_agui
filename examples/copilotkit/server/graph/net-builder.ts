import { digest, namespaceKey } from "./wiki-store";
import type { MemoryNet, NetProvenance } from "./memory-net";
import type { ReadEdge } from "./v2-retrieval-store";
import type { Namespace } from "./types";
import type { TemporalRow } from "./temporal-view";
export function addNetEdge(net:MemoryNet, ns:Namespace, row:ReadEdge, selected:TemporalRow, score:number, seeds:string[]) {
  const refs:string[]=[];
  row.edge.evidence.forEach((e,i)=>{
    const ref = digest(JSON.stringify([namespaceKey(ns),e])); refs.push(ref);
    const item:NetProvenance={ref,namespace:ns,source:row.sources[i],evidence:e};
    if (!net.provenance.some(p=>p.ref===ref)) net.provenance.push(item);
  });
  const {evidence:_,...edge}=row.edge;
  net.edges.push({...edge,namespace:ns,evidenceRefs:refs,view:selected.view,seedScore:score,role:seeds.length?"seed":"supporting",querySeeds:seeds});
  for (const subject of [row.from,row.to]) if (!net.subjects.some(s=>s.subjectId===subject.subjectId && namespaceKey(s.namespace)===namespaceKey(ns))) net.subjects.push({...subject,namespace:ns});
}
/** Whole claims are pruned; never truncate an evidence quote or leave dangling references. */
export function pruneNet(net:MemoryNet, maxBytes=65536):MemoryNet {
  const tidy=()=>{
    const used=new Set([...net.edges,...net.wikiSections].flatMap(e=>e.evidenceRefs));
    net.provenance=net.provenance.filter(p=>used.has(p.ref));
    net.subjects=net.subjects.filter(s=>net.edges.some(e=>namespaceKey(e.namespace)===namespaceKey(s.namespace) && [e.fromSubjectId,e.toSubjectId].includes(s.subjectId)) || net.wikiSections.some(w=>namespaceKey(w.namespace)===namespaceKey(s.namespace) && w.pageId===s.wikiPageId));
    const events=new Map<string,MemoryNet["events"][number]>();
    for (const e of net.edges) if(e.eventId){const key=JSON.stringify([namespaceKey(e.namespace),e.eventId]);const group=events.get(key) ?? {eventId:e.eventId,namespace:e.namespace,edgeIds:[]};group.edgeIds.push(e.edgeId);events.set(key,group);}
    net.events=[...events.values()];
  };
  const support=new Map<string,number>();
  net.edges=net.edges.filter(e=>{
    if(e.role!=="supporting" || !e.eventId || e.factKind==="state")return true;
    const key=JSON.stringify([namespaceKey(e.namespace),e.eventId]);
    const count=(support.get(key) ?? 0)+1;support.set(key,count);
    if(count<=8)return true;
    net.partial=true;if(!net.warnings.includes("event_support_limit"))net.warnings.push("event_support_limit");return false;
  });
  tidy();
  while ((Buffer.byteLength(JSON.stringify(net))>maxBytes || net.provenance.length>96 || net.edges.length>64 || net.subjects.length>64) && (net.edges.length || net.wikiSections.length)) {
    net.partial=true;
    if (!net.warnings.includes("net_budget")) net.warnings.push("net_budget");
    if(net.edges.length)net.edges.pop();else net.wikiSections.pop();tidy();
  }
  return net;
}
