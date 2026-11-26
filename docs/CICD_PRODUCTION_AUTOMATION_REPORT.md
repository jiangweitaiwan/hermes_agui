# Production CI/CD Automation 實作報告

日期：2026-11-26。基準／目前 HEAD：`7c31d402dc46640084cdbe199266c0a036b931a6`。
實作分支：`production-cicd-automation`；變更尚未 commit、push 或部署。
依使用者「先收尾，報告目前進度」要求，本輪停止擴充實作並交付目前工作樹。

## 結論：BLOCKED，未完成計畫全案

本輪完成 Part 1 的 inventory、離線 CI、source/artifact integrity 與 failure-injection 基礎，
**Part 1 live staging 與 Part 2 production controller 尚未完成**。
日常 push main 自動更新 GCP 的最終目標尚未達成，不可宣稱 production ready。
沒有啟用 Production 自動部署、沒有設定 `AUTO_DEPLOY_ENABLED`、沒有把 `managed_rollout_confirmed` 固定 true。
既有人工 dispatch SOP 保留，預設改為 build-only；不代表人工確認可取代新計畫的 live gate。

本次 GCP 操作僅 list inventory；沒有 cloud build、deploy、migration、IAM、secret、queue pause、
Scheduler 或 production data mutation。既有 Bot、Thread、Graph、LLM active/draft/releases/pins/history 未被本次操作修改；
這是「沒有執行 production mutation」的範圍聲明，不是成功 rollout 後資料保持的驗收證據。

## 已實作

| 項目 | 交付 |
|---|---|
| 真實入口盤點 | [inventory](CICD_PRODUCTION_AUTOMATION_INVENTORY.md)：tests、兩套 migrators/ledgers、Jobs/Tasks entrypoints、writer/admission seams、實際 GCP 名稱 |
| PR／main 共用 CI | `.github/workflows/llm-ci.yml`：PR 無 OIDC／environment／production secrets；main build 用同一 reusable workflow；單一 lockfile Python 環境與 PG17 cluster |
| 離線測試序列 | `scripts/ci/llm_offline_ci.sh`：既有 Python／Node、tsc/build、獨立 real PG 與 real API/browser configs；全部成功後才寫 commit-bound PASS evidence |
| 安全掃描 | npm high/critical fail；隔離 PM `pip-audit==2.9.0` 掃描 installed Python dependencies，任一已知 advisory／未掃描第三方 package fail；唯一 source exception 是本地 hermes-agent（無 PyPI identity），不豁免第三方依賴 |
| SQL integrity | `migration_gate.py` 與 `deploy/gcp/cicd/migration-baseline.json`：Host 001–006、Runtime 001–012、grants 固定 SHA256；新增／修改／刪除預設 BLOCKED；不重造 migrator、不執行 DDL |
| Source identity | `source_identity.py`：git archive file hashes；拒絕 symlink、被修改／新增檔案；Cloud Build 對同一 archive 驗證，映像加入 source revision label |
| Release manifest | `llm_release_manifest.py`：成功 build、兩個 exact image tags/digests、build ID、source commit/checksum、實際 code contract/task fingerprint、完整 offline gate evidence 全數一致才產生 BUILT candidate；staging NOT_RUN、production BLOCKED |
| 固定工具 | 新 Actions SHA pins、PG17 digest、既有 Cloud Build Docker builder 解析並固定 digest；保留原兩映像拓撲與候選 Host contracts |
| Review ownership | `.github/CODEOWNERS` 覆蓋 workflows、CI scripts、GCP infra；GitHub branch protection 尚未設定，CODEOWNERS 本身不等於 required review 已生效 |
| 真實 PG gate 阻擋修正 | `PostgresWikiStore.ready()` 原九表 JOIN 的 `LIMIT 0` 在基準觸發 statement timeout；改為逐表／欄位 schema probe，保留原 schema/grant 檢查；新增缺欄位 failure injection，完整 PG suite 由 red 轉為 15 PASS，未修改 migration、資料或 runtime grants |
| 單一 Python 測試環境 | 修正 Vertex flow、registry、prompts、Graph V3 四個跨語言 tests 原本固定 `.venv/bin/python` 的路徑，改尊重既有 `HERMES_PYTHON`；保留所有 assertions 與 timeout，讓 CI 共用同一 PM interpreter |
| 初始化文件 | [deploy/gcp/cicd/README.md](../deploy/gcp/cicd/README.md)，operations 文件加入目前狀態及限制 |

