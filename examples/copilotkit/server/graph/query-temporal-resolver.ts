import type { QueryTime } from "./query-types";
import type { ReferenceTime } from "./temporal-resolver";
import type { FactEdge } from "./v2-types";
import { temporalView } from "./temporal-view";
/** Convert a local calendar midnight using the supplied IANA zone (including DST). */
function midnight(day: string, timezone: string) {
  const target = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0,10) !== day) throw new Error("Invalid calendar date");
  let instant = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  for (let i=0;i<3;i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type,p.value]));
    const displayed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    instant += target - displayed;
  }
  return new Date(instant).toISOString();
}
function nextDay(day:string) { return new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10); }
function calendar(text:string, reference?:ReferenceTime):string | undefined {
  if (text === "上週三" && reference) {
    const local = new Intl.DateTimeFormat("en-CA",{timeZone:reference.timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(reference.instant));
    const d = new Date(`${local}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay()+6)%7) - 7 + 2);
    return d.toISOString().slice(0,10);
  }
  const m = /^(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (!m || (!m[1] && !reference)) return;
  const year = m[1] ?? new Intl.DateTimeFormat("en",{timeZone:reference!.timezone,year:"numeric"}).format(new Date(reference!.instant));
  return `${year}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
}
export function resolveQueryTime(time:QueryTime, reference?:ReferenceTime, anchors:FactEdge[]=[]):QueryTime {
  const unknown = {...time,confidence:"uncertain" as const};
  try {
    if (["before_event","after_event"].includes(time.kind)) {
      const events = anchors.filter(e => comparable(e));
      const dates = new Set(events.map(e => e.time.occurredFrom));
      if (!events.length || dates.size !== 1 || events.length !== anchors.length) return unknown;
      const date = events[0].time.occurredFrom!;
      return {...time,confidence:"certain", ...(time.kind === "before_event" ? {to:new Date(Date.parse(date)-1).toISOString()} : {from:new Date(Math.max(...events.map(e=>Date.parse(e.time.occurredTo ?? date)))+1).toISOString()})};
    }
    if (!["exact","range","as_of"].includes(time.kind)) return {...time,confidence:["unknown","previous_event"].includes(time.kind)?"uncertain":"certain"};
    const raw = (time.originalText ?? "").replace(/^(?:截至|as of)\s*/i,"").trim();
    const dates = raw.split(/\s*(?:至|到|\.\.|\bto\b|~|–)\s*/);
    const first = calendar(dates[0],reference), last = time.kind === "range" ? calendar(dates[1] ?? "",reference) : first;
    if (!first || !last || first > last) return unknown;
    const timezone = reference?.timezone ?? "UTC";
    return {...time,timezone,from:midnight(first,timezone),to:new Date(Date.parse(midnight(nextDay(last),timezone))-1).toISOString(),confidence:"certain"};
  } catch { return unknown; }
}
function comparable(e:FactEdge) { return e.time.confidence === "certain" && !!e.time.occurredFrom && e.certainty !== "disputed" && e.status !== "disputed"; }
export function queryTemporalView(edges:FactEdge[], time:QueryTime) {
  if (time.kind === "current") return temporalView(edges,{mode:"current"});
  if (["as_of","before_event"].includes(time.kind) && time.confidence === "certain") return temporalView(edges,{mode:"as_of",at:time.to});
  let rows = temporalView(edges,{mode:"history",from:time.confidence === "certain" ? time.from:undefined,to:time.confidence === "certain" ? time.to:undefined});
  if (time.kind === "previous_event") {
    const events = rows.filter(r=>r.edge.factKind === "event" && comparable(r.edge));
    const last = events.at(-1)?.edge.time.occurredFrom;
    // Unknown event dates cannot establish an objective previous event.
    if (last && rows.every(r=>comparable(r.edge))) rows = rows.filter(r=>r.edge.time.occurredFrom === last);
    else return rows.map(r=>({...r,view:"uncertain" as const}));
  }
  if (time.confidence === "uncertain" || time.kind === "unknown") return rows.map(r=>({...r,view:"uncertain" as const}));
  return rows;
}
