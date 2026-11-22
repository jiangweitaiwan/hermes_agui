import type { z } from "zod";
import type { TimeSchema } from "./v2-types";
export interface ReferenceTime { instant: string; timezone: string }
/** Calendar arithmetic uses an explicitly supplied local date, never the machine clock. */
export function resolveTime(originalTimeText: string, reference?: ReferenceTime, previous?: string): z.infer<typeof TimeSchema> {
  const base = { originalTimeText: originalTimeText || undefined, confidence: "uncertain" as const };
  if (!reference && /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(originalTimeText)) {
    const year = originalTimeText.slice(0,4);
    return resolveTime(originalTimeText,{instant:`${year}-01-01T00:00:00.000Z`,timezone:"UTC"});
  }
  if (!reference) return { ...base, timePrecision: "unknown" };
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: reference.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(reference.instant));
  const anchor = `${date}T00:00:00.000Z`;
  const metadata = { originalTimeText: originalTimeText || undefined, timezone: reference.timezone, anchor, confidence: "certain" as const };
  const day = (d: Date) => d.toISOString();
  if (originalTimeText === "上週") {
    const start = new Date(anchor); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) - 7);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
    return { ...metadata, timePrecision: "week", occurredFrom: day(start), occurredTo: day(end) };
  }
  if (originalTimeText === "隔天") {
    const next = new Date(previous ?? anchor); next.setUTCDate(next.getUTCDate() + 1);
    return { ...metadata, timePrecision: "day", occurredFrom: day(next) };
  }
  const match = /^(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})$/.exec(originalTimeText);
  if (match) {
    const year = match[1] ?? date.slice(0, 4), month = match[2].padStart(2, "0"), dayText = match[3].padStart(2, "0");
    const iso = `${year}-${month}-${dayText}T00:00:00.000Z`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString() === iso) return { ...metadata, timePrecision: "day", occurredFrom: iso };
  }
  return { ...metadata, confidence: "uncertain", timePrecision: originalTimeText ? "relative" : "unknown" };
}
