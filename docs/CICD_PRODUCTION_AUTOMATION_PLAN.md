# Hermes AG-UI — Production CI/CD Automation

基準：`7c31d402dc46640084cdbe199266c0a036b931a6`。交付給 Codex 的實作與驗收規格；不是已完成的部署報告。

## 1. 目標與約束

日常相容性更新只需 push main，經完整 CI、staging 驗收、production gate 後自動更新 GCP。保留現有 `llm-images.yml`、Cloud Build、digest-based deploy、WIF、Cloud SQL、GCS、Tasks、LLM managed auto-init。不要重新設計 agent、Graph Memory 或管理介面。禁止以固定 true 取代 `managed_rollout_confirmed`；禁止自動 bootstrap/opt-in CLI、覆寫 active/draft、改 pin、重建索引、放寬 grants、使用 production 資料做測試。

一次性基礎設施 provisioning 與高風險 schema/config 變更仍需要管理員批准。例行部署無需人工點擊。缺資源/權限/證據即 BLOCKED，不可假造成功。先在分支實作，未通過驗收前不得直接改 production 或啟用自動 CD。

## 2. 現有程式與差距

- `.github/workflows/llm-images.yml`：main push 只 build；dispatch 需 deploy 與人工 rollout confirmation；concurrency `llm-console-rollout`，不取消執行中工作。
- `deploy/gcp/cloudbuild.llm-images.yaml`：Host image → candidate Host 中的 Node tests/跨語言 contracts/build → Runtime image → publish。
- `scripts/ci/llm_build_outputs.py`：成功 build 且兩個 digest 完整才輸出。
- `scripts/ci/deploy_llm_cloud_run.sh`：三個 service 先 no-traffic、startup `/health`、全 Ready 才逐一切流；沒有自動回復、真實 API 驗收或 jobs image 更新。
- `deploy/gcp/setup-github-cicd.sh`：既有 WIF/IAM 初始化，build/deploy 共用 CI SA。需擴充並分權。
- `docs/llm-management-console-operations.md`：managed rollout 順序、pins、migration 001–012、grants、舊 unpinned jobs drain、獨立 PG/browser/cloud gates。保持其保護條件。

## 3. 交付切成兩階段，避免重複測試

### Part 1 — CI 與隔離 staging

1. 盤點 repository 的 test commands、Host/Runtime migrator、Job entrypoints、Scheduler/Task handlers、所有 admission/writer boundary；先產出 inventory，引用實際檔案與函式。不要猜 endpoint、SQL table、job name 或 config key。
2. 建立 PR CI（不具雲端部署權限、不使用 production secrets），執行既有 Python suites、Node tests、tsc、build、pipeline unit tests、disposable real PG migration/grants/pin tests、Playwright real API/browser tests。既有 `vitest.llm-control.config.ts`、`playwright.llm-control.config.ts` 應重用。明確區分 mock/live。依 lockfile 安裝依賴；使用 pinned actions/base images。安全掃描應有明確可審核例外與 fail threshold；不可因掃描未執行而 PASS。
3. main CI 通過後沿用 Cloud Build 產出兩個 immutable digests，建立 release manifest（commit、build ID、digest、code/schema contract、測試結果），同一 artifact 推進 staging/prod，不重 build。驗證 build metadata 與 commit 一致。
4. 一次性 staging provisioning：隔離 DB/roles、GCS bucket 或獨立權限邊界、Tasks queues、Scheduler、service identities、Secret Manager、Firebase synthetic principals、Vertex quota/region、Runtime/Host/Worker、Completion/Reconcile。優先獨立 GCP project；若同 project，須證明所有資料、tasks、secrets、identity 隔離。以現有部署範例衍生，不複製 production data。資源名稱由 inventory/config 確定，禁止猜測或自動覆蓋現有資源。
5. Staging 套用全部 Host/Runtime migrations + grants，檢查 fresh/upgrade/rerun、old/new schema compatibility、least privilege；部署所有 consumers。現有 Runtime→Host→Worker 順序保留，Jobs 更新後驗證 command/args/SA/secret mounts/SQL/timeout/retry 不變。
6. Staging live acceptance：authenticated bot create/list、native agent run、thread continuity、LLM managed active release、synthetic prompt/model 操作、pin 保持、session ingest、Cloud Tasks worker delivery、PG wiki/edge/evidence 寫入、retrieval/story/system prompt、review gate、retry/reconcile、GCS object read/write、Vertex actual request/embedding、Completion/Reconcile actual execution。使用專屬 synthetic namespace，帶 run ID；有界 timeout、明確 assertions、cleanup 只清自己測試資源。重用現有 scenario.py 與 L01–L10 gate（先盤點其實際定義），不可用 mock 替代 live。保留 redacted evidence。測試缺少資源即 fail。

