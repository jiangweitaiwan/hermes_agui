# Production CI/CD inventory

基準 `7c31d402dc46640084cdbe199266c0a036b931a6`；2026-11-26 盤點。
本文件只記錄已核對項目。尚未建立 staging、未執行 production mutation。

## Part 1：測試與 artifacts

| 範圍 | 既有實作／命令 | 限制 |
|---|---|---|
| Python | `scripts/run_tests.sh tests/hermes_agui -m 'not integration'` | runner 隔離 HOME、credentials、每檔程序；不可直接 pytest |
| Pipeline | `scripts/run_tests.sh tests/scripts/test_llm_image_rollout.py tests/scripts/test_llm_release_manifest.py tests/scripts/test_cicd_integrity.py` | fake gcloud／純 artifact failure injection；不是 cloud rollback |
| Node | `examples/copilotkit/package-lock.json`、`npm ci --ignore-scripts`、`npm test -- --maxWorkers=2 --testTimeout=15000` | 預設 `vitest.config.ts` 僅 `tests/*.test.ts`，不含獨立 PG gate |
| Type/build | `npm run build` | 包含 `tsc --noEmit && vite build` |
| PG | `npm test -- --config vitest.llm-control.config.ts` | `tests/acceptance/llm-control.pg.ts` 在隨機 disposable database 上測 grants、immutable history、pins、race、管理 API；缺 URL 直接 fail |
| Browser | `playwright test --config playwright.llm-control.config.ts` | `tests/fixtures/llm-control-browser-server.ts`、`llm-managed-host.py`：real PG、API、native Host、Chromium；local scripted inference／filesystem objects |
| Host migrations | `tests/hermes_agui/test_storage_migrations.py::test_legacy_prefix_and_rerun` | prefix 0、1、6；要求 `HERMES_AGUI_TEST_DB_SOCKET`，使用 cluster user `hermes`；其他 durable Python contracts 要求真正 Unix socket directory 與已 migrate 的共享 postgres DB，CI 先準備兩套 schema |
| Native restart | `tests/hermes_agui/test_cloud_native_restart.py` → `cloud_native_scenario.scenario/create_bots/learn_and_lose_ack/recover` | Docker/local fixture，不能直接作 GCP live harness；不在 offline CI 偷標 cloud PASS |
| Security | `npm audit --audit-level=high`、`scripts/ci/python_audit.py` | npm high/critical、Python 任一已知 advisory 阻擋；scanner failure 也阻擋；無預設例外 |
| Build | `.github/workflows/llm-images.yml` → `deploy/gcp/cloudbuild.llm-images.yaml` | 同一 source 產出 Host 與 Runtime/Worker 兩 digest；本次新增 source checksum、commit label、offline-CI binding 與 BUILT manifest |

`L01–L10` 僅在 `deploy/gcp/README.md` 被引用，基準 tracked source 找不到各 gate 的可執行定義。
該 README 的 `docs/cloud-native-part-2-final-acceptance.md` 連結在此 checkout 不存在。
不得把其他本機測試重新命名為已通過 L01–L10，須補齊原始定義及 live adapter。

## Migrator／Job／Tasks 邊界

| 元件 | 已核對入口 | Ledger／transaction |
|---|---|---|
| Host | `python -m hermes_agui.storage.migrate` → `main` | `hermes_agui_host_migrations.host(name)`；advisory lock `92017001`；每 SQL 與 ledger 同 transaction；Host 001–006 |
| Runtime | `node --import tsx server/storage/migrate-cli.ts` → `main` | `hermes_agui_runtime_migrations.runtime(name)`；lock `92017002`；Runtime 001–012 |
| Grants | `deploy/gcp/database-grants.sql`、`llm-control-grants.sql` | schema owner 明確執行，沒有自動 startup DDL |
| Host completion | `hermes_agui/storage/completion_delivery.py::main/GraphCompletionDispatcher.deliver` | outbox／evidence delivery；已接收工作需 drain，不能刪除或重 pin |
| Host reconcile | `hermes_agui/storage/reconcile.py::main` | expired lease／profile recovery；需核對 Cloud Run executions |
| Graph one-shot | `server/graph/worker-cli.ts::main` | `process JOB_ID`、`tick`、`reconcile`；read-only release resolver |
| Bot reconcile CLI | `server/bots/reconcile-cli.ts::main` | provisioning operations writer；也是外部維運入口 |
| Worker HTTP | `server/worker-http.ts::workerHandler` | POST `/internal/jobs/process`、`/internal/jobs/reconcile`；IAM + business token |
| Completion API | `server/graph/completion-api.ts::createCompletionApi` | authenticated ingestion；不能由一般 maintenance middleware 一律阻斷，否則舊 run 無法 drain |
| Cloud Tasks | `server/graph/tasks.ts::CloudTasksDelivery` | durable delivery rows、queue ACK 不是 publication proof |

## Part 2 前必須覆蓋的 writer／admission inventory

下列是**待實作 maintenance fence** 的 production seams，不代表目前已有 gate。
HTTP middleware 不足以覆蓋這些 CLI、child 或 DB writers。

