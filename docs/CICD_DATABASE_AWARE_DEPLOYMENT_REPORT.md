# Database-aware CI/CD 交付報告

日期：2026-11-27（Asia/Taipei）
基準：`b7768d6c40923e904d3465bbc498165a466c0ce7`
分支：`codex/database-aware-cicd`

## 交付範圍與狀態

本次修改 Source、Cloud Build、GitHub Actions、Cloud Run rollout 與本地驗收；沒有連線、清空或修改 Production Database，沒有執行 GCP provisioning，也沒有 Push。沒有建立真實 GCP Staging 或執行 Browser E2E。部署前仍須完成下方一次性設定；本地通過不代表正式環境已部署成功。

選用受控維護窗口。每次部署先排空舊消費者，再處理 SQL／Release；不推測舊 Image 對新版 SQL 的相容性。即使 Contract 沒變，也使用相同安全流程。這會有短暫服務中斷；沒有承諾零停機。

## 實作內容

- `control-contract.ts` 只產生及接受 `management-part-2`。`prompts: {}` 與 `codeTaskFingerprint` 永遠存在；是否自訂 Prompt 不再決定 Contract。
- Python Release Reader 只接受最新版 Snapshot。舊 Contract 不能直接執行。
- `control-upgrade.ts` 是獨立的歷史資料讀取／升級入口：先驗證原始 Release Hash、Model Fingerprint、Task Fingerprint 與已知歷史結構，再用最新版 Manifest、Schema、Validator Version、Protected Prompt、Policy 重建。
- Active Release 和未發布 Draft 分別保留自己的 Model／Prompt 設定。Provider、Model、Embedding 或 Prompt 欄位不符合新 Policy 時明確失敗，不採用預設值覆蓋。
- 最新且相容時不建立 Release、不重設 Draft、不增加 Audit。Bootstrap 使用 `release-001`；升級使用由 parent ID 和新版 Snapshot Hash 決定的新 ID。
- 升級插入新版 Release、Prompt Versions、更新 Active Pointer／Generation、必要 Draft／Revision 和 Audit，在同一個 Transaction 與既有 Control advisory lock 中完成。舊 Release、Audit、Run Pin 保持不可變。
- Host Image 建置時從同一份 TypeScript Source 產生 Task Fingerprint，包進 `llm_task_contract.json`。Host 不再依賴 YAML 裡手動填寫的舊 Task Fingerprint；Approval Policy 仍由部署設定提供。
- 沿用 Python Host 和 TypeScript Runtime Migrator；每個 SQL 檔案及其 Ledger Row 同 Transaction 提交，保留原 advisory locks，增加 SHA-256、未知版本／Ledger 缺口檢查。沒有新增替代 Migration Framework。
- 新增 Host `007_deployment_fence.sql`、Runtime `013_current_job_contract.sql`／`014_deployment_fence.sql`，沒有 DROP TABLE、TRUNCATE 或業務資料清空。

## 自動 Migration 與 Release 流程

