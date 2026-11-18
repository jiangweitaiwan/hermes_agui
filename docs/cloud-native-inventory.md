# Cloud-native Part 1 儲存盤點

> 最新狀態（2026-11-18）：依 owner 指示停止測試；Part 1／Part 2 前置尚未通過。詳本文末段最新紀錄。

起始 commit `b433a7873a5250e925bb0c3e2bf17cdca4a49d2f`。工作樹已有七項 docs 刪除及兩份未追蹤 Cloud Native 計畫。過往 Graph Memory 與 Frontend Workspace 報告從 HEAD 讀取。Runtime Memory 與 Bot Manager 報告從歷史 commit `00b72ae` 讀取。既有部署與協定見 `docs/agui-deployment.md`、`agui-server.md`、`agui-native-capabilities.md` 與 example README。

| Owner | 入口與目前 schema | 一致性、隔離、遷移注意事項 |
| --- | --- | --- |
| Runtime Bot Manager | `server/bots/registry.ts` 的 `BotRegistry` 同步讀寫 `bots(id,value)`，JSON 涵蓋 record/runtime/spec | `BotManager.owned` 以經驗證 owner/project 授權。程序內 Promise queue 序列化；Host HTTP ack 和 SQLite commit 分開。既有 token 和 memoryKey 位於 JSON，搬遷前須拆成 secret reference。新增 PostgreSQL registry 保存 Bot metadata、ACL 及可信 principal，使用 DB advisory lock 序列化生命週期寫入，憑證由部署模板或秘密 seed 重建。 |
| Runtime 登入、路由、thread | `bots/auth.ts` 的 Cookie session map，`BotManager.publish` 的 bots/allow map，`frontend/BotThreads.tsx` 的 UI thread 索引 | 重啟須重新登入。UI 索引只在當前頁面；後端續聊依 caller 傳入相同 thread ID。新增的 PostgreSQL thread mapping 儲存互動式 run 的 scoped ID 對應，並保留原有 Host ID。委派在另一張 scoped 表保留 parent call 與 child thread/run 對應，防止多 Runtime 重複派送。選用 PostgreSQL Bot registry 時，管理查詢、互動式 run、委派及 Graph Browser 入口會重新讀取 registry，Graph evolution 的跨實例授權仍待接線。 |
| Host Bot 管理 | `HostManagement` 的 `registry.sqlite3`，`bots(id,spec,status)` 與 `installed(id,spec)` | `_save` 在同交易記錄 active 和 installed。記憶體 specs/installed 於啟動讀入。現有 spec 含秘密。restore 需要既有 profile，故 registry 單獨存活不足以重建。 |
| Host profile、工具與 workspace | `HermesBotProvisioner.prepare`、`_initialize`、`_install_skills` 使用每 Bot 的 home/workspace、config.yaml、SOUL、skills 和 archived managed skills | config 由部署模板產生。原生 memory 工具更新 `memories/MEMORY.md` 與 `memories/USER.md`。受信任模板與受配額限制的 profile 清單須分開。不能備份整個 home 或任意 workspace。 |
| Hermes native session | `HermesAgentService._run` 經 `hermes_state_registry.acquire` 打開 `state.db`。`hermes_state_schema.py` 及 siblings 擁有 messages、sessions、FTS、lineage 與 lease | 原生 admission 持鎖載入 transcript，包含分支、壓縮及工具結果。SQLite WAL、連線 registry、inode guards、lease/repair 與 SQLite schema 強耦合。過渡走 SQLite backup API。 `SessionManager.native_id` 將絕對 home 路徑與 principal 納入 hash，搬遷需保存既有 identity 輸入，並驗證原生持久資料內的路徑參照。 |
| Host turn admission | `ReceiptStore.reserve` 在 profile SQLite 寫入有界 run receipts。 `AgentAdapter.active`、`ExecutionManager`、HITL、取消及 delegation parent 狀態存在程序 | 既有 receipt 只能防有限範圍重送。接入 fenced lease 時須涵蓋 Host 管理寫入與正常及 delegation runs，終止事件必須等待必要 checkpoint。跨 instance cancel 和 event replay 屬 Part 2。靜態 durable Host 現在於隔離 worker 註冊委派工具，worker 的 HTTP 連線中斷會通知 Runtime 取消子 run。 |
| Graph Memory | `WikiStore` 擁有 namespaces、revisions、pages、sections FTS5、embeddings、page_owners、edges；Markdown immutable 檔案。`DocumentIngestor` 擁有 document_sources、ingest_jobs、session_evidence、source_versions/owners、completion_times、session_knowledge/origins、ingest_keys | `WikiStore.transaction` 使用同步 `BEGIN IMMEDIATE`。browser、retriever、health、ingestion 直接依賴同步快照及 SQL。移植需保留 publication/revocation 原子性、CJK bigram 召回、active pointer、ACL、provenance 與向量 model/version/dimension。 |
| Graph worker | `MemoryEvolution` timer、`SessionIngestor` 及 delegation completion observer | SQLite 已有 lease/retry 和去重。靜態 durable 模式可由 Host 的 PostgreSQL outbox 交付已提交的回合，Runtime 透過同一個 SessionIngestor 去重入列。Graph job 和發布 metadata 仍由本機 SQLite 管理。 |

