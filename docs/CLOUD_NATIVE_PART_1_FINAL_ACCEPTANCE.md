# Hermes AG-UI — Cloud-native Part 1 Final Acceptance

> 最終驗收收尾計畫｜執行者：Codex
> 
> Repository: https://github.com/jiangweitaiwan/hermes_agui.git  
> 文件日期：2026-11-19  
> 審查基準：`c0d2e5990f1a708debfdab181e449c141189a0c3`（main，commit message `add:part1-4`）  
> 建議放置：`docs/CLOUD_NATIVE_PART_1_FINAL_ACCEPTANCE.md`

## 1. 任務定義與停止條件

本輪唯一目標：完成 Part 1 尚未通過的驗收，形成有可重現證據、可直接交接 Part 2 的候選版本。本文件延續 `docs/CLOUD_NATIVE_PART_1_REMAINING.md`，不是新增架構階段，也不是重新實作 A/B/C。原先的功能、安全、隔離、資料持久化及驗收契約依然有效。本文件細化執行及證據要求，不自行豁免既有 gate。

以 `docs/cloud-native-part-1-report.md` 最末節 2026-11-18 紀錄、`docs/cloud-native-part1-status.json`、`docs/cloud-native-part1-validation.md` 為基線。停測紀錄的候選是 `ae7d7ae51eca59c49a79ef47f7d086fb23f0798a` 加未提交工作樹；本次查閱 main 已為 `c0d2e599…`，不可把兩者或過往 image PASS 視為同一候選驗收結果。執行時以實際 HEAD、工作樹、文件和測試為準。保留 owner 的未提交變更，遵守最近的 `AGENTS.md`。

完成定義：除 owner 已明確核准 fresh scope 所對應的「歷史全量遷移 N/A」外，Part 1 必要 gate 皆有同一候選的 PASS，雙應用容器實際刪除全部可寫層後，僅透過部署模板、秘密、外部 PostgreSQL 和 object storage 恢復已提交狀態。完成後才允許進入 Part 2。真 GCS/IAM/PITR 等 Part 2 項維持 NOT RUN，不能用 double 代替。

不進行 Cloud Run/GCP/Vercel 部署、不建立付費資源、不新增 Cloud Tasks、Scheduler、Firebase、SSE replay/cross-instance cancel、不重寫 Agent Core、Graph compiler/retriever、前端或原生 SQLite session backend。只因有可重現驗收缺陷才修改產品程式碼；新增必要驗收及診斷功能不算擴張業務功能。

## 2. 已知剩餘驗收與凍結範圍

| Gate | 最新報告狀態 | 必須補齊的證據 |
|---|---|---|
| Legacy regression | FAIL | Runtime 19 檔 115 passed、2 failed、另 1 worker RPC timeout；Python 全套及 PG probe 未到達；multi-Bot browser 未完成。 |
| Storage | NOT RUN | 真 PG、object double、故障注入、安全授權、fail-fast 及新增 importer 在同候選重驗。 |
| Graph | NOT RUN | PG + evolution、CJK、embedding、browser、retrieval/context injection、撤銷與授權，在最終候選重驗。 |
| Job | NOT RUN | durable job / completion、雙 worker/fence、publication/complete 同交易及重送，重驗最後增量。 |
| Provisioning | NOT RUN | desired/applied revision、ACK loss、reconcile、busy-run 新增斷言及雙服務一致性。 |
| Restart | FAIL | 新一次 PostgreSQL readiness 40s timeout；前次跑到原 thread prompt cache 相容性斷言；修正版完整 scenario 未過。 |
| Migration | NOT RUN / 未核准 | scope 決策；新增 importer compatibility tests；若保留舊資料則仍缺全量歷史遷移。 |
| Build | FAIL | 歷史 Docker/TS/Vite 通過但 repository-wide check 失敗；須覆核最後一致候選。 |
| GCS/IAM/PITR | NOT RUN（Part 2） | 不在本輪做實雲項。 |

凍結已接通的主要機制：Host immutable profile snapshot + fenced lease + transactional manifest/terminal/outbox；Runtime PG registry/mapping；Graph PG source/wiki/index/job + object adapter + 現有 compiler；desired/applied provisioning。保留 local mode 和 AG-UI/API 語意。不要把成功 turn 的 SQLite backup 改成 live SQLite on object mount，亦不要新增其他 DB。

核心系統現有契約：Host 只在成功 turn 發布 profile，未提交 memory/skill 可能遺失；沒有工具級 checkpoint 或 exactly-once 外部副作用。模板技能由部署重建，自建技能依逐檔 allowlist 才持久化；snapshot 最大 64 MiB/256 項；Wiki 預設 256 KiB/1000 pages，source 1 MiB。維持原 session_home_identity、scope、checksum、generation、CAS、DB clock/fence 和秘密隔離。既有 unreferenced objects 保留策略不改，未來 GC 至少七天寬限並對全部歷史引用對帳。

