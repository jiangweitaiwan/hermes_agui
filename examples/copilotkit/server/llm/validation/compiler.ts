import type { CompilerLLM } from "../../graph/compiler";
import { execution, observe, type Observer } from "../observability";
import { failure, result, validateOutput, ValidationError, issue } from "./pipeline";
/** Job scope is inherited through AsyncLocalStorage, including concurrent workers. */
export async function callCompiler(llm:CompilerLLM,stage:string,data:unknown,signal:AbortSignal,sink:Observer=observe,route:{provider?:string;model?:string}={}){
  const started=Date.now();
  let listener=()=>{};
  try{
    signal.throwIfAborted();
    const output=await Promise.race([llm.json(stage,data,signal),new Promise<never>((_,reject)=>{
      listener=()=>reject(signal.reason);signal.addEventListener("abort",listener,{once:true});if(signal.aborted)listener();
    })]);
    signal.throwIfAborted();
    if(Buffer.byteLength(JSON.stringify(output)??"")>65536)throw new ValidationError(result(stage,[issue(stage,"output","OUTPUT_INVALID")]));
    const parsed=validateOutput(stage,output);
    sink(execution(stage,started,result(stage),route));
    return parsed;
  }catch(error){
    const validation=failure(stage,error,signal.aborted);
    sink(execution(stage,started,validation,{...route,outcome:"failed"}));
    throw error;
  }finally{signal.removeEventListener("abort",listener);}
}
