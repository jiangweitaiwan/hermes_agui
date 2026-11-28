import { boundedText } from "./http-body";
import { WORKER_SHUTDOWN } from "./graph/compiler";
import { timingSafeEqual } from "node:crypto";
import { deploymentEpoch, taskGeneration } from "./storage/epoch";
import type { MemoryEvolution } from "./graph/evolution";
import type { CloudTasksDelivery } from "./graph/tasks";

/** Private Cloud Run IAM is required in addition to this independent business credential. */
export function workerHandler(evolution: MemoryEvolution, tasks: CloudTasksDelivery, token: string, reconcileBots: () => Promise<void> = async () => {}) {
  if (token.length < 32) throw new Error("Worker credential required");
  const expected = Buffer.from(token);
  return async (request: Request) => {
    if(request.method==="GET" && new URL(request.url).pathname==="/internal/execution-capabilities") return Response.json({graphFence:1});
    const supplied = Buffer.from(request.headers.get("x-worker-token") ?? "");
    if (request.headers.has("origin") || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    if (!["/internal/jobs/reconcile", "/internal/jobs/process"].includes(path)) return new Response(null, {status:404});
    const client = await tasks.consumerPool.connect();
    try {
      await client.query("BEGIN");
      let identifier: string | undefined;
      if(path==="/internal/jobs/process") {
        let body: unknown;
        try { body=JSON.parse(await boundedText(request,1024)??""); } catch { return new Response(null,{status:400}); }
        const generation=taskGeneration(body,await deploymentEpoch(client));
        if(generation.status==="invalid") return new Response(null,{status:400});
        if(generation.status==="stale") return new Response(null,{status:204});
        identifier=generation.jobId;
      }
      const row=(await client.query("SELECT hermes_agui_runtime.acquire_graph_delivery() AS allowed")).rows[0];
      if(!row || !row.allowed) {
        if(path==="/internal/jobs/process") {
          const state=(await client.query("SELECT state FROM hermes_agui_runtime.graph_jobs WHERE id=$1",[identifier])).rows[0]?.state;
          return new Response(null,{status:state && ["completed","failed","cancelled"].includes(state)?204:503});
        }
        return new Response(null,{status:503});
      }
      return await handle(request,path,identifier);
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  };
  async function handle(request:Request,path:string,identifier?:string) {
    if (path === "/internal/jobs/reconcile") {
      await reconcileBots(); await evolution.reconcile();
      const result = await tasks.reconcile(evolution.options.provider.edgeVectors?.key);
      return Response.json(result, { status: result.failed ? 503 : 200 });
    }
    if (path !== "/internal/jobs/process") return new Response(null, { status: 404 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(WORKER_SHUTDOWN), (tasks.settings.deadlineSeconds - 10) * 1000);
    let job;
    try { job = await evolution.processJob(identifier!, AbortSignal.any([controller.signal, evolution.controller.signal])); }
    finally { clearTimeout(timer); }
    // Terminal failures are persisted by the compiler; exhausted jobs need explicit administrator review.
    return Response.json({ state: job.state }, { status: ["completed", "failed", "cancelled"].includes(job.state) ? 200 : 503 });
  }
}
