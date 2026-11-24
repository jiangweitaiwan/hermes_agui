import type { z } from "zod";
import type { RelationOutputSchema } from "../schema/relations";
import type { Parsed } from "../../graph/parser";
import { issue, result, type Issue } from "./pipeline";
type Proposal=z.infer<typeof RelationOutputSchema>["edges"][number];
/** Parser narrativeRef is the evidence bridge: model cannot select persisted source IDs. */
export function validateRelation(parsed:Parsed,p:Proposal){
  const stage="v2-relations",issues:Issue[]=[];
  const n=parsed.narratives.find(n=>n.ref===p.narrativeRef);
  if(!n||!n.subjectRefs.includes(p.fromRef)||!n.subjectRefs.includes(p.toRef))return result(stage,[issue(stage,"domain","REF_INVALID")]);
  if(!n.quote.includes(p.description)||p.certainty!=="reported"||(p.relationLabel&&!n.quote.includes(p.relationLabel)))issues.push(issue(stage,"evidence","SEMANTIC_UNCERTAIN","needs_review"));
  if(p.factKind==="event"&&p.stateProperty)issues.push(issue(stage,"domain","STATE_EVENT_CONFLICT"));
  if(p.factKind==="state"&&!p.stateProperty)issues.push(issue(stage,"domain","STATE_EVENT_CONFLICT"));
  const from=parsed.subjects.find(s=>s.ref===p.fromRef),to=parsed.subjects.find(s=>s.ref===p.toRef);
  if(!from||!to)return result(stage,[issue(stage,"domain","REF_INVALID")]);
  // Causal prose frequently puts the effect before its cause; ordering alone is unsafe.
  if(p.relation==="caused_degradation"){
    const marker=n.quote.indexOf("原因是");
    if(marker<0||!n.quote.slice(marker).includes(from.name)||!n.quote.slice(0,marker).includes(to.name))issues.push(issue(stage,"evidence","SEMANTIC_UNCERTAIN","needs_review"));
  }
  if(![from,to].every(s=>[s.name,s.quote].some(name=>n.quote.includes(name))))issues.push(issue(stage,"evidence","ATTRIBUTION_UNCERTAIN","needs_review"));
  if(!supportedAction(parsed,p,n.quote))issues.push(issue(stage,"evidence","ATTRIBUTION_UNCERTAIN","needs_review"));
  return result(stage,issues,["evidence","domain"]);
}

function supportedAction(parsed:Parsed,p:Proposal,quote:string):boolean {
  const from=parsed.subjects.find(s=>s.ref===p.fromRef)!,to=parsed.subjects.find(s=>s.ref===p.toRef)!;
  const actions:Partial<Record<Proposal["relation"],RegExp>>={restored:/恢復|restored/i,rolled_back:/回滾|rolled back/i,reported_issue:/報告|reported/i,drafted:/草擬|drafted/i,delivered_to:/交給|delivered to/i,deployed_version:/部署|deployed/i};
  if(/(?:\b(?:not|never|might|maybe|allegedly|if)\b|沒有|不曾|並非|假如|如果|可能)/i.test(quote))return false;
  const action=actions[p.relation];
  if(action){
    const position=quote.search(action);
    const left=quote.slice(0,position),right=p.relation==="rolled_back"?quote.slice(Math.max(0,quote.indexOf(from.name)+from.name.length)):quote.slice(position);
    if(!nearestActor(parsed,p.fromRef,left))return false;
    if(position<0||![from.name,from.quote,...from.aliases].some(name=>left.includes(name))||![to.name,to.quote,...to.aliases].some(name=>right.includes(name)))return false;
  }
  return true;
}

function nearestActor(parsed:Parsed,fromRef:string,prefix:string):boolean {
  const from=parsed.subjects.find(s=>s.ref===fromRef)!;
  if(!["person","role"].includes(from.type))return true;
  const actors=parsed.subjects.filter(s=>["person","role"].includes(s.type));
  const positions=actors.map(s=>({ref:s.ref,position:Math.max(prefix.lastIndexOf(s.name),prefix.lastIndexOf(s.quote))}));
  const own=positions.find(s=>s.ref===fromRef)!.position;
  return own>=0 && !positions.some(s=>s.position>own);
}
