import { z } from "zod";
const id = z.string().min(1).max(200).regex(/^[\p{L}\p{N}_-]+$/u);
const text = z.string().trim().min(1).max(1000);
export const TimeSchema = z.object({ occurredFrom: z.string().datetime().optional(), occurredTo: z.string().datetime().optional(),
  timePrecision: z.enum(["instant", "day", "week", "month", "relative", "unknown"]), originalTimeText: text.optional(),
  timezone: z.string().max(100).optional(), anchor: z.string().datetime().optional(), confidence: z.enum(["certain", "uncertain"]),
}).strict();
export const SubjectSchema = z.object({ subjectId: id, canonicalName: text, type: z.enum(["person", "system", "component", "concept", "role", "document", "value"]),
  wikiPageId: id, parentSubjectId: id.optional(), sectionKey: id, identityKey: z.string().min(1).max(512), aliases: z.array(text).max(32),
}).strict();
export const EvidenceSchema = z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().positive(), quote: text,
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/), position: z.number().int().nonnegative(),
  attribution: z.enum(["user_stated", "assistant_unverified", "document_reported"]),
}).strict();
export const EventSchema = z.object({ eventId: id, title: text, summary: text, time: TimeSchema }).strict();
export const EdgeSchema = z.object({ edgeId: id, eventId: id.optional(), fromSubjectId: id, toSubjectId: id,
  relation: z.enum(["reported_issue", "caused_degradation", "rolled_back", "restored", "drafted", "delivered_to", "deployed_version", "related_to"]),
  relationType: z.enum(["action", "state", "association"]).optional(), relationLabel: z.string().trim().min(1).max(80).optional(),
  description: text, factKind: z.enum(["event", "state"]), stateSlotKey: z.string().min(1).max(512).optional(), time: TimeSchema,
  observedAt: z.string().datetime().optional(), recordedAt: z.string().datetime(),
  certainty: z.enum(["reported", "inferred", "disputed"]), status: z.enum(["active", "superseded", "disputed", "retracted"]),
  attribution: EvidenceSchema.shape.attribution, semanticHash: z.string().regex(/^[a-f0-9]{64}$/), evidence: z.array(EvidenceSchema).min(1).max(96),
}).strict().superRefine((v, ctx) => {
  if ((v.factKind === "state") !== !!v.stateSlotKey) ctx.addIssue({ code: "custom", message: "Only states require a slot" });
});
export const AttributeSchema = z.object({ attributeId: id, subjectId: id, kind: z.enum(["background", "role", "expertise", "interest", "design", "component_property"]),
  text, evidence: EvidenceSchema }).strict();
export const GraphDataSchema = z.object({ subjects: z.array(SubjectSchema).max(96), events: z.array(EventSchema).max(96),
  edges: z.array(EdgeSchema).max(96), attributes: z.array(AttributeSchema).max(96) }).strict();
export type Subject = z.infer<typeof SubjectSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type MemoryEvent = z.infer<typeof EventSchema>;
export type FactEdge = z.infer<typeof EdgeSchema>;
export type Attribute = z.infer<typeof AttributeSchema>;
export type GraphData = z.infer<typeof GraphDataSchema>;
export interface GraphPublication extends GraphData { pages: import("./ingest-store").Publication[]; compilerVersion: "v2" }
