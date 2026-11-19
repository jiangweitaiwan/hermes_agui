import { MemoryExplorer } from "../memory/MemoryExplorer";
import { useState } from "react";
import { BotManagement, type BotItem } from "../BotManagement";
import { BotThreads } from "../BotThreads";

type Page = "Chat" | "Bot Manager" | "Graph Memory";
export function AppShell() {
  const [bots, setBots] = useState<BotItem[]>([]);
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState<Page>("Chat");
  const [expanded, setExpanded] = useState(false);
  function updateBots(values: BotItem[]) {
    setBots(values);
    if (values.length && !values.some(bot => bot.status === "active")) setPage("Bot Manager");
    setSelected(current => values.some(bot => bot.id === current && bot.status === "active")
      ? current : values.find(bot => bot.status === "active")?.id ?? "");
  }
  function open(id: string) { setSelected(id); setPage("Chat"); setExpanded(false); }
  return <div className="app-shell">
    <button className="menu-toggle" aria-expanded={expanded} aria-controls="workspace-sidebar"
      onClick={() => setExpanded(!expanded)}>工作空間導覽</button>
    <aside id="workspace-sidebar" className={`sidebar ${expanded ? "expanded" : ""}`}>
      <h1>Hermes Workspace</h1>
      <nav aria-label="工作空間">{(["Chat", "Bot Manager", "Graph Memory"] as Page[]).map(value =>
        <button key={value} aria-current={page === value ? "page" : undefined}
          onClick={() => { setPage(value); setExpanded(false); }}>{value}</button>)}</nav>
      <nav aria-label="Bot 列表">{bots.filter(bot => bot.status === "active").map(bot =>
        <button key={bot.id} aria-current={selected === bot.id ? "page" : undefined}
          onClick={() => open(bot.id)}>{bot.name}</button>)}</nav>
      <div id="thread-navigation" />
      <p>雲端模式可重新載入已提交的對話。</p>
    </aside>
    <main className="workspace-content">
      <div hidden={page !== "Bot Manager" && bots.length > 0}>
        <BotManagement bots={bots} onBots={updateBots} onOpen={open} />
      </div>
      {page === "Graph Memory" && <MemoryExplorer key={bots.map(b => b.id).join("/")} bots={bots} selected={selected} />}
      {page === "Chat" && !selected && <p role="status">請登入或在 Bot Manager 建立並啟用 Bot 後開始對話。</p>}
      {bots.filter(bot => bot.status === "active").map(bot =>
        <BotThreads key={bot.id} botId={bot.id} visible={page === "Chat" && selected === bot.id} />)}
    </main>
  </div>;
}
