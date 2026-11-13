# Phase 2：AG-UI HTTP Server

本階段提供 `POST /agent` 與 `GET /health`。Request、事件與 SSE 編碼使用官方
`ag-ui-protocol` **1.0.0**；FastAPI/Uvicorn 沿用專案版本。文字在原生 turn 完成後一次
傳送，完整 token/tool callback bridge 留在 Phase 3。本階段沒有 CopilotKit UI 驗收。

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
本階段不提供 CORS、Docker 或 Node Runtime。Native tools 具有該程序的 OS 權限；token
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

成功時依序發出 `RUN_STARTED`、可選的 `TEXT_MESSAGE_START/CONTENT/END`、`RUN_FINISHED`。
`CONTENT.delta` 為完成後的文字，沒有假裝成 token streaming。執行失敗、partial、interrupt
或建構例外則發出 `RUN_STARTED`、泛化的 `RUN_ERROR`；error 後不再發 `RUN_FINISHED`。
不公開原生 exception、messages、system prompt、reasoning 或 tool result。

`GET /health` 不驗證 provider 可用性；僅回傳 `{"status":"ok"}`，不建立 Agent 或讀取 secrets。
ASGI lifespan 開始時建立 Headless Service，結束時取消／等待已接收工作並關閉 native resources。

## Request 與 History 策略

- `threadId`、`runId`、最後一筆 user message ID 均須 1–512 字元。
- `messages` 必須以非空文字 user message 結束，接受字串及純文字 parts。
  不支援圖片、音訊、tool-result resume 或中斷恢復。
- 只將最後一筆 user text 交給 native service；前面的 UI history 全部忽略，不匯入、
  不比較、不替換 Hermes DB。全新 thread 也不以 UI history 建構過去對話。
  若使用者需要匯入對話，須等後續明確的 import/reconciliation API。
- Hermes SQLite 是執行歷史的唯一權威；原生 admission 在 durable lease 下載入歷史。
  HTTP 層不重寫 Prompt、Context、Memory、Skills 或 Tool Dispatch。
- 非空 `tools`、`context`、`state`、`forwardedProps`、`resume` 回覆 422；它們不會改變
  native toolsets、profile、provider 或系統指令。前端與後端工具整合留在後續階段。
- 同 thread active 時回覆 409；不同 thread 最多同時執行 4 個，超過容量回覆 503。
  HTTP 採計畫容許的「拒絕第二輪」策略；純 Python Service 仍支援原生同 Session 排隊。
- 每個已接收的 `(threadId, runId)` 與 `(threadId, user message ID)` 均保留收據。
  重送回覆 409，不自動重跑或重播結果；失敗與斷線也保留收據。上限預設 4096 筆收據
  （最多 2048 個 Run），滿時回覆 503，避免靜默驅逐後重複執行。
- 收據與 admission 僅存在單一程序內，**不是跨重啟 exactly-once 保證**。程序重啟後需使用
  新 Run/message IDs 並先確認 history，不能盲目重試。多 worker、多節點與持久收據屬 Phase 4。

HTTP 401 表示 token 不符；422 表示 SDK/schema 或上述語意不合法；409 表示重送或 thread
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
沒有直接從 worker 操作 asyncio.Queue，也尚未引入 Phase 3 的 token queue/backpressure。

## 嵌入與授權

```python
from pathlib import Path
from hermes_agui.config import ServerConfig
from hermes_agui.core import AgentConfig
from hermes_agui.server import create_app

app = create_app(
    AgentConfig(home=Path('/srv/hermes/profile'), cwd=Path('/srv/workspace'), principal='alice'),
    ServerConfig(bearer_token=read_secret()),  # read_secret 是 host 自行實作的秘密來源
)
```

一個 app 固定一個可信 principal/profile，token 授予該 principal 的 thread 存取權。
Thread ID 本身不授權；不讀 client 提供的 user/profile。需要自訂 ACL 的可信 host 可透過
`service_factory` 建立帶原生 `authorize(principal, thread_id)` 的 `HermesAgentService`。
本階段未實作每個 HTTP 使用者的身份解析、多租戶路由或獨立 OS 工作空間。

## 官方依據與驗證

於 2026-11-14 檢查官方套件與實際安裝版本，而非假設 pre-1.0 的介面：

- [PyPI 官方 SDK 1.0.0](https://pypi.org/project/ag-ui-protocol/1.0.0/)
- [AG-UI 官方 Server 範例](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/quickstart/server.mdx)
- [官方 Python Request 型別](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/python/ag_ui/core/types.py)
- [官方 SSE Encoder](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/python/ag_ui/encoder/encoder.py)

可重現測試方式與結果見 [Phase 2 report](phase-2-report.md)。下一階段才接入文字與 tool
callbacks、thread-safe bounded queue、tool result 遮罩與事件順序驗證。
