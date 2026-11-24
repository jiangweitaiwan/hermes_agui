import { z } from "zod";
import type { BotAuthentication } from "../bots/auth";
import { sameOrigin } from "../bots/api";
import { boundedText } from "../http-body";
import { ControlError, roles } from "./control-contract";
import { ControlStore } from "./control-store";
import { VertexStructuredLLMClient } from "./providers/vertex";
import { OpenAICompatibleClient } from "./providers/openai-compatible";
import { ModelRegistry } from "./config";
import { managedTransport } from "./managed-transport";

const revision = z.number().int().positive();
const reason = z.string().trim().min(1).max(500);
const shapes = {
  draft: z.object({ expectedRevision: revision, config: z.unknown() }).strict(),
  publish: z.object({ expectedGeneration: revision, draftRevision: revision,
    candidateHash: z.string().regex(/^[a-f0-9]{64}$/), reason }).strict(),
  rollback: z.object({ target: z.string().min(1).max(100), expectedGeneration: revision, reason }).strict(),
  probe: z.object({ providerId: z.string().min(1).max(100), draftRevision: revision }).strict(),
};
async function readControl(store:ControlStore,path:string,url:URL){
  const readers=new Map<string,()=>unknown>([
    ["draft",()=>store.draft()],
    ["tasks",async()=>({mode:store.policy.mode,roles,active:await store.active(),
      nativeParameters:{retries:"additional attempts",timeoutMs:"per provider request",maxTokens:"native output budget"}})],
    ["providers",()=>providerOptions(store)],
    ["releases",()=>{
      const before=url.searchParams.get("before")??undefined;
      return store.history(before);
    }],
  ]);
  const reader=readers.get(path);
  if(!reader)throw new ControlError(404,"Unknown route");
  return reader();
}
function providerOptions(store:ControlStore){
  return store.policy.approved.providers.map(provider=>({...provider,
    models:store.policy.approved.models.filter(m=>m.provider===provider.id).map(m=>m.model),
    modelsByRole:Object.fromEntries(roles.map(role=>[role,provider.capabilities.includes(role==="graph_embedding"?"embedding":role==="agent_primary"?"chat":"structured_output")
      ? [...new Set(store.policy.approved.models.filter(m=>m.provider===provider.id && (role==="graph_embedding"?m.alias===role:m.alias!=="graph_embedding")).map(m=>m.model))] : []])),
    credentialAvailable:provider.driver==="vertex"?null:!!process.env[provider.keyEnv],
  }));
}
function mutations(store:ControlStore,probe:(input:z.infer<typeof shapes.probe>,actor:string)=>Promise<unknown>){
  return new Map<string,(body:unknown,actor:string)=>Promise<unknown>>([
    ["PATCH draft",async(body,actor)=>{const v=shapes.draft.parse(body);return store.update(v.config,v.expectedRevision,actor);}],
    ["POST validate",async(body,actor)=>{z.object({}).strict().parse(body);return store.validate(actor);}],
    ["POST releases",async(body,actor)=>{const v=shapes.publish.parse(body);return store.publish(v.expectedGeneration,v.draftRevision,v.candidateHash,actor,v.reason);}],
    ["POST rollback",async(body,actor)=>{const v=shapes.rollback.parse(body);return store.rollback(v.target,v.expectedGeneration,actor,v.reason);}],
    ["POST providers/test",async(body,actor)=>probe(shapes.probe.parse(body),actor)],
  ]);
}
/** Process-local limits supplement deployment instance/ingress limits; probes never accept source text. */
export function controlApi(store: ControlStore, auth: Pick<BotAuthentication, "authenticate">) {
  const windows = new Map<string, { start: number; count: number }>();
  let probes = 0;
  async function probe(input: z.infer<typeof shapes.probe>, actor: string) {
    if (probes >= 2) throw new ControlError(429, "Probe capacity reached");
    probes++;
    try{
    const draft = await store.draft();
    if (draft.revision !== input.draftRevision) throw new ControlError(409, "Draft changed; reload");
    const registry = new ModelRegistry(draft.config), provider = registry.provider(input.providerId);
    const model = registry.config.models.find(m => m.provider === provider.id && m.alias !== "graph_embedding");
    if (!model) throw new ControlError(422, "No synthetic chat probe for this provider");
    const started = Date.now();
    try {
      await store.audit(store.pool, "probe", actor);
      const bounded = { ...model, timeoutMs: Math.min(model.timeoutMs, 5000), retries: 0, maxTokens: 32, fallback: [] };
      const client = provider.driver === "vertex" ? new VertexStructuredLLMClient(provider, bounded,managedTransport) : new OpenAICompatibleClient(provider, bounded,managedTransport);
      const output = await client.generate("Return the JSON object {\"ok\":true}.", { synthetic: true },
        { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, AbortSignal.timeout(5000));
      return { status: z.object({ ok: z.literal(true) }).strict().safeParse(output).success ? "ok" : "invalid_output", latencyMs: Date.now() - started };
    } catch { return { status: "failed", latencyMs: Date.now() - started }; }
    }finally { probes--; }
  }
  const writes=mutations(store,probe);
  return async (request: Request) => {
    const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    try {
      const identity = auth.authenticate(request);
      if (!identity) return response({ error: "Authentication required" }, 401);
      if (!store.policy.admins.includes(identity.principal)) return response({ error: "Deployment administrator required" }, 403);
      if (!sameOrigin(request)) return response({ error: "Origin denied" }, 403);
      const now = Date.now();
      for (const [key, value] of windows) if (now - value.start >= 60000) windows.delete(key);
      const window = windows.get(identity.principal) ?? { start: now, count: 0 };
      windows.set(identity.principal, window);
      if (++window.count > 30) return response({ error: "Rate limit" }, 429);
      const url = new URL(request.url), path = url.pathname.slice("/api/admin/llm/".length);
      if ([...url.searchParams.keys()].some(key => key !== "before")) return response({ error: "Unknown query or scope" }, 422);
      if (request.method === "GET")return response(await readControl(store,path,url));
      const text = await boundedText(request, 65536);
      if (text === undefined) return response({ error: "Input too large" }, 413);
      const body = JSON.parse(text);
      const action=writes.get(`${request.method} ${path}`);
      if(!action)return response({error:"Unknown route"},404);
      return response(await action(body,identity.principal),request.method==="POST" && path==="releases"?201:200);
    } catch (error) {
      if (error instanceof ControlError) return response({ error: error.message }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ error: "Invalid control input" }, 422);
      return response({ error: "Control plane unavailable or configuration rejected" }, 503);
    }
  };
}
