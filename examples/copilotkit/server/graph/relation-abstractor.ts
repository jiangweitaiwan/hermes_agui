import { validateRelation } from "../llm/validation/relation";
import { requireAccepted, issue, result } from "../llm/validation/pipeline";
import { promptFor } from "../llm/prompts/registry";
import type { CompilerLLM } from "./compiler";
import type { Parsed } from "./parser";
import { evidence } from "./parser";
import type { RawSource } from "./ingest-queue";
import type { Match } from "./subject-matcher";
import { EdgeSchema, type FactEdge, type MemoryEvent } from "./v2-types";
import { resolveTime, type ReferenceTime } from "./temporal-resolver";
import { digest } from "./wiki-store";
import { resolveQueryTime } from "./query-temporal-resolver";
import { RelationOutputSchema as Output } from "../llm/schema/relations";
export async function abstractRelations(llm: CompilerLLM, parsed: Parsed, matches: Match[], source: RawSource, reference: ReferenceTime | undefined, signal: AbortSignal) {
  const output = Output.parse(await llm.json("v2-relations", { schema:'{edges:[{narrativeRef,fromRef,toRef,relation,relationType?,relationLabel?,description,factKind,stateProperty?,certainty}]}',
    relations:EdgeSchema.innerType().shape.relation.options,subjects:parsed.subjects,narratives:parsed.narratives,
    rule: promptFor("v2-relations").rule },signal));
  const subjects = new Map(matches.map(m => [m.ref,m.subject]));
  const times = narrativeTimes(parsed,reference);
  const events = new Map<string,MemoryEvent>(); const edges: FactEdge[] = [];
  for (const proposal of output.edges) {
    requireAccepted(validateRelation(parsed,proposal));
    const n = parsed.narratives.find(n => n.ref === proposal.narrativeRef);
    const from = subjects.get(proposal.fromRef), to = subjects.get(proposal.toRef);
    if (!n || !n.subjectRefs.includes(proposal.fromRef) || !n.subjectRefs.includes(proposal.toRef)) throw new Error("Relation outside narrative");
    if (!from || !to) throw new Error("Unresolved relation subject");
    if(evidence(source,{quote:n.quote,position:n.position}).attribution==="assistant_unverified")requireAccepted(result("v2-relations",[issue("v2-relations","evidence","ATTRIBUTION_UNCERTAIN","needs_review")]));
    const time = times.get(n.ref)!;
    const eventId = `event_${digest(JSON.stringify([source.hash,n.eventRef,reference?.instant ?? source.id])).slice(0,32)}`;
    if (!events.has(eventId)) events.set(eventId,{eventId,title:n.text,summary:n.text,time});
    const semanticHash = digest(JSON.stringify([from.subjectId,to.subjectId,proposal.relation,proposal.description,proposal.factKind,time,
      // Unknown time cannot establish that independent sessions describe the same event.
      time.occurredFrom ? null : [source.id,n.ref],...(proposal.relationType || proposal.relationLabel ? [proposal.relationType ?? null,proposal.relationLabel ?? null]:[])]));
    edges.push(EdgeSchema.parse({ edgeId:`edge_${semanticHash}`,eventId,fromSubjectId:from.subjectId,toSubjectId:to.subjectId,
      relation:proposal.relation,relationType:proposal.relationType,relationLabel:proposal.relationLabel,description:proposal.description,factKind:proposal.factKind,
      stateSlotKey:proposal.stateProperty ? `${from.subjectId}:${proposal.stateProperty}` : undefined,time,observedAt:reference?.instant,
      recordedAt:new Date().toISOString(),certainty:proposal.certainty,status:proposal.certainty === "disputed" ? "disputed":"active",semanticHash,attribution:evidence(source,{quote:n.quote,position:n.position}).attribution,
      evidence:[evidence(source,{quote:n.quote,position:n.position})] }));
  }
  return {events:[...events.values()],edges};
}

function narrativeTimes(parsed:Parsed,reference:ReferenceTime|undefined) {
  const times = new Map<string,ReturnType<typeof resolveTime>>();
  for (const narrative of parsed.narratives) {
    if (narrative.anchorRef && !times.has(narrative.anchorRef)) throw new Error("Missing temporal anchor");
    if (narrative.anchorRef && !times.get(narrative.anchorRef)?.occurredFrom) {
      times.set(narrative.ref,{timePrecision:"relative",originalTimeText:narrative.timeText,confidence:"uncertain"}); continue;
    }
    const expression = narrative.timeExpression;
    if (expression) {
      if (expression.originalText && !narrative.quote.includes(expression.originalText)) throw new Error("Unsupported time expression");
      const resolved = resolveQueryTime(expression,reference);
      times.set(narrative.ref,{originalTimeText:expression.originalText ?? narrative.timeText,timezone:resolved.timezone,
        occurredFrom:resolved.from,occurredTo:resolved.to,timePrecision:resolved.from ? "day":"unknown",confidence:resolved.confidence ?? "uncertain"});
    } else times.set(narrative.ref, resolveTime(narrative.timeText,reference,narrative.anchorRef ? times.get(narrative.anchorRef)?.occurredFrom : undefined));
  }
  return times;
}
