# AG-UI HTTP Server（Phase 2–4）

本階段提供 `POST /agent` 與 `GET /health`。Request、事件與 SSE 編碼使用官方
`ag-ui-protocol` **1.0.0**；FastAPI/Uvicorn 沿用專案版本。Phase 3 已接入原生文字與
工具 callback 串流。Phase 5 已完成 [CopilotKit 範例與 UI 驗證](../examples/copilotkit/README.md)。

## 啟動

在已按 Hermes 原生流程設定 provider 的獨立 profile 下，透過 PM 啟用 extra：

```bash
hermes pm install --extra agui
source ./activate
export AGUI_API_KEY='replace-with-a-private-random-token'
python -m hermes_agui.server --home /srv/hermes/profile --cwd /srv/workspace \
  --host 127.0.0.1 --port 8000
```

`AGUI_API_KEY` 是入口認證 secret，與 LLM API key 不同；不得交給瀏覽器端或寫進版本控制。
`--home`、`--cwd`、host、port 是可信啟動參數，沒有新增非 secret 的 `HERMES_*` 設定。
CLI 預設 home 使用原生 `get_hermes_home()`，cwd 使用啟動目錄。未提供 token 時拒絕啟動。
CLI 的新增參數均見 `python -m hermes_agui.server --help`。

服務預設只監聽 loopback；對外部署由可信反向代理提供 TLS，使用單一 ASGI worker。
Python 不提供 CORS 或 Docker；Phase 5 的獨立 Node Runtime 範例使用同來源前端。Native tools 具有該程序的 OS 權限；token
持有人可以使用該 profile，並非隔離沙箱。

```bash
curl http://127.0.0.1:8000/health
curl -N http://127.0.0.1:8000/agent \
  -H "Authorization: Bearer $AGUI_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"threadId":"thread-1","runId":"run-1","state":{},"tools":[],"context":[],
       "forwardedProps":{},"messages":[{"id":"user-1","role":"user","content":"Hello"}]}'
```

成功時從 `RUN_STARTED` 開始，即時發出 `TEXT_MESSAGE_START/CONTENT/END` 與工具事件，
最後 `RUN_FINISHED`。文字 callback 的 delta 直接傳送，不等待整個 turn 完成，不重送
整份 final。工具事件為 `TOOL_CALL_START/ARGS/END/RESULT`；完整參數安全投影一次送出，
沒有偽造增量參數。工具結果保留 tool role，沿用 native call ID。

執行失敗、partial、原生 hard cancellation、投影錯誤或滿載以泛化 `RUN_ERROR` 結束；先關閉已開始
的文字訊息，error 後不再發 `RUN_FINISHED`。已送出的 partial 文字無法撤回。
不公開原生 exception、messages、system prompt 或 reasoning；tool payload 預設遮蔽。
若 native streaming 被關閉或原生 hold_stream 阻擋 delta，才使用 completed final fallback。

`GET /health` 不驗證 provider 可用性；僅回傳 `{"status":"ok"}`，不建立 Agent 或讀取 secrets。
ASGI lifespan 開始時建立 Headless Service，結束時取消／等待已接收工作並關閉 native resources。

## Request 與 History 策略

- `threadId`、`runId`、最後一筆 user message ID 均須 1–512 字元。
- `messages` 必須以非空文字 user message 結束，接受字串及純文字 parts。
  不支援圖片、音訊或 browser-side tool-result resume。Phase 7 的 interrupt resume
  不需要新的 user message，格式見 [HITL](agui-human-input.md)。
- 只將最後一筆 user text 交給 native service；前面的 UI history 全部忽略，不匯入、
  不比較、不替換 Hermes DB。全新 thread 也不以 UI history 建構過去對話。
  若使用者需要匯入對話，須等後續明確的 import/reconciliation API。
- Hermes SQLite 是執行歷史的唯一權威；原生 admission 在 durable lease 下載入歷史。
  HTTP 層不重寫 Prompt、Context、Memory、Skills 或 Tool Dispatch。
- 非空 `tools`、`context`、`state`、`forwardedProps` 回覆 422；它們不會改變
  native toolsets、profile、provider 或系統指令。前端與後端工具整合留在後續階段。
- 同 thread active 時除匹配的 interrupt resume 外回覆 409；不同 thread 最多同時執行 4 個，超過容量回覆 503。
  HTTP 採計畫容許的「拒絕第二輪」策略；純 Python Service 仍支援原生同 Session 排隊。
- 每個已接收的 `(threadId, runId)` 與 `(threadId, user message ID)` 均保留收據。
  重送回覆 409，不自動重跑或重播結果；失敗與斷線也保留收據。上限預設 4096 筆收據
  （最多 2048 個 Run），滿時回覆 503，避免靜默驅逐後重複執行。
- Phase 4 收據儲存在 profile 的 `agui-receipts.db`，以 principal/thread 隔離，兩個 ID
  在 SQLite transaction 中原子保留，跨重啟仍拒絕重送。只儲存 ID，不儲存對話或工具內容。
  保留先於 native submit；crash 可能留下尚未執行的收據，因此是 at-most-once admission，
  不保證 exactly-once completion，也不重播結果。失敗、取消及不確定的工作不自動重跑。
  不應刪除收據來重試有副作用的工作；滿載時由 host 調高上限。
  Session 映射由 canonical home、可信 principal 與 thread 決定，重啟後載入原生歷史。
  HTTP admission 仍限單 ASGI worker／單節點；持久收據不代表支援多 worker。

HTTP 401 表示 token 不符；403 表示 Thread ACL 拒絕；422 表示 SDK/schema 或上述語意不合法；409 表示重送或 thread
忙碌；503 表示 admission/shutdown 限制。開始 SSE 後的執行錯誤以 `RUN_ERROR` 表示。
FastAPI 的 validation error 也使用泛化內容，避免回傳原始輸入。

