import { createHash } from "node:crypto";
import { z } from "zod";
import { PageSchema } from "./types";
import { BotError } from "../bots/types";

const visibility = z.enum(["bot_private", "project_shared"]);
export const pageId = z.string().min(1).max(200).regex(/^[\p{L}\p{N}_-]+$/u);
const integer = (fallback: number, maximum: number) => z.string().regex(/^[1-9][0-9]*$/)
  .transform(Number).refine(n => n <= maximum).default(String(fallback));
const schema = z.object({
  scope: z.enum(["all", "bot_private", "project_shared"]).default("all"),
  limit: integer(100, 300), cursor: z.string().max(2048).optional(),
  type: PageSchema.shape.type.optional(), verification: PageSchema.shape.verification,
  q: z.string().trim().min(1).max(512).refine(s => Buffer.byteLength(s) <= 2048).optional(),
  view: z.enum(["current","history"]).default("current"),
  subjectId: pageId.optional(), edgeId: pageId.optional(), eventId: pageId.optional(),
  evidenceStart: z.string().regex(/^[0-9]{1,2}$/).transform(Number).default("0"),
  pageId: pageId.optional(), visibility: visibility.optional(), depth: integer(1, 2),
}).strict();
export type BrowserQuery = z.infer<typeof schema>;
export function parseQuery(url: URL, endpoint: string): BrowserQuery {
  const allowed: Record<string, string[]> = {
    facts: ["scope","limit","cursor","q","view","subjectId","edgeId","eventId","pageId","evidenceStart"],
    pages: ["scope", "limit", "cursor", "type", "verification", "q"],
    network: ["view", "scope", "limit", "cursor", "type", "verification", "q", "pageId", "visibility", "depth"],
    search: ["scope", "limit", "cursor", "q", "type", "verification"],
    stats: ["scope"], health: ["scope"], jobs: ["scope", "limit"], detail: ["scope"],
  };
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed[endpoint]?.includes(key) || key in values) throw new BotError(400, "Invalid query");
    values[key] = value;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw new BotError(400, "Invalid query");
  const q = parsed.data;
  if (endpoint === "search" && !q.q) throw new BotError(400, "Query required");
  if (q.visibility && !q.pageId) throw new BotError(400, "Focus requires pageId");
  if (endpoint !== "facts" && q.pageId && !q.visibility) throw new BotError(400, "Focus requires visibility");
  if (q.visibility && q.scope !== "all" && q.scope !== q.visibility) throw new BotError(400, "Focus outside scope");
  if (endpoint === "jobs") q.limit = Math.min(q.limit, 50);
  return q;
}
const cursorSchema = z.object({ key: z.string().length(64), after: z.string().max(512) }).strict();
export function pagination(query: BrowserQuery, binding: string) {
  const { cursor, ...filters } = query;
  const key = createHash("sha256").update(JSON.stringify([binding, filters])).digest("hex");
  let after = "";
  if (cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      if (value.key !== key) throw new Error();
      after = value.after;
    } catch { throw new BotError(400, "Invalid cursor"); }
  }
  return { after, encode: (last: string) => Buffer.from(JSON.stringify({ key, after: last })).toString("base64url") };
}