### Part 2 — Production CD 與故障回復

1. 使用 main push 自動觸發 deploy，前提是 build + staging 全部 PASS、一次性 `AUTO_DEPLOY_ENABLED` opt-in 開啟。保留 dispatch build-only/recovery 模式，禁止人工旗標繞過 gate。GitHub environment 無逐次 reviewer 才能無人值守；高風險變更走獨立人工批准 workflow。main 保護、required CI、workflow CODEOWNERS。部署前檢查 commit 是否仍為期望 main head；過期候選不切流。GitHub concurrency 不保證 FIFO 且可能取消 pending run；以 latest eligible SHA 為目標，不承諾每個中間 commit 都部署。GCP/DB durable deployment lock 防止 manual/out-of-band 並行，使用 lease/heartbeat/fencing token，避免僅依 GitHub concurrency。
2. Preflight：讀取目前三服務完整 traffic allocation、revision/image digest、service config hash、Completion/Reconcile job image/template、Scheduler/queue 原狀態、DB migration ledger/schema/grants、active/draft/pinned release/code compatibility。檢查備份/PITR 與必要 GCS generation 參照可用性、DB pool/quota。保存不含 secret 的 durable rollback manifest；記錄 secret reference/version 而非值。檢查部署狀態未被外部改動。對舊版本 reader 無法解析新 release/schema 等情況禁止自動回復或部署。不可把 startup health 當作所有 pin 相容性的證據。
3. Migration controller：重用 Host Python migrator 與 Runtime TS migrator 的既有 ledger/transaction，不重造 migration runner。建立受限 Cloud Run migration job(s)，schema owner DSN 由 Secret Manager 注入，CI 不讀值；migration job SA 不作日常 runtime SA。管理兩套 schema owner（按實際 DB 拓撲），不授 runtime DDL。只執行已審查 immutable migration 與 grants，checksum/ledger/version/role probes，migration lock、timeout、重跑安全。既有 001–012 不重寫。新增 migration 預設阻擋直到有 reviewed compatibility declaration、staging upgrade 與 old-image-on-new-schema 測試；自動允許已證明 additive/expand 的 migration；drop/rename/破壞性資料轉換、embedding selector、static→managed 初次切換、不可逆 pin/contract change 走專案維運流程。任何 migration failure 不切流，不自動 down migration。DDL 成功後仍保留新 schema；只有舊程式相容才可 image rollback。
4. Maintenance controller：建立 durable deployment maintenance state（建議 PG 表 + additive migration，先部署所有 reader/writer 支援才啟用），包含 deployment owner、epoch/fencing token、phase、原狀態。依實際程式碼把 admission gate 放在可信 server/DB transaction boundary：新 run、child delegation、Graph enqueue、retry/review publication、管理 release activation、CLI/外部寫入等逐一分類。禁止新 admission 與控制面變更，但允許已接收工作在原 pin 下 drain。不能只關前端或停 queue。先停止新 admission，讓既有任務正常完成；再暫停 delivery/Scheduler（保留原本已 pause 的狀態），核對 running runs、jobs、leases、completion/reconcile executions、待處理 delivery 與所有寫入路徑。對 future retry/pinned pending job 可保留但必須證明新舊 consumer 都相容，禁止重 pin/任意 cancel/delete。以 DB transaction/fence 避免 check-then-act race；有界 drain timeout，失敗時未改版則安全恢復原狀態，無法判定則保持 maintenance 並報警。不得用 sleep 或 queue depth=0 代替證明。lease 過期不自動解鎖或恢復流量；recovery 必須核對 manifest 與現況。
5. Production rollout：沿用原 `--no-traffic --deploy-health-check`，驗證最新建立/Ready revision 屬於本 deployment 且 digest 正確。所有候選通過後才逐一切換；檢查 maintenance fence 在每個 side effect 前有效。更新 Completion/Reconcile 所有實際存在的 Cloud Run Jobs 到同 Runtime digest，保留 template/SA/command/args/secret/SQL/資源。Scheduler targets 不任意變更；確保既有 executions drain。驗證實際 service traffic 100% 指向指定 revision、jobs template digest 一致。候選 URL 若使用 tag，僅對具 invoker 權限身分開放，測試完移除；不要宣稱 no-traffic revision 的 service URL 就是新版本。維持現有 ingress/IAM。
6. Smoke 與觀察：production 使用專用 synthetic identity/namespace、受限 read-only 或明確授權的 bounded synthetic run；不讀真實 session、不修改真實 active/draft、不以 production credentials 做 staging。若需要寫入 smoke，僅提供受限 synthetic path，可在 maintenance 下驗證但不得成為一般 admission bypass；如果無法安全隔離，先做只讀 probe，寫入由 staging 驗收。核對三服務 version/contract/health、DB read、LLM resolver、授權、必要跨服務 API；恢復 admission/delivery 前 gate 通過。恢復後再觀察有界時間的 5xx、startup errors、job failure/backlog、DB/Vertex errors，無樣本不能當成有流量成功。異常進入 recovery。閾值依 baseline 設定並文件化。
7. Rollback controller：切流前失敗保留舊 traffic；部分切流失敗時保持 maintenance，以 manifest 恢復全部原 traffic split 和 jobs template，驗證實際狀態/health/compatibility，包含先前 0 traffic tags（不破壞無關 tag）。若 migration 已執行或新 pin/release 已產生，先證明原版可讀；不可證明則不自動切回不相容版本，保留相容 consumer、BLOCKED_MANUAL_RECOVERY、告警。絕不自動還原 DB、drop schema、重寫 pins。恢復 queue/Scheduler 原狀態而非全部 unpause。若 runner crash/取消，durable state 保留，下一次 run 必須先 recovery；不要只依 bash trap。禁止在 recovery 未完成時繼續下一次 rollout。
8. Release reporting：GitHub summary + durable manifest/audit，包含 commit、digests、staging gates、migration ledger、revision、job template、phase、rollback evidence、failure reason；敏感資料 redaction。發送成功/失敗通知（GitHub 原生通知可先用）；觀察/回復操作有 runbook。狀態區分 PASS/BLOCKED/FAILED/ROLLED_BACK/RECOVERY_REQUIRED。