1. Critical CI tests 通過，產生 Source／SQL／Task Contract 證據。
2. Cloud Build 建置 Host／Runtime Images，保留不可變 Digest。Host 建置階段產生自己的 Task Contract。
3. 在 Build 的獨立 PostgreSQL 17 容器中，依序執行所有 SQL，產生每個 Migration Prefix 的 Schema Catalog Contract；隨 Runtime Image 包裝。
4. `hermes-database-prepare check` 由新 Runtime Image 在 Cloud Run Job 中比較 Production 的 Ledger、Checksum、Host Schema Version 和實際 Schema。未知版本、缺口、Hash 不符或 Schema Drift 在維護前停止部署。
5. 關閉新 Run／Run Pin Admission。舊 Completion 仍可將結果送入 Graph Queue；舊 Worker、Completion、Reconcile 繼續排空。
6. 等待 Host running Runs、pending／leased Outbox、pending／running Graph Jobs 清空（最多 300 秒）。Task Deliveries 是 Graph Job 的投遞紀錄，是否仍有工作以 Graph Job 狀態判定，不刪除投遞紀錄。
7. 暫停已盤點的 Cloud Scheduler，等待舊 Completion／Reconcile Executions 結束，再將 Runtime／Host／Worker 設為 service-level manual scaling 0，重新檢查排空。首次部署尚無 Fence 時，也必須通過這個停止後的第二次檢查。
8. 封住 Graph Job 新增；執行新 Host Image 的既有 Migrator，再執行新 Runtime Image 的既有 Migrator。只執行缺少的 SQL。重新比對 Schema Catalog。
9. 自動套用既有 `database-grants.sql`／`llm-control-grants.sql` 的相應 Host／Runtime GRANT。Grants 以 Checksum Ledger 記錄；Grants 及記錄同 Transaction，失敗可重試。一般 Runtime 不獲得 DDL 權限。DB Roles 必須先由操作者建立。
10. 新 Schema 再次封鎖 Admission，在全部舊消費者停止時執行 Release 檢查與必要 Bootstrap／Upgrade。全新狀態才 Bootstrap；缺少 Pointer 卻有歷史資料視為損毀，不當成空資料庫。
11. 建立 Candidate Revisions。在維護 Fence 仍關閉時，選定新 Revision 的 100% Traffic，再恢復該服務 autoscaling，執行 Candidate Tag Smoke；全部服務更新後再測正式 URL。
12. Smoke 驗證 `/health` 與未帶應用程式憑證的 API 必須拒絕；應用啟動 Readiness 會驗證已啟用的新版 Release。這是**受控維護窗口**方案，不宣稱可以在舊 Active Release 上測試不相容 Candidate，也不宣稱有做真實 LLM 推論 Smoke。
13. Completion／Reconcile 改為新 Host Image，移除 Candidate Tags、核對所有 Traffic／Digest／設定，最後開啟 DB Admission 並恢復 Scheduler。
14. GitHub Artifact 保留部署結果、前後 Revision／Traffic、Immutable Images、各 Database Operation 與 Cloud Run Execution ID。Bootstrap／Upgrade 的具體 Release ID、Schema 差異／Policy 失敗原因在對應 Execution 的結構化輸出及 DB Audit 中。

Cloud SQL Credential 只以 Secret Manager Binding 掛載至 Cloud Run Jobs。GitHub Runner 不取得連線字串，也不直接連線 Production Database。新 Job 更新時沿用既有 Service Account、Cloud SQL／VPC 與 Secret 綁定。

### 最新版本的寫入行為

相容 Release 檢查與完整 Migration 重跑可在 PostgreSQL `default_transaction_read_only=on` 下通過。沒有無意義的 Release、Draft、Audit、Ledger 或重複 GRANT 寫入。首次導入 Checksum／Grant Ledger 的記錄，以及部署期間關閉／開啟 Fence，是必要的管理寫入，不算成 Release 更新。

Schema Catalog 比對涵蓋受管 Schema 的 Relations、Columns／Types／Collations／Defaults／Nullability、Constraints、Indexes、Functions、Triggers／Enabled State、RLS Policies、Sequence 定義；不比較資料內容、Sequence 目前計數與不同環境的 Owner／ACL。ACL 由獨立 Grants 和角色驗收負責。Schema Contract 目前明確限定 PostgreSQL **17**；不同 Major 會停止，不會猜測相容性。

## Release 切換與失敗回復

