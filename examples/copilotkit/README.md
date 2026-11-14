# Hermes × CopilotKit

獨立的本機整合範例，使用 CopilotKit **1.83.0 的 v2 API**、AG-UI JS **1.0.2** 與
React 19。版本已鎖定於 `package-lock.json`；與 Hermes Python 官方 SDK 1.0.0 透過
HTTP/SSE 整合，不需要 Copilot Cloud、Intelligence 或另一個 LLM API key。

```text
CopilotKit React UI (:3000)
  → 同來源 /api/copilotkit
  → CopilotRuntime v2 + InMemoryAgentRunner
  → 官方 HttpAgent（server-side Bearer token）
  → Hermes /agent (:8000)
  → 原生 Agent Loop / Provider / Tools / SessionDB
```

## 啟動

需要 Node **22.12+（<27）**、npm，以及已按專案 PM 流程安裝 `agui` extra 的 Python
環境。先在獨立 Hermes profile 設定 Provider。兩個終端使用相同 `AGUI_API_KEY`。

終端 A（repository root）：

```bash
source ./activate
export AGUI_API_KEY='replace-with-a-private-random-token'
python -m hermes_agui.server --home /absolute/path/to/profile --cwd /absolute/path/to/workspace
```

終端 B：

```bash
cd examples/copilotkit
npm ci
export AGUI_API_KEY='replace-with-a-private-random-token'
export AGUI_URL='http://127.0.0.1:8000/agent'
npm run dev
```

打開 **http://127.0.0.1:3000**。Node 同時服務 Vite 前端與 Runtime，瀏覽器不需要
Hermes token，也沒有直連 Python 的 CORS 設定。`.env.example` 只作參考；程式不自動
讀取 `.env`，請在啟動環境 export 變數。token 不可改成 `VITE_*` 或放進前端程式碼。

建置與本機 production mode：

```bash
npm run build
npm start
```

`npm start` 仍使用 tsx，所以執行環境要保留 devDependencies。production mode 代表
服務已建置的靜態前端，不代表這個單使用者範例已具備對外部署的身份系統。

## 行為

- 新增／切換對話使用不同的 thread-scoped `useAgent` instance，透過同一 `hermes`
  Runtime agent 路由；每個分頁中的對話保留獨立 UI messages。最多開啟 64 個對話。
- `CopilotChatView` 呈現官方聊天 UI；按下送出才呼叫 `copilotkit.runAgent`。
  不使用 `CopilotChat` 的自動初始化 Run，因為 Hermes 不接受空 user message。
- Hermes `state.db` 是模型歷史權威；Runtime runner 的事件紀錄只服務 UI。
  Browser 傳來的完整 transcript 不會再次注入模型。重新整理會建立新的對話 ID；
  此範例沒有持久 UI thread 列表或 history import API。
- Hermes 保留跨重啟 Run/message 去重；不提供自動 retry／regenerate，以免重複工具副作用。
- 工具由原生 Hermes 執行；wildcard **renderer** 只呈現事件，不宣告／執行 frontend tools。
  預設工具參數／結果公開投影是 `[withheld]`；可在可信 Python host 設定 `tool_projection`。
- 官方 core 會注入 `forwardedProps.__copilotkitRequestId`。官方 HttpAgent middleware
  只移除這個傳輸追蹤欄位；state/context/frontend tools／其餘 forwardedProps 沿用 Hermes
  的明確拒絕策略。不啟用 A2UI、generative UI、MCP 或 frontend tool middleware。
- 文字、工具與錯誤均透過官方協定串流；UI 顯示泛化錯誤，不呈現 provider 原始例外。
  Stop 使用官方 Runtime stop API；Python 的合作取消限制仍適用。

## 存取範圍

這是固定 principal/profile 的單使用者 **loopback** 範例。Node 僅綁定 `127.0.0.1`，
檢查 Host／Origin、不啟用跨來源存取，所有 Runtime 呼叫使用固定本機身份。
Hermes Bearer token 只存於 Node 環境與 HttpAgent headers；入站 authorization／x-* 不轉發。
對外部署時應另外整合真正的應用程式身份、Thread ACL 與 TLS，並保留 Python 的授權介面。

Runtime 的有界 in-memory runner 不取代原生 SessionDB，重啟 Node 也不保證恢復完整 UI。
不同 HTTP Thread 可由 Python 並行執行，同 Thread 忙碌仍拒絕第二個 Run。

安裝腳本與 CopilotKit server telemetry 預設停用；不新增外送分析。`.npmrc` 以
2026-10-31 為套件解析截止日（建立範例時至少 14 天），更新依賴時需重新審核截止日及 lock。

## 測試

```bash
npm test
npm run build
# 使用有 agui / test 依賴的隔離 Python 環境：
export HERMES_PYTHON=/absolute/path/to/test-env/bin/python
npx playwright install chromium
npm run test:e2e
# 驗證已建置的前端（先 npm run build）：
COPILOTKIT_TEST_PRODUCTION=1 npm run test:e2e
```

若已有相容的 Chrome，可略過下載並設定：

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/absolute/path/to/chrome'
npm run test:e2e
```

E2E 會啟動 temporary `HERMES_HOME`、loopback FakeLLMServer、真實 Hermes server 及 Node
Runtime，測試官方 React UI 的串流、原生 read_file、Thread 延續／隔離及 Agent Error。
使用 3000／8765 連接埠，不允許重用既有服務；不讀取個人 profile 或呼叫付費模型。
文字串流測試會將原生 callback 暫停到瀏覽器確認已顯示第一段文字後才放行，驗證真正
在 Run 完成前呈現，而非只檢查最後一份回覆。Node unit test 也驗證 credential pinning、
header policy 與精確的 metadata 過濾。

Python 回歸仍從 repository root 執行：

```bash
HERMES_PYTHON=/absolute/path/to/test-env/bin/python scripts/run_tests.sh tests/hermes_agui/
```

## 官方參考

- [CopilotKit v2 Runtime](https://docs.copilotkit.ai/deepagents/backend/copilot-runtime)
- [Thread-scoped useAgent](https://docs.copilotkit.ai/reference/v2/hooks/useAgent)
- [CopilotChatView](https://docs.copilotkit.ai/reference/v2/components/CopilotChatView)
- [Backend tool renderers](https://docs.copilotkit.ai/reference/v2/hooks/useRenderTool)
- [AG-UI HttpAgent](https://docs.ag-ui.com/sdk/js/client/http-agent)

API 以 lockfile 安裝版本的實際 declarations 與行為測試為準；後續文件可能對應更新版本。

## 原生能力（Phase 6）

Memory、Skills、Context compression 由 Python 的原生 Hermes 實作負責。
同一 profile 的多個 UI Thread 共用長期 memory／skills，各自保留獨立對話歷史與
已建立的 prompt snapshot。Thread 切換不等於切換使用者。需要隔離使用者資料時
應使用不同可信 profile/workspace。詳見 [原生能力與驗收](../../docs/agui-native-capabilities.md)。

## Human-in-the-loop

Phase 7 支援原生 clarify、一次性 approval、interrupt／resume 與取消。
範例 UI 使用官方 `useInterrupt` 呈現決策表單。Continuation 僅於同一程序存活期間有效，
預設等待 90 秒；完整協定、授權與部署限制見 [HITL 說明](../../docs/agui-human-input.md)。
