import type { Namespace, Page } from "./types";
import type { Provenance } from "./provenance";

export type Awaitable<T> = T | Promise<T>;
export interface BrowserRevision { ns: string; page: string; revision: string }
export interface BrowserJob { id: string; state: string; created: number | null; source: string; ns: string; owners: string[] }
/** Bounded reads shared by the local and external storage adapters. */
export interface BrowserStore<R extends BrowserRevision = BrowserRevision> {
  validateRead(ns: Namespace, revision: string, activeRequester?: boolean): Awaitable<boolean>;
  active(ns: string, page: string): Awaitable<R | undefined>;
  read(row: R): Awaitable<Page>;
  pageBytes(row: R): Awaitable<number>;
  sourceValid(ns: string, source: Provenance): Awaitable<boolean>;
  matchesTokens(ns: string, page: string, tokens: string[]): Awaitable<boolean>;
  pageIds(ns: string, prefix: string, after: string, tokens: string[], limit: number): Awaitable<string[]>;
  edgeCount(ns: string, pages: string[]): Awaitable<number>;
  linkedPages(ns: string, page: string, incoming: boolean, limit: number): Awaitable<string[]>;
  sectionIndex(ns: string, page: string): Awaitable<{ content: string; tokens: string }[]>;
  browserJobs(ns: string): Awaitable<BrowserJob[]>;
}
