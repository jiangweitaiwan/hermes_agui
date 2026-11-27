import { afterEach, expect, test, vi } from "vitest";
import { workerHandler } from "../server/worker-http";
import type { MemoryEvolution } from "../server/graph/evolution";
import type { CloudTasksDelivery } from "../server/graph/tasks";
import { randomUUID } from "node:crypto";

const token = "local-worker-test-credential-32-characters";
afterEach(() => vi.useRealTimers());
function setup(state = "completed") {
  const evolution = { options: {provider: {edgeVectors: {key:"fixture-model-v2"}}}, controller: new AbortController(), reconcile: vi.fn(),
    processJob: vi.fn(async () => ({ state })) };
  const client = {query:vi.fn(async(_sql:string)=>({rows:[{allowed:true}]})),release:vi.fn()};
  const tasks = {consumerPool:{connect:vi.fn(async()=>client)}, settings: { deadlineSeconds: 30 }, reconcile: vi.fn(async () => ({ attempted: 1, failed: 0 })) };
  const reconcileBots = vi.fn();
  const handle = workerHandler(evolution as unknown as MemoryEvolution, tasks as unknown as CloudTasksDelivery, token, reconcileBots);
  const request = (body: unknown = { schema: 1, jobId: randomUUID() }, headers: Record<string, string> = { "X-Worker-Token": token }, path = "process") =>
    handle(new Request(`https://worker.run.app/internal/jobs/${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { evolution, tasks, reconcileBots, request };
}
test("worker rejects browser credentials and malformed payloads before processing", async () => {
  const { request, evolution } = setup();
  expect((await request(undefined, { Authorization: "Bearer browser" })).status).toBe(401);
  expect((await request(undefined, { "X-Worker-Token": token, Origin: "https://browser.example" })).status).toBe(401);
  expect((await request({ schema: 1, jobId: "invalid" })).status).toBe(400);
  expect((await request({ schema: 1, jobId: randomUUID(), transcript: "never accepted" })).status).toBe(400);
  expect(evolution.processJob).not.toHaveBeenCalled();
});
test.each(["completed", "failed", "cancelled", "running", "pending"])("worker acknowledges only persisted terminal state %s", async state => {
  const { request } = setup(state);
  expect((await request()).status).toBe(["completed", "failed", "cancelled"].includes(state) ? 200 : 503);
});
test("worker reconcile retries unsuccessful task delivery", async () => {
  const { request, tasks, reconcileBots, evolution } = setup();
  tasks.reconcile.mockResolvedValue({ attempted: 1, failed: 1 });
  expect((await request({}, undefined, "reconcile")).status).toBe(503);
  expect(reconcileBots).toHaveBeenCalledOnce();
  expect(evolution.reconcile).toHaveBeenCalledOnce();
  expect(tasks.reconcile).toHaveBeenCalledWith("fixture-model-v2");
});
test("worker propagates bounded deadline before task dispatch expires", async () => {
  vi.useFakeTimers();
  const { request, evolution } = setup();
  evolution.processJob.mockImplementation(async (_id?: unknown, signal?: AbortSignal) => new Promise(resolve => {
    signal!.addEventListener("abort", () => resolve({ state: "pending" }), { once: true });
  }));
  const response = request();
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await response).status).toBe(503);
});

test("sealed worker acknowledges terminal stale tasks and retries work without entering the compiler", async()=>{
  const {request,tasks,evolution}=setup();
  const client=await tasks.consumerPool.connect();
  client.query.mockImplementation(async sql=>({rows:sql.includes("acquire_graph_delivery")?[{allowed:false}]:sql.includes("SELECT state")?[{state:"completed"}]:[]} as any));
  expect((await request()).status).toBe(204);
  expect((await request({},undefined,"reconcile")).status).toBe(503);
  expect(evolution.processJob).not.toHaveBeenCalled();
  expect(client.release).toHaveBeenCalledTimes(2);
});
