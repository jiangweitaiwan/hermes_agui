import { BotEditor } from "./BotEditor";
import { useEffect, useState } from "react";
import type { BotRecord, BotTemplate } from "../server/bots/types";

export interface BotItem { id: string; name: string; status: string; record?: BotRecord }
interface BotManagementProps {
  bots: BotItem[];
  onBots: (bots: BotItem[]) => void;
  onOpen: (id: string) => void;
}
export function BotManagement({ bots, onBots, onOpen }: BotManagementProps) {
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [managed, setManaged] = useState(false);
  const [login, setLogin] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<BotRecord>();
  async function refresh() {
    const response = await fetch("/api/bots");
    if (response.status === 401) { setManaged(true); setLogin(true); onBots([]); return; }
    if (!response.ok) throw new Error("無法載入 Bot 清單");
    const values = await response.json() as (string | BotRecord)[];
    onBots(values.map(bot => typeof bot === "string" ? { id: bot, name: bot, status: "active" } :
      { id: bot.id, name: bot.name, status: bot.status, record: bot }));
    const options = await fetch("/api/bots/options");
    if (options.ok && options.headers.get("content-type")?.includes("application/json")) {
      const available = await options.json() as BotTemplate[];
      setManaged(true); setTemplates(available);
    }
  }
  useEffect(() => { void refresh().catch(e => setError(String(e.message))); }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "操作失敗"); }
    finally { setBusy(false); }
  }
  async function request(path: string, method: string, value?: unknown) {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value) });
    if (!response.ok) {
      const result = await response.json() as { error?: string };
      throw new Error(result.error ?? "操作失敗");
    }
    return response;
  }
  return <aside className="bot-management" aria-label="Bot 管理">
    {error && <p role="alert">{error}</p>}
    {login ? <form aria-label="管理登入" onSubmit={event => {
      event.preventDefault(); void action(async () => {
        await request("/api/bot-session", "POST", { token }); setToken(""); setLogin(false);
      });
    }}>
      <label>存取金鑰<input type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required /></label>
      <button disabled={busy}>登入</button>
    </form> : managed && <>
      <h2>Bot 管理</h2>
      <ul>{bots.map(bot => <li key={bot.id}>
        <strong>{bot.name}</strong> · {bot.status}
        <button disabled={busy || bot.status !== "active"} onClick={() => onOpen(bot.id)}>開啟 {bot.name}</button>
        {bot.record && <button disabled={busy} onClick={() => setEditing(bot.record)}>編輯 {bot.name}</button>}
        <button disabled={busy} onClick={() => void action(async () => {
          await request(`/api/bots/${bot.id}/${bot.status === "active" ? "disable" : "enable"}`, "POST");
        })}>{bot.status === "active" ? "停用" : "啟用／重試"} {bot.name}</button>
        <button disabled={busy} onClick={() => void action(async () => {
          await request(`/api/bots/${bot.id}`, "DELETE"); if (editing?.id === bot.id) setEditing(undefined);
        })}>刪除 {bot.name}</button>
      </li>)}</ul>
      <BotEditor editing={editing} templates={templates} bots={bots} busy={busy}
        onCancel={() => setEditing(undefined)} onSave={input => action(async () => {
          const response = await request(editing ? `/api/bots/${editing.id}` : "/api/bots", editing ? "PATCH" : "POST", input);
          const created = await response.json() as BotRecord;
          setEditing(undefined); if (created.status === "active") onOpen(created.id);
        })} />
    </>}
  </aside>;
}
