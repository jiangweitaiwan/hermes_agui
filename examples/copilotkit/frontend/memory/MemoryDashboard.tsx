import { useEffect, useState } from "react";
import { graph, type Scope, type StatsResult, type HealthResult, type JobsResult } from "../api/graph";
interface DashboardProps { bot: string; scope: Scope; onUnauthorized: (message: string) => void }
export function MemoryDashboard({ bot, scope, onUnauthorized }: DashboardProps) {
  const [stats, setStats] = useState<StatsResult>();
  const [health, setHealth] = useState<HealthResult>();
  const [jobs, setJobs] = useState<JobsResult>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>, failures = 0;
    let controller: AbortController | undefined;
    async function poll() {
      if (!active || document.hidden) return;
      controller?.abort(); controller = new AbortController();
      const requestController = controller;
      const params = new URLSearchParams({ scope });
      const results = await Promise.allSettled([
        graph<StatsResult>(bot, "stats", params, controller.signal),
        graph<HealthResult>(bot, "health", params, controller.signal),
        graph<JobsResult>(bot, "jobs", params, controller.signal),
      ]);
      if (!active || requestController.signal.aborted) return;
      setStats(undefined); setHealth(undefined); setJobs(undefined); setError("");
      const denied = results.find(r => r.status === "rejected" && String(r.reason).includes("Unauthorized"));
      if (denied?.status === "rejected") { onUnauthorized(denied.reason.message); return; }
      if (results[0].status === "fulfilled") setStats(results[0].value);
      if (results[1].status === "fulfilled") setHealth(results[1].value);
      if (results[2].status === "fulfilled") setJobs(results[2].value);
      const failed = results.filter(r => r.status === "rejected");
      setError(failed.map(r => r.status === "rejected" ? String(r.reason.message) : "").join("; "));
      failures = failed.length ? Math.min(failures + 1, 3) : 0;
      timer = setTimeout(() => void poll(), 15000 * 2 ** failures);
    }
    function visibility() { clearTimeout(timer); controller?.abort(); if (!document.hidden) void poll(); }
    document.addEventListener("visibilitychange", visibility); void poll();
    return () => { active = false; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); };
  }, [bot, scope, version]);
  return <section aria-label="Memory Evolution Dashboard"><h3>Memory Evolution Dashboard</h3>
    <button onClick={() => { setStats(undefined); setHealth(undefined); setJobs(undefined); setVersion(v => v + 1); }}>Refresh dashboard</button>
    {error && <p role="status">{error} · Evolution not available 時不顯示假數值。</p>}
    {stats && <p>Pages {stats.pages} · Edges {stats.edges} · Private {stats.private} · Shared {stats.shared} {stats.partial && "(partial / lower bounds)"}</p>}
    {health && <dl>{Object.entries(health).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v === null ? "unknown (partial)" : String(v)}</dd></div>)}</dl>}
    {jobs && <><p>{['pending', 'running', 'completed', 'failed', 'cancelled'].map(s => `${s}: ${jobs.jobs.filter(j => j.state === s).length}`).join(" · ")}（recent window）</p>
      <ul>{jobs.jobs.map(j => <li key={j.id}>{j.id}: {j.state}{j.createdAt && ` · ${new Date(j.createdAt).toLocaleString()}`}</li>)}</ul></>}
  </section>;
}
