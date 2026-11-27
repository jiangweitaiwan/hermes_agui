# Event-driven Execution 實作報告

日期：2026-11-28（Asia/Taipei）。本報告記錄 source 與本機驗收；沒有部署 GCP Staging、執行 Production SQL、修改 Production 排程或 Push main。

## 交付狀態與版本

- 基準：`4fffc212dc1d8effd38e0e503d9381556195a5f0`。
- 工作分支：`codex/event-driven-execution`，本機分支，未推送。
- 基準沒有計畫書；已比對並 fast-forward 至 `eca16c9ccce12cc6e589ced9637270d89d4a8268`，其唯一差異是新增計畫書，並完整閱讀。
- Source commit：`24ddbe310ebcdb66299b0076a8427aadccaaee50`；此後的報告 commit 不改執行程式。最終 branch tip 以 `git rev-parse codex/event-driven-execution` 查閱。
- 程式、部署模板、CI critical gates、operator scripts 及必要本機驗收已交付。**Production deployment 仍為 BLOCKED：需要操作者完成下列一次性設定、舊 consumer bootstrap 與真實 GCP 驗證。這不是 DEPLOYED 證據。**

## 實作內容與設計

1. `PostgresRunStore.finish()` 在 Session/profile/outbox transaction 內取得 `RETURNING id`，離開 transaction 且 commit 成功後，同步 bounded best-effort 通知。rollback、不成功的 lease/CAS、非 completed Run 不發通知。enqueue 失敗只留下 event ID 診斷，不更改已提交結果。
2. 新增 `completion_tasks.py`：重用現有 `agui-cloud` 的 Google ADC/Auth 與 httpx，以 Cloud Tasks REST enqueue。payload 僅為 schema 及十進位 bigint 字串；正整數與 PG bigint 上界驗證。使用 server-assigned task name，補償不受 deterministic task tombstone 阻擋。不新增 dependency 或更改 lockfile。
3. Outbox 新增指定 ID 的 SQL 原子 claim，保留 `SKIP LOCKED`、attempt/lease fencing、原有全域 claim、ack/retry 及終態。未到期／他人 leased 回 503；delivered、failed 或不存在回 204。DB 不可用不會被當成空佇列。
4. Host 新增 `/internal/completions/process`，重用 `GraphCompletionDispatcher`、committed evidence generation 與 Runtime durable acceptance。獨立 `x-completion-token`、constant-time 比對、1 KiB body、嚴格 schema/ID；不使用 bot token。Cloud Run IAM 由 provisioning 與 rollout private-policy preflight 保護。
5. 新增 `--drain --max-events 100 --max-seconds 120`；與 `--once` 互斥，空閒立即退出，不 sleep polling。逐筆錯誤進既有 backoff，DB/claim/config/ack 錯誤非零退出。輸出 claimed/delivered/retry/budget_exhausted。legacy local loop 保留，Production Job 受 preflight 限制只能使用 once/drain，升級後轉 drain。
6. 正常 Graph enqueue/dedup、delivery row、Worker claim/publication 及 reconciliation 沿用現有實作；未重寫 Parser、Retriever、Compiler 或 LLM Prompts。原有 bootstrap 已在 Graph enqueue transaction 完成後發 task。
7. 新增 Host `008_completion_fence.sql` 與 Runtime `015_consumer_fence.sql`。consumer 透過固定 search_path 的 SECURITY DEFINER function 取得 deployment fence 共用 row lock；seal 的 UPDATE 等待在途 consumer 完成，再持續拒絕新處理。應用角色只有 EXECUTE，不能開啟 fence。sealed handler 對終態 stale task 安全 ACK，對待處理工作回 503。
8. Worker guard 使用獨立、上限 2 的連線池，避免多個長工作把原 Graph 工作連線池耗盡；隨服務關閉。Completion drain 逐筆持有 guard，不把整批工作放在一個長 transaction。
9. 只追加 migration，未修改歷史 SQL/grants bytes。新 privilege 放在 `event-driven-grants.sql`，納入既有 Host grants checksum、Runtime schema artifact 及 migration gate。Dockerfile 與專用 dockerignore 一併包含新 grant 檔。

### 實際 I/O 邊界

