# Phase 1：Headless Hermes Python API

本階段提供 `hermes_agui.core.AgentConfig` 與 `HermesAgentService`，執行既有
`AIAgent.run_conversation`。此頁記錄 Phase 1 Python API；Phase 2/3 HTTP/SSE 與 callback bridge 介面見 [agui-server.md](agui-server.md)。
尚無 CopilotKit 整合。
原生 Loop、Tools、Memory、Skills、Prompt 與 ContextEngine 均保持原實作。

## 使用方式

先依 Hermes 原生 PM 流程準備 runtime/provider extras，在指定 profile 的 `config.yaml`
與 secrets store 設定模型及認證。`home` 與 `cwd` 必須由可信 host 決定，不接受 HTTP client 指定。

```python
from pathlib import Path
from hermes_agui.core import AgentConfig, HermesAgentService

config = AgentConfig(
    home=Path("/srv/hermes/profiles/alice"),
    cwd=Path("/srv/workspaces/alice"),
    principal="alice",
    # 不指定時，使用原生 api_server platform 的工具設定。
    enabled_toolsets=("file", "terminal", "memory", "skills"),
)

with HermesAgentService(config) as service:
    first = service.run(
        session_id="thread-001",
        message="請分析目前目錄有哪些檔案",
        callbacks={
            "stream_delta_callback": print,
            "tool_complete_callback": lambda call_id, name, args, result: None,
        },
    )
    second = service.run(session_id="thread-001", message="繼續說明")
    print(second["final_response"])
```

每個 Service 固定一個可信 principal/profile。可傳入 `authorize(principal, session_id)`，
拒絕時拋出 `PermissionError`；run、submit、cancel、evict 皆檢查授權。此 hook 是未來
HTTP 身分檢查的接點，不是現成多租戶認證系統。共享 profile 仍共享長期 Memory/Skills，
不同 Session 不代表不同 OS 工具權限。

## Session 與生命週期

- 外部 ID 限 1–512 字元；以 home、principal、外部 ID 的穩定映射產生原生 UUID。
  跨服務重建／程序重啟可找到同一 DB session；這個 ID 不是 secret 或 access token。
- DB 是 history 權威。只傳本輪新增 message；沒有 `conversation_history` 外部參數。
  Service 解析原生 resume tip，呼叫 `run_conversation(..., reload_history=True)`；原生
  admission 取得 durable lease 後才讀 conversation rows，避免 read-before-lease 的競態。
  此新增選項預設 False，既有 caller-owned history 路徑保持原行為。
- 每 Session 一個 AIAgent，保留其 prompt/tool snapshots；同 Session 串行，不同 Session 可並行。
  和原生 CLI 一樣，以目前的 native session ID 作為 task ID，維持工具 backend 的對話範圍。
  建構序列化以保護 process-wide discovery。Registry DB reference 直到 eviction/close 才釋放。
- `max_sessions=64` 限制保留的 session agents，滿時明確報錯；由 host 呼叫 `evict(id)`
  釋放 idle session，執行／排隊中的 session 不可 evict。後續可從 DB 恢復。
- `close()` 停止背景 executor admission、取消尚未執行的 background futures，等待進行中的
  calls，最後關閉 agents／memory provider／DB reference。close 不是取消指令；必要時先 cancel。
  不得在 run callback 中呼叫 close。
- profile 與 session context 包含 construction、run、cancel、evict、shutdown；私有 Context
  保護 caller context。Service 啟用原生 process multiplex guard，之後 unscoped secret reads
  會 fail closed；embedding host 的其他工作也必須遵循原生 profile scope 規範。

## 背景執行與取消

`run` 是同步 API，不得在 async event loop 直接呼叫。`submit` 使用有界 thread executor，
預設 `max_workers=4`、`max_pending=16`（running + queued），超過容量立即報錯：

```python
future = service.submit("thread-001", "分析檔案", run_id="run-001")
# async host 可 await asyncio.wrap_future(future)；保留 future 直到工作真正結束。
accepted = service.cancel("thread-001", "run-001")
result = future.result()
```

