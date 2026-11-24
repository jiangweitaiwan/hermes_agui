import type { Encoder } from "../graph/embedding";
import type { ModelRegistry } from "./config";
import { executionRelease } from "./execution-release";

/** Preserve the existing vector key and transport; never log embedding input or raw errors. */
export class ObservedEncoder implements Encoder {
  constructor(readonly encoder:Encoder,readonly registry:ModelRegistry){}
  get model(){return this.encoder.model;}
  get dimension(){return this.encoder.dimension;}
  get version(){return this.encoder.version;}
  get fingerprint(){return this.encoder.fingerprint;}
  async embed(texts:string[],signal:AbortSignal){
    const release=executionRelease(),started=Date.now();let outcome="failed";
    try{const vectors=await this.encoder.embed(texts,signal);outcome="succeeded";return vectors;}
    finally{
      console.error(JSON.stringify({severity:"INFO",event:"llm_embedding_execution",role:"graph_embedding",
        releaseId:release?.release_id??null,releaseFingerprint:release?.release_fingerprint??null,
        configHash:release?.snapshot.modelFingerprint??this.registry.fingerprint,embeddingFingerprint:this.fingerprint,
        provider:this.registry.model("graph_embedding").provider,model:this.model,latencyMs:Date.now()-started,outcome}));
    }
  }
}
