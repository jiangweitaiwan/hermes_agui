import type { BotManagementSettings } from "./application";

interface DeploymentManagement extends Omit<BotManagementSettings, "hostToken" | "users"> {
  hostTokenEnv: string;
  users: { ownerId: string; principal: string; projectId: string; tokenEnv: string }[];
}
export function loadManagement(settings?: DeploymentManagement): BotManagementSettings | undefined {
  if (!settings) return undefined;
  const { hostTokenEnv, users, ...behavior } = settings;
  return { ...behavior, hostToken: process.env[hostTokenEnv] ?? "",
    users: users.map(({ tokenEnv, ...identity }) => ({ ...identity, token: process.env[tokenEnv] ?? "" })) };
}
