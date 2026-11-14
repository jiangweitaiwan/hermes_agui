import { randomUUID, timingSafeEqual } from "node:crypto";
import type { RuntimeSettings } from "./runtime";

export interface DelegationSettings {
  token: string;
  allow: Record<string, string[]>;
  timeoutMs?: number;
  maxRecords?: number;
}
interface Call {
  sourceBotId: string; threadId: string; runId: string; toolCallId: string;
  targetBotId: string; task: string;
}
export interface DelegationResult {
  status: "completed" | "failed" | "human_required" | "timeout" | "cancelled" |
    "busy" | "result_too_large" | "denied" | "depth_exceeded" | "invalid_request" | "capacity";
  delegationId?: string; threadId?: string; runId?: string; text?: string;
}
interface RecordEntry {
  fingerprint: string; result: Promise<DelegationResult>; expires: number;
  parentUrl: string; sourceToken: string;
}
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function base(url: string) { return url.replace(/\/agent\/?$/, ""); }
const path = (value: string) => encodeURIComponent(value);
const parentUrl = (source: RuntimeSettings, call: Call) =>
  `${base(source.agentUrl)}/delegation/parent?thread_id=${path(call.threadId)}&run_id=${path(call.runId)}`;

export class DelegationCoordinator {
  private records = new Map<string, RecordEntry>();
  private timeout: number;
  constructor(private bots: Record<string, RuntimeSettings>, private settings: DelegationSettings) {
    this.timeout = settings.timeoutMs ?? 55_000;
    if (!settings.token || !Number.isFinite(this.timeout) || this.timeout <= 0 || this.timeout > 290_000 ||
      !Number.isInteger(settings.maxRecords ?? 1024) || (settings.maxRecords ?? 1024) < 1 ||
      Object.entries(settings.allow).some(([source, targets]) => !bots[source] ||
        !Array.isArray(targets) || targets.some(target => !bots[target] || target === source))) {
      throw new Error("Invalid delegation configuration");
    }
  }
  async handle(request: Request): Promise<Response> {
    let call: Call;
    try {
      const body = await request.text();
      if (Buffer.byteLength(body) > 20_000) throw new Error();
      call = JSON.parse(body);
      const ids = [call.sourceBotId, call.targetBotId, call.threadId, call.runId, call.toolCallId];
      if (ids.some(id => typeof id !== "string" || !id || id.length > 512) ||
        typeof call.task !== "string" || !call.task.trim() || Buffer.byteLength(call.task) > 16384) throw new Error();
    } catch { return Response.json({ status: "invalid_request" }, { status: 422 }); }
    const source = Object.hasOwn(this.bots, call.sourceBotId) ? this.bots[call.sourceBotId] : undefined;
    if (!source || !equal(request.headers.get("authorization") ?? "", `Bearer ${source.token}`) ||
      !(Object.hasOwn(this.settings.allow, call.sourceBotId) &&
        this.settings.allow[call.sourceBotId].includes(call.targetBotId))) {
      return Response.json({ status: "denied" }, { status: 403 });
    }
    const controller = new AbortController();
    const abort = () => controller.abort("cancelled");
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(() => controller.abort("timeout"), this.timeout);
    try {
      const parent = await fetch(parentUrl(source, call), {
        headers: { Authorization: `Bearer ${source.token}` }, signal: controller.signal,
      });
      if (!parent.ok) { await parent.body?.cancel(); return Response.json({ status: "denied" }); }
      if ((await parent.json()).depth !== 0) return Response.json({ status: "depth_exceeded" });
      const key = JSON.stringify([call.sourceBotId, call.threadId, call.runId, call.toolCallId]);
      const fingerprint = JSON.stringify([call.targetBotId, call.task]);
      // Retain dedup for the entire live parent, even when it outlives the retention window.
      const expired = [...this.records].filter(([id, record]) => id !== key && record.expires < Date.now()).slice(0, 16);
      for (const [id, record] of expired) {
        const parent = await fetch(record.parentUrl, { headers: { Authorization: `Bearer ${record.sourceToken}` },
          signal: controller.signal });
        await parent.body?.cancel();
        if ([404, 409].includes(parent.status)) this.records.delete(id);
      }
      const previous = this.records.get(key);
      if (previous) return Response.json(previous.fingerprint === fingerprint
        ? await previous.result : { status: "invalid_request" });
      if (this.records.size >= (this.settings.maxRecords ?? 1024)) return Response.json({ status: "capacity" });
      const record: RecordEntry = { fingerprint, expires: Infinity,
        parentUrl: parentUrl(source, call),
        sourceToken: source.token,
        result: this.execute(call, controller.signal) };
      this.records.set(key, record);
      const result = await record.result;
      record.expires = Date.now() + 300_000;
      return Response.json(result);
    } catch { return Response.json({ status: controller.signal.reason === "timeout" ? "timeout" :
      controller.signal.aborted ? "cancelled" : "failed" }); }
    finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
  }
  private async execute(call: Call, signal: AbortSignal): Promise<DelegationResult> {
    const target = this.bots[call.targetBotId];
    const ids = { delegationId: randomUUID(), threadId: `delegation-${randomUUID()}`, runId: randomUUID() };
    let completed = false;
    try {
      const response = await fetch(target.agentUrl, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.token}`,
          "X-Hermes-Delegation": this.settings.token },
        body: JSON.stringify({ threadId: ids.threadId, runId: ids.runId, state: {}, tools: [], context: [],
          forwardedProps: {}, messages: [{ id: randomUUID(), role: "user", content: call.task }] }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ...ids, status: [409, 503].includes(response.status) ? "busy" : "failed" };
      }
      const outcome = await consumeResult(response, ids.threadId, ids.runId);
      completed = outcome.status === "completed";
      return { ...ids, ...outcome };
    } catch { return { ...ids, status: signal.reason === "timeout" ? "timeout" : signal.aborted ? "cancelled" : "failed" }; }
    finally {
      if (!completed) {
        // Cancellation has its own short deadline; the caller's signal is already aborted.
        await fetch(`${base(target.agentUrl)}/threads/${path(ids.threadId)}/cancel`, {
          method: "POST", headers: { Authorization: `Bearer ${target.token}` }, signal: AbortSignal.timeout(2000),
        }).then(response => response.body?.cancel()).catch(() => undefined);
      }
    }
  }
}

async function consumeResult(response: Response, thread: string, run: string): Promise<DelegationResult> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return { status: "failed" };
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", text = "", message = "", total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return { status: "failed" };
      total += chunk.value.byteLength;
      if (total > 1_048_576) return { status: "result_too_large" };
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpMatchArray | null;
      while ((boundary = buffer.match(/\r?\n\r?\n/))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index! + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === "TEXT_MESSAGE_START" && event.role === "assistant") { message = event.messageId; text = ""; }
        if (event.type === "TEXT_MESSAGE_CONTENT" && event.messageId === message) {
          if (typeof event.delta !== "string") return { status: "failed" };
          text += event.delta;
          if (Buffer.byteLength(text) > 32768) return { status: "result_too_large" };
        }
        if (event.type === "RUN_ERROR") return { status: "failed" };
        if (event.type === "RUN_FINISHED") {
          if (event.threadId !== thread || event.runId !== run) return { status: "failed" };
          if (event.outcome?.type === "interrupt") return { status: "human_required" };
          if (event.outcome && event.outcome.type !== "success") return { status: "failed" };
          return { status: "completed", text };
        }
      }
      if (buffer.length > 131072) return { status: "result_too_large" };
    }
  } finally { await reader.cancel().catch(() => undefined); }
}
