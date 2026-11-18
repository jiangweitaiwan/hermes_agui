import { createServer } from "node:http";
import { once } from "node:events";
import { createApplication } from "../server/application";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { FilesystemGraphObjects } from "../server/graph/objects";
import { PostgresWikiStore } from "../server/graph/postgres-wiki-store";
import { PostgresDocumentIngestor } from "../server/graph/postgres-ingest-queue";
import { GraphBrowser } from "../server/graph/browser";
import { parseQuery } from "../server/graph/browser-query";
import { WikiGraphProvider } from "../server/graph/provider";
import { WikiCompiler, type CompilerLLM } from "../server/graph/compiler";
import { namespaceKey } from "../server/graph/wiki-store";
import { SessionIngestor } from "../server/graph/session-ingestor";
import { createCompletionApi } from "../server/graph/completion-api";

const url = process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;
const model: CompilerLLM = { async json(stage, value: any) {
  if (stage === "analysis") return { claims: [{ text: value.text, quote: value.text, certainty: "fact", conflict: false }] };
  if (stage === "generation") return { pages: [{ id: "database", title: "資料庫", type: "concept", tags: [], related: [], claims: [0] }] };
  return { claims: [0], conflict: false };
} };
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "graph-external-"));
  const objects = new FilesystemGraphObjects(root);
  const store = new PostgresWikiStore(url!, objects), other = new PostgresWikiStore(url!, objects);
  const queue = new PostgresDocumentIngestor(store), second = new PostgresDocumentIngestor(other);
  const ns = { principal: randomUUID(), projectId: "project", botId: "a", visibility: "bot_private" as const };
  await store.ready(); await queue.ready();
  return { root, store, other, queue, second, ns, close: async () => {
    await Promise.all([store.close(), other.close()]); await rm(root, { recursive: true, force: true });
  } };
}
const upload = (content: string, idempotencyKey: string, sourceId?: string) => ({ content, title: "資料庫", mime: "text/plain", idempotencyKey, ...(sourceId ? { sourceId } : {}) });

test.skipIf(!url)("PG source/wiki/browser/retrieval use external objects; revoke defeats stale object reads and publication", async () => {
  const f = await fixture(); const { store, queue, ns } = f;
  try {
    const id = await queue.enqueue(ns, upload("繁體中文資料庫保存原始證據", "first"));
    await new WikiCompiler(queue, model).processJob(ns, id);
    expect((await queue.status(ns, id)).state).toBe("completed");
    const browser = new GraphBrowser(f.other, ns, parseQuery(new URL("http://localhost/?q=資料庫"), "search"), () => true);
    expect((await browser.list("binding", true)).pages.map(page => page.pageId)).toContain("database");
    expect((await browser.detail("bot_private", "database")).provenance[0]).toMatchObject({ kind: "document", version: 1 });
    await browser.revalidate();
    const provider = new WikiGraphProvider(f.other);
    expect((await provider.query({ ...ns, threadId: "t", runId: "r" }, { text: "資料庫", limit: 10 }, new AbortController().signal)).status).toBe("ok");
    const job = await queue.status(ns, id), source = await queue.source(job);
    await expect(queue.sources.get({ ...ns, principal: "other" }, source.id)).rejects.toThrow();
    const updated = await queue.enqueue(ns, upload("繁體中文資料庫第二版本", "second", source.id));
    await new WikiCompiler(queue, model).processJob(ns, updated);
    expect((await queue.current(ns, "database"))!.page.sources).toHaveLength(2);
    await queue.sources.revoke(ns, source.id);
    expect(await queue.current(ns, "database")).toBeUndefined();
    await expect(browser.revalidate()).rejects.toThrow();
    await expect(queue.sources.get(ns, source.id)).rejects.toThrow();
    const md = `---\n${stringify({ id: "resurrected", title: "stale", type: "note", sources: [{ kind: "document", botId: "a", sourceId: source.id, version: 1, hash: source.hash, title: source.title }], tags: [], related: [], created: new Date().toISOString(), updated: new Date().toISOString() })}---\n資料庫`;
    await expect(store.import(ns, [{ markdown: md, expectedRevision: null }])).rejects.toThrow("provenance");
    expect(await queue.current(ns, "resurrected")).toBeUndefined();
  } finally { await f.close(); }
});

