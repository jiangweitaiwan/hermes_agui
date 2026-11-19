import { cloudEnabled } from "./cloud-auth";
import type { Message } from "@ag-ui/core";
import { useEffect, useRef, useState } from "react";
import { CopilotChatView, useAgent, useCopilotKit } from "@copilotkit/react-core/v2";

import { ThreadHumanInput } from "./HumanInput";

interface ThreadChatProps {
  botId: string;
  threadId: string;
  visible: boolean;
}

export function ThreadChat({ botId, threadId, visible }: ThreadChatProps) {
  const { agent, isReady } = useAgent({ agentId: `chat-${botId}-${threadId}`, runtimeAgentId: botId, threadId });
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

  async function reload() {
    const response = await fetch(`/api/threads/${botId}/${encodeURIComponent(threadId)}/history`);
    if (response.status === 404) return;
    if (!response.ok) throw new Error("無法載入歷史");
    const value = await response.json() as { runs: { input: Message | null; status: string; events: { seq: number; event: Record<string, any> }[] }[] };
    const messages: Message[] = [];
    for (const run of value.runs) {
      if (run.input) messages.push(run.input);
      const texts = new Map<string, string>();
      const seen = new Set<number>();
      for (const { seq, event } of run.events) {
        if (seen.has(seq)) continue; seen.add(seq);
        if (event.type === "TEXT_MESSAGE_START") texts.set(event.messageId, "");
        if (event.type === "TEXT_MESSAGE_CONTENT") texts.set(event.messageId, (texts.get(event.messageId) ?? "") + event.delta);
      }
      for (const [id, content] of texts) messages.push({ id, role: "assistant", content });
      if (run.status === "interrupted") setError("此回合已中斷；請確認副作用後再送出新訊息。");
    }
    agent.setMessages(messages);
  }
  useEffect(() => {
    if (cloudEnabled && isReady) void reload().catch(() => setError("無法載入歷史，請重新連線"));
  }, [isReady, botId, threadId]);

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
    <section hidden={!visible} aria-label="對話" data-thread-id={threadId} data-bot-id={botId}>
      <div className="connection" role="status">{!isReady ? "連線中…" : agent.isRunning ? "執行中…" : "已連線"}</div>
      {error && <p className="error" role="alert">{error} {cloudEnabled && <button disabled={agent.isRunning} onClick={() => void reload().catch(() => setError("重新連線失敗"))}>重新連線</button>}</p>}
      {isReady && <ThreadHumanInput agentId={`chat-${botId}-${threadId}`} onWaiting={setWaiting} />}
      <CopilotChatView
        messages={agent.messages}
        isRunning={agent.isRunning}
        isConnecting={!isReady}
        onSubmitMessage={isReady && !waiting ? text => { void send(text); } : undefined}
        onStop={() => {
          if (cloudEnabled) void fetch(`/api/threads/${botId}/${encodeURIComponent(threadId)}/cancel`, { method: "POST" }).catch(() => setError("取消失敗"));
          void copilotkit.stopAgent({ agent });
        }}
        inputValue={draft}
        onInputChange={setDraft}
        messageView={{ messageFeedback: false, toolCallDisplay: "separate" }}
      />
    </section>
  );
}
