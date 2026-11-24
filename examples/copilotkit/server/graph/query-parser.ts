import { validateRetrieval } from "../llm/validation/retrieval";
import { promptFor } from "../llm/prompts/registry";
import type { CompilerLLM } from "./compiler";
import type { QueryParseResult } from "./query-types";
import { QueryPlanSchema } from "../llm/schema/query";
/** Independent query contract: no persistence, source assertions, IDs or ACL fields. */
export class QueryParser {
  constructor(readonly llm: CompilerLLM, readonly timeoutMs = 2000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid query timeout");
  }
  async parse(message: string, signal: AbortSignal): Promise<QueryParseResult> {
    const fallback = (): QueryParseResult => ({status:"fallback",plan:{subjects:[],narratives:[],temporal:{kind:"unknown"}},warnings:["query_parser_unavailable"]});
    if (!message.trim() || Buffer.byteLength(message) > 4096) return fallback();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    let onAbort: (() => void) | undefined;
    try {
      bounded.throwIfAborted();
      const output = await Promise.race([this.llm.json("v3-query", {
        schema: "{subjects:[{ref,name,type?,aliases?}],narratives:[{ref,text,subjectRefs,intent,time:{kind,originalText?,anchorRef?}}],temporal:{kind,originalText?,anchorRef?}}",
        rule: promptFor("v3-query").rule, message,
      }, bounded), new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Query aborted")); bounded.addEventListener("abort", onAbort, {once:true});
      })]);
      bounded.throwIfAborted();
      const plan=validateRetrieval("v3-query",output,()=>{
      if (Buffer.byteLength(JSON.stringify(output)) > 16384) throw new Error("Query output budget");
      const plan = QueryPlanSchema.parse(output);
      const subjects = new Set(plan.subjects.map(s => s.ref)), narratives = new Set(plan.narratives.map(n => n.ref));
      if (subjects.size !== plan.subjects.length || narratives.size !== plan.narratives.length) throw new Error("Duplicate query refs");
      for (const s of plan.subjects) if (![s.name,...s.aliases ?? []].every(n => message.includes(n))) throw new Error("Invented query actor");
      for (const n of plan.narratives) if (!message.includes(n.text) || n.subjectRefs.some(r => !subjects.has(r))) throw new Error("Invalid subject ref");
      for (const time of [plan.temporal,...plan.narratives.map(n => n.time)]) {
        if (time.originalText && !message.includes(time.originalText)) throw new Error("Invented query time");
        if (time.anchorRef && !narratives.has(time.anchorRef)) throw new Error("Invalid anchor ref");
      }
      return plan;
      });
      return {status:"ok",plan,warnings:[]};
    } catch { return fallback(); }
    finally { if (onAbort) bounded.removeEventListener("abort", onAbort); }
  }
}
