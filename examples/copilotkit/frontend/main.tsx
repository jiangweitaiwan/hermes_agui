import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
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
  const [bots, setBots] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    void fetch("/api/bots").then(r => {
      if (!r.ok) throw new Error("Registry unavailable");
      return r.json() as Promise<string[]>;
    }).then(ids => { setBots(ids); setSelected(ids[0]); }).catch(() => setError(true));
  }, []);
  return <>
    <nav aria-label="Bot 列表">{bots.map(id => <button key={id}
      aria-current={selected === id ? "page" : undefined} onClick={() => setSelected(id)}>{id}</button>)}</nav>
    {error && <p role="alert">無法載入 Bot 清單</p>}
    {bots.map(id => <BotThreads key={id} botId={id} visible={selected === id} />)}
  </>;
}
createRoot(document.getElementById("root")!).render(<App />);
