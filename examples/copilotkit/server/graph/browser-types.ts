import type { Visibility } from "../graph-memory";
import type { Page } from "./types";
import type { Provenance } from "./provenance";

/** IDs are local to the selected Bot response; never use them as authorization. */
export interface PageSummary {
  id: string; pageId: string; title: string; type: Page["type"];
  visibility: Visibility; verification: NonNullable<Page["verification"]>;
}
export interface PageList { pages: PageSummary[]; nextCursor: string | null; partial: boolean }
export interface SearchResult extends PageList { pages: (PageSummary & { snippet: string })[] }
export interface PageDetail extends PageSummary {
  revisionId: string; tags: string[]; body: string; related: PageSummary[]; provenance: Provenance[];
}
export interface NetworkResult {
  subjects?: FactsResult["subjects"]; factEdges?: FactsResult["edges"];
  nodes: PageSummary[]; edges: { source: string; target: string }[];
  nextCursor: string | null; truncated: boolean;
}
export interface StatsResult { pages: number; edges: number; private: number; shared: number; partial: boolean }
export interface HealthResult {
  facts?: {edges:number;subjects:number;events:number;partial:boolean;vectorEnabled:boolean};
  status: "ok"; pages: number; brokenLinks: number | null; isolated: number | null; conflicts: number;
  staleProvenance: number; indexDrift: number; pending: number; failed: number; lagMs: number; partial: boolean;
}
export interface JobSummary { id: string; state: "pending" | "running" | "completed" | "failed" | "cancelled"; createdAt?: number }
export interface JobsResult { status: "ok"; jobs: JobSummary[] }
export interface UnavailableResult { status: "unavailable" | "disabled"; error: string }

export interface FactsResult {
  subjects: (ReturnType<typeof import("./edge-retriever").publicSubject> & {visibility: Visibility})[];
  edges: (ReturnType<typeof import("./edge-retriever").edgeDisplay> & {
    visibility: Visibility; evidence: import("./v2-types").Evidence[]; evidenceStart:number; evidenceTotal:number;
    provenance:Provenance[]; provenanceTotal:number;
    changes:{edgeId:string;description:string;time:import("./v2-types").FactEdge["time"]}[];
  })[];
  nextCursor:string|null; partial:boolean;
}
