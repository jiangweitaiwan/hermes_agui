export {};
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
process.env.DO_NOT_TRACK = "1";

async function main() {
  if (!process.env.AGUI_BOTS_CONFIG) throw new Error("Deployment configuration required");
  const [command, id] = process.argv.slice(2);
  if (!["process", "tick", "reconcile"].includes(command) || (command === "process" && !id)) throw new Error("Expected process JOB_ID | tick | reconcile");
  const { readFile } = await import("node:fs/promises");
  const { bootstrap } = await import("../bootstrap");
  const { WORKER_SHUTDOWN } = await import("./compiler");
  const { application, wiki, threadMappings,releases,adminStore } = await bootstrap(JSON.parse(await readFile(process.env.AGUI_BOTS_CONFIG, "utf8")), { evolutionTimer: false });
  const evolution = application.evolution;
  const stop = () => evolution?.controller.abort(WORKER_SHUTDOWN);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (!evolution) throw new Error("Graph evolution required");
    if (command === "process") {
      const job = await evolution.processJob(id);
      console.log(JSON.stringify({ id: job.id, state: job.state, attempt: job.attempt }));
      if (job.state !== "completed") process.exitCode = 1;
    } else {
      if (command === "tick") await evolution.tick(); else await evolution.reconcile();
      console.log(JSON.stringify(await evolution.queue.metrics()));
    }
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await application.close(); await wiki?.close(); await threadMappings?.close();await releases?.close();await adminStore?.close();
  }
}
main().catch(() => { console.error("Graph worker command failed; inspect scoped job status and deployment references."); process.exitCode = 1; });
