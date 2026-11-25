import { promptContext } from "./prompts/context";
import { baselinePromptFor as promptFor, baselineSystemPrompt as systemPrompt } from "./prompts/registry";
import { z } from "zod";
import { createHash } from "node:crypto";
import { schemas, outputSchema } from "./schema/registry";
const name=z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/);
const capability=z.enum(["chat","structured_output","embedding"]);
const Provider=z.discriminatedUnion("driver",[
  z.object({id:name,driver:z.literal("openai-compatible"),baseUrl:z.string().url(),keyEnv:z.string().regex(/^[A-Z_][A-Z0-9_]*$/),capabilities:z.array(capability).min(1)}).strict(),
  z.object({id:name,driver:z.literal("vertex"),project:z.string().regex(/^[a-z][a-z0-9-]{4,62}$/),location:z.string().regex(/^(global|[a-z]+-[a-z]+[0-9])$/),auth:z.literal("adc"),capabilities:z.array(capability).min(1)}).strict(),
]);
const Model=z.object({alias:name,provider:name,model:z.string().min(1).max(200),timeoutMs:z.number().int().min(1).max(120000),
  retries:z.number().int().min(0).max(2),maxTokens:z.number().int().min(1).max(8192),fallback:z.array(name).max(3),
  dimension:z.number().int().min(1).max(4096).optional(),version:z.string().min(1).max(100).optional(),
}).strict();
export const RegistryConfig=z.object({version:z.literal(1),providers:z.array(Provider).min(1),models:z.array(Model).min(1)}).strict();
export type ModelConfig=z.infer<typeof Model>;
export type ProviderConfig=z.infer<typeof Provider>;
export type RegistrySettings=z.infer<typeof RegistryConfig>;
export interface TaskContract { readonly role:string; readonly schemaVersion:number; readonly promptVersion:string; readonly validatorVersion:string }
export const taskRegistry:Readonly<Record<string,TaskContract>> = Object.freeze(Object.fromEntries(
  Object.entries({analysis:"graph_parser",generation:"graph_parser",merge:"graph_parser","v2-parser":"graph_parser",
    "v2-subject-disambiguation":"graph_matcher","v2-relations":"graph_relations","v3-query":"graph_query","v3-story":"graph_story"})
    .map(([id,role])=>[id,Object.freeze({role,schemaVersion:1,promptVersion:"1",validatorVersion:"1"})])
));
export class ModelRegistry {
  readonly config:RegistrySettings;
  readonly fingerprint:string;
  constructor(input:unknown){
    this.config=RegistryConfig.parse(input);
    if(new Set(this.config.providers.map(p=>p.id)).size!==this.config.providers.length || new Set(this.config.models.map(m=>m.alias)).size!==this.config.models.length)throw new Error("Duplicate registry alias");
    for(const provider of this.config.providers)validateEndpoint(provider);
    const roles=new Set(["agent_primary","graph_parser","graph_matcher","graph_relations","graph_query","graph_story","graph_embedding",...this.config.models.flatMap(m=>m.fallback)]);
    for(const model of this.config.models)validateModel(this,model,roles);
    validateTaskContracts(taskRegistry);
    this.fingerprint=createHash("sha256").update(canonical(this.config)).digest("hex");
  }
  model(alias:string){const m=this.config.models.find(m=>m.alias===alias);if(!m)throw new Error("Unknown model role");return m;}
  provider(id:string){const p=this.config.providers.find(p=>p.id===id);if(!p)throw new Error("Unknown provider");return p;}
}
function validateEndpoint(provider:ProviderConfig){
  if(provider.driver!=="openai-compatible")return;
  const u=new URL(provider.baseUrl);
  if(!["https:","http:"].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error("Invalid provider endpoint");
}
function validateVertex(model:ModelConfig,provider:Extract<ProviderConfig,{driver:"vertex"}>,embedding:boolean){
  if(embedding){
    if(model.model!=="gemini-embedding-001"||!model.dimension||model.dimension>3072||provider.location==="global")throw new Error("Unsupported Vertex embedding model/region/dimension");
  }else if(!["gemini-2.5-flash","gemini-2.5-pro","google/gemini-2.5-flash","google/gemini-2.5-pro"].includes(model.model))throw new Error("Unsupported Vertex structured model");
}
function validateModel(registry:ModelRegistry,model:ModelConfig,roles:Set<string>){
  if(!roles.has(model.alias))throw new Error("Unknown model role");
  const provider=registry.provider(model.provider),embedding=model.alias==="graph_embedding";
  const capability=embedding?"embedding":model.alias==="agent_primary"?"chat":"structured_output";
  if(!provider.capabilities.includes(capability))throw new Error("Incompatible model capability");
  if(embedding && (!model.dimension||!model.version))throw new Error("Embedding dimension/version required");
  if(provider.driver==="vertex")validateVertex(model,provider,embedding);
  for(const target of model.fallback){
    const fallback=registry.model(target);
    if(fallback.alias===model.alias||fallback.fallback.length||embedding||fallback.dimension)throw new Error("Invalid fallback chain");
  }
}
export function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value!==null && typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b,"en")).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function validateTaskContracts(tasks:Readonly<Record<string,TaskContract>>):void {
  for(const [id,task] of Object.entries(tasks)){
    promptFor(id,task.promptVersion);
    if(task.schemaVersion!==1 || task.validatorVersion!=="1" || !schemas[id] || task.role!==taskRegistry[id]?.role)throw new Error("Invalid task contract");
    outputSchema(schemas[id]);
  }
  if(Object.keys(taskRegistry).some(id=>!tasks[id]))throw new Error("Missing task contract");
}

/** Independent from model config, compiler mode, persisted domain schema and SQL migrations. */
const frozenTaskFingerprint=createHash("sha256").update(canonical(Object.fromEntries(Object.entries(taskRegistry).map(([stage,task])=>[stage,{...task,prompt:systemPrompt(stage),schema:outputSchema(schemas[stage])}])))).digest("hex");
export function taskFingerprint():string { return promptContext()?.fingerprint ?? frozenTaskFingerprint; }
