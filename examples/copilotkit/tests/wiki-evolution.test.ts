import { afterEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore, namespaceKey } from "../server/graph/wiki-store";
import { DocumentIngestor } from "../server/graph/ingest-queue";
import { SessionIngestor, RunCompletionObserver } from "../server/graph/session-ingestor";
import { createCompletionApi } from "../server/graph/completion-api";
import { WikiCompiler, type CompilerLLM } from "../server/graph/compiler";
import { WikiGraphProvider } from "../server/graph/provider";
import { MemoryEvolution } from "../server/graph/evolution";
import { wikiHealth } from "../server/graph/health";
import type { RunAgentInput } from "@ag-ui/core";

const roots: string[] = [], stores: WikiStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
const ns = { principal: "owner", projectId: "project", visibility: "bot_private" as const, botId: "a" };
const settings = { agentUrl: "http://localhost/agent", token: "upstream", memory: { key: "signer", principal: ns.principal, projectId: ns.projectId } };
const answer = "Research finding: PostgreSQL uses a write ahead log for durable database recovery.";
function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-evolution-")); roots.push(root);
  const store = new WikiStore(root); stores.push(store);
  const queue = new DocumentIngestor(store), sessions = new SessionIngestor(queue);
  return { root, store, queue, sessions };
}
function input(runId = "run"): RunAgentInput {
  return { threadId: "thread", runId, state: {}, tools: [], context: [], forwardedProps: {},
    messages: [{ id: "old", role: "user", content: "old history SECRET" }, { id: "user", role: "user", content: "Research database recovery" }] };
}
function events(runId = "run", text = answer) {
  return [{ type: "RUN_STARTED", threadId: "thread", runId },
    { type: "TEXT_MESSAGE_START", messageId: "first", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "first", delta: text },
    { type: "TEXT_MESSAGE_END", messageId: "first" },
    { type: "TEXT_MESSAGE_START", messageId: "second", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "second", delta: "Decision remains user-stated; this result has not been independently verified." },
    { type: "TEXT_MESSAGE_END", messageId: "second" },
    { type: "RUN_FINISHED", threadId: "thread", runId, outcome: { type: "success" } }];
}
const model: CompilerLLM = { async json(stage, data: any) {
  if (stage === "analysis") return { claims: [{ text: answer, quote: answer, certainty: "fact", conflict: false }] };
  if (stage === "generation") return { pages: [{ id: "recovery", title: "Recovery", type: "finding", tags: [], related: [], claims: [0] }] };
  return { claims: data.existing?.body?.includes(answer) ? [] : [0], conflict: false };
} };
function observe(service: SessionIngestor, run = "run", stream = events(run), value = input(run), complete = true) {
  const observer = new RunCompletionObserver("a", settings, value, service);
  stream.forEach(e => observer.event(e)); if (complete) observer.complete();
}
const scope = { principal: "owner", projectId: "project", botId: "a", threadId: "query", runId: "query" };
const hits = (store: WikiStore, patch = {}) => new WikiGraphProvider(store).query({ ...scope, ...patch }, { text: "database recovery", limit: 10 }, new AbortController().signal);

