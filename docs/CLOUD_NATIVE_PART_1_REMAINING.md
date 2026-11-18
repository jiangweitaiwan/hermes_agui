# Hermes AG-UI — Cloud-native Part 1 Remaining

> Part 1 收尾及 Part 2 交接契約｜執行者：Codex
>
> Repository: https://github.com/jiangweitaiwan/hermes_agui.git
> 審查基準：`7d74a8d9ba94559a6997424e98ad747f82a4c226`；執行時以實際 HEAD 和未提交變更為準。

## 1. 任務定位與優先順序

本文件不是 Part 3，也不要求重做 Part 1。接續 `docs/CLOUD_NATIVE_PART_1.md` 的既有成果，補齊阻擋 `docs/CLOUD_NATIVE_PART_2.md` 的核心缺口。本文件經專案 owner 採用後，優先適用於 Part 1 剩餘工作及調整後的驗收範圍；原計畫的安全、隔離、持久化要求仍有效。遇到矛盾時記錄差異，不自行降低安全閘門。

成功定義：兩個應用服務的本機可寫資料全部消失後，僅依部署模板、秘密設定、PostgreSQL 與外部 object storage 即可恢復既有 Bot、已提交對話、核准持久化的原生 memory/skills 和 Graph Memory；重複投遞、過期 worker 或舊 provisioning 操作不得破壞已提交資料。

本階段不部署 GCP，不建立付費資源，不實作 Firebase、Cloud Tasks/Scheduler、IAM service-to-service、SSE replay、跨實例 cancel 或任意中斷 Agent 的無縫續跑。保留現有 local mode、AG-UI contract、前端及記憶演算法。

## 2. 起始狀態與凍結範圍

先讀 `docs/CLOUD_NATIVE_PART_1.md`、`docs/cloud-native-part-1-report.md`、`docs/cloud-native-inventory.md`、`docs/cloud-native-part-2-report.md`、`docs/CLOUD_NATIVE_PART_2.md`。記錄 HEAD、git status、現有測試及配置；不要覆蓋未提交變更。若最新程式碼已完成某項工作，驗證並沿用，不重做。

| 模組 | 已報告成果／現況 | 本輪處置 |
|---|---|---|
| Hermes Host | PostgreSQL managed registry、run lease、revision admission | 凍結，僅補整合缺陷 |
| Native session/profile | SQLite backup 快照、GCS adapter、隔離 hydration、原始 session identity | 保留，不改寫原生 Hermes DB |
| Host outbox | run completion 與 profile manifest 提交、completion evidence delivery | 沿用並接至 durable Graph ingestion |
| Runtime registry / mappings | PostgreSQL registry、thread/delegation mappings、Bot metadata import | 沿用 |
| Graph | SQLite WikiStore、filesystem Markdown、SQLite queue、timer | 本輪核心 |
| Provisioning | 既有 reconcile、Host revision、tombstone | 補跨服務操作順序與對帳 |

上述為文件與靜態審查結果，不代表本輪已驗證。報告中的真 PG probe、12 項聚焦 Python、105 項 Runtime 測試及 build 成果可作基線，不當作新版本通過證據。

### 2.1 原生 Session 契約

接受 SQLite backup + immutable object revision 為本版本正式採用的相容方案，不再把原生 PostgreSQL session backend 列為 Part 1/2 阻擋條件。保留 bot-wide fenced lease、隔離執行、原始 home identity、checksum/generation、SQL manifest CAS、terminal success 前持久化。現有實作只在成功回合提交快照：本版本接受未提交回合的 memory/skill 變更可能遺失；不得宣稱工具級 checkpoint 或 exactly-once 外部副作用。若無法復原已提交回合則必須修復。記錄快照容量限制、核准路徑、模板技能與 Bot 自建技能的差別、延遲及未引用物件 retention；不得把 live SQLite/WAL 放在 GCS mount。不得為了保存任意檔案放寬 allowlist。

## 3. 工作包 A — Graph Memory Storage（優先）

### 3.1 真實入口與重構邊界

定位 `examples/copilotkit/server/graph/` 的 `wiki-store.ts`、`ingest-queue.ts`、`provider.ts`、`retriever.ts`、`compiler.ts`、`browser*.ts`、`embedding.ts`、`health.ts`、`evolution.ts`、`session-ingestor.ts`、CLI/API，及 `server/application.ts`、`graph-memory.ts`。以 rg 盤點所有 `.db.prepare`、同步 transaction、filesystem、直接 SQL 呼叫及其上層。現有 WikiStore 的 `DatabaseSync` 和同步 callback 不可只換 driver；需要將 I/O 邊界改成可 await 的 typed contract，並沿呼叫鏈傳遞 async。