Producer ADC transport 每次 timeout 2 秒，Tasks API 每個 httpx I/O phase 3 秒；不宣稱完整 ADC refresh + HTTP 的總 wall-clock 嚴格等於 5 秒。Dispatcher GCS reload/download 各 30 秒且停用內建 retry、identity transport 5 秒、Runtime httpx 每 phase 10 秒。Endpoint lease 180 秒、task deadline 120 秒；操作者須確認 Host request timeout 至少 120 秒。

Drain 的 max-seconds 是停止接受下一筆工作的 deadline；已開始的外部 I/O 會依上述 timeout 完成，不宣稱可硬中斷。Completion Job 建議 task-timeout 至少 300 秒，max-retries=0。Graph queue 的既有 dispatch/concurrency 不變。

## Database-aware rollout

- preflight 檢查 services、business/preparation jobs、兩 queues、Scheduler targets/OAuth/OIDC、private invoker policy、consumer capability、舊 Completion image/args、固定版本 secrets 與 feature config。
- 舊 Host/Worker 沒有 fence capability，或 Completion Job 與 Host 使用不同 image，維護前即 FAILED_SAFE。這是首次舊版升級的明確拒絕，不會盲目向舊 image 傳 `--drain`。
- 記錄維護 intent → DB fence Run/Pin admission → pause Scheduler → 主動執行舊 Completion/Reconcile Jobs 與 Worker Scheduler RunJob。Worker secret 不下載至 CI runner。
- 在同一 drain budget 重複補償；Preparation drain 只短暫檢查，不再先被動等 300 秒。舊 `--once` 可以重複執行。預設全域 budget 300 秒，`LLM_DRAIN_SECONDS` 可設 30–1800。
- DB empty → pause 兩 queues 並讀回 → 等 business executions → stop services → seal 等待在途 consumer lock → 再次 DB drain → migrations/grants/schema check/release → candidate/readiness/smoke。
- Completion Job 改為 drain 時保留其他 args、identity、VPC、secrets；intentional delta 更新 expected template，其他 drift 仍 fail closed。Host activation delta 注入新 feature config、固定版本 task secret，並繼承舊 Completion Job 的固定版本 Runtime business secret，設定正式 Runtime URL/audience。
- 正式 URL/auth smoke → 開 admission → resume queues → resume Scheduler，讀回後才 DEPLOYED。
- 維護後任何失敗：重新 seal、pause queues/schedulers、stop services、cancel/確認 executions。無法確認寫入 containment_incomplete / execution_cancel_unconfirmed；不做舊 image/pointer rollback，不 purge 或刪 DB 工作。
- `llm-deploy-report` 增加 queue intent/read-back、Scheduler actions、drain iterations、execution IDs、DB counts、feature 非秘密配置及 intentional template changes。DB counts 由 preparation JSON log 取得，只容許三個固定 table 的非負整數；證據缺失也 fail closed，需 CI 的 logging.logEntries.list。

## 實際驗收結果

隔離 PostgreSQL：Docker PostgreSQL **17.12**，只使用本機 disposable databases。Google ADC/Cloud Tasks API 以 fake 模擬，object evidence 使用 filesystem adapter；未把 fake 當成 GCP IAM/網路驗收。

