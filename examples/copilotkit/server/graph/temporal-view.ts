import type { FactEdge } from "./v2-types";
export interface TemporalIntent { mode: "current" | "history" | "as_of"; at?: string; from?:string; to?:string }
export function temporalIntent(text: string): TemporalIntent {
  const range = text.match(/(\d{4}-\d{2}-\d{2})\s*(?:至|到|\.\.|and|to|~|–)\s*(\d{4}-\d{2}-\d{2})/i);
  if (range && range[1] <= range[2] && [range[1],range[2]].every(d=>Number.isFinite(Date.parse(d)) && new Date(d).toISOString().startsWith(d)))
    return {mode:"history",from:`${range[1]}T00:00:00.000Z`,to:`${range[2]}T23:59:59.999Z`};
  const date = text.match(/(?:as[_ ]of|截至|當時|在)\s*(\d{4}-\d{2}-\d{2})(?:T([0-9:.]+Z))?/i);
  if (date) {
    const at = date[2] ? `${date[1]}T${date[2]}` : `${date[1]}T23:59:59.999Z`;
    if (Number.isFinite(Date.parse(at)) && new Date(at).toISOString().startsWith(date[1])) return {mode:"as_of",at};
  }
  if (/as[_ ]of|截至|當時/i.test(text)) return {mode:"as_of"};
  return {mode: /history|timeline|why|歷史|時間線|為何|如何|怎麼|過程|原因/i.test(text) ? "history" : "current"};
}
export interface TemporalRow { edge: FactEdge; view: "event" | "history" | "latest" | "uncertain"; changes: FactEdge[] }
function comparable(edge: FactEdge) {
  return edge.time.confidence === "certain" && !!edge.time.occurredFrom &&
    !["unknown","relative"].includes(edge.time.timePrecision) && edge.certainty !== "disputed" && edge.status !== "disputed";
}
function end(edge: FactEdge) { return edge.time.occurredTo ?? edge.time.occurredFrom!; }
/** Latest is a view over valid time, never an update to stored facts or an assertion of objective truth. */
export function temporalView(edges: FactEdge[], intent: TemporalIntent): TemporalRow[] {
  const eligible = edges.filter(e => e.status !== "retracted" && (!intent.at || !e.time.occurredFrom || e.time.occurredFrom <= intent.at) &&
    (!intent.to || !e.time.occurredFrom || e.time.occurredFrom <= intent.to) &&
    (!intent.from || !e.time.occurredFrom || end(e) >= intent.from));
  if (intent.mode === "as_of" && !intent.at) return eligible.map(edge=>({edge,view:"uncertain" as const,changes:[]})).sort(order);
  if (intent.mode === "history") return eligible.map(edge => ({edge,view: comparable(edge) ? "history" as const : "uncertain" as const,changes:[]})).sort(order);
  const rows: TemporalRow[] = [], slots = new Map<string, FactEdge[]>();
  for (const edge of eligible) {
    if (edge.factKind === "event") { rows.push({edge,view:comparable(edge) ? "event" : "uncertain",changes:[]}); continue; }
    const key = edge.stateSlotKey!; slots.set(key,[...(slots.get(key) ?? []),edge]);
  }
  for (const group of slots.values()) {
    const certain = group.filter(e => comparable(e) && (!intent.at || end(e) <= intent.at));
    // Overlapping intervals and tied effective dates are incomparable, even when imported later.
    const frontier = certain.filter(e => !certain.some(other => other.time.occurredFrom! > end(e)));
    const uncertain = group.filter(e => !certain.includes(e));
    for (const edge of [...frontier,...uncertain]) rows.push({edge,
      view: frontier.length === 1 && !uncertain.length && frontier[0] === edge ? "latest" : "uncertain",
      changes: group.filter(e => certain.includes(e) && !frontier.includes(e))});
  }
  return rows.sort(order);
}
function order(a: TemporalRow,b: TemporalRow) {
  return (a.edge.time.occurredFrom ?? "9999").localeCompare(b.edge.time.occurredFrom ?? "9999") || a.edge.edgeId.localeCompare(b.edge.edgeId);
}
