import { Dialog } from "./workspace/Dialog";
import { BotEditor } from "./BotEditor";
import { useEffect, useRef, useState } from "react";
import type { BotRecord, BotTemplate } from "../server/bots/types";

export interface BotItem { id: string; name: string; status: string; record?: BotRecord }
interface BotManagementProps {
  bots: BotItem[];
  onBots: (bots: BotItem[]) => void;
  onOpen: (id: string) => void;
}
export function BotManagement({ bots, onBots, onOpen }: BotManagementProps) {
  const locked = useRef(false);
  const [showEditor, setShowEditor] = useState(false);
  const [deleting, setDeleting] = useState<BotItem>();
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [managed, setManaged] = useState(false);
  const [login, setLogin] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<BotRecord>();
  async function refresh() {
    const response = await fetch("/api/bots");
    if (response.status === 401) { setManaged(true); setLogin(true); setEditing(undefined); setShowEditor(false); setDeleting(undefined); setTemplates([]); onBots([]); return; }
    if (!response.ok) throw new Error("無法載入 Bot 清單");
    const values = await response.json() as (string | BotRecord)[];
    onBots(values.map(bot => typeof bot === "string" ? { id: bot, name: bot, status: "active" } :
      { id: bot.id, name: bot.name, status: bot.status, record: bot }));
    const options = await fetch("/api/bots/options");
    if (options.ok && options.headers.get("content-type")?.includes("application/json")) {
      const available = await options.json() as BotTemplate[];
      setManaged(true); setTemplates(current => JSON.stringify(current) === JSON.stringify(available) ? current : available);
    }
  }
  useEffect(() => { void refresh().catch(e => setError(String(e.message))); }, []);
  async function action(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await work(); await refresh(); } catch (e) { await refresh().catch(() => undefined); setError(e instanceof Error ? e.message : "操作失敗"); }
    finally { locked.current = false; setBusy(false); }
  }
  async function request(path: string, method: string, value?: unknown) {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value) });
    if (response.status === 401 && path !== "/api/bot-session") {
      onBots([]); setLogin(true); setShowEditor(false); setEditing(undefined); setDeleting(undefined);
    }
    if (!response.ok) {
      const result = await response.json() as { error?: string };
      throw new Error(result.error ?? "操作失敗");
    }
    return response;
  }
  return <aside className="bot-management" aria-label="Bot 管理">
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => void action(async () => {})}>重試載入</button></p>}
    {login ? <form aria-label="管理登入" onSubmit={event => {
      event.preventDefault(); void action(async () => {
        await request("/api/bot-session", "POST", { token }); setToken(""); setLogin(false);
      });
    }}>
      <label>存取金鑰<input type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required /></label>
      <button disabled={busy}>登入</button>
    </form> : managed && <>
      <h2>Bot 管理</h2>
      <p role="status">{busy ? "處理中…" : `${bots.length} 個 Bot · ${bots.filter(bot => bot.status === "active").length} 個可對話`}</p>
      <button disabled={busy} onClick={() => { setEditing(undefined); setShowEditor(true); }}>新增 Bot</button>
      <button disabled={busy} onClick={() => void action(async () => {
        await request("/api/bot-session", "DELETE"); onBots([]); setTemplates([]);
        setEditing(undefined); setShowEditor(false); setDeleting(undefined); setToken(""); setLogin(true);
      })}>登出</button>
      {!bots.length && <p role="status">尚無 Bot，請新增第一個 Bot。</p>}
      <ul>{bots.map(bot => <li key={bot.id}>
        <strong>{bot.name}</strong> · <span>{bot.status}</span>
        {bot.record && <p>{bot.record.description}<br />{bot.record.harness} · {bot.record.provider}/{bot.record.model}</p>}
        <button disabled={busy || bot.status !== "active"} onClick={() => onOpen(bot.id)}>開啟 {bot.name}</button>
        {bot.record && <button disabled={busy} onClick={() => void action(async () => {
          const response = await request(`/api/bots/${bot.id}`, "GET");
          setEditing(await response.json() as BotRecord); setShowEditor(true);
        })}>編輯 {bot.name}</button>}
        <button disabled={busy || bot.status === "provisioning"} onClick={() => void action(async () => {
          await request(`/api/bots/${bot.id}/${bot.status === "active" ? "disable" : "enable"}`, "POST");
        })}>{bot.status === "active" ? "停用" : "啟用／重試"} {bot.name}</button>
        <button disabled={busy} onClick={() => setDeleting(bot)}>刪除 {bot.name}</button>
      </li>)}</ul>
      {showEditor && <Dialog title={editing ? "編輯 Bot" : "建立 Bot"} onClose={() => { if (!busy) setShowEditor(false); }}>
      {error && <p role="alert">{error}</p>}
      <BotEditor editing={editing} templates={templates} bots={bots} busy={busy}
        onCancel={() => { setEditing(undefined); setShowEditor(false); }} onSave={input => action(async () => {
          const response = await request(editing ? `/api/bots/${editing.id}` : "/api/bots", editing ? "PATCH" : "POST", input);
          const created = await response.json() as BotRecord;
          setEditing(undefined); setShowEditor(false); if (!editing && created.status === "active") onOpen(created.id);
        })} /></Dialog>}
      {deleting && <Dialog title="確認刪除 Bot" onClose={() => { if (!busy) setDeleting(undefined); }}>
        <h3>刪除 {deleting.name}？</h3>
        {error && <p role="alert">{error}</p>}
        <p>停用會保留有效知識；刪除會永久撤銷此 Bot 的衍生永久記憶及分享副本。歷史稽核資料不會實體抹除。</p>
        <button disabled={busy} onClick={() => void action(async () => {
          await request(`/api/bots/${deleting.id}`, "DELETE"); setDeleting(undefined);
        })}>確認刪除</button>
      </Dialog>}
    </>}
    {!managed && !login && <p>Static mode：管理寫入未啟用。請由管理員配置 server management；既有 Bot 可直接對話。</p>}
  </aside>;
}