| 驗收 | 結果與證據範圍 |
|---|---|
| E01 | PASS：跨 Python/TS PG test，真正 Host commit → Completion HTTP → Runtime completion acceptance → Graph task HTTP → Compiler/publication；無 Scheduler，Outbox delivered、單一 completed job/page，重送終態 ACK。推論模型及 cloud API 為 fixture。 |
| E02 | PASS：PG outbox constraint 注入 rollback，Run 仍 running、無通知；重新 commit 才通知，另一連線能觀察 committed event。 |
| E03 | PASS：PG test 注入 producer timeout，Run completed 不變，event 留存，手動 drain 成功。crash-before-enqueue 由同一 durable event/fallback 路徑恢復，未真的 kill Host process。 |
| E04 | PASS：四條並行 targeted claims 僅一筆成功、expired attempt 無法 ack/retry；既有 Runtime PG tests 驗 durable ACK loss/dedup 與 publication fencing。 |
| E05 | PASS：leased/not-available/DB failure/terminal stale task；不能錯誤 ACK 工作。 |
| E06 | PASS：Graph enqueue failure 保留 delivery row；既有兩個獨立 Worker process takeover test 驗 expired lease、舊程序不能 publish。 |
| E07 | PASS：空 drain、101 個候選事件只取 100、單筆 failure 不擋其他事件、時間 budget。 |
| E08 | PASS：token/method/body/schema/bigint guards；private IAM policy 靜態 preflight 與 provisioning 模板已提供，真實 IAM 待操作者驗證。 |
| E09 | PASS（fake GCP）：pending drain 一次後重複執行舊 once/reconcile，先補償後 queue pause/seal/migrate，不等自然 tick。 |
| E10 | PASS：無界舊 Job、缺設定、無 consumer capability 均 FAILED_SAFE；activation test 驗固定版本 Graph secret 繼承。舊版自動 bootstrap 不被宣稱支援，見下節。 |
| E11 | PASS：Host/Runtime PG lock tests 真正讓 seal 等待 active consumer；後續 consumer 被拒，terminal task ACK。Cloud Run instance shutdown 未在 GCP 實測。 |
| E12 | PASS（fake GCP）：schema/preflight、drain budget、pause/resume、migration/release、smoke/traffic failure 注入；保留 containment incomplete，不自動回滾或刪工作。GCP cancellation 實際終止延遲未測。 |
| E13 | PASS：連續兩次 fake rollout 回復所有 managed states；PG tests 驗 migration/release replay 不新增 Release/Audit、DDL/ledger rollback 與歷史 upgrade。 |

測試命令與最後結果：

```bash
# PM 建立測試環境；不得對 Hermes environment raw pip/uv install。
python -m pm.build_env --source . --out work/cloud-test-env \
  --extra agui --extra agui-cloud --group dev --group test
export HERMES_PYTHON="$PWD/work/cloud-test-env/bin/python"
# HERMES_AGUI_TEST_DB_SOCKET 指向 disposable PG17 socket。
scripts/run_tests.sh \
  tests/hermes_agui/test_completion_tasks.py tests/hermes_agui/test_completion_postgres.py \
  tests/hermes_agui/test_storage_migrations.py tests/hermes_agui/test_server.py \
  tests/scripts/test_llm_image_rollout.py tests/scripts/test_llm_release_manifest.py \
  tests/scripts/test_cicd_integrity.py tests/scripts/test_event_queues.py
# 最後完整一組：75 PASS、0 failed、0 skipped。

# 下列兩組使用 disposable PG17 URL，並設定 AGUI_LLM_TEST_HOST_PYTHON。
npm --prefix examples/copilotkit test -- tests/event-driven-postgres.test.ts \
  tests/cloud-tasks.test.ts tests/cloud-worker.test.ts tests/wiki-postgres-sources.test.ts --maxWorkers=2
# 21 PASS
npm --prefix examples/copilotkit test -- --config vitest.database-deployment.config.ts
# 7 PASS
npm --prefix examples/copilotkit run build
# tsc --noEmit + Vite build PASS；既有大 chunk 提示，沒有 build error。
python -m scripts.ci.migration_gate
# PASS：歷史 checksum 保持，追加 migration/grants 已納入。
python scripts/check --only ruff,health,install-root --base 4fffc212dc1d8effd38e0e503d9381556195a5f0
# PASS
bash -n deploy/gcp/setup-event-driven.sh deploy/gcp/set-event-reconciliation-schedules.sh scripts/ci/llm_offline_ci.sh
git diff --check
# PASS
```

不重複的必要案例合計 **103**（Python 75 + TS Graph 21 + PG deployment 7）。本機 logs 在 `work/`：`final-python-tests.log`、`rollout-final.log`、`graph-tests-final.log`、`database-tests-final.log`、`build-final.log`、`migration-gate.log`、`check-targeted-final.log`。

完整 `python scripts/check` **沒有通過**：既有 artifacts/docs/host-config 的 no-tmp 命中，及 `work/` 內自行建立的 Python dependency archives 被 profile-archive guard 判定為 source archive。第一次掃描還掃到 toolchain；加入本機 ignore 後 code health 已通過。觸及的 install-root 問題已改用標準 project_root_str 修正，定向三項 check 已通過。沒有為本案放寬 lint baseline 或移除驗證。未跑無關全量 E2E、完整 Host Docker image build 或安全掃描。

## 一次性 GCP 設定（Cloud Shell，操作者執行）

