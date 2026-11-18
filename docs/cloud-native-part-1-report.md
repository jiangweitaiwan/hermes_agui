# Cloud-native Part 1 實作與驗收報告

**狀態：部分完成，第一階段上線閘門尚未通過。** 起始 commit 為
`b433a7873a5250e925bb0c3e2bf17cdca4a49d2f`。變更留在工作樹，保留既有 docs 刪除及兩份
Cloud Native 計畫。現有部署繼續使用 SQLite / filesystem。
資料 ownership、現有 schema 與耦合見 [儲存盤點](cloud-native-inventory.md)。

## 已實作

| 檔案 | 行為 |
| --- | --- |
| `hermes_agui/storage/objects.py` | 不可變 object create 與限量、指定 generation 的 read。GCS 使用 ADC、generation-match 預條件與 timeout。Filesystem 以獨占硬連結發布已寫完的資料。 |
| `hermes_agui/storage/profile.py` | `ProfileObjects.stage/hydrate` 以 project、principal、Bot 隔離 object namespace。manifest 記錄 generation、SHA-256 與 size。預設包含 SOUL、MEMORY、USER 與完整 native state.db。技能與 workspace 檔案需逐一列入 server allowlist。拒絕 dotfiles、非正規檔案、symlink、hardlink、路徑逃逸與超額資料。 |
| `hermes_agui/core/factory.py`、`core/service.py` | `session_home_identity` 支援搬遷後保留原生 session ID 輸入。舊資料可用原始絕對 home 字串，本地 caller 沿用原有 mapping。 |
| `hermes_agui/storage/migrations/001_host.sql`、`runs.py` | Host schema `hermes_agui_host` v1、Bot scope 主鍵、thread 查詢索引、run/lease 記錄。`PostgresRunStore.begin/get/renew/finish/profile` 接收有界 psycopg pool，使用資料庫時鐘、row lock 和單調 fence。過期 run 在下次 admission 標記 interrupted。終止與可選 profile CAS 一起 commit。 |
| `tests/hermes_agui/test_profile_objects.py`、`postgres_storage_probe.py` | Fake LLM 原生續聊、檔案復原、不可變儲存、scope 和竄改測試。另有真 PostgreSQL 競態、lease takeover、舊 writer、重送與 CAS probe。 |

### Native SQLite 過渡契約

以 SQLite backup API 建立獨立快照，保留原生 schema 與 transcript。呼叫端需關閉原生 service
與所有寫入者，在獨占的新私有目錄 hydration，再以部署模板與 secret 注入重建 config.yaml
及憑證。原生資料庫以外的 sidecars 與插件狀態需逐項驗證。工具不會自動辨識對話、記憶或
允許檔案裡的秘密。

快照整份上傳，每個 profile 共 64 MiB、最多 256 個清單項目。上傳到 SQL commit 之間失敗
可能遺留未發布物件，舊 manifest 繼續可讀。hydration 失敗時呼叫端需丟棄暫存目錄。
未引用物件的 retention/GC 待實作。正式 Host 寫入邊界、工具完成 checkpoint 與 terminal
event 的持久化等待仍需接線，因此服務崩潰時尚無跨 instance 保證。後續 PG session backend
需逐項驗證原生 resume、branch、compression、工具結果、查詢及清理行為。

## 第一階段剩餘交付

- Runtime Bot registry、durable Host 動態 provisioning、憑證參照及雙 registry operation reconciliation。
- Graph PostgreSQL metadata、繁中搜尋索引、Graph job 及 immutable GCS source/wiki publication。現有 golden fixture 驗證本機搜尋行為。
- 完整資料遷移與對帳，以及清空兩服務容器可寫層後，驗證動態 Bot、原生記憶／技能、續聊及 Graph 檢索。
- 整體 local/gcp 設定範例與服務角色 grants。真 GCS generation/IAM 依計畫列為 Part 2 實雲驗收。

## 可重複執行的驗收命令

本地服務沿用 [AG-UI 部署](agui-deployment.md) 與 [CopilotKit 操作方式](../examples/copilotkit/README.md)。
使用 Hermes PM test interpreter 與 Node 22.18。

