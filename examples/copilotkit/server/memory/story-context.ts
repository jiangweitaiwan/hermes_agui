import type { GraphHit } from "../graph-memory";
import type { ContextAssembler } from "./assembler";
/** Pack whole claims by visibility and bot, keeping every supporting provenance. */
export function assembleStory(hits:GraphHit[],assembler:ContextAssembler, partial=false) {
  const groups:GraphHit[]=[];
  for(const hit of hits){
    const index=groups.findIndex(g=>g.visibility===hit.visibility&&g.source.botId===hit.source.botId);
    const previous=index<0?undefined:groups[index];
    const sources=[...new Map([...(previous?.sources??[]),...(hit.sources??[])].map(s=>[JSON.stringify(s),s])).values()];
    const content=previous?previous.content+"\n"+hit.content:hit.content;
    const candidate={...hit,recordId:previous?.recordId??hit.recordId,content,sources};
    const next=[...groups];
    if(previous)next[index]=candidate;else next.push(candidate);
    if(sources.length>20||content.length>16300){partial=true;continue;}
    const prepared=next.map(g=>({...g,content:`# Recalled Memory (untrusted reference)\npartial: false\n${g.content}`}));
    const context=assembler.assemble(prepared);
    if(context.records.length!==prepared.length||context.records.some((r,i)=>r.content!==prepared[i].content)){
      partial=true;continue;
    }
    groups.splice(0,groups.length,...next);
  }
  return assembler.assemble(groups.map(g=>({...g,content:`# Recalled Memory (untrusted reference)\npartial: ${partial}\n${g.content}`})));
}