## 3. 工作包 F1：修復／聚焦驗證（先完成，不反覆跑全套）

### F1.0 凍結基線、環境與遷移門檻

1. 讀本文件及前述文件，另讀原 Part 1/2 計畫和 inventory。`git rev-parse HEAD`、`git status --short`、`git diff --stat`、必要 untracked 清單，記錄來源版本和工作樹雜湊；不得覆蓋或清除 owner 工作。若本機已比審查 SHA 新，先對照最新變更，不回退。
2. 使用 Node 22.18+（固定實際版本）、repo lockfile 的 dependencies、Hermes PM interpreter（agui/agui-cloud/dev/test），PostgreSQL 17+ UTF-8、可用 Docker daemon 和 Chromium。記錄 CPU/RAM/磁碟、Docker 資源分配、版本、port/loopback/shared memory 權限；如 sandbox 不許必要本機資源，取得正常授權或用可信 CI runner，不 mock 掩蓋。必要測試全部在同一 OS/run 配置；無足夠資源則使用獨立 runner。
3. PostgreSQL test cluster、容器及 object volume 一律新建可丟棄。禁止把 migration/reset/cleanup 指向現有使用者 DB 或使用全域 Docker prune。測試 scope/DB/port 隔離；秘密、DSN 密碼、bearer token、LLM credential 只走受信任 env/模板，證據須遮罩。
4. 所有重型階段串行：Vitest、Python、瀏覽器、Docker build/restart、repository check 不同時跑。確認前一步 child process、port、timer、pool、container 已退出；開發聚焦測試可使用低 worker 數。禁止將 source/report 的舊 log 當本輪證據。不得因使用 retry 才成功而隱藏首輪失敗。
5. 先按第 4 節取得 migration scope 決策（不必阻塞非破壞性 fresh 測試）。如無 owner 決策，仍可完成其他 gate，但最終停在 BLOCKED，不進 Part 2。

環境準備直接沿用 `docs/cloud-native-part1-validation.md` 的 PM、一次性 Unix socket PG 和 migration 步驟：Host 001–005；Runtime 001–007（若 HEAD 有新 migration 應按實際順序記錄）。`tests/hermes_agui/cloud_native_grants.sql` 是 fixture grants，正式服務不可使用 migration owner。

```bash
# repo root；按原操作文件建立 HERMES_PYTHON 及可丟棄 PostgreSQL test cluster。
node --version
"$HERMES_PYTHON" --version
docker version
docker info
# HERMES_AGUI_TEST_DATABASE_URL、HERMES_AGUI_TEST_RUNTIME_DATABASE_URL、
# HERMES_AGUI_TEST_DB_SOCKET 必須指向該次獨立 test cluster。
scripts/cloud_native_part1_check.sh migrate
(cd examples/copilotkit && npm ci)
```

`migrate` 對空白 test DB 執行一次，必要時新建 database 不在不明資料庫重跑；依原操作文件限制和 fixture 行為重建。若依賴已裝則先驗證 lockfile 一致性，不必每次重裝。準備 browser binary（若需指定 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`，使用實際安裝路徑）。

### F1.1 Runtime timeout 與 RPC error

檔案：`examples/copilotkit/tests/graph-browser.test.ts`、`examples/copilotkit/tests/wiki-ingest-cli.test.ts`、`examples/copilotkit/vitest.config.ts`。舊報告的 timeout 為 work-bounds 30 秒、CLI 60 秒、另 worker RPC timeout。資源爭用仍是假說，不能直接標環境假失敗。

先在無其他重型套件執行的安靜環境，依序跑：

```bash
cd examples/copilotkit
npm test -- tests/graph-browser.test.ts --reporter=verbose --maxWorkers=1
npm test -- tests/wiki-ingest-cli.test.ts --reporter=verbose --maxWorkers=1
```

如再失敗，先取出測試階段耗時、child stdout/stderr、CPU/RAM/OOM、PG/SQLite lock、HTTP fixture lifecycle、worker exit/open handles 等。Graph work-bounds 檢查實際掃描/輸出上下界、keyset traversal、edge 上限及 DB 查詢／fixture 初始化；不得縮小資料集或移除 bounds 斷言換綠燈。CLI 驗證 execFile 子程序、tsx 啟動、mock HTTP server、關閉連線及退出；保留可信 CLI ingest/compile/report/revoke/rebuild 全流程。RPC error 確認 worker 停止、OOM/IPC 而非直接放寬 worker timeout。逐項區分環境不足、fixture 效能和產品 bug。若改測試期限，需量測證明其必要性，保持 bounded deadline、失敗條件和 diagnostic；禁止只拉長 timeout，不使用固定 sleep。

F1.1 完成：上述檔案在隔離環境通過；若有 timeout 修正，相關失敗情境有明確根因與可重現修復證據。最終仍須 F2 全套 Runtime PASS，不能用 focused tests 代替。

### F1.2 新增 importer、busy-run 與故障注入測試

沿用現有測試，不另寫新的 test harness。確認最終 runner 的收集範圍包含以下新增／既有檔案，必要時先聚焦驗證（不要從舊報告搬測試數）：

```bash
# repo root；使用已遷移的獨立真 PG 環境
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh -j 1 \
  tests/hermes_agui/test_profile_import_compatibility.py \
  tests/hermes_agui/test_dynamic_host.py \
  tests/hermes_agui/test_dynamic_runtime.py
