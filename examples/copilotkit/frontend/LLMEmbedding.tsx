import { useEffect, useState } from "react";
import { llmApi } from "./LLMManagement";
export function LLMEmbedding(){
  const [view,setView]=useState<unknown>(),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [target,setTarget]=useState({provider:"",model:"",dimension:768,version:""}),[revision,setRevision]=useState(0);
  const [reason,setReason]=useState(""),[mode,setMode]=useState("v3");
  async function load(){setBusy(true);setError("");try{const [draft,status]=await Promise.all([llmApi("draft"),llmApi("embedding/migrations")]);const m=draft.config.models.find((m:{alias:string})=>m.alias==="graph_embedding");setTarget({provider:m.provider,model:m.model,dimension:m.dimension,version:m.version});setRevision(draft.revision);setView(status);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  useEffect(()=>{void load();},[]);
  return <section aria-label="Embedding Migration"><p>以既有 vectors CLI 建立候選索引；舊索引保留。缺少全域 coverage／水位／所有寫入路徑 drain 證明時，切換保持 BLOCKED。</p>
    {error&&<p role="alert">{error}</p>}{busy&&<p role="status">處理中…</p>}
    {(["provider","model","version"] as const).map(key=><label key={key}>{key}<input value={target[key]} onChange={e=>setTarget({...target,[key]:e.target.value})}/></label>)}
    <label>dimension<input type="number" value={target.dimension} onChange={e=>setTarget({...target,dimension:Number(e.target.value)})}/></label>
    <label>retrieval mode<select value={mode} onChange={e=>setMode(e.target.value)}><option>v2</option><option>v3</option></select></label>
    <label>原因<input value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <button disabled={busy||!reason.trim()} onClick={async()=>{setBusy(true);setError("");try{await llmApi("embedding/migrations","POST",{expectedRevision:revision,target,retrievalMode:mode,reason});await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>建立唯讀 migration plan</button>
    <button disabled={busy} onClick={()=>void load()}>重新載入</button><pre>{view==null?"沒有狀態":JSON.stringify(view,null,2)}</pre>
  </section>;
}
