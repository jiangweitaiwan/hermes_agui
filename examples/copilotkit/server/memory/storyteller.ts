import { validateRetrieval } from "../llm/validation/retrieval";
import { promptFor } from "../llm/prompts/registry";
import type { CompilerLLM } from "../graph/compiler";
import type { MemoryNet } from "../graph/memory-net";
import { groundedStory, validateStory } from "./story-validator";
export class Storyteller {
  private pending=0;
  constructor(readonly llm?:CompilerLLM,readonly timeoutMs=1500,readonly concurrency=2) {
    if (!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||!Number.isInteger(concurrency)||concurrency<1||concurrency>8) throw new Error("Invalid storyteller budget");
  }
  async tell(net:MemoryNet,signal:AbortSignal) {
    const fallback=()=>({story:groundedStory(net),status:"deterministic" as const});
    if(!this.llm||this.pending>=this.concurrency)return fallback();
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]);
    let onAbort:(()=>void)|undefined;
    this.pending++;
    let started=false;
    try {
      bounded.throwIfAborted();
      if(Buffer.byteLength(JSON.stringify(net))>65536)throw new Error("Story input budget");
      const input={
        rule: promptFor("v3-story").rule,
        net,candidate:groundedStory(net),
      };
      if(Buffer.byteLength(JSON.stringify(input))>98304)throw new Error("Story total input budget");
      started=true;
      const call=Promise.resolve().then(()=>this.llm!.json("v3-story",input,bounded)).finally(()=>{this.pending--;});
      const output=await Promise.race([call,new Promise<never>((_,reject)=>{onAbort=()=>reject(new Error("Story deadline"));bounded.addEventListener("abort",onAbort,{once:true});})]);
      bounded.throwIfAborted();return {story:validateRetrieval("v3-story",output,()=>validateStory(output,net)),status:"model" as const};
    }catch{return fallback();}
    finally{if(!started)this.pending--;if(onAbort)bounded.removeEventListener("abort",onAbort);}
  }
}