(cd examples/copilotkit && npm test -- tests/bot-import-compatibility.test.ts tests/bot-operations.test.ts --reporter=verbose --maxWorkers=1)
```

執行前核對動態測試的實際檔名與 `versioned busy-run` 測例位置（以 HEAD 中 `rg` 為準）；如版本已改名，以 repo 實際路徑替換，不新增同名空檔。上述範圍若會互相清 DB，使用新的 DB/scope 或依既有 harness 輪替。

重驗 Host 與 Runtime 既有 offline importer：dry-run 與真匯入、穩定 session identity、manifest integrity、欄位預設值、credential 不入庫、重跑/拒絕覆寫符合原契約，新 schema 第一次 reconcile 正確建立 desired/applied operation。busy-run management 保留原 admission/fence 規則；在兩服務實際拒絕狀態衝突、不因舊 ACK 或延遲操作復活 Bot。若有增量改動須聚焦覆蓋原始缺陷。

對照 F2 矩陣確認真 PG storage / Graph / Job / Provisioning 的既有 focused tests 列入最後一輪。以下檔案優先定位：`tests/wiki-postgres.test.ts`、`tests/wiki-postgres-sources.test.ts`、`tests/graph-browser.test.ts`、`tests/bot-operations.test.ts`，以及實際存在的 durable job/worker/evolution suites（位於 `examples/copilotkit`），Host `postgres_storage_probe`、profile/delegation/dynamic tests。不要求在 F1 再跑完整 A/B/C；缺覆蓋才新增。

### F1.3 雙容器 Restart：修復且預驗完整 scenario

優先使用現有 `tests/hermes_agui/test_cloud_native_restart.py`、`cloud_native_scenario.py`、`cloud_native_host.py`、`examples/copilotkit/tests/fixtures/cloud-native-runtime.ts`、`cloud_native_grants.sql`、`Dockerfile.agui`、`Dockerfile.agui.part1-test`、`examples/copilotkit/Dockerfile`。

已知最新錯誤出現在 `ContainerScenario.initialize()`：`wait_until(database_ready, timeout=40, what="PostgreSQL container ready")`，psycopg 經 Docker 映射 port 連真 PostgreSQL。先在獨立 Docker 環境執行；若重現，收集 PG image/platform、container Running/ExitCode/OOMKilled、`docker logs`、`docker inspect` 安全摘錄、pg_isready、映射 port/socket 及真 SQL ping。當前 `database_ready` 把 OperationalError 折成 False，應補充最後錯誤與 elapsed，不在 log 中輸出完整 DSN 或 secret。確認 PostgreSQL init、port mapping、CPU/RAM 和磁碟等。以 readiness predicate + 有界 timeout + 可診斷失敗作為修復方式；可在實測後合理配置 deadline，不使用固定等待，不大幅放寬而不解釋。確保 container 退出能立即 fail，cleanup 不吞主錯誤，失敗同樣保存 logs。只清前綴/ID 對應本次 fixture 的資源。

沿用既有 TLS fixture（Runtime hostname HTTPS 及受信 CA），不要改寬 dispatcher 安全限制。fake LLM 只替代外部模型，PG 真實、object store 外置且不是應用 writable layer。確認兩容器 read-only、fresh tmpfs、沒有舊 home/workspace/graph 持久 volume；fixture 的部署 bind mount 不可用於保存業務 state。可在實際運行環境使用既有 `host.docker.internal`/host-gateway；若需平台相容修正，維持隔離及真實 HTTP。

如前次 image 不是當前原始碼 build，先建立該候選 image；在 F1 開發階段只在相關 source/build 有變動時重建。驗證既有正式 images 的 entrypoint、PORT/config/readiness 和失敗行為（不依賴 test-only endpoint 或 production root 可寫），另用專用 test fixture image 跑 scenario。F1 若候選最終沒有再改，可依第 5 節規則一次取證，不強制重跑相同完整 scenario 兩遍。

```bash
# 正式 build + scenario；也可直接在 F2 執行，避免重複 build
scripts/cloud_native_part1_check.sh container
# 已確認三個 images 都來自同一候選時，僅重跑 scenario：
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh -j 1 --file-timeout 600 \
  tests/hermes_agui/test_cloud_native_restart.py -m integration
