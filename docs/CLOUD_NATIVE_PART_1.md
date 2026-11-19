# Hermes AG-UI Cloud-native 改造計畫 — Part 1

> Cloud-native Agent Core：外部持久化、可重建 Hermes Host、Graph Memory 儲存遷移
>
> Repository: https://github.com/jiangweitaiwan/hermes_agui.git
> 執行者：Codex；Part 1 合併驗收後才進入 Part 2。

## 1. 任務與範圍

將目前可運作的多 Bot Hermes AG-UI + CopilotKit Runtime 專案改造成可使用 PostgreSQL 與 Google Cloud Storage（GCS）的核心系統。保留 SQLite / filesystem 本機模式、既有 AG-UI 協定、前端 API、Bot Manager、Graph Memory 檢索及演化行為。不要重新實作 Hermes agent loop、prompt assembly、wiki compiler 或前端。不要部署正式 Cloud Run，不引入 Firebase 或 Cloud Tasks SDK 至核心業務層。Part 2 負責雲端執行環境。

成功定義：在 PostgreSQL 與 object storage 持續存在的情況下，刪除 Runtime 和 Hermes 的容器及其可寫層、重建後，原 Bot 可繼續對話、讀取歷史、使用原生記憶與技能、檢索 Graph Memory；不承諾中斷中的 Run 無縫繼續。

## 2. 開始前：盤點而非猜測

1. 記錄 git commit、工作樹、既有 docs、安裝及測試命令；不要覆蓋使用者未提交的變更。
2. 閱讀既有改造計畫與完成報告、AG-UI contract、runtime memory、graph memory、workspace、delegation 文件。以下路徑是定位起點，以實際 HEAD 為準：`hermes_agui/host.py`、`provisioner.py`、host management/session/run 相關模組；`examples/copilotkit/server/index.ts`、`application.ts`、`bots/`、`graph/`（含 provider、evolution）、delegation 模組、前端及現有測試。
3. 用 rg 盤點 Python sqlite3/state.db/原生 session API、TypeScript SQLite/FTS、檔案 I/O、環境變數與全域 cwd/HERMES_HOME、背景 timer、in-memory map、subprocess/container、session ID 映射、run/cancel/interrupt、工具與產物。記錄每個狀態的 owner、讀寫位置、一致性、隔離與遷移方式。
4. 新增 `docs/cloud-native-inventory.md`：真實檔案與 symbol、儲存 schema、無法安全抽象的耦合、現有測試基線、待解風險。先跑現有主要 regression suite 一次；已知失敗記錄，不自行跳過。

## 3. 架構決策與資料 ownership

| 資料 | Cloud authority | 所屬服務 |
|---|---|---|
| Runtime Bot registry、ACL、principal/thread mapping | PostgreSQL | Runtime |
| Host Bot provision registry、template reference | PostgreSQL | Hermes |
| Session transcript、原生 session metadata | PostgreSQL（見原生相容性閘門） | Hermes；Runtime 只用明確介面讀取所需內容 |
| Profile、SOUL、MEMORY、USER、原生 skills、允許持久化的 workspace | GCS immutable revisions；SQL manifest/version | Hermes |
| Wiki source/page revisions | GCS immutable objects；SQL active revision | Graph layer |
| Graph node/edge/source metadata、搜尋索引 | PostgreSQL | Graph layer |
| Run metadata、lease、job、outbox | PostgreSQL | 各自 owner，透過契約協作 |
| Secret | 環境注入/secret reference | 各服務；禁止明文寫入 log、物件與一般 registry |
| 暫存工具檔、agent object/cache | ephemeral scratch directory（由平台解析）或 process | Hermes |

使用同一 PostgreSQL instance 的獨立 schema/role（邏輯 ownership），不用跨服務直接修改對方的資料表。若現有雙 registry 有一致性問題，保留現有 API，以 provisioning operation ID、狀態機與補償/reconcile 修復，不把 GCS/SQL/HTTP 假裝成單一 ACID transaction。Bot ID 必須搭配經驗證的 tenant/owner/project scope；沿用現有 ACL 語意，不信任客戶端 scope。

## 4. 工作包（同一階段，按依賴實作）

