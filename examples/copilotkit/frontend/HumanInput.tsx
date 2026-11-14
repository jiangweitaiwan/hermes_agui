import { useEffect, useState } from "react";
import type { Interrupt } from "@ag-ui/core";
import { useInterrupt } from "@copilotkit/react-core/v2";

interface Question {
  qid: string;
  question: string;
  choices?: string[] | null;
  multi_select?: boolean;
}

interface HumanInputProps {
  interrupt: Interrupt;
  resolve: (payload: unknown) => Promise<unknown>;
  cancel: () => Promise<unknown>;
}

export function HumanInput({ interrupt, resolve, cancel }: HumanInputProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const questions = (interrupt.metadata?.questions ?? []) as Question[];

  async function submit(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      setError("回覆失敗或等待已逾時，請確認執行狀態。");
    } finally {
      setBusy(false);
    }
  }

  return <form aria-label="等待使用者回覆" onSubmit={event => {
    event.preventDefault();
    void submit(() => resolve({ answers }));
  }}>
    <p>{interrupt.message}</p>
    {interrupt.reason === "tool_approval" ? <>
      <pre>{String(interrupt.metadata?.command ?? "")}</pre>
      <button type="button" disabled={busy} onClick={() => void submit(() => resolve({ approved: true }))}>允許一次</button>
      <button type="button" disabled={busy} onClick={() => void submit(() => resolve({ approved: false }))}>拒絕</button>
    </> : <>
      {questions.map(question => <label key={question.qid}>
        {question.question}
        {question.choices && <span>{question.choices.join(" / ")}</span>}
        <input aria-label={question.question} value={answers[question.qid] ?? ""}
          onChange={event => setAnswers(current => ({ ...current, [question.qid]: event.target.value }))} />
      </label>)}
      <button disabled={busy}>送出回覆</button>
    </>}
    <button type="button" disabled={busy} onClick={() => void submit(cancel)}>取消此互動</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}


interface ThreadHumanInputProps {
  agentId: string;
  onWaiting: (waiting: boolean) => void;
}

export function ThreadHumanInput({ agentId, onWaiting }: ThreadHumanInputProps) {
  const ui = useInterrupt({
    agentId,
    renderInChat: false,
    render: ({ interrupt, resolve, cancel }) => interrupt
      ? <HumanInput key={interrupt.id} interrupt={interrupt} resolve={resolve} cancel={cancel} />
      : <p>等待互動資料…</p>,
  });
  const waiting = ui !== null;
  useEffect(() => onWaiting(waiting), [waiting, onWaiting]);
  return ui;
}
