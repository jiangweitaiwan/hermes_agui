# 精簡 Production CI/CD 計畫

基準 commit：`e4789729907d5ee55c3a6b0f3a1b6184cd6b0a20`。本文件取代原完整 staging／controller 計畫。

## 日常路徑

`main push → critical CI → Cloud Build → immutable release manifest → no-traffic candidates → readonly smoke → Jobs image update → Runtime/Host/Worker 切流 → readonly smoke → report`

一次性啟用後，一般相容程式更新不需逐次人工確認。PR 沒有 OIDC／production secrets。
沿用 `llm-ci.yml`、`llm-images.yml`、Cloud Build、既有 migrators 與 manifests；不新建部署平台。

| 必要 gate | 範圍 |
|---|---|
| Typecheck / Build | CopilotKit `npm run build`，包含 tsc |
| Runtime / API | 精選 Python HTTP/SSE、auth、restart/history；Node runtime/cloud/registry/startup |
| Database compatibility | 本地 disposable PG17；Host fresh/legacy upgrade/rerun；Runtime migrations、grants、CAS、pins、既有 control PG suite |
| Migration / contract | 固定 SQL/grants checksum；相對經審查基準的 infra、dependency、schema、LLM 管理契約變更直接阻擋 |
| Image integrity | 同 source commit/archive；Host、Completion、Reconcile 模組可載入；Runtime build；non-root image 與 source revision labels；完整 Cloud Build steps 與兩個 immutable digests |
| Candidate readiness | 三服務皆 Ready、created=ready、digest 正確；tagged URL 的 GET `/health` 與無 app credential 的 API 拒絕測試 |

完整 Python、Node、Playwright、Graph Memory E2E、dependency advisory scans 放在 `llm-acceptance.yml` 手動獨立驗收，不再是每個 push 必要條件。這不代表已解決歷史 advisory。

## 部署界線

- **Production 不執行任何 migration／grants／bootstrap CLI／reindex。** 新增 migration（含 additive）也先阻擋，另經 schema-owner 流程與相容性審查。沒有自動 down migration。
- 管理員設定 repository variable `COMPATIBILITY_BASE_COMMIT`，必須是經審查、位於候選祖先的完整 commit。policy 針對 schema、managed-release readers/writers、LLM contracts、infra、CI、dependency declarations 保守阻擋；不能只更新 checksum 繞過。
- 首次受控部署新 Runtime，保留既有 args 並加入 `--require-existing-control`。該模式讀取既有 draft/active，缺資料就失敗，不呼叫 initial release creation；Worker HTTP 使用 reader-only composition，保留 `--worker` args。日常 controller 只換 image，要求此選項已存在。
- 初次舊版本相容性由管理員審查實際 image digests，放入 `APPROVED_ROLLBACK_IMAGES` JSON array。後續同一受保護 contract hash 的 revision／Job 可自動升級與回復。無相容性證據就停止，不能自動猜測舊版本可解析 release pins。
- 三服務和兩 Jobs 都先 describe；保留 command、args、SA、secrets、SQL、retry、timeout。Completion/Reconcile 必須是 `python -m hermes_agui.storage.completion_delivery`／`python -m hermes_agui.storage.reconcile`，更新至 **Host digest**；Runtime/Worker 使用 Node digest。
- 不執行 Jobs 做 smoke，不送 model run、不寫正式 API/DB。不中斷既有 execution、不改 Scheduler/queues、不改 Bot、Thread、Graph、active/draft 或 pins。
- 所有候選通過後才更新 Jobs，再逐一切流。舊 revisions 保留；完整記錄原 revision allocation 與 tags。回復以實際 revision 固定原 percentages，避免 `LATEST` 指向新 revision。
- 每次 mutation 後 read-back；切流前重查 main head、template/traffic 是否被外部修改。失敗回復已嘗試修改的 traffic 與 Jobs image；模板／traffic 出現未知變化則 `RECOVERY_REQUIRED`，停止覆蓋並要求人工復原。
- 使用 GitHub 單一 concurrency group，不取消執行中的 rollout。不承諾部署每個中間 commit；過期候選不切流。啟用期間不得同時從 Console／其他 workflow 手動部署。不是 durable lock／通用 crash recovery；runner 被強制終止時依 report、實際資源與 candidate tag 手動處理。

## 一次性管理員工作

1. 審查本修改與既有 production schema/grants、active/draft/pins；受控建立上述相容基準。既有初始化缺失另按管理流程處理，日常 CD 不補建。
2. 審查並執行 `deploy/gcp/setup-github-cicd.sh`：分離 build submit／executor／deploy／smoke SAs；WIF 限 repo ID、owner ID、main、固定 workflow/environment subject；deploy 僅三服務／兩 Jobs 更新、指定 runtime SAs 的 actAs、指定 smoke SA 的 OIDC token minting。CI 無 schema-owner／Secret Accessor。手動審查並撤除舊 shared CI 過寬 grants；setup 不自動撤權。
3. 設 `GCP_DEPLOY_SERVICE_ACCOUNT`、`GCP_SMOKE_SERVICE_ACCOUNT`、`COMPATIBILITY_BASE_COMMIT`、`APPROVED_ROLLBACK_IMAGES` repository vars。檢查資源／IAM 與 tagged URL 存取可用；Ingress 必須容許指定 CI smoke principal。缺少必要條件即阻擋，不能放寬業務驗證。
4. 設 main branch protection、required deployment CI、CODEOWNERS review。`llm-build`／`llm-deploy` environment 不設逐次 reviewer（高風險變更由 code review 與 baseline gate 分流）。完成一次受控真實候選／rollback 演練後，設 `AUTO_DEPLOY_ENABLED=true`。

## 報告與延後項目

GitHub Summary 每次記 commit、critical CI/build/deploy job 結果與 digests；release manifest 記 source/build/schema/contracts；部署 JSON artifact 記 revisions、原 traffic、config hashes、嘗試更新的 Jobs/traffic 與 `DEPLOYED / FAILED_SAFE / ROLLED_BACK / RECOVERY_REQUIRED`。報告不含 secret values 或 application data。

本階段延後完整 GCP staging provisioning、durable maintenance state machine、通用 migration controller、全面 failure injection。保留局部切流／Job ambiguity／startup／smoke／未知相容性等必要本地行為測試。真實 GCP 尚未驗證時，報告必須與本地 fake gcloud／disposable PG 分開，不宣稱已啟用 production automation。