### 4.1 Storage contracts 與設定

在現有 I/O 邊界抽出最小且可測試的 repository/interface；名稱以既有慣例為準，以下是示意：BotRegistry、SessionStore、ProfileStore、GraphStore、ObjectStore、RunStore、LeaseStore、JobStore/JobDispatcher。Python 與 TS 分別定義 typed contract，而非建立通吃所有資料的 CRUD interface。TS PostgreSQL 路徑使用 async I/O，將 await 傳遞至呼叫端；保留原有 API response/schema。

設定採明確 local/gcp 模式（建議 `STORAGE_BACKEND=local|gcp`，若已有設定 loader 則整合），DATABASE_URL/分服務 DB URL、GCS bucket/prefix、暫存根目錄等。用 ADC 存取 GCS，禁止 service account key 檔入庫；缺少必要設定時 fail fast，不默默退回 local。DB pool 有界，migration 使用明確命令，不在每個 instance 任意改 schema；新增 `.env.example` 不含 secret。

### 4.2 PostgreSQL 與 migration

保留 SQLite adapter，新增 PostgreSQL adapter。定義 migration、FK/unique/index、transaction isolation、UTC timestamp、stable ID、pagination 與 JSON 序列化。Graph FTS5 改用 PG FTS，明確處理繁體中文：不能假設英文 tokenizer 能保留中文召回；用既有中文 fixture 評估，必要時採用明確斷詞或 trigram/其他可支援的索引。Embedding 選配保持開關，若支援 pgvector，固定 model/dimension、距離定義及重建機制，不混用不同模型向量；無需強制每環境啟用。

提供離線、可 dry-run、可重跑的 migration CLI：來源 SQLite/檔案先備份並停止 writer 或取得一致性快照；保持 bot/thread/session ID、timestamps、ACL、graph provenance 與 revision；報告 counts、checksum、orphans、失敗項。目標非空時明確拒絕或安全 resume，不默默覆寫。遷移後執行對帳，切換前保留原始資料；不宣稱自動反向遷移。

### 4.3 GCS ProfileStore 與 Hermes 可重建化

保持原生 Hermes home layout，依現有 agent factory/host lifecycle 做 lazy hydration。在每次 run 開始時查權威 registry、取得 bot-wide lease（第一版序列化同 Bot runs；不同 Bot 可並行）、讀取 profile manifest/version，下載白名單檔案至獨立暫存目錄，再初始化 agent。不可依賴先前 instance 的 agent object。Cache 如有必須綁定 revision 且可丟棄。

檔案寫入採不可變 object/revision + checksum，再由 SQL transaction 比對舊 revision 與有效 fencing token 後發布新 manifest；讀者只使用已發布 revision。GCS generation precondition 防止非預期覆寫。失敗留下未發布 object 可回收，不破壞已發布版本。對原生 memory/skill 寫入設 checkpoint 或工具完成邊界的同步，run terminal event 之前確認必要 persistence，不能只靠 SIGTERM 或 finally。明確記錄 crash 時未提交操作的恢復語意；禁止宣稱 exactly-once 工具副作用。

驗證 path traversal、symlink、archive expansion、大小限制；不持久化 token、credentials、暫存鎖、任意 dotfiles。workspace 持久化使用允許清單/配額；不同 Bot 隔離。盤點原生 Hermes 全域設定與 cwd/env，若不能保證併發隔離，使用每 Bot/Run subprocess 或限制程序內併發，不以 Python 全域環境切換模擬安全隔離。

**原生 session 相容性閘門：**優先在真正的 Hermes session backend 邊界改用 PostgreSQL，保留 session resume、tool call/result、branch、壓縮與原生查詢語意，禁止只把 user/assistant text 複製到另一張表便宣稱完成。若實際原生依賴太深，允許提出明確的過渡 adapter：在 bot-wide fenced lease 下，hydrate 原生 SQLite 至本地，使用 SQLite backup API 產生一致性快照並持久化為 immutable GCS revision；不得把 live SQLite/WAL 放在 GCS FUSE/NFS。此方案必須在變更文件中明列差異、crash window、效能及後續 PG 遷移責任，若不能保證跨 instance 正常續聊則停止並報告，不得標為完成。