## 4. 建議檔案佈局（新檔名稱可依實際 repo 調整）

| 檔案 | 工作 |
|---|---|
| `.github/workflows/llm-ci.yml` | PR/CI，無 GCP production credentials |
| `.github/workflows/llm-images.yml` | main 自動 orchestration，沿用原 WIF workflow_ref；build→staging→prod |
| `deploy/gcp/cloudbuild.llm-images.yaml` | 既有 build + 必要驗證，不改兩映像拓撲 |
| `deploy/gcp/setup-github-cicd.sh` | 一次性管理員執行，staging/prod SA、WIF、最小權限 |
| `deploy/gcp/cicd/` | 環境 manifest schema、migration jobs、provisioning instructions |
| `scripts/ci/llm_build_outputs.py` | 沿用 digest verification |
| `scripts/ci/deploy_llm_cloud_run.sh` | 拆成可重入、可驗證的 revision/job/traffic 操作 |
| `scripts/ci/rollout_controller.*` | durable state machine、preflight、fencing、rollback |
| `scripts/ci/migration_gate.*` | migration compatibility、schema/grants probes |
| `scripts/ci/staging_acceptance.*` | reuse scenario + live gate |
| `scripts/ci/production_smoke.*` | synthetic production probes |
| `docs/llm-management-console-operations.md` | 更新自動化與 recovery SOP |
| `docs/CICD_PRODUCTION_AUTOMATION_REPORT.md` | 實作與實際測試結果、未完成 gate |

維護 gate 必須在實際 application admission/DB boundaries 實作，不是只有 scripts/ci。不要把新檔名當成既有 endpoint 或承諾。CI identity 應拆 build、staging deploy、prod deploy；WIF 仍限制 repo/owner/main/workflow/environment；若新增 environment/改 workflow path，須同步更新 trust condition，不放寬到任意 workflow。build SA 優先使用專用最小權限 SA，避免 default compute SA 既有過廣權限；不自動撤銷其他服務依賴的 IAM。Production CI 不取得 schema owner 密碼/Secret Accessor，只能執行特定預設 migration job，並限制其可修改/actAs 範圍；注意有權更新 job image/command 的身分等同可執行該 SA 權限，須分隔與保護。設定 staging/prod 配置 allowlist，保留既有 model/prompt/schema 管理語意。