```bash
scripts/run_tests.sh tests/hermes_agui
scripts/run_tests.sh tests/hermes_agui/test_profile_objects.py
cd examples/copilotkit
npm test -- --reporter=dot
npm run build
npm run test:e2e
GRAPH_MEMORY_TEST=1 npm run test:e2e -- tests/browser/memory-explorer.spec.ts
DYNAMIC_BOT_TEST=1 npm run test:e2e -- tests/browser/bot-management.spec.ts
MULTI_BOT_TEST=1 npm run test:e2e -- tests/browser/multi-bot.spec.ts
node --import tsx tests/fixtures/wiki-evaluate.ts
```

以 migration owner 連往全新的 UTF-8 測試 DB，依序執行 001 和 002。Probe 從
`HERMES_AGUI_TEST_DATABASE_URL` 取得同一資料庫的連線字串，需在裝有
`psycopg[binary,pool]` 的獨立 Python 環境執行。Probe 會插入 fixture rows，重跑請使用新的
測試資料庫，完成後刪除測試 DB 或測試容器。

```bash
psql -X -v ON_ERROR_STOP=1 -f hermes_agui/storage/migrations/001_host.sql
psql -X -v ON_ERROR_STOP=1 -f hermes_agui/storage/migrations/002_run_outbox.sql
psql -X -v ON_ERROR_STOP=1 -f hermes_agui/storage/migrations/003_completion_evidence.sql
python -m tests.hermes_agui.postgres_storage_probe
```

`GCSObjects.from_adc(bucket_name)` 使用 google-cloud-storage 與 ADC。

## 驗收結果

| 驗收項目 | 實際結果 |
| --- | --- |
| 起始 sandbox 基線 | Vitest 83 passed、16 failed，均為 loopback listen EPERM。Python runner 的 22 個檔案在執行測試前遇到 sandbox PermissionError。兩套皆重跑並保留下列結果。 |
| PostgreSQL adapter | 18.6 真實伺服器搭配 psycopg 3.3.9，migration、同 Bot 競態、跨 scope 並行、過期接管、拒絕舊 writer、重送、終止、profile CAS 與注入 SQL 寫入失敗後的交易 rollback 全數通過。Docker Desktop 的容器啟動卡住，改用一次性本機 Unix socket。測後已停止 PostgreSQL 並移除暫存 cluster。 |
| 既有 Hermes AG-UI | 22 files、82 passed、0 failed，Docker integration 未在預設模式執行。包含 dynamic Host/Runtime、delegation、原生 session、壓縮與 Graph evolution。 |
| CopilotKit Vitest | 15 files、99 passed、0 failed。 |
| Native profile 快照 | 1 file、3 passed、0 failed。刪除原 home 後在另一個路徑建立原生 service，使用同 Thread 和 Session ID 續聊。搬遷前由原生 memory 工具寫入，還原後由原生 skill_view 讀取技能。另驗證錯誤 scope、checksum、symlink 與重複寫入。 |
| CopilotKit build | TypeScript 與 Vite build 通過。Vite 回報既有 bundle 大小警告。 |
| Playwright 預設模式 | 6 passed、4 skipped，跳過的情境需要指定 managed、graph 或 multi-Bot 模式。 |
| Playwright 指定模式 | Graph Explorer 3 passed，managed Bot 2 passed，多 Bot 1 passed。已執行預設模式跳過的四項。 |
| 現有 Graph retrieval fixture | `wiki-evaluate.ts` 成功，recall@3 為 keyword 0.50、hybrid 約 0.92、hybrid + graph 1.00。使用 deterministic fixture encoder 與現有 SQLite。 |
| 靜態檢查 | 變更的 Python 檔案通過 Ruff。工作樹通過 `git diff --check`。 |

快照測試首輪發現非法清單項目前可能已上傳其他檔案。修正為先驗證所有清單路徑再上傳，
重跑後三項通過。

## 後續接線：靜態 Hermes Host

