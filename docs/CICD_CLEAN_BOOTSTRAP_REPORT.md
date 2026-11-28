# CI/CD Clean Bootstrap 實作與驗收報告

交付日期：2026-11-28（Asia/Taipei）。
指定基準：`747c0978ac111b8b233d486cfd0e99647978ad12`。
讀取／實作起點：`codex/event-driven-execution` 的 `b8dd8ae52f75a468e77ecb4c51db7d572486cfe6`，包含完整計畫書，且基準為其 ancestor。本文測試涵蓋本次 working tree。

本次只實作及執行本機驗收，**未執行 production reset、GCP provisioning、正式部署、workflow dispatch 或 push main**。正式環境仍須完成下列一次性權限／Secret 配置及 operator verification；本報告不代表 deployed。

## 實作範圍

- `.github/workflows/llm-images.yml`：新增 `deployment_mode`（預設 `rolling-upgrade`）、`confirm_reset`、明確的 `recovery_operation`。Push 強制 rolling，沒有常駐 reset 開關；保留 CI critical gates、WIF、immutable images、manifest、main eligibility、environment、concurrency。
- `scripts/ci/clean_bootstrap.py`：dispatch／target／確認／run-attempt 授權、GitHub environment review history 驗證、GCS generation-CAS journal。Build 在 cloud mutation 前驗證輸入；deploy 要求另一位 reviewer 真正核准 `llm-deploy`。
- `scripts/ci/clean_rollout.py`：clean 專屬 state machine；共用原 `DatabaseRollout` inventory、preparation Job、template drift、candidate readiness／auth smoke、digest／traffic／tag read-back 與恢復流程。Clean 不呼叫舊 drain、不詢問舊 capability、不要求舊 Completion image 相同或 paused RunJob 已驗證；新 consumer 仍須 capability=1。
- `scripts/ci/database_rollout.py`、`completion_rollout.py`：抽出共用 candidate rollout；clean 將 Completion 設為 `--drain --max-events 100 --max-seconds 120`，保留 audience／prefix／其他必要參數，timeout ≥300s、max-retries=0。
- `server/storage/clean-reset.ts`、`clean-operations.ts`、deployment CLI：由既有 preparation Job 執行 target／owner／dependency／login 隔離檢查與 reset；CI 不取得 owner DSN。Host 繼續用原 Python migrator，Runtime 繼續用原 Node migrator、grants、schema catalog、release bootstrap／upgrade。
- Host `009_deployment_epoch.sql`、Runtime `016_deployment_epoch.sql`：只新增 migration，歷史 migration／grants bytes 不變。Authority table 的 epoch 在普通 rolling 為 NULL／保留既有值；只有已提交 clean markers 才可初始化新 UUID。
- Completion／Graph producers、handlers、reconciliation 及跨 Host→Runtime evidence：generation-aware payload／header；Host profile/evidence 和 Runtime Graph objects 使用新 epoch namespace。
- `setup-clean-bootstrap.sh`、`provision-clean-logins.sh`、`provision-clean.ts`：操作者的一次性 provisioning 支援。新增隔離用登入及 Secret；不要求人工 SQL、migration 或舊 consumer bootstrap。
- 新增／擴充 Fake GCP、PG17、完整事件鏈、epoch 與 rolling retention 測試，加入原 `llm_offline_ci.sh` 及 database-deployment test config。未變更 agent loop 或 Graph prompts。

## Reset 範圍與 SQL 安全性

固定 allowlist，沒有 prefix 動態展開：

1. `hermes_agui_host`
2. `hermes_agui_host_migrations`
3. `hermes_agui_runtime`
4. `hermes_agui_runtime_migrations`

LLM control／prompts／release／Bot metadata 均位於既有 `hermes_agui_runtime`，不需要額外 drop schema。新 `hermes_deployment` 是一次性 provisioning 的隔離函式所在 schema，**不在 reset allowlist**。

Host owner transaction 使用 literal SQL：

```sql
DROP SCHEMA IF EXISTS hermes_agui_host,hermes_agui_host_migrations CASCADE;
CREATE SCHEMA hermes_agui_host_migrations;
```

Runtime owner transaction 同樣只操作另外兩個 literal schemas。每個 transaction 同時寫入 migration schema 中的 `clean_reset(operation, epoch)` marker；使用既有 migration lock `92017001`／`92017002`、preparation locks `92017099`／`92017100`，以及 lock timeout 5s、statement timeout 30s。

