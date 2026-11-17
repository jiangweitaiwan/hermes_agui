import { z } from "zod";
import type { RuntimeSettings } from "../runtime";

export const BotInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  harness: z.enum(["hermes", "remote_ag_ui"]),
  templateId: z.string().min(1).max(64),
  skills: z.array(z.string().min(1).max(100)).max(32).default([]),
  toolsets: z.array(z.string().min(1).max(100)).max(32).default([]),
  delegationTargets: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(32).default([]),
}).strict();
export type BotInput = z.infer<typeof BotInputSchema>;
export interface Identity { ownerId: string; principal: string; projectId: string }
export interface BotRecord extends BotInput {
  id: string; ownerId: string; projectId: string;
  status: "provisioning" | "active" | "disabled" | "failed";
  model: string; provider: string;
  createdAt: string; updatedAt: string; deletedAt?: string;
}
export interface HostSpec {
  id: string; name: string; description: string; templateId: string; principal: string; projectId: string;
  token: string; memoryKey: string; skills: string[]; toolsets: string[];
}
export interface StoredBot { record: BotRecord; runtime: RuntimeSettings; spec?: HostSpec }
export interface BotTemplate {
  id: string; name: string; harness: "hermes" | "remote_ag_ui";
  model: string; provider: string; skills: string[]; toolsets: string[];
  /** Only administrator-approved remote endpoints may be registered. */
  remote?: RuntimeSettings;
}
export class BotError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const publicBot = (bot: StoredBot): BotRecord => structuredClone(bot.record);