## 斷線與生命週期

Response 同時監聽 ASGI disconnect，包括模型沒有輸出的時段，並涵蓋 ASGI 2.0/2.4。
斷線會設定該 Run 的 stop flag；Adapter 持有背景 task，重複嘗試取消 executor queued future
及相符的 native active run，直到 future 真正 settled 才釋放 thread admission。
因此能跨過 queued → constructing → active 之間 `cancel()` 暫時回覆 False 的窗口。
取消若拋出例外仍保留追蹤並重試，不把失敗當成 native worker 已終止。

這是合作取消；無法強殺 Python thread 或保證外部工具立即退出。非合作工具會讓 admission
及 shutdown 等待；不得在此時宣稱已清理。程序被 OS 強殺或部署強制逾時不在此保證內。
worker 透過 lock 保護的有界 mailbox 與 `loop.call_soon_threadsafe` 通知 ASGI loop，
不直接操作 asyncio.Queue。預設 pending 上限 256 項／UTF-8 payload 1 MiB；單一回覆
文字最多 1 MiB，每 Run 最多追蹤 256 個 tool IDs、ID bytes 合計 1 MiB。容量不足時
將 Run 標記失敗並合作取消，不阻塞 provider reader 或靜默丟棄後宣告成功。

## 嵌入與授權

```python
from pathlib import Path
from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig
from hermes_agui.server import create_app

app = create_app(
    AgentConfig(home=Path('/srv/hermes/profile'), cwd=Path('/srv/workspace'), principal='alice'),
    ServerConfig(bearer_token=read_secret()),  # read_secret 是 host 自行實作的秘密來源
    authorize=check_thread_access,  # 可信 host 函式，接收 principal、thread_id
)
```

一個 app 固定一個可信 principal/profile，token 授予該 principal 的 thread 存取權。
Thread ID 本身不授權；不讀 client 提供的 user/profile。可信 host 可提供 `authorize(principal, thread_id)`；拒絕時拋出 `PermissionError`。
HTTP 在保留收據前檢查，原生 Service 在執行與 cancel/evict 時再次檢查。hook 必須快速、
thread-safe，不能信任 client 的身份宣告。既有 `service_factory` 授權方式仍可使用，
但只有 `create_app(authorize=...)` 提供 HTTP admission 前的 403 檢查。
本階段未實作每個 HTTP 使用者的身份解析、多租戶路由或獨立 OS 工作空間。

## 工具公開投影

預設 arguments 與 result 都傳送 `{"content":"[withheld]"}`，仍保留 call name/ID 及
結果事件。工具原始內容不影響 Hermes 模型的執行歷史；只遮蔽傳到 UI 的投影。
沒有可靠的通用遮罩能保證任意 shell/file 輸出不含秘密，因此公開內容必須由可信 host
明確選擇。以下例子只對已知工具提供摘要：

```python
def public_tool_payload(kind, name, value):
    if kind == "arguments":
        return {}  # 不公開參數
    if name == "read_file":
        return {"message": "File operation returned; contents withheld"}
    return {"content": "[withheld]"}

config = ServerConfig(
    bearer_token=read_secret(),
    event_capacity=256,
    event_bytes=1048576,
    tool_projection=public_tool_payload,
)
```

投影接收 `(kind, tool_name, native_value)`，其中 kind 為 `arguments` 或 `result`；
傳回 JSON 可序列化資料。它在 callback thread 同步執行，必須快速且 thread-safe，
不可等待 UI；不可序列化／NaN／拋出例外會使 Run 失敗，不回傳原始錯誤。

只觀察原生 callback 有提供的已執行工具；blocked、invalid、skipped 工具可能沒有完整
callback，不會補造結果。native 工具失敗可讓模型繼續處理，不必然導致 RUN_ERROR。

## 官方依據與驗證

於 2026-11-14 檢查官方套件與實際安裝版本，而非假設 pre-1.0 的介面：

- [PyPI 官方 SDK 1.0.0](https://pypi.org/project/ag-ui-protocol/1.0.0/)
- [AG-UI 官方 Server 範例](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/quickstart/server.mdx)
- [官方 Python Request 型別](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/python/ag_ui/core/types.py)
- [官方 SSE Encoder](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/python/ag_ui/encoder/encoder.py)

可重現測試方式與結果見 [Phase 2 report](phase-2-report.md) 與
[Phase 3 report](phase-3-report.md)。事件順序參照 [官方 Events](https://docs.ag-ui.com/concepts/events)。
Phase 4 驗證見 [Phase 4 report](phase-4-report.md)；CopilotKit UI 與啟動方式見
[範例 README](../examples/copilotkit/README.md) 與 [Phase 5 report](phase-5-report.md)。

## 原生能力與 profile 範圍

同一 profile 的 Thread 共用 built-in MEMORY.md／USER.md 與可見的 skills；Thread ID
或不同 principal 只隔離 session history，不會分出另一份 memory 檔案。既有 Agent
保持 prompt snapshot，新 Thread 可讀取後續記憶寫入。Service eviction／shutdown
透過 owning scope 的原生 close 執行 provider extraction／flush；每個 HTTP Run
結束不等於 session end。自動 compression 與可配置 ContextEngine 也沿用原生流程。
完整策略見 [Phase 6 原生能力](agui-native-capabilities.md)。

## Human-in-the-loop

Phase 7 支援原生 clarify、一次性 approval、interrupt／resume 與取消。
範例 UI 使用官方 `useInterrupt` 呈現決策表單。Continuation 僅於同一程序存活期間有效，
預設等待 90 秒；完整協定、授權與部署限制見 [HITL 說明](agui-human-input.md)。
