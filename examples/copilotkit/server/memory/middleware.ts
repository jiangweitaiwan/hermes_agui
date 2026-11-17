import { createHmac } from "node:crypto";
import type { GraphScope } from "../graph-memory";
import type { RuntimeMemoryManager } from "./runtime-memory-manager";
export interface MemoryBridgeSettings { key: string; principal: string; projectId: string }
/** Backend-owned metadata only. Never reuse or merge browser envelopes. */
export class RuntimeMemoryMiddleware {
  constructor(readonly manager: RuntimeMemoryManager, readonly scope: (identity: GraphScope) => GraphScope) {}
  async prepare(botId: string, settings: MemoryBridgeSettings, threadId: string, runId: string, query: string) {
    if (!settings.key || !settings.principal || !settings.projectId) throw new Error("Invalid memory bridge settings");
    const context = await this.manager.prepare(this.scope({ principal: settings.principal,
      projectId: settings.projectId, botId, threadId, runId }), query);
    const payload = Buffer.from(JSON.stringify({ botId, threadId, runId, principal: settings.principal,
      projectId: settings.projectId, expires: Math.floor(Date.now() / 1000) + 60, context })).toString("base64url");
    return { payload, signature: createHmac("sha256", settings.key).update(payload).digest("hex") };
  }
}
