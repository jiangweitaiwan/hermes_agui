/** Aborting wins even when an injected provider ignores its AbortSignal. */
export async function graphDeadline<T>(action:(signal:AbortSignal)=>Promise<T>,timeoutMs:number,parent?:AbortSignal):Promise<T|{status:"unavailable"}> {
  const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(parent?[parent]:[])]);
  let onAbort:(()=>void)|undefined;
  try {
    signal.throwIfAborted();
    return await Promise.race([Promise.resolve().then(()=>action(signal)),new Promise<{status:"unavailable"}>(resolve=>{
      onAbort=()=>resolve({status:"unavailable"});signal.addEventListener("abort",onAbort,{once:true});
      if(signal.aborted)onAbort();
    })]);
  }catch{return {status:"unavailable"};}
  finally{if(onAbort)signal.removeEventListener("abort",onAbort);}
}
