import { z } from "zod";
import { namespaceKey, WikiStore } from "./wiki-store";
import type { Namespace } from "./types";

export const EmbeddingConfig = z.object({ baseUrl: z.string().url(), model: z.string().min(1), keyEnv: z.string().min(1),
  dimension: z.number().int().min(1).max(4096), version: z.string().min(1).max(100),
  timeoutMs: z.number().int().min(1).max(1000).default(500), retries: z.number().int().min(0).max(2).default(1),
}).strict();
export interface Encoder {
  model: string; dimension: number; version: string; readonly fingerprint?: string;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}
export function validVector(value: unknown, dimension: number): value is number[] {
  return Array.isArray(value) && value.length === dimension && value.every(n => typeof n === "number" && Number.isFinite(n)) && value.some(n => n !== 0);
}
export class OpenAIEncoder implements Encoder {
  readonly options: z.infer<typeof EmbeddingConfig>;
  readonly model: string; readonly dimension: number; readonly version: string;
  constructor(options: unknown, readonly transport: typeof fetch = fetch) {
    this.options = EmbeddingConfig.parse(options);
    const url = new URL(this.options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid embedding URL");
    this.model = this.options.model; this.dimension = this.options.dimension; this.version = this.options.version;
  }
  async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
    if (!process.env[this.options.keyEnv]) throw new Error("Embedding key required");
    if (!texts.length || texts.length > 32 || texts.some(t => Buffer.byteLength(t) > 16384)) throw new Error("Embedding batch limit");
    const response = await this.transport(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env[this.options.keyEnv] ?? ""}` },
      body: JSON.stringify({ model: this.model, dimensions: this.dimension, input: texts }),
    });
    if (!response.ok || !response.body) throw new Error("Embedding unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 4194304) throw new Error("Embedding response limit");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.model !== this.model || !Array.isArray(body.data) || body.data.length !== texts.length) throw new Error("Embedding model mismatch");
    const data = body.data.sort((a: any, b: any) => a.index - b.index);
    if (data.some((v: any, i: number) => v.index !== i || !validVector(v.embedding, this.dimension))) throw new Error("Invalid embedding vector");
    return data.map((v: any) => v.embedding);
  }
}
export interface VectorSection { ns: string; page: string; ordinal: number; content: string; revision: string; score: number }
export interface EmbeddingSection { ns: string; page: string; ordinal: number; content: string; revision: string }
export interface EmbeddingStore {
  unindexedSections(ns: string, model: string): Promise<EmbeddingSection[]>;
  indexEmbeddings(model: string, sections: EmbeddingSection[], vectors: number[][]): Promise<number>;
  indexedEmbeddings(ns: string, model: string): Promise<(EmbeddingSection & { vector: string })[]>;
  clearEmbeddings(ns: string): Promise<void> | void;
}

class LocalEmbeddingStore implements EmbeddingStore {
  constructor(readonly store: WikiStore) {}
  async unindexedSections(ns: string, model: string) {
    return this.store.db.prepare(`SELECT s.ns,s.page,s.ordinal,s.content,p.revision FROM sections s
      JOIN pages p ON p.ns=s.ns AND p.page=s.page LEFT JOIN embeddings e ON e.ns=s.ns AND e.page=s.page
      AND e.ordinal=CAST(s.ordinal AS INTEGER) AND e.model=? AND e.revision=p.revision
      WHERE s.ns=? AND e.revision IS NULL ORDER BY s.page,CAST(s.ordinal AS INTEGER) LIMIT 32`).all(model, ns) as unknown as EmbeddingSection[];
  }
  async indexEmbeddings(model: string, sections: EmbeddingSection[], vectors: number[][]) {
    return this.store.transaction(() => {
      let indexed = 0;
      sections.forEach((row, i) => {
        if (this.store.active(row.ns, row.page)?.revision !== row.revision) return;
        this.store.db.prepare("INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?,?,?)")
          .run(row.ns, row.page, Number(row.ordinal), row.revision, model, JSON.stringify(vectors[i]));
        indexed++;
      });
      return indexed;
    });
  }
  async indexedEmbeddings(ns: string, model: string) {
    return this.store.db.prepare(`SELECT e.*,s.content FROM embeddings e
      JOIN pages p ON p.ns=e.ns AND p.page=e.page AND p.revision=e.revision
      JOIN sections s ON s.ns=e.ns AND s.page=e.page AND CAST(s.ordinal AS INTEGER)=e.ordinal
      WHERE e.ns=? AND e.model=? ORDER BY e.page,e.ordinal LIMIT 4096`).all(ns, model) as unknown as
      (EmbeddingSection & { vector: string })[];
  }
  clearEmbeddings(ns: string) { this.store.db.prepare("DELETE FROM embeddings WHERE ns=?").run(ns); }
}
export class VectorIndex {
  readonly key: string;
  readonly metrics = { indexed: 0, failures: 0, queries: 0 };
  readonly storage: EmbeddingStore;
  constructor(store: WikiStore | EmbeddingStore, readonly encoder: Encoder, readonly retries = 1) {
    this.storage = store instanceof WikiStore ? new LocalEmbeddingStore(store) : store;
    this.key = encoder.fingerprint ? JSON.stringify([encoder.fingerprint,"wiki-sections-v1"]) : JSON.stringify([encoder.model, encoder.dimension, encoder.version]);
  }
  async update(ns: Namespace, signal: AbortSignal) {
    const rows = await this.storage.unindexedSections(namespaceKey(ns), this.key);
    if (!rows.length) return;
    let vectors: number[][] | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try { vectors = await this.encoder.embed(rows.map(r => String(r.content)), signal); break; }
      catch { signal.throwIfAborted(); this.metrics.failures++; }
    }
    if (!vectors || vectors.length !== rows.length || vectors.some(v => !validVector(v, this.encoder.dimension))) return;
    this.metrics.indexed += await this.storage.indexEmbeddings(this.key, rows, vectors);
  }
  async search(namespaces: string[], text: string, signal: AbortSignal): Promise<VectorSection[]> {
    this.metrics.queries++;
    try {
      const vectors = await boundedEmbedding(this.encoder, [text], signal);
      if (vectors.length !== 1 || !validVector(vectors[0], this.encoder.dimension)) return [];
      const rows = (await Promise.all(namespaces.map(ns => this.storage.indexedEmbeddings(ns, this.key)))).flat();
      return rows.flatMap(row => {
        const vector = JSON.parse(row.vector);
        if (!validVector(vector, this.encoder.dimension)) return [];
        const score = cosine(vectors[0], vector);
        const { ns, page, ordinal, content, revision } = row;
        return score > 0 ? [{ ns, page, ordinal: Number(ordinal), content, revision, score }] : [];
      }).sort((a, b) => b.score - a.score || a.page.localeCompare(b.page));
    } catch { this.metrics.failures++; return []; }
  }
  rebuild(ns: Namespace) { return this.storage.clearEmbeddings(namespaceKey(ns)); }
}
function cosine(a: number[], b: number[]) {
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2; }
  return dot / Math.sqrt(left * right);
}

export async function boundedEmbedding(encoder: Encoder, texts: string[], signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(750)]);
  deadline.throwIfAborted();
  let listener = () => {};
  try {
    return await Promise.race([encoder.embed(texts, deadline), new Promise<never>((_, reject) => {
      listener = () => reject(new Error("Embedding deadline")); deadline.addEventListener("abort", listener, { once: true });
    })]);
  } finally { deadline.removeEventListener("abort", listener); }
}
