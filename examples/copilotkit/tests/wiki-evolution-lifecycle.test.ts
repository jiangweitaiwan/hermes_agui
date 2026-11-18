import { expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../server/application";
import { WikiStore } from "../server/graph/wiki-store";
import { WikiGraphProvider } from "../server/graph/provider";
import { WikiCompiler } from "../server/graph/compiler";
import { DocumentIngestor } from "../server/graph/ingest-queue";

const ns = { principal: "owner", projectId: "project", botId: "a", visibility: "bot_private" as const };
const finding = "Research finding: database recovery needs regular durable checkpoint backups.";
const compiler = { async json(stage: string) {
  if (stage === "analysis") return { claims: [{ text: finding, quote: finding, certainty: "fact", conflict: false }] };
  if (stage === "generation") return { pages: [{ id: "recovery", title: "Recovery", type: "finding", tags: [], related: [], claims: [0] }] };
  return { claims: [0], conflict: false };
} };
test.each(["delete", "project", "policy", "owner-access"])("%s revokes learned session/doc/shared knowledge and pending jobs through real application lifecycle", async mode => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-lifecycle-"));
  const store = new WikiStore(join(root, "wiki")), provider = new WikiGraphProvider(store);
  const user = { ownerId: "owner", principal: "owner", projectId: "project", token: "owner-key" };
  const bot = { agentUrl: "http://127.0.0.1:8000/agent", token: "upstream", memory: { principal: "owner", projectId: "project", key: "signer" } };
  let allowed = true;
  const app = createApplication({ a: bot, b: bot }, {
    graph: { provider, authorize: () => allowed }, evolution: { provider, compiler, pollMs: 60000 },
    management: { registryPath: join(root, "bots.sqlite"), hostUrl: "http://127.0.0.1:8000", hostToken: "host", users: [user], templates: [] },
  });
  try {
    await app.ready;
    const evolution = app.evolution!, queue = evolution.queue;
    const session = (await evolution.sessions.ingest({ namespace: ns, threadId: "t", runId: "r", messageId: "u", user: "I confirm database recovery needs regular backups", assistants: [{ id: "a", text: finding }] }))!;
    await evolution.tick();
    const source = (await queue.status(ns, session)).source;
    await evolution.sessions.share(ns, source); await evolution.tick();
    const document = await queue.enqueue(ns, { title: "document", mime: "text/plain", content: finding, idempotencyKey: "doc" });
    await evolution.tick();
    const pending = await queue.enqueue(ns, { title: "pending", mime: "text/plain", content: finding, idempotencyKey: "pending" });
    expect(store.diagnostics().pages).toBeGreaterThan(0);
    if (mode === "delete") await app.management!.manager.deactivate("a", user, true);
    if (mode === "project") {
      const saved = app.management!.manager.options.registry.get("a")!;
      saved.runtime.memory!.projectId = "changed";
      app.management!.manager.options.registry.put(saved);
    }
    if (mode === "policy") allowed = false;
    if (mode === "owner-access") user.projectId = "revoked";
    await evolution.reconcile();
    expect((await queue.status(ns, pending)).state).toBe("cancelled");
    expect((await queue.status(ns, document)).state).toBe("cancelled");
    const result = await provider.query({ principal: "owner", projectId: "project", botId: "b", threadId: "q", runId: "q" }, { text: "recovery", limit: 10 }, new AbortController().signal);
    expect(result).toEqual({ status: "ok", hits: [] });
    store.reindex(); expect(store.diagnostics().pages).toBe(0);
    await queue.rebuild(ns); await new WikiCompiler(queue, compiler).runNext(ns);
    expect(store.diagnostics().pages).toBe(0);
  } finally { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
test("restart reconciles sources queued under a removed bot before a worker can compile", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-restart-"));
  let store = new WikiStore(root); const queue = new DocumentIngestor(store);
  queue.enqueue(ns, { title: "old", mime: "text/plain", content: finding, idempotencyKey: "old" }); store.close();
  store = new WikiStore(root); const provider = new WikiGraphProvider(store);
  const app = createApplication({}, { graph: { provider, authorize: () => true }, evolution: { provider, compiler, pollMs: 60000 } });
  try {
    await app.ready; await app.evolution!.tick();
    expect(store.db.prepare("SELECT state FROM ingest_jobs").get()!.state).toBe("cancelled");
    expect(store.diagnostics().pages).toBe(0);
  } finally { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("evolution refuses an ambiguous owner/principal deployment before opening the management registry", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-owner-")); const store = new WikiStore(root);
  const provider = new WikiGraphProvider(store);
  try {
    expect(() => createApplication({}, { graph: { provider, authorize: () => true }, evolution: { provider, compiler },
      management: { registryPath: join(root, "bots.sqlite"), hostUrl: "http://localhost:8000", hostToken: "host", templates: [],
        users: [{ ownerId: "a", principal: "aliased", projectId: "p", token: "a-key" }, { ownerId: "b", principal: "aliased", projectId: "p", token: "b-key" }] },
    })).toThrow("distinct owner principals");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("authorized shared document updates preserve the author of each version across bots", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-authors-")), store = new WikiStore(root);
  const queue = new DocumentIngestor(store), shared = { ...ns, visibility: "project_shared" as const };
  try {
    const first = queue.enqueue(shared, { title: "shared", mime: "text/plain", content: finding, idempotencyKey: "v1" });
    await new WikiCompiler(queue, compiler).runNext(shared);
    const sourceId = queue.status(shared, first).source;
    const second = queue.enqueue({ ...shared, botId: "b" }, { sourceId, title: "shared", mime: "text/plain", content: finding + " Revised evidence.", idempotencyKey: "v2" });
    await new WikiCompiler(queue, compiler).runNext(shared);
    expect(queue.status(shared, second).state).toBe("completed");
    const { namespaceKey } = await import("../server/graph/wiki-store");
    const sources = store.read(store.active(namespaceKey(shared), "recovery")!).sources;
    expect(sources).toEqual([expect.objectContaining({ kind: "document", botId: "a", version: 1 }), expect.objectContaining({ kind: "document", botId: "b", version: 2 })]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