以 `e9408177d4d23adfca1a3d4bc780350da87c4b84` 為起點，新增 Host 的 opt-in PostgreSQL／GCS
執行路徑。既有本機入口維持原設定。雲端 Host 每次 run 查詢已 provision 的 scope，
以 DB 時鐘更新 bot-wide lease，在私有暫存目錄還原 manifest 並建立原生 service。
成功 run 關閉 service 後才擷取 SQLite 快照與允許清單內的檔案。SQL 在同一交易驗證 fence、
比對舊 manifest、發布新 revision 並標記完成。終止事件會等待該交易。中斷與失敗會保留上次
已發布的快照；目前的 checkpoint 是 turn 完成邊界，工具執行後至提交前的 crash window 仍存在。
背景記憶回顧及模型產生標題升級在此路徑關閉，以免 service 關閉後仍寫入待擷取的目錄。

### 受信任的靜態 Host 測試設定

測試前先以獨立 migration identity 依序套用 `hermes_agui/storage/migrations/001_host.sql`
、`hermes_agui/storage/migrations/002_run_outbox.sql` 與
`hermes_agui/storage/migrations/003_completion_evidence.sql`。
Host interpreter 需可匯入 `psycopg`、`psycopg_pool` 與 `google.cloud.storage`。在有 ADC
及測試 DB 的環境設定 `AGUI_STORAGE_BACKEND=gcp`、`AGUI_HOST_DATABASE_URL` 和
`AGUI_GCS_BUCKET`。以既有 `--bots-config` 入口啟動，Bot 的 `home` 為受信任的設定模板，
`cwd` 為既有目錄。實際執行的 home/workspace 會在私有 scratch 目錄建立。

```yaml
max_active_runs: 1
storage:
  project: staging-project
  prefix: profiles
  approved_files:
    analyst:
      - skills/analyst/SKILL.md
bots:
  - id: analyst
    token_env: ANALYST_AGUI_TOKEN
    agent:
      home: ./analyst-template
      cwd: ./analyst-template-workspace
      principal: alice
      enabled_toolsets: [memory, skills]
      api_key_env: ANALYST_MODEL_KEY
```

首次上線前必須建立同 scope 的 `bot_state`。既有 Bot 可先停止所有 profile writer，從一致性
備份執行下列 dry-run。確認檔案清單、大小和 SHA-256，再用相同值移除 `--dry-run` 提交。
若移植既有 session，在 Host 設定的 `agent.session_home_identity` 填入相同的原始 identity。
`--approve` 的檔案須與 Host 設定一致。匯入會拒絕目標 scope 已存在的情況，並在發布前
從物件儲存讀回檔案驗證 generation、size 與 SHA-256。

```bash
python -m hermes_agui.storage.import_profile \
  --source /path/to/consistent-backup \
  --project staging-project --principal alice --bot analyst \
  --session-home-identity /original/agent/home \
  --approve skills/analyst/SKILL.md --dry-run
```

本次只接線受信任的靜態 Host，限制為明確配置的 memory／skills toolsets。每個 run 由獨立
子程序執行，父程序等待子程序成功退出後才開始快照。取消時終止子程序並保留上一份已提交快照。
Host 依 DB lease 將同 Bot 的 run 序列化，不同 Bot 受設定的 Host 容量限制。隔離路徑目前沒有
互動式 HITL 通道。暫存 workspace 的 system prompt 使用穩定的說明與相對路徑，實際檔案仍
透過原生 workspace resolver 操作。

Schema v2 在完成 run、發布 profile manifest 的同一筆交易保存 Host completion outbox。
Outbox 的資料包含可信 scope、run ID 和對應的 profile manifest，支援過期接管、重試及 fenced
acknowledgement。Graph compiler 增加依授權 namespace 與 job ID 執行既有 compiler 的入口。
該入口使用 Graph 的 SQLite queue。Host outbox 的後續接線見本文「Host outbox 交付 Graph ingestion」。

在靜態 Host 與 outbox 完成後，第一階段整體驗收仍未通過。當時動態 provisioning、delegation、Runtime registry 與 thread mapping、
Graph Memory PostgreSQL／GCS adapter、完整資料遷移與對帳仍待補齊。真實 GCS、Container writable
layer 清除後的雙服務復原及資料隔離尚未驗證。

