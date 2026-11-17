import { z } from "zod";
import { WikiCompiler, OpenAICompilerLLM, type CompilerLLM } from "./compiler";
import { DocumentIngestor } from "./ingest-queue";
import { WikiGraphProvider } from "./provider";
import { SessionIngestor } from "./session-ingestor";
import { NamespaceSchema, type Namespace } from "./types";

export interface EvolutionOptions { provider: WikiGraphProvider; compiler: CompilerLLM; pollMs?: number }
export function loadEvolution(provider: unknown, config: unknown): EvolutionOptions | undefined {
  if (!config || (config as any).enabled === false) return undefined;
  const value = z.object({ enabled: z.literal(true), pollMs: z.number().int().min(100).max(60000).default(1000),
    compiler: z.object({ baseUrl: z.string().url(), model: z.string().min(1), keyEnv: z.string().min(1),
      timeoutMs: z.number().int().positive().max(120000).optional(), maxTokens: z.number().int().positive().max(8192).optional(),
    }).strict(),
  }).strict().parse(config);
  if (!(provider instanceof WikiGraphProvider)) return undefined; // unavailable store stays fail soft
  return { provider, compiler: new OpenAICompilerLLM(value.compiler), pollMs: value.pollMs };
}
export class MemoryEvolution {
  readonly queue: DocumentIngestor;
  readonly sessions: SessionIngestor;
  readonly worker: WikiCompiler;
  readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  readonly metrics = { ticks: 0, errors: 0, compiled: 0 };
  constructor(readonly options: EvolutionOptions, readonly authorized: (ns: Namespace) => boolean,
    readonly retained: (ns: Namespace, botId: string) => boolean) {
    if (!Number.isInteger(options.pollMs ?? 1000) || (options.pollMs ?? 1000) < 100) throw new Error("Invalid worker interval");
    this.queue = new DocumentIngestor(options.provider.store);
    this.sessions = new SessionIngestor(this.queue, authorized);
    this.worker = new WikiCompiler(this.queue, options.compiler);
    this.queue.store.transaction(() => this.backfillOwnership());
    options.provider.beforeQuery = () => this.reconcile();
  }
  private backfillOwnership() {
    const store = this.queue.store;
    store.backfillOwners();
    for (const row of store.db.prepare(`SELECT DISTINCT s.ns,s.id,n.metadata FROM document_sources s
      JOIN namespaces n ON n.id=s.ns WHERE NOT EXISTS (SELECT 1 FROM source_owners o WHERE o.ns=s.ns AND o.source=s.id)`).all()) {
      const ns = NamespaceSchema.parse(JSON.parse(String(row.metadata)));
      store.db.prepare("INSERT OR IGNORE INTO source_owners VALUES (?,?,?)").run(row.ns, row.id, ns.botId);
      for (const page of store.db.prepare("SELECT page FROM pages WHERE ns=?").all(row.ns)) {
        for (const source of store.read(store.active(String(row.ns), String(page.page))!).sources) {
          if ("kind" in source && source.sourceId === row.id) store.db.prepare("INSERT OR IGNORE INTO source_owners VALUES (?,?,?)").run(row.ns, row.id, source.botId);
        }
      }
    }
  }
  reconcile() {
    const store = this.queue.store;
    for (const row of store.db.prepare(`SELECT DISTINCT o.ns,o.source,o.bot,n.metadata FROM source_owners o
      JOIN namespaces n ON n.id=o.ns JOIN document_sources s ON s.ns=o.ns AND s.id=o.source WHERE s.deleted=0`).all()) {
      const ns = NamespaceSchema.parse(JSON.parse(String(row.metadata)));
      if (!this.retained(ns, String(row.bot))) this.queue.revoke(ns, String(row.source));
    }
    for (const row of store.db.prepare("SELECT o.*,n.metadata FROM page_owners o JOIN namespaces n ON n.id=o.ns").all()) {
      const ns = NamespaceSchema.parse(JSON.parse(String(row.metadata)));
      if (!this.retained(ns, String(row.bot))) store.transaction(() => this.queue.withdraw(String(row.ns), String(row.page)));
    }
  }
  start() {
    if (this.timer || this.running || this.controller.signal.aborted) return;
    this.schedule();
  }
  private schedule() {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().catch(() => { this.metrics.errors++; }).finally(() => {
        this.running = undefined;
        if (!this.controller.signal.aborted) this.schedule();
      });
    }, this.options.pollMs ?? 1000);
    this.timer.unref();
  }
  async tick() {
    this.metrics.ticks++; this.reconcile();
    const store = this.queue.store;
    const rows = store.db.prepare("SELECT metadata FROM namespaces ORDER BY id").all();
    for (const row of rows) {
      this.controller.signal.throwIfAborted();
      const ns = NamespaceSchema.parse(JSON.parse(String(row.metadata)));
      // Shared jobs are explicitly administrator-authorized. Session origins are checked above.
      if (!this.authorized(ns)) continue;
      const id = await this.worker.runNext(ns, this.controller.signal);
      if (id) {
        if (this.queue.status(ns, id).state === "completed") this.metrics.compiled++;
        else this.metrics.errors++;
      }
      await this.options.provider.retrieval?.vectors?.update(ns, this.controller.signal);
    }
  }
  async close() {
    clearTimeout(this.timer); this.controller.abort();
    await this.running;
    this.options.provider.beforeQuery = undefined;
  }
  /** Revoke source and every explicitly shared copy of its session provenance. */
  revoke(ns: Namespace, source: string) { this.queue.revokeCopies(ns, source); }
}