`pg_depend` recursive closure 與 `pg_identify_object` 檢查外部依賴；只接受 allowlist 物件及其可證明的內部物件（如 TOAST/default）。外部 view、FK／其他物件或 extension membership 都 fail closed。沒有 `DROP DATABASE`、新建 Cloud SQL instance/database、drop public／extension 或清空 bucket 的 production 路徑。測試中的 CREATE/DROP DATABASE 僅用於 disposable local PG。

重建會移除舊 application、migration 及 grants ledgers，完整 replay 001…009／001…016（包含 008／015 consumer fences）；再依序 migrate/grants、pending=0 catalog check、seal、epoch、release。新 control store 由原 release 流程從 managed runtime config 初始化；同版本 release 仍保持 idempotent。

## 強制隔離與一次性 provisioning

只 pause queue／scaling=0／短暫沒有連線不構成 reset 授權。實作選擇「**保留既有 capability roles，另建隔離登入與 IAM／Secret 邊界**」：

- 保留 `hermes_host`、`hermes_runtime`、`hermes_llm_admin`、`hermes_llm_runtime`、`hermes_llm_reader`、`hermes_llm_host_reader` 的 OID、舊密碼及既有 grants 定義。
- 一次性建立對應的 `*_clean` LOGIN roles，繼承原 capability roles；owner／superuser／CREATEROLE 不能作為 application login。
- 新登入 DSN 使用獨立的新 Secret 名稱及固定 numeric version，新 application service account 不能是任何舊 application identity。
- 這個增量是為了讓舊 revision/job 的 ADC **無法讀取新 credential**；不能只改同一個共享 Secret 的 version，然後假設舊 identity 不會透過 API 讀到它。其他 business tokens、config Secrets、queue／scheduler names、URLs、bucket 均可沿用。
- preparation identity 必須與 CI／application identities 分開。舊 application 及 CI 對 owner Secrets 都必須得到真實 Secret Manager `403 PERMISSION_DENIED`；impersonation 本身失敗不能算通過。
- provisioning 安裝固定 inventory 的 `hermes_deployment.isolate_old_writers(text[])`。只有 Host preparation owner 可 EXECUTE；PUBLIC／application 不可呼叫。函式將舊六個 role 設 NOLOGIN、terminate 舊 backend。Workflow 在 drop 前再次確認舊 roles 無 LOGIN／active backend、新 roles 無 owner 權限，也拒絕未知可繼承 Hermes 權限的 LOGIN。
- 新 application Secret 必須同時以 `AGUI_CLEAN_*_URL` 掛在 preparation Job，讓 owner-side preflight 核對 role、可信 `/cloudsql/PROJECT:REGION:INSTANCE` binding、database target、current_user、current_database、OID 及實際登入。所有實際舊 DSN 也須由 preparation 解碼核對為固定 legacy roles，避免已注入舊 revision 的 owner／未知 credential 漏出隔離範圍。CI 提供的 binding JSON hash 必須符合獨立掛載的 preparation config。

### 操作者的一次性設定

先保持 `AUTO_DEPLOY_ENABLED=false`，由維護者審閱／合併本次程式碼後取得 build-only 的新版 immutable images。**不要為了取得 image 先執行 rolling 舊 consumer bootstrap。**

