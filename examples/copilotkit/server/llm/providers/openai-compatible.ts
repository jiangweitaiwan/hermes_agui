import type {ProviderConfig,ModelConfig} from "../config";
import {ProviderError,responseJSON,retryProvider} from "./http";
import {validVector,type Encoder} from "../../graph/embedding";
type Provider=Extract<ProviderConfig,{driver:"openai-compatible"}>;
export class OpenAICompatibleClient {
  constructor(readonly provider:Provider,readonly model:ModelConfig,readonly transport:typeof fetch=fetch){}
  headers(){const key=process.env[this.provider.keyEnv];if(!key)throw new ProviderError("auth");return {"Content-Type":"application/json",Authorization:`Bearer ${key}`};}
  url(method:string){return `${this.provider.baseUrl.replace(/\/$/,"")}/${method}`;}
  async generate(system:string,data:unknown,schema:Record<string,unknown>,signal:AbortSignal){
    const body=await responseJSON(await this.transport(this.url("chat/completions"),{method:"POST",redirect:"error",signal,headers:this.headers(),
      body:JSON.stringify({model:this.model.model,max_tokens:this.model.maxTokens,response_format:{type:"json_object"},messages:[
        {role:"system",content:system+"\nOutput JSON schema: "+JSON.stringify(schema)},{role:"user",content:JSON.stringify(data)}]})}));
    if(body.choices?.[0]?.finish_reason && body.choices[0].finish_reason!=="stop")throw new ProviderError("format");
    try{return JSON.parse(body.choices[0].message.content);}catch{throw new ProviderError("format");}
  }
}
export class OpenAIEmbeddingClient implements Encoder {
  readonly model:string;readonly dimension:number;readonly version:string;readonly fingerprint:string;
  readonly client:OpenAICompatibleClient;
  constructor(provider:Provider,readonly options:ModelConfig,transport:typeof fetch=fetch){
    this.client=new OpenAICompatibleClient(provider,options,transport);this.model=options.model;this.dimension=options.dimension!;this.version=options.version!;
    this.fingerprint=JSON.stringify([provider.driver,provider.id,provider.baseUrl.replace(/\/$/,""),this.model,this.dimension,this.version,"symmetric","raw"]);
  }
  async embed(texts:string[],signal:AbortSignal):Promise<number[][]>{
    if(!texts.length||texts.length>32||texts.some(t=>!t||Buffer.byteLength(t)>16384))throw new Error("Embedding batch limit");
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs)]);
    return retryProvider(this.options.retries,deadline,async()=>{
      const body=await responseJSON(await this.client.transport(this.client.url("embeddings"),{method:"POST",redirect:"error",signal:deadline,headers:this.client.headers(),
        body:JSON.stringify({model:this.model,dimensions:this.dimension,input:texts})}),4194304);
      if(body.model!==this.model||!Array.isArray(body.data)||body.data.length!==texts.length)throw new ProviderError("format");
      const rows=body.data.sort((a:any,b:any)=>a.index-b.index);
      if(rows.some((r:any,i:number)=>r.index!==i||!validVector(r.embedding,this.dimension)))throw new ProviderError("format");
      return rows.map((r:any)=>r.embedding);
    });
  }
}