- 所有 Job 關閉自動重試，單 Task／單 Parallelism。Migrator／Control Transaction 的 advisory locks 序列化寫入；Database Preparation 另有 Host／Runtime advisory locks。GitHub Workflow concurrency 不取消正在執行的部署。
- 長 Job 先非同步提交並保存 Execution ID，再等待結果。等待失敗會要求取消尚在執行的 Job；不能確認取消時，報告會標示 `execution_cancel_unconfirmed`。
- 維護前 Schema Check 失敗：`FAILED_SAFE`，既有服務及 Scheduler 不變。Preparation Job Template 的 Image 可能已更新，但不切換應用程式 Image／Traffic。
- 一旦進入維護，任何 Migration、Release、Startup、Smoke、Traffic 或 Scheduler 恢復失敗：`RECOVERY_REQUIRED`。重新 Seal DB Fence、停止三個服務、暫停 Scheduler；個別封鎖操作無法確認時另標示 `containment_incomplete`。不得把這些狀態當成回滾成功。
- SQL 以檔案為 Transaction 邊界：失敗檔案的 DDL／Ledger 回復；先前已成功的 Migration 不自動倒退。Release Upgrade 以 Transaction 為邊界：失敗不改 Pointer／Draft；若已提交，Pointer 可能已是新版。
- 沒有自動切回舊 Image／舊 Pointer。由於舊 Image 不保證能讀新版 SQL 或 Release，應優先向前修復。
- 復原前先確認所有 Preparation／Migration Executions 已終止，從部署 Artifact 及 Audit 確認已提交的 SQL／Release。維持 Fence／manual scaling 0，修正失敗原因，使用相同或更新 Source Image 重做 Schema Check、必要 Migration／Grants 與 Release 檢查。相容時不會重複 Bootstrap／Upgrade。
- 接著只啟動已能讀目前 Schema／Active Release 的新 Images，重新核對 Completion／Reconcile Images、Candidate／正式 URL Smoke、全部 Traffic 和 Tags，再執行 `resume` 並恢復 Scheduler。不要先將舊 Image 恢復 autoscaling。
- 殘留 `ci-candidate` Tag、manual scaling 或已暫停 Scheduler 會阻擋一般新部署，要求操作者完成上述復原，不會偷偷覆蓋中斷現場。若只能從 Backup 回復，必須由操作者確認包含 SQL 和 Pointer 的整體方案後另行執行。

沒有為升級刪除 Bot、Session、Graph Memory、Run Pin、Graph Jobs 或 Audit。舊的終態歷史 Pin 可以保留，但不能再用舊 Contract 執行；待執行／執行中的舊任務必須先排空。

## 一次性 GCP／Database 設定（尚未執行）

### 1. 確認現有環境

- Cloud SQL 為 PostgreSQL 17，存在適當 Host／Runtime Migration Owner，以及既有 `hermes_host`、`hermes_runtime`、`hermes_llm_admin`、`hermes_llm_runtime`、`hermes_llm_reader`、`hermes_llm_host_reader` DB Roles。登入資訊只存 Secret Manager。
- Owner 能管理自己的 Schema、Migration／Grant Ledger 與 GRANT；LLM Admin 只需現有 Control DML，加上新 Migration 授予的 Fence SELECT。不要給一般 Runtime CREATE／ALTER／DROP 權限。
- 新 Runtime 的 `013` 更新 Graph Job claim fence 為最新版 Contract；既有 `011`／`012` 原始 SQL Bytes 保持不變。
- Runtime、Worker、Host、Completion、Reconcile 都必須使用這裡盤點的服務／Jobs；不得另有未盤點 Worker、跨專案排程或外部程序直接執行 DB 工作。
- 清除舊 Revision Tags；目前服務必須為 autoscaling。Runtime 保留 `--require-existing-control`，Worker 保留 `--worker`。
- 新資料庫需要先建 DB Roles／Owner 與 Secrets；Schema、DML Grants、Control State 由部署自動建立，不必手動 Bootstrap。

### 2. IAM：沿用同一個 CI/CD Service Account

沿用 `github-hermes-cicd@copilotkit-agui.iam.gserviceaccount.com`，本次不建立新 Service Account。

在既有服務／Jobs 的部署與 Invoker 權限之外，一次性補足：

- 對兩個新 Job 的更新、查詢、執行、帶 Overrides 執行，以及 Execution list／get／cancel 權限。可在兩個 Job Resource 綁定既有 `roles/run.developer`，並確認具備 `roles/run.jobsExecutorWithOverrides` 所需的 `run.jobs.runWithOverrides`；使用自訂最小權限 Role 亦可。
- 對排程所在 Project／Region 的 `cloudscheduler.jobs.get/list/pause/resume`（建議自訂 Role，只含這四項）。不需要讓 CI 刪除或任意改寫 Scheduler。
- Job 執行身份的既有 `roles/cloudsql.client`；只對指定 Owner／Admin／Runtime Config Secrets 的 `roles/secretmanager.secretAccessor`；沿用現有 Log Writer、Artifact Reader、Service Account actAs 與 Smoke ID Token 權限。