test.skipIf(!url)("DB-clock job takeover fences stale worker and publication/completion roll back together", async () => {
  const f = await fixture(); const { queue, second, ns, store } = f;
  try {
    const id = await queue.enqueue(ns, upload("資料庫原子提交", "key"));
    expect(await second.enqueue(ns, upload("資料庫原子提交", "key"))).toBe(id);
    await expect(second.enqueue(ns, upload("資料庫不同內容", "key"))).rejects.toThrow("Idempotency conflict");
    const first = (await queue.claim(ns, undefined, undefined, id))!;
    expect(await second.claim(ns, undefined, undefined, id)).toBeUndefined();
    await store.pool.query("UPDATE hermes_agui_runtime.graph_jobs SET lease=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    const takeover = (await second.claim(ns, undefined, undefined, id))!;
    expect(takeover.attempt).toBe(2); expect(takeover.token).not.toBe(first.token);
    await expect(queue.heartbeat(first)).rejects.toThrow("lease");
    await expect(queue.publish(ns, first, [], () => {})).rejects.toThrow("lease");
    await queue.fail(first); await queue.cancelClaim(first);
    expect((await queue.status(ns, id)).token).toBe(takeover.token);
    await second.publish(ns, takeover, [], () => {});
    expect((await queue.status(ns, id)).state).toBe("completed");
  } finally { await f.close(); }
});

test.skipIf(!url)("completion ACK waits for durable source/job; ACK loss and new receiver preserve one job", async () => {
  const f = await fixture(); const { queue, second, ns } = f;
  try {
    const token = "a".repeat(32), value = { namespace: ns, threadId: "t", runId: "r", messageId: "u",
      user: "研究資料庫備份", assistants: [{ id: "final", text: "資料庫的備份決定需要保存已提交的資料以及原始的證據，才能驗證恢復過程，並且確保重新部署後可以繼續讀取。" }] };
    const request = () => new Request("http://localhost/internal/graph/completions", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(value) });
    const receive = createCompletionApi(new SessionIngestor(queue), token);
    expect((await receive(request())).status).toBe(204);
    expect((await createCompletionApi(new SessionIngestor(second), token)(request())).status).toBe(204);
    expect(await queue.store.browserJobs(namespaceKey(ns))).toHaveLength(1);
    const job = (await queue.store.browserJobs(namespaceKey(ns)))[0];
    expect((await second.source(await second.status(ns, job.id))).provenance).toMatchObject({ threadId: "t", runId: "r" });
  } finally { await f.close(); }
});

test.skipIf(!url)("two independent worker processes take over an expired claim; resumed old process cannot publish", async () => {
  const f = await fixture();
  const children: ReturnType<typeof fork>[] = [];
  const start = (mode: string, id: string) => {
    const child = fork(fileURLToPath(new URL("./fixtures/graph-job-worker.ts", import.meta.url)), [mode, JSON.stringify(f.ns), id], {
      execArgv: ["--import", "tsx"], env: { ...process.env, GRAPH_TEST_OBJECT_ROOT: f.root }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    const result = new Promise<any>((resolve, reject) => {
      child.once("message", resolve); child.once("error", reject);
      child.once("exit", code => { if (code) reject(new Error("Worker failed")); });
    });
    return { child, result };
  };
  try {
    const id = await f.queue.enqueue(f.ns, upload("資料庫獨立程序接管成功", "process"));
    const first = start("hold", id);
    expect((await first.result).state).toBe("claimed");
    first.child.kill("SIGSTOP");
    await f.store.pool.query("UPDATE hermes_agui_runtime.graph_jobs SET lease=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    const second = start("process", id);
    expect((await second.result).state).toBe("completed");
    const fenced = new Promise<any>(resolve => first.child.once("message", resolve));
    first.child.kill("SIGCONT"); first.child.send("resume");
    expect((await fenced).state).toBe("fenced");
    expect((await f.queue.current(f.ns, "database"))!.page.body).not.toContain("STALE WORKER");
  } finally {
    for (const child of children) { child.kill("SIGCONT"); child.kill("SIGKILL"); }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()))));
    await f.close();
  }
}, 30000);

