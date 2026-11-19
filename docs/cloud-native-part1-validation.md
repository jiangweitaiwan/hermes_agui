# Part 1 收尾驗收與交接操作

本文件配合 `CLOUD_NATIVE_PART_1_FINAL_ACCEPTANCE.md`，只涵蓋 Part 1。所有 DB 指令僅對新建、可丟棄的測試庫執行；不清除或覆寫既有使用者資料。Owner 於 2026-11-19 核准首次部署採用 `fresh_deployment`：保留既有本機資料，歷史全量遷移 N/A；importer 相容性與新資料重建仍是必要 gate，不代表可直接切換既有使用者。

## 環境與 migration

使用 Node 22.18+（需原生 `node:sqlite`）、PostgreSQL 17+ UTF-8，以及以 Hermes PM 建立、包含 `agui`、`agui-cloud`、test group 的 Python interpreter。新增 `agui-cloud` extra 已由 `hermes pm lock` 鎖定；Android/PyPy 使用純 Python psycopg，需要自行提供 libpq，容器使用 binary wheel。

```bash
python -m pm.build_env --source . --out /path/to/new-test-env --extra agui --extra agui-cloud --group dev --group test
export HERMES_PYTHON=/path/to/new-test-env/bin/python
```

本機可用 PostgreSQL 套件建立獨立 cluster（先把對應的 `initdb`、`pg_ctl` 加入 PATH）：

```bash
export PART1_PG_ROOT="$(mktemp -d)"
initdb -D "$PART1_PG_ROOT/db" -A trust -U hermes --no-locale --encoding=UTF8
pg_ctl -D "$PART1_PG_ROOT/db" -l "$PART1_PG_ROOT/postgres.log" -o "-h '' -k $PART1_PG_ROOT" -w start
export HERMES_AGUI_TEST_DB_SOCKET="$PART1_PG_ROOT"
export HERMES_AGUI_TEST_DATABASE_URL="host=$PART1_PG_ROOT dbname=postgres user=hermes"
export HERMES_AGUI_TEST_RUNTIME_DATABASE_URL="postgresql://hermes@localhost/postgres?host=$PART1_PG_ROOT"
scripts/cloud_native_part1_check.sh migrate
```

Migration owner 依序套用 Host `001`–`005`，再套用 Runtime `001`–`007`。應用啟動不執行 DDL，缺 migration 會失敗。原生 SQLite snapshot 契約不改成 PostgreSQL transcript。既有匯入工具的目標欄位保持相容；新增管理欄位有 `0`／NULL 預設值，首次 reconcile 建立正式 operation。

獨立服務角色的可執行 grants 範例見 `tests/hermes_agui/cloud_native_grants.sql`。該檔的角色、密碼僅供全新容器 fixture；正式環境以相同表級權限套用至部署角色，密碼由秘密儲存注入。Host 只獲 Host schema 權限；Runtime 只獲 Runtime schema 權限。`graph_namespaces` 的 UPDATE 權限用於 namespace row lock。Migration owner 不作為正式應用身分。

## 分開的驗收入口

最終驗收先保存起始 HEAD 與失敗紀錄，聚焦修復後凍結候選 commit；以同一
候選建立 images、fresh test cluster 與全部證據。歷史比較 base 固定為
`ae7d7ae51eca59c49a79ef47f7d086fb23f0798a`（目前起點的直接父 commit），
不能拿候選與自己相比。結果、起止時間、exit code 與 checksum 存在
`artifacts/part1-final-20261119/`；最終判定見 status JSON 與報告末節。

所有重型階段串行。資源較少時使用既有 runner 的 worker 設定：

```bash
HERMES_TEST_WORKERS=1 scripts/cloud_native_part1_check.sh regression
```

先對空庫 migrate 一次；如重新建庫，使用新 socket/cluster，禁止對既有使用者
資料庫重跑 migration。容器 gate 可先執行以提早發現 Restart 缺陷；其後原始碼
保持凍結，才依序執行 regression、browser、完整 repository check 與 diff check。
如果產品、fixture、依賴或 runner 改動，重新凍結候選並重驗必要 suites。

2026-11-19 聚焦診斷：sandbox 的 loopback EPERM 須以正常授權重驗，不得改用
mock HTTP。Graph bounds 與 CLI 測試保留原 30/60 秒期限。PG readiness 使用
有界 SQL ping 與容器存活檢查；失敗報告最後錯誤、elapsed、State/Mounts，避免
完整 inspect 的 Env 洩漏秘密。busy-run lease release 使用 `finish` 的 keyword-only
參數。Repository checker 恢復的 upstream guard 來源見
`scripts/ci/RESTORED_GUARDS.md`；TS metrics 由 tracked package manifests 解析同一
engine，所有適用檔案仍由原測量器掃描，不建立空的 root package。