不要把 Owner Secrets 綁到 Runtime／Host／Worker 服務。兩個 Preparation Jobs 都使用同一 CI/CD SA；Runner 只提交 Job，程式不下載 Secrets。若組織已有專用 Migration 執行身份，也可沿用它，但不必為本次拆出多個 SA。

### 3. 建立兩個 Job Templates

提供可檢查的操作者腳本 `deploy/gcp/setup-database-aware-jobs.sh`。**本次未執行**。先準備以下非密文座標，再由有 provisioning 權限的人執行：

```bash
export GCP_PROJECT_ID=copilotkit-agui
export GCP_BUILD_REGION=asia-east1
export CLOUD_SQL_INSTANCE='PROJECT:REGION:INSTANCE'
export HOST_IMAGE='REGISTRY/hermes-host@sha256:EXISTING_64_HEX_DIGEST'
export RUNTIME_IMAGE='REGISTRY/hermes-runtime@sha256:EXISTING_64_HEX_DIGEST'
export HOST_OWNER_SECRET='host-owner-database-url:1'
export RUNTIME_OWNER_SECRET='runtime-owner-database-url:1'
export LLM_ADMIN_SECRET='llm-admin-database-url:1'
export RUNTIME_CONFIG_SECRET='runtime-config:1'
bash deploy/gcp/setup-database-aware-jobs.sh
```

Secrets 必須填實際名稱／固定數字版本，Image 必須填真實不可變 Digest。腳本只建立 Job Templates，不執行 Job 或 SQL。Template 可以先用目前既有 Images，部署程式會在第一次執行前換成新建置的 Images。若現有 Cloud SQL 使用 VPC／Subnet，將相同的 `--network`／`--subnet`／`--vpc-egress` 參數傳給腳本；不要猜測另一套網路設定。

`hermes-host-migrate`：新 Host Image，`python -m hermes_agui.storage.migrate`，Host Owner Secret。
`hermes-database-prepare`：新 Runtime Image，`node --import tsx server/storage/deployment-cli.ts COMMAND`，掛載 Runtime Config、Host Owner／Runtime Owner／LLM Admin Secrets。Runtime Owner 與 LLM Admin 連線目的地必須相同。

兩個 Job：`tasks=1`、`parallelism=1`、`max-retries=0`、`task-timeout=900s`。Orchestrator 最多等待每次 Execution 600 秒，逾時停止部署並嘗試取消。Runtime Config 的 Approval Policy 必須與候選 Runtime／Worker／Host 使用的部署 Policy 一致。

### 4. GitHub 設定與排程盤點

- 在 `llm-deploy` 可見的 Repository／Environment Variables 設定 `LLM_SCHEDULER_JOBS` 為**實際名稱**的 JSON Array，例如 `["hermes-completion-schedule","hermes-reconcile-schedule"]`；若還有 Worker Scheduler 也要列入。所有排程必須位於本流程使用的 `asia-east1`，不同 Region 應先調整明確的座標。
- 程式會比對目前 Region 的 HTTP Scheduler Inventory，發現指向這些服務／Jobs 但未列入的排程會失敗。Pub/Sub、外部 Scheduler 或別的專案不在這個 Inventory 能力範圍內，必須先由操作者確認不存在或納管，不能省略這個前提。
- `COMPATIBILITY_BASE_COMMIT` 必須是 Source 的已審核祖先，可設為本次基準。它現在用於 Source 證據，不再要求每次 SQL／Contract 變更都手動推進，也不代表舊 Image 可回滾。
- 確認兩個新 Jobs 的 IAM 綁定、Secret 版本、Cloud SQL／VPC 連線；現有 `llm-build`／`llm-deploy` Environment、WIF、`AUTO_DEPLOY_ENABLED` 設定沿用。

## 現有 release-001 如何升級

若 `release-001` 是完整且 Hash 正確的 `management-part-1`：排空並停止舊消費者後，讀取其 LLM 設定，以空 Prompt Edits 和目前 Source 重建 `management-part-2` Snapshot。合法的前端 Model 路由保持不變；未發布 Draft 以自己的設定與 Prompt Edits 獨立驗證、保留。

