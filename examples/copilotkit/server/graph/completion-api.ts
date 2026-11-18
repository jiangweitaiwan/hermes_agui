import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SessionIngestor } from "./session-ingestor";
import { NamespaceSchema } from "./types";

const id = z.string().min(1).max(512);
const bounded = (limit: number) => z.string().refine(text => Buffer.byteLength(text) <= limit);
const completion = z.object({
  namespace: NamespaceSchema.extend({ visibility: z.literal("bot_private") }),
  threadId: id, runId: id, messageId: id, user: bounded(16384),
  assistants: z.tuple([z.object({ id: z.literal("final"), text: bounded(65536) }).strict()]),
}).strict();

export function createCompletionApi(ingestor: SessionIngestor, token: string) {
  if (!/^[\x21-\x7e]{32,}$/.test(token)) throw new Error("Invalid Graph completion token");
  const expected = Buffer.from(`Bearer ${token}`);
  return async (request: Request): Promise<Response> => {
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return new Response(null, { status: 401 });
    }
    const value = completion.safeParse(await request.json().catch(() => undefined));
    if (!value.success) return new Response(null, { status: 400 });
    if (!ingestor.authorized(value.data.namespace)) return new Response(null, { status: 403 });
    // Let store failures escape so the Host leaves the event eligible for redelivery.
    ingestor.enqueue(value.data);
    return new Response(null, { status: 204 });
  };
}
