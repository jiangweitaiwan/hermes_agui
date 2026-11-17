import { useEffect, useState } from "react";
import { graph, type PageSummary, type SearchResult, type Scope } from "../api/graph";
interface Props {
  bot: string; scope: Scope; query: string; type: string; verification: string;
  onSelect: (page: PageSummary) => void; onFailure: (message: string) => void;
}
export function WikiPageList({ bot, scope, query, type, verification, onSelect, onFailure }: Props) {
  const [cursor, setCursor] = useState<string>();
  const [result, setResult] = useState<SearchResult>();
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const params = new URLSearchParams({ scope, limit: '100' });
    if (query) params.set('q', query);
    if (type) params.set('type', type);
    if (verification) params.set('verification', verification);
    if (cursor) params.set('cursor', cursor);
    void graph<SearchResult>(bot, query ? 'search' : 'pages', params, controller.signal).then(value => {
      if (active) setResult(value);
    }).catch(e => { if (active) onFailure(e.message); });
    return () => { active = false; controller.abort(); };
  }, [bot, scope, query, type, verification, cursor]);
  return <section><h3>Wiki pages · 鍵盤／行動版清單</h3>
    {!result && <p role="status">Loading Wiki list…</p>}
    {result && !result.pages.length && <p role="status">沒有符合條件的記憶。</p>}
    {result?.partial && <p>Partial：目前列表是 bounded window。</p>}
    <ul aria-label="Wiki pages">{result?.pages.map(p => <li key={p.id}>
      <button onClick={() => onSelect(p)}>{p.title} · {p.visibility} · {p.type} · {p.verification}</button>
      {p.snippet && <p>{p.snippet}</p>}
    </li>)}</ul>
    {result?.nextCursor && <button onClick={() => { setResult(undefined); setCursor(result.nextCursor!); }}>Wiki next page（取代此頁）</button>}
  </section>;
}
