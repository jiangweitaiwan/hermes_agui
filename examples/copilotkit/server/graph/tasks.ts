import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import type { Pool } from "pg";

export const TasksSchema = z.object({
  project: z.string().regex(/^[a-z][a-z0-9-]+$/), location: z.string().regex(/^[a-z0-9-]+$/),
  queue: z.string().regex(/^[a-zA-Z0-9_-]+$/), workerUrl: z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; }),
  serviceAccount: z.string().email(), tokenEnv: z.string().min(1),
  deadlineSeconds: z.number().int().min(30).max(1800).default(600),
}).strict();
export type TasksSettings = z.infer<typeof TasksSchema>;
/** PG jobs + delivery rows remain authoritative even when task creation fails. */
export class CloudTasksDelivery {
  private auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  constructor(readonly pool: Pool, readonly settings: TasksSettings) {
    if (!process.env[settings.tokenEnv] || process.env[settings.tokenEnv]!.length < 32) throw new Error("Worker credential required");
  }
  async ready() { await this.pool.query("SELECT job FROM hermes_agui_runtime.task_deliveries LIMIT 0"); }
  async enqueue(id: string) {
    const { project, location, queue, workerUrl, serviceAccount, deadlineSeconds, tokenEnv } = this.settings;
    const client = await this.auth.getClient();
    await client.request({
      url: `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/${location}/queues/${queue}/tasks`, method: "POST",
      data: { task: { dispatchDeadline: `${deadlineSeconds}s`, httpRequest: {
        httpMethod: "POST", url: `${workerUrl.replace(/\/$/, "")}/internal/jobs/process`,
        headers: { "Content-Type": "application/json", "X-Worker-Token": process.env[tokenEnv]! },
        body: Buffer.from(JSON.stringify({ schema: 1, jobId: id })).toString("base64"),
        oidcToken: { serviceAccountEmail: serviceAccount, audience: workerUrl },
      } } }, timeout: 15000,
    });
    await this.pool.query("UPDATE hermes_agui_runtime.task_deliveries SET next_delivery=clock_timestamp()+interval '10 minutes', deliveries=deliveries+1 WHERE job=$1", [id]);
  }
  async reconcile(edgeModel?: string) {
    const { rows } = await this.pool.query<{ job: string }>(`SELECT d.job FROM hermes_agui_runtime.task_deliveries d
      JOIN hermes_agui_runtime.graph_jobs j ON j.id=d.job
      WHERE d.next_delivery<=clock_timestamp() AND ((j.state='pending' AND j.available<=clock_timestamp()) OR
      (j.state='running' AND j.lease<=clock_timestamp()) OR
      (j.state='completed' AND EXISTS (SELECT 1 FROM hermes_agui_runtime.graph_edge_evidence e
        JOIN hermes_agui_runtime.graph_sources s ON s.ns=e.ns AND s.id=e.source_id AND s.version=e.source_version
        WHERE e.ns=j.ns AND e.source_id=j.source AND e.source_version=j.version AND NOT s.deleted AND
        (NOT EXISTS (SELECT 1 FROM hermes_agui_runtime.graph_fact_tokens t WHERE t.ns=e.ns AND t.edge_id=e.edge_id)
         OR ($1::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hermes_agui_runtime.graph_edge_embeddings v
           WHERE v.ns=e.ns AND v.edge_id=e.edge_id AND v.model=$1)))))) ORDER BY d.next_delivery LIMIT 100`,[edgeModel ?? null]);
    let failed = 0;
    for (const { job } of rows) { try { await this.enqueue(job); } catch { failed++; } }
    return { attempted: rows.length, failed };
  }
}
