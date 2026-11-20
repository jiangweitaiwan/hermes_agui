import { afterEach, expect, test, vi } from "vitest";
import { GoogleAuth } from "google-auth-library";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CloudTasksDelivery, TasksSchema } from "../server/graph/tasks";
import { PostgresWikiStore } from "../server/graph/postgres-wiki-store";
import { FilesystemGraphObjects } from "../server/graph/objects";
import { PostgresDocumentIngestor } from "../server/graph/postgres-ingest-queue";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const database = process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
test.skipIf(!database)("committed jobs survive task enqueue failure and duplicate delivery with minimal payload", async () => {
  vi.stubEnv("LOCAL_TASK_TOKEN", "local-task-only-credential-at-least-32-characters");
  const request = vi.fn().mockRejectedValueOnce(new Error("transport unavailable")).mockResolvedValue({});
  vi.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({ request } as any);
  const root = await mkdtemp(join(await realpath(tmpdir()), "part2-task-objects-"));
  const store = new PostgresWikiStore(database!, new FilesystemGraphObjects(root));
  const queue = new PostgresDocumentIngestor(store);
  const ns = { principal: randomUUID(), projectId: "project", botId: "bot", visibility: "bot_private" as const };
  try {
    await store.ready(); await queue.ready();
    const id = await queue.enqueue(ns, { title: "test", mime: "text/plain", content: "private document", idempotencyKey: "one" });
    const tasks = new CloudTasksDelivery(store.pool, TasksSchema.parse({ project: "local-project", location: "asia-east1",
      queue: "memory", workerUrl: "https://worker.run.app", serviceAccount: "tasks@local-project.iam.gserviceaccount.com", tokenEnv: "LOCAL_TASK_TOKEN" }));
    await tasks.ready();
    await expect(tasks.enqueue(id)).rejects.toThrow("transport unavailable");
    expect((await queue.status(ns, id)).state).toBe("pending");
    const pending = await store.pool.query("SELECT deliveries FROM hermes_agui_runtime.task_deliveries WHERE job=$1", [id]);
    expect(Number(pending.rows[0].deliveries)).toBe(0);
    await tasks.enqueue(id); await tasks.enqueue(id);
    const delivered = await store.pool.query("SELECT deliveries FROM hermes_agui_runtime.task_deliveries WHERE job=$1", [id]);
    expect(Number(delivered.rows[0].deliveries)).toBe(2);
    const task = request.mock.calls.at(-1)![0].data.task;
    expect(JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString())).toEqual({ schema: 1, jobId: id });
    expect(task.dispatchDeadline).toBe("600s");
    expect(task.httpRequest.oidcToken.audience).toBe("https://worker.run.app");
    expect(task.httpRequest.headers["X-Worker-Token"]).toBe(process.env.LOCAL_TASK_TOKEN);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
