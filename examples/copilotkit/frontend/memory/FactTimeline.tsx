import {useEffect,useState} from "react";
import {graph,type FactsResult,type Scope} from "../api/graph";
interface FactTimelineProps {bot:string;scope:Scope;query:string;pageId?:string;onFailure:(message:string)=>void;view?:string;onViewChange?:(view:string)=>void}
export function FactTimeline({bot,scope,query,pageId,onFailure,view:externalView,onViewChange}:FactTimelineProps) {
  const [localView,setLocalView]=useState("current");
  const view=externalView ?? localView;
  const setView=onViewChange ?? setLocalView;
  const [event,setEvent]=useState<string>();
  const [subject,setSubject]=useState<string>();
  const [result,setResult]=useState<FactsResult>();
  const [cursor,setCursor]=useState("");
  const [evidence,setEvidence]=useState<{edgeId:string;start:number}>();
  useEffect(()=>{
    let active=true;const controller=new AbortController();setResult(undefined);
    const params=new URLSearchParams({scope,view,limit:"50"});
    if(query)params.set("q",query);
    if(pageId)params.set("pageId",pageId);
    if(event)params.set("eventId",event);
    if(subject)params.set("subjectId",subject);
    if(cursor)params.set("cursor",cursor);
    if(evidence){params.set("edgeId",evidence.edgeId);params.set("evidenceStart",String(evidence.start));}
    void graph<FactsResult>(bot,"facts",params,controller.signal).then(v=>{if(active)setResult(v);})
      .catch(e=>{if(active)onFailure(e.message);});
    return ()=>{active=false;controller.abort();};
  },[bot,scope,query,pageId,view,cursor,evidence,event,subject]);
  return <section aria-label="Fact timeline"><h3>Subjects · Fact edges · Event timeline</h3>
    <label>時間檢視<select value={view} onChange={e=>{setView(e.target.value);setCursor("");setEvidence(undefined);}}>
      <option value="current">只看最新狀態</option><option value="history">查看歷史</option></select></label>
    {(event || subject) && <button onClick={()=>{setEvent(undefined);setSubject(undefined);setCursor("");setEvidence(undefined);}}>清除事件／Subject 篩選</button>}
    {!result?<p role="status">Loading facts…</p>:<>
      <details><summary>展開 Wiki 內 Subject（{result.subjects.length}）</summary><ul>{result.subjects.map(s=><li key={`${s.visibility}:${s.subjectId}`}>
        <details><summary>{s.canonicalName} · {s.type}</summary>Subject {s.subjectId} · Wiki {s.wikiPageId} · section {s.sectionKey}{s.parentSubjectId && ` · parent ${s.parentSubjectId}`}<button onClick={()=>{setSubject(s.subjectId);setCursor("");setEvidence(undefined);}}>查看 Subject 關係</button></details>
      </li>)}</ul></details>
      {!result.edges.length && <p>此範圍沒有可用的 Fact Edge。</p>}
      <ol>{result.edges.slice().sort((a,b)=>(a.time.occurredFrom??"9999").localeCompare(b.time.occurredFrom??"9999")).map(e=><li key={`${e.visibility}:${e.edgeId}`}>
        <details><summary>{e.time.occurredFrom??"時間未知"}{e.time.occurredTo && ` — ${e.time.occurredTo}`} · {e.fromSubject.canonicalName} → {e.toSubject.canonicalName} · {e.relation} · {e.view}</summary>
          <p>{e.description}</p><p>{e.certainty} · {e.attribution} · {e.time.timePrecision} · {e.time.originalTimeText} · Event {e.eventId??"—"}</p>
          {e.eventId && <button onClick={()=>{setEvent(e.eventId);setCursor("");setEvidence(undefined);}}>查看同一事件</button>}
          {e.uncertainty && <p role="status">時間或主張不確定：{e.uncertainty}</p>}
          {!!e.changes.length && <ul aria-label="較早狀態">{e.changes.map(c=><li key={c.edgeId}><button onClick={()=>{setView("history");setCursor("");setEvidence({edgeId:c.edgeId,start:0});}}>{c.time.occurredFrom} · {c.description}</button></li>)}</ul>}
          <ul>{e.evidence.map((v,i)=><li key={i}><blockquote>{v.quote}</blockquote>Source {v.sourceId} v{v.sourceVersion} · position {v.position} · {v.attribution}</li>)}</ul>
          <p>Evidence {e.evidenceStart+1}–{Math.min(e.evidenceStart+4,e.evidenceTotal)} / {e.evidenceTotal}</p>
          {e.evidenceStart+4<e.evidenceTotal && <button onClick={()=>{setCursor("");setEvidence({edgeId:e.edgeId,start:e.evidenceStart+4});}}>更多來源證據</button>}
          <ul>{e.provenance.map((p,i)=><li key={i}>{"kind" in p?`Document ${p.title} v${p.version}`:`Bot ${p.botId} · thread ${p.threadId} · run ${p.runId}`}</li>)}</ul>
        </details>
      </li>)}</ol>
      {result.partial && <p>目前為有界查詢視窗，結果可能不完整。</p>}
      {result.nextCursor && <button onClick={()=>{setResult(undefined);setCursor(result.nextCursor!);}}>下一頁 Fact Edges</button>}
    </>}
  </section>;
}
