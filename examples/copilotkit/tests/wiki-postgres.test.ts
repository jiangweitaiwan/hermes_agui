import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FilesystemGraphObjects } from "../server/graph/objects";
import { PostgresWikiStore } from "../server/graph/postgres-wiki-store";
import { WikiRetriever } from "../server/graph/retriever";
import { namespaceKey } from "../server/graph/wiki-store";

const databaseUrl = process.env.HERMES_AGUI_TEST_RUNTIME_DATABASE_URL;

function input(body: string, expectedRevision: string | null = null) {
  return { expectedRevision, markdown: `---
id: database
title: database
type: note
sources:
  - botId: a
    threadId: recorded-thread
    runId: recorded-run
tags: []
related: []
created: 2026-11-17T00:00:00.000Z
updated: 2026-11-17T00:00:00.000Z
---
${body}` };
}

test("external Graph objects enforce create-only writes, generation and byte integrity", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "graph-objects-"));
  try {
    const store = new FilesystemGraphObjects(root);
    const object = await store.create("wiki/test.md", Buffer.from("資料庫"));
    await expect(store.create(object.key, Buffer.from("updated"))).rejects.toMatchObject({ code: "EEXIST" });
    await expect(store.read({ ...object, generation: "different" })).rejects.toThrow("generation");
    expect((await store.read(object)).toString()).toBe("資料庫");
    await writeFile(join(root, object.key), "資料集");
    await expect(store.read(object)).rejects.toThrow("integrity");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(!databaseUrl)("PostgreSQL wiki publication fences competing revisions and is readable by a fresh store", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "graph-objects-"));
  const store = new PostgresWikiStore(databaseUrl!, new FilesystemGraphObjects(root));
  const second = new PostgresWikiStore(databaseUrl!, new FilesystemGraphObjects(root));
  const namespace = { principal: randomUUID(), projectId: "project", botId: "a", visibility: "bot_private" as const };
  const scope = { ...namespace, threadId: "current", runId: "current-run" };
  const retriever = new WikiRetriever(second);
  const query = (principal: string = scope.principal) => retriever.query({ ...scope, principal }, { text: "資料庫", limit: 10 }, new AbortController().signal);
  try {
    await store.ready();
    const [revision] = await store.import(namespace, [input("繁體中文資料庫搜尋")]);
    expect((await query()).map(hit => hit.content)).toEqual(["繁體中文資料庫搜尋"]);
    expect(await query("other")).toEqual([]);
    await expect(store.import(namespace, [input("資料庫未發布", revision)], async client => {
      await client.query("SELECT 1 / 0");
    })).rejects.toThrow("division by zero");
    expect((await query()).map(hit => hit.content)).toEqual(["繁體中文資料庫搜尋"]);
    const namespaceId = namespaceKey(namespace);
    const originalSections = await second.unindexedSections(namespaceId, "test-model");
    expect(originalSections.map(section => section.revision)).toEqual([revision]);
    const updates = await Promise.allSettled([
      store.import(namespace, [input("資料庫版本甲", revision)]),
      second.import(namespace, [input("資料庫版本乙", revision)]),
    ]);
    expect(updates.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.find(result => result.status === "rejected")).toMatchObject({ reason: new Error("Revision conflict") });
    expect(await second.indexEmbeddings("test-model", originalSections, [[1]])).toBe(0);
    expect(await second.indexedEmbeddings(namespaceId, "test-model")).toEqual([]);
    const active = await second.active(namespaceId, "database");
    expect(active?.revision).not.toBe(revision);
    expect((await query())[0].recordId).toBe(`${active?.revision}:0`);
  } finally {
    await Promise.all([store.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
