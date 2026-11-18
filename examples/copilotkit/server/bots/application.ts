import { PostgresBotRegistry } from "../storage/bot-registry";
import { BotRegistry } from "./registry";
import { BotManager } from "./manager";
import { BotAuthentication, type UserCredential } from "./auth";
import { HermesHostClient } from "./host-client";
import { createBotApi } from "./api";
import type { BotTemplate, StoredBot } from "./types";
import type { RuntimeSettings } from "../runtime";

export interface BotManagementSettings {
  registryPath?: string; postgres?: { url: string; credentialSeed: string }; hostUrl: string; hostToken: string;
  users: UserCredential[]; templates: BotTemplate[];
  maxBotsPerOwner?: number; maxRecords?: number;
  bootstrapOwnerId?: string;
}
export function createBotManagement(settings: BotManagementSettings, bots: Record<string, RuntimeSettings>, allow: Record<string, string[]>) {
  const host = new HermesHostClient(settings.hostUrl, settings.hostToken);
  const auth = new BotAuthentication(settings.users);
  const templates = [...settings.templates];
  const owner = settings.users.find(user => user.ownerId === (settings.bootstrapOwnerId ?? settings.users[0].ownerId));
  if (!owner) throw new Error("Unknown bootstrap owner");
  const deployed = Object.entries(bots);
  for (const [id, runtime] of deployed) {
    const templateId = `deployed-${id}`;
    templates.push({ id: templateId, name: id, harness: "remote_ag_ui", model: "deployed", provider: "deployed",
      skills: [], toolsets: [], remote: runtime });
    delete bots[id];
  }
  if (!settings.postgres && !settings.registryPath) throw new Error("Configure a local Bot registry path");
  const registry = settings.postgres
    ? new PostgresBotRegistry(settings.postgres.url, settings.postgres.credentialSeed, templates, settings.users, id => host.agentUrl(id))
    : new BotRegistry(settings.registryPath!);
  const bootstrap = () => {
    const writes: Promise<void>[] = [];
    for (const [id, runtime] of deployed) {
      if (registry.get(id)) continue;
      const templateId = `deployed-${id}`;
      const now = new Date().toISOString();
      const stored: StoredBot = { runtime, record: { id, name: id, description: "Deployment Bot", harness: "remote_ag_ui",
        templateId, model: "deployed", provider: "deployed", skills: [], toolsets: [], delegationTargets: allow[id] ?? [],
        ownerId: owner.ownerId, projectId: owner.projectId, status: "active", createdAt: now, updatedAt: now } };
      writes.push(Promise.resolve(registry.put(stored)));
    }
    return Promise.all(writes).then(() => undefined);
  };
  const pending = settings.postgres ? undefined : bootstrap();
  const manager = new BotManager({ registry, host, agentUrl: id => host.agentUrl(id), templates,
    maxBotsPerOwner: settings.maxBotsPerOwner, maxRecords: settings.maxRecords }, bots, allow);
  const api = createBotApi(manager, auth);
  return { manager, auth, api, restore: () => manager.restore(pending ? () => pending : bootstrap), close: () => registry.close() };
}
