import type { Namespace } from "./types";
import type { V2RetrievalStore } from "./v2-retrieval-store";
export class SubjectRetriever {
  constructor(readonly store: V2RetrievalStore) {}
  resolve(ns: Namespace, text: string) { return this.store.subjects(ns, text); }
}
