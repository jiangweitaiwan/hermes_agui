import { boundedText } from "./http-body";
import { WORKER_SHUTDOWN } from "./graph/compiler";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { MemoryEvolution } from "./graph/evolution";
import type { CloudTasksDelivery } from "./graph/tasks";
const input = z.object({ schema: z.literal(1), jobId: z.string().uuid() }).strict();
/** Private Cloud Run IAM is required in addition to this independent business credential. */
export function workerHandler(evolution: MemoryEvolution, tasks: CloudTasksDelivery, token: string, reconcileBots: () => Promise<void> = async () => {}) {
  if (token.length < 32) throw new Error("Worker credential required");
  const expected = Buffer.from(token);
  return async (request: Request) => {
    const supplied = Buffer.from(request.headers.get("x-worker-token") ?? "");
    if (request.headers.has("origin") || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    if (path === "/internal/jobs/reconcile") {
      await reconcileBots(); await evolution.reconcile();
      const result = await tasks.reconcile();
      return Response.json(result, { status: result.failed ? 503 : 200 });
    }
    if (path !== "/internal/jobs/process") return new Response(null, { status: 404 });
    const text = await boundedText(request, 1024);
    if (text === undefined) return new Response(null, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
    const value = input.safeParse(body);
    if (!value.success) return new Response(null, { status: 400 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(WORKER_SHUTDOWN), (tasks.settings.deadlineSeconds - 10) * 1000);
    let job;
    try { job = await evolution.processJob(value.data.jobId, AbortSignal.any([controller.signal, evolution.controller.signal])); }
    finally { clearTimeout(timer); }
    // Terminal failures are persisted by the compiler; exhausted jobs need explicit administrator review.
    return Response.json({ state: job.state }, { status: ["completed", "failed", "cancelled"].includes(job.state) ? 200 : 503 });
  };
}