test.skipIf(!url)("PG Runtime evolution, browser and context injection survive a new application and refresh authoritative ACL", async () => {
  const f = await fixture();
  f.ns.botId = `bot-${randomUUID()}`;
  const received: any[] = [];
  const host = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); received.push(input);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [{ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  host.listen(0, "127.0.0.1"); await once(host, "listening");
  const address = host.address() as { port: number };
  const provider = new WikiGraphProvider(f.store);
  const options = {
    management: { postgres: { url: url!, credentialSeed: "a".repeat(64) }, hostUrl: "http://localhost", hostToken: "host",
      users: [{ ownerId: f.ns.principal, principal: f.ns.principal, projectId: f.ns.projectId, token: "owner-token" }], templates: [] },
    graph: { provider, authorize: () => true }, evolution: { provider, compiler: model, pollMs: 60000 }, graphCompletionToken: "b".repeat(32),
  };
  const bots = { [f.ns.botId]: { agentUrl: `http://127.0.0.1:${address.port}/agent`, token: "upstream", memory: { key: "signing-secret", principal: f.ns.principal, projectId: f.ns.projectId } } };
  let app = createApplication(bots, options);
  const get = (path: string) => app.graphApi(new Request(`http://localhost/api/graph/${f.ns.botId}/${path}`, { headers: { authorization: "Bearer owner-token" } }));
  try {
    await app.ready;
    const foreignNs = { ...f.ns, principal: randomUUID() };
    const foreign = await f.second.enqueue(foreignNs, upload("資料庫其他部署保留證據", "foreign"));
    const id = await app.evolution!.queue.enqueue(f.ns, upload("繁體中文資料庫重新部署仍保存證據", "runtime"));
    await app.evolution!.tick(); expect((await app.evolution!.queue.status(f.ns, id)).state).toBe("completed");
    expect((await f.second.status(foreignNs, foreign)).state).toBe("pending");
    expect((await (await get("search?q=資料庫")).json()).pages.length).toBeGreaterThan(0);
    await app.close();
    app = createApplication(bots, options); await app.ready;
    expect((await (await get("stats")).json()).pages).toBe(2);
    const response = await app.runtime(new Request(`http://localhost/api/copilotkit/agent/${f.ns.botId}/run`, {
      method: "POST", headers: { "Content-Type": "application/json", authorization: "Bearer owner-token" },
      body: JSON.stringify({ threadId: "original-thread", runId: randomUUID(), state: {}, tools: [], context: [], forwardedProps: {}, messages: [{ id: "q", role: "user", content: "資料庫" }] }),
    }));
    expect(await response.text()).toContain("RUN_FINISHED");
    const context = JSON.parse(Buffer.from(received.at(-1).forwardedProps.runtimeMemory.payload, "base64url").toString()).context;
    expect(context.records.some((record: any) => record.content.includes("重新部署"))).toBe(true);
    // Simulate another Runtime committing a deletion while this process still has a cached Bot.
    await f.store.pool.query(`UPDATE hermes_agui_runtime.bot_registry SET record=jsonb_set(record,'{deletedAt}',to_jsonb('2026-11-18T00:00:00Z'::text)) WHERE id=$1`, [f.ns.botId]);
    expect((await get("pages")).status).toBe(404);
    await app.evolution!.tick();
    expect(await f.queue.current(f.ns, "database")).toBeUndefined();
  } finally {
    await app.close();
    await new Promise<void>(resolve => { host.close(() => resolve()); host.closeAllConnections(); });
    await f.close();
  }
}, 30000);

test.skipIf(!url)("different jobs merge the same page after revision conflict without losing either source", async () => {
  const f = await fixture();
  try {
    const first = await f.queue.enqueue(f.ns, upload("資料庫證據甲", "race-a"));
    const second = await f.second.enqueue(f.ns, upload("資料庫證據乙", "race-b"));
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const competing: CompilerLLM = { async json(stage, data, signal) {
      if (stage === "merge") { if (++arrivals === 2) release(); await barrier; }
      return model.json(stage, data, signal);
    } };
    await Promise.all([new WikiCompiler(f.queue, competing).processJob(f.ns, first), new WikiCompiler(f.second, competing).processJob(f.ns, second)]);
    const jobs = await Promise.all([f.queue.status(f.ns, first), f.queue.status(f.ns, second)]);
    expect(jobs.map(job => job.state).sort()).toEqual(["completed", "pending"]);
    const retry = jobs.find(job => job.state === "pending")!;
    await f.store.pool.query("UPDATE hermes_agui_runtime.graph_jobs SET available=clock_timestamp() WHERE id=$1", [retry.id]);
    await new WikiCompiler(f.second, model).processJob(f.ns, retry.id);
    const active = (await f.queue.current(f.ns, "database"))!;
    expect(active.page.body).toContain("資料庫證據甲"); expect(active.page.body).toContain("資料庫證據乙");
    expect(active.page.sources).toHaveLength(2);
    expect((await f.queue.status(f.ns, retry.id)).state).toBe("completed");
  } finally { await f.close(); }
});

test.skipIf(!url)("revocation during compile and failed object upload never publish or complete a job", async () => {
  const f = await fixture();
  try {
    const id = await f.queue.enqueue(f.ns, upload("資料庫撤銷證據", "revoke"));
    await new WikiCompiler(f.queue, { async json(stage, data, signal) {
      if (stage === "merge") await f.queue.sources.revoke(f.ns, (await f.queue.status(f.ns, id)).source);
      return model.json(stage, data, signal);
    } }).processJob(f.ns, id);
    expect((await f.queue.status(f.ns, id)).state).toBe("cancelled");
    expect(await f.queue.current(f.ns, "database")).toBeUndefined();
    const next = await f.queue.enqueue(f.ns, upload("資料庫上傳失敗證據", "upload-failure"));
    const broken = new PostgresWikiStore(url!, {
      create: async () => { throw new Error("Injected object upload failure"); },
      read: object => f.store.objects.read(object),
    });
    try {
      await new WikiCompiler(new PostgresDocumentIngestor(broken), model).processJob(f.ns, next);
      expect((await f.queue.status(f.ns, next)).state).toBe("pending");
      expect(await f.queue.current(f.ns, "database")).toBeUndefined();
    } finally { await broken.close(); }
  } finally { await f.close(); }
});

test.skipIf(!url)("job completion SQL failure rolls back staged wiki pointers and all publication metadata", async () => {
  const f = await fixture();
  const trigger = "fault_" + randomUUID().replaceAll("-", "");
  try {
    const id = await f.queue.enqueue(f.ns, upload("資料庫回滾證據", "rollback"));
    await f.store.pool.query(`CREATE FUNCTION hermes_agui_runtime.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='${id}'::uuid AND NEW.state='completed' THEN RAISE EXCEPTION 'injected completion failure'; END IF; RETURN NEW; END $$`);
    await f.store.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON hermes_agui_runtime.graph_jobs
      FOR EACH ROW EXECUTE FUNCTION hermes_agui_runtime.${trigger}()`);
    await new WikiCompiler(f.queue, model).processJob(f.ns, id);
    expect((await f.queue.status(f.ns, id)).state).toBe("pending");
    expect(await f.queue.current(f.ns, "database")).toBeUndefined();
    const { rows } = await f.store.pool.query("SELECT count(*)::integer AS n FROM hermes_agui_runtime.graph_revisions WHERE ns=$1", [namespaceKey(f.ns)]);
    expect(rows[0].n).toBe(0);
  } finally {
    await f.store.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON hermes_agui_runtime.graph_jobs`);
    await f.store.pool.query(`DROP FUNCTION IF EXISTS hermes_agui_runtime.${trigger}()`);
    await f.close();
  }
});

