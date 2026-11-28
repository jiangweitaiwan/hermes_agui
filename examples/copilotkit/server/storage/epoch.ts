import type { Pool, PoolClient } from "pg";
import { z } from "zod";
export async function deploymentEpoch(db: Pick<Pool | PoolClient,"query">): Promise<string | null> {
  const row=(await db.query("SELECT epoch::text FROM hermes_agui_runtime.deployment_epoch WHERE singleton")).rows[0];
  if(!row || (row.epoch!==null && !z.string().uuid().safeParse(row.epoch).success)) throw new Error("Deployment epoch authority missing");
  return row.epoch;
}
const legacy=z.object({schema:z.literal(1),jobId:z.string().uuid()}).strict();
const modern=z.object({schema:z.literal(2),jobId:z.string().uuid(),epoch:z.string().uuid()}).strict();
export function taskGeneration(value:unknown,current:string|null) {
  const parsed=z.union([legacy,modern]).safeParse(value);
  if(!parsed.success) return {status:"invalid" as const};
  if(parsed.data.schema===1) return {status:current?"stale" as const:"current" as const,jobId:parsed.data.jobId};
  if(current===null) return {status:"invalid" as const};
  return {status:parsed.data.epoch===current?"current" as const:"stale" as const,jobId:parsed.data.jobId};
}
