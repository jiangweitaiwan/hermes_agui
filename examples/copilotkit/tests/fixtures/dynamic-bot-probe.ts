/** Real Runtime + registry + management API against a native Hermes HTTP Host. */
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../server/application";
import { createDelegationServer } from "../../server/delegation-http";
import { FakeGraphProvider } from "../../server/memory/fake-provider";
import type { BotRecord } from "../../server/bots/types";

const [hostUrl, registryPath, portText] = process.argv.slice(2);
const graph = new FakeGraphProvider([]);
const management = { registryPath, hostUrl, hostToken: "host-manager-secret",
  users: [{ ownerId: "owner", principal: "owner", projectId: "alpha", token: "owner-token" }],
  templates: [{ id: "native", name: "Native", harness: "hermes" as const, model: "fake-model", provider: "custom",
    skills: [], toolsets: ["memory", "skills"] }],
};
const options = { management, graph: { provider: graph, authorize: () => true },
  delegation: { token: "delegation-secret", allow: {} } };
let app = createApplication({}, options);
await app.ready;
async function startInternal() {
  const server = createDelegationServer(app.delegation!);
  server.listen(Number(portText), "127.0.0.1");
  await once(server, "listening");
  return server;
}
async function stopInternal(server: ReturnType<typeof createDelegationServer>) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
let internal = await startInternal();
async function api(path: string, method = "GET", value?: unknown) {
  const response = await app.management!.api(new Request(`http://local/api/bots${path}`, {
    method, headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  }));
  if (!response.ok) throw new Error(`Management failed: ${response.status}: ${await response.text()}`);
  return response;
}
async function chat(id: string, text: string, threadId = "same-thread") {
  const response = await app.runtime(new Request(`http://local/api/copilotkit/agent/${id}/run`, {
    method: "POST", headers: { Authorization: "Bearer owner-token", "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, runId: randomUUID(), state: {}, context: [], tools: [], forwardedProps: {},
      messages: [{ id: randomUUID(), role: "user", content: text }] }),
  }));
  const output = await response.text();
  if (!response.ok || output.includes("RUN_ERROR") || !output.includes("RUN_FINISHED")) {
    throw new Error(`Dynamic chat failed: ${response.status}: ${output}`);
  }
  const answer = output.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
    .filter(event => event.type === "TEXT_MESSAGE_CONTENT").map(event => event.delta).join("");
  return answer;
}
try {
  const create = (name: string) => api("", "POST", { name, description: `${name} native role`, harness: "hermes",
    templateId: "native", toolsets: ["memory", "skills"] }).then(r => r.json() as Promise<BotRecord>);
  const parent = await create("Researcher"), child = await create("Reviewer");
  for (const [id, visibility, botId] of [["private-parent", "bot_private", parent.id],
    ["private-child", "bot_private", child.id], ["shared-fact", "project_shared", parent.id]] as const) {
    graph.hits.push({ recordId: id, content: id === "shared-fact" ? "Project Alpha 使用 PostgreSQL" : id,
      visibility, principal: "owner", projectId: "alpha", source: { botId, threadId: "source", runId: "source" } });
  }
  await api(`/${parent.id}`, "PATCH", { delegationTargets: [child.id] });
  if (await chat(parent.id, "Project Alpha 使用什麼資料庫？") !== "PostgreSQL") throw new Error("Graph response missing");
  if (await chat(child.id, "Project Alpha 使用什麼資料庫？") !== "PostgreSQL") throw new Error("Child isolation missing");
  await api(`/${parent.id}`, "PATCH", { name: "Researcher Updated" });
  await chat(parent.id, "continue");
  const result = await chat(parent.id, `delegate ${child.id}`, "parent-delegation");
  if (!result.includes("Delegation completed: PostgreSQL")) throw new Error(`Delegation failed: ${result}`);
  await api(`/${child.id}/disable`, "POST");
  const blocked = await app.runtime(new Request(`http://local/api/copilotkit/agent/${child.id}/run`, {
    method: "POST", headers: { Authorization: "Bearer owner-token" }, body: "{}",
  }));
  if (blocked.status !== 404) throw new Error("Disabled bot accepted a new run");
  const denied = await chat(parent.id, `delegate ${child.id}`, "denied-delegation");
  if (!denied.includes("Delegation denied")) throw new Error("Disabled delegation target was admitted");
  await api(`/${child.id}/enable`, "POST");
  // Reopen the persistent Runtime registry while the Host remains online.
  app.close();
  await stopInternal(internal);
  app = createApplication({}, options);
  await app.ready;
  internal = await startInternal();
  await chat(parent.id, "continue", "same-thread");
  const restartedResult = await chat(parent.id, `delegate ${child.id}`, "restarted-delegation");
  if (!restartedResult.includes("Delegation completed: PostgreSQL")) throw new Error("Restored delegation failed");
  await api(`/${child.id}`, "DELETE");
  const listed = await (await api("")).json() as BotRecord[];
  if (listed.some(bot => bot.id === child.id) || !listed.some(bot => bot.id === parent.id)) throw new Error("Soft delete failed");
  process.stdout.write(JSON.stringify({ parent: parent.id, child: child.id }));
} finally {
  app.close();
  await stopInternal(internal);
}
