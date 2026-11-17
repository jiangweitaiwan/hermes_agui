# Dynamic Bot Manager — Part 2

本階段接續 [Runtime Memory Part 1](runtime-memory-part-1.md)，實作動態 Bot 生命週期、
持久化 Registry、管理 API、管理介面、Hermes Provisioner、Host 動態服務與 Delegation 記憶流程。
沒有引入正式 Graph DB、知識抽取或多層 Delegation。

## 元件與資料流

- `server/bots/registry.ts`：SQLite Registry，持久化 Bot 狀態、所有權、配置與後端憑證。
- `server/bots/manager.ts`：序列化建立、更新、啟用、重試、停用及軟刪除。
- `server/bots/auth.ts`、`api.ts`：認證、Owner／Project 檢查、CSRF 防護及公開資料投影。
- `hermes_agui/provisioner.py`：從核准模板建立隔離的原生 Home／Workspace。
- `hermes_agui/management.py`：受保護的 Host 管理端點與 Host 自身的持久化狀態。
- `hermes_agui/host_runtime.py`：每 Bot 的 HermesAgentService、Adapter、Receipts 與卸載。
- `frontend/BotManagement.tsx`、`BotEditor.tsx`：登入、清單、建立、編輯、停用、啟用／重試、刪除與開啟對話。

建立流程：認證與配額 → Registry `provisioning` → Host provision／register → Registry `active`
→ Runtime 動態解析與路由。Provision 失敗會保留 `failed`，不發布可執行路由，可對同一 Bot ID 重試。

Runtime 依 Registry 發布目前可執行的 Bot；每個 Bot 保留自己的 BotRunner。
更新 Agent 設定時重建該 Bot 的 HTTP Agent handler，但沿用相同 Runner，因此不會把不同 Bot
的同名 Thread 合併，也不會清空原有 Runtime Thread Store。

## 啟用方式

管理功能為部署端明確啟用；不設定 `management` 時，既有單 Bot／靜態多 Bot 啟動方式仍可使用。
所有路徑、Endpoint、Provider Secrets、模型及能力模板均由管理員配置。

### Hermes Host

以 `python -m hermes_agui.server --bots-config /path/to/host.yaml` 啟動，例如：

```yaml
bots: []
max_active_runs: 8
management:
  root: ./managed-bots
  token_env: BOT_HOST_MANAGEMENT_KEY
  max_bots: 128
  templates:
    analyst:
      model: your-approved-model
      provider: custom
      base_url: https://approved-provider.example/v1
      api_key_env: MODEL_API_KEY
      toolsets: [memory, skills]
      skills:
        financial-analysis: ./approved-skills/financial-analysis
      config:
        skills:
          creation_nudge_interval: 0
# 使用 message_bot 時另配置既有 delegation 區塊：
delegation:
  url: http://127.0.0.1:3001/internal/delegations
  token_env: BOT_DELEGATION_KEY
```

模板 key（如 `analyst`）必須與 Runtime 的 Hermes 模板 ID 相同。
`config` 沿用 Hermes 原生配置；不要把 Provider Key 放入此配置，使用 `api_key_env`。
Provisioner 呼叫原生 `ensure_hermes_home()`／`save_config()` 初始化，不複製其他 Bot 的記憶或 Session。
Bot 名稱與說明建立獨立的 `SOUL.md`；SQLite 由原生 Session 初始化流程建立。

檔案配置：

```text
managed-bots/
  registry.sqlite3       # Host 恢復服務與生命週期的記錄
  bot-<uuid>/
    home/                 # config.yaml、SOUL.md、memories/、skills/、state.db
    workspace/
```

Host 管理 API 使用獨立 Bearer credential，不接受帶 Origin 的瀏覽器請求：

| 方法 | 路徑 | 功能 |
| --- | --- | --- |
| GET | `/internal/bots` | 列出 ID／狀態 |
| GET | `/internal/bots/{id}` | 查詢 ID／狀態 |
| PUT | `/internal/bots/{id}` | 冪等註冊／配置 |
| POST | `/internal/bots/{id}/disable` | 停用與卸載 |
| DELETE | `/internal/bots/{id}` | 軟刪除與卸載 |

### CopilotKit Runtime

`AGUI_BOTS_CONFIG` 指向下列 JSON，沿用既有啟動方式 `npm run dev` 或 `npm start`：

```json
{
  "bots": [],
  "management": {
    "registryPath": "./data/bots.sqlite3",
    "hostUrl": "http://127.0.0.1:8000",
    "hostTokenEnv": "BOT_HOST_MANAGEMENT_KEY",
    "maxBotsPerOwner": 32,
    "maxRecords": 128,
    "users": [{
      "ownerId": "owner-1",
      "principal": "owner-1",
      "projectId": "project-alpha",
      "tokenEnv": "BOT_OWNER_ACCESS_KEY"
    }],
    "templates": [{
      "id": "analyst",
      "name": "Financial Analyst",
      "harness": "hermes",
      "model": "your-approved-model",
      "provider": "custom",
      "skills": ["financial-analysis"],
      "toolsets": ["memory", "skills"]
    }]
  },
  "delegation": {
    "tokenEnv": "BOT_DELEGATION_KEY",
    "allow": {},
    "listenPort": 3001
  }
}
```

