import { createHash } from "node:crypto";
import { z } from "zod";
import type { HostSpec } from "./types";

export type DesiredState = "active" | "disabled" | "deleted";
export interface ManagementOperation {
  operationId: string; desiredRevision: string; state: DesiredState; specHash: string;
  spec: Omit<HostSpec, "token" | "memoryKey">;
}
export const Acknowledgement = z.object({
  id: z.string(), principal: z.string(), projectId: z.string(), ownerId: z.string(),
  desiredRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/), operationId: z.string().uuid().nullable(),
  specHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), state: z.enum(["active", "disabled", "deleted"]),
}).strict();
export type ManagementAck = z.infer<typeof Acknowledgement>;
export function operationHash(state: DesiredState, spec: ManagementOperation["spec"]) {
  const sorted = Object.fromEntries(Object.entries(spec).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([state, sorted])).digest("hex");
}
export function matchesAck(operation: ManagementOperation, ack: ManagementAck) {
  return ack.id === operation.spec.id && ack.principal === operation.spec.principal && ack.projectId === operation.spec.projectId &&
    ack.ownerId === operation.spec.ownerId && ack.desiredRevision === operation.desiredRevision && ack.operationId === operation.operationId &&
    ack.specHash === operation.specHash && ack.state === operation.state;
}