1. 確認既有 database 是 `hermes`、PG17，並核對實際 instance；填入 repository variable `LLM_CLEAN_SQL_INSTANCE= copilotkit-agui:asia-east1:實際INSTANCE`（值本身不含空白）。其他 database 名稱會拒絕，不會自動選另一個目標。
2. 使用獨立 preparation SA、全新 application SA。若目前 CI identity 同時也是舊 application identity，還須分開 deploy identity，設定 repository variable `LLM_DEPLOY_SERVICE_ACCOUNT`，補上既有 main-only WIF trust、既有部署／smoke IAM；不能讓舊 app 具 journal 寫權。未設定此 variable 時仍沿用原 CI SA。
3. 先看 `deploy/gcp/setup-clean-bootstrap.sh check`，再由有權限的操作者執行 `apply`。它建立必要 SA、Cloud SQL client、CI actAs 及 scoped journal role／Troubleshooter；不重設 DB、不部署 service。
4. 用原 `setup-database-aware-jobs.sh` 設定兩個 preparation templates，指定 `GCP_PREPARATION_SERVICE_ACCOUNT` 為獨立 preparation SA，沿用 instance、network、owner Secret numeric versions、runtime config。不要把 owner Secrets 掛在 application 或 CI identity。
5. 準備一次性的 security-admin DSN Secret：只供 provisioning Job 使用，需要既有 `hermes` database 的 CREATE、既有六個 role 的 ADMIN／ALTER 能力、CREATEROLE 及 pg_signal_backend。這不是 application／CI 的 credential，也不需要 Cloud SQL instance/database 建立／刪除權限。
6. 執行新的 `provision-clean-logins.sh`，它在現有 preparation Job 內呼叫 `provision-clean.ts`，自動完成 SQL 及產生隨機密碼／新 Secret versions；trap 移除臨時 admin Secret mount 與存取 grant。`CLEAN_PROVISION_CONFIG` 是非秘密 JSON：

   ```json
   {
     "project": "copilotkit-agui",
     "instance": "copilotkit-agui:asia-east1:實際INSTANCE",
     "hostOwner": "實際HostOwnerRole",
     "secrets": {
       "hermes_host": "hermes-clean-host-dsn",
       "hermes_runtime": "hermes-clean-runtime-dsn",
       "hermes_llm_admin": "hermes-clean-llm-admin-dsn",
       "hermes_llm_runtime": "hermes-clean-llm-runtime-dsn",
       "hermes_llm_reader": "hermes-clean-llm-reader-dsn",
       "hermes_llm_host_reader": "hermes-clean-llm-host-reader-dsn"
     }
   }
   ```

   同時提供腳本要求的 project、既有 Job、preparation/application SA、`CLEAN_SECURITY_ADMIN_SECRET=name:numeric-version`。只讀取 Job log 的 role／Secret version receipt；不把 DSN 下載到 CI。已有可登入且 target 正確的 Secret 會驗證後重用，不盲目旋轉密碼。配置／權限不足即停止。
7. 依實際五個 application templates 的 **所有** `*_DATABASE_URL` env 建立 `LLM_CLEAN_APPLICATION_BINDINGS`。`clean-bootstrap.bindings.example.json` 是範例，必須與實際 inventory 相符，不能直接假定 version=1 或少掉現有 env。新 SA 需沿用原 app 的必要 non-owner Secret、Cloud Run invoker、Tasks enqueuer／dispatch actAs、Vertex、Cloud SQL client、GCS object read/create 權限；scope 至原資源及 `epochs/`，不要授予 journal 寫入權。
8. 以 `clean-bootstrap.config.example.json` 建立固定 version 的 preparation config Secret，掛至檔案，設定 `CLEAN_BOOTSTRAP_CONFIG=/etc/hermes/clean-bootstrap.json`。六個 `AGUI_CLEAN_*_URL` 掛載對應的新 DSN fixed versions；另將目前五個 app 實際引用的所有舊 DSN fixed versions 掛為 `AGUI_OLD_*_URL`，在 config 的 `oldCredentials` 列出各 env／實際 legacy role（範例需依實際 mount 刪減）。Workflow 核對每個舊 Secret reference 及所有 credential env 都被驗證，owner／未知角色的 Secret alias 會阻擋；不能只相信 role 清單或 API access 已撤銷。preparation 的 `AGUI_LLM_ADMIN_DATABASE_URL` 也改用新的 admin login，owner 兩個 DSN 保持原本的 schema-owner credentials。
9. `bindingsHash` 計算方式：

   ```bash
   python3 -c 'import json; from scripts.ci.clean_bootstrap import manifest_digest; print(manifest_digest(json.load(open("bindings.json"))))'
   ```

   將輸出寫入 preparation config。不得只改 GitHub variable 而未更新受控 config。