範例維持 loopback／同源 Host 限制；這個認證入口是部署方配置的 Owner credentials，沒有新增帳號註冊系統。
`users` 決定 Owner、Principal、Project；同一 Owner 必須對應同一 Principal。
瀏覽器輸入 Owner Access Key 後取得 8 小時的 HttpOnly、SameSite=Strict session cookie。
Cookie 在 HTTPS Request 上另帶 Secure；後端 API 呼叫也可直接使用 Owner Bearer token。

若同時保留原有 `bots` 陣列，部署 Bot 會納入 Registry，綁定 `bootstrapOwnerId` 指定的使用者；
未指定時使用 `users[0]`。原有部署 Endpoint 會成為管理員核准的 remote template。
Owner Access Key、Host Management Key、Bot Token、Runtime Memory Signing Key 是不同憑證。
新 Hermes Bot 的後兩者由後端隨機產生，API 不回傳。

程式化使用 `createApplication(..., { management })` 時，必須先 `await application.ready` 再接收請求；
結束後呼叫 `application.close()` 釋放 Runtime Registry。為使用不需 experimental flag 的內建 SQLite，
Node engines 調整為 `^22.13.0 || >=23.4.0 <27`，並同步 package-lock；沒有新增套件依賴。
版本界線依 [Node 官方 SQLite 歷史](https://nodejs.org/download/release/v22.23.0/docs/api/sqlite.html)。

## 公開管理 API

啟用管理模式後，所有 CRUD、選項、清單與 Runtime 路由都會驗證身分及 Owner／Project。
未知或不屬於目前使用者的 Bot 回覆 404。瀏覽器狀態修改另驗證 Origin。

| 方法 | 路徑 | 功能 |
| --- | --- | --- |
| POST | `/api/bot-session` | 以 Owner Access Key 登入 |
| GET | `/api/bots/options` | 取得公開模板與能力 allowlist |
| GET | `/api/bots` | 本 Owner／Project 的 Bot 清單 |
| POST | `/api/bots` | 建立 Bot |
| GET | `/api/bots/{id}` | 取得公開 Bot Record |
| PATCH | `/api/bots/{id}` | 更新名稱、說明、模板、Skills、Toolsets、委派權限 |
| POST | `/api/bots/{id}/disable` | 停用 |
| POST | `/api/bots/{id}/enable` | 啟用 |
| POST | `/api/bots/{id}/retry` | 重試失敗／未完成的 Provision |
| DELETE | `/api/bots/{id}` | 軟刪除 |

建立範例（不要提交 Owner、Project、伺服器路徑、Endpoint 或 Secrets）：

```json
{
  "name": "Financial Analyst",
  "description": "分析公司財務報表。",
  "harness": "hermes",
  "templateId": "analyst",
  "skills": ["financial-analysis"],
  "toolsets": ["memory", "skills"],
  "delegationTargets": []
}
```

管理 Request 最大 16 KiB，以串流讀取時即限制大小。使用者只能從核准模板選模型／Provider；
不能任意填 URL 或提交憑證。`remote_ag_ui` 僅接受部署方的 `BotTemplate.remote` Endpoint，
以模板參照方式註冊，不對遠端第三方服務執行檔案 Provision 或資源刪除。

## 更新、停用、刪除與還原

- 每個新 Hermes Bot 使用隨機 ID 和分離的 Home／Workspace；合法 ID 與固定相對子目錄防止路徑穿越。
  Provision 與 Restore 都拒絕 profile 路徑的 symlink，既有 Bot 的身份、路徑與憑證不可透過配置更新更換。
- Owner 配額預設 32（跨其 Projects 計算）；總 Registry Record 預設 128，含軟刪除 tombstones。
  Host 也獨立限制受管理 Record 數量，防止無限擴張。
- Active Run 包含暫停中的 HITL。Native Host 在有 Active Run 時拒絕重新配置、停用或卸載，回覆 409。
  Runtime 對明確的 409 恢復原 Record 與路由，其他 Bot 不受影響。
- 名稱／角色／模型／Toolsets 更新保留已建構的原生 Agent 與快取前綴；新對話取得新配置。
  Native Skills 檔案仍依 Hermes 原本的工具讀取方式使用；移除的受管理 Skill 移到 archive，避免刪掉演化內容。
  若需終止使用舊設定的所有 Session，先於閒置時停用再啟用 Bot。
- 停用會卸載該 Bot 的服務並拒絕新 Run；啟用以相同 ID、Profile 及 credentials 恢復。
- 軟刪除保留 Profile、Skills、Memory 與 SQLite History，tombstone 防止同 ID 意外復活。
  目前沒有永久刪除／自動 GC。UI 維持既有的重新整理開新 Thread 行為，沒有新增歷史 Thread 瀏覽器。
- Registry 先保存 lifecycle intent 再呼叫 Host。若停用／刪除時 Host 不可用，Runtime 仍維持拒絕路由；
  重試或重新啟動會重新協調 Host。Provision 故障保留 failed 狀態，前端可以啟用／重試同一 Bot。
- Host 啟動從自己的 SQLite Registry 還原 active Bot，不需要 Runtime 同時重啟。
  還原不重寫原生 SOUL、Memory、Skills 或配置；不安全／遺失的 Profile 會標記 failed，讓其他 Bot 繼續啟動。
  Runtime 重啟也從 Registry 還原路由與委派權限，向 Host 執行冪等註冊。

Registry 檔案以 0600 建立，新的專用管理目錄以 0700 建立；資料庫包含後端 credentials，
部署與備份應採用私有目錄。初版採單一 Runtime writer，不提供多 Replica 的分散式生命週期鎖。

## Runtime Memory 與 Delegation

新 Hermes Bot 自動取得 Principal、Bot ID、Project、Memory Signing Key，直接接上 Part 1。
Graph Provider 仍從 `createApplication(..., { graph })` 注入；未提供時使用原生記憶正常執行。

互動 Run 與 Child Run 都使用 `memory/pipeline.ts::prepareRunInput`：

```text
互動：Runtime HTTP Agent → prepareRunInput → Graph query → signed context → Hermes
委派：DelegationCoordinator → prepareRunInput（target identity）→ Graph query → signed context → Hermes
```

委派依目前 Registry／allow table 解析 active target，來源與目標需經 Owner／Project 授權。
來源只能把自己的允許清單設為相同 Owner／Project 的 active Bot；目標停用／刪除後立即拒絕新的委派。
Child Thread／Run 使用新的隨機 ID，不複製來源的 MemoryContext。
原有 Parent Run 驗證、單層深度、去重、超時、取消、HITL 與回傳大小限制保留。

Part 1 的「Graph Context 不落 SQLite」與「完整跨輪 request prefix cache」取捨仍然存在；
本階段沒有改變那個契約。正式 Graph DB、抽取、寫入仍不在範圍內。

## 驗證方式

```bash
cd examples/copilotkit
npm test
npm run build
DYNAMIC_BOT_TEST=1 HERMES_PYTHON=/path/to/test/python npm run test:e2e -- tests/browser/bot-management.spec.ts
MULTI_BOT_TEST=1 HERMES_PYTHON=/path/to/test/python npm run test:e2e -- tests/browser/multi-bot.spec.ts
cd ../..
HERMES_PYTHON=/path/to/test/python scripts/run_tests.sh tests/hermes_agui/
python scripts/check
```

- Vitest 驗證 Registry reopen、配額、跨 Owner／Project 拒絕、憑證投影、忙碌保護、重試與 API session。
- Python native Host 測試驗證 Profile／Thread 隔離、獨立憑證、重啟、軟刪除、路徑／symlink 拒絕與 Active Run 保護。
- 跨語言驗收使用真實 CopilotKit Runtime、管理 API、Hermes HTTP Host、原生 message_bot 與 Fake LLM HTTP provider；
  驗證模型 Request 內有正確 target 的共享／私有 Graph records、沒有來源 Bot 私有 records，SQLite 未受 Context 污染。
- Playwright 驗證實際新增、對話、編輯、停用、啟用與刪除，並回歸原有多 Bot 串流／工具／HITL／取消／Delegation。

模型採 loopback Fake LLM，沒有使用真實供應商 credentials；跨語言測試需要 Node 在 PATH 與 example node_modules。
瀏覽器需要已安裝 Playwright Chromium，或透過 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定本機 Chrome。

## 本次驗收結果（2026-11-17）

- TypeScript：5 個檔案、21 個測試通過；包括 Host 離線時仍保持停用狀態的恢復測試。
- `npm run build` 與最終 `tsc --noEmit` 通過。
- Python AG-UI 完整回歸：21 個檔案，77 個測試通過、1 個既有啟動測試逾時，容器測試未啟用。
  當時同時執行 build／browser 測試；這是逾時的可能原因，未當成已證實的根因。
  隨後重跑啟動、Dynamic Host、Dynamic Runtime 三個測試檔，7/7 通過；Host 最後調整後再次 3/3 通過。
  跨語言驗收包含 Runtime Registry 重開、Host 自身還原、停用後拒絕委派、啟用後恢復，以及重啟後委派權限／記憶。
- Playwright：新管理介面生命週期 1/1 通過；既有 multi-Bot 串流／工具／HITL／取消／Delegation 1/1 通過。
- Ruff、Python 新模組 CC≤20、TypeScript 管理模組與前端 CC≤20、`git diff --check` 通過。
- `scripts/check` 已執行，10/17 項通過。7 項仍因原有 checkout 缺少 6 個 CI guard 腳本及
  根目錄 `package.json` 而不能完成，與 Part 1 報告的阻礙相同；未宣稱完整 CI 全綠。

已完成本計畫 Part 2 的 Hermes 路徑；remote endpoint 註冊使用管理員核准模板，沒有新增任意 URL
註冊或遠端第三方資源刪除。正式 Graph Provider、永久刪除／GC、歷史 Thread 管理 UI、
多 Replica 協調與外部 Harness 的端到端驗收留作後續擴充。
