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

需要符合 `^22.13.0 || >=23.4.0 <27` 的 Node、npm，以及已按專案 PM 流程安裝 `agui` extra 的 Python
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

### 多 Bot

設定 `AGUI_BOTS_CONFIG=./bots.example.json`，在 Node 程序提供其中 `tokenEnv`
指定的秘密，即可將 researcher/reviewer 註冊到同一 Python host。瀏覽器只選 Bot ID，
每 Bot 有獨立 runner 與 Thread UI。完整單 host、雙 profile/volume 啟動方式見
[部署指南](../../docs/agui-deployment.md#單程序雙-bot里程碑-a--b)。
既有 `AGUI_URL` / `AGUI_API_KEY` 單 Bot 模式繼續支援。

### 跨 Bot 委派與 Graph 接口（Part 2）

雙 Bot 設定 `bots.example.json` 現在包含 `delegation`：方向性 `allow`、
`tokenEnv`、`listenHost`／`listenPort`（預設 `127.0.0.1:3001`）、
`timeoutMs`（預設 55000，最大 290000）。兩個程序提供相同的 `DELEGATION_TOKEN`，
Node 另保留各 Bot 原有 token。刪除 Python YAML 與 Node JSON 的 `delegation` 區塊
即可停用；單 Bot 的既有環境變數不變。

Node 的內部 listener 僅接受 `POST /internal/delegations`，拒絕瀏覽器 Origin，
以來源 Bot token 驗證請求，再向 Python 查證父 Run 仍有效及深度為 0。
此服務接口不經 CopilotKit 的瀏覽器路由。範例綁 `0.0.0.0:3001` 以接收 Python
容器經 `host.docker.internal` 的回呼；全本機啟動時改成 `127.0.0.1`。
完整啟動步驟與結果見 [Part 2 交接](../../docs/multi-bot-part-2.md)。

Graph 接口由 `server/application.ts:createApplication` 的 `graph` option 注入。
`server/graph-memory.ts` 定義 `GraphMemoryPort`、具型別 scope、來源、可見範圍及結果。
預設無 provider；授權通過的操作回 `disabled`。產品對話不自動 query/write。
provider 範例與契約測試在 `tests/graph-memory.test.ts`，in-memory provider 僅存在測試。

### Runtime shared memory (Part 1)

Bots may opt into a signed, read-only Runtime Memory channel using backend `memory`
settings. The graph provider is injected through `createApplication(..., { graph })`;
no provider is enabled by default. See [configuration, trust boundary, tests and cache
tradeoff](../../docs/runtime-memory-part-1.md). Browser-supplied ACL or memory envelopes
are never accepted as trusted context. Native Hermes memory and SQLite remain authoritative.

### Dynamic Bot Manager (Part 2)

Enable backend `management` settings to create Bots without restarting either Runtime
or Hermes Host. The UI authenticates the owner and offers approved model, skill and
toolset templates. Lifecycle records persist in SQLite, and delegated runs use the
target Bot's Runtime Memory pipeline. See [deployment, API and lifecycle details](../../docs/runtime-memory-bot-manager-part-2.md).

### Wiki Graph retrieval (Graph Memory Part 1)

Use Node 22.13+ with SQLite/FTS5 and `npm ci`. Add a server-owned `graph` section to
`AGUI_BOTS_CONFIG` (JSON); omit it or set `enabled: false` to avoid opening a wiki database:

```json
{
  "graph": {
    "enabled": true,
    "dataRoot": "/absolute/physical/path/wiki",
    "timeoutMs": 2000,
    "maxPages": 1000,
    "maxPageBytes": 262144
  }
}
```

This section accompanies the existing `bots`, `memory`, management and delegation
settings. Each Bot still needs its signed `memory` configuration. Namespace identity
comes from these backend settings; custom graph authorization can only restrict access.
An unavailable store fails soft; authorization failures stop the run. Shutdown closes
the provider. No LLM, embeddings or automatic writes are enabled.

Trusted local administrators can import compiled Markdown from a manifest, rebuild
indexes and inspect aggregate counts, from `examples/copilotkit`:

```bash
npx tsx server/graph/cli.ts import /absolute/physical/path/wiki fixtures/wiki/manifest.json
npx tsx server/graph/cli.ts reindex /absolute/physical/path/wiki
npx tsx server/graph/cli.ts diagnose /absolute/physical/path/wiki
npx tsx server/graph/cli.ts cleanup /absolute/physical/path/wiki
```

The seed describes the completed local stub session exercised in `wiki-runtime.test.ts`
(`a`, `source-thread`, `source-run`); it is a test dataset. For your own data, explicitly
set the namespace and replace the source with an actual completed session's Bot/thread/run.
The CLI trusts the administrator's attestation; it cannot verify another service's session DB.
Shared publication requires an explicit `project_shared` namespace in this local manifest.
Private sources must match the namespace Bot. v1 accepts exactly one session source per
page; document and multi-source publication await a provenance contract update.

Frontmatter requires `id/title/type/sources/tags/related/created/updated`; types are
`concept/entity/note/index`. IDs are safe slugs; timestamps are ISO UTC strings. YAML
aliases/custom tags/unknown fields are rejected. Links `[[slug|alias]]` and `related`
are confined to the same namespace; missing targets remain non-searchable edges.
Each import requires `expectedRevision: null` for a new page or its current revision UUID
for an update, and prints the new revision UUIDs. Duplicate slugs in one import fail;
the same slug in different namespaces is allowed. Immutable Markdown plus the SQLite
committed manifest are authoritative; FTS and edges are rebuildable with `reindex`.
Schema version 1 rejects unknown future versions; back up before migrations.

Search uses English words and CJK bigrams, eight lexical seed paragraphs and at most
three outgoing links per seed, with lexical coverage ranking, hub penalties and stable
tie breaks. Unrelated neighbors cannot qualify on their edge alone. Query output is
bounded to 50 records/64 KiB and 16 KiB per paragraph; the existing assembler enforces
20 records and 4096 UTF-8 JSON bytes. Timeout/abort checks discard late results;
SQLite operations are synchronous and cooperate between bounded operations, so this
is not a hard real-time deadline. Limit each page to 128 paragraphs.

Use a physical data-root path (resolve macOS temporary-directory aliases with `realpath`); symlinks
in its ancestors, revision paths and import paths are rejected. Keep this directory
administrator-owned. Files and directories use 0600/0700 on creation. Stop Runtime
and import processes before backing up the entire directory (SQLite and Markdown);
restore them together and run `reindex`. Startup/`cleanup` removes orphan revision files
under a SQLite writer lock; retained published revisions remain available for recovery.
Filesystem rename and SQLite are separate resources: files are validated, synced and
renamed before the SQLite transaction publishes pointers/indexes. Failed transactions
can leave orphan files, which are invisible to readers. No deletion/revocation API is
introduced in Part 1; disabling a Bot's runtime memory or graph feature stops injection.

### Graph Memory Part 2：外部文件編譯

在 Part 1 的 Wiki provider 上新增 Markdown／純文字匯入、durable queue 與獨立 LLM compiler。
Runtime 的 `graph` 設定和啟動方式不變；compiler 透過可信本地管理 CLI 執行，無新增公開 HTTP 上傳路由。
只有具有本機資料目錄與部署設定讀寫權限的管理員使用此 CLI；這沿用 Part 1 的 OS 管理員信任邊界，
並非提供未驗證使用者自行指定 namespace 的 API。先部署支援下述 v2 bridge 的 Hermes，再啟用文件記憶。

建立伺服器管理設定 `wiki-ingest.json`（不要讓上傳者修改此檔）：

```json
{
  "namespace": {
    "principal": "local-owner", "projectId": "alpha",
    "visibility": "bot_private", "botId": "researcher"
  },
  "compiler": {
    "baseUrl": "https://openrouter.ai/api/v1", "model": "your-approved-model",
    "keyEnv": "WIKI_COMPILER_API_KEY", "timeoutMs": 30000, "maxTokens": 4096
  }
}
```

API key 只放指定的 secret env；模型、URL 和 budget 放 JSON。也支援其他 OpenAI-compatible base URL
（不含 `/chat/completions`）。每次 request timeout 預設 30 秒、輸出上限 4096 tokens，
最多 120 秒／8192 tokens；整個 job 另有 120 秒期限。測試注入 mock，不需付費 API。
`namespace` 必須與 Runtime 的 principal/project/bot 配置一致；shared 需要管理員明確指定
`project_shared`。預設使用上例的 private；compiler 僅讀寫該 namespace，shared compiler 不讀 private。

上傳 JSON `document.json`：

```json
{
  "title": "Database decision", "mime": "text/markdown",
  "content": "Project Alpha 使用 PostgreSQL。", "idempotencyKey": "database-import-001"
}
```

不接受路徑、ACL、URL、任意 MIME。內容最多 1 MiB UTF-8，僅 `text/plain`／`text/markdown`，
禁止 NUL；PDF／HTML 解析未實作。更新既有來源時加入 status 回傳的 `sourceId`，並換新的
`idempotencyKey`。Source ID、內容 SHA-256、整數版本與 request key 分開保存；相同內容／標題
在同一 namespace 重送會回原 job，不增加 revision。不同內容重用同一 key 會拒絕。

於 `examples/copilotkit` 執行（`DATA_ROOT` 與 Runtime `graph.dataRoot` 相同）：

```bash
node --import tsx server/graph/ingest-cli.ts DATA_ROOT wiki-ingest.json enqueue document.json
node --import tsx server/graph/ingest-cli.ts DATA_ROOT wiki-ingest.json status JOB_ID
node --import tsx server/graph/ingest-cli.ts DATA_ROOT wiki-ingest.json work
node --import tsx server/graph/ingest-cli.ts DATA_ROOT wiki-ingest.json cancel JOB_ID
node --import tsx server/graph/ingest-cli.ts DATA_ROOT wiki-ingest.json retry JOB_ID
node --import tsx server/graph/ingest-cli.ts DATA_ROOT wiki-ingest.json delete SOURCE_ID
node --import tsx server/graph/ingest-cli.ts DATA_ROOT wiki-ingest.json rebuild
```

`enqueue` 的 accepted 只代表已持久化。`work` 每次處理一個到期 job，可重複呼叫直至
`processedJobId: null`；無常駐 worker／自動 session observer。狀態為 pending/running/completed/failed/cancelled。
Job lease 30 秒、每 5 秒 heartbeat，崩潰後 lease 到期可重取；舊 worker token 不能發布。
最多三次 attempt，失敗後 backoff 為 2 秒乘 2 的 attempt 次方，第三次進 failed（dead-letter）。
`retry` 可人工重試 failed/cancelled；SIGINT／SIGTERM 取消目前 job。取消與撤銷會使進行中的發布失效。
`status` 僅回 ID、版本、狀態、attempt 與一般錯誤代碼，不輸出原始內容、LLM response 或 secrets。

Compiler 分 analysis → generation → merge：每 12000 字元做 evidence digest，最多 96 claims，
每次 generation 最多八個頁面；候選 context 最多八頁，不掃描整庫到 prompt。
JSON／引用索引／逐字 evidence quote／slug／頁面與段落大小均驗證後才發布。
支援 entity/concept/decision/finding/procedure/preference/task，並由程式生成 source 摘錄頁。
頁面保留 type、title、tags、related、多來源 references、時間和 verification；revision ID 保存在 SQLite manifest。
Merge 只能選擇帶來源的新增主張，既有正文和 provenance 保留，矛盾標為 disputed；事實與推測分別標記。
空結果可 no-op。這是保守的追加式 merge，沒有語意去重或自動裁定何者為真；LLM 的語意判斷仍需管理員審閱。
所有來源與既有 Wiki 均作為不可信資料；LLM 不取得 filesystem、ACL 或命令執行權限。

SQLite 在既有儲存 layout v1 上增設 document_sources／ingest_jobs／ingest_keys，不重寫 Part 1 revisions。
原始 source 每版本 immutable，撤銷另標 deleted；檔案 revision 仍先驗證及 fsync/rename，
再以單一 SQLite transaction 發布 active pointers、FTS、edges 和 completed job。
跨檔案系統與 SQLite 不具天然交易原子性；孤立檔案沿用 `cleanup`，未提交版本不提供檢索。
資料目錄仍應只有可信管理員可寫，拒絕 symlink／path traversal。

單一 session 仍產生 MemoryContext v1；文件或多來源頁使用 v2，完整傳送 document ID、版本、hash、title
及所有 session/document references，不捏造 thread/run ID。新版 Hermes 同時驗證 v1/v2、HMAC、run binding、
private sources 和既有大小限制。舊 Hermes 會拒絕 v2；不做有損降級。
Graph `write()` 仍 disabled，沒有提前加入 Part 3 自動 session 學習、embedding 或 hybrid retrieval。

刪除是來源撤銷，立即取消相關 jobs，將所有包含該來源的衍生頁從 active manifest／FTS／edges 撤下。
混合來源頁整頁撤下，避免殘留已撤銷主張；其他獨立來源頁保留。
`rebuild` 在該 namespace 撤下文件衍生頁並重新排入未撤銷來源的全部版本，之後執行 `work` 逐筆編譯。
歷史 revisions／raw sources 仍供稽核，這不是實體抹除 API；不會因 reindex 恢復已撤下頁面。
備份／恢復須停止 Runtime 和 CLI worker，整個 DATA_ROOT（SQLite、journals 和 Markdown）一起處理。
恢復後未完成 job 可於 lease 到期重取；降回舊版本前必須恢復升級前的完整備份，因舊 reader 不認識文件 provenance。

### Graph Memory Part 3：自動學習與 hybrid retrieval

先完成前述 Part 2 安裝、Hermes signing key 配置及 DATA_ROOT 備份。沿用 Node 22.13+、
現有 example dependencies；本階段無新依賴、不改 Hermes agent loop。管理模式下不同 owner 在同一
project 必須使用不同 principal，避免部署端把兩個 owner 配成同一個知識 namespace。

在 `AGUI_BOTS_CONFIG` 的既有 `graph` 加入下列設定；API secrets 只放在所指的環境變數：

```json
{
  "graph": {
    "enabled": true,
    "dataRoot": "./data/wiki",
    "timeoutMs": 2000,
    "retrieval": { "rrfK": 60, "seedLimit": 8, "neighbors": 3 },
    "embedding": {
      "baseUrl": "https://approved-provider.example/v1",
      "model": "your-approved-embedding-model",
      "dimension": 1536,
      "version": "deployment-1",
      "keyEnv": "WIKI_EMBEDDING_KEY",
      "timeoutMs": 500,
      "retries": 1
    },
    "evolution": {
      "enabled": true,
      "pollMs": 1000,
      "compiler": {
        "baseUrl": "https://approved-provider.example/v1",
        "model": "your-approved-compiler-model",
        "keyEnv": "WIKI_COMPILER_KEY",
        "timeoutMs": 30000,
        "maxTokens": 4096
      }
    }
  }
}
```

保留原本 `bots`、`management`、`delegation` 設定，以上僅示範 graph 區塊。
依原流程啟動 Hermes Host，然後在 example 目錄執行 `npm run dev`；部署版執行
`npm ci && npm run build && npm start`。先升級支援 Part 2 v2 bridge 的 Hermes，再啟動此 Runtime。

一般 Run 只監聽真實 `next.run(prepared)` 的事件；delegation 使用同一 ingestion service。
完整且成功的本輪原始 user／assistant 文字會先同步 durable enqueue，LLM 編譯由背景 worker 處理。
不擷取 reasoning、tools、完整歷史、Runtime 注入 context；第一版 tool allowlist 為空。
低品質／閒聊、常見明文 credential 模式會整筆跳過。這是保守規則，不能保證偵測所有敏感資料。
User 明確確認的 decision 與 assistant 未驗證的 finding 分別保留標記，LLM 不能將其升為 verified。
預設皆 private；重複 Run、相同 user/answer 的重複知識不再建立學習工作。

Resume 因現有介面無法可靠取得完整本輪原始內容而跳過，增加 `resumeSkipped` counter；
interrupt/error/cancel/disconnect 不入列。完成事件與 SQLite enqueue 前崩潰仍可能漏記，沒有
completion journal／reconciliation API，因此不宣稱 exactly-once；入列後沿用 lease/fencing/retry 的恢復契約。

Embedding 的 model/dimension/version 全部構成索引身份。背景批次每 namespace 最多 32 sections，
查詢在已授權 private/shared namespaces 各最多掃描 4096 個有效向量；模型故障、維度或版本不符時回退
keyword + graph。Embedding 查詢最多等待 750ms；外部 adapter 的單次 timeout 最大 1000ms。
第一版適用有限規模，不是大型向量資料庫。RRF 合併 keyword/vector seeds 後只展開一階鄰居，
保留 provenance、片段去重及原有 runtime budget。無 embedding 設定時沿用 keyword 路徑。

沿用可信本地 OS 管理 CLI，沒有新增公開 HTTP endpoint 或管理 UI。`SERVER_CONFIG` 與 Part 2 相同，
含 server-owned `namespace`、選配 `compiler`；若需向量重建，可額外加入上例 `embedding`。
從 example 目錄操作：

```bash
node --import tsx server/graph/ingest-cli.ts DATA_ROOT SERVER_CONFIG enqueue UPLOAD_JSON
node --import tsx server/graph/ingest-cli.ts DATA_ROOT SERVER_CONFIG jobs
node --import tsx server/graph/ingest-cli.ts DATA_ROOT SERVER_CONFIG status JOB_ID
node --import tsx server/graph/ingest-cli.ts DATA_ROOT SERVER_CONFIG share SESSION_SOURCE_ID
node --import tsx server/graph/ingest-cli.ts DATA_ROOT SERVER_CONFIG revoke SOURCE_ID
node --import tsx server/graph/ingest-cli.ts DATA_ROOT SERVER_CONFIG health
node --import tsx server/graph/ingest-cli.ts DATA_ROOT SERVER_CONFIG reindex
node --import tsx server/graph/ingest-cli.ts DATA_ROOT SERVER_CONFIG vectors
```

`jobs` 列出該 namespace 最近 50 個工作（含 source ID，不含 lease token 或原文）；`status` 回傳 source ID；`share` 的 config namespace 必須是該來源的 private scope。
分享只重編譯原始來源，不複製混有其他私有來源的 wiki 頁；重新檢查敏感資料並保留真實 session provenance。
Shared compilation 不讀 private context。`revoke` 連同同 owner/project 的 session 分享副本一起撤銷；
`delete` 保留 Part 2 僅撤銷指定 namespace/source 的語意。混合來源頁保守地整頁撤下，後續可 rebuild。
`vectors` 清除該 namespace 各模型索引後重建全部批次；失敗時回傳 `partial`，可重跑或由 Runtime 續建。
模型更換時同步更換 model/dimension/version 並執行此命令；`reindex` 修復 FTS/edges 並使舊 vectors 失效，
背景 worker 隨後重建。`health` 回報 broken links、孤立頁、衝突、過期/無法追溯 provenance、索引漂移及 job lag/error，
不自動刪除知識。Runtime 每分鐘只輸出 operational counters（latency、hits、job lag/states、compiler token usage），不輸出全文或憑證。

Bot 刪除、project/principal 改變或部署端 policy/owner-access 撤銷，會在生命週期回呼、啟動、查詢前及
worker tick 檢查來源所有權；取消工作、撤下衍生頁、FTS/edges/vectors。停用 Bot 暫停其 private worker，
保留有效知識，刪除才永久撤銷。ACL 設定仍由部署端負責，沒有新增瀏覽器修改 project/owner 的 API。
Part 2 歷史來源以 namespace metadata 和已發布 provenance 回填 owner；若歸屬有歧義，拒絕再編譯，
需管理員確認後以新 source 重新匯入，避免錯認作者。

SQLite schema 為 additive migration；immutable Markdown 與原始來源保留稽核，撤銷不代表實體抹除。
備份/還原仍需停止 Runtime/CLI workers，整個 DATA_ROOT 一起備份；還原後 lease 到期續跑。
停用 `evolution.enabled` 可停止自動收集/worker，仍可檢索已發布知識；移除 `embedding` 回退 keyword。
`graph.enabled: false` 關閉整個 graph，保留原生 Hermes memory/skills/session 行為。
程式版本 rollback 使用升級前完整備份，避免舊版忽略新增 ownership/revocation 契約。

不需要付費 API 的雙 Bot smoke 與固定中英文 evaluation：

```bash
npm test -- --reporter=dot
node --import tsx tests/fixtures/wiki-evaluate.ts
# 位於 repository root，使用已由 Hermes PM 建立的 test interpreter：
HERMES_PYTHON=/path/to/test/python scripts/run_tests.sh tests/hermes_agui/
```

`wiki-evolution-runtime.test.ts` 同時驗證 standard/delegation、A 新 thread、B 分享前後、C 跨 project 與撤銷；
`test_graph_evolution.py` 驗證真實 Runtime → Hermes → fake model → 自動 queue/compiler → 新 Hermes thread，
並檢查原生 SQLite 無注入 context。Evaluation 使用明確標示的 deterministic synonym fixture encoder，
可重現 RRF/graph 的效果與噪音；數值不代表真實 embedding 模型品質或 production latency/cost。
實際測試紀錄與限制見 `docs/graph-memory-part-3.md`。

### Multi-Bot Workspace (Frontend Part 1)

Workspace 提供 Chat、Bot Manager 與 Graph Memory Explorer。桌面側欄按 Bot 顯示
本頁的 thread 索引；行動版使用「工作空間導覽」展開。切換頁面、Bot 或 thread 保持既有
CopilotKit/AG-UI 元件掛載，串流與 HITL 可返回繼續；重新整理沒有 server history 恢復功能。

在本機使用既有 Node 22.13+ 與 package-lock：

```bash
cd examples/copilotkit
npm ci
# Static mode：先依前述方式啟動 Hermes AG-UI，沿用 AGUI_URL / AGUI_API_KEY。
npm run dev
# Production assets：
npm run build
npm start
```

Runtime 預設只監聽 loopback。請維持 localhost host/origin 限制，不以此範例直接公開部署。
Managed mode 的 server JSON 沿用以下配置形狀；Host 必須有相同的核准 native template ID，
並由管理員在後端配置 provider/model key，瀏覽器不輸入 Host token 或模型 API key：

```json
{
  "bots": [],
  "management": {
    "registryPath": "./data/bots.sqlite3",
    "hostUrl": "http://127.0.0.1:8765",
    "hostTokenEnv": "BOT_HOST_MANAGEMENT_KEY",
    "users": [{ "ownerId": "owner", "principal": "owner", "projectId": "local", "tokenEnv": "BOT_OWNER_ACCESS_KEY" }],
    "templates": [{ "id": "analyst", "name": "Approved analyst", "harness": "hermes", "provider": "custom", "model": "your-approved-model", "skills": [], "toolsets": ["memory", "skills"] }]
  }
}
```

將 `AGUI_BOTS_CONFIG` 指向此管理員持有的 JSON，秘密僅放上述 secret env，再啟動 Runtime。
使用管理員配置的 owner 存取金鑰登入，session cookie 為 HttpOnly；登出會撤銷 server session
並清除 Bot/thread/form 狀態。不將 credential 存入 localStorage。Static mode 隱藏管理寫入。
建立／編輯只使用 server options；失敗的 Bot 可啟用／重試，只有 active 可開啟對話。
停用保留有效知識；刪除前必須確認，會永久撤銷相關衍生記憶與分享副本，歷史稽核資料仍保留。
Graph API 與 Wiki/Search/Dashboard 已完成；匯入／分享／撤銷仍使用可信 CLI。前期交接見
[Frontend Part 1](../../docs/frontend-workspace-part-1.md)。

### Frontend Workspace Part 2: read-only Graph Browser API

Managed deployments expose `GET /api/graph/:botId/...`, using the existing Bearer/session login,
local Host/Origin guards, Bot ownership, server runtime principal/project and graph deployment
policy. Every response is JSON with `Cache-Control: no-store`. Static mode exposes no graph data.
Active and disabled Bots retain read access while their owner and deployment policy remain valid;
deleted Bots cannot read. No endpoint writes, imports, shares, revokes or invokes an LLM/encoder.
The existing evolution reconciliation may withdraw revoked memory before a read.

Shared frontend DTOs are in `server/graph/browser-types.ts`. The Part 3 explorer uses these read-only routes.
All endpoints accept `scope=all|bot_private|project_shared` (default `all`):

| GET suffix | Parameters and response |
| --- | --- |
| `stats` | `{pages, edges, private, shared, partial}`; active validated pages, edges with visible endpoints only |
| `pages` | `limit` (default 100, 1–300), `cursor`, `type`, `verification`, `q`; `{pages, nextCursor, partial}` |
| `pages/:visibility/:pageId` | Active revision only: summary, `revisionId`, `tags`, untrusted `body`, visible `related`, scoped `provenance` |
| `search` | Required `q`, optional list filters/pagination; summaries with snippets of at most 320 Unicode characters, using existing FTS terms/CJK bigrams |
| `network` | List filters/pagination; optional paired `pageId`/`visibility` focus and `depth=1|2` (default 1); `{nodes, edges, nextCursor, truncated}` |
| `health` | `{status:"ok", pages, brokenLinks, isolated, conflicts, staleProvenance, indexDrift, pending, failed, lagMs, partial}` |
| `jobs` | `limit` (at most 50); `{status:"ok", jobs:[{id,state,createdAt?}]}`; no raw source, errors or lease information |

Summary fields: `{id,pageId,title,type,visibility,verification}`; missing stored verification is
`unverified`. IDs are `visibility:pageId`, local to the selected Bot, preserving same-slug private
and shared pages. Network edges are directed namespace-local SQLite edges; endpoints must both be
returned nodes. Focus walks incoming/outgoing links within one namespace; it never expands through
an unauthorized page. Filters apply to returned nodes. Pagination covers bounded result windows;
edges between nodes in different windows are intentionally omitted. There are no typed or cross
namespace relations. Focus traversal has a 301-candidate neighborhood cap; `truncated` remains true
when that cap is reached, even after paging through the bounded neighborhood. Related pages in details are bounded to the store's validated links.

Queries reject unknown/duplicate parameters, malformed IDs/cursors, invalid enums and limits with
400; `q` is at most 512 characters/2048 UTF-8 bytes. Cursors bind Bot/owner/principal/project,
endpoint, scope and every filter (including limit); they are pagination hints, never authorization.
They use stable `visibility:pageId` keyset ordering. Each request reauthorizes and reads current
publication pointers; paging across requests is a live view and does not pin old revisions.
Unauthenticated requests return 401, foreign/missing/deleted Bots and inaccessible pages share 404,
foreign Origin returns 403, non-GET requests return 405 with `Allow: GET`. Static mode, disabled or
unavailable graph, work/response budget exhaustion return 503; graph unavailable/disabled responses
have a typed `status`. Health/jobs return 503 `status:"unavailable"` when evolution is disabled.

Each response uses the existing WikiStore connection with a bounded SQLite transaction, serializing
against publication and revocation; there is no second writing store. Markdown must pass the existing
active/read checksum and schema checks. All source owners must still be retained, including mixed
pages and project-shared sources. With evolution off these checks remain enabled; document provenance
must match a non-revoked source version/hash, and tracked sessions must have a live source. Missing
source tables deny document evidence. Legacy session-only imports retain the existing trusted local
administrator attestation contract; no native session database lookup is introduced.

Work limits: at most 300 candidate pages per window, 650 Markdown parses (including focus/related),
8 MiB parsed-page work, 2 MiB response JSON, 300 nodes and 1500 edges. Over-budget requests fail closed
with 503. List `partial`/`nextCursor` and network `truncated` describe bounded windows. Stats and health
scan only the first 300 scoped candidates; with `partial=true` numeric counts are lower bounds, not totals.
Health analyzes validated visible pages only (`staleProvenance=0` after evidence validation), measures
FTS section drift, and counts pending/failed jobs and lag in the most recent 50 retained-owner jobs
per selected namespace. Jobs without recorded enqueue time omit `createdAt`; lag excludes those jobs.
Health is partial when its job window is full. Broken-link and isolation counts are `null` when diagnostics are partial, since incomplete
neighborhoods cannot determine those counts. These bounded diagnostics do
not replace the existing full administrator `health` CLI. No database migration or dependency is added.

**Frontend rendering contract:** treat titles, snippets, Markdown, provenance titles and tags as
untrusted data. Render strings as text; disable raw HTML in Markdown, sanitize rendered output,
allowlist link protocols, and never execute embedded scripts, event handlers or external resource
loads. Do not convert filesystem paths or arbitrary Markdown links into API requests. Resolve Wiki
navigation only through returned scoped IDs. Clear private state and in-flight results when changing
identity/Bot/scope and after logout; do not cache private responses. The Part 3 explorer follows this contract (see operation guide below).

### Graph Memory Explorer（Frontend Part 3）

1. 先啟動具有核准 template 的 managed Hermes Host，依上方 Multi-Bot Workspace 設定
   `management`、owner 與 Host secret env，並設定 `AGUI_BOTS_CONFIG`。
2. 在相同 server JSON 加入前述 Graph Memory 的 `graph.enabled: true`、私有 `dataRoot`、
   `graph.evolution.enabled: true` 與 compiler 配置；沿用既有 runtime memory signing key 與
   principal/project 設定。不要將 DATA_ROOT 放進 frontend/dist 或任何公開靜態目錄。
   可先不設 embedding，使用既有 keyword/FTS；模型與 encoder secrets 只在 server env。
3. 執行 `npm ci`、`npm run dev`，或 `npm run build && npm start`。開啟
   `http://127.0.0.1:3000`，於 Bot Manager 登入並從核准模板建立 Bot。
4. 在 Chat 完成一次對話；啟用 evolution 後，既有 worker 會處理 durable job。
   開啟側欄 Graph Memory，選擇 Memory Bot 與 All / Bot Private / Shared。
   All 僅包含此 Bot private 與同 owner/project 授權 shared，不包含其他 Bot private。
5. Graph 可拖曳平移、拖曳節點、Zoom in/out、Fit graph、Degree size；選取節點或
   Wiki pages 清單按鈕查看 Markdown、verification、revision、tags、related 與 Provenance。
   Load neighbors 讀取同 scope 一層鄰居。手機使用 Wiki 清單；鍵盤可 Tab/Enter 操作。
6. Memory Search 使用既有 FTS 的 title/body/snippet，搭配 type、verification 與 visibility 篩選。
   Truncated 表示 bounded window；Load more 會以新頁替換舊頁，不累積 private cache。
   Wiki links 僅導向 API related 提供的同 namespace 授權頁；broken/unavailable 不猜測內容。
7. Memory Evolution Dashboard 顯示當前 stats、health 與最近 jobs，支援手動更新；僅在頁面
   可見時每 15 秒輪詢，錯誤以 30–120 秒退避。Partial counts 是下限，unknown 不是零。
   Evolution 關閉時 health/jobs 顯示 not available，pages/network/search 仍可使用。
   Graph 關閉或 store 不可用時顯示 disabled/unavailable；授權失敗清空已載入記憶。
8. 使用既有可信 CLI 刪除／撤銷來源後按 Refresh memory，會重新查詢有效 revision。
   切 Bot、scope、query 或登出會清除舊結果及取消請求；離開 Graph 停止 Dashboard 輪詢。

Markdown 不執行 raw HTML、不自動載入圖片、禁止 javascript/data URL；https/http 外連需手動點擊，
以新視窗與安全 rel 開啟。Unverified/disputed 以原 DTO 標示，不等於已核實事實。
沒有 graph 寫入、分享、撤銷、匯入或 reindex 按鈕，也不提供 raw session transcript。

驗證指令（模型均為 fixture，沒有付費 API）：

```bash
npm test -- --reporter=dot
npm run build
# 環境需有 Hermes PM test interpreter 與 Playwright Chromium 或本機 Chrome。
npm run test:e2e
GRAPH_MEMORY_TEST=1 npm run test:e2e -- tests/browser/memory-explorer.spec.ts
DYNAMIC_BOT_TEST=1 npm run test:e2e -- tests/browser/bot-management.spec.ts
MULTI_BOT_TEST=1 npm run test:e2e -- tests/browser/multi-bot.spec.ts
# repository root
scripts/run_tests.sh tests/hermes_agui
```

Graph browser fixture 使用真實 Application、BotAuthentication、WikiStore、SQLite、HTTP API、
原生 Hermes fake-model Host 與 mock compiler；慢回應／分頁／權限錯誤另用明確標示的 route mock。
這不代表已驗證真實外部 provider 的 compiler 品質、embedding 效能或大型知識庫 SLA。
完整結果、限制與 rollback 見 [Part 3 完成報告](../../docs/frontend-workspace-part-3.md)。

### Graph Memory V2 write pipeline (Part 1)

`graph.evolution.graphCompilerVersion` accepts `"v1"` (default) or `"v2"`.
The trusted ingestion CLI config accepts the same `graphCompilerVersion` key at its root.
V2 preserves the existing queue, lease fencing, immutable Wiki revisions, namespace ACLs,
PostgreSQL and GCS object adapters. Apply Runtime migration `009_graph_memory_v2.sql`
and the updated grants with your normal administrator rollout **before** starting this version;
the application never runs PostgreSQL DDL. No production migration or deployment is part of acceptance.

Use a fresh namespace for V2 acceptance. The first successful publication pins a namespace's
compiler version; changing the flag does not silently recompile already completed V1 jobs.
Changing a namespace's compiler version requires an explicit administrator migration/rebuild plan.
Disabling evolution stops ingestion/compilation; it does not erase immutable historical records.

Subjects retain permanent IDs independently of their Wiki Page IDs. An evidenced component can
share its parent's Wiki page with a stable section key. New identities get minimal profile sections;
events and mutable state use separate fact edges. A known subject receiving only an event produces
no unnecessary Wiki revision. Event time never falls back to ingestion time. Host completion delivery
persists the original Run creation timestamp in `referenceTime`; legacy completion records remain
valid and leave relative dates unresolved. Trusted internal callers can provide `{instant,timezone}`;
source text cannot select namespace, credentials or tools.

Full source-level edge and attribute evidence is stored independently of the bounded 20-source
Wiki frontmatter window. Revocation synchronously invalidates source evidence and clears affected
edge vectors. A mixed-source Wiki is safely withdrawn and surviving-source jobs are queued to rebuild
it; their evidence and immutable Wiki history remain stored. Rebuild can temporarily remove that Wiki
from V1 search. V2 Runtime retrieval, temporal latest views, embedding indexing and browser UI are
Part 2 and are intentionally not enabled here. Part 1 storage lookups are available to acceptance tests.
