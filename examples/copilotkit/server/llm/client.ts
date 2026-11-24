import { execution, observe, type Observer } from "./observability";
import { executionRelease } from "./execution-release";
import { managedTransport } from "./managed-transport";
import { ObservedEncoder } from "./embedding-observability";
import { result, validateOutput, failure } from "./validation/pipeline";
import { systemPrompt } from "./prompts/registry";
import { OpenAICompatibleClient, OpenAIEmbeddingClient } from "./providers/openai-compatible";
import { z } from "zod";
import { ModelRegistry, RegistryConfig, taskRegistry } from "./config";
import { schemas, outputSchema } from "./schema/registry";
import { OpenAICompilerLLM, type CompilerLLM } from "../graph/compiler";
import { OpenAIEncoder, EmbeddingConfig, type Encoder } from "../graph/embedding";
import { VertexEmbeddingClient, VertexStructuredLLMClient, type TokenSource } from "./providers/vertex";
import { bounded, ProviderError, pause } from "./providers/http";
export const LegacyChatConfig=z.object({baseUrl:z.string().url(),model:z.string().min(1),keyEnv:z.string().min(1),
  timeoutMs:z.number().int().positive().max(120000).optional(),maxTokens:z.number().int().positive().max(8192).optional()}).strict();
export const RoleConfig=z.object({registry:RegistryConfig,role:z.string().min(1),managed:z.boolean().optional()}).strict();
export const ChatConfig=z.union([LegacyChatConfig,RoleConfig]);
export const EncoderConfig=z.union([EmbeddingConfig,RoleConfig]);
export interface ClientDependencies {transport?:typeof fetch;token?:TokenSource;observe?:Observer}
export class RegistryLLM implements CompilerLLM {
  readonly registry:ModelRegistry;
  constructor(config:unknown,readonly role:string,readonly deps:ClientDependencies={},readonly managed=false){this.registry=new ModelRegistry(config);this.registry.model(role);}
  async json(stage:string,data:unknown,signal:AbortSignal):Promise<unknown>{
    if(this.managed){
      const release=executionRelease();
      if(!release)throw new Error("Managed execution requires a release pin");
      return new RegistryLLM(release.snapshot.llm,this.role,{...this.deps,transport:this.deps.transport??managedTransport}).json(stage,data,signal);
    }
    const task=taskRegistry[stage],schema=schemas[stage];
    if(!task||!schema)throw new Error("Unknown LLM task");
    // Ingest bridge selects per-stage role; query/story bridges cannot route another task.
    const role=this.role==="graph_parser"?task.role:this.role;
    if(role!==task.role)throw new Error("Task role mismatch");
    const primary=this.registry.model(role);
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(primary.timeoutMs)]);
    return bounded(deadline,async()=>{
      let lastError:unknown;
      for(const alias of [role,...primary.fallback]){
        const model=this.registry.model(alias),provider=this.registry.provider(model.provider);
        for(let attempt=0;attempt<=model.retries;attempt++){
          const started=Date.now();
          try{
            const attemptSignal=AbortSignal.any([deadline,AbortSignal.timeout(model.timeoutMs)]);
            const client=provider.driver==="vertex"?new VertexStructuredLLMClient(provider,model,this.deps.transport,this.deps.token):new OpenAICompatibleClient(provider,model,this.deps.transport);
            const output=await bounded(attemptSignal,()=>client.generate(systemPrompt(stage),data,outputSchema(schema),attemptSignal));
            const parsed=validateOutput(stage,output);
            (this.deps.observe??observe)(execution(stage,started,result(stage),{phase:"provider_attempt",provider:provider.id,model:model.model,configHash:this.registry.fingerprint,...client.usage}));
            return parsed;
          }catch(error){
            const validation=failure(stage,error,deadline.aborted);
            (this.deps.observe??observe)(execution(stage,started,validation,{phase:"provider_attempt",provider:provider.id,model:model.model,configHash:this.registry.fingerprint,outcome:"failed"}));
            deadline.throwIfAborted();lastError=error;if(!(error instanceof ProviderError&&error.retryable))throw error;
            if(attempt<model.retries)await pause(Math.min(1000,100*2**attempt),deadline);
          }
        }
      }
      throw lastError;
    });
  }
}
export function chatClient(options:unknown,deps:ClientDependencies={}):CompilerLLM {
  const parsed=ChatConfig.parse(options);
  return "registry" in parsed?new RegistryLLM(parsed.registry,parsed.role,deps,parsed.managed):new OpenAICompilerLLM(parsed,deps.transport);
}
export function embeddingClient(options:unknown,deps:ClientDependencies={}):Encoder {
  const parsed=EncoderConfig.parse(options);
  if(!("registry" in parsed))return new OpenAIEncoder(parsed,deps.transport);
  if(parsed.role!=="graph_embedding")throw new Error("Invalid embedding role");
  const registry=new ModelRegistry(parsed.registry),model=registry.model(parsed.role),provider=registry.provider(model.provider);
  const encoder=provider.driver==="vertex"?new VertexEmbeddingClient(provider,model,deps.transport,deps.token):new OpenAIEmbeddingClient(provider,model,deps.transport);
  return new ObservedEncoder(encoder,registry);
}
