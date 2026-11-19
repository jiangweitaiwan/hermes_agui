import { configureCloud } from "../cloud";
import { readFile } from "node:fs/promises";
import { createBotManagement } from "./application";
import { loadDeployedBots, loadManagement } from "./deployment";
import { PostgresBotRegistry } from "../storage/bot-registry";

/** Trusted administrator entrypoint. The deployment file supplies behavior; secrets remain in env. */
async function main() {
  if (!process.env.AGUI_BOTS_CONFIG) throw new Error("AGUI_BOTS_CONFIG is required");
  const deployment = JSON.parse(await readFile(process.env.AGUI_BOTS_CONFIG, "utf8"));
  configureCloud(deployment.cloud);
  const settings = loadManagement(deployment.management);
  if (!settings) throw new Error("Bot management is required");
  const backend = deployment.storage?.botRegistry ?? "local";
  if (!["local", "postgres"].includes(backend)) throw new Error("Invalid Bot registry backend");
  if (backend === "postgres") settings.postgres = { url: process.env.AGUI_RUNTIME_DATABASE_URL ?? "", credentialSeed: process.env.AGUI_BOT_CREDENTIAL_SEED ?? "" };
  const management = createBotManagement(settings, loadDeployedBots(deployment.bots), deployment.delegation?.allow ?? {});
  try {
    await management.restore();
    const registry = management.manager.options.registry;
    if (registry instanceof PostgresBotRegistry) {
      const operations = await registry.provisioningStatus();
      console.log(JSON.stringify({ operations }));
      if (operations.some(operation => operation.status !== "applied")) process.exitCode = 1;
    } else console.log(JSON.stringify({ bots: management.manager.options.registry.all().map(bot => ({ id: bot.record.id, status: bot.record.status })) }));
  } finally { await management.close(); }
}
main().catch(() => { console.error("Bot reconciliation failed; inspect deployment references and protected Host status."); process.exitCode = 1; });