| 此輪驗收 | 結果 |
| --- | --- |
| `scripts/run_tests.sh tests/hermes_agui/test_profile_objects.py` | 4 項通過。新增案例用原生隔離子程序、fake LLM、filesystem object adapter 與 RunStore 測試替身，在不同暫存目錄續聊。兩次 system prompt 完全相同，兩個暫存目錄均已清理。 |
| PostgreSQL storage probe | 真 PostgreSQL 18.6 UTF-8 通過 schema v1/v2、同 Bot 競爭、跨 scope、過期接管、終止/快照/outbox 交易回滾、重試及 fenced acknowledgement。 |
| CopilotKit Vitest | 15 檔、100 項通過。包含指定 job 執行、跨 scope 拒絕及重送不重複發布。 |
| CopilotKit build | TypeScript 和 Vite 通過。Vite 回報既有的 chunk 大小警告。 |
| Agent prompt 回歸 | 3 檔、38 項通過，涵蓋 cwd 解析、原生 system prompt 復原與 identity 切換。 |
| Python AG-UI 回歸 | 第一輪 81 項通過、5 項跳過。提供 Node 22 後，第二輪 85 項通過、1 項 Runtime 重啟案例發生 socket timeout。以單 worker 重跑該檔後，3 項均通過。 |
| Graph retrieval fixture | SQLite 查詢的 recall@3 為 keyword 0.50、hybrid 約 0.92、hybrid + graph 1.00。 |
| Playwright 本機 | 預設模式 6 項通過、4 項條件跳過。分別啟用 Graph、動態 Bot 與多 Bot 後，通過 3、2、1 項，已覆蓋預設模式跳過的案例。 |
| 單一 profile 匯入 | 本機 dry-run 通過。實際 GCS 匯入未執行。 |

## Runtime thread mapping

Runtime 可透過 `server/storage/thread-mappings.ts` 將互動式 run 的瀏覽器 thread ID 對應至
Host thread ID。PostgreSQL 記錄以 (project, principal, bot, browser thread) 為主鍵，
並限制同 scope 內 Host thread ID 唯一。Runtime 在既有 Bot 授權後查詢對應，以經驗證的
Bot owner 與 project 設定決定 scope。靜態 Bot 必須設定受信任的 per-Bot `threadScope`（`principal` 與 `projectId`），
也可沿用同一 Bot 的 memory scope。應用程式首次遇到既有 thread 時，會保留原始 Host thread ID。
若資料庫已有對應，轉發給 Host 的 run 與記憶簽章會使用該 Host ID，瀏覽器事件則使用原 ID。
PostgreSQL 不可用時，該 run 會回傳錯誤，Host 不會收到請求。

以 Runtime schema 管理角色手動套用
`examples/copilotkit/server/storage/migrations/001_threads.sql`。應用程式角色需要 schema
`USAGE` 與 `thread_mappings` 的 `SELECT`、`INSERT`，以及資料庫連線權限。使用部署設定檔
中的 `"storage": { "threadMappings": "postgres" }` 啟用，從秘密環境變數
`AGUI_RUNTIME_DATABASE_URL` 提供應用程式角色的連線字串。啟動時會檢查資料表，連線池上限是
四條。測試請對一次性資料庫套用同一份 migration，在 `examples/copilotkit` 用
`HERMES_AGUI_TEST_RUNTIME_DATABASE_URL` 指定測試庫，再執行 `npm test`。

此路徑會在使用既有 thread 時逐步建立對應。完整的歷史匯入與對帳、前端 thread 清單恢復、
Runtime Bot registry、動態 Host provisioning 和 Graph Memory 持久化仍待完成。
委派 mapping 與 outbox 接線見後續章節。

本輪使用一次性 PostgreSQL 18.6 UTF-8 實例套用 Runtime migration。CopilotKit Vitest
16 檔、101 項通過。新增整合測試經過 Runtime 的 AG-UI 路徑和本機 HTTP 測試 Host，涵蓋
並行寫入、project／principal／Bot 隔離、Runtime 實例重建、既有 thread ID 相容、SSE ID
轉換及資料庫不可用時的拒絕行為。受限 sandbox 的初次回歸遇到 loopback `listen EPERM`，
在允許本機 loopback 後全套通過。此測試重建 Runtime 實例，雙服務容器的 writable layer
清除與原生 session 全流程復原仍待驗收。

TypeScript 與 Vite production build 通過。Vite 仍回報既有的 chunk 大小警告。


