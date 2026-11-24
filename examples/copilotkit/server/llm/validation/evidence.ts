import type { RawSource } from "../../graph/ingest-queue";
import type { Parsed } from "../../graph/parser";
import { issue, result, type Issue } from "./pipeline";
/** JavaScript offsets are UTF-16 code units, including astral characters. */
export function validateSpan(source:RawSource,item:{quote:string;position:number},stage="v2-parser") {
  const valid=Number.isSafeInteger(item.position)&&item.position>=0&&item.quote.length>0&&utf16Boundary(source.content,item.position)&&utf16Boundary(source.content,item.position+item.quote.length)&&source.content.slice(item.position,item.position+item.quote.length)===item.quote;
  return result(stage,valid?[]:[issue(stage,"evidence","SPAN_INVALID")]);
}
export function validateParsed(source:RawSource,parsed:Parsed) {
  const stage="v2-parser",issues:Issue[]=[];
  const refs=new Set(parsed.subjects.map(s=>s.ref));
  for(const item of [...parsed.subjects,...parsed.narratives,...parsed.stableAttributes])issues.push(...validateSpan(source,item).issues);
  for(const item of [...parsed.narratives,...parsed.stableAttributes]){
    if(!item.quote.includes(item.text))issues.push(issue(stage,"evidence","SEMANTIC_UNCERTAIN","needs_review"));
  }
  if(refs.size!==parsed.subjects.length||new Set(parsed.narratives.map(n=>n.ref)).size!==parsed.narratives.length)issues.push(issue(stage,"domain","REF_INVALID"));
  issues.push(...identityIssues(parsed));
  for(const n of parsed.narratives){
    if(n.subjectRefs.some(r=>!refs.has(r)))issues.push(issue(stage,"domain","REF_INVALID"));
    if(n.timeText && !n.quote.includes(n.timeText))issues.push(issue(stage,"domain","TEMPORAL_INVALID"));
    if(n.anchorRef===n.ref || (n.anchorRef && !parsed.narratives.some(a=>a.ref===n.anchorRef)))issues.push(issue(stage,"domain","TEMPORAL_INVALID"));

  }
  for(const a of parsed.stableAttributes){
    if(!refs.has(a.subjectRef))issues.push(issue(stage,"domain","REF_INVALID"));
    if(/(?:\d{1,2}[/月]\d{1,2}|昨天|隔天|會後|事故|目前部署|yesterday|incident|rolled back)/i.test(a.text))issues.push(issue(stage,"domain","STATE_EVENT_CONFLICT","needs_review"));
  }
  return result(stage,issues,["evidence","domain"]);
}

/** A grouped component may omit a modifier ("本機快取" → "快取"), never invent characters. */
function subsequence(name:string,quote:string):boolean {
  let position=0;
  for(const character of name){const next=quote.indexOf(character,position);if(next<0)return false;position=next+character.length;}
  return true;
}

function identityIssues(parsed:Parsed):Issue[]{
  const stage="v2-parser",issues:Issue[]=[];
  for(const s of parsed.subjects){
    const canonicalComponent=s.type==="component" && !!s.parentRef && s.identity===s.name && subsequence(s.name,s.quote);
    if((!s.quote.includes(s.identity)||!s.quote.includes(s.name))&&!canonicalComponent)issues.push(issue(stage,"domain","IDENTITY_UNCERTAIN","needs_review"));
    for(const alias of s.aliases){
      if(alias.normalize("NFKC").toLowerCase()!==s.name.normalize("NFKC").toLowerCase() && !s.quote.includes(`${s.name}（${alias}）`) && !s.quote.includes(`${s.name} (${alias})`))issues.push(issue(stage,"domain","IDENTITY_UNCERTAIN","needs_review"));
    }
  }
  return issues;
}

function utf16Boundary(text:string,position:number):boolean {
  const before=text.charCodeAt(position-1),after=text.charCodeAt(position);
  return !(before>=0xd800&&before<=0xdbff&&after>=0xdc00&&after<=0xdfff);
}