test.skipIf(!url)("sharing and revocation bind the original private namespace even when a shared reader has another bot ID", async () => {
  const f = await fixture();
  try {
    const sessions = new SessionIngestor(f.queue);
    const id = (await sessions.enqueue({ namespace: f.ns, threadId: "t", runId: "r", messageId: "u", user: "研究資料庫",
      assistants: [{ id: "a", text: "研究資料庫的復原流程需要核對外部儲存的原始來源以及已提交的版本，並且保留所有授權的知識以及證據以供後續查驗。" }] }))!;
    const source = (await f.queue.status(f.ns, id)).source;
    const shared = { ...f.ns, visibility: "project_shared" as const };
    const copy = await sessions.share(f.ns, source);
    await new WikiCompiler(f.queue, model).processJob(f.ns, id);
    await new WikiCompiler(f.second, model).processJob(shared, copy);
    const copiedSource = (await f.queue.status(shared, copy)).source;
    await f.queue.revokeCopies({ ...shared, botId: "other-shared-reader" }, copiedSource);
    expect(await f.queue.current(f.ns, "database")).toBeUndefined();
    expect(await f.queue.current(shared, "database")).toBeUndefined();
    expect((await f.queue.status(f.ns, id)).state).toBe("cancelled");
    await expect(f.queue.sources.get(f.ns, source)).rejects.toThrow();
    await expect(sessions.share(f.ns, source)).rejects.toThrow();
  } finally { await f.close(); }
});
