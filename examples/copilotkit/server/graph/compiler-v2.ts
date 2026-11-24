import { domainStage, requireAccepted, ValidationError, result, issue } from "../llm/validation/pipeline";
import { validateIntegrity } from "../llm/validation/integrity";
import type { CompilerLLM } from "./compiler";
import type { IngestStore } from "./ingest-store";
import type { RawSource } from "./ingest-queue";
import type { Namespace } from "./types";
import { parseSource, evidence } from "./parser";
import { resolveSubjects } from "./subject-matcher";
import { abstractRelations } from "./relation-abstractor";
import { rewriteWiki, sourceProvenance } from "./wiki-rewriter";
import { validateMerge } from "./wiki-merger";
import { digest } from "./wiki-store";
import type { Attribute, GraphPublication } from "./v2-types";
export async function compileV2(queue: IngestStore, llm: CompilerLLM, ns: Namespace, source: RawSource, signal: AbortSignal): Promise<GraphPublication> {
  if (!queue.graphSubjects || !queue.graphAttributes) throw new Error("V2 persistence unavailable");
  const parsed = await domainStage("v2-parser","REF_INVALID",()=>parseSource(llm,source,signal));
  const existing = await queue.graphSubjects(ns);
  const matches = await domainStage("v2-subject-disambiguation","IDENTITY_UNCERTAIN",()=>resolveSubjects(parsed,existing,llm,signal));
  if (matches.some(m => m.status === "unresolved")) throw new ValidationError(result("v2-subject-disambiguation",[issue("v2-subject-disambiguation","domain","IDENTITY_UNCERTAIN","needs_review")]));
  const subjects = [...new Map(matches.map(m => [m.subject!.subjectId,m.subject!])).values()];
  const attributes: Attribute[] = parsed.stableAttributes.map(a => {
    const subjectId = matches.find(m => m.ref === a.subjectRef)!.subject!.subjectId;
    return {attributeId:`attr_${digest(JSON.stringify([subjectId,a.kind,a.text]))}`,subjectId,kind:a.kind,text:a.text,
      evidence:evidence(source,{quote:a.quote,position:a.position})};
  });
  // Identity is a stable profile attribute, so newly discovered entities can have a minimal Wiki.
  // Existing subjects with only new events do not acquire another Wiki revision.
  for (const match of matches.filter(m => m.status === "create")) {
    const item = parsed.subjects.find(s => s.ref === match.ref)!;
    const subject = match.subject!;
    attributes.push({attributeId:`attr_${digest(JSON.stringify([subject.subjectId,"identity"]))}`,subjectId:subject.subjectId,
      kind:"background",text:subject.canonicalName,evidence:evidence(source,{quote:item.quote,position:item.position})});
  }
  const relations = await domainStage("v2-relations","TEMPORAL_INVALID",()=>abstractRelations(llm,parsed,matches,source,source.referenceTime,signal));
  const pages = [];
  for (const pageId of new Set(attributes.map(a => subjects.find(s => s.subjectId === a.subjectId)!.wikiPageId))) {
    const current = await queue.current(ns,pageId);
    const grouped = [...new Map([...existing,...subjects].filter(s => s.wikiPageId === pageId).map(s => [s.subjectId,s])).values()];
    const oldAttributes = await queue.graphAttributes(ns,pageId);
    const all = [...oldAttributes,...attributes.filter(a => grouped.some(s => s.subjectId === a.subjectId))];
    validateMerge(current?.page,grouped,all);
    const sources = [...(current?.page.sources ?? []),sourceProvenance(source,ns)];
    const page = rewriteWiki(grouped,all,sources,current);
    if (page) pages.push(page);
  }
  const publication:GraphPublication={compilerVersion:"v2",pages,subjects,attributes,...relations};
  requireAccepted(validateIntegrity(publication,source));
  return publication;
}