`future.cancel()` 只能取消尚未開始的工作；active native turn 必須呼叫 `service.cancel`。
回傳 False 表示該 Run 已不 active（也可能還在排隊／建構），不能視為取消成功。
host 應對 queued future 使用 `future.cancel()`，active turn 使用帶 run ID 的 cancel，
並等候原生結果／cleanup；後續 HTTP execution manager 必須處理 queued→active 的競態。
已進入 worker、但尚在等同 Session lock 的呼叫，目前仍須等前一輪釋放後執行，
無法透過 Future.cancel 取消；HTTP 層上線前須補完整的 queued-run cancellation。
host 提供的 run ID 必須唯一；本階段不提供 request 重試去重。ID 不重用時，遲到的
舊 run cancel 不會取消下一輪。

取消走 `AIAgent.interrupt(hard_cancel=True)`；不是 Python thread 強制終止保證。
非合作工具或外部 backend 可能延後結束，host 不可在 future 尚未 settled 時宣稱已釋放。
Phase 2 HTTP Adapter 已提供斷線取消與工作追蹤（見 agui-server.md）；
純 Python API 的 queued cancellation 限制仍如上述，Phase 3 已提供有界 callback mailbox 與文字/tool event bridge。

## Callback 與結果

`callbacks` 接受原生 display callbacks：文字 delta、interim、tool start/complete/progress、
step、status、notice、event、tool generation。保留原 payload，尚不轉 AG-UI Events。
它們可能在 provider/tool worker thread 觸發，必須 thread-safe、快速返回；不可直接操作
asyncio.Queue。獨立 reasoning callback 不在白名單；原生 tool_progress 仍可能含
`reasoning.available` 等混合通知，未來 Event Bridge 必須白名單過濾，不得原樣公開。

每輪 callbacks 在完成／例外後解除；只使用一個文字 sink，避免重複 delta。
Tool callback coverage 的 blocked／invalid／skipped 路徑限制，與 upstream 原生行為一致，
詳見 `architecture-audit.md`。`clarify` 回覆 unavailable；approval 使用原生 unattended
`api_server` policy，預設需要 approval 的操作拒絕，不開 yolo 或 terminal prompt。

結果保留原生 dict（包括 messages、completed、failed、partial、interrupted 等欄位），
增加 `external_session_id`、`native_session_id`、`run_id`。不能用函式成功 return 判斷 Run 成功。
Python 例外原樣傳出；後續協定 Adapter 才負責轉成 RUN_ERROR。
原始 messages／工具結果可能含敏感資料，不是可直接公開的 wire response。

`AgentConfig.agent_options` 是可信 host 的原生 constructor 選項，例如測試用
`skip_background_review`／`max_iterations`；不接受 client overrides，不能覆寫 Session、
profile identity 或 routing。UI 不支援的互動工具仍須由 host 的原生 toolsets policy 限制。

## 驗證

```bash
HERMES_PYTHON="$PWD/.venv/bin/python" scripts/run_tests.sh tests/hermes_agui/
python scripts/check --base HEAD
```

測試使用本機 `FakeLLMServer`，實際走 AIAgent、provider transport、tool registry 與 SQLite，
不消耗真實模型 token。具體結果、環境限制與尚未驗證事項於本階段交付報告記錄。

## Phase 4：持久 Admission

HTTP host 使用 `ReceiptStore` 在 profile 的 `agui-receipts.db` 原子保留 principal/thread/run
與 message IDs；Hermes `state.db` 仍獨占執行歷史。重啟後 SessionManager 的穩定 ID
映射恢復同一 Session，UI transcript 不匯入。相同 thread 並發回覆 409。
可信 `create_app(authorize=...)` hook 在 admission 前與原生 Service 邊界檢查存取權；
單 app 仍固定 principal/profile。收據不儲存輸出、不重播，也不保證 crash 後一定完成。
詳見 [HTTP 策略](agui-server.md) 與 [Phase 4 report](phase-4-report.md)。
