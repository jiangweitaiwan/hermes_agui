export class ProviderError extends Error {
  constructor(readonly code:"http"|"format"|"auth",readonly status=0){super(`LLM provider ${code}${status ? ` (${status})`:""}`);}
  get retryable(){return this.status===429||this.status>=500;}
}
export async function responseJSON(response:Response,limit=131072):Promise<any>{
  if(!response.ok){await response.body?.cancel();throw new ProviderError("http",response.status);}
  const reader=response.body?.getReader();if(!reader)throw new ProviderError("format");
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new ProviderError("format");chunks.push(part.value);}}
  finally{await reader.cancel();}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new ProviderError("format");}
}
export async function bounded<T>(signal:AbortSignal,call:()=>Promise<T>):Promise<T>{
  signal.throwIfAborted();let abort=()=>{};
  try{return await Promise.race([call(),new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}
  finally{signal.removeEventListener("abort",abort);}
}
export async function retryProvider<T>(retries:number,signal:AbortSignal,call:()=>Promise<T>):Promise<T>{
  for(let attempt=0;;attempt++){
    try{return await bounded(signal,call);}catch(error){
      signal.throwIfAborted();
      if(attempt>=retries||!(error instanceof ProviderError&&error.retryable))throw error;
      await pause(Math.min(1000,100*2**attempt),signal);
    }
  }
}
export async function pause(ms:number,signal:AbortSignal){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await bounded(signal,()=>new Promise<void>(resolve=>{timer=setTimeout(resolve,ms);timer.unref();}));}
  finally{clearTimeout(timer);}
}
