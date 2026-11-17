import { test, expect } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("trusted CLI ingests, compiles, reports, revokes and rebuilds with mock HTTP LLM", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-cli-"));
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); seen.push(body);
    const stage = body.messages[0].content;
    const result = stage.endsWith("analysis") ? { claims: [{ text: "database PostgreSQL", quote: "database PostgreSQL", certainty: "fact", conflict: false }] } :
      stage.endsWith("generation") ? { pages: [{ id: "database", title: "Database", type: "concept", tags: [], related: [], claims: [0] }] } : { claims: [0], conflict: false };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("port");
  const config = join(root, "server.json"), upload = join(root, "upload.json");
  writeFileSync(config, JSON.stringify({ namespace: { principal: "owner", projectId: "project", botId: "a", visibility: "bot_private" },
    compiler: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "mock", keyEnv: "WIKI_CLI_TEST_KEY" } }));
  writeFileSync(upload, JSON.stringify({ title: "Database policy", mime: "text/plain", content: "database PostgreSQL", idempotencyKey: "one" }));
  const command = async (...args: string[]) => {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "server/graph/ingest-cli.ts", root, config, ...args],
      { env: { ...process.env, WIKI_CLI_TEST_KEY: "mock-key" }, timeout: 20000 });
    return JSON.parse(result.stdout);
  };
  try {
    const accepted = await command("enqueue", upload); expect(accepted.status).toBe("accepted");
    expect((await command("enqueue", upload)).jobId).toBe(accepted.jobId);
    expect((await command("status", accepted.jobId)).state).toBe("pending");
    await command("work");
    const completed = await command("status", accepted.jobId); expect(completed.state).toBe("completed");
    expect(seen).toHaveLength(3); expect(seen[0].messages[0].content).toContain("UNTRUSTED DATA");
    await command("delete", completed.sourceId);
    expect((await command("status", accepted.jobId)).state).toBe("cancelled");
    await command("rebuild"); expect((await command("work")).processedJobId).toBeNull();
    await expect(command("status", "unknown")).rejects.toThrow("Graph ingest command failed");
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