Owner 於 2026-11-19 核准 Graph 注入依既有 run-local untrusted reference 契約驗收：
真 LLM request 的當前 user message 副本有獨立、明確標示不可信資料的 reference，
system prompt 與已存 transcript 不變。Restart fixture 解析 multipart content，先驗證
分享前 B 不可見，再核對完整知識、Bot/thread、Graph active revision 及原 run provenance；
可信查詢不含複製知識，fake 回答不能代替 context 證據。Session reference v1 與
document reference v2 保持原支援範圍；不改 Core、簽章或 ACL。

```bash
scripts/cloud_native_part1_check.sh regression
scripts/cloud_native_part1_check.sh browser
scripts/cloud_native_part1_check.sh container
```

也可用 `just cloud-native-part1 MODE`。完整 regression 含 Runtime/Graph/delegation Vitest、真 PG Host probe、Python AG-UI、TypeScript/Vite 與 local/PG 同 fixture 評估。Browser 入口依序執行預設、Graph、動態 Bot、多 Bot 模式。沒有 Playwright Chromium 時可明確指定已安裝的 Chrome：

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Container 入口建置正式 Host image、加入獨立測試 fixture 的 Host image，以及 Runtime image，再以 canonical test runner 的 `-m integration` 執行 `test_cloud_native_dual_container_restart`。此 scenario 自行建立獨立 Docker network、PostgreSQL 容器及 object contract-double volume；兩應用使用不同 PG roles、read-only root 與全新 tmpfs。只保留部署模板、秘密設定、PG 與外部 object volume，刪除並重建兩個應用容器。驗證原 thread/native session IDs、tool/result、原生 memory、自建 allowlisted skill、Graph browser/retrieval/injection、私有／共享／跨 owner 授權，以及 outbox ACK loss 重送。測試結束只清理自己建立的具名資源。這是外部 filesystem object double，不能當作真 GCS IAM/generation 驗收。

已建好 images 後只重跑 scenario：

```bash
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh -j 1 --file-timeout 600 tests/hermes_agui/test_cloud_native_restart.py -m integration
```

完成本機 DB 測試後清理自己建立的 cluster：

```bash
pg_ctl -D "$PART1_PG_ROOT/db" -m fast -w stop
rm -rf "$PART1_PG_ROOT"
```

## 正式 storage 設定及一次性 worker

沿用秘密環境變數 `AGUI_RUNTIME_DATABASE_URL`、`AGUI_HOST_DATABASE_URL`、`AGUI_GCS_BUCKET`、`AGUI_BOT_CREDENTIAL_SEED`、`AGUI_GRAPH_COMPLETION_TOKEN`。`AGUI_STORAGE_BACKEND=gcp` 選擇 PG/GCS，沒有 SQLite fallback。ADC 負責 object 存取。兩服務共享 credential seed，seed 不存進 SQL metadata；遺失 seed 無法重建舊憑證，輪替需協調兩端並排空舊 worker，不是本輪已實作的線上輪替功能。

Runtime deployment JSON 範例（`AGUI_BOTS_CONFIG` 指向此檔；management 欄位沿用既有格式）：

```json
{
  "bots": [],
  "storage": {"botRegistry": "postgres", "threadMappings": "postgres", "graphCompletions": true},
  "graph": {
    "enabled": true,
    "evolution": {"enabled": true, "compiler": {"baseUrl": "https://your-approved-model-endpoint/v1", "model": "approved-model", "keyEnv": "GRAPH_MODEL_KEY"}}
  },
  "management": {
    "hostUrl": "http://127.0.0.1:8000",
    "hostTokenEnv": "HOST_MANAGEMENT_TOKEN",
    "users": [{"ownerId": "owner", "principal": "owner", "projectId": "project", "tokenEnv": "OWNER_TOKEN"}],
    "templates": [{"id": "native", "name": "Native", "harness": "hermes", "model": "approved-model", "provider": "custom", "skills": [], "toolsets": ["memory", "skills"]}]
  }
}
```

Host 仍透過既有 management/templates/storage 設定啟動，storage.project 必須與 Runtime scope 相同，並啟用 graph_completions。只核准具體的 `storage.approved_files`；模板技能由 deployment 重建，自建技能只有逐檔 allowlist 才持久化。

從 `examples/copilotkit` 執行：

```bash
node --import tsx server/graph/worker-cli.ts process JOB_UUID
node --import tsx server/graph/worker-cli.ts tick
node --import tsx server/graph/worker-cli.ts reconcile
node --import tsx server/bots/reconcile-cli.ts
```

Graph worker 與 HTTP Runtime 共用 bootstrap、權威 registry、MemoryEvolution 及 WikiCompiler；指定 job 從 SQL 取得 namespace，不接受呼叫者自報 scope。一次性 worker 不啟動 timer。`tick` 可重跑並接管過期 lease，最多三次自動 attempt；失敗後由可信管理員檢查 source／provenance 再使用既有 `ingest-cli.ts` scoped retry。PG 模式的 `ingest-cli` 是可信 OS 管理邊界；一般 durable worker 使用 deployment-aware 的 `worker-cli`，避免繞過 Bot 授權刷新。

