import { hostFetch } from "../cloud";
import { Acknowledgement, type ManagementAck, type ManagementOperation } from "./operations";
import { BotError, type HostSpec } from "./types";
export interface HostPort {
  applyOperation?(operation: ManagementOperation): Promise<ManagementAck>;
  operationStatus?(operation: ManagementOperation): Promise<ManagementAck | undefined>;
  register(spec: HostSpec): Promise<void>;
  disable(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}
export class HermesHostClient implements HostPort {
  constructor(readonly endpoint: string, private token: string) {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || !token || url.username || url.password) {
      throw new Error("Invalid managed Host configuration");
    }
  }
  agentUrl(id: string) { return `${this.endpoint.replace(/\/$/, "")}/bots/${id}/agent`; }
  private async request(id: string, method: string, suffix = "", body?: HostSpec) {
    let response: Response;
    try {
      response = await hostFetch(`${this.endpoint.replace(/\/$/, "")}/internal/bots/${encodeURIComponent(id)}${suffix}`, {
        method, headers: { authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
      });
    } catch { throw new BotError(503, "Hermes Host unavailable"); }
    await response.body?.cancel();
    if (response.status === 404 && method !== "PUT") return;
    if (!response.ok) throw new BotError(response.status === 409 ? 409 : 503,
      response.status === 409 ? "Bot is busy or conflicts with Host state" : "Hermes provisioning failed");
  }
  async applyOperation(operation: ManagementOperation) {
    return (await this.operationRequest(operation, "PUT"))!;
  }
  operationStatus(operation: ManagementOperation) { return this.operationRequest(operation, "GET"); }
  private async operationRequest(operation: ManagementOperation, method: "GET" | "PUT") {
    const { id, principal, projectId, ownerId } = operation.spec;
    const query = method === "GET" ? "?" + new URLSearchParams({ principal, projectId, ownerId: ownerId! }) : "";
    let response: Response;
    try {
      response = await hostFetch(`${this.endpoint.replace(/\/$/, "")}/internal/bots/${encodeURIComponent(id)}/operation${query}`, {
        method, headers: { authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: method === "PUT" ? JSON.stringify(operation) : undefined, signal: AbortSignal.timeout(15000),
      });
    } catch { throw new BotError(503, "Host operation result unknown"); }
    if (response.status === 404 && method === "GET") { await response.body?.cancel(); return undefined; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BotError(response.status >= 400 && response.status < 500 ? response.status : 503, "Host operation not acknowledged");
    }
    return Acknowledgement.parse(await response.json());
  }
  register(spec: HostSpec) { return this.request(spec.id, "PUT", "", spec); }
  disable(id: string) { return this.request(id, "POST", "/disable"); }
  delete(id: string) { return this.request(id, "DELETE"); }
}
