import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PageDetail, PageSummary } from "../api/graph";
interface PageProps { page: PageDetail }
interface ViewerProps extends PageProps { onSelect: (page: PageSummary) => void }
export function ProvenancePanel({ page }: PageProps) {
  return <section aria-label="Provenance"><h3>Provenance</h3><ul>{page.provenance.map((source, index) => <li key={index}>
    {"kind" in source ? <>Document: {source.title} · version {source.version} · sourceId {source.sourceId}</>
      : <>Session · Bot {source.botId} · thread {source.threadId} · run {source.runId}</>}
  </li>)}</ul></section>;
}
export function WikiPageViewer({ page, onSelect }: ViewerProps) {
  const body = page.body.replace(/\[\[([\p{L}\p{N}_-]+)\]\]/gu, (_, id: string) => `[${id}](wiki:${id})`);
  return <article aria-label="Wiki Viewer"><h2>{page.title}</h2>
    <p>{page.visibility} · {page.type} · verification: <strong>{page.verification}</strong></p>
    <p>Revision: {page.revisionId} · Tags: {page.tags.join(", ") || "—"}</p>
    <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => /^(https?:|wiki:)/i.test(url) ? url : ""}
      components={{ img: ({ alt }) => <span>[圖片未載入：{alt}]</span>, a: ({ href, children }) => {
        if (href?.startsWith("wiki:")) {
          const related = page.related.find(p => p.pageId === href.slice(5) && p.visibility === page.visibility);
          return related ? <button onClick={() => onSelect(related)}>{children}</button> : <span>{children} (broken / unavailable)</span>;
        }
        return href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children} ↗</a> : <span>{children}</span>;
      } }}>{body}</Markdown>
    <h3>Related pages</h3><ul>{page.related.map(p => <li key={p.id}><button onClick={() => onSelect(p)}>{p.title} · {p.visibility}</button></li>)}</ul>
    <ProvenancePanel page={page} />
  </article>;
}
