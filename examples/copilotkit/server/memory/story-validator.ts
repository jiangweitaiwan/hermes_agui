import type { MemoryNet } from "../graph/memory-net";
import { StorySchema, type MemoryStory } from "./story-types";
export function groundedStory(net:MemoryNet):MemoryStory {
  const claims:MemoryStory["claims"]=[...net.edges.map(e=>({text:e.description,edgeIds:[e.edgeId],wikiSections:[],
    confidence:(e.certainty==="disputed"?"conflicting":e.attribution==="assistant_unverified"||e.view==="uncertain"||e.time.confidence==="uncertain"||e.certainty!=="reported"?"uncertain":"supported") as "conflicting"|"uncertain"|"supported"})),
    ...net.wikiSections.map(s=>({text:s.text,edgeIds:[],wikiSections:[{pageId:s.pageId,sectionKey:s.sectionKey,revision:s.revision}],confidence:"uncertain" as const}))];
  return {summary:claims.map(c=>c.text).join("\n"),claims,events:[],warnings:[]};
}
/** Extractive contract deliberately rejects paraphrases: references alone cannot prove semantics. */
export function validateStory(output:unknown,net:MemoryNet):MemoryStory {
  if(Buffer.byteLength(JSON.stringify(output)??"")>32768)throw new Error("Story output budget");
  const story=StorySchema.parse(output),allowed=groundedStory(net).claims;
  if(story.events.length||story.warnings.length||story.summary!==story.claims.map(c=>c.text).join("\n"))throw new Error("Ungrounded free text");
  if(story.claims.length!==allowed.length)throw new Error("Missing claims");
  const remaining=allowed.map(c=>JSON.stringify(c));
  for(const claim of story.claims){const index=remaining.indexOf(JSON.stringify(claim));if(index<0)throw new Error("Unsupported or repeated claim");remaining.splice(index,1);}
  return story;
}
