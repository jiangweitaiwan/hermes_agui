/** Invoked by the Python acceptance test against its real native HTTP host. */
import { createApplication } from "../../server/application";
import { FakeGraphProvider } from "../../server/memory/fake-provider";

const application = createApplication({ hermes: {
  agentUrl: process.argv[2], token: "runtime-test-token",
  memory: { key: "runtime-only-key", principal: "local-owner", projectId: "alpha" },
} }, { graph: { authorize: scope => scope.principal === "local-owner" && scope.projectId === "alpha",
  provider: new FakeGraphProvider([{
    recordId: "runtime-acceptance-fact", content: "Project Alpha 使用 PostgreSQL", visibility: "project_shared",
    principal: "local-owner", projectId: "alpha", source: { botId: "researcher", threadId: "origin", runId: "origin" },
  }]),
} });
const response = await application.runtime(new Request("http://localhost/api/copilotkit/agent/hermes/run", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    threadId: "acceptance", runId: "acceptance-run", messages: [{ id: "question", role: "user",
      content: "Project Alpha 使用什麼資料庫？" }], tools: [], context: [], state: {}, forwardedProps: {},
  }),
}));
const output = await response.text();
const events = output.split("\n").filter(line => line.startsWith("data: "))
  .map(line => JSON.parse(line.slice(6)));
const answer = events.filter(event => event.type === "TEXT_MESSAGE_CONTENT").map(event => event.delta).join("");
if (response.status !== 200 || !output.includes("RUN_FINISHED") || !answer.includes("PostgreSQL")) {
  throw new Error(`Runtime to Hermes acceptance failed (${response.status}): ${output}`);
}