以下是待執行指令，不是本次已執行紀錄。先確認 PG17、backup、維護窗口、既有 application/owner roles 與 owner secrets、3 services/4 Jobs/3 Scheduler、既有 Graph queue。Owner DSN 只留在兩 preparation Jobs。

```bash
export GCP_PROJECT_ID=copilotkit-agui GCP_BUILD_REGION=asia-east1
export GRAPH_QUEUE='填入既有 Graph queue'
export HOST_EXECUTION_SA='填入現有 Host execution SA'
export COMPLETION_DISPATCH_SA='填入同 project 的低權限 dispatch SA'
export COMPLETION_TOKEN_SECRET=hermes-completion-task-token
export GRAPH_COMPLETION_TOKEN_SECRET='填入現有 Runtime completion token Secret 名稱'
# 專用 token：不要 echo、不放 shell literal、GitHub vars 或 repo。
gcloud secrets create "$COMPLETION_TOKEN_SECRET" --project="$GCP_PROJECT_ID" --replication-policy=automatic
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add "$COMPLETION_TOKEN_SECRET" \
  --project="$GCP_PROJECT_ID" --data-file=- --format='value(name)'
# 記下 numeric version。已存在的 secret 不重建；需要 rotation 才新增 version。
bash deploy/gcp/setup-event-driven.sh apply
bash deploy/gcp/setup-event-driven.sh check
```

Script 的 check/apply 分離；apply 建 queue、rate/retry tuning 與 IAM，不執行 SQL/Job、不啟用 Host、不改頻率。Completion queue：2 concurrent、2/s、8 attempts、10–300 秒 backoff、1800 秒 retry duration；Graph queue 不改 tuning。

權限：Host SA 只對 Completion queue enqueuer、對 dispatch SA actAs、讀兩個 business token secrets；dispatch SA 只對 Host run.invoker。確認 Cloud Tasks service agent 的 roles/cloudtasks.serviceAgent 發 token 權限存在。CI SA 的 queue custom role 只有 get/pause/resume，綁定兩 queues，沒有 purge/delete；另補 cloudscheduler.jobs.run、logging.logEntries.list，沿用現有部署/取消 execution 權限。private IAM 不得有 allUsers/allAuthenticatedUsers invoker 或停用 IAM check。

### 真實 Scheduler contract 必須先驗證