介面名稱以下為示意，沿用 repo 命名：GraphStore、GraphObjectStore、IngestJobStore。保留 SQLite/local filesystem adapter；新增 PostgreSQL/GCS adapter 與 filesystem object contract double。避免通用 CRUD 或重寫 compiler/retrieval；不得在 gcp 模式偷偷 fallback SQLite。所有 API、CLI、browser、embedding、health、revocation 路徑都必須能走選定 backend。

### 3.2 資料布局

- PostgreSQL（Runtime owner schema）：namespace、pages/nodes、edges、revisions/active pointer、page/source owners、source versions、provenance/classification、session evidence/knowledge/origins、ingest keys、jobs、completion times、section/search index、embedding metadata/vector（若啟用）。以實際 schema 盤點補全；維持 FK/unique/index、scope、UTC 和 ID 語意。
- GCS：原始 source 內容、Wiki Markdown immutable revision；SQL 保存 object key、generation、checksum、size。衍生索引可保存文字；不得把索引和原文各自當作權威。
- Runtime 與 Host schema/role 維持 ownership；不直接修改對方資料表，不新增 Firestore、Redis、Neo4j。配置沿用既有環境變數，補必要設定及 `.env.example`；ADC、pool 上限、獨立 migration 命令、fail-fast；無秘密入庫或 log。

### 3.3 發布與檢索一致性

先 stage immutable object（create-only / generation precondition、checksum），再以同一 SQL transaction 驗證 scope、job lease、source 未撤銷及 expected active revision，發布 revisions、active pointers、edges、owners、sections/index 並完成 job。SQL transaction 必須使用同一 client；不可在舊 SQLite 同步 transaction 中傳 async callback。避免把 GCS 網路 I/O 或 LLM 呼叫放在長時間 SQL transaction 中。可用 namespace row lock 或等效機制處理首次建立、quota 和並發寫入；固定鎖順序。

失敗時保持原 active revision；孤立 object 可供後續安全 GC，記錄 grace/retention 策略，不刪仍被引用版本。兩個不同 job 更新同頁時以 revision CAS 防 lost update，衝突後重新讀取再 merge/retry，而非盲覆蓋。撤銷 source、停用/刪除 Bot（依既有 retained 語意）與 project_shared provenance 必須保持現有規則；讀取/embedding await 後再次校驗 active revision 和授權，不能依賴過期的 process map。

維持 existing CJK tokenization/terms 語意；PG FTS 建議使用相容的預斷詞 token 與 simple config，或測試證明等效方案。不可直接用英文 stemming 取代繁中 bigram。既有 `wiki-evaluate.ts` 作比較基準（報告曾為 keyword 0.50、hybrid 0.9167、hybrid+graph 1.00）；在同 fixture、encoder 和設定下記錄 local/PG 結果，關鍵知識召回與 scope 不得退化，排序差異須說明。保持原 embedding 開關、model/dimension/revision 隔離，不強制 pgvector；已支援的模式須有等效行為。不得藉停用 Graph/embedding 功能來通過測試。

### 3.4 A 完成條件

真 PG + object contract double 下可 ingest 文件、發布 wiki、讀取 graph browser、繁中 retrieval、context injection、撤銷及 revision 更新；無依賴應用本機 wiki.sqlite/Markdown。local mode 維持既有行為。相關聚焦測試通過後進 B，完整 regression 留 D。

## 4. 工作包 B — Durable Graph Job 與 completion 銜接

沿用 `DocumentIngestor.claim/heartbeat/complete/fail/cancelClaim`、`WikiCompiler.processJob(namespace, jobId, signal)`、`SessionIngestor` 和 Host `completion_delivery.py`/`run_outbox.py`。不要另外建立第二個 Graph compiler 或 queue。