test("successful run persists only this turn, multiple final messages, true session provenance and conservative verification", async () => {
  const { store, queue, sessions } = setup();
  observe(sessions);
  const job = queue.claim(ns)!; const source = queue.source(job);
  expect(source.provenance).toEqual({ botId: "a", threadId: "thread", runId: "run" });
  expect(source.content).toContain(answer); expect(source.content).toContain("second");
  expect(source.content).not.toContain("old history");
  expect(source.classification).toContain("assistant-unverified");
  queue.cancel(ns, job.id); queue.retry(ns, job.id);
  await new WikiCompiler(queue, model).runNext(ns);
  const page = store.read(store.active(namespaceKey(ns), "recovery")!);
  expect(page.verification).toBe("unverified"); expect(page.sources).toEqual([source.provenance]);
  expect(page.body).toContain("[assistant-unverified]");
  expect((await hits(store)).status).toBe("ok");
});
test.each(["interrupt", "error", "cancel", "disconnect", "mismatch", "open-message", "bad-start", "no-start", "resume", "secret", "chitchat", "late-error"])("%s never learns", mode => {
  const { store, sessions } = setup();
  let stream: any[] = events(), value = input();
  if (mode === "interrupt") stream.at(-1).outcome = { type: "interrupt" };
  if (mode === "error") stream[3] = { type: "RUN_ERROR" };
  if (mode === "mismatch") stream.at(-1).runId = "other";
  if (mode === "bad-start") stream[0].threadId = "other";
  if (mode === "no-start") stream.shift();
  if (mode === "open-message") stream.splice(3, 1);
  if (mode === "resume") value = { ...value, resume: [{ interruptId: "i", status: "resolved", payload: "yes" }] };
  if (mode === "secret") stream = events("run", "Research api_key=do-not-store database secret credential output");
  if (mode === "chitchat") { stream = events("run", "hello").filter(e => e.messageId !== "second"); value.messages = [{ id: "u", role: "user", content: "hi" }]; }
  if (mode === "late-error") stream.push({ type: "RUN_ERROR" });
  observe(sessions, "run", stream, value, !["cancel", "disconnect"].includes(mode));
  expect(store.db.prepare("SELECT count(*) AS n FROM ingest_jobs").get()!.n).toBe(0);
  if (mode === "resume") expect(sessions.metrics.resumeSkipped).toBe(1);
});
test("reasoning and unapproved tool output are excluded; repeated completion, repeated knowledge and restart deduplicate", () => {
  const { store, sessions, root } = setup();
  const stream = events();
  stream.splice(2, 0, { type: "REASONING_MESSAGE_CONTENT", delta: "hidden reasoning" } as any,
    { type: "TOOL_CALL_RESULT", content: "tool secret" } as any);
  observe(sessions, "run", stream); observe(sessions); observe(sessions, "another");
  expect(store.db.prepare("SELECT count(*) AS n FROM ingest_jobs").get()!.n).toBe(1);
  expect(String(store.db.prepare("SELECT content FROM document_sources").get()!.content)).not.toMatch(/hidden reasoning|tool secret/);
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new WikiStore(root); stores.push(reopened);
  observe(new SessionIngestor(new DocumentIngestor(reopened)));
  expect(reopened.db.prepare("SELECT count(*) AS n FROM ingest_jobs").get()!.n).toBe(1);
});
test("a completion retries after storage failure and cannot republish after revocation", async () => {
  const { store, queue, sessions } = setup();
  const token = "completion-fixture-token-over-32-characters";
  const api = createCompletionApi(sessions, token);
  const body = { namespace: ns, threadId: "thread", runId: "durable-run", messageId: "user",
    user: "Research database recovery", assistants: [{ id: "final", text: answer }] };
  const deliver = () => api(new Request("http://internal/internal/graph/completions", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }));
  store.db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON ingest_jobs BEGIN SELECT RAISE(ABORT, 'test'); END;");
  await expect(deliver()).rejects.toThrow();
  store.db.exec("DROP TRIGGER reject_completion");

  expect((await deliver()).status).toBe(204);
  const compiler = new WikiCompiler(queue, model);
  const job = (await compiler.runNext(ns))!;
  const active = store.active(namespaceKey(ns), "recovery");
  expect(active).toBeDefined();
  expect((await deliver()).status).toBe(204);
  expect(await compiler.runNext(ns)).toBeUndefined();
  expect(store.active(namespaceKey(ns), "recovery")).toEqual(active);

  queue.revoke(ns, queue.status(ns, job).source);
  expect((await deliver()).status).toBe(204);
  expect(await compiler.runNext(ns)).toBeUndefined();
  expect(store.active(namespaceKey(ns), "recovery")).toBeUndefined();
});