### 4.4 Graph Memory migration

保持 wiki compiler、retrieval policy、namespace/ACL、context injection、Graph Browser API、revision/provenance。只重構 storage、索引與 job 邊界。原始文件、wiki markdown 使用 immutable GCS object；PG 存 metadata、active revision、edges、FTS、vector（若啟用）。先寫 object，SQL transaction 發布 revision 與相關 graph/index；失敗可重試，孤立 object 有保留及清理策略。避免全文索引與 revision 指向不同版本；graph 查詢須始終帶 ACL scope。針對現有 Graph Memory golden fixtures 比較結果及 context 注入，容許合理排序差異但不得跨 scope 洩漏。

### 4.5 Run/lease/job 核心契約（Part 2 不重寫）

建立 durable RunRecord（runId、bot/thread scope、status、owner attempt、lease/fence、heartbeat、terminal reason、timestamps）；沿用既有 AG-UI runId，定義重複 request idempotency 與單一合法 terminal transition。lease 以 DB 時間、原子取得/續期、過期接管、單調 fencing token 實作，不使用 process mutex 代替；失去 lease 必須停止提交。第一階段支援正常完成/失敗、過期 run 標 interrupted、同 Bot 序列化；跨 instance cancel、event replay 和 HITL resume 在 Part 2。

新增 durable job/outbox，和適當的 run/graph transaction 一起 commit；job key 唯一，含 scope、run/source revision、type、status、attempt、next retry、lease/fencing。抽出 dispatcher 與 `processJob(jobId)`（名稱示意），本機仍用既有 timer 執行，gcp 模式 Part 2 接 Cloud Tasks。重複 job 不得重複發布 graph revision；確定失敗可見、可重試。不要在本階段引入 Redis、Firestore 或新 graph DB。

## 5. 測試策略：一次建立，共用到 Part 2

新增 `tests`/現有對應測試目錄內的共享 fixtures、contract suites 與 E2E scenario runner；沿用 repo 原有 Python/TS test framework。使用固定 fake LLM、真 PG container、object store emulator/contract double；GCS 真實 generation/權限語意若 emulator 不支援，標註為 Part 2 實雲 gate，不能以 mock 通過代替。避免重複建立測試 harness。

| Gate | 本階段驗收 |
|---|---|
| Legacy regression | 原有 AG-UI、dynamic bot、workspace、delegation、graph suites 無新增失敗 |
| Storage contracts | local 與 cloud adapter 同一組語意；migration dry-run/re-run/資料對帳 |
| Restart | 建 Bot→聊 A→更新 memory/skill→演化 graph→刪除應用容器 writable layer→重建→同 Bot/Thread 續聊 |
| Isolation | 兩個 owner、兩個 bot，profile/session/graph/API 不跨 scope；同 Bot 競態被拒絕或序列化 |
| Failure injection | object upload/DB commit 失敗、lease 過期、舊 writer、worker 重試、kill before terminal、重複 run/job |
| Retrieval | 中文 fixture、ACL、source provenance、embedding 開關、context injection |

測試用資料與 fixtures 可重用，Part 2 只新增分散式、真 IAM、Cloud Tasks、streaming 測試，再於最終 gate 跑完整 regression。編寫可重複執行的啟動/遷移/測試命令、清理測試資料；不要硬寫現有 repo 未確認的命令。

## 6. 交付與完成條件

- 可執行的 adapters、DB schema migrations、migration CLI、profile hydration、lazy host、graph migration、run/lease/job contracts。
- `docs/cloud-native-inventory.md`、`docs/cloud-native-part-1-report.md`、本機/PG/object storage setup、config example、共享測試及驗收輸出。
- 報告記錄 commit、實際變更檔案、測試命令與 pass/fail/skip、資料 ownership、schema version、Part 2 要沿用的介面及環境變數、尚未完成的限制。
- 不部署 GCP、不重寫 UI、不修改未相關的 upstream Hermes 功能、不提交密鑰。不得用 TODO/stub 宣稱驗收完成。
- Part 2 開始前，若 session adapter、持久化、隔離、restart 任一核心 gate 未通過，先修復或取得明確的 scope 決策。
