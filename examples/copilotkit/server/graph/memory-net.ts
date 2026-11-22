import type { Namespace } from "./types";
import type { Subject, FactEdge, Evidence } from "./v2-types";
import type { Provenance } from "./provenance";
import type { MemoryQueryPlan, QueryTime } from "./query-types";
export interface NetProvenance { ref:string; namespace:Namespace; source:Provenance; evidence?:Evidence }
export interface NetSubject extends Subject { namespace:Namespace }
export interface NetSection { pageId:string; sectionKey:string; revision:string; text:string; namespace:Namespace; evidenceRefs:string[] }
export interface NetEdge extends Omit<FactEdge,"evidence"> {
  namespace:Namespace; evidenceRefs:string[]; view:string; seedScore:number; role:"seed"|"supporting"; querySeeds:string[];
}
export interface MemoryNet {
  query:MemoryQueryPlan; temporal:QueryTime; subjects:NetSubject[]; wikiSections:NetSection[]; edges:NetEdge[];
  events:Array<{eventId:string; namespace:Namespace; edgeIds:string[]}>; provenance:NetProvenance[];
  partial:boolean; warnings:string[];
}
export type NetResult = {status:"ok";net:MemoryNet}|{status:"fallback"|"unavailable"|"disabled"}|{status:"rejected";reason:"unauthorized"|"invalid_request"};