Hermes 以 profile ContextVar 綁定設定與 turn 資料，也會快取 agent、SessionDB 和工具註冊。工具可能啟動 subprocess，或留下跨 turn 的工作。每次在乾淨目錄 hydration 時，必須先證明程序與工具已停止寫入，再擷取 profile 與資料庫。工具副作用及 run 中途失敗的語意需獨立處理。

既有測試使用 `scripts/run_tests.sh tests/hermes_agui`、`examples/copilotkit` 下的 `npm test` 與 Playwright。首次 sandbox 執行 Node 基線已遇 loopback `listen EPERM`。允許 loopback 後，既有 Python AG-UI 82 項通過，Vitest 99 項通過。其餘實際結果見 [實作報告](cloud-native-part-1-report.md)。

## 收尾候選增量

基準 `7d74a8d9ba94559a6997424e98ad747f82a4c226`。Runtime migration 004 增加
`graph_namespaces`、`graph_revisions`、`graph_pages`、`graph_page_owners`、
`graph_edges`、`graph_sections`、`graph_embeddings`。PG Wiki 以 immutable object
持有 Markdown，SQL 持有 active pointer、generation、checksum、size 與衍生 token 索引。
以 UTF-8、C collation 的 page ID 和相同繁中 token 陣列維持排序與召回。PG 頁面介面與本機
adapter 共用 retriever、encoder 及向量計分。

Runtime 應用仍以 SQLite 處理來源、provenance、撤銷、Graph browser、health、evolution
和 queue。現行 PG registry 加 evolution 的 fail-fast 閘門仍有效。只有可信管理員 Wiki
manifest 入口可選用 PG/GCS。舊資料與匯入工具保留，歷史搬遷 scope 待 owner 核准。


## 2026-11-18 工作樹增量（驗收尚未完成）

基準 `ae7d7ae51eca59c49a79ef47f7d086fb23f0798a`。舊章節是歷史狀態；最新完整矩陣見 Part 1 report 的停止紀錄。

| Owner／元件 | 本輪增加的儲存及契約 |
| --- | --- |
| Runtime Graph source | Migration 005：`graph_sources`（逐版本 object key/generation/hash/size/bot/deleted）、`graph_source_owners`、`graph_session_origins`（provenance/classification/evidence）、`graph_revision_provenance`。source 原文與 wiki revision 在外部 immutable object；SQL metadata/索引由 Runtime 擁有。 |
| Runtime Graph queue | Migration 006：`graph_jobs`、`graph_ingest_keys`、`graph_session_knowledge`。completion time 在 job.created；每次 claim 唯一 token，DB clock lease，最多三次自動 attempt，與 wiki publication 同交易完成。 |
| Runtime desired state | Migration 007：`bot_registry.desired_revision` 與 `bot_operations`；spec 不含 token/memoryKey。意圖與 operation 同交易，HTTP 不包在長 SQL transaction；舊 ACK 以 desired revision CAS 隔離。 |
| Host applied state | Host migration 005：`managed_bots.applied_revision/applied_operation/applied_spec_hash`、`management_operations`。沿用既有 admission UUID/fence、profile manifest 與 outbox；不讀寫 Runtime schema。 |
| Local compatibility | 原 WikiStore／SQLite queue 保留；Browser/API 透過 typed await 邊界。local Host 另存 versioned operations，既有 legacy 路徑仍可用；PG Runtime 對 local Host 的 versioned 操作需同一秘密 seed。 |
| Composition／caller | `application-config.ts`、`graph/access.ts` 分離配置與權威讀寫檢查；`bootstrap.ts` 共用 Runtime/一次性 worker。背景 reconciliation 只處理本部署 principal/project。 |
| Build／test | `agui-cloud` extra + `uv.lock`；Host/Runtime Dockerfiles；不同 PG roles、外部 object volume 與雙容器可寫層清除 scenario。真 GCS、完整 restart 與最後回歸仍未全過。 |

不把原生 Hermes SQLite DB 改寫成 PostgreSQL；只沿用已核准的 backup/immutable revision 過渡方案。
未引用物件保留，尚無自動 GC。Graph／thread 的完整 preserve-existing 遷移仍缺；fresh scope 未獲 owner 明確核准。
