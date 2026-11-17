import { randomBytes, randomUUID } from "node:crypto";
import type { RuntimeSettings } from "../runtime";
import { BotRegistry } from "./registry";
import type { HostPort } from "./host-client";
import { BotError, BotInputSchema, publicBot, type BotInput, type BotTemplate,
  type Identity, type StoredBot, type BotRecord } from "./types";

export interface BotManagerOptions {
  registry: BotRegistry; host: HostPort; agentUrl: (id: string) => string;
  templates: BotTemplate[]; maxBotsPerOwner?: number; maxRecords?: number;
}
/** One Runtime writer serializes lifecycle operations, including upstream acknowledgements. */
export class BotManager {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly options: BotManagerOptions, readonly bots: Record<string, RuntimeSettings>,
    readonly allow: Record<string, string[]>) {
    if ([options.maxBotsPerOwner ?? 32, options.maxRecords ?? 128].some(n => !Number.isInteger(n) || n < 1)) {
      throw new Error("Invalid Bot capacity");
    }
    if (!options.templates.length || new Set(options.templates.map(t => t.id)).size !== options.templates.length) {
      throw new Error("Configure unique managed Bot templates");
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  owned(id: string, identity: Identity, includeDeleted = false): StoredBot {
    const bot = this.options.registry.get(id);
    if (!bot || (!includeDeleted && bot.record.deletedAt) || bot.record.ownerId !== identity.ownerId ||
      bot.record.projectId !== identity.projectId) throw new BotError(404, "Unknown Bot");
    return bot;
  }
  listBots(identity: Identity): BotRecord[] {
    return this.options.registry.all().filter(bot => !bot.record.deletedAt &&
      bot.record.ownerId === identity.ownerId && bot.record.projectId === identity.projectId).map(publicBot);
  }
  private input(value: unknown, identity: Identity, id?: string): { input: BotInput; template: BotTemplate } {
    const parsed = BotInputSchema.safeParse(value);
    if (!parsed.success) throw new BotError(422, "Invalid Bot settings");
    const input = parsed.data;
    const template = this.options.templates.find(t => t.id === input.templateId && t.harness === input.harness);
    if (!template || input.skills.some(skill => !template.skills.includes(skill)) ||
      input.toolsets.some(tool => !template.toolsets.includes(tool))) throw new BotError(422, "Unapproved template or capability");
    for (const target of input.delegationTargets) {
      const bot = this.owned(target, identity);
      if (target === id || bot.record.status !== "active") throw new BotError(422, "Invalid delegation target");
    }
    return { input, template };
  }
  private publish(bot: StoredBot): void {
    const { id, status, deletedAt, delegationTargets } = bot.record;
    if (status === "active" && !deletedAt) {
      this.bots[id] = { ...structuredClone(bot.runtime), ownerId: bot.record.ownerId };
      this.allow[id] = [...delegationTargets];
    } else { delete this.bots[id]; delete this.allow[id]; }
  }
  private save(bot: StoredBot): void {
    bot.record.updatedAt = new Date().toISOString();
    this.options.registry.put(bot);
    this.publish(bot);
  }
  private async provision(bot: StoredBot): Promise<BotRecord> {
    bot.record.status = "provisioning";
    this.save(bot);
    try {
      if (bot.spec) await this.options.host.register(bot.spec);
      bot.record.status = "active";
      this.save(bot);
      return publicBot(bot);
    } catch (error) {
      bot.record.status = "failed";
      this.save(bot);
      throw error instanceof BotError ? error : new BotError(503, "Bot provisioning failed; retry is available");
    }
  }
  createBot(value: unknown, identity: Identity): Promise<BotRecord> {
    return this.serial(async () => {
      const { input, template } = this.input(value, identity);
      const records = this.options.registry.all();
      if (records.filter(bot => bot.record.ownerId === identity.ownerId && !bot.record.deletedAt).length >= (this.options.maxBotsPerOwner ?? 32) ||
        records.length >= (this.options.maxRecords ?? 128)) throw new BotError(409, "Bot quota reached");
      const id = `bot-${randomUUID()}`, now = new Date().toISOString();
      const token = randomBytes(32).toString("hex"), memoryKey = randomBytes(32).toString("hex");
      const record: BotRecord = { ...input, id, ownerId: identity.ownerId, projectId: identity.projectId,
        model: template.model, provider: template.provider, status: "provisioning", createdAt: now, updatedAt: now };
      const runtime: RuntimeSettings = template.harness === "remote_ag_ui" ? structuredClone(template.remote!) : {
        agentUrl: this.options.agentUrl(id), token,
        memory: { key: memoryKey, principal: identity.principal, projectId: identity.projectId },
      };
      if (!runtime?.agentUrl || !runtime.token) throw new BotError(422, "Template has no approved endpoint");
      const spec = template.harness === "hermes" ? { id, name: input.name, description: input.description, templateId: template.id, principal: identity.principal,
        projectId: identity.projectId, token, memoryKey, skills: input.skills, toolsets: input.toolsets } : undefined;
      return this.provision({ record, runtime, spec });
    });
  }
  updateBot(id: string, changes: unknown, identity: Identity): Promise<BotRecord> {
    return this.serial(async () => {
      const previous = this.owned(id, identity);
      const patch = BotInputSchema.partial().safeParse(changes);
      if (!patch.success) throw new BotError(422, "Invalid Bot update");
      const { input, template } = this.input({ ...this.editable(previous.record), ...patch.data }, identity, id);
      if (input.harness !== previous.record.harness) throw new BotError(422, "Harness cannot change");
      const next = structuredClone(previous);
      next.record = { ...next.record, ...input, model: template.model, provider: template.provider };
      if (next.spec) next.spec = { ...next.spec, name: input.name, description: input.description, templateId: input.templateId, skills: input.skills, toolsets: input.toolsets };
      else next.runtime = structuredClone(template.remote!);
      if (previous.record.status === "disabled") { next.record.status = "disabled"; this.save(next); return publicBot(next); }
      try { return await this.provision(next); }
      catch (error) {
        // A definite busy response means the Host did not mutate anything.
        if (error instanceof BotError && error.status === 409) this.save(previous);
        throw error;
      }
    });
  }
  private editable(record: BotRecord): BotInput {
    const { name, description, harness, templateId, skills, toolsets, delegationTargets } = record;
    return { name, description, harness, templateId, skills, toolsets, delegationTargets };
  }
  enableBot(id: string, identity: Identity): Promise<BotRecord> {
    return this.serial(() => {
      const bot = this.owned(id, identity);
      if (bot.record.status === "active") throw new BotError(409, "Bot is already active");
      return this.provision(bot);
    });
  }
  deactivate(id: string, identity: Identity, deleted: boolean): Promise<void> {
    return this.serial(async () => {
      const previous = this.owned(id, identity, deleted);
      const bot = structuredClone(previous);
      bot.record.status = "disabled";
      if (deleted) bot.record.deletedAt = new Date().toISOString();
      this.save(bot);
      try {
        if (bot.spec) await (deleted ? this.options.host.delete(id) : this.options.host.disable(id));
      } catch (error) {
        if (error instanceof BotError && error.status === 409) this.save(previous);
        throw error;
      }
    });
  }
  async restore(): Promise<void> {
    for (const bot of this.options.registry.all()) {
      if (bot.record.deletedAt || bot.record.status === "disabled") {
        if (bot.spec) {
          try { await (bot.record.deletedAt ? this.options.host.delete(bot.record.id) : this.options.host.disable(bot.record.id)); }
          catch (error) {
            // Keep the durable denial even when the Host is offline; retry/restart reconciles it.
            if (!(error instanceof BotError)) throw error;
          }
        }
        this.publish(bot);
      } else if (["active", "provisioning"].includes(bot.record.status)) {
        const template = this.options.templates.find(item => item.id === bot.record.templateId);
        if (!template) { bot.record.status = "failed"; this.save(bot); continue; }
        if (!bot.spec && template.remote) bot.runtime = structuredClone(template.remote);
        try { await this.provision(bot); } catch { /* Durable failed state is visible for explicit retry. */ }
      } else this.publish(bot);
    }
  }
}