10. Journal 沿用 build source bucket 的 `deployment-journal/clean/`。需 uniform bucket-level IAM；CI custom role 只在此 prefix 有 `storage.objects.get/create/delete`（CAS overwrite 需要 delete），不能刪 application data。舊／新 application identities 對此 prefix 必須無 create/delete；Policy Troubleshooter 回覆 UNKNOWN 也會阻擋。App 也不得透過 project/Secret/SA policy mutation、impersonation／actAs 新 identity 或執行／修改 owner preparation Job 繞過隔離，preflight 一併驗證這些 deny。檢查並由 IAM 管理者縮小既有 broad inherited grants，腳本不擅自移除可能服務其他 workload 的權限。
11. CI 另需讀 service/job inventory、Secret version metadata、IAM actAs 檢查、對舊 application SA 的 access-token impersonation（用於真實 deny test）、IAM Policy Troubleshooter。保留原 deployment、queue pause/resume、scheduler、execution cancel/read、logging、artifact、smoke 權限；沒有要求 purge/delete queue 或 Cloud SQL admin。
12. 在 GitHub `llm-deploy` environment 設 required reviewers、prevent self-review，並確保有另一位可用 reviewer。沒有有效獨立 review history 時會拒絕 reset；不能用 variable 假造核准。

原 `LLM_COMPLETION_CONFIG`、兩個 queue inventory、三個 scheduler inventory、managed producer confirmation 必須正確。Setup scripts 未在本次連線正式 GCP 執行；IAM、Secret versions、實際角色名稱不能由本報告推定已配置。

## Journal、失敗及 recovery

Journal 名稱為 `gs://既有BUCKET/deployment-journal/clean/GITHUB_RUN_ID.json`；第一次寫入 `ifGenerationMatch=0`，後續每次用上一個 generation。記錄 source SHA、manifest digest、project/instance/database、mode、核准／確認、operation、UUID epoch、phase history、Job executions、template hashes、intentional delta 與結果，不含 DSN／密碼／token。

順序：read-only preflight → durable intent → preparation image 更新／DB preflight → durable maintenance intent → 三 service stop/read-back → 三 scheduler pause／兩 queue pause/read-back → cancel executions／確認終態 → DB isolate → main tip 重查／template verify／isolation 重查 → **Host reset Job 提交及 journal receipt → Runtime reset Job 提交及 journal receipt** → 原 migrations／grants／catalog／seal／epoch／release → 共用 candidate verification → 新 capability／隔離重驗 → main tip／template 重驗 → DB resume → queues → schedulers → DEPLOYED。

維護前失敗為 FAILED_SAFE；開始維護後為 RECOVERY_REQUIRED。Containment 逐一嘗試停止所有 services、pause queues/schedulers、取消四個 Jobs 的 executions、重封鎖舊 identities、seal；schema/fence 不存在時記錄 containment incomplete，服務停止／identity 隔離不依賴 seal 成功。不回滾舊 image／release pointer。

Crash 落在 COMMIT 與 journal 之間時，每個 owner transaction 的 `clean_reset` marker 是權威證據；同 operation／epoch 再執行只回 ALREADY_RESET，不會再次 DROP。兩個 reset Job 分開記錄成功 receipt，部分提交可辨識。phase unknown／template drift／target 或 epoch 不一致均停止。

### GitHub Actions 操作

新的一次性 reset：

1. 完成上述 provisioning，設定 `AUTO_DEPLOY_ENABLED=true`。
2. Actions → **LLM console CI/CD** → Run workflow，branch=`main`。
3. `deployment_mode=clean-bootstrap`，`deploy=true`，`confirm_reset=RESET copilotkit-agui/hermes`，`recovery_operation` 留空。
4. 等 CI/build/manifest 完成，由另一位 reviewer 核准 `llm-deploy`。
5. 檢視 `llm-deploy-report` artifact、journal、reset receipts、readiness／digest／capability／auth／queue/scheduler read-back，只有 DEPLOYED 才算成功。

失敗後 **不要使用 Re-run jobs 重做 clean**。新的 dispatch 選 clean、deploy=true，填原失敗 workflow run ID 為 `recovery_operation`，確認字串改為 `RECOVER 原RUN_ID copilotkit-agui/hermes`，再取得獨立核准。Workflow 讀取原 run 的 release manifest artifact，要求原 source 仍為 main tip、原 manifest digest 相同、受控 templates 及 credentials 相同，使用同 operation／epoch 向前續作。

