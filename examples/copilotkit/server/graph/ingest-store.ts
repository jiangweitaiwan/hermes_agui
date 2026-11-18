import type { Awaitable } from "./browser-store";
import type { Job, RawSource } from "./ingest-queue";
import type { SourceOrigin } from "./source-store";
import type { Namespace, Page } from "./types";

export interface IngestOrigin extends SourceOrigin { knowledgeHash?: string }
export interface Publication { markdown: string; expectedRevision: string | null }
/** No driver or transaction callback escapes to the compiler. Publication includes job completion. */
export interface IngestStore {
  enqueue(ns: Namespace, value: unknown, origin?: IngestOrigin): Awaitable<string>;
  status(ns: Namespace, id: string): Awaitable<Job>;
  claim(ns: Namespace, now?: number, leaseMs?: number, jobId?: string | null): Awaitable<Job | undefined>;
  heartbeat(job: Job, now?: number, leaseMs?: number): Awaitable<void>;
  source(job: Job): Awaitable<RawSource>;
  current(ns: Namespace, page: string): Awaitable<{ page: Page; revision: string } | undefined>;
  candidates(ns: Namespace, query: string): Awaitable<{ id: string; title: string; body: string }[]>;
  publish(ns: Namespace, job: Job, inputs: Publication[], check: () => void): Awaitable<void>;
  fail(job: Job): Awaitable<void>;
  cancelClaim(job: Job): Awaitable<void>;
  latestSource(ns: Namespace, source: string): Awaitable<RawSource>;
}
