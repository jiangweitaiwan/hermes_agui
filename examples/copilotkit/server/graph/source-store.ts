import type { Namespace } from "./types";
import type { Provenance } from "./provenance";
import type { RawSource } from "./ingest-queue";

export interface SourceInput { sourceId?: string; title: string; content: string }
export interface SourceOrigin { provenance: Provenance; classification: string; evidence?: RawSource["evidence"] }
/** Source versions reference immutable objects. Implementations serialize writes with Wiki publication. */
export interface SourceStore {
  put(namespace: Namespace, input: SourceInput, origin?: SourceOrigin): Promise<RawSource>;
  get(namespace: Namespace, source: string, version?: number): Promise<RawSource>;
  revoke(namespace: Namespace, source: string): Promise<void>;
}
