import { useEffect, useRef, useState } from "react";
import type { NetworkResult, PageSummary } from "../api/graph";
interface Point { x: number; y: number }
interface GraphViewProps { network: NetworkResult; onSelect: (page: PageSummary) => void }
export function GraphView({ network, onSelect }: GraphViewProps) {
  const [points, setPoints] = useState<Record<string, Point>>({});
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [degreeSize, setDegreeSize] = useState(true);
  const animation = useRef(0);
  const drag = useRef<{ id?: string; x: number; y: number; moved: boolean } | undefined>(undefined);
  useEffect(() => {
    const positions = Object.fromEntries(network.nodes.map((n, i) => [n.id, { x: 400 + 200 * Math.cos(i * 2.4), y: 240 + 180 * Math.sin(i * 2.4) }]));
    const links=[...network.edges,...(network.factEdges ?? []).map(e=>({source:`${e.visibility}:${e.fromSubject.wikiPageId}`,target:`${e.visibility}:${e.toSubject.wikiPageId}`}))];
    let frame = 0, ticks = 0;
    function step() {
      const nodes = network.nodes;
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = positions[nodes[i].id], b = positions[nodes[j].id];
        const dx = a.x - b.x, dy = a.y - b.y, distance = Math.max(40, dx * dx + dy * dy);
        a.x += dx * 80 / distance; a.y += dy * 80 / distance;
        b.x -= dx * 80 / distance; b.y -= dy * 80 / distance;
      }
      for (const edge of links) {
        const a = positions[edge.source], b = positions[edge.target];
        if (!a || !b) continue;
        const dx = (b.x - a.x) * .012, dy = (b.y - a.y) * .012;
        a.x += dx; a.y += dy; b.x -= dx; b.y -= dy;
      }
      for (const p of Object.values(positions)) { p.x += (400 - p.x) * .003; p.y += (240 - p.y) * .003; }
      setPoints(Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, { ...p }])));
      if (++ticks < 160) animation.current = frame = requestAnimationFrame(step);
    }
    setCamera({ x: 0, y: 0, zoom: 1 }); animation.current = frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [network]);
  function zoom(factor: number) { setCamera(c => ({ ...c, zoom: Math.min(4, Math.max(.25, c.zoom * factor)) })); }
  function fit() {
    const values = Object.values(points);
    if (!values.length) return;
    const xs = values.map(p => p.x), ys = values.map(p => p.y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    const zoom = Math.min(2, 700 / Math.max(1, right - left), 380 / Math.max(1, bottom - top));
    setCamera({ zoom, x: (400 - (left + right) / 2) * zoom, y: (240 - (top + bottom) / 2) * zoom });
  }
  return <section aria-label="Knowledge graph"><h3>Knowledge graph</h3>
    <p>● 藍色 Bot Private · ● 橘色 Shared · {network.nodes.length} Wiki nodes / {network.edges.length} links / {network.factEdges?.length ?? 0} facts</p>
    <button onClick={() => zoom(1.25)} aria-label="Zoom in">＋</button><button onClick={() => zoom(.8)} aria-label="Zoom out">－</button>
    <button onClick={fit}>Fit graph</button>
    <label><input type="checkbox" checked={degreeSize} onChange={e => setDegreeSize(e.target.checked)} />Degree size</label>
    <svg className="memory-graph" viewBox="0 0 800 480" role="img" aria-label="可拖曳圖譜；鍵盤請使用下方 Wiki 清單"
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
      onPointerMove={e => {
        const d = drag.current; if (!d) return;
        const dx = (e.clientX - d.x) * 800 / e.currentTarget.getBoundingClientRect().width;
        const dy = (e.clientY - d.y) * 480 / e.currentTarget.getBoundingClientRect().height;
        d.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
        if (d.id) setPoints(p => ({ ...p, [d.id!]: { x: p[d.id!].x + dx / camera.zoom, y: p[d.id!].y + dy / camera.zoom } }));
        else setCamera(c => ({ ...c, x: c.x + dx, y: c.y + dy }));
        d.x = e.clientX; d.y = e.clientY;
      }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      <g transform={`translate(${camera.x} ${camera.y}) translate(400 240) scale(${camera.zoom}) translate(-400 -240)`}>
        {network.edges.map(e => <line key={`${e.source}/${e.target}`} x1={points[e.source]?.x} y1={points[e.source]?.y} x2={points[e.target]?.x} y2={points[e.target]?.y} stroke="#708399" />)}
        {network.factEdges?.map(e => <line key={`fact/${e.visibility}/${e.edgeId}`}
          x1={points[`${e.visibility}:${e.fromSubject.wikiPageId}`]?.x} y1={points[`${e.visibility}:${e.fromSubject.wikiPageId}`]?.y}
          x2={points[`${e.visibility}:${e.toSubject.wikiPageId}`]?.x} y2={points[`${e.visibility}:${e.toSubject.wikiPageId}`]?.y}
          stroke="#a56cdd" strokeWidth="2"><title>{e.relation}: {e.description} · {e.time.occurredFrom ?? "時間未知"} · {e.view}</title></line>)}
        {network.nodes.map(n => <g key={n.id} transform={`translate(${points[n.id]?.x ?? 400} ${points[n.id]?.y ?? 240})`}
          onPointerDown={e => { cancelAnimationFrame(animation.current); e.stopPropagation(); e.currentTarget.ownerSVGElement!.setPointerCapture(e.pointerId); drag.current = { id: n.id, x: e.clientX, y: e.clientY, moved: false }; }}
          onClick={() => onSelect(n)}><circle r={degreeSize ? 7 + Math.min(12, network.edges.filter(e => e.source === n.id || e.target === n.id).length) : 9}
            fill={n.visibility === "bot_private" ? "#408edd" : "#e6a13d"} /><text y="-14" textAnchor="middle" fill="currentColor" fontSize="12">{n.title}</text></g>)}
      </g>
    </svg>
  </section>;
}
