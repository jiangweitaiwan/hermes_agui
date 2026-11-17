# Cloud-native Part 1 儲存盤點

起始 commit `b433a7873a5250e925bb0c3e2bf17cdca4a49d2f`。工作樹已有七項 docs 刪除及兩份未追蹤 Cloud Native 計畫。過往 Graph Memory 與 Frontend Workspace 報告從 HEAD 讀取。Runtime Memory 與 Bot Manager 報告從歷史 commit `00b72ae` 讀取。既有部署與協定見 `docs/agui-deployment.md`、`agui-server.md`、`agui-native-capabilities.md` 與 example README。

| Owner | 入口與目前 schema | 一致性、隔離、遷移注意事項 |
| --- | --- | --- |
| Runtime Bot Manager | `server/bots/registry.ts` 的 `BotRegistry` 同步讀寫 `bots(id,value)`，JSON 涵蓋 record/runtime/spec | `BotManager.owned` 以經驗證 owner/project 授權。程序內 Promise queue 序列化；Host HTTP ack 和 SQLite commit 分開。既有 token 和 memoryKey 位於 JSON，搬遷前須拆成 secret reference。 |
| Runtime 登入、路由、thread | `bots/auth.ts` 的 Cookie session map，`BotManager.publish` 的 bots/allow map，`frontend/BotThreads.tsx` 的 UI thread 索引 | 重啟須重新登入。UI 索引只在當前頁面；後端續聊依 caller 傳入相同 thread ID。Async registry 會牽涉 API、Runtime lookup、Graph Browser 和 evolution 的授權呼叫。 |
| Host Bot 管理 | `HostManagement` 的 `registry.sqlite3`，`bots(id,spec,status)` 與 `installed(id,spec)` | `_save` 在同交易記錄 active 和 installed。記憶體 specs/installed 於啟動讀入。現有 spec 含秘密。restore 需要既有 profile，故 registry 單獨存活不足以重建。 |
| Host profile、工具與 workspace | `HermesBotProvisioner.prepare`、`_initialize`、`_install_skills` 使用每 Bot 的 home/workspace、config.yaml、SOUL、skills 和 archived managed skills | config 由部署模板產生。原生 memory 工具更新 `memories/MEMORY.md` 與 `memories/USER.md`。受信任模板與受配額限制的 profile 清單須分開。不能備份整個 home 或任意 workspace。 |
| Hermes native session | `HermesAgentService._run` 經 `hermes_state_registry.acquire` 打開 `state.db`。`hermes_state_schema.py` 及 siblings 擁有 messages、sessions、FTS、lineage 與 lease | 原生 admission 持鎖載入 transcript，包含分支、壓縮及工具結果。SQLite WAL、連線 registry、inode guards、lease/repair 與 SQLite schema 強耦合。過渡走 SQLite backup API。 `SessionManager.native_id` 將絕對 home 路徑與 principal 納入 hash，搬遷需保存既有 identity 輸入，並驗證原生持久資料內的路徑參照。 |
| Host turn admission | `ReceiptStore.reserve` 在 profile SQLite 寫入有界 run receipts。 `AgentAdapter.active`、`ExecutionManager`、HITL、取消及 delegation parent 狀態存在程序 | 既有 receipt 只能防有限範圍重送。接入 fenced lease 時須涵蓋 Host 管理寫入與正常及 delegation runs，終止事件必須等待必要 checkpoint。跨 instance cancel 和 event replay 屬 Part 2。 |
| Graph Memory | `WikiStore` 擁有 namespaces、revisions、pages、sections FTS5、embeddings、page_owners、edges；Markdown immutable 檔案。`DocumentIngestor` 擁有 document_sources、ingest_jobs、session_evidence、source_versions/owners、completion_times、session_knowledge/origins、ingest_keys | `WikiStore.transaction` 使用同步 `BEGIN IMMEDIATE`。browser、retriever、health、ingestion 直接依賴同步快照及 SQL。移植需保留 publication/revocation 原子性、CJK bigram 召回、active pointer、ACL、provenance 與向量 model/version/dimension。 |
| Graph worker | `GraphEvolution` timer、`SessionIngestor` 及 delegation completion observer | SQLite 已有 lease/retry 和去重。一般 run 的 terminal 至 enqueue 存在 crash window。cloud 需保留 job 與 graph revision transaction 邊界。 |

Hermes 以 profile ContextVar 綁定設定與 turn 資料，也會快取 agent、SessionDB 和工具註冊。工具可能啟動 subprocess，或留下跨 turn 的工作。每次在乾淨目錄 hydration 時，必須先證明程序與工具已停止寫入，再擷取 profile 與資料庫。工具副作用及 run 中途失敗的語意需獨立處理。

既有測試使用 `scripts/run_tests.sh tests/hermes_agui`、`examples/copilotkit` 下的 `npm test` 與 Playwright。首次 sandbox 執行 Node 基線已遇 loopback `listen EPERM`。允許 loopback 後，既有 Python AG-UI 82 項通過，Vitest 99 項通過。其餘實際結果見 [實作報告](cloud-native-part-1-report.md)。