成功 run、DB 已標記 resumed、epoch 不符或未能證明狀態時，recovery 拒絕；不為了方便而重設新資料。已開放 admission 後的中斷仍維持 containment，需操作者另行處理已開放狀態；本路徑刻意不重新 DROP 或自動恢復。若要另一個資料世代，除了新的 dispatch／reset 確認，還必須另行審閱可隔離目前 LOGINs 的 provisioning。本次固定 legacy→`*_clean` provisioning 僅供第一次 bootstrap；不同的已 clean epoch 會在 read-only preflight 拒絕，不能用 legacy-only 隔離重做第二次 reset，以免目前的 credential 仍可寫入。普通 rolling 與同 operation recovery 不受影響。

日常 push main 強制使用既有保資料 `DatabaseRollout`；不旋轉 epoch。**Clean 不會自動把 `LLM_PAUSED_SCHEDULER_RUN_VERIFIED` 設 true**。後續 rolling 前，操作者仍須實際驗證 paused Scheduler RunJob contract，才設定既有 variable；這是既有 contract 驗證，不是舊 consumer bootstrap。

## Task、evidence 與 seed 契約

- Authority：Host／Runtime 各有 singleton epoch，clean 必須使用同 UUID，resume 前再次比對。普通 rolling 不重新產生 epoch。
- epoch=NULL 的既有世代仍產生／接受 schema=1 task，不會靜默丟棄舊 rolling 工作；既有 rolling drain／consumer gates 保留。
- clean 世代產生 Completion `{schema:2,eventId,epoch}`、Graph `{schema:2,jobId,epoch}`。Business token、strict schema、epoch 在任何新 work ID claim／state lookup 前驗證。
- 已驗證 authentication 的 schema=1 或合法不同 epoch task 回 204；malformed 或未授權不是 stale。DB outage 不能取得 authority，就重試／失敗，不 ACK。
- Host→Runtime Graph completion 使用 `X-Deployment-Epoch`；合法舊 evidence 不 enqueue。Host `epochs/UUID/profiles/...`、Runtime `epochs/UUID/graph/...` 避免讀取／覆寫舊 object。保留兩 queues 及整個 bucket，不要求 purge。
- Cloud startup 仍使用 PostgreSQL／GCS durable adapters，不啟動 local registry/snapshot 自動匯入。Host 新 profile 只依原 seed contract 使用 SOUL／明確批准的 skills；舊 session/state/workspace snapshot 不從 bucket list 回填。
- Managed LLM/model/prompt/control 配置從現有 runtime config seed。靜態 deployed Bots 依原 explicit bootstrap 設定可重新 seed；只存在舊 DB 的使用者 Bot、Session、Graph Memory、未完成 Run、Outbox 與 editable DB-only 設定已丟棄，使用者需由前端重建。

## 本機驗收與實測命令

<!-- no-tmp: ok — explicitly disposable local PostgreSQL socket -->
測試使用專用 Docker `postgres:17@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c`、loopback 55432、`/tmp/hermes-clean-pg-socket`。Python test env 由 PM 的 `pm.build_env --extra agui --extra agui-cloud --group dev --group test` 建立。未使用正式 DSN 或 GCP credentials。

主要命令（環境路徑可依操作者本機調整）：

```bash
PG_SOCKET=/tmp/hermes-clean-pg-socket # no-tmp: ok — disposable local PostgreSQL socket
HERMES_PYTHON=/workspace/work/clean-bootstrap-test-env/bin/python \
AGUI_LLM_TEST_ADMIN_URL=postgres://hermes@127.0.0.1:55432/postgres \
HERMES_AGUI_TEST_DB_SOCKET="$PG_SOCKET" \
CI_EVIDENCE_DIR=/workspace/hermes_agui/work/ci-evidence-final-complete \
COMPATIBILITY_BASE_COMMIT=747c0978ac111b8b233d486cfd0e99647978ad12 \
bash scripts/ci/llm_offline_ci.sh
```

此命令重用原 critical gates：migration integrity、rollout policy、Python API／rollout／PG、TypeScript/build、managed runtime／registry、Tasks／Worker／事件鏈、PG schema／release。另執行 targeted canonical `scripts/run_tests.sh`、`npx tsc --noEmit`、`bash -n`、workflow YAML parse、`git diff --check`。實際結果如下。

