import { z } from "zod";
export const StorySchema = z.object({
  summary:z.string().max(16384),
  claims:z.array(z.object({text:z.string().min(1).max(4096),edgeIds:z.array(z.string()).max(1),
    wikiSections:z.array(z.object({pageId:z.string(),sectionKey:z.string(),revision:z.string()}).strict()).max(1),
    confidence:z.enum(["supported","uncertain","conflicting"])}).strict()).max(80),
  events:z.array(z.object({eventId:z.string(),summary:z.string()}).strict()).max(64),
  warnings:z.array(z.string().max(200)).max(20),
}).strict();
