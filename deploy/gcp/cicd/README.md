# CI/CD initialization and handoff

此目錄目前交付 Part 1 的 SQL integrity baseline。**不是 production enablement bundle**。
`migration-baseline.json` 只固定基準 Host 001–006、Runtime 001–012 與兩份 grants 的 bytes；
它不是相容性批准，不可當作 old-image-on-new-schema、live grants 或 migration job 執行證據。
新增 SQL 預設阻擋；不得單純重算 checksum 就宣稱取得 additive compatibility review。

## Offline gate

PR 使用 `.github/workflows/llm-ci.yml`，main build 呼叫同一 reusable workflow；沒有第二套 PG／browser 環境。
同一 disposable PG17 cluster 供 Host migration、Runtime control、browser gate 依序使用。
`llm_offline_ci.sh` 要求呼叫端已透過 lockfile 安裝 Node dependencies 與匹配 Chromium，
並設定獨立的 PM `HERMES_PYTHON`、`AGUI_LLM_TEST_ADMIN_URL`、`HERMES_AGUI_TEST_DB_SOCKET`、`CI_EVIDENCE_DIR`。
PG user 為 `hermes`，只能使用允許建立／移除隨機 DB 與測試 roles 的 disposable cluster。
Python durable fixtures 要求 Unix socket directory，CI 將 PostgreSQL service socket 掛到 runner，
並先以既有 Host/Runtime migrator 準備共享的 disposable `postgres` DB；不能拿 TCP hostname 假裝 socket path。

安全閾值：npm high/critical 直接 fail，Python 任一已知 advisory 直接 fail。
Registry/scanner 無法執行、沒有任何 audited dependency、第三方 package 被 scanner skipped 都 fail。
唯一 source exception 是本地 `hermes-agent` project（無 PyPI advisory identity；由本 repo CI 驗證），
不豁免其第三方依賴；沒有 advisory 忽略清單。若需 advisory 例外，應另以經 reviewer 批准、附 advisory、
理由、scope、到期日的 change 實作，不能在 workflow 使用 `continue-on-error` 或 `|| true`。
目前尚未提供 image OS CVE scanner；因此 offline security PASS 不等於完整 image supply-chain 驗收。

main build 從 `git archive HEAD` 產生 file-hash manifest，在既有 Cloud Build 容器驗證來源，
映像標記 source commit。release manifest 綁定 build ID、commit、兩 digest、SQL checksum 及全部 offline gate。
候選狀態僅 `BUILT`，`staging=NOT_RUN`、`production=BLOCKED`。
GitHub artifacts 供審閱，不能充當計畫 Part 2 所需 runner 外 durable rollback state store。

## 管理員初始化順序（尚未執行）

1. 提供已批准的獨立 staging project 與 environment manifest：真實 services/Jobs、DB/roles、GCS、Tasks、
   Scheduler、Firebase synthetic principals、Vertex project/region/quota、Secret **references**。
   不要填入 production DSN 或複製 production data；名稱需管理員確認，不能沿用範例猜測建立。
2. 依 inventory 的既有 compose/env/config 範例衍生 staging。盤點各 DB 的 owner/runtime roles 與 pool budget。
   Migration owner SA 與日常 Runtime SA 分開。Host／Runtime migration job 執行既有 runner；
   schema owner DSN 只由 Secret Manager 注入 migration job，CI 不取得值或 Secret Accessor。
3. Build submit、Cloud Build executor、staging deploy、production deploy、migration job executor 分權。
   WIF 限定 repo ID、owner ID、main、原 workflow path、各自 environment subject；新增 environment 前更新精確 trust。
   不執行現有共用 SA setup 當作完成分權，也不自動撤銷既有服務 IAM。
   可修改 migration job image/command 的權限等同其 SA 權限，不能給 production 日常 deploy SA。
4. 建立 runner 外 durable state/audit store、lease/fencing 權限與 recovery reader；另存 DB outage 可讀的 redacted rollback manifest。
   確認 PITR 與所需 GCS generations 可復原，不只檢查設定為 enabled。
5. 實作並以手動 SOP 先部署所有 reader/writer 的 maintenance-compatible 版本。
   用 disposable PG 驗證 admission pause race、child/CLI/writer gate、drain、expired lease、crash recovery。
   已有工作保留原 pin，delivery 與 Scheduler 只在證明 drain 後暫停，完整保存原本 paused 狀態。
6. 補齊 L01–L10 原始規格、live acceptance adapter、synthetic identity/namespace、清理權限。
   staging 執行 Vertex actual request/embedding、GCS generations、Tasks delivery、Graph、Jobs 與全 failure/rollback 矩陣。
7. 完成 Part 2 controller、migration compatibility、jobs template preservation、main-head check、production bounded smoke／metrics／recovery。
   經受控首次 staging 與 production 演練，保留 commit-bound redacted evidence。
8. 設定 main protection／required `LLM offline CI` 與 reviewer ownership；檢查 GitHub environment 無逐次 reviewer。
   最後才由管理員開啟 `AUTO_DEPLOY_ENABLED`。目前 workflow **沒有**以此變數啟動 production 的路徑。

## 目前 recovery 限制

現有 `scripts/ci/deploy_llm_cloud_run.sh` 只有 startup gate 與逐一切流，沒有 durable recovery、jobs 更新或自動 rollback。
在 Part 2 完成前，不得拿它作 unattended production controller；`managed_rollout_confirmed` 仍只屬原人工 SOP，
未被固定 true，也不代表新 live gate 已通過。需要 maintenance 的情況須依原 operations 文件由管理員處理，
不可因這次 Part 1 CI 通過就恢復流量、修改 pins、回復 DB 或啟用自動部署。