| 類別 | 實際函式／檔案 | Maintenance 分類 |
|---|---|---|
| Host 新 run | `hermes_agui/storage/runs.py::PostgresRunStore.begin` → `001_host.sql::begin_run` | 新 admission 需在同 transaction 與 fence 序列化；不得依賴 Runtime 已暫停 |
| Native／遠端 run pin | `server/llm/control-store.ts::ControlStore.pinRun`、`server/llm/run-pinning.ts::managedRunPreparation` | 目前僅 Bot lock `53859273,1`；新 admission 需 deployment fence；既有 run 重送需保持原 pin |
| Child delegation | `server/delegation.ts::DelegationCoordinator`、`hermes_agui/delegation.py` | child 也是新 admission；不可只封 browser |
| Bot management | `server/storage/bot-registry.ts::PostgresBotRegistry.write/beginOperation/put`、`hermes_agui/management.py::HostManagement` | 新控制操作拒絕；既有 operation acknowledge/reconcile 要明確 drain |
| Release／draft／rollback | `server/llm/control-store.ts::update/publish/rollback/bootstrap/ensureInitialRelease`；`control-cli.ts` | HTTP 與 CLI 共用可信 transaction gate；不得自動 bootstrap、改 active/draft |
| Graph enqueue | `server/graph/postgres-ingest-queue.ts::PostgresDocumentIngestor.enqueue`、`session-ingestor.ts`、`ingest-cli.ts` | 新外部 ingest 禁止；已接收 completion 的因果 ingest 需可證明且保留原 release |
| Retry／cancel／rebuild／withdraw | 同 queue 的 `retry/cancel/rebuild/withdraw`，`graph/cli.ts` | 操作員與 API 控制寫入須 gate；不能自動 reindex 或任意取消工作 |
| Claim／publication | 同 queue 的 `claim/heartbeat/publish/checkPublicationPin/fail` | 已接收工作原 pin 下 drain；待 delivery 暫停後，需證明沒有 running claim；review publication 不可繞過 fence |
| Thread／profile／run outbox | `server/storage/thread-mappings.ts`、`hermes_agui/storage/host_runs.py::DurableHostRuns`、`runs.py::finish` | 既有工作寫入要完成；不能以 queue depth=0 推定全 drain |
| Source／review／Graph mutation | `server/graph/api.ts::createGraphApi`、`postgres-source-store.ts`、`postgres-wiki-store.ts` | publication、revoke、review 等 DB transaction 都需完整分類及競態測試 |

## 唯讀 GCP discovery

使用既有登入的 gcloud，僅執行 list，不讀 Secret 值、prompt 或 session。
範圍是 `copilotkit-agui`／`asia-east1`，不代表已查遍其他 projects/regions。

| 指令範圍 | 實際結果（exit 0） | 尚缺 |
|---|---|---|
| `gcloud run services list` | `hermes-runtime`、`hermes-host`、`hermes-worker` | 隔離 staging project、URL、IAM、config allowlist |
| `gcloud run jobs list` | `hermes-completion`、`hermes-reconcile` | 完整 image/template/SA/secret refs、其他 region 是否另有 consumer |
| `gcloud sql instances list` | `hermes-db`、POSTGRES_17、backup=true、PITR=true | DB/role 拓撲、ledger/grants／old-reader probes；備份可復原演練 |
| `gcloud tasks queues list` | `hermes-memory`、RUNNING | 專用 staging queue、deadlines、delivery identities |
| `gcloud scheduler jobs list` | 空 | 必須核對其他 region、既有 tick/completion/reconcile 執行來源；不能猜 Scheduler job name |

現有 setup script 共用 `github-hermes-cicd` build/deploy SA，build 使用 default compute SA；尚未分權。
本次沒有執行 setup script、沒有修改 WIF/IAM，也沒有建立雲端資源。
Production pool/Vertex quotas、GCS generations、Firebase synthetic principals、Vercel integration 均未確認。

### Jobs image mapping：計畫假設與現況衝突

已額外執行兩次 `gcloud run jobs describe`（exit 0），只輸出 image、command、已知 module、SA、secret refs、
timeout/retry 與完整 template 的 SHA256；未保存／輸出 secret 值。

| Job | 實際 command/module | Image | Template SHA256 |
|---|---|---|---|
| hermes-completion | command `python`；module arg `hermes_agui.storage.completion_delivery` | `asia-east1-docker.pkg.dev/copilotkit-agui/hermes/host@sha256:ddf54ac9ac59baa421dc80796fd3b42f588607fbc444529b0ec7be31f9bcf605` | `69aa5b1ca6d6f17222c68d33aa6fae356dda549319d4414ffa48d9e067be69a8` |
| hermes-reconcile | command `python`；module arg `hermes_agui.storage.reconcile` | `asia-east1-docker.pkg.dev/copilotkit-agui/hermes/runtime@sha256:9b8f23bbdaf364a22b1b7e50a7b65f51ef8d0f056838bb6257f6d114e6f35ca0` | `26d2e2d18c5512ad54364a0154a1e1b70f71aa39557181a6088a53e287999d8e` |

兩個 Jobs 的 SA 均為 `hermes-host@copilotkit-agui.iam.gserviceaccount.com`，timeout 120s、maxRetries 0。
Completion secret refs：`host-db-url:latest`、`graph-completion-token:latest`；Reconcile：`host-db-url:latest`。
這些 refs 不是已核對／備份的 resolved secret versions。

不能以舊 repository 名稱推定 image 內容或執行是否正常。實際配置明確要求 Python；
新的 `examples/copilotkit/Dockerfile` 以 Node 為 base、只帶 Node frontend/server，不提供 Host Python modules。
計畫 Part 2「所有 Jobs 使用同 Runtime digest」必須先修正 consumer→image mapping，並在 staging 驗證。
兩個新候選映像中，Host Dockerfile 才有 Python／`hermes_agui.storage.*`，不應為遵守錯誤假設而改掉 job command 或砍掉既有功能。
本次沒有修改任何 Job。
