import { createPortal } from "react-dom";
import { useState } from "react";
import { CopilotKit } from "@copilotkit/react-core/v2";
import { ThreadChat } from "./ThreadChat";

interface BotThreadsProps {
  botId: string;
  visible: boolean;
}

export function BotThreads({ botId, visible }: BotThreadsProps) {
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
      <div hidden={!visible}>
        <header>
          <div><p className="eyebrow">HERMES AGENT</p><h1>Hermes × CopilotKit</h1></div>
          <p>文字串流 · 原生工具 · 獨立對話</p>
        </header>
        {connectionError && <p role="alert" className="error">Runtime 或 Agent 發生錯誤。請檢查服務狀態。</p>}
        <div className="workspace">
          {createPortal(<nav hidden={!visible} aria-label="對話列表">
            <button onClick={newThread} disabled={threads.length >= 64}>新增對話</button>
            {threads.map((id, index) => (
              <button key={id} aria-current={selected === index ? "page" : undefined}
                onClick={() => setSelected(index)}>對話 {index + 1}</button>
            ))}
          </nav>, document.getElementById("thread-navigation")!)}
          <div className="chat">
            {threads.map((id, index) => <ThreadChat key={id} botId={botId} threadId={id} visible={selected === index} />)}
          </div>
        </div>
        <footer>工具由 Hermes 執行；內容依後端公開投影顯示。重新整理會開啟新對話。</footer>
      </div>
    </CopilotKit>
  );
}