SQL checksum baseline 不是 reviewed schema compatibility declaration；source fingerprint 也不是 old-reader-on-new-schema 證明。
GitHub retained artifacts 不是 durable deployment lock／rollback state store。
目前 security scope 尚缺 image OS CVE scanner，不能視為完整供應鏈驗收。

## 測試與證據

所有命令在本分支 dirty tree 執行；沒有新實作 commit SHA 可冒充正式驗收 commit。
本機原始 logs 位於 `/private/tmp/hermes-cicd-*`，最終結果見本節；本機 fake/model 訊息不作 live cloud 證據。
結構化且去除敏感內容的 [evidence](CICD_PRODUCTION_AUTOMATION_EVIDENCE.json) 記錄 18 個實作檔案 SHA256、
15 組實際 gate 結果／exit codes／log hashes；不是正式 release approval。

| 命令／範圍 | 結果 | 說明 |
|---|---|---|
| `HERMES_PYTHON=$PWD/.venv/bin/python scripts/run_tests.sh tests/scripts/test_llm_release_manifest.py tests/scripts/test_cicd_integrity.py tests/scripts/test_llm_image_rollout.py -j 2` | PASS，21 tests，exit 0（最終） | 成功／不完整 build、commit/source/tag mismatch、缺少／失敗／skipped gate、digest 缺失／重複、SQL/source tampering、scanner skipped/empty/advisory 拒絕、startup failure 不切流；fake gcloud 不是真實 rollback |
| `python3 -m scripts.ci.migration_gate` | PASS，exit 0 | 基準 SQL/grants 未變；不是 live ledger probe |
| `npm audit --audit-level=high --json` | FAILED，exit 1 | 47 項：7 low、14 moderate、24 high、2 critical；`vitest`／`tinypool` critical；未加例外或 `audit fix --force` |
| `python -m scripts.ci.python_audit`（隔離 PM scanner） | FAILED，exit 1 | 掃描本機已安裝的 86 packages，`opentelemetry-api 1.45.1`：`GHSA-mf5v-w3w3-f6cg`；此本機環境缺少 agui-cloud，不代表掃完完整 CI closure |
| PM macOS test env build（標準） | BLOCKED，exit 1 | Python download CA verification failure；未停用 TLS |
| PM macOS test env build（既有 Python＋certifi CA） | BLOCKED，exit 1 | cryptography 50.0.2 native build 缺少 OpenSSL development files；未 raw pip/uv 修改環境 |
| Linux cached Host test env（非 root） | BLOCKED，exit 1 | `/opt/hermes/tools/.install.lock` permission denied；重試改為專用測試 container root，不改 production image |
| Linux cached Host test env（root，PM frozen lock） | 環境建置完成 | 重用既有 Host image 與同一 disposable PG；不是 cloud acceptance |
| `npm test -- --config vitest.llm-control.config.ts --reporter=verbose` | FAILED，exit 1 | 真實 disposable PG17.12 已連線；beforeAll 30s timeout，14 cases 未執行，不算 PASS |
| 同上，Python reader 改為已就緒 Linux env（`/private/tmp/hermes-cicd-host-python` wrapper） | FAILED，exit 1 | 仍使用同一 PG；`PostgresWikiStore.ready` line 35 schema probe statement timeout（PG 57014），14 cases 未執行；無 mock 替代 |
| 同上，修正 readiness probe 後 | PASS，15 tests，exit 0 | 同一 PG17.12，real grants、CAS、pins、prompt/history、Graph publication、初始化 rollback/retry、缺欄位拒絕；只有 model/object storage 是 fixtures，不是 Vertex/GCS live PASS |
| `playwright test --config playwright.llm-control.config.ts` | FAILED，exit 1 | real browser fixture server 30s readiness timeout；不算 browser PASS |
| 同四個 browser tests，system Chrome + 同一 Linux API/Host/PG（僅使用透明 TCP bridge） | FAILED，3 passed／1 failed，exit 1 | admin publish/rollback、owner 403、prompt/schema/playground 3 cases PASS；Native Bot case 在已收到文字回答後等待 SSE `response.finished()` 超過原 60s budget。保留 trace/screenshot，沒有提高 test timeout 或略過 assertion。僅 fixture startup budget 為 90s（跨 OS setup），仍不是 cloud gate |
| `npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000` | FAILED，exit 1 | 208 passed、3 failed、29 skipped、2 worker errors；graph-browser／wiki-ingest-cli timeout，Vertex local flow 因 Python SQLite warning contract 不符；無 live Vertex |
| Linux 重跑上述 3 files | FAILED，13 passed／1 failed／1 skipped，exit 1 | graph-browser 與 wiki-ingest-cli 全 PASS；Vertex flow 顯示固定 `.venv` 不存在（spawn status null），據此修正 interpreter selection |
| 修正後僅重跑 `llm-vertex-flow.test.ts` | PASS（mock flow），1 passed／1 live skipped，exit 0 | 真實 native session 與本機 scripted Vertex HTTP；LIVE ADC smoke 未設定，**不計入 PASS** |
| 修正同類 interpreter selection 後，`llm-registry.test.ts llm-prompts.test.ts graph-v3-runtime.test.ts` | PASS，22 tests，exit 0 | 真正 Python/TS fingerprints、dynamic snapshot/code compatibility、signed-memory verifier；未重造測試環境 |
| `npm run build` | PASS，exit 0 | `tsc --noEmit` 與 Vite build 均通過；9075 modules，14m13s；bundle size warning 保留；此 build 在最後 server-only readiness 修正之前 |
| `tsc --noEmit`（readiness 修正後） | PASS，exit 0 | 最後 server change 的型別驗證；同時通過上述 15 項 PG gate；沒有重跑未變動的 frontend bundle |
| `scripts/run_tests.sh tests/hermes_agui -m 'not integration' -j 2`（原 macOS env） | BLOCKED，exit 143 | 缺 `ag_ui` 等必要依賴、多次 timeout；保留失敗後停止本次程序樹，不算 suite PASS |
| 同上，Linux frozen PM env + 基準 source copy | FAILED，exit 1 | 98 passed、6 failed、2 errors、6 skipped；Host fresh/upgrade/rerun 3 cases PASS。初次 setup 的 TCP host 不符合部分 durable fixtures 的 Unix socket 契約，且共享 postgres DB 尚未 migrate；據此修正 CI mount 與 migrator prefill，再 targeted rerun |
| Linux corrected setup，重跑上述 6 個失敗 files，`scripts/run_tests.sh ... -m 'not integration' -j 1` | PASS，15 tests，exit 0 | 真實 Host/Runtime schemas、Node 22.18.0（cached Runtime npm lock 與 checkout SHA256 完全一致）、Unix socket↔同一 PG TCP bridge；涵蓋 delegation、completion redelivery、managed lifecycle、profile import、restart/thread history、run events。未將先前 full run 改標成全 PASS |
| 原 Host／Runtime migrator 在 shared disposable postgres fresh + rerun | PASS，四次 exit 0 | Host 首次 001–006，Runtime 首次 001–012；第二次兩者 stdout 都為空；同一 cluster，未重造 runner |
| `scripts/check --only footguns,health,ruff --base 7c31d402dc46640084cdbe199266c0a036b931a6` | PASS，exit 0 | 本次新增程式無 blocking health／ruff／encoding findings |
| `scripts/check --base 7c31d402dc46640084cdbe199266c0a036b931a6`（最終） | FAILED，exit 1 | 17 checks，僅既有 no-tmp finding 失敗：未修改的 `host-config.yaml` 與兩個歷史 artifact 共 6 處；health 0 blocking／0 advisory，其餘 checks 通過 |
| `git diff --check`、`bash -n scripts/ci/llm_offline_ci.sh`、新 Python modules compileall、三份 workflow/Cloud Build YAML parse | PASS，exit 0 | 靜態驗證；GitHub／Cloud Build orchestration 尚未實際觸發 |