1. PG job claim 使用 DB clock、原子 row lock（可用 SKIP LOCKED）、唯一 idempotency key、attempt、lease expiry、每次 claim 唯一 token 或 monotonic fence；heartbeat、complete、fail/cancel 都須驗證有效 owner/lease。重送相同 payload 回傳原 job；同 key 不同 payload 拒絕；保留 scope 與 source revision。
2. Compiler heartbeat 改為可等待且不重疊的 renew，失去 lease abort；即使 LLM/網路不支援 abort，舊 worker 仍不可發布。維持有限重試、backoff、terminal failure 與安全人工 retry。worker shutdown 不把可恢復 job 誤標永久取消。
3. Job 完成和 Graph publication 必須使用 A 的同一交易，不存在「job completed 但 page 未發布」或相反情形。檢查 source revocation、expected revision、ACL；不同 job 併發更新同頁也不可遺失資料。
4. Host 已提交 run → durable outbox/evidence → authenticated completion API → SessionIngestor → durable source+job。API 僅在入列交易成功或確認已入列後 ACK；ACK 遺失後重送不得產生重複 source/job。保留既有 completion token/授權契約，不加入正式 IAM。檢查 durable host 和 stream ingestion 不會雙重寫入；不要為補漏自動重播 agent/tool 副作用。
5. 抽出可由外部 caller 執行指定 job 的入口和可重跑 dispatch/reconcile CLI；local timer 可保留；測試 PG mode 可用獨立 process/一次 tick。Part 2 才接 Cloud Tasks/Scheduler/HTTP worker，正式 Cloud Run 不依賴 response 後 timer。明確記錄 Host outbox 如何被 Part 2 定期喚醒。
6. 修正 `application.ts` 現有 `PostgreSQL Bot registry requires durable Graph evolution` 保護：僅在 durable graph/job backend 和權威 ACL 刷新均接通後允許 PG+evolution；保留不相容配置的 fail-fast。不要只移除 throw。Worker 和 provider 的 retained/authorized 查詢必須使用當前權威狀態。

聚焦驗收：兩個獨立 worker 共用真 PG；A claim 後停止，B 過期接管；A 恢復仍不得發布；重複 completion/ACK loss、object upload/SQL rollback、revocation during compile、不同 job 同頁競態均有可重現測試。

## 5. 工作包 C — 最小跨服務 Provisioning Reconciliation

定位 `server/bots/manager.ts`、`host-client.ts`、Runtime registry adapter、`hermes_agui/storage/managed_bots.py` 及 management endpoints。現況：Runtime 先保存 provisioning，再 HTTP register，再保存 active；HTTP ACK 遺失可能令 Runtime failed/Host active。既有 Host UUID revision 是本地 admission fence，不能自行判斷遠端操作新舊。

- Runtime 為 desired state owner；Host 為 applied state owner。沿用現有 registry 和 API，新增最小 durable operation（operation_id、scope、desired_revision、desired state/spec hash、status、attempt/error/timestamps）。每 Bot 單調 desired_revision 由 PG transaction 配發，與 desired state 同交易；不得用 wall clock 或 UUID 排新舊。
- Host 原子校驗 scope、operation_id、desired_revision/spec hash 與 tombstone；相同操作回傳既有結果，同版本不同內容衝突，低版本拒絕；保存 applied_revision/operation_id。保留現有 run admission revision/fence；管理寫入與 run admission 互斥規則不退化。刪除不可復活，disable/update/re-enable 遵守原狀態機。
- 增加受保護 Host status/ack 查詢（最少 scope、applied_revision、state、operation_id/spec hash，不返回秘密）。Runtime 接到 ACK 後用 desired_revision CAS 更新狀態；timeout/503 視為結果未知，可 retry/reconcile，不當成確定未執行。確定拒絕可標明原因；不得因舊 ACK 覆蓋新狀態。
- 擴充既有 reconcile，掃 pending/unknown 及不一致狀態，包括舊版 failed 的可安全判定案例；查 Host、重送同操作、記錄衝突。不能安全自動修復者停止並報告。禁止持有長時間 SQL transaction 等跨服務 HTTP；短交易保存意圖與確認結果。沿用啟動/明確 CLI 觸發；定期雲端觸發留 Part 2。
- Runtime 在 disable/delete 意圖提交後立即拒絕新 run；Host 一旦套用新狀態也拒絕舊 admission。網路分割期間 Host 尚未收到停用不能宣稱全域瞬時失效；需記錄窗口，Part 2 private IAM 防止直接繞過 Runtime。共享 credential seed 沿用秘密注入，禁止明文保存或輸出；交接 seed 漏失/輪替限制。

