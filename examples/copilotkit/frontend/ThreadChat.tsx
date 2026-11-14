import { useEffect, useRef, useState } from "react";
import { CopilotChatView, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";

import { ThreadHumanInput } from "./HumanInput";

interface ThreadChatProps {
  threadId: string;
  visible: boolean;
}

export function ThreadChat({ threadId, visible }: ThreadChatProps) {
  const { agent, isReady } = useAgent({ agentId: `chat-${threadId}`, runtimeAgentId: "hermes", threadId });
  const { copilotkit } = useCopilotKit();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [waiting, setWaiting] = useState(false);


  useEffect(() => {
    if (!isReady) return;
    const { unsubscribe } = agent.subscribe({
      onRunErrorEvent: () => setError("Agent 執行失敗。請確認結果後，再以新訊息繼續。"),
      onRunFailed: () => setError("連線或執行失敗。請確認結果後，再以新訊息繼續。"),
    });
    return unsubscribe;
  }, [agent, isReady]);

  async function send(text: string) {
    if (!isReady || agent.isRunning || waiting || submitting.current || !text.trim()) return;
    submitting.current = true;
    setError(null);
    setDraft("");
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text });
    try {
      await copilotkit.runAgent({ agent });
    } catch {
      setError("連線或執行失敗。請確認結果後，再以新訊息繼續。");
    } finally {
      submitting.current = false;
    }
  }

  return (
    <section hidden={!visible} aria-label="對話" data-thread-id={threadId}>
      <div className="connection" role="status">{!isReady ? "連線中…" : agent.isRunning ? "執行中…" : "已連線"}</div>
      {error && <p className="error" role="alert">{error}</p>}
      {isReady && <ThreadHumanInput agentId={`chat-${threadId}`} onWaiting={setWaiting} />}
      <CopilotChatView
        messages={agent.messages}
        isRunning={agent.isRunning}
        isConnecting={!isReady}
        onSubmitMessage={isReady && !waiting ? text => { void send(text); } : undefined}
        onStop={() => { void copilotkit.stopAgent({ agent }); }}
        inputValue={draft}
        onInputChange={setDraft}
        messageView={{ messageFeedback: false, toolCallDisplay: "separate" }}
      />
    </section>
  );
}
