# 精簡 CI/CD 實作報告

日期：2026-11-26。基準 `e4789729907d5ee55c3a6b0f3a1b6184cd6b0a20`；工作分支 `cicd-streamline`。
本報告取代先前大型 staging/controller 的完成條件；歷史測試記錄仍可從基準 commit 查閱，原 evidence JSON 不代表本輪驗收。

## 交付

- 重用並縮減 `llm-ci.yml`／`llm_offline_ci.sh`，必要 gate 限 Typecheck/Build、核心 Runtime/API、disposable PG compatibility、migration/contract policy；完整 Python/Node/Playwright/Graph/scans 移至手動 `llm-acceptance.yml`。
- `llm-images.yml` 在一次性啟用後支援 main push 自動部署；dispatch 不再有 `managed_rollout_confirmed` 繞過路徑。所有 deploy 都需要同一 CI、Cloud Build、manifest、policy、readiness/smoke。
- Cloud Build 保留兩映像；增加 Host Python Jobs imports、non-root/source-label integrity（執行仍須真實 Cloud Build 驗證）。Manifest 驗證完整成功 steps、commit/source、兩 immutable digest 與精簡 gate evidence。
- `llm_rollout.py` 替換原 shell 逐一切流邏輯：先 snapshot 三服務與兩 Jobs；所有 candidates no-traffic + tagged readonly smoke 通過後才更新 Jobs／切流；切流後再做 readonly smoke，失敗恢復已改 traffic 與 Jobs image。
- Completion/Reconcile 映射 Host Python image，驗證真實 module entrypoints，保留 command/args/SA/secrets/SQL/retry/timeout，不執行 Jobs smoke。
- Schema／infra／managed LLM 契約與 dependencies 變更需要人工審查更新 `COMPATIBILITY_BASE_COMMIT`；production 不跑 migration、grants、bootstrap、reindex 或管理 API。
- Runtime `--require-existing-control` 模式只讀既有 draft/active，缺資料拒絕 startup；Worker HTTP 以既有 reader-only composition 啟動，不取得 admin control／不初始化。原一般初始化行為仍由原管理 SOP 掌控；日常部署必須已帶此 flag。
- 分離 WIF build submit/executor/deploy/smoke SAs 的一次性 setup；resource-scoped service/Job updates、指定 actAs、指定 smoke OIDC minting，不給 CI schema-owner/Secret Accessor。
- 報告包含 commit、digests、CI/build/deploy results、revisions、舊 allocation/tags/config hashes、Job 舊 image 與 deployment outcome；不保存 secret values 或 application data。

## 本輪驗證

所有測試針對本分支未 commit 工作樹；沒有把基準 SHA 冒充本輪最終 release SHA。
本地 logs：`/tmp/hermes-cicd-*`。PG17 使用原 pinned image，空白 disposable cluster；Unix socket 以本機透明 TCP bridge 連同一 cluster，不是假的資料庫。

| 驗證 | 結果 |
|---|---|
| `scripts/run_tests.sh tests/scripts/test_llm_image_rollout.py tests/scripts/test_llm_release_manifest.py tests/scripts/test_cicd_integrity.py -j 2` | 30 passed（分次驗證：manifest 13、integrity/policy 7、最終 rollout 10）；artifact/source/SQL/contract、startup/smoke、Job/切流變更後 ambiguous API failure、split traffic/tags restore、未知舊 image 阻擋、外部 template 變更停止回復 |
| `scripts/run_tests.sh tests/hermes_agui/test_server.py tests/hermes_agui/test_runtime_entrypoint.py tests/hermes_agui/test_http_lifecycle.py tests/hermes_agui/test_storage_migrations.py -j 2` | 21 passed；HTTP/SSE/auth、原生 shell、restart/history、真實 Host fresh/legacy upgrade/rerun |
| 精簡 Node `runtime/cloud/llm-registry/llm-managed-startup` | 21 passed（原核心 18、最終 startup 3）；新增 require-existing 不初始化的行為測試 |
| `npm test -- --config vitest.llm-control.config.ts --reporter=verbose` | 最終 16 passed；真實 disposable PG、grants、CAS、pins/history、readiness；新增 startup 前後 draft/active/releases/admin-event 數量保持測試 |
| `npm run build` | PASS；Typecheck + Vite bundle；後續 server/test 修改另以 `npx tsc --noEmit` 驗證 PASS |
| `python -m scripts.ci.migration_gate` | PASS；SQL/grants bytes 未改，不代表授權正式 DDL |
| 對原基準執行 `rollout_policy` | 如預期 MANUAL_REQUIRED：本次 CI/infra 管線改造屬高風險，不冒充日常相容更新 |
| `scripts/check --only footguns,health,ruff --base e478972…` | PASS，0 blocking/0 advisory（本輪 focused checks） |
| Bash syntax、workflow/Cloud Build YAML parse、`git diff --check` | PASS；不是 Actions/GCP orchestration 的 live 驗收 |

本地 image build 額外嘗試：原 Host 在 inner-container TLS CA 失敗；以環境 CA bundle 作 BuildKit secret 後 checksum 驗證成功，繼而碰到還原 checkout 的 0600 source permissions。改用 Git archive 權限的 disposable context 後，Host／Runtime builds 都在 Docker VFS layers 耗盡 63GB 磁碟時失敗。Runtime 曾在原 context 完成 build/non-root inspect，但未證明該 context 的非 root runtime 可讀性，不算 image integrity PASS。沒有更改正式 Dockerfile、關閉 TLS 或更換 checksum；只清理本次時間範圍建立的 build cache。容量不足造成的一次 rollout test run 為 0 collected/FAILED，清理後最終重跑 PASS。**本地 image gates 未完成，不能宣稱 release 可部署。**

完整 Python、Node、Playwright、Graph E2E、dependency scanners 本輪未重跑，不作為本輪必要 gate，也未把歷史失敗改標 PASS。

## Production 狀態與必要啟用工作

**程式已交付；未啟用或驗證真實 GCP 自動部署。** 沒有 push、GitHub Actions run、Cloud Build、Cloud Run mutation、IAM setup、migration 或正式資料操作。
沒有自動建立完整 staging、durable maintenance state machine、通用 migration controller 或大型 failure-injection 平台。

管理員須依 [啟用與復原手冊](../deploy/gcp/cicd/README.md)：

1. 審查本次高風險管線改造、現行 schema/grants 與所有 consumer image 相容性，設定新 `COMPATIBILITY_BASE_COMMIT` 與 `APPROVED_ROLLBACK_IMAGES`。
2. 核對／建立分權 WIF/IAM、兩 Jobs 的 Host image 與 immutable digests、固定 config/secret references；人工審查撤除舊 shared CI 過寬 grants。
3. 以既有 SOP 受控部署帶 `--require-existing-control` 的 Runtime 基準，保持 active/draft/pins；缺初始化不能由 CD 自動補建。
4. 設 repository vars、branch protection、CODEOWNERS 與無逐次 reviewer 的 routine environments。真實候選 readiness、readonly smoke、受控 rollback 演練通過後才開 `AUTO_DEPLOY_ENABLED=true`。

GitHub concurrency 與 resource read-back 只處理此精簡 image-only 流程；不提供跨 Console/其他 workflow 的 durable lock。
runner 強制終止、外部 config/traffic 競爭、未知舊版相容性會停止並要求人工判讀；不能宣稱任何情況都會自動復原。