## 委派 thread mapping

當 Runtime 同時配置 PostgreSQL thread mappings 與 delegation 時，請在
`001_threads.sql` 後套用 `examples/copilotkit/server/storage/migrations/002_delegations.sql`。
Runtime 應用程式角色須對新資料表有 `SELECT`、`INSERT` 權限。啟動會檢查該表。

Runtime 先驗證來源 Bot 憑證、方向 ACL 與 Host 上的 parent run，再用受信任的來源
project／principal／Bot scope 及 parent thread、run、tool call 建立唯一對應。資料表保存
目標 Bot、子 thread／run、delegation ID 和請求指紋。委派指令和回應內容不寫入此表。
同一 Runtime 仍會回傳已快取的結果。另一 Runtime 收到同一筆請求時，回傳 `busy`
與原本的 ID，避免重複送出子 run；若改變目標或指令，則回傳 `invalid_request`。
失去原執行者或在提交對應後中斷時，對應仍會阻止重送。此版本未儲存委派結果或實作接管，
因此無法判定原執行者是否已提交結果。PostgreSQL 不可用時，Runtime 拒絕派出子 run。

真 PostgreSQL 與本機 HTTP Host 替身驗證了並行去重、重建後 ID 穩定與 scope 隔離。
該輪測試時，durable Hermes Host 尚未支援服務端 delegation 設定。後續接線與驗收結果見下節。

本輪完整 CopilotKit Vitest 在 PostgreSQL 18.6 上執行，16 檔、102 項通過，包含委派對應表
migration、兩實例競爭及資料庫不可用時未派送子 run 的案例。
TypeScript 與 Vite production build 通過，仍有既有的 chunk 大小警告。

## Durable Hermes Host 委派與本機復原

靜態 durable Host 可使用原有 `delegation` 設定。Host 驗證既有的委派憑證，並把本次
run 的可信 Bot、thread、run 和深度交給隔離子程序。子程序在暫存 profile 的 scope
註冊既有 `message_bot` 工具，沿用原本的 HTTP 契約。Runtime 授權後依 PostgreSQL
對應派送子 run。停止父 run 時，Host 終止子程序並關閉其委派 HTTP 連線，Runtime
會走既有的斷線取消流程。子 run 仍受 target Bot 的 lease 及 Host 容量限制。
委派即使成功，父 run 日後失敗也不會回滾子 run 已經提交的副作用。

`tests/hermes_agui/test_delegation.py::test_durable_host_delegates_and_redelivers_graph_completion`
使用真 PostgreSQL 18.6、Node Runtime、Hermes Host、原生隔離 worker、fake LLM 與
filesystem object adapter。測試從 Runtime API 觸發父 run，檢查父子 run 已完成、
拒絕偽造委派標記與第二層委派，刪除測試的 Host profile、workspace、scratch、Runtime
設定檔和 log，重新建立兩個服務後，以同一 thread 續話並由 fake LLM 驗證原始歷史。
首次採用較短的委派測試逾時，子 worker 尚未完成啟動便被取消。調整 fixture 時限後，
從 Runtime API 進行的聚焦測試無需重試即通過。

重跑時對本機一次性 PostgreSQL 套用 Host 和 Runtime migration，設定
`HERMES_AGUI_TEST_DB_SOCKET` 為該 PostgreSQL 的 Unix socket 目錄。測試使用
`hermes` role 與 `postgres` database，runner 只傳遞 socket 路徑。
執行 `scripts/run_tests.sh tests/hermes_agui/test_delegation.py -k test_durable_host`。

這次是本機服務重建測試。Docker daemon 在此工作環境未連線，且 Graph Memory 仍使用
SQLite，因此尚無刪除兩個容器可寫層後恢復 Graph 的驗收結果。動態 Bot provisioning、
Runtime Bot registry、Graph Memory PostgreSQL／GCS、完整資料遷移
及對帳仍待實作。

同一測試庫執行委派、委派 bridge 與 profile snapshot 三個測試檔。關閉自動重試，
11 項通過，無失敗或跳過。

## Host outbox 交付 Graph ingestion