原始 logs 的 SHA256、實際結果與限制記錄於最終 evidence；不以環境初始化完成宣稱 tests PASS。

Failure injection **只完成 artifact/source/SQL integrity 與既有 startup-failure 的本機範圍**。
第二服務切流、Jobs update、smoke/5xx、drain race、runner kill、lease/fencing、queue 原 paused 狀態、
old-reader incompatibility、真實 staging rollback 均尚未完成；不能將 21 tests 外推為計畫驗收矩陣通過。

## 已核實 GCP／尚需管理員初始化

2026-11-26 使用既有 gcloud 登入，唯讀查詢 `--project=copilotkit-agui`／`asia-east1`，全部 list exit 0：

- Services：`hermes-runtime`、`hermes-host`、`hermes-worker`。
- Cloud Run Jobs：`hermes-completion`、`hermes-reconcile`。
- Cloud SQL：`hermes-db`、POSTGRES_17、backup=true、PITR=true；尚未驗證可復原性。
- Tasks：`hermes-memory` RUNNING。
- Scheduler：此 region 空清單；需核對其他 region 與實際排程來源，不能猜 job name。

額外 Job describe（exit 0）確認：兩個 command 都是 `python`，分別使用
`hermes_agui.storage.completion_delivery` 與 `hermes_agui.storage.reconcile`。
SA 均為 `hermes-host@copilotkit-agui.iam.gserviceaccount.com`，timeout 120s、retry 0；
images、template hashes、secret refs 見 [inventory 的 Jobs mapping](CICD_PRODUCTION_AUTOMATION_INVENTORY.md#jobs-image-mapping計畫假設與現況衝突)。
新 Runtime Dockerfile 是 Node 映像，不提供上述 Host Python modules；計畫要求「全部 Jobs 同 Runtime digest」
與實際 entrypoints 不符，必須先修正 mapping 並驗證。沒有盲目更新或改寫 Jobs command。

未確認有已批准的獨立 staging project；已向使用者索取 project ID 與資源清單。
本次沒有自行命名／建立／覆寫 staging 資源。管理員尚需提供／建立：

1. 獨立 staging project 與明確資源 manifest、DB/roles、GCS bucket/generation policy、Tasks、Scheduler、三服務與兩個實際 Jobs、
   service identities、Secret refs、Firebase synthetic principals、Vertex quota/region。若同 project，須先完成全隔離證據。
2. 分離 build submit/executor、staging/prod deploy、migration job SA；精確 WIF trust、最小 resource IAM，CI 不取得 schema owner secret。
   現有共用 SA setup 未更改、未執行；不能視為已分權。
3. 受限、預先審查的 Host／Runtime migration jobs、兩套 schema owner／runtime grants、ledger/checksum/role probes、備份與 GCS generations 復原證據。
4. Durable deployment lease/heartbeat/fencing 與 maintenance state store、DB outage 可讀的 redacted rollback manifest/audit、告警與 metrics baseline。
5. L01–L10 可執行定義、live synthetic namespace／identity 及 cleanup 權限。原 README 引用的 gate 定義／舊報告在此基準無法定位。
6. GitHub main protection、required CI/review、staging/prod environments、無逐次 reviewer 的例行環境設定；高風險 workflow 分流。

## 尚未實作，不能以初始化資源代替的程式工作

Part 1：staging provisioning 自動化、完整 schema fresh/upgrade/least-privilege／old-image 測試、同 digest staging deploy、
live Vertex/GCS/Tasks/Graph/Completion/Reconcile acceptance、immutable durable release evidence 與 image security scan。

Part 2：durable controller/state machine、main-head eligibility、preflight snapshot/compatibility/backup probes、migration controller、
可信 application/DB maintenance gates、drain/fence、Jobs template preservation、production smoke/observation、
partial traffic/jobs rollback、crash read-back recovery、保留原 queue/Scheduler 狀態、通知/audit，以及全部對應 failure injection。
目前沒有加入空殼 controller、fake PASS 或只有 HTTP middleware 的 maintenance 替代方案。

依計畫 Part 1 → Part 2 順序，先補足隔離 staging 與上述 CI/security blockers，再完成並測試 controller；
最後經受控 staging／production 首次演練後，管理員才可開啟 `AUTO_DEPLOY_ENABLED`。
**目前不得啟用自動 CD。**

## 收尾狀態

最後 TypeScript check 與本次變更的 footguns／health／ruff 均 exit 0；health 共 12 files，0 blocking／0 advisory。
本次建立的 disposable PG、Linux test containers、Node dependency source container、browser proxy 均已停止／移除；
原有 cached images、使用者既有容器及工作樹原有文件刪除保持原狀。測試 logs、browser failure trace/screenshot 保留於 `/private/tmp`。
沒有 commit、push、PR、GCP provisioning 或 production rollout。後續工作須從本報告列出的 failed／未實作 gates 繼續，
不能將本輪收尾視為整體改造完成。