建立 `release-upgrade-<sha256>`，parent 指向 `release-001`；同 Transaction 將 Active Pointer／Generation 指向新 ID、更新必要的 Draft，並寫入 `publish` Audit，reason 為 `Release contract upgrade`。`release-001` 原始內容、舊 Pins 和 Audit 保留。再次執行發現 Active 相容，沒有新的 Release／Audit／Draft 寫入。

若 `release-001` 已是目前 `management-part-2` 且 Snapshot／Policy 相容，直接保留它。若 Provider／Model／Embedding／Prompt Policy 不符或資料 Hash 損壞，停止部署，透過 Execution 的明確錯誤及 Audit 由操作者修正；不擅自覆寫。

## 本地驗收結果

使用本地隔離 PostgreSQL 17 容器；Python 依專案 PM 建立隔離 test environment；測試資料庫全部是隨機名稱的本地 DB。

| 必要驗收 | 證據 |
|---|---|
| 空 DB Migration + Bootstrap | PG suite 建立空 DB、執行兩套 Migrator、啟用最新版 Release；Preparation CLI 使用 LLM Admin Role Bootstrap |
| 最新版不產生多餘寫入 | Read-only DB 設定下重跑 Migrator、Grant Check 和相容 Release Check；比較 Release／Audit／Draft／Pointer 狀態 |
| management-part-1 升級 | 保留 release-001，建立新 parented Release，驗證舊 Contract 被 Runtime Reader 拒絕 |
| SQL Schema 變更 | 已有 Prefix 自動執行缺少的 013／014；未知版本／新增異常欄位拒絕 |
| Task Contract 變更 | 模擬歷史 Code Fingerprint，重建目前 Contract、驗證新 Code Fingerprint 與 Python Reader |
| Model／Prompt 保留 | Active 的合法設定與 Draft 的未發布 Model／Native／Graph Prompt 分別保留 |
| Migration／Upgrade 失敗阻擋 | SQL Ledger INSERT 失敗時 DDL 回復；Policy／Hash 失敗時 Pointer／Draft／Audit 不變；rollout failure injection 不建立 Candidate 或不恢復 Admission |
| 重複 CI/CD | Bootstrap／Upgrade 重跑和相容並行檢查不增加 Release、Audit 或重設 Draft |

驗證命令：

```bash
# 設定 AGUI_LLM_TEST_ADMIN_URL、AGUI_LLM_TEST_HOST_PYTHON 指向隔離本地環境
cd examples/copilotkit
npm test -- --config vitest.database-deployment.config.ts
npm run build
npm test -- tests/llm-control.test.ts tests/llm-prompts.test.ts tests/llm-managed-startup.test.ts --maxWorkers=2
cd ../..
scripts/run_tests.sh tests/scripts/test_llm_image_rollout.py tests/scripts/test_llm_release_manifest.py tests/scripts/test_cicd_integrity.py -j 2
python3 -m scripts.ci.migration_gate
```

PG suite：6 個案例通過。Release／Prompt／啟動單元測試：17 個通過。部署／Manifest／完整性 Python 測試：27 個通過。TypeScript typecheck／Vite production build 通過；Shell 語法及 diff whitespace 檢查通過。沒有執行與本次無關的 Browser E2E 或真實 GCP 部署測試。

## 使用者待辦與 Push 順序

1. 審閱本 commit，完成上面 DB Roles／Owner Secrets、IAM、兩個 Cloud Run Jobs、Scheduler Inventory 的一次性設定。
2. 確認 Production PostgreSQL Major、Schema／Ledger 完整性及排程盤點；如有 Drift 先調查，不以清空資料處理。
3. 準備首次升級維護窗口；初次尚無 Fence，繁忙工作可能使第二次排空檢查失敗，會停留 `RECOVERY_REQUIRED` 而非冒險啟用新版。
4. 一次性設定完成後，才將本分支整合並 Push 至 `main` 觸發正式流程。不要先 Push 來測 GCP 設定。
5. 觀察 GitHub Deployment Artifact 及 Cloud Run Job Executions；只有最後 `DEPLOYED` 才表示 Smoke、Traffic、Admission 及 Scheduler 恢復全部完成。
