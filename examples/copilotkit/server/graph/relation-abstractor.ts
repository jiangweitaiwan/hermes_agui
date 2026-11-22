import { z } from "zod";
import type { CompilerLLM } from "./compiler";
import type { Parsed } from "./parser";
import { evidence } from "./parser";
import type { RawSource } from "./ingest-queue";
import type { Match } from "./subject-matcher";
import { EdgeSchema, type FactEdge, type MemoryEvent } from "./v2-types";
import { resolveTime, type ReferenceTime } from "./temporal-resolver";
import { digest } from "./wiki-store";
const Output = z.object({ edges: z.array(z.object({ narrativeRef:z.string().max(100),fromRef:z.string().max(100),toRef:z.string().max(100),
  relation:EdgeSchema.innerType().shape.relation,description:z.string().min(1).max(1000),factKind:z.enum(["event","state"]),
  stateProperty:z.string().regex(/^[a-z_]{1,80}$/).optional(),certainty:z.enum(["reported","inferred","disputed"]),
}).strict()).max(96) }).strict();
export async function abstractRelations(llm: CompilerLLM, parsed: Parsed, matches: Match[], source: RawSource, reference: ReferenceTime | undefined, signal: AbortSignal) {
  const output = Output.parse(await llm.json("v2-relations", { schema:'{edges:[{narrativeRef,fromRef,toRef,relation,description,factKind,stateProperty?,certainty}]}',
    relations:EdgeSchema.innerType().shape.relation.options,subjects:parsed.subjects,narratives:parsed.narratives,
    rule:"Only explicitly source-supported actors and directed relations. Do not attribute AI assistant actions to Bob. Use stateProperty only for comparable mutable state; independent events never share a state slot." },signal));
  const subjects = new Map(matches.map(m => [m.ref,m.subject]));
  const times = new Map<string,ReturnType<typeof resolveTime>>();
  for (const narrative of parsed.narratives) {
    if (narrative.anchorRef && !times.has(narrative.anchorRef)) throw new Error("Missing temporal anchor");
    if (narrative.anchorRef && !times.get(narrative.anchorRef)?.occurredFrom) {
      times.set(narrative.ref,{timePrecision:"relative",originalTimeText:narrative.timeText,confidence:"uncertain"}); continue;
    }
    times.set(narrative.ref, resolveTime(narrative.timeText,reference,narrative.anchorRef ? times.get(narrative.anchorRef)?.occurredFrom : undefined));
  }
  const events = new Map<string,MemoryEvent>(); const edges: FactEdge[] = [];
  for (const proposal of output.edges) {
    const n = parsed.narratives.find(n => n.ref === proposal.narrativeRef);
    const from = subjects.get(proposal.fromRef), to = subjects.get(proposal.toRef);
    if (!n || !n.subjectRefs.includes(proposal.fromRef) || !n.subjectRefs.includes(proposal.toRef)) throw new Error("Relation outside narrative");
    if (!from || !to) throw new Error("Unresolved relation subject");
    const time = times.get(n.ref)!;
    const eventId = `event_${digest(JSON.stringify([source.hash,n.eventRef,reference?.instant ?? source.id])).slice(0,32)}`;
    if (!events.has(eventId)) events.set(eventId,{eventId,title:n.text,summary:n.text,time});
    const semanticHash = digest(JSON.stringify([from.subjectId,to.subjectId,proposal.relation,proposal.description,proposal.factKind,time,
      // Unknown time cannot establish that independent sessions describe the same event.
      time.occurredFrom ? null : [source.id,n.ref]]));
    edges.push(EdgeSchema.parse({ edgeId:`edge_${semanticHash}`,eventId,fromSubjectId:from.subjectId,toSubjectId:to.subjectId,
      relation:proposal.relation,description:proposal.description,factKind:proposal.factKind,
      stateSlotKey:proposal.stateProperty ? `${from.subjectId}:${proposal.stateProperty}` : undefined,time,observedAt:reference?.instant,
      recordedAt:new Date().toISOString(),certainty:proposal.certainty,status:proposal.certainty === "disputed" ? "disputed":"active",semanticHash,attribution:evidence(source,{quote:n.quote,position:n.position}).attribution,
      evidence:[evidence(source,{quote:n.quote,position:n.position})] }));
  }
  return {events:[...events.values()],edges};
}
