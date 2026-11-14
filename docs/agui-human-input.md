# AG-UI Human-in-the-loop

Phase 7 使用官方 Python SDK 的 `Interrupt`／`ResumeEntry` 與 CopilotKit 1.83.0 的
`useInterrupt`，不注入前端工具、不重寫原生 Agent Loop。官方契約見
[CopilotKit interrupt flow](https://docs.copilotkit.ai/a2a/human-in-the-loop/useInterrupt)。

## 協定與執行狀態

原生 clarify callback 或 approval callback 進入有期限的等待。當前 SSE 先結束開啟的
文字訊息，再傳送 `RUN_FINISHED`，其 `outcome.type` 是 `interrupt`，`interrupts`
包含隨機 ID、reason、responseSchema、expiresAt 與顯示資料。工具結果仍未產生。

同一原生 turn 的 worker、session lease、工具參數及 history 留在程序記憶體，工具不重跑，
不額外插入 user message、不重建 prompt 或 tool surface。平行工具的互動序列化呈現。
等待期間持續佔用 active-run／worker 容量，同 Thread 的新訊息回覆 409。

前端以同一 `threadId`、新的 `runId` 呼叫 `POST /agent`，保留一般 RunAgentInput 必填欄位，
並傳送一筆決策；不需要新的 user message，傳入的 UI history 不會重新注入模型：

```json
{
  "threadId": "thread-1",
  "runId": "resume-1",
  "messages": [],
  "resume": [{
    "interruptId": "the-issued-id",
    "status": "resolved",
    "payload": {"approved": true}
  }]
}
```

新 SSE 的 `RUN_STARTED` 使用新的 runId，原生 worker 繼續執行，原有 toolCallId 保持穩定。
工具事件可能跨兩個 SSE stream：第一個 stream 發送 call start／args／end，resume stream
才有 result。後續可能再次 interrupt；每次皆需新的 runId 與對應 interruptId。

## 決策格式與授權

- `reason: tool_approval`：payload 必須是 `{"approved": true}` 或 `{"approved": false}`。
  只允許一次授權，沒有 session／永久授權選項。
- `reason: clarification`：metadata.questions 保留原生 qid、question、choices、multi_select；
  payload 為 `{"answers": {"q0": "Blue"}}`，多選可傳字串陣列，略過可省略或填 null。
- `status: cancelled`：不接受該互動的決策，原生工具收到 deny／cancelled，模型可據此繼續。
- 要取消整個原生 turn，以同一 Bearer token 呼叫 `POST /threads/{threadId}/cancel`。
  回覆 `cancelling` 是合作式取消請求，不表示已強制終止工具。

所有 run、resume 與 cancel 都需要 Bearer authentication，並重新呼叫 trusted authorize hook。
錯 Thread、未知／已使用／過期 interrupt、同 Thread 新 Run、重複 resume 都不會執行工具。
回覆內容由 backend 驗證，不能只依賴 UI 的 responseSchema。Resume 不使用 forwardedProps。

Approval 透過 `tools.approval_context.bind_host_approval` 明確綁定 host callback，保留
api_server 的平台身分，透過 ContextVar 與原生 thread propagation 傳到 tool worker；
離開 turn 時還原 thread-local callback。沒有這個 channel 的 host 保留原有 unattended
政策。hardline deny、使用者 deny rules、native smart／allowlist／yolo／approvals.mode
仍由 Hermes 負責；此功能不會覆寫操作者已選定的原生政策，也不代表所有工具都需要 approval。

## 時限、斷線與重啟

Trusted `ServerConfig.human_input_timeout` 預設 90 秒，必須為有限正數；不是新的環境變數。
一般執行中的 SSE 斷線會取消原生執行。Interrupt 的 SSE 正常結束後允許稍後 reconnect／resume，
最晚至 expiresAt；逾時、overflow、明確 cancel 或 app shutdown 會令等待 fail closed 並要求
原生 turn 取消。非合作式外部工具仍可能延遲清理，保留原本的 lifecycle 保證。

此版本的 continuation **只在同一程序內有效**，不是持久化 Python stack checkpoint。
重啟或轉送到其他 server instance 會回覆 409，不會重播工具。使用單程序或 sticky routing；
歷史及原始 admission receipts 仍沿用前階段 SQLite persistence。部署時應讓前端顯示逾時／
失效決策，使用者確認外部操作狀態後再送出新訊息。不要自動重新提交有副作用的工作。

## 驗收

Python：`scripts/run_tests.sh tests/hermes_agui/test_human_input.py`。
CopilotKit：在 `examples/copilotkit` 執行 `npm run build`、`npm test`、`npm run test:e2e`。
瀏覽器 fixture 使用真實 AIAgent、工具與 loopback 模型；不消耗真實 LLM token。

手動驗收：啟用原生 clarify／file toolsets，請 Agent 詢問選項，回覆後觀察同一 toolCallId
的結果；再請其修改 workspace 的 AGENTS.md，確認核准前沒有寫入、拒絕後內容不變。
開啟新 Thread 應無法回答另一 Thread 的 interrupt；等待超時後重送舊決策應失敗。