Host migration `003_completion_evidence.sql` 將 evidence generation 加到既有 outbox。啟用後，
Host 擷取成功回合的使用者訊息與最終助理回答，排除工具 payload、理由、超額內容及符合現有
憑證偵測模式的文字。Evidence 以不可變物件儲存在同一個 profile prefix 與 revision 下，
PostgreSQL 只記錄 generation，並與 profile CAS 和 run 終止狀態同一交易提交。既有無 evidence
的 outbox 可確認為無內容；歷史回合回填屬於遷移工作。物件 retention 須保留待交付 revision，
孤立物件清理仍待實作。

Runtime 使用內部 listener 的 `POST /internal/graph/completions`，驗證獨立 Bearer token 與
Bot 授權 scope，沿用 SessionIngestor 的敏感文字政策、分類、provenance 與去重。Graph
queue 交易完成後回應 204，Host 才確認交付。逾時或失敗會留在 outbox 依退避重送，SQL
可查嘗試次數與下次排程。Runtime 目前的確認以 SQLite Graph queue 為持久化邊界，
測試重建程序時保留該 store，因此清空 Runtime 可寫層的 Graph 復原須待後端遷移。

### 啟用方式

1. 套用 Host SQL migration 001 至 003，配置既有靜態 Bot、對應的 Runtime Memory 簽章金鑰
   及一致的 project／principal。Host YAML 設定 `storage.graph_completions: true`。
2. Runtime 啟用既有 `graph.evolution`，設定 `storage.graphCompletions: true`，以
   `internal.listenPort`／`internal.listenHost` 配置接收端。缺省沿用 delegation 的 listener
   設定，其後備值為 `127.0.0.1:3001`。啟用此模式的 Runtime 統一以 outbox 接收已完成回合。
3. Dispatcher 與 Runtime 以秘密注入相同的 `AGUI_GRAPH_COMPLETION_TOKEN`（至少 32 個
   可見 ASCII 字元），Dispatcher 另需 `AGUI_HOST_DATABASE_URL`、`AGUI_GCS_BUCKET`、
   GCS ADC 讀取身分及 `AGUI_GRAPH_COMPLETION_URL`。地址使用 HTTPS 或本機 loopback HTTP，
   路徑為 `/internal/graph/completions`。DB 身分需要 Host schema 使用權與 outbox
   SELECT／UPDATE 權限。

```sh
python -m hermes_agui.storage.completion_delivery --prefix profiles
```

`--prefix` 使用與 Host 相同的值。可加 `--once` 只領取一次。

### 本輪驗收結果

| 測試 | 結果 |
| --- | --- |
| Python 委派、委派 bridge 與 profile snapshot | 3 檔、11 項通過。沿用兩服務測試，使用真 PostgreSQL 18.6 和 filesystem object adapter。驗證拒絕未授權與跨 principal 的交付、Runtime 重啟後接管未確認事件、單一 Graph job、同 thread 續聊。 |
| PostgreSQL storage probe | 通過 Host schema 001–003、同 Bot 競爭、過期接管、profile CAS、scope 隔離及終止／outbox 的交易回滾。 |
| Runtime Vitest | 16 檔、103 項通過。涵蓋 Graph 交易寫入失敗後重送、已發布 revision 的冪等性，以及撤銷後重送無法重新發布。 |
| TypeScript、Vite、Ruff、git diff check | 通過。Vite 回報既有 chunk 大小警告。 |

## Runtime Bot registry 的 PostgreSQL 儲存

Runtime migration `003_bot_registry.sql` 保存 Bot ID、owner／project／principal、template ID、
Bot 設定、委派 ACL、生命週期狀態和時間。Runtime 以 PostgreSQL advisory lock 序列化管理寫入，
包含配額檢查及有逾時的 Host HTTP 呼叫。狀態轉換各自提交。Runtime 以最新的 DB 資料進行
管理寫入，並在管理查詢、互動式 run、Graph Browser 和內部委派入口重新讀取 registry。
載入時重新比對可信部署身分與模板。身分或模板遺失時，Bot 無法派送 run。既有
Bot 管理和啟動 reconcile API 沿用原有契約。

