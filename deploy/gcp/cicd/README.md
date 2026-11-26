# 精簡 CI/CD 啟用與復原

完整規格見 [精簡計畫](../../../docs/CICD_PRODUCTION_AUTOMATION_PLAN.md)，實際驗證見 [報告](../../../docs/CICD_PRODUCTION_AUTOMATION_REPORT.md)。

- `llm-ci.yml`：PR／main 共用精簡 deployment gates；只使用 disposable PG，沒有 production credentials。
- `llm-images.yml`：通過 CI 後 Cloud Build；一次性 `AUTO_DEPLOY_ENABLED=true` 後 main push 自動部署。dispatch 預設只 build，選 deploy 也不能略過任何 gate。
- `llm-acceptance.yml`：手動獨立 full Python/Node/browser/Graph/scanner acceptance，不阻擋一般 push。
- `migration-baseline.json`：SQL/grants bytes integrity，**不授權 migration**。本管線永不執行正式 DDL。
- `rollout_policy.py`：相對 repository var `COMPATIBILITY_BASE_COMMIT` 阻擋高風險改動。首次引入管線本身需人工審查並設定新基準；不能用舊基準宣稱本次 infra 變更是普通更新。

## 一次性設定

依計畫審查 WIF/IAM setup，分離 build submit/executor/deploy/smoke 身分；不使用 service account JSON key。
設定 repository vars `GCP_DEPLOY_SERVICE_ACCOUNT`、`GCP_SMOKE_SERVICE_ACCOUNT`、`COMPATIBILITY_BASE_COMMIT`。
另設定 `APPROVED_ROLLBACK_IMAGES` 為經審查的**完整 immutable image URLs JSON array**；不要把 tag 或未驗證 image 放進去。
後續同 contract label 的已部署 image 可自動相容；contract 變更需重新審查現有所有 consumers。

Runtime 既有 args 必須包含 `--require-existing-control`，且既有 active/draft 已就緒。首次以原管理 SOP 部署此版本並加該 flag；CD 不會替你初始化資料或重寫 args。
兩 Jobs 必須已有正確 Python command/args、不可變 image、service identity、SQL/secrets/timeout/retry；controller 只換 Host image。
保留 private Cloud Run IAM，指定 smoke SA 只有三服務 invoker，deploy SA 只可為該 smoke SA mint ID token。CI 不讀 application tokens。
啟用前核對 secret/config versions 與相容基準；凍結 secret mount references 的不相容改動，不能在 rollout 中改指向內容。

## 失敗與復原

候選使用 `ci-candidate` tag，沒有正式 traffic。GET `/health` 驗證 startup；另一個無 app credential 的 GET 必須 401/403。這不驗證 live inference，且不呼叫會寫入的 API／Job。
全部候選通過後更新 Jobs，再切流；最後對正式 URLs 做相同 readonly smoke。
startup/smoke 失敗不切流；部分更新失敗依已保存 allocation（包含 split traffic）與舊 Job image 回復，read-back 驗證。
保留原有 tags，移除自己的 candidate tag；不刪除舊 revisions、不執行 down migration。

若 report 為 `RECOVERY_REQUIRED`、runner 被強制終止，或發現既存 `ci-candidate` tag：

1. 關閉 `AUTO_DEPLOY_ENABLED`，避免另一個 rollout；不要與 Console/其他 workflow 同時寫入。
2. 下載 `llm-deploy-report`／release manifest，唯讀比對三服務 traffic/tags/revisions、兩 Jobs template/image、已審查 contract/schema。不要回復資料庫或 release pins。
3. 只有能證明相容才將**已改變的** traffic/Jobs 回復報告的版本；若資源已被外部修改，先人工判讀，不能盲目 replay。
4. 驗證 readonly smoke、移除本次 candidate tag，再重新啟用。GitHub artifacts 不是 durable controller；硬終止後不承諾自動續跑。

本地 entrypoint：設定 PM test interpreter、disposable PG URLs/socket、`CI_EVIDENCE_DIR`、reviewed `COMPATIBILITY_BASE_COMMIT`，執行 `bash scripts/ci/llm_offline_ci.sh`。
正式執行只由 main 上的 workflow 使用 WIF。缺少基準、相容證據、schema、IAM 或 startup readiness 一律停止，不以人工 boolean 繞過。
