import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { BotManagement, type BotItem } from "./BotManagement";
import { ThreadChat } from "./ThreadChat";
import "./style.css";

interface BotThreadsProps {
  botId: string;
  visible: boolean;
}

function BotThreads({ botId, visible }: BotThreadsProps) {
  const [threads, setThreads] = useState(() => [crypto.randomUUID()]);
  const [selected, setSelected] = useState(0);
  const [connectionError, setConnectionError] = useState(false);

  function newThread() {
    setThreads([...threads, crypto.randomUUID()]);
    setSelected(threads.length);
  }

  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={false}
      enableInspector={false} showIntelligenceIndicator={false}
      renderToolCalls={[{
        name: "*",
        render: ({ name, status, result }) => (
          <details className="tool-result" open data-testid="tool-call">
            <summary>{name} · {status}</summary>
            {result && <pre data-testid="tool-result">{String(result)}</pre>}
          </details>
        ),
      }]}
      onError={() => setConnectionError(true)}>
      <main hidden={!visible}>
        <header>
          <div><p className="eyebrow">HERMES AGENT</p><h1>Hermes × CopilotKit</h1></div>
          <p>文字串流 · 原生工具 · 獨立對話</p>
        </header>
        {connectionError && <p role="alert" className="error">Runtime 或 Agent 發生錯誤。請檢查服務狀態。</p>}
        <div className="workspace">
          <nav aria-label="對話列表">
            <button onClick={newThread} disabled={threads.length >= 64}>新增對話</button>
            {threads.map((id, index) => (
              <button key={id} aria-current={selected === index ? "page" : undefined}
                onClick={() => setSelected(index)}>對話 {index + 1}</button>
            ))}
          </nav>
          <div className="chat">
            {threads.map((id, index) => <ThreadChat key={id} botId={botId} threadId={id} visible={selected === index} />)}
          </div>
        </div>
        <footer>工具由 Hermes 執行；內容依後端公開投影顯示。重新整理會開啟新對話。</footer>
      </main>
    </CopilotKit>
  );
}

function App() {
  const [bots, setBots] = useState<BotItem[]>([]);
  const [selected, setSelected] = useState("");
  function updateBots(values: BotItem[]) {
    setBots(values);
    setSelected(current => values.some(bot => bot.id === current && bot.status === "active")
      ? current : values.find(bot => bot.status === "active")?.id ?? "");
  }
  return <>
    <BotManagement bots={bots} onBots={updateBots} onOpen={setSelected} />
    <nav aria-label="Bot 列表">{bots.filter(bot => bot.status === "active").map(bot => <button key={bot.id}
      aria-current={selected === bot.id ? "page" : undefined} onClick={() => setSelected(bot.id)}>{bot.name}</button>)}</nav>
    {bots.filter(bot => bot.status === "active").map(bot => <BotThreads key={bot.id} botId={bot.id} visible={selected === bot.id} />)}
  </>;
}
createRoot(document.getElementById("root")!).render(<App />);