聚焦驗收：Host 已提交但 ACK 遺失；Runtime 崩潰後 reconcile；duplicate create/update；延遲舊 register 抵達已 disable/delete Host；舊 ACK；兩 Runtime 並發；busy run；跨 scope 拒絕。最終兩 registry 一致，無重複或復活 Bot。

## 6. 遷移 scope 決策（owner 核准）

建議 `fresh_deployment` 為本輪預設執行路徑，但不等於授權刪除現有資料。若 owner 未確認舊資料可不遷移，原 Part 1 歷史遷移閘門保持未核准，不得自行標 PASS。可先完成非破壞性 fresh 測試。

- fresh_deployment：新 DB/bucket/prefix；既有 local data 完整保留，既有 Host/Runtime import 工具不拆除。全量歷史匯入在 owner 明確接受後標 N/A（非 PASS），不阻擋 fresh staging。不得宣稱可直接切換既有使用者。
- preserve_existing：在進入有舊資料的部署前補 thread mapping（只恢復可證明存在者）、Graph sources/revisions/active pointers/provenance/ACL/jobs/索引遷移；停止 writer、SQLite 一致性備份、dry-run、可安全重跑、counts/checksum/orphans/cross-service reconciliation。保留 stable IDs、timestamp、scope；不猜測舊 browser thread ID。索引可重建，pending/running job 採明確安全重試策略。缺資料列出，禁止靜默丟棄或覆寫。

記錄 owner 決策及對 Part 2 的影響。fresh 路徑仍需驗證新資料可重建、既有匯入命令不因 schema 更新失效；備份/PITR 實雲還原演練留 Part 2。

## 7. 工作包 D — 一次整體驗收

沿用原 fixtures、fake LLM、Python/TS/Playwright harness；優先擴充現有 tests 而非重建。開發 A/B/C 時僅跑受影響的 contract/integration tests；全部接通後執行完整 regression 一次，失敗先聚焦修復，最終合併前以同一候選版本重驗必要 suite。禁止固定等待或 mock 掩蓋真 DB 競態。

### 7.1 共享 E2E scenario（Part 2 沿用）

1. 啟動真 PostgreSQL、獨立 object storage contract double（儲存根目錄不屬於任一應用 writable layer）、Runtime、Host；套用 migrations。兩服務用 PG 模式並啟用 Graph evolution。
2. 以既有 API 或 UI 建立不同 Bot A/B，另配置不同 owner，確認 scoped Bot/thread registry。使用 fake LLM 對話，記錄原始 browser/host/native session ID、run ID；執行核准的 native memory/skill 寫入並確認成功 terminal 後 manifest 已發布。
3. 由 Host completion outbox 或既有受支援 source API 觸發 graph ingestion；完成 job 並確認 graph browser、provenance、繁中檢索、active revision 和 context injection。驗證新 bot 私有與共享授權語意。
4. 停止並刪除 Runtime/Host 容器及全部應用本機可寫資料（不可掛載舊 profile/wiki volume）；保留外部 PG/object store 和部署模板/秘密。重新建立兩服務。斷言 Bot list、原 thread ID 續聊、已提交對話（含原生必要 tool/result 資料）、memory/核准 skill、Graph browser/retrieval/injection 均成功，且不依賴舊 process cache。新 thread 的歷史列表 UI 屬 Part 2，Part 1 至少通過原 ID 的 server-side 存取/續聊。
5. 注入至少一次失敗窗口：已完成 run 的 outbox 未 ACK、job lease 過期與重送、舊 worker 發布拒絕、provisioning ACK lost/舊 revision；重新啟動或重送後收斂。驗證隔離及拒絕已停用 Bot。

### 7.2 驗收矩陣

| Gate | PASS 條件 |
|---|---|
| Legacy regression | 原 Python AG-UI、Runtime、browser、delegation、Graph suites 無新增失敗；條件跳過的必要案例另以指定模式執行 |
| Storage | local/PG contracts、真 PG、object double、migration/config fail-fast、ACL/revision/source consistency |
| Graph | PG+evolution 真正接通；繁中 fixture、embedding 開關、browser、context injection、撤銷 |
| Job | 真 PG 雙 process takeover、fence、重送、故障注入、不同 job 同頁 CAS |
| Provisioning | ACK lost、延遲操作、reconcile、停用/刪除、scope、並發與 run admission |
| Restart | 雙服務容器及可寫層刪除後完整 E2E；PG/object storage 保留 |
| Migration | owner 核准 fresh 為 N/A（既有 importer 兼容性仍測）或 preserve_existing 全量對帳 PASS |
| Build | TypeScript/Vite、Python lint、git diff --check，以及可重複 container build/setup |

