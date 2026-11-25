import { useEffect, useState, useRef } from "react";
import { llmApi } from "./LLMManagement";
const tasks=["v2-parser","v2-subject-disambiguation","v2-relations","v3-query","v3-story","agent_primary","analysis","generation","merge"];
interface PromptData {task:string;revision:number;editable:boolean;protectedText:string;active:{prompt?:string;promptVersion?:string}|null;draft:{editableText?:string;prompt:string;promptVersion:string}}
interface Props {tab:string;onSaved:()=>Promise<void>}
export function LLMPrompts({tab,onSaved}:Props){
  const [task,setTask]=useState("v2-parser"),[data,setData]=useState<PromptData>(),[text,setText]=useState("");
  const [view,setView]=useState<unknown>(),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [input,setInput]=useState("Bob did not deploy."),[egress,setEgress]=useState(false),[mode,setMode]=useState("v2-parser");
  const controller=useRef<AbortController|null>(null);
  async function action(run:()=>Promise<void>){setBusy(true);setError("");try{await run();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  useEffect(()=>{
    let current=true;setError("");setView(undefined);setData(undefined);setBusy(true);
    if(tab==="Playground"){setBusy(false);return ()=>{controller.current?.abort();};}
    const path=tab==="Schemas"?`schemas/${task}`:`prompts/${task}`;
    llmApi(path).then(value=>{if(!current)return;if(tab==="Schemas")setView(value);else{setData(value);setText(value.draft.editableText??(task==="agent_primary"?value.draft.prompt:""));}})
      .catch(e=>{if(current)setError(e.message);}).finally(()=>{if(current)setBusy(false);});
    return ()=>{current=false;controller.current?.abort();};
  },[task,tab]);
  return <section aria-label={tab}>
    <label>Task<select value={task} onChange={e=>setTask(e.target.value)}>{tasks.filter(t=>tab!=="Schemas"||t!=="agent_primary").map(t=><option key={t}>{t}</option>)}</select></label>
    {busy&&<p role="status">處理中…</p>}{error&&<p role="alert">{error}</p>}
    {tab==="Prompts"&&data&&<>
      <p>Active {data.active?.promptVersion??"legacy/unknown"} → Draft {data.draft.promptVersion}</p>
      <label>Protected contract（locked）<textarea readOnly value={data.protectedText} rows={8}/></label>
      <label>Editable task guidance<textarea maxLength={task==="agent_primary"?4000:12000} readOnly={!data.editable} value={text} rows={8} onChange={e=>setText(e.target.value)}/></label>
      <button disabled={busy||!data.editable} onClick={()=>void action(async()=>{
        const draft=await llmApi("draft");
        if(draft.revision!==data.revision)throw new Error("草稿已變更，請重新載入。");
        await llmApi("draft","PATCH",{expectedRevision:data.revision,config:draft.config,prompts:{...draft.prompts,[task]:text}});
        const next=await llmApi(`prompts/${task}`);setData(next);await onSaved();
      })}>儲存 Prompt 草稿</button>
      <details><summary>Effective prompt diff（active / saved candidate）</summary><pre>{data.active?.prompt??"legacy/unknown"}</pre><hr/><pre>{data.draft.prompt}</pre></details>
      <button disabled={busy} onClick={()=>void action(async()=>setView(await llmApi(`prompts/${task}/versions`)))}>版本歷史</button>
      {view!=null&&<><pre>{JSON.stringify(view,null,2)}</pre>{(view as {versions?:Array<{release_id:string;task:{editableText?:string;prompt?:string}|null}>}).versions?.map(v=><button key={v.release_id} disabled={busy||!data.editable} onClick={()=>setText(v.task?.editableText??(task==="agent_primary"?v.task?.prompt??"":""))}>以 {v.release_id} 內容編輯新草稿</button>)}</>}
      {task==="agent_primary"&&<p>僅顯示 deployment instruction slot。Native tools、skills、memory、history 保留；auxiliary prompts unmanaged。完整 session prompt 不公開。</p>}
    </>}
    {tab==="Schemas"&&view!=null&&<><p>唯讀 Zod provider projection；完整語義規則由 server validators 執行。</p><pre>{JSON.stringify(view,null,2)}</pre><button onClick={()=>void action(async()=>navigator.clipboard.writeText(JSON.stringify(view,null,2)))}>複製</button></>}
    {tab==="Playground"&&<>
      <p>Baseline / candidate 使用相同輸入及 synthetic upstream context。無資料發布、工具或 Cloud Tasks。Matcher/relations/story 的單 stage 使用固定 synthetic context；retrieval 不執行向量搜尋。</p>
      <label>Mode<select value={mode} onChange={e=>setMode(e.target.value)}>{[...tasks.filter(t=>t.startsWith("v")),"ingest","retrieval"].map(t=><option key={t}>{t}</option>)}</select></label>
      <label>Synthetic input<textarea maxLength={4000} rows={6} value={input} onChange={e=>setInput(e.target.value)}/></label>
      <label><input type="checkbox" checked={egress} onChange={e=>setEgress(e.target.checked)}/>確認向已批准 Provider 傳送此測試文字（勿輸入真實 session 或秘密）</label>
      <button disabled={busy||!egress||!input.trim()} onClick={()=>void action(async()=>{
        const draft=await llmApi("draft");controller.current=new AbortController();
        setView(await llmApi("playground","POST",{draftRevision:draft.revision,mode,input,vendorEgressAcknowledged:true},controller.current.signal));
      })}>執行 baseline / candidate</button><button disabled={!busy} onClick={()=>controller.current?.abort()}>取消</button>
      <pre>{view==null?"尚無結果；原文結果不永久保存。":JSON.stringify(view,null,2)}</pre>
    </>}
  </section>;
}