以 `storage.botRegistry: "postgres"` 啟用，搭配既有 `management` 和
`AGUI_RUNTIME_DATABASE_URL`。套用 Runtime migration 001 至 003，Runtime DB 身分需要
`hermes_agui_runtime` schema 使用權及 `bot_registry` SELECT／INSERT／UPDATE。設定所有
Runtime replica 共用同一個由 32 個隨機位元組編碼成 64 字元十六進位的
`AGUI_BOT_CREDENTIAL_SEED`，並透過秘密注入。原生 Bot 依 scope 與 Bot ID 派生
Host token 和 memory key，remote Bot 的服務端設定由可信部署模板提供。
Registry 本身只存 Bot 資料及 scope。重啟和 replica 使用同一 seed，任意更換 seed
會改變已註冊的憑證。舊 SQLite 原生 Bot 的隨機憑證轉移仍待遷移工具處理。

此模式可使用現有本機 Host 管理 API。Host 的 PostgreSQL provisioning registry、
跨服務 operation ID 和 durable profile 的動態掛載仍待補上。
Graph Browser 入口可使用此 registry。Graph evolution 啟動時需要一致的 Bot 授權視圖，
因此暫不與 PostgreSQL Bot registry 一起啟用。瀏覽器 cookie 登入仍由各 Runtime 程序管理。

本輪使用一次性 PostgreSQL 18.6 與既有 Bot Manager 的 Host 測試替身。驗證兩實例競爭時
全域配額仍生效、資料表只有公開 Bot metadata 與 scope、另一實例讀到停用狀態後撤除路由、
principal 改變時拒絕啟用，及重建後使用相同 Bot ID 和憑證。

可對一次性 PostgreSQL 套用 Runtime migrations，設定
`HERMES_AGUI_TEST_RUNTIME_DATABASE_URL` 後在 `examples/copilotkit` 執行 `npm test`。
跨語言整合則透過 `HERMES_AGUI_TEST_DB_SOCKET` 指向測試專用 Unix socket，再執行
`scripts/run_tests.sh tests/hermes_agui/test_dynamic_runtime.py`。同一 fixture 跑 SQLite 與
PostgreSQL，監看動態建立、原生委派、停用、重啟 Runtime 後同一 thread 續聊及軟刪除。
PostgreSQL 案例檢查 Runtime 沒有建立 registry SQLite 檔。Hermes Host 在此測試沿用其
本機 registry 和 profile。

最終 Runtime 回歸在 PostgreSQL 18.6 通過 16 檔、105 項。真 Hermes Host 搭配 fake LLM
的跨語言整合兩種模式皆通過，共 2 項，無跳過。TypeScript、Vite production build、
Ruff 與 `git diff --check` 通過。Vite 仍回報既有 chunk 大小警告。

## 靜態 Host 首次快照初始化

在 `ab24d4adac6c39b7d3074c2d90fad49388775533` 的基礎上補齊首次回合的模板初始化。
當 scope 尚無已發布 manifest，Host 取得 lease 後，會把可信部署模板的 `SOUL.md` 與
`storage.approved_files` 核准的技能檔複製到私有執行目錄。後續回合使用已發布版本。
既有 profile 的資料匯入仍使用 `import_profile`，以保存原生資料庫與原始 session identity。

沿用 `tests/hermes_agui/test_profile_objects.py` 的隔離 worker 和 fake LLM。
測試刪除原 profile 後用同一 thread 續聊，確認原始對話、system prompt 與原生技能可用。
此測試檔共 4 項通過。Ruff 與 `git diff --check` 通過。
真 PostgreSQL storage probe 通過。使用同一座一次性資料庫重跑
`scripts/run_tests.sh tests/hermes_agui/test_delegation.py tests/hermes_agui/test_dynamic_runtime.py`，
4 項通過，涵蓋靜態 durable Host 與 PostgreSQL Runtime registry。動態 Runtime 情境仍使用本機 Host registry。

第一階段整體驗收仍有待完成。Host 動態 provisioning registry、Graph PostgreSQL/GCS
與耐久 job、完整遷移與對帳仍有缺口。Docker daemon 未連線，本次未執行雙服務容器重建。

## 動態 Host PostgreSQL registry 與 Bot 匯入

