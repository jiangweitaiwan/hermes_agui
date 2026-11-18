import { ProvenanceSchema, type Provenance } from "./graph/provenance";
/** Server-only graph adapter contract. Native SQLite remains conversation authority. */
export interface GraphScope {
  readonly principal: string; readonly botId: string; readonly projectId: string;
  readonly threadId: string; readonly runId: string;
}
export type Visibility = "bot_private" | "project_shared";
export interface GraphSource { botId: string; threadId: string; runId: string }
export interface GraphEntry {
  content: string; visibility: Visibility; source: GraphSource; idempotencyKey: string;
}
export interface GraphHit {
  recordId: string; content: string; visibility: Visibility; source: Provenance; sources?: Provenance[];
  principal: string; projectId: string;
}
export interface GraphQuery { text: string; limit: number }
export type GraphRejection = { status: "rejected"; reason: "unauthorized" | "invalid_request" };
export type GraphQueryResult = { status: "ok"; hits: GraphHit[] } |
  { status: "disabled" | "unavailable" } | GraphRejection;
export type GraphWriteResult = { status: "accepted"; recordId: string } |
  { status: "disabled" | "unavailable" } | GraphRejection;
/** Providers must scope queries and enforce idempotent writes; honor the abort signal. */
export interface GraphMemoryPort {
  query(scope: GraphScope, request: GraphQuery, signal: AbortSignal): Promise<GraphQueryResult>;
  write(scope: GraphScope, entry: GraphEntry, signal: AbortSignal): Promise<GraphWriteResult>;
}
export interface GraphMemoryOptions {
  provider?: GraphMemoryPort;
  /** Deployment ACL is namespace-based; callers need no synthetic run/thread identity. */
  authorize: (scope: Pick<GraphScope, "principal" | "projectId" | "botId">, operation: "query" | "write") => boolean;
  timeoutMs?: number;
}
const bounded = (value: unknown, bytes: number): value is string =>
  typeof value === "string" && !!value.trim() && Buffer.byteLength(value) <= bytes;
const validScope = (scope: GraphScope) => scope &&
  [scope.principal, scope.botId, scope.projectId, scope.threadId, scope.runId].every(value => bounded(value, 512));
const visible = (value: unknown): value is Visibility => value === "bot_private" || value === "project_shared";
const validSource = (source: unknown) => ProvenanceSchema.safeParse(source).success;

export function createGraphMemory(options: GraphMemoryOptions) {
  const timeout = options.timeoutMs ?? 2000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30000) throw new Error("Invalid graph timeout");
  const scopes = new WeakSet<GraphScope>();
  const allowed = (scope: GraphScope, operation: "query" | "write") => {
    try { return validScope(scope) && scopes.has(scope) && options.authorize(scope, operation) === true; }
    catch { return false; }
  };
  async function invoke<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T | { status: "unavailable" }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => action(controller.signal)),
        new Promise<{ status: "unavailable" }>(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve({ status: "unavailable" }); }, timeout);
        })]);
    } catch { return { status: "unavailable" }; }
    finally { clearTimeout(timer); }
  }
  return {
    /** Only trusted backend code calls this after resolving authenticated identity/project. */
    scope(identity: GraphScope): GraphScope {
      if (!validScope(identity)) throw new Error("Invalid graph scope");
      const { principal, botId, projectId, threadId, runId } = identity;
      const scope = Object.freeze({ principal, botId, projectId, threadId, runId });
      scopes.add(scope);
      return scope;
    },
    async query(scope: GraphScope, request: GraphQuery): Promise<GraphQueryResult> {
      if (!allowed(scope, "query")) return { status: "rejected", reason: "unauthorized" };
      if (!request || !bounded(request.text, 4096) || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
        return { status: "rejected", reason: "invalid_request" };
      }
      if (!options.provider) return { status: "disabled" };
      const result = await invoke(signal => options.provider!.query(scope, { text: request.text, limit: request.limit }, signal));
      if (!allowed(scope, "query")) return { status: "rejected", reason: "unauthorized" };
      if (!result || typeof result !== "object") return { status: "unavailable" };
      if (result.status !== "ok") return normalizeFailure(result);
      if (!Array.isArray(result.hits) || result.hits.length > request.limit || result.hits.some(hit =>
        !hit || !bounded(hit.recordId, 512) || !bounded(hit.content, 16384) || !validSource(hit.source) ||
        !visible(hit.visibility) || (hit.sources !== undefined && (!Array.isArray(hit.sources) ||
          hit.sources.length < 1 || hit.sources.length > 20 || hit.sources.some(s => !validSource(s)))))) return { status: "unavailable" };
      if (result.hits.some(hit => !authorizedHit(hit, scope))) {
        return { status: "rejected", reason: "unauthorized" };
      }
      return { status: "ok", hits: result.hits.map(hit => ({
        recordId: hit.recordId, content: hit.content, visibility: hit.visibility,
        principal: hit.principal, projectId: hit.projectId,
        source: structuredClone(hit.source), ...(hit.sources ? { sources: structuredClone(hit.sources) } : {}),
      })) };
    },
    async write(scope: GraphScope, entry: GraphEntry): Promise<GraphWriteResult> {
      if (!allowed(scope, "write")) return { status: "rejected", reason: "unauthorized" };
      if (!entry || !bounded(entry.content, 16384) || !visible(entry.visibility) || !validSource(entry.source) ||
        !bounded(entry.idempotencyKey, 512) || entry.source.botId !== scope.botId ||
        entry.source.threadId !== scope.threadId || entry.source.runId !== scope.runId) {
        return { status: "rejected", reason: "invalid_request" };
      }
      if (!options.provider) return { status: "disabled" };
      const result = await invoke(signal => options.provider!.write(scope, structuredClone(entry), signal));
      if (!result || typeof result !== "object") return { status: "unavailable" };
      if (result.status !== "accepted") return normalizeFailure(result);
      return bounded(result.recordId, 512) ? { status: "accepted", recordId: result.recordId } : { status: "unavailable" };
    },
  };
}
function normalizeFailure(result: { status: string; reason?: string }): { status: "disabled" | "unavailable" } | GraphRejection {
  if (result.status === "disabled") return { status: "disabled" };
  if (result.status === "rejected" && ["unauthorized", "invalid_request"].includes(result.reason ?? "")) {
    return { status: "rejected", reason: result.reason as GraphRejection["reason"] };
  }
  return { status: "unavailable" };
}

function authorizedHit(hit: GraphHit, scope: GraphScope): boolean {
  return hit.principal === scope.principal && hit.projectId === scope.projectId &&
    (hit.visibility === "project_shared" || [hit.source, ...(hit.sources ?? [])].every(s => s.botId === scope.botId));
}
