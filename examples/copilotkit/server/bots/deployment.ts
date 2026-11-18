import type { BotManagementSettings } from "./application";

interface DeploymentManagement extends Omit<BotManagementSettings, "hostToken" | "users" | "postgres"> {
  hostTokenEnv: string;
  users: { ownerId: string; principal: string; projectId: string; tokenEnv: string }[];
}
export function loadManagement(settings?: DeploymentManagement): BotManagementSettings | undefined {
  if (!settings) return undefined;
  const { hostTokenEnv, users, ...behavior } = settings;
  return { ...behavior, postgres: undefined, hostToken: process.env[hostTokenEnv] ?? "",
    users: users.map(({ tokenEnv, ...identity }) => ({ ...identity, token: process.env[tokenEnv] ?? "" })) };
}

export interface DeploymentBot {
  id: string; agentUrl: string; tokenEnv: string;
  threadScope?: { principal: string; projectId: string };
  memory?: { keyEnv: string; principal: string; projectId: string };
}
export function loadDeployedBots(bots: DeploymentBot[]) {
  if (!Array.isArray(bots) || new Set(bots.map(bot => bot.id)).size !== bots.length) throw new Error("Configure unique Bot IDs");
  return Object.fromEntries(bots.map(bot => [bot.id, {
    agentUrl: bot.agentUrl, token: process.env[bot.tokenEnv] ?? "", threadScope: bot.threadScope,
    memory: bot.memory ? { key: process.env[bot.memory.keyEnv] ?? "", principal: bot.memory.principal, projectId: bot.memory.projectId } : undefined,
  }]));
}
