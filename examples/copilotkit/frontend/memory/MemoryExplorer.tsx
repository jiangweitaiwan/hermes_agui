import { FactTimeline } from "./FactTimeline";
import { useEffect, useRef, useState } from "react";
import { graph, type Scope, type NetworkResult, type PageDetail, type PageSummary } from "../api/graph";
import type { BotItem } from "../BotManagement";
import { WikiPageList } from "./WikiPageList";
import { GraphView } from "./GraphView";
import { WikiPageViewer } from "./WikiPageViewer";
import { MemoryDashboard } from "./MemoryDashboard";
interface ExplorerProps { bots: BotItem[]; selected: string }
export function MemoryExplorer({ bots, selected }: ExplorerProps) {
  const [bot, setBot] = useState(selected || bots[0]?.id || "");
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [verification, setVerification] = useState("");
  const key = JSON.stringify([bot, scope, query, type, verification]);
  return <section className="memory-explorer"><h2>Graph Memory Explorer</h2>
    <label>Memory Bot<select value={bot} onChange={e => setBot(e.target.value)}>{bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
    <div role="group" aria-label="Memory scope">{([['all', 'All'], ['bot_private', 'Bot Private'], ['project_shared', 'Shared']] as const).map(([value, label]) =>
      <button key={value} aria-pressed={scope === value} onClick={() => setScope(value)}>{label}</button>)}</div>
    <label>Memory Search<input type="search" maxLength={512} value={query} onChange={e => setQuery(e.target.value)} /></label>
    <label>Page type<select value={type} onChange={e => setType(e.target.value)}><option value="">All types</option>{['concept', 'entity', 'note', 'index', 'decision', 'finding', 'procedure', 'preference', 'task', 'source'].map(t => <option key={t}>{t}</option>)}</select></label>
    <label>Verification<select value={verification} onChange={e => setVerification(e.target.value)}><option value="">All verification</option>{['unverified', 'verified', 'disputed'].map(v => <option key={v}>{v}</option>)}</select></label>
    {bot && bots.some(b => b.id === bot) ? <MemorySession key={key} bot={bot} scope={scope} query={query.trim()} type={type} verification={verification} /> : <p>請登入並選擇 Bot。</p>}
  </section>;
}
interface SessionProps { bot: string; scope: Scope; query: string; type: string; verification: string }
function MemorySession({ bot, scope, query, type, verification }: SessionProps) {
  const [view,setView] = useState("current");
  const [network, setNetwork] = useState<NetworkResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [focus, setFocus] = useState<PageSummary>();
  const [page, setPage] = useState<PageSummary>();
  const [fatal, setFatal] = useState(false);
  const invalidated = useRef(false);
  function invalidate(message: string) { invalidated.current = true; setNetwork(undefined); setPage(undefined); setError(message); setFatal(true); }
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    function fail(message: string) {
      if (!active) return;
      active = false; controller.abort(); setBusy(false); invalidate(message);
    }
    setBusy(true); setError("");
    const params = new URLSearchParams({ scope, limit: "100", view });
    if (query) params.set("q", query);
    if (type) params.set("type", type);
    if (verification) params.set("verification", verification);
    if (cursor) params.set("cursor", cursor);
    if (focus) { params.set("pageId", focus.pageId); params.set("visibility", focus.visibility); params.set("depth", "1"); }
    void graph<NetworkResult>(bot, "network", params, controller.signal).then(value => {
      if (!active || invalidated.current) return;
      // Responses are live views. Replace each window; never retain a revoked node from an older window.
      setNetwork(value); setFatal(false);
    }).catch(e => fail(e.message)).finally(() => { if (active) setBusy(false); });
    return () => { active = false; controller.abort(); };
  }, [bot, scope, query, type, verification, cursor, focus, refresh, view]);
  function reload() { invalidated.current = false; setNetwork(undefined); setPage(undefined); setCursor(undefined); setFocus(undefined); setFatal(false); setRefresh(v => v + 1); }
  return <>
    <button onClick={reload}>Refresh memory</button>
    {busy && <p role="status">Loading memory…</p>}{error && <p role="alert">{error}</p>}
    {network && <><GraphView network={network} onSelect={setPage} />
      {network.truncated && <p role="status">Truncated：僅顯示此 bounded window，統計可能不完整。</p>}
      {network.nextCursor && <button disabled={busy} onClick={() => { setPage(undefined); setNetwork(undefined); setCursor(network.nextCursor!); }}>Load more · 下一頁（取代此頁）</button>}
    </>}
    {!fatal && <FactTimeline key={`facts/${refresh}`} bot={bot} scope={scope} query={query} view={view} onViewChange={value=>{setNetwork(undefined);setView(value);}} onFailure={invalidate} />}
    {!fatal && <WikiPageList key={`wiki/${refresh}`} bot={bot} scope={scope} query={query} type={type} verification={verification} onSelect={setPage} onFailure={invalidate} />}
    {page && !fatal && <><button onClick={() => { setNetwork(undefined); setCursor(undefined); setFocus(page); }}>Load neighbors</button>
      <Detail key={`${page.id}/${refresh}`} bot={bot} scope={scope} page={page} onSelect={setPage} onFailure={invalidate} /></>}
    {!fatal && <MemoryDashboard key={`dashboard/${refresh}`} bot={bot} scope={scope} onUnauthorized={invalidate} />}
  </>;
}
interface DetailProps { bot: string; scope: Scope; page: PageSummary; onSelect: (p: PageSummary) => void; onFailure: (message: string) => void }
function Detail({ bot, scope, page, onSelect, onFailure }: DetailProps) {
  const [detail, setDetail] = useState<PageDetail>();
  useEffect(() => {
    let active = true; const controller = new AbortController();
    void graph<PageDetail>(bot, `pages/${page.visibility}/${encodeURIComponent(page.pageId)}`, new URLSearchParams({ scope }), controller.signal)
      .then(value => { if (active) setDetail(value); }).catch(e => { if (active) onFailure(e.message); });
    return () => { active = false; controller.abort(); };
  }, [bot, scope, page.id]);
  return detail ? <><WikiPageViewer page={detail} onSelect={onSelect} /><FactTimeline bot={bot} scope={page.visibility} query="" pageId={page.pageId} onFailure={onFailure} /></> : <p role="status">Loading Wiki…</p>;
}
