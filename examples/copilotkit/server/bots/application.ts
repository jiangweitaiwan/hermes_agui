import { BotRegistry } from "./registry";
import { BotManager } from "./manager";
import { BotAuthentication, type UserCredential } from "./auth";
import { HermesHostClient } from "./host-client";
import { createBotApi } from "./api";
import type { BotTemplate, StoredBot } from "./types";
import type { RuntimeSettings } from "../runtime";

export interface BotManagementSettings {
  registryPath: string; hostUrl: string; hostToken: string;
  users: UserCredential[]; templates: BotTemplate[];
  maxBotsPerOwner?: number; maxRecords?: number;
  bootstrapOwnerId?: string;
}
export function createBotManagement(settings: BotManagementSettings, bots: Record<string, RuntimeSettings>, allow: Record<string, string[]>) {
  const registry = new BotRegistry(settings.registryPath);
  const host = new HermesHostClient(settings.hostUrl, settings.hostToken);
  const auth = new BotAuthentication(settings.users);
  const templates = [...settings.templates];
  const owner = settings.users.find(user => user.ownerId === (settings.bootstrapOwnerId ?? settings.users[0].ownerId));
  if (!owner) throw new Error("Unknown bootstrap owner");
  for (const [id, runtime] of Object.entries(bots)) {
    const templateId = `deployed-${id}`;
    templates.push({ id: templateId, name: id, harness: "remote_ag_ui", model: "deployed", provider: "deployed",
      skills: [], toolsets: [], remote: runtime });
    if (!registry.get(id)) {
      const now = new Date().toISOString();
      const stored: StoredBot = { runtime, record: { id, name: id, description: "Deployment Bot", harness: "remote_ag_ui",
        templateId, model: "deployed", provider: "deployed", skills: [], toolsets: [], delegationTargets: allow[id] ?? [],
        ownerId: owner.ownerId, projectId: owner.projectId, status: "active", createdAt: now, updatedAt: now } };
      registry.put(stored);
    }
    delete bots[id];
  }
  const manager = new BotManager({ registry, host, agentUrl: id => host.agentUrl(id), templates,
    maxBotsPerOwner: settings.maxBotsPerOwner, maxRecords: settings.maxRecords }, bots, allow);
  const api = createBotApi(manager, auth);
  return { manager, auth, api, close: () => registry.close() };
}
