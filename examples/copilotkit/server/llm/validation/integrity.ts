import type { GraphPublication } from "../../graph/v2-types";
import { GraphDataSchema } from "../../graph/v2-types";
import type { RawSource } from "../../graph/ingest-queue";
import { digest } from "../../graph/wiki-store";
import { validateSpan } from "./evidence";
import { result, issue, type Issue } from "./pipeline";
export function validateIntegrity(publication:GraphPublication,source:RawSource){
  const stage="v2-relations",issues:Issue[]=[];
  const {subjects,attributes,edges,events}=publication;
  if(!GraphDataSchema.safeParse({subjects,attributes,edges,events}).success)return result(stage,[issue(stage,"domain","REF_INVALID")]);
  const subjectIds=new Set(subjects.map(s=>s.subjectId)),eventIds=new Set(events.map(e=>e.eventId));
  for(const list of [subjects.map(s=>s.subjectId),attributes.map(a=>a.attributeId),edges.map(e=>e.edgeId),events.map(e=>e.eventId)]){
    if(new Set(list).size!==list.length)issues.push(issue(stage,"domain","REF_INVALID"));
  }
  for(const edge of edges){
    if(!subjectIds.has(edge.fromSubjectId)||!subjectIds.has(edge.toSubjectId)||(edge.eventId&&!eventIds.has(edge.eventId)))issues.push(issue(stage,"domain","REF_INVALID"));
    if(edge.time.occurredFrom&&edge.time.occurredTo&&Date.parse(edge.time.occurredFrom)>Date.parse(edge.time.occurredTo))issues.push(issue(stage,"domain","TEMPORAL_INVALID"));
  }
  for(const a of attributes)if(!subjectIds.has(a.subjectId))issues.push(issue(stage,"domain","REF_INVALID"));
  for(const evidence of [...edges.flatMap(e=>e.evidence),...attributes.map(a=>a.evidence)]){
    issues.push(...validateSpan(source,evidence,stage).issues);
    if(evidence.sourceId!==source.id||evidence.sourceVersion!==source.version||evidence.quoteHash!==digest(evidence.quote))issues.push(issue(stage,"evidence","SOURCE_CHANGED"));
  }
  return result(stage,issues,["evidence","domain"]);
}