```

必須整個 scenario 通過，不止 PostgreSQL 啟動。共享 scenario 斷言以第 5 節 Restart gate 為準。報告的舊 prompt-cache 錯誤不可用改 Core 方式修掉：舊 thread 應驗證已提交 transcript、tool/result、原 native session ID，並成功呼叫 skill_view；新 thread 才驗證 persistent memory 進入 system prompt。必要時增強對兩 owner、跨 Bot、共享 retrieval、Host applied disable 狀態等的驗收證據；不可刪現有任何安全斷言。若沒有 Docker，process-level proof 僅作診斷，本文件不申請延期例外；完整 Restart gate 不可 PASS。

### F1.4 修復 repository-wide check

已查閱 `scripts/check`：包含 guard、diff guard、ruff、health；`scripts/code_health/config.py` 為 blocking。目前 git tree 的 `scripts/ci/` 有 `list_os_marked_tests.py` 及 `profile_scope_patterns.json`，卻缺 `scripts/check` 所引用的數個 helpers；根目錄沒有 `package.json`。不視為 cloud 功能 bug，也不擅自跳過原報告列出的 Build blocker。

1. 先保存 baseline 的 `python scripts/check --base <BASE_SHA>` 結果，逐項定位 missing file、no-tmp、health toolchain、其餘真實失敗。用 `git log --all -- <path>`、刪除歷史及 `scripts/check` 的來源版本確認是否 fork 精簡造成；對照與目前版本相容的可證來源（必要時 upstream Hermes 的匹配 commit，不盲抓最新）。優先以最小改動恢復真實 guard helper 和其依賴，保留授權與來源資訊；不得寫永遠 exit 0 或建立空檔。
2. `scripts/ci/` 缺失候選依目前 `_GUARDS`/`_DIFF_GUARDS` 實際查核：`check_os_marker_fakes.py`、`check_agents_md_size.py`、`check_line_endings.py`、`check_lazy_deps_imports.py`、`check_profile_archive_boundary.py`、`check_blob_size.py`。記錄所有缺項及修復，不假定只有這六個問題。
3. `docs/CLOUD_NATIVE_PART_1.md` 原 no-tmp 違規：修改該處為符合 repo 的可攜式 scratch/temporary directory 寫法，保留歷史設計意義／範圍；僅合法說明性例外可按原 guard 註解，不添加 blanket allowlist 或抬高 baseline。
4. health 的 root manifest 問題：定位 `scripts/code_health/` 實際 TS metrics runner、root/package dependencies discovery；此 fork 的真實 Node package 在 `examples/copilotkit` 等工作區。選擇有依賴的實際 package root 或修正工具能從正確 roots 執行所有適用 TS checks；不要只造空 root package.json、跳過 TypeScript 或把 ENFORCEMENT 切 advisory/off。必要時修復工具依賴及 lockfile，證明掃描範圍未縮小、同一變更有相同 metrics engine/門檻，補測多 package 路徑。原報告的聚焦 CC≤20 不能替代完整 check。
5. 若恢復 upstream 工具需重大範圍變更，先完成其他 gate，提出可驗證的最小修復方案及差異。只有 owner 可明確修改 repository guard 適用範圍；不得宣稱完整 check PASS，也不得放寬 cloud domain 的 lint/safety/health。預設本輪要求全 repository check PASS。

最終鎖定候選後用真實、固定、早於本輪改動的 base 和 candidate SHA 檢查，不能以新 HEAD 作自己與自己的 diff。若可由 git history 證明 `ae7d7ae…` 為 Part 1 收尾比較起點，用它量測歷史收尾變更；本輪修復起點亦記錄，必要時依原 CI 政策使用實際 merge-base。所有必要 guard 真正執行、nonzero 必須反映到 Build。不更改全域 enforcement 或繞過本機 hook/CI。

## 4. Migration scope：owner 明確決策（建議 fresh_deployment）

2026-11-19 owner 已核准首次部署採用 `fresh_deployment`，保留既有本機資料，不要求全量歷史資料遷移，仍須通過 importer 相容性及新資料重建驗收。歷史全量遷移記 N/A，不代表可直接切換既有使用者。

推薦首次 GCP staging/deployment 採用全新 database 和 bucket/prefix，不搬開發階段的歷史資料；此為計畫作者建議，不代表 owner 已核准，不刪除本地資料。保留舊資料和已有 import 工具。可先完成非破壞性 fresh 測試。

owner 可在交給 Codex 的指示中明確寫：

> 我核准 Part 1 / Part 2 首次 staging 採用 `fresh_deployment`；保留既有本機資料，不要求全量歷史遷移，仍須通過 importer 相容性及新資料完整重建驗收，不可宣稱可直接切換既有使用者。

若收到該核准：歷史全量遷移記 N/A（非 PASS），但 Migration gate 的 fresh schema、importer compatibility、重建仍必須 PASS。記錄批准日期、用語及資料保留策略。

若 owner 選 `preserve_existing`：仍屬本輪真正未完成工程，須先補足歷史 thread mapping、Graph sources/revisions/active pointers/provenance/ACL/jobs/index 遷移與跨服務對帳。停既有 writer、建立 SQLite consistent backup，保留 native home identity，dry-run、不覆寫、可安全重跑、stable IDs/scope/timestamps、counts/checksum/orphans/report、可追溯 rollback 方案。未知歷史 browser thread 不得捏造；pending/running job 記安全重試策略，避免重放 Agent/tool 副作用。索引可重建但需驗證 retrieval。只在隔離副本做測試，不操作實際使用者資料；全量 importer 驗收 PASS 才能交接既有使用者部署。不要將 preserve 路徑用少量 smoke 代替。

若尚無核准：Migration gate = NOT RUN / BLOCKED（scope）；不自動進 Part 2。可將其餘已過 gate 如實交付。

## 5. 工作包 F2：單一候選完整驗收（只一次總體驗收）

### 5.1 候選與 runner

F1 可做聚焦修復，不每次重跑所有 suites。待缺陷修復完成，建立可識別的本機候選 commit（若 owner 要求不 commit，使用完整檔案 manifest+雜湊，包含未追蹤來源）。禁止重寫歷史、擅自 push/merge。從候選 fresh checkout 或可驗證工作樹建立鎖定依賴、fresh DB、fixtures 和 images；保存 SHA、source manifest、env versions、image IDs/digests。驗收時原始碼不再改動。測試不可混用不同候選版本的結果。

沿用 `scripts/cloud_native_part1_check.sh`（現有 migrate/regression/browser/container 四個 mode）及 `just cloud-native-part1 MODE`。建議最小擴充 runner 的 evidence/summary（不必另造框架）：每步 exit code、elapsed、開始/結束、stdout/stderr 安全 log、預期必跑項和 skip、候選 SHA。regression 原本 `set -euo pipefail` 在第一個 Vitest FAIL 就停止，導致後續 suite 無結果；可保留 fail-fast 各 mode，並由串行總控繼續執行互不依賴的後續診斷 gate，最後任一必要 gate 非 PASS 則非零退出。setup 失敗時依賴步驟標 NOT RUN，不偽造結果；不使用 `|| true` 使 gate 成功。

### 5.2 串行順序（同一機器不重疊）

```bash
# 先按 validation 文件建立 fresh test PG 和 PM interpreter；空庫 migrate 一次
scripts/cloud_native_part1_check.sh migrate
# 若此候選已完成相同 fresh setup，不要再對同一 DB 執行 migrate
scripts/cloud_native_part1_check.sh regression
scripts/cloud_native_part1_check.sh browser
scripts/cloud_native_part1_check.sh container
# BASE_SHA、CANDIDATE_SHA 由真實 git history 設定，均不能是空值
"$HERMES_PYTHON" scripts/check --base "$BASE_SHA" --commit "$CANDIDATE_SHA"
git diff --check "$BASE_SHA" "$CANDIDATE_SHA"
git diff --check
```

分別記錄每個 exit code；以上是串行步驟而非把 bash 貼成忽略失敗的總控。regression 實際已包含 Runtime Vitest `--maxWorkers=1`、真 PG probe、Python AG-UI `-j 2` 且 retries=0、TS/Vite build、local/PG fixture。若測試機資源不足，Python worker 可降至 1 並記錄，不改測例。browser 已包含四種模式；container 已包含三個 images build + integration scenario。必要時加 `npm ci`、正式 image smoke、runtime/host role fail-fast 等明確獨立子步。已用同候選源、依賴、config 完整通過的 F1 子步（例如完整 container scenario）可以在 F2 引用原始一手證據，避免重複 build/run，但需確認 candidate digest 未變、所有本輪 gate 斷言均已覆蓋；focused 不可代替 full suite。

若中途產品、fixture、依賴或 runner 修改，建立新候選並使受影響證據失效；先聚焦重驗，再為新候選跑完整必要 suites，除非只是純報告文字改動且有 source digest 證明與 gate 無關。不得以新修補版本沿用舊產品候選的完整 PASS。若多次相同 failure 停滯，報告具體根因或未定位證據、最小下一步，不無限重試、不刪斷言、不直接轉 Part 2。

### 5.3 Gate 矩陣：最低可接受證據

| ID | Gate | PASS 必要條件及一手證據 |
|---|---|---|
| G1 | Legacy regression | 完整 Runtime Vitest、Python AG-UI、既有 native/delegation/memory/Graph regression、browser 預設 + GRAPH_MEMORY_TEST + DYNAMIC_BOT_TEST + MULTI_BOT_TEST 無必要測試 fail/skip。對照實際 collection/JUnit 與指定模式所覆蓋的 skips；不要求計數恆等過往報告。真 PG probe 必須執行。 |
| G2 | Storage | local/PG adapter 等效；真 PG schema、run lease、fence、manifest CAS、rollback、immutable object integrity、scope、角色跨 schema 拒絕、缺 migration 和 DB/object backend fail-fast；不 fallback SQLite。Importer compatibility 必過。終止成功須在 commit 後。已逾 lease writer 不可提交。 |
| G3 | Graph | 真 PG+evolution，source ingestion、private/shared provenance、source revocation during compile/read、revision checksum/CAS、browser pagination/bounds、active revision、當前 registry ACL、retrieval/context injection；正常 embedding 開關／model/dimension/revision，禁止降級或關閉測項。local/PG 繁中 fixture 同 encoder/設定比較，基線 recall@3 為 0.50/0.9167/1.00，不退化；MRR/noise/排序差異應記錄而非宣稱真模型品質／雲端效能。 |
| G4 | Job | 真 PG 兩獨立 worker/process claim/heartbeat、DB clock/過期接管、舊 token 禁止發布，重送 idempotency，有限 retry，shutdown 可恢復，revocation、object upload fail、SQL rollback、同頁不同 job CAS 後 merge，publication/completion 同交易。Host completion await durable enqueue 才 ACK；ACK lost 重送不增 source/job，無雙重 stream ingestion。 |
| G5 | Provisioning | desired/applied revisions 與 durable operation；兩 Runtime、duplicate/update、ACK lost、restart reconcile、舊 ACK、低 revision、scope/spec collision、disable/delete 防復活、busy run/admission；權威 status/兩 registry 對帳。Runtime 意圖提交即拒絕；Host 套用後拒絕；網路分割窗口誠實記錄。 |
| G6 | Restart | 真 PG+外部 object double，兩應用容器刪除/重建；完整共享 scenario 加下節證據。Docker image ID/容器 ID、mount 資訊、前後 DB/query/manifest/native session assertions。process-only 不足。 |
| G7 | Migration | owner 明確 scope；fresh 路徑既有 importer compatibility + fresh restart PASS，歷史全量遷移 N/A；或 preserve-existing full dry-run/import/re-run/reconciliation PASS。owner 未決定不得通過。 |
| G8 | Build | TS/Vite、Python lint、git diff --check、完整 repository-wide scripts/check、本候選正式 image build/setup/smoke、test fixture image scenario；guard 真執行，無全域豁免。 |

同一 case 可支援多個 gate；不用為各 gate 重複跑同一套 E2E。真 GCS/IAM/PITR 單獨標 Part 2 NOT RUN，不列入 G1–G8 的本地 PASS 判定。

### 5.4 G6 共享 Restart 驗收：逐項證據清單

2026-11-19 owner 核准依既有 **run-local untrusted reference** 契約驗收 Graph 注入。
`agent/runtime_reference.py` 只在送往 provider 的當前 user message 副本附加獨立 reference 部分，保留 system prompt 與已存 transcript；本節原「system context」措辭依此更正。測試須處理 multipart content、驗證完整知識與來源／ACL、分享前不可見及 system prompt 不變，不改 Core。既有 session reference v1 的 Bot/thread 與 record revision 綁定 Graph Browser active revision／原 run provenance；document reference v2 仍由原完整 suites 驗證。

沿用現有 `create_bots → learn_and_lose_ack → recover`，不另建另一套 E2E。現有 helper 使用真 PG 容器及外部 volume；測試 fixture 中可直接控制 lease expiry，獨立真 PG worker tests 補實際 fencing 競態。至少保存：

- [ ] 開始時角色分離、兩 schema migration、兩服務 readiness、外部物件儲存、read-only container + fresh tmpfs；應用不能以對方 schema owner 執行。
- [ ] 透過實際 Runtime API 建立同 owner Bot A/B 及另一 owner Bot C；確認跨 owner/private Graph API 拒絕。bot/thread/run IDs 與 scope 記錄。
- [ ] A 由 fake LLM 真正呼叫 native memory、skill_manage（核准 `skills/notebook/SKILL.md`）；成功 terminal、DB committed manifest 含 `state.db`、`memories/MEMORY.md`、skill，且 native session/tool-result 正確。不能 mock profile 或 DB commit。
- [ ] Host completion 已 durable 入列但 ACK 遺失；完成 Graph job/active revision、CJK 檢索；撤銷、source provenance、獨立 worker takeover 和舊發布拒絕至少由 G3/G4 真 PG suites 證明，不把未驗證分支假稱 scenario 已內建。
- [ ] 真正 stop + rm -v 兩應用容器，記錄舊/new 容器 ID 不同、fresh scratch、mount 前後；只保留 PG、外部 object volume、部署配置和秘密；不掛載原 home、workspace、session DB 或 Wiki local files。PG/object 的資料應可證明無重建或清除。
- [ ] 使用相同 thread mapping 跟原 native session ID 續聊、完整歷史含 tool/result，實際調用 skill_view 並確認內容。不要要求舊 thread system prompt 即時重載記憶（per-conversation prompt cache）。另建新 thread 驗證 memory 真的進 system prompt。原既有 skill 和 memory 斷言不得弱化。
- [ ] 重送未 ACK outbox，原 idempotency；job/source 未重複、原 DB 狀態與 profile 可讀、原完成 run 保持 completed。應直接驗 source/job batch 或 key 數，不能僅用 HTTP 200 代表成功。
- [ ] Graph Browser/retrieval 可讀原 active revision；B 初始不能看到 A 的 private data（含實際 LLM request）；明確 share 後 B 可以檢索，實際 LLM request 的獨立 run-local untrusted reference records 含完整共享知識、正確 Bot/thread 及 active revision／原 run provenance，system prompt 保持不變；C 跨 owner 仍不可越權（包括重建後）。可信查詢文字不含複製的知識，不能以 fake 固定回答代替注入證據。
- [ ] disable 意圖/Host applied state（依最終 reconcile 語意）後拒絕新的 run；同候選 G5 另證明直接 Host admission/cached revision、ACK lost/延遲 operation 等；既有完成 run 不被改寫。確認未偷偷跨 schema 授權。
- [ ] 整體 integration runner exit=0，必跑 test 未 skip；保留診斷 log 與清理結果。不得省略新 thread memory、shared injection 或 disable 後半段，這些是最新未全過步驟。

## 6. 交付物、報告與證據保存

以現有 repo 路徑為準；必要時補以下內容，避免新建平行真相來源：

- `docs/cloud-native-part-1-report.md`：在末尾新增 Final Acceptance 段落，保留原 FAIL/NOT RUN 紀錄、修復根因、候選 commit、G1–G8 狀態、具體證據、known limitations。
- `docs/cloud-native-part1-status.json`：更新為最新候選的機器可讀證據快照。建議欄位：candidate SHA/source digest、base SHA、環境、image digest、owner migration decision、每 gate status+test names+exit codes+artifact path+skip rationale、`part1_accepted`、`part2_prerequisites_accepted`、`blockers`、`real_gcs_iam_pitr`。沿用現有欄位兼容，不讓報告數字脫離實際 runner。產生 status 時只有全必要 gate 滿足才 true；owner 未核准不得 true。
- `docs/cloud-native-part1-validation.md`：補 freeze candidate、串行順序、實際故障排查及可重現命令；保留正確 migrations/grants、服務配置、worker CLI。
- `docs/cloud-native-part-2-report.md`：更新「前置驗收」為本候選結果；沒有 Part 2 實雲資料，不宣稱已部署。
- `docs/cloud-native-inventory.md`：僅若儲存契約修復改變 ownership/limit/資料類型才更新。
- 必要程式碼/測試、CI guard helper/runner 改動、lockfile。輸出具名的測試 artifacts（可用 CI artifact 或 owner 可取的目錄，不需提交含隱私的大 log/credentials）。保留失敗初始 log 和修復後結果，不能只引用已消失的舊暫存絕對路徑。附 redacted log/checksum/exit code 的索引；不得把整個環境變數 dump 或私有 profile 上傳。

報告摘要模板：

| Gate | Status | Candidate / 證據 | Root cause / 修復／限制 |
|---|---|---|---|
| G1 Legacy regression | PASS/FAIL/NOT RUN | 真實 artifact | 實際結果 |
| G2 Storage | PASS/FAIL/NOT RUN | 真實 artifact | 實際結果 |
| G3 Graph | PASS/FAIL/NOT RUN | 真實 artifact | 實際結果 |
| G4 Job | PASS/FAIL/NOT RUN | 真實 artifact | 實際結果 |
| G5 Provisioning | PASS/FAIL/NOT RUN | 真實 artifact | 實際結果 |
| G6 Restart | PASS/FAIL/NOT RUN | 真實 artifact | 實際結果 |
| G7 Migration | PASS/FAIL/NOT RUN | scope + 驗收 | 歷史全量匯入可單列 owner 核准 N/A |
| G8 Build | PASS/FAIL/NOT RUN | 真實 artifact | 實際結果 |
| Part 2 GCS/IAM/PITR | NOT RUN | — | 實雲驗收尚未執行 |

指定唯一候選，報告追加後若 commit SHA 改變僅因報告內容，明列 tested code SHA 與 report SHA，使用來源/目錄比對證明產品、fixtures、配置、依賴皆未變。記錄執行起止時間，允許記錄 partial PASS，但不得以局部成果替代全 gate。若還有 blocker，交付已完成證據與具體 reproduction、最小修復建議，不突然開新一輪大改造。

## 7. Part 2 交接契約與 Go/No-Go

僅 G1–G8 均通過、migration scope 已核准且證據指向同一候選才 Go。GitHub CI 或可信獨立機器可補本地不足，仍需證明完全相同 source/config/測試契約。未核准延期、不使用容器或 repository check 例外。本輪在 No-Go 不實作 Part 2，也不建立雲端資源。

現有交接入口（不得重寫）：

| Part 1 完成契約 | Part 2 消費方式 |
|---|---|
| Host 001–005 / Runtime 001–007 schema、分權角色、PG/GCS config、ADC adapter | Cloud SQL / 獨立 migration job、GCS 真 generation/IAM、Secret Manager |
| Host profile snapshot、lease、manifest/terminal/outbox | 私有 Hermes Cloud Run、interrupted run/replay/cancel（後者 Part 2） |
| `node --import tsx server/graph/worker-cli.ts process JOB_UUID` / `tick` / `reconcile`（從 examples/copilotkit） | private Graph worker、Cloud Tasks、Scheduler、過期 lease 接管 |
| `node --import tsx server/bots/reconcile-cli.ts` | provisioning 定期對帳、私有 IAM |
| `python -m hermes_agui.storage.completion_delivery --once` | 定期補送 Host completion，單次最多一筆、重複 caller |
| 兩服務正式 Docker artifacts、共享 scenario | 真 Cloud Run restart/scale、GCS/Cloud SQL、隔離及恢復 |

Cloud Run 禁止依賴 response 後 timer 做可靠工作；本輪驗證一次性 worker CLI/明確 tick。外部排程、Cloud Tasks、Firebase Auth、Vercel、IAM service identity、長 SSE/跨 instance cancel、真資料恢復/成本/負載測試等留 Part 2。Credential seed 兩端一致且持久保管，輪替/遺失不是本輪已完成的線上功能。

## 8. 給 Codex 的執行指示

以現在實際 HEAD 增量完成本文件，先 F1（環境、聚焦修復、決策），再 F2（同一候選依序驗收及報告）。不要重作已完成 A/B/C，不要把舊 PASS 當最終 PASS，不以增加 timeout、關功能、弱化斷言、跳過 repository check 或 mock 外部持久性掩蓋問題。完整回歸一次即可，聚焦修復後才重新建立最終候選；不要並行重型 suites。若必要 gate 失敗，標清實際原因；若資源允許且可安全修復則繼續按缺陷迭代，優先收尾而非引入新功能。只有 G1–G8 都通過且 owner scope 明確後，才寫 Part 1 accepted、Part 2 prerequisites accepted。停止於可交接狀態，不直接實作 Part 2。

## 參考與審查限制

本計畫依 GitHub main 靜態查閱及最新報告編寫，沒有在此執行實際測試。路徑與命令依審查 SHA；執行者須重新確認本機版本和所有 collector/fixtures。除原有契約外，新定的證據記錄格式、F1/F2 串行執行策略、建議 fresh_deployment 都是計畫建議；未獲 owner 授權不切換或刪除既有資料，不變更 acceptance scope。

- https://github.com/jiangweitaiwan/hermes_agui/blob/main/docs/CLOUD_NATIVE_PART_1_REMAINING.md
- https://github.com/jiangweitaiwan/hermes_agui/blob/main/docs/cloud-native-part-1-report.md
- https://github.com/jiangweitaiwan/hermes_agui/blob/main/docs/cloud-native-part1-validation.md
- https://github.com/jiangweitaiwan/hermes_agui/blob/main/docs/cloud-native-part1-status.json
- https://github.com/jiangweitaiwan/hermes_agui/blob/main/docs/cloud-native-part-2-report.md
- https://github.com/jiangweitaiwan/hermes_agui/blob/main/scripts/cloud_native_part1_check.sh
- https://github.com/jiangweitaiwan/hermes_agui/blob/main/tests/hermes_agui/cloud_native_scenario.py
- https://github.com/jiangweitaiwan/hermes_agui/blob/main/tests/hermes_agui/test_cloud_native_restart.py
- https://github.com/jiangweitaiwan/hermes_agui/blob/main/scripts/check
