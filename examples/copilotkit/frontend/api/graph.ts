export type { FactsResult, PageSummary, PageDetail, NetworkResult, PageList, SearchResult, StatsResult, HealthResult, JobsResult } from "../../server/graph/browser-types";
export type Scope = "all" | "bot_private" | "project_shared";
export async function graph<T>(bot: string, endpoint: string, query: URLSearchParams, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/graph/${encodeURIComponent(bot)}/${endpoint}?${query}`, { signal, cache: "no-store" });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(response.status === 401 || response.status === 403 || response.status === 404
      ? "Unauthorized：請重新登入或重新選擇 Bot。" : `${value.status ?? "unavailable"}：無法載入記憶 (${response.status})`);
  }
  return response.json() as Promise<T>;
}