官方 [RunJob](https://cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs/run) 說明強制 dispatch，並列出 cloudscheduler.jobs.run；其文字未明示 PAUSED state 的實際 dispatch 保證。因此本案**沒有宣稱已驗證 paused RunJob**。先由操作者在維護窗口針對既有 Worker Scheduler pause → run → 檢查 Worker reconcile 實際成功 → 保持 PAUSED read-back → resume，成功後才設定確認 variable；若不支援，停止，不啟用自動 rollout，改以受控 GCP Job invocation 做後續修正。

```bash
gcloud scheduler jobs pause hermes-worker-schedule --project="$GCP_PROJECT_ID" --location=asia-east1
gcloud scheduler jobs run hermes-worker-schedule --project="$GCP_PROJECT_ID" --location=asia-east1
# 在 Cloud Logging 確認 reconcile 回應成功；不要輸出完整 Scheduler headers。
gcloud scheduler jobs describe hermes-worker-schedule --project="$GCP_PROJECT_ID" --location=asia-east1 --format='value(state,lastAttemptTime)'
gcloud scheduler jobs resume hermes-worker-schedule --project="$GCP_PROJECT_ID" --location=asia-east1
```

Queue pause/resume 權限對照官方 [pause](https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues/pause)／[resume](https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues/resume)。pause 仍可 enqueue，不能當成取消在途 HTTP；本案另以 DB consumer fence 保護。

### GitHub 非秘密 variables

在既有 llm-deploy environment 設置（使用實際 queue 名稱）：

```bash
gh variable set LLM_CLOUD_TASK_QUEUES --env llm-deploy --body '["hermes-completion-delivery","實際GraphQueue"]'
gh variable set LLM_SCHEDULER_JOBS --env llm-deploy --body '["hermes-completion-schedule","hermes-reconcile-schedule","hermes-worker-schedule"]'
gh variable set LLM_DRAIN_SECONDS --env llm-deploy --body '300'
# 只有完成 paused RunJob 實驗、以及確認沒有未納管 producer/consumer 後才設 true。
gh variable set LLM_PAUSED_SCHEDULER_RUN_VERIFIED --env llm-deploy --body 'true'
gh variable set LLM_MANAGED_PRODUCERS_CONFIRMED --env llm-deploy --body 'true'
```

`LLM_COMPLETION_CONFIG` JSON 僅包含 project/location/queue/host_url/service_account/token_secret/token_version；正式 Host base URL 必須來自現有 service，不能是 revision tag。token_secret 是 Secret 名稱，token_version 是固定 numeric version。Runtime token 的固定 Secret binding 從舊 Completion Job 繼承；若缺失 preflight 拒絕。保留既有 AUTO_DEPLOY_ENABLED、COMPATIBILITY_BASE_COMMIT，未完成下面 bootstrap 前不要開自動部署。

```json
{"project":"copilotkit-agui","location":"asia-east1","queue":"hermes-completion-delivery","host_url":"https://實際Host正式URL","service_account":"實際dispatch-SA@copilotkit-agui.iam.gserviceaccount.com","token_secret":"hermes-completion-task-token","token_version":"1"}
```

## 首次舊版 bootstrap 與正式部署順序

**尚未執行／需操作者審核的 prerequisite**：指定基準的 consumer 沒有新 DB lock，無法用 queue pause 證明它已靜止。自動 rollout 因此在 preflight 拒絕這個版本；不能跳過 capability 檢查或假造 env flag。

1. 完成上述 queue/IAM/secrets、paused Scheduler RunJob 實驗、inventory 與 backup。先以既有 pipeline build 經審核 immutable images，關閉 AUTO_DEPLOY_ENABLED；不更改 Release/Task Contract。
2. 操作者在受控維護窗口使用既有 database preparation `fence`，pause 三 Scheduler，保持舊 services/queues 可工作。主動重複執行舊 Completion `--once`、Host Reconcile、Worker reconcile，直到三個 DB work counts 為零；等待已知 executions 終止。若舊 Completion 是 infinite loop，先明確改為舊版支援的 once，保留所有其他 args。
3. pause 兩 queues 並讀回，stop 舊 services。**必須另確認所有舊 consumer 已終止；做不到就停止，不進任何 migration。** 本機 fake 不足以核准此步，這是首次 bootstrap 的人工 blocker。
4. 由操作者明確核准後，以兩既有 preparation Jobs 掛新 immutable image，依既有 migration framework 執行 Host migrate/grants、Runtime migrate/grants/check；只有追加的 008/015，不更改歷史 SQL。先 seal，保留既有 release check/bootstrap/upgrade，不直接改 pointer。
5. 三 services 與兩 business Jobs 換新 images；Host 只在此新 revision 綁定 task producer config、專用固定版本 token、既有 Runtime completion 固定版本 token、Runtime 正式 URL/audience。Completion args 使用 drain 並保留 audience/prefix/VPC/identity。Owner secrets 不掛到 services。
6. 驗 readiness、正式 URL auth guard、Host `completionFence:1` 與 Worker `graphFence:1` capability、immutable digests、Completion image 與 Host 相同、無歷史 tags。以 existing preparation `resume` 開 DB admission，resume queues/schedulers 並讀回。不能取得這些證據就維持 containment，不宣告 bootstrap 完成。
7. 此後合併經審核 commit 至 main，由 CI database-aware rollout 執行；只有 `llm-deploy-report` 的 DEPLOYED 才算自動部署成功。本次未替操作者 merge/push main。
8. 正常 Session 驗收不等 Scheduler、outbox delivered、graph completed、單一 publication；手動執行 bounded Completion/Host/Worker reconciliation 驗 fallback。不故意破壞 production credential 或刪 task。
9. 正常路徑與主動 drain 都成功後，才降低頻率：

```bash
EVENT_PATH_ACCEPTED=true bash deploy/gcp/set-event-reconciliation-schedules.sh --apply
# Completion 0,30；Host 5,35；Worker 10,40；timezone Asia/Taipei。
```

這是同一 source 交付中的一次性 operator bootstrap，不是宣稱已自動完成從未具 consumer fence 的舊版升級。此人工確認與真實 GCP 驗證未完成前，Production 仍 BLOCKED。

## RECOVERY_REQUIRED 向前修復

先保留 report、migration ledger、Release/pointer/audit 證據；不要回滾 image 或 SQL、不要 purge/刪工作。確認 admission sealed、兩 queues PAUSED、三 Scheduler PAUSED、services stopped、所有 preparation/business executions 終止。任何 cancel/stop/封鎖未能確認，保留 containment_incomplete，不開 admission。

修正當前 schema/release/config 並以最新契約向前重跑準備與檢查；已提交 migration 由 checksum/ledger 跳過。確認 Completion args 為 drain，Host feature/audience 與固定 secret versions 正確。完成新 revision readiness/auth smoke 與 sealed drain 後，才按 admission → queues → Scheduler 的順序恢復；若 resume 中途失敗重新 containment，不能把剛進來的新工作當空。

```bash
for queue in hermes-completion-delivery "$GRAPH_QUEUE"; do
  gcloud tasks queues describe "$queue" --project="$GCP_PROJECT_ID" --location=asia-east1 --format='value(name,state)'
done
for job in hermes-completion-schedule hermes-reconcile-schedule hermes-worker-schedule; do
  gcloud scheduler jobs describe "$job" --project="$GCP_PROJECT_ID" --location=asia-east1 --format='value(name,state,schedule,timeZone)'
done
gcloud run jobs describe hermes-completion --project="$GCP_PROJECT_ID" --region=asia-east1 --format='value(spec.template.spec.template.spec.containers[0].args)'
# Feature read-back 僅檢視上述非秘密 feature keys 與 secret version references；不要 dump 全 env/headers。
```

未完成項目：真實 GCP provisioning/IAM/network/deadline/cancellation、paused RunJob dispatch、初次舊 consumer 終止/bootstrap、production Session/fallback 驗收、頻率調整；完整 repository lint 仍有上述阻擋。這些限制保留在報告中，沒有以 fake 成功或刪驗證取代。

## 變更檔案

- `.github/workflows/llm-images.yml`
- `Dockerfile.agui`
- `Dockerfile.agui.dockerignore`
- `deploy/gcp/cicd/migration-baseline.json`
- `deploy/gcp/event-driven-grants.sql`
- `deploy/gcp/host.env.example`
- `deploy/gcp/set-event-reconciliation-schedules.sh`
- `deploy/gcp/setup-event-driven.sh`
- `docs/EVENT_DRIVEN_EXECUTION_PLAN.md`
- `examples/copilotkit/server/graph/tasks.ts`
- `examples/copilotkit/server/index.ts`
- `examples/copilotkit/server/storage/deployment-operations.ts`
- `examples/copilotkit/server/storage/migrations/015_consumer_fence.sql`
- `examples/copilotkit/server/storage/schema-contract.ts`
- `examples/copilotkit/server/worker-http.ts`
- `examples/copilotkit/tests/acceptance/database-deployment.pg.ts`
- `examples/copilotkit/tests/cloud-worker.test.ts`
- `examples/copilotkit/tests/event-driven-postgres.test.ts`
- `hermes_agui/cloud_identity.py`
- `hermes_agui/server.py`
- `hermes_agui/storage/completion_delivery.py`
- `hermes_agui/storage/completion_http.py`
- `hermes_agui/storage/completion_tasks.py`
- `hermes_agui/storage/host_settings.py`
- `hermes_agui/storage/migration_grants.py`
- `hermes_agui/storage/migrations/008_completion_fence.sql`
- `hermes_agui/storage/objects.py`
- `hermes_agui/storage/run_outbox.py`
- `hermes_agui/storage/runs.py`
- `scripts/ci/completion_rollout.py`
- `scripts/ci/database_rollout.py`
- `scripts/ci/event_queues.py`
- `scripts/ci/llm_offline_ci.sh`
- `scripts/ci/llm_rollout.py`
- `scripts/ci/migration_gate.py`
- `tests/hermes_agui/completion_event_probe.py`
- `tests/hermes_agui/test_completion_postgres.py`
- `tests/hermes_agui/test_completion_tasks.py`
- `tests/scripts/test_event_queues.py`
- `tests/scripts/test_llm_image_rollout.py`
- `docs/EVENT_DRIVEN_EXECUTION_REPORT.md`