Host 補送沿用：

```bash
python -m hermes_agui.storage.completion_delivery --once
```

另注入 `AGUI_GRAPH_COMPLETION_URL`，指向 authenticated `/internal/graph/completions`。`--once` 每次最多交付一筆；caller 可重複執行。Part 2 必須以 Scheduler／私有 worker 定期喚醒此入口及 Graph/provisioning reconcile；正式 Cloud Run 不以 response 後 timer 作可靠交付。這裡沒有 Cloud Tasks、IAM HTTP worker、replay/cancel 或 Firebase。

## 一致性與限制

來源與 Wiki 先 create-only 上傳 immutable object，再用單一 PG client、固定 namespace lock 順序、revision CAS、有效 job token／DB clock、來源未撤銷及當前 Bot ownership 發布 metadata 並完成 job。兩個 job 的 revision 衝突進有限 backoff，重試重新讀取並 merge。讀取在 object／encoder await 後驗證 active revision、provenance 與目前 registry。背景清理限於本部署擁有的 principal/project，不撤銷其他部署的資料。

Runtime desired state 與單調 revision、operation 同交易提交；Host applied state、admission revision 及 operation ACK 同交易提交。timeout/503 是 unknown，可用同一 operation 對帳；舊 ACK 只有 desired revision CAS 命中才更新目前狀態。disable/delete 意圖提交後 Runtime 拒絕新 run；Host 尚未收到意圖的網路分割窗口仍存在，Part 2 private IAM 才防止直接繞過 Runtime。

成功回合才提交原生 profile；失敗／中斷回合可能失去未提交 memory/skill 變更，沒有工具級 checkpoint 或 exactly-once 外部副作用。Profile 上限 64 MiB／256 項，Wiki 預設 256 KiB／1000 pages，原始 source 上限 1 MiB。整份 SQLite backup／上下載的延遲隨容量成長。

目前不刪除未引用 object：SQL rollback、重送前 staging 可能留下孤立物件。採保留策略，後續 GC 至少保留七天寬限，且必須對所有歷史 source/wiki revision、Host manifest/outbox 引用對帳後才能刪除；不可只看 active pointer，亦不可對整個 bucket 套短期 lifecycle。真 GCS IAM/generation、備份/PITR 實雲還原及成本測試仍屬 Part 2。


## 2026-11-19 最終候選與重現紀錄

Tested SHA `c9e7a56d46d4eb70e6ac9f26edb29c0a685796c9`；base `ae7d7ae51eca59c49a79ef47f7d086fb23f0798a`；source digest `3dfd47ac67b3e26de62b0e42d7a10ff800f001e201df846757a8259eaeb96795`。
實際命令／exit code／elapsed／UTC 起止／log checksum 見 `artifacts/part1-final-20261119/INDEX.md` 與各 step JSON。
最終使用全新 PG Unix socket cluster（UTF-8，Host 001–005／Runtime 001–007 各一次），PM agui/agui-cloud/dev/test、Node 22.18.0、Chrome 150.0.7871.125。

順序為三個 Docker build → production smoke／完整 restart → 既有 native container probe → fresh PG/migrate → regression（Python workers=1、Vitest maxWorkers=1、retries=0）→ browser 四模式 → repository check → guard contracts → diff checks。各重型階段未重疊。容器 build/scenario 使用現有 container mode 內相同命令拆開記錄，以保留每個 build exit code、JUnit 與 `--basetemp` 診斷。

```bash
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh -j 1 --file-timeout 600 tests/hermes_agui/test_cloud_native_restart.py -m integration --junitxml=/path/to/evidence/container.junit.xml -o junit_logging=all
HERMES_TEST_WORKERS=1 scripts/cloud_native_part1_check.sh regression
scripts/cloud_native_part1_check.sh browser
"$HERMES_PYTHON" scripts/check --base ae7d7ae51eca59c49a79ef47f7d086fb23f0798a --commit c9e7a56d46d4eb70e6ac9f26edb29c0a685796c9
git diff --check ae7d7ae51eca59c49a79ef47f7d086fb23f0798a c9e7a56d46d4eb70e6ac9f26edb29c0a685796c9
git diff --check
```

原 legacy container wrapper 的 probe 直接以候選正式 image 執行，命令保留在 `final-legacy-container-probe.json`；其全部 asserts 與成功 marker 已驗證。正常 Python selector 排除的 integration 由這個 probe 及完整 restart/smoke 覆蓋；browser 預設條件案例由三個指定模式覆蓋。舊失敗與 `89eadbf` 的非最終完整回歸均保存於 attempt 目錄，沒有混作本候選結果。報告追加後僅 docs 改變，source manifest 重新核對一致。
