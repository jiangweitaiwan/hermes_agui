import type { RunAgentInput } from "@ag-ui/core";
import type { RuntimeSettings } from "../runtime";
import { DocumentIngestor } from "./ingest-queue";
import { digest, namespaceKey } from "./wiki-store";
import type { Namespace } from "./types";

// Deliberately conservative: reject the entire source instead of persisting secrets around a mask.
export function sensitive(text: string) {
  return /(?:\b(?:sk-[a-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b|-----BEGIN .*PRIVATE KEY|(?:password|api[_ -]?key|authorization|密碼|金鑰)\s*[:=]\s*\S+|Bearer\s+\S+)/i.test(text);
}
export interface Completion {
  namespace: Namespace; threadId: string; runId: string; messageId: string;
  user: string; assistants: { id: string; text: string }[];
}
export class SessionIngestor {
  readonly metrics = { accepted: 0, skipped: 0, errors: 0, resumeSkipped: 0 };
  constructor(readonly queue: DocumentIngestor, readonly authorized: (ns: Namespace) => boolean = () => true) {}
  ingest(value: Completion): string | undefined {
    try { return this.enqueue(value); }
    catch { this.metrics.errors++; return undefined; }
  }
  enqueue(value: Completion): string | undefined {
    const { namespace: ns, user, assistants } = value;
    if (ns.visibility !== "bot_private" || !this.authorized(ns)) return this.skip();
    const answer = assistants.map(a => a.text).join("\n\n");
    if (!user.trim() || answer.trim().length < 40 || sensitive(user + "\n" + answer) ||
      !/(?:decid|confirm|research|because|implement|procedure|finding|configure|database|決定|確認|研究|因為|實作|步驟|發現|設定|資料庫)/i.test(user + "\n" + answer)) return this.skip();
    const confirmed = /(?:\bI (?:confirm|decide|choose)\b|我確認|我決定|決定採用)/i.test(user);
    const content = `${confirmed ? "User-confirmed decision" : "User-stated request"} (not independently verified), message ${value.messageId}:\n${user}\n\n` +
      assistants.map(a => `Assistant-unverified finding, message ${a.id}:\n${a.text}`).join("\n\n");
    const provenance = { botId: ns.botId, threadId: value.threadId, runId: value.runId };
    const key = `session:${digest(JSON.stringify(provenance))}`;
    const id = this.queue.enqueue(ns, { title: `Session ${digest(key).slice(0, 24)}`, content, mime: "text/plain", idempotencyKey: key },
        { provenance, classification: "user-stated / assistant-unverified", knowledgeHash: digest(JSON.stringify([user.trim(), answer.trim()])), evidence: { user, confirmed, assistants: assistants.map(a => a.text) } });
    this.metrics.accepted++; return id;
  }
  private skip(): undefined { this.metrics.skipped++; return undefined; }
  /** Trusted local administrator operation: copy only the original source, never a mixed private wiki page. */
  share(ns: Namespace, sourceId: string): string {
    if (ns.visibility !== "bot_private" || !this.authorized(ns)) throw new Error("Share denied");
    const row = this.queue.store.db.prepare("SELECT * FROM document_sources WHERE ns=? AND id=? AND deleted=0 ORDER BY version DESC LIMIT 1")
      .get(namespaceKey(ns), sourceId);
    if (!row || sensitive(String(row.content))) throw new Error("Source unavailable or sensitive");
    const provenance = this.queue.store.db.prepare("SELECT * FROM session_origins WHERE ns=? AND source=?").get(namespaceKey(ns), sourceId);
    if (!provenance) throw new Error("Not a session source");
    const evidence = this.queue.store.db.prepare("SELECT content FROM session_evidence WHERE ns=? AND source=?").get(namespaceKey(ns), sourceId);
    return this.queue.enqueue({ ...ns, visibility: "project_shared" }, {
      title: row.title, content: row.content, mime: "text/plain", idempotencyKey: `share:${sourceId}:${row.version}`,
    }, { provenance: JSON.parse(String(provenance.provenance)), classification: String(provenance.classification), ...(evidence ? { evidence: JSON.parse(String(evidence.content)) } : {}) });
  }
}

/** One observer per real invocation; replay/connect never construct this object. Tools/reasoning are excluded. */
export class RunCompletionObserver {
  private started = false;
  private finished = false;
  private invalid = false;
  private messages = new Map<string, { id: string; text: string; ended: boolean }>();
  private bytes = 0;
  private readonly completion?: Completion;
  constructor(botId: string, settings: RuntimeSettings, input: RunAgentInput, readonly service: SessionIngestor) {
    if (input.resume?.length) { service.metrics.resumeSkipped++; return; }
    const last = input.messages.at(-1);
    if (!settings.memory || last?.role !== "user" || typeof last.content !== "string" || Buffer.byteLength(last.content) > 16384) return;
    this.completion = { namespace: { principal: settings.memory.principal, projectId: settings.memory.projectId,
      botId, visibility: "bot_private" }, threadId: input.threadId, runId: input.runId,
      messageId: last.id, user: last.content, assistants: [] };
  }
  event(event: any) {
    if (!this.completion || this.invalid) return;
    if (this.finished) { if (["RUN_ERROR", "RUN_FINISHED", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_START"].includes(event.type)) this.invalid = true; return; }
    const handlers: Record<string, (event: any) => void> = {
      RUN_STARTED: event => this.start(event), RUN_ERROR: () => { this.invalid = true; },
      TEXT_MESSAGE_START: event => this.startMessage(event), TEXT_MESSAGE_CONTENT: event => this.content(event),
      TEXT_MESSAGE_END: event => this.endMessage(event), RUN_FINISHED: event => this.finish(event),
    };
    handlers[event.type]?.(event);
  }
  private start(event: any) {
    if (this.started || event.threadId !== this.completion!.threadId || event.runId !== this.completion!.runId) this.invalid = true;
    this.started = true;
  }
  private startMessage(event: any) {
    if (event.role !== "assistant") return;
    if (!this.started || typeof event.messageId !== "string" || this.messages.has(event.messageId) || this.messages.size >= 32) { this.invalid = true; return; }
    this.messages.set(event.messageId, { id: event.messageId, text: "", ended: false });
  }
  private content(event: any) {
    const message = this.messages.get(event.messageId);
    if (!message || message.ended || typeof event.delta !== "string") { this.invalid = true; return; }
    this.bytes += Buffer.byteLength(event.delta);
    if (this.bytes > 65536) { this.invalid = true; return; }
    message.text += event.delta;
  }
  private endMessage(event: any) {
    const message = this.messages.get(event.messageId);
    if (!message || message.ended) this.invalid = true;
    else message.ended = true;
  }
  private finish(event: any) {
    const c = this.completion!;
    if (!this.started || event.threadId !== c.threadId || event.runId !== c.runId ||
      (event.outcome && event.outcome.type !== "success")) { this.invalid = true; return; }
    this.finished = true;
  }
  complete() {
    const c = this.completion;
    if (!c || this.invalid || !this.finished || !this.messages.size || [...this.messages.values()].some(m => !m.ended)) return;
    this.invalid = true;
    this.service.ingest({ ...c, assistants: [...this.messages.values()].map(({ id, text }) => ({ id, text })) });
  }
}