| 驗收 | 本機證據／結論 | 正式環境尚需核對 |
|---|---|---|
| C01 | Fake clean 不查舊 capability、不執行 drain；PG unknown migration／schema drift 可清除重播 | 舊 revisions 的實際 inventory |
| C02 | push 強制 rolling；錯確認／branch／target／approval／run attempt 阻擋；既有 stale-main gate 重用 | GitHub reviewer policy／review API、WIF |
| C03 | 真 PG17 OID、role OIDs、extensions、sentinel schema/table/data 保留；data／ledger 清除，catalog pending=0 | 真 instance／owner／grants binding |
| C04 | 真 PG 外部 dependent view／extension member 阻擋；preflight 驗 owner／CREATE／role；未知 consumer fail closed | GCP 外部 producers、跨系統 dynamic SQL inventory |
| C05 | 真舊 login/session 被 NOLOGIN／terminate 後不可存取新 schema；新 login 可繼承既有 grants | Secret effective deny、實際 Cloud Run 停止及在途連線 |
| C06 | 真 PG ID 碰撞 stale ACK 不 claim；新版 task／evidence handler、epoch GCS namespace；v1 與 v2 完整跨 Python/Node publication chain | 實際 Tasks OIDC／business header、GCS IAM／network |
| C07 | 原 PG release bootstrap／hash／contract／fence 測試及新 auth／capability gates | 真 service readiness、images、auth smoke |
| C08 | Fake reset-host／reset-runtime／Host migrate／Runtime migrate／seal／epoch／release／smoke／resume failure containment，無舊 image rollback | 真 GCP API cancellation／manual scaling read-back |
| C09 | create-only/CAS journal、同 operation marker 不重複 DROP、partial reset/recovery、成功重跑拒絕、resumed marker guard | 真 GCS preconditions、GitHub 原 artifact retention |
| C10 | 真 PG 新 Bot／Session／Graph／epoch 在後續 migration 保留；原 current schema/release 零額外初始化測試 | 下一次真正 push main 的 rolling operator verification |
| C11 | Fake GCP＋真 PG17＋原 critical gates；事件模型使用 fixture inference | 未執行真 GCP reset、正式部署、真模型／IAM canary；不宣稱 deployed |

## 結果紀錄

- 完整 `llm_offline_ci.sh`：**PASS**。13 個 Python files／116 tests、Runtime／registry／credential guard 27 tests、Tasks／Worker／PG event chain 22 tests、PG deployment/reset 15 tests（合計 180 tests），全部通過；五個既有 critical gates 均為 PASS。
- 獨立 reviewer／CAS conflict、bounded epoch connection、舊 DSN alias／URI override、不同已 clean generation 拒絕測試均納入最後完整 run。先前 canonical targeted run 也曾 4 files／51 tests PASS；沒有把重複執行加總為額外驗收數。
- 兩個完整 Host→Completion→Graph→Worker→publication chain 測試：legacy NULL epoch 與 clean UUID epoch 均 PASS；使用真 PG 及 fixture inference，沒有連 GCP Tasks 或真模型。
- PG17 deployment suite：**15/15 PASS**，涵蓋同 database OID／roles／extensions／sentinel 保留、外部 view／extension member 拒絕、舊 writer 隔離、marker replay、不重複初始化 release、fence locks，以及新 Bot／Session／Graph 記錄後續 migration retention。
- TypeScript/typecheck/build、migration integrity、shell syntax、workflow YAML parse、`git diff --check`：PASS；最後 `scripts/check --only footguns,ruff,health` 三項 PASS（health 0 blocking／0 advisory）。
- Repository-wide `scripts/check`：17 checks 中只剩 **`no-tmp` 失敗**，是本次未修改的 `host-config.yaml`、`docs/CICD_PRODUCTION_AUTOMATION_REPORT.md` 及兩個歷史 verification artifacts 共 7 個 literal `/tmp` findings；`git diff --exit-code` 已確認這些檔案未變。其餘 checks（含 footguns、ruff、profile archives、health）通過；health 為 0 blocking／0 advisory。未將這個既存 lint failure 宣稱為全綠。
- 完整 critical evidence 在本機 `work/ci-evidence-final-complete/offline-ci.json`；source commit 欄位是當時 HEAD `b8dd8ae`，測試實際包含本次 working tree，並非宣稱已建立／推送新的 source commit。
- 本機未執行正式 GCP IAM／Secret provisioning、Cloud Build、production reset、workflow dispatch／deploy、push 或建立 PR。所有正式操作仍由操作者審閱後執行。