Docker daemon 若無法連線，可先用兩組獨立 process + 全新 scratch directory 執行相同 scenario，報告為 process-level PASS；容器 gate 仍為 NOT RUN，不得當 PASS。提供一鍵或明確可執行的容器測試命令，請 owner/CI 補測，或由 owner 明確核准延至 Part 2 staging（仍禁止 public 上線直至通過）。此例外不適用於尚未實作的 Graph、隔離或資料持久化。真 GCS IAM/generation 等無法由 double 證明的語意列 Part 2 NOT RUN。

按實際 repo 確認命令，基線包括 `scripts/run_tests.sh tests/hermes_agui`、`python -m tests.hermes_agui.postgres_storage_probe`、`cd examples/copilotkit && npm test -- --reporter=dot`、`npm run build`、`npm run test:e2e`（含 GRAPH_MEMORY_TEST、DYNAMIC_BOT_TEST、MULTI_BOT_TEST 指定模式）及 `node --import tsx tests/fixtures/wiki-evaluate.ts`。提供實際 DB setup、migration、資料清理和共享 scenario 指令，不硬編不存在的 script。

## 8. Part 2 交接契約

所有核心 gate 通過（或僅有前述明確核准的容器環境例外）且 migration scope 已核准，才進 Part 2。Part 2 前置報告更新為對應候選 commit 的真實結果，不重新設計已完成 storage。

| Part 1 交付 | Part 2 消費方式 |
|---|---|
| PG/GCS adapters、schema/version、config | Cloud SQL/GCS provisioning、ADC/IAM、獨立 migration job |
| Host profile/run lease/manifest/outbox | Cloud Run Hermes private service、interrupted run、event replay/cancel |
| Graph durable source/jobs + processJob | Memory Worker HTTP handler，Cloud Tasks OIDC、retry、queue limits |
| Completion dispatcher + reconcile CLI | Cloud Scheduler/worker 私有入口補送 outbox、接管過期 lease、對帳 |
| Runtime desired/applied revision 契約 | 雲端服務間 IAM、定期 reconcile、可觀測 provisioning |
| 共享 E2E/contract fixtures | 真 GCS/PG、Cloud Run restart/scale、Cloud Tasks、Firebase/Vercel 最終驗收 |

Part 2 仍負責 Firebase Auth、Vercel、IAM service identity、長 SSE/record/replay、跨實例 cancel、部署腳本、正式安全 gate、備份還原及實雲成本測試。不得把 Part 1 的 local double 結果冒充實雲 PASS。未經 owner 授權不建立付費資源。

## 9. 交付清單與停止條件

交付實際程式碼、schema migrations、配置樣板、補充 tests/fixtures、共享 E2E runner、setup/驗收命令。更新 `docs/cloud-native-part-1-report.md`、`docs/cloud-native-inventory.md`、`docs/cloud-native-part-2-report.md` 的前置閘門；保留歷史結果並追加最新紀錄，不覆蓋失敗歷史。若文件與原 Part 1 有差異，記載 owner 核准的 scope 修訂，不擅自改寫原計畫。

報告必須列：起始/候選 commit、變更檔案、實際介面與環境變數、migration 順序/角色 grants、每個 gate 的 PASS/FAIL/NOT RUN/N/A 及證據、測試命令與結果、已知限制、owner 決策、Part 2 可直接使用的 entrypoint。不得用測試數量取代功能 gate；不得以 TODO/stub 或關閉 Graph 標為完成。

遇到 ACL 洩漏、未提交回合被當成功、舊 writer 可發布、兩 registry 無法安全收斂、必要資料無法恢復、owner 未定 migration scope 時，停止宣稱 Part 1 完成，回報具體原因與最小修復方案。不要自行擴張至 Part 2 功能。

**執行順序：A → B → C → D → 更新交接報告 → Part 2。** 可先建立 A/B 共享契約並共同接線；不為每個工作包重跑整套 E2E。Codex 應從當前 HEAD 增量實作並以可驗證的結果收尾，而非再次從原 Part 1 起點重構。
