import { usage, type Usage } from "../usage";
import { GoogleAuth } from "google-auth-library";
import type { ProviderConfig, ModelConfig } from "../config";
import { bounded, ProviderError, responseJSON, retryProvider } from "./http";
import { validVector, type Encoder } from "../../graph/embedding";
export type TokenSource=(signal:AbortSignal)=>Promise<string>;
export function adcTokenSource():TokenSource {
  const auth=new GoogleAuth({scopes:["https://www.googleapis.com/auth/cloud-platform"]});
  return signal=>bounded(signal,async()=>{const token=await auth.getAccessToken();if(!token)throw new ProviderError("auth");return token;});
}
export function vertexURL(provider:Extract<ProviderConfig,{driver:"vertex"}>,model:string,method:string){
  const host=provider.location==="global"?"aiplatform.googleapis.com":`${provider.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${provider.project}/locations/${provider.location}/publishers/google/models/${encodeURIComponent(model.replace(/^google\//,""))}:${method}`;
}
export class VertexStructuredLLMClient {
  usage:Usage=usage(null,null);
  constructor(readonly provider:Extract<ProviderConfig,{driver:"vertex"}>,readonly model:ModelConfig,readonly transport:typeof fetch=fetch,readonly token:TokenSource=adcTokenSource()){}
  async generate(system:string,data:unknown,schema:Record<string,unknown>,signal:AbortSignal){
    const token=await this.token(signal);
    const body=await responseJSON(await this.transport(vertexURL(this.provider,this.model.model,"generateContent"),{
      method:"POST",redirect:"error",signal,headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},
      body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:"user",parts:[{text:JSON.stringify(data)}]}],
        generationConfig:{maxOutputTokens:this.model.maxTokens,responseMimeType:"application/json",responseJsonSchema:schema}}),
    }));
    this.usage=usage(body.usageMetadata?.promptTokenCount,body.usageMetadata?.candidatesTokenCount);
    const candidate=body.candidates?.[0];
    if(candidate?.finishReason!=="STOP"||!Array.isArray(candidate.content?.parts))throw new ProviderError("format");
    const content=candidate.content.parts.filter((p:any)=>!p.thought).map((p:any)=>typeof p.text==="string"?p.text:"").join("");
    try{return JSON.parse(content);}catch{throw new ProviderError("format");}
  }
}
export class VertexEmbeddingClient implements Encoder {
  readonly model:string;readonly dimension:number;readonly version:string;readonly fingerprint:string;
  constructor(readonly provider:Extract<ProviderConfig,{driver:"vertex"}>,readonly options:ModelConfig,readonly transport:typeof fetch=fetch,readonly token:TokenSource=adcTokenSource()){
    this.model=options.model;this.dimension=options.dimension!;this.version=options.version!;
    this.fingerprint=JSON.stringify(["vertex",provider.id,provider.project,provider.location,this.model,this.dimension,this.version,"SEMANTIC_SIMILARITY","autoTruncate:false"]);
  }
  async embed(texts:string[],signal:AbortSignal):Promise<number[][]>{
    if(!texts.length||texts.length>32||texts.some(t=>!t||Buffer.byteLength(t)>16384))throw new Error("Embedding batch limit");
    // gemini-embedding-001 accepts one instance per predict request. Preserve batch order.
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs)]);
    return bounded(deadline,async()=>{
      const vectors:number[][]=[];
      for(const text of texts){
        const body=await retryProvider(this.options.retries,deadline,async()=>{
          const token=await this.token(deadline);
          return responseJSON(await this.transport(vertexURL(this.provider,this.model,"predict"),{method:"POST",redirect:"error",signal:deadline,
            headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({instances:[{content:text,task_type:"SEMANTIC_SIMILARITY"}],parameters:{autoTruncate:false,outputDimensionality:this.dimension}})}),4194304);
        });
        const e=body.predictions?.[0]?.embeddings;
        if(body.predictions?.length!==1||e?.statistics?.truncated===true||!validVector(e?.values,this.dimension))throw new ProviderError("format");
        vectors.push(e.values);
      }
      return vectors;
    });
  }
}