test("A learns; B sees nothing until explicit original-source sharing; C never sees it; revoke withdraws mixed pages and shared copies", async () => {
  const { store, queue, sessions } = setup();
  const provider = new WikiGraphProvider(store);
  const evolution = new MemoryEvolution({ provider, compiler: model }, () => true, () => true);
  observe(sessions); await evolution.tick();
  const job = store.db.prepare("SELECT * FROM ingest_jobs").get()!;
  expect((await hits(store, { botId: "b" }) as any).hits).toEqual([]);
  const sharedJob = sessions.share(ns, String(job.source));
  const shared = { ...ns, visibility: "project_shared" as const };
  await new WikiCompiler(queue, model).runNext(shared);
  expect(queue.status(shared, sharedJob).state).toBe("completed");
  expect((await hits(store, { botId: "b" }) as any).hits.length).toBeGreaterThan(0);
  for (const other of [{ principal: "stranger" }, { projectId: "other" }]) expect((await hits(store, other) as any).hits).toEqual([]);
  // A separately imported private document cannot contaminate shared compilation.
  queue.enqueue(ns, { title: "private", mime: "text/plain", content: "private contamination", idempotencyKey: "private" });
  const sharedPage = store.read(store.active(namespaceKey(shared), "recovery")!);
  expect(sharedPage.body).not.toContain("contamination");
  evolution.revoke(ns, String(job.source));
  store.reindex();
  expect((await hits(store, { botId: "b" }) as any).hits).toEqual([]);
  expect(() => sessions.share(ns, String(job.source))).toThrow();
  expect(queue.status(shared, sharedJob).state).toBe("cancelled");
  await evolution.close();
});
test("bot/project/ACL loss cancels pending jobs, withdraws learned data and prevents in-flight publication", async () => {
  const { store, sessions } = setup(); const provider = new WikiGraphProvider(store); let retained = true;
  const evolution = new MemoryEvolution({ provider, compiler: { async json(stage, data, signal) {
    if (stage === "merge") { retained = false; evolution.reconcile(); }
    return model.json(stage, data, signal);
  } } }, () => retained, () => retained);
  observe(sessions); await evolution.tick();
  expect(store.db.prepare("SELECT state FROM ingest_jobs").get()!.state).toBe("cancelled");
  expect(evolution.metrics).toMatchObject({ compiled: 0, errors: 1 });
  expect(store.diagnostics().pages).toBe(0);
  await evolution.close();
});
test("health detects graph issues, conflicts, stale provenance and index drift without deleting pages", async () => {
  const { store, sessions, queue } = setup(); observe(sessions); await new WikiCompiler(queue, model).runNext(ns);
  store.db.prepare("DELETE FROM sections WHERE ns=? AND page='recovery'").run(namespaceKey(ns));
  expect(wikiHealth(queue, ns)).toMatchObject({ pages: 2, indexDrift: 1, isolated: 2, pending: 0 });
  store.reindex(ns); expect(wikiHealth(queue, ns).indexDrift).toBe(0);
});

test("explicit user confirmation stays distinct from an assistant claim and never grants verified status", async () => {
  const { queue, store, sessions } = setup();
  const decision = "I confirm database backups must be tested monthly.";
  const job = sessions.ingest({ namespace: ns, threadId: "confirmed", runId: "confirmed", messageId: "decision", user: decision,
    assistants: [{ id: "finding", text: answer }] })!;
  await new WikiCompiler(queue, { async json(stage) {
    if (stage === "analysis") return { claims: [decision, answer].map(text => ({ text, quote: text, certainty: "fact", conflict: false })) };
    if (stage === "generation") return { pages: [{ id: "decision", title: "Decision", type: "decision", tags: [], related: [], claims: [0, 1] }] };
    return { claims: [0, 1], conflict: false };
  } }).runNext(ns);
  expect(queue.status(ns, job).state).toBe("completed");
  const page = store.read(store.active(namespaceKey(ns), "decision")!);
  expect(page.body).toContain(`[user-confirmed decision] ${decision}`);
  expect(page.body).toContain(`[assistant-unverified] ${answer}`);
  expect(page.verification).toBe("unverified");
});


test("an unavailable authorization service cannot turn a completed run into an error", () => {
  const { store, queue } = setup();
  const sessions = new SessionIngestor(queue, () => { throw new Error("policy unavailable"); });
  expect(() => observe(sessions)).not.toThrow();
  expect(sessions.metrics.errors).toBe(1);
  expect(store.db.prepare("SELECT count(*) AS n FROM ingest_jobs").get()!.n).toBe(0);
});
