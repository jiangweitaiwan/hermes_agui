import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, ModelRegistry, RegistryConfig, taskRegistry } from "./config";
import { baselineSystemPrompt as systemPrompt } from "./prompts/registry";
import { promptManifest, PromptEdits } from "./prompt-contract";
import { schemas, outputSchema } from "./schema/registry";

export const roles = ["agent_primary", "graph_parser", "graph_matcher", "graph_relations", "graph_query", "graph_story", "graph_embedding"] as const;
export const ControlSettings = z.object({
  mode: z.enum(["static", "managed"]).default("static"),
  scope: z.literal("deployment"),
  admins: z.array(z.string().min(1)).min(1).max(100),
  approved: RegistryConfig,
  embeddingCandidates:z.array(z.object({provider:z.string().min(1).max(100),model:z.string().min(1).max(100),dimension:z.number().int().min(1).max(3072),version:z.string().min(1).max(100)}).strict()).max(16).optional(),
}).strict();
export type ControlPolicy = z.infer<typeof ControlSettings>;
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export class ControlError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function taskManifest() {
  return Object.fromEntries(Object.entries(taskRegistry).map(([stage, contract]) =>
    [stage, { ...contract, prompt: systemPrompt(stage), schema: outputSchema(schemas[stage]) }]));
}
export const SnapshotSchema = z.object({
  version: z.literal(1), contract: z.enum(["management-part-1", "management-part-2"]), llm: RegistryConfig,
  modelFingerprint: z.string().regex(/^[a-f0-9]{64}$/), taskFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  tasks: z.record(z.unknown()), prompts: PromptEdits.optional(), codeTaskFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Approval is deployment-owned. Drafts can select routes but cannot expand network/secret authority. */
export function candidate(raw: unknown, policy: ControlPolicy, prompts?: unknown): Snapshot {
  try{return buildCandidate(raw,policy,prompts);}
  catch(error){
    if(error instanceof ControlError)throw error;
    throw new ControlError(422,"Invalid registry configuration");
  }
}
function buildCandidate(raw:unknown,policy:ControlPolicy,edits?:unknown):Snapshot{
  const registry = new ModelRegistry(raw), approved = new ModelRegistry(policy.approved);
  for (const role of roles) registry.model(role);
  for (const provider of registry.config.providers) {
    if (canonical(provider) !== canonical(approved.provider(provider.id))) throw new ControlError(422, "Provider is not approved");
    if (provider.driver === "openai-compatible") {
      const url = new URL(provider.baseUrl);
      if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.includes(":") ||
          /^\d+(?:\.\d+){3}$/.test(url.hostname) || !url.hostname.includes(".")) {
        throw new ControlError(422, "HTTPS public provider required");
      }
    }
  }
  for (const model of registry.config.models) {
    if (!approved.config.models.some(m => m.provider === model.provider && m.model === model.model &&
        (m.alias === model.alias || (m.alias !== "graph_embedding" && model.alias !== "graph_embedding")))) {
      throw new ControlError(422, "Model is not approved");
    }
  }
  if (registry.model("agent_primary").fallback.length) throw new ControlError(422, "Native fallback must be empty");
  if (registry.model("agent_primary").dimension !== undefined) throw new ControlError(422,"Native primary requires a chat model");
  const embedding = registry.model("graph_embedding"), baseline = approved.model("graph_embedding");
  if (canonical(embedding) !== canonical(baseline) ||
      canonical(registry.provider(embedding.provider)) !== canonical(approved.provider(baseline.provider))) {
    throw new ControlError(422, "Embedding is read only");
  }
  if(edits!==undefined){
    const prompts=PromptEdits.parse(edits), tasks=promptManifest(taskManifest(),prompts);
    return {version:1,contract:"management-part-2",llm:registry.config,modelFingerprint:registry.fingerprint,
      taskFingerprint:hash(tasks),tasks,prompts,codeTaskFingerprint:hash(taskManifest())};
  }
  return { version: 1, contract: "management-part-1", llm: registry.config,
    modelFingerprint: registry.fingerprint, taskFingerprint: hash(taskManifest()), tasks: taskManifest() };
}
export function verifySnapshot(raw: unknown, fingerprint: string, policy: ControlPolicy): Snapshot {
  try{
    const snapshot = SnapshotSchema.parse(raw);
    if (hash(snapshot) !== fingerprint || canonical(candidate(snapshot.llm, policy, snapshot.prompts)) !== canonical(snapshot)) {
      throw new ControlError(503, "Release contract incompatible");
    }
    return snapshot;
  }catch{
    throw new ControlError(503, "Release contract incompatible");
  }
}
