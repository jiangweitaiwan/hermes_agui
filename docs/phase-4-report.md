# Phase 4：Session 與 Conversation History

## Implementation Summary

延續目前工作樹的 Phase 3（尚未提交），完成計畫第 6 節。沒有修改原生 Agent Loop、
Tool Dispatch、Context Management 或 Hermes history persistence。

既有 SessionManager 以 canonical profile home、可信 principal、external thread ID 產生
穩定 native Session ID；Service 在原生 durable turn lease 下載入歷史，沿用 resume tip。
本階段保留這套機制，補齊跨 HTTP app 重啟的 admission 去重與 HTTP Thread ACL。

## 策略

- History ownership：Hermes `state.db` 是唯一執行歷史；只傳入最後一筆新 user text，
  不串接、不匯入 UI transcript。新 Thread 不從客戶端舊訊息建立歷史。
- Isolation：固定 principal/profile 的 app；native ID 與收據都依 principal/thread 隔離。
- Concurrent runs：同 Thread 第二個 HTTP Run 回覆 409；不同 Thread 可並行且受全域容量限制。
  純 Python Service 仍保留既有 Session lock 序列化策略。
- Replay：profile 的 `agui-receipts.db` 原子保留 Run/message IDs，跨重啟重送回覆 409。
  兩個 ID 一起成功或一起回滾；重複 ID 不消耗另一個新 ID。
- Crash：先保留再 submit；未執行、失敗、斷線或被強殺的 Run 都可能留下收據。
  不重試、不重播，不宣稱 exactly-once completion。避免重複副作用優先於自動恢復。
- Capacity：預設每 principal 4096 筆，滿時 503；不自動清除，host 可調高既有上限。
- Authorization：`create_app(authorize=...)` 接受可信同步 hook `(principal, thread_id)`；
  `PermissionError` 在 admission 前轉成泛化 403，不保留收據；原生 Service 仍在
  run/cancel/evict 檢查權限。Thread ID 不是身份驗證，Bearer token 仍綁固定 principal。

## Files Changed

- 新增 `hermes_agui/receipts.py`：獨立 SQLite admission tombstones；不保存內容或改動 native DB schema。
- 修改 `hermes_agui/adapter.py`：HTTP 使用持久收據；DB 例外回覆泛化 503。
- 修改 `hermes_agui/server.py`：lifespan 建立 receipt store、公開並傳遞可信 ACL hook。
- 新增 `tests/hermes_agui/test_durable_sessions.py`：HTTP restart + 真實 native history、
  ACL/capacity、transaction atomicity 與 principal isolation。
- 更新 `docs/agui-server.md`、`docs/agui-architecture.md` 與本報告。

## 範圍與限制

仍只支援單 ASGI worker、單節點，以及一個 app 固定一個可信 principal/profile。
SQLite transaction 保護收據原子性，並不將程序內 active-run tracking 變成分散式鎖。
未加入多租戶身份解析、history import/read API、結果重播或 CopilotKit UI。
原生工具、Memory、Skills 的安全範圍仍由 profile owner 管理。
下一階段為 Phase 5 CopilotKit integration。

## Validation