## 5. 建議 state machine

`BUILT → STAGING_MIGRATED → STAGING_DEPLOYED → STAGING_PASSED → PROD_PREFLIGHT → ADMISSION_PAUSED → DRAINED → MIGRATED → CANDIDATES_READY → JOBS_UPDATED → TRAFFIC_SWITCHED → SMOKE_PASSED → RESUMED → OBSERVED → COMPLETE`

任何 stage 失敗依 side effects 決定 `FAILED_SAFE` / `ROLLING_BACK → ROLLED_BACK` / `RECOVERY_REQUIRED`。每個 phase 在 durable store 記錄 intent/result；若 side effect 已發生但結果未記錄，recovery read-back reconcile，不直接重做或假設成功。持久化 store 需獨立於可失敗的 runner；若 DB migration 與 state store 同 DB，需考慮 DB outage 時的 recovery evidence。用最小權限存放 manifest，避免 DSN/secret/prompt/session 內容。

## 6. 驗收矩陣（必須有 failure injection）

| 測試 | 必須結果 |
|---|---|
| push main，所有 gate PASS | 無人工操作，全部 services/jobs 使用同一 release 的 digest |
| PR / 非 main | 不可取得 production WIF、不部署 |
| Python/TS/PG/browser/security gate 失敗 | 不部署 production |
| Cloud Build 缺 digest/commit 不符 | 不部署 |
| staging Vertex/GCS/Tasks/Graph 失敗 | production 無任何變更 |
| 缺 migration/grants、未知破壞性 migration | BLOCKED，原版保持 |
| drain 時有 running native run、job、Scheduler execution | 等待完成或 timeout；不強殺/重 pin |
| pause 後競態新工作、CLI、child run | gate 拒絕新工作，已接收工作保留原 pin |
| 新 revision 啟動失敗 | 原 traffic 不變，正確處理已改 schema |
| 第二服務切流失敗、Job update 失敗 | 維持 maintenance；恢復已改部分並驗證或 BLOCKED |
| rollback old reader 無法理解新 pin | 不自動回復不相容版 |
| smoke failure / 5xx threshold | 受控 rollback 或 recovery required |
| runner kill 在 migration/切流/恢復各階段 | durable recovery 可重入；不假報成功 |
| 兩次 push / manual concurrent rollout / 過期 lease | 無交錯 mutation、stale candidate 不覆寫新 release |
| 已 paused 的 queue/Scheduler | 恢復後仍維持原狀態 |
| 成功 rollout | Bot/thread/active/draft/pins/history/Graph 資料保持，無重建索引 |

所有 failure injection 優先 local fake gcloud + disposable PG，再 staging 實際演練；不在 production 故意製造故障。測試 coverage 要涵蓋新控制器的 failure/recovery state，不僅 happy path。報告列出真實 commands、exit codes、commit、redacted evidence；mock 測試不宣稱 live PASS。

## 7. 一次性管理員交付

盤點現行 GCP services、Jobs、Scheduler、queues、DB topology、IAM、Secret refs、Vercel integration。建立隔離 staging、migration jobs/roles、deployment state store、必要 permissions，確認備份/PITR、cost quota。先 rollout maintenance-compatible 版本，以原手動 SOP 啟用安全閘門；完成 staging 與 production 受控首次演練後，由管理員開啟 AUTO_DEPLOY_ENABLED。日常 push 無額外人工確認；重大 schema/infra/provider policy 變更走獨立流程。Vercel 不包含在本次 GCP 自動部署目標內，若前端已有 Git integration，另驗證 API backward compatibility；不得假設 Vercel 已設定。

## 8. 完成定義與本文件限制

Codex 必須提交 source、tests、infra setup/runbook、驗收報告。實作只需要兩階段，先完成隔離 CI/staging，再開 production automation；共享 tests 不重複造輪子。未提供真實 staging 資源或 GCP 授權時，程式完成不代表 production ready；報告 BLOCKED 並列出確切剩餘操作。此文件根據指定 commit 的 workflow、commit diff 與 ops 文件擬定，尚未逐一核實全部 admission endpoints、實際 GCP job names、雲端 IAM/config、staging 是否存在；由實作者 inventory 驗證，不得以推測填補。沒有在本次工作修改 GitHub 或 GCP。