將 Host migration 001–004 依序套用至 Host DB，Runtime 套用其既有 001–003。
Host DB 應用程式角色須能讀寫 `hermes_agui_host.managed_bots`，以及依既有 lease/profile 路徑
讀寫 `bot_state`。Host 的 `management` 與 `storage` 可同時配置，並由秘密環境變數注入
與 Runtime 相同的 `AGUI_BOT_CREDENTIAL_SEED`。此模式以 Host 的單一 `storage.project`
作為管理範圍。同一 Host 內可有多位 owner，Runtime 管理身分的 project 必須與 Host 相符。

Host 只在 PostgreSQL 保存 Bot scope、模板、能力、生命週期和 revision。Runtime 與 Host 使用
同一組 HMAC 派生 Bot bearer 與 memory key。每次解析 Bot 會讀取權威狀態，durable run
取得 lease 時再核對 revision。更新／停用會在同一 scope 的 profile row 上與 run admission
互斥。相同規格的重送會維持原 revision，刪除會保留 tombstone。Runtime 已有的啟動 reconcile
可以重送相同規格。目前仍缺以跨服務 operation ID 追蹤及對帳延遲寫入的協定。
managed 模板技能由 deployment 重建，Bot 自己的記憶與其他核准檔案使用原有快照機制。
動態 Host 以管理規格生成 `SOUL.md`。若舊 profile 有手動自訂 persona，切換前須對照 Bot 設定。

### 離線匯入既有 Bot

先停止兩服務的相關 writer，留存 SQLite 一致性備份及各 Bot 的 profile 備份。
先在隔離 DB/bucket 驗證。從已知 Runtime owner/project 對照 Host registry，確認 Bot ID、
principal 和模板一致。對每個 native Bot 使用既有匯入命令新增的參數：

```sh
python -m hermes_agui.storage.import_profile \
  --source /backup/managed/bot-id/home \
  --project staging --principal alice --bot bot-id \
  --session-home-identity /original/managed/bot-id/home \
  --managed-registry /backup/managed/registry.sqlite3 --owner-id alice-owner \
  --dry-run
```

加入需保存的個別 `--approve` 路徑。模板供應的技能由目標模板重建。
移除 `--dry-run` 會使用 Host DB 和 GCS 設定，驗證不可變物件後一併發布 profile 與 registry。
同 scope 已存在時停止，需先用原本的匯入輸出對帳，避免覆蓋線上寫入。

接著在 `examples/copilotkit` 執行 Runtime registry 的 metadata 匯入：

```sh
node --import tsx server/storage/import-bot-registry.ts \
  --source /backup/runtime-registry.sqlite3 --config /deploy/bots.json --dry-run
```

確認 scope、數量與 SHA-256 後移除 `--dry-run`，以 `AGUI_RUNTIME_DATABASE_URL` 寫入目標。
匯入會驗證授權身分、模板、能力、委派目標及寫入對帳，相同資料可重跑，遇到衝突會回滾。
舊版隨機憑證留在離線來源備份，切換後由 Host 與 Runtime 共同派生新憑證。
尚未提供 Graph 備份匯入、歷史 thread 完整盤點、兩服務的全量對帳，或雙服務容器重建的整體驗收。

| 本輪驗收 | 結果 |
| --- | --- |
| PostgreSQL storage probe 與 Python 聚焦整合 | PASS。4 檔、12 項通過。雙 Host 副本讀取相同 registry，遠端停用後舊 revision 無法取得 lease，移除 managed root 後同 thread 續聊。首輪發現未啟用 Graph 的 Host 仍寫入空 outbox，已改由 `graph_completions` 控制並重跑通過。 |
| Runtime Vitest、TypeScript 及 Vite | PASS。16 檔、105 項測試通過。Vite 有既有 chunk 大小警告。 |
| Runtime 匯入 | PASS。一次性 PostgreSQL 的 dry-run、寫入與重跑回報相同數量及 checksum。 |
| Managed Host 匯入 | PASS。使用真 PostgreSQL 與 filesystem object adapter，驗證 manifest、原始 session identity、憑證欄位排除及重複匯入拒絕。 |
| 整體重建與 GCS | NOT RUN。Docker daemon 未連線。Graph PostgreSQL/GCS adapter 與跨實例 job 尚未完成。 |

第一階段整體驗收仍未通過。
