# CI/CD Clean Bootstrap：原地重建部署計畫

基準 commit：`747c0978ac111b8b233d486cfd0e99647978ad12`  
交付對象：Codex  
範圍：Hermes AG-UI / GCP / GitHub Actions

## 1. 目標與決策

操作者明確允許丟棄舊 Hermes 資料、未完成 Run、Outbox、Graph Memory 與舊 managed control state，並接受停機。首次部署不再要求人工舊 consumer bootstrap。保留同一 Cloud SQL instance、現有 database 名稱（目前預期 `hermes`，以實際 DSN 核對）、roles、密碼、Secret references、Cloud Run services/jobs、既有 queues/schedulers、GCS bucket。**原地重建應用 schema，不新增 database，不 DROP DATABASE，不刪 Cloud SQL instance。** 不改非 Hermes schema、extension 或其他應用資料。舊 GCS objects 保留但隔離，不視為新記憶；不批次刪 bucket。

這是一次性明確授權的 destructive deployment；日常 push 仍使用現有 database-aware maintenance rollout，不因 schema 差異而清空資料。不得將 clean 模式當成自動 fallback。

## 2. 現況與改造邊界

- `.github/workflows/llm-images.yml` 目前 main-only build/deploy；既有 CI gates、WIF、immutable digest、manifest、main tip eligibility、concurrency 不變。
- `scripts/ci/database_rollout.py::inventory()` 在部署前要求舊 Host `completionFence:1`、Worker `graphFence:1`，並要求 paused Scheduler RunJob 已驗證、Completion Job 同 Host image、bounded args。Clean 模式跳過僅適用舊資料保全的 gate 與 active drain，不跳過共用安全檢查。
- `completionFence` / `graphFence` 是新版 endpoint `/internal/execution-capabilities` 的能力回應，不是手動寫入 SQL 的 flag；新 revision 必須實際回應 1，並驗證對應 DB functions 存在及 fence 行為。
- Runtime `server/storage/deployment-operations.ts` 已提供 check/migrate/release/fence/seal/resume；Host `hermes_agui.storage.migrate` 已有 migration/grants。重用現有 migrators、schema catalog、ledger、control upgrade/bootstrap。不修改歷史 migration bytes，不手寫一套平行最新版 schema。

## 3. Workflow 契約

新增 workflow_dispatch inputs：`deployment_mode` choice（`rolling-upgrade` 預設 / `clean-bootstrap`）、沿用 `deploy` boolean、`confirm_reset` string。Clean 僅在 main、deploy=true、AUTO_DEPLOY_ENABLED=true、明確輸入 `RESET copilotkit-agui/hermes`（實際 target 必須一致）且通過既有 llm-deploy environment approval（若未配置 approval，文件要求設置可用的獨立人工核准）時允許。Push 一律 rolling-upgrade；禁止以常駐 variable 默默觸發 reset。無效 input 在 cloud mutation 前拒絕。若使用 workflow rerun，須防止同一已成功或已開放 admission 的 reset operation 重複破壞資料；要求新的明確確認或專用 recovery 路徑，不盲目重新 drop。

記錄 operation ID、source SHA、manifest digest、target project/instance/database（不含 DSN）、mode、確認與核准狀態。部署前與 destructive boundary 前重新核對 main tip。現有 AUTO_DEPLOY_ENABLED 關閉時可 build-only，但不得 reset。

## 4. 共用 preflight 與 clean 專屬 preflight

保留：3 services、4 jobs、3 schedulers、2 queues 明確 inventory；OIDC/OAuth、private IAM、固定 Secret versions、正式 URL、單 container、entrypoint、managed runtime config、資源與 image digest、template drift、owner roles、PG17、CI evidence、未知 producer/consumer 拒絕。

Clean 專屬：核對 project/region、Cloud SQL instance、所有 Host/Runtime/admin DSN 指向同一預期 database（用安全解析及可信 Cloud SQL binding 核驗，不輸出密碼）；核對 current_database/current_user、schema ownership、跨 schema dependencies、roles 與 grants 能力。若不確定目標或發現非 Hermes 物件依賴，fail closed。舊 schema drift / unknown migration 不應阻止經授權的重建，但必須確認重建範圍；舊 capability、舊 completion image mismatch、舊 once/drain、paused RunJob 驗證不是 clean 的前置條件，因為不執行舊 drain。未完成部署留下 tags/manual scaling 等仍拒絕一般 clean，改走明確 recovery，不假裝安全。

## 5. 原地重建完整順序

### 5.1 建置與停止舊工作

1. CI critical gates、Cloud Build、manifest 驗證，準備 immutable Host/Runtime digests；完成 preflight。
2. 持久記錄 reset intent（存於不被 reset 的受控部署 journal；不得只依賴 runner 暫存檔）。切入 maintenance，先阻止外部新 Run / producer，pause 三 schedulers、兩 queues 並讀回。停止三 services（scaling=0）、取消所有 business/preparation executions 並確認終態；盤點歷史 revision tags / 其他入口、DB connections、在途請求。不得要求舊 drain，也不依賴舊 schema fence。
3. **證明舊 consumer 無法再寫入重建後的 schema**：僅 queue pause、scaling=0 或暫時沒有 pg_stat_activity 均不充分。設計可驗證的隔離，例如在停止服務後封鎖舊 application DB login / 連線，終止其既有 backend，並在新 revision 使用新 credential（同一 role、Secret 名稱，新固定 version；所有舊 revision/job 不可取得新 credential），或等效的 GCP/DB 強制隔離方案。避免把 owner secrets 給 app 或 CI；如果現有權限做不到，提供一次性最小 provisioning 並 fail closed，不執行 drop。確保 owner / migration 連線不受影響。不得假造 capability 或靠固定 sleep 宣稱 quiescent。
4. 舊 task/evidence 隔離（第 6 節）。所有必要隔離證據確認後才進入 destructive boundary。

### 5.2 重建同一 database 內的 Hermes schemas

在現有 preparation Job identities 中執行新 `reset` 操作；CI 只發 Job 指令，不取得 owner DSN。使用現有 migration/preparation advisory locks，防止並行 schema 操作；若 Host/Runtime owner 不同，分別由正確 owner 執行，明確記錄每個已提交階段。

固定 allowlist（依實際 migration inventory 確認完整性）：

- `hermes_agui_host`
- `hermes_agui_host_migrations`
- `hermes_agui_runtime`
- `hermes_agui_runtime_migrations`

若 LLM control / 其他 Hermes 元資料位於獨立 schema，由 Codex 查證 migration 定義及 ownership 後明列於固定 allowlist；不得動態 drop 任意 prefix、public schema 或非 Hermes 物件。先檢查 CASCADE 依賴範圍，禁止刪除 allowlist 外物件。使用固定 SQL identifier、transaction、lock/statement timeout；不得使用使用者輸入拼接 DDL。清除 migration ledgers 與 grants ledgers，避免空 schema 被判斷已 migrated。保留 instance/database OID、roles、extensions 與 unrelated data。

重建後順序：Host migrate+grants → Runtime migrate+grants → schema/ledger/catalog check（pending=0）→ seal admission/consumer fences → release（空 control store 自動 bootstrap）→ 驗證 active release/registry/prompt/schema contract。由於會從空資料庫 schema replay，008/015 和此前所有有效 migrations 都必須執行；省略的是舊資料相容性升級，而非新 schema 初始化。以現有 managed runtime config 作 seed；舊 Bot/模型設定若只存在 DB 不保留。明確區分可重新 seed 的配置與需使用者前端重建的 Bot。

### 5.3 新版服務與恢復

重用現有候選 revision / immutable digest / template verify 流程；Host 注入 LLM_COMPLETION_CONFIG 對應 feature env、固定 version task token、Runtime 正式 URL/audience 與既有 Graph completion secret（隔離若需 rotation 則使用核准後的新版本）。Runtime/Worker 使用新版 digest，Completion/Reconcile 使用新版 Host digest；Completion 轉 `--drain --max-events 100 --max-seconds 120`，保留其他必要 args，timeout 至少 300s、max-retries=0。確保 intentional config delta 有證據，其餘 drift fail closed。

驗證新版 readiness、正式 URL auth guard、Host/Worker capability=1、DB consumer fences 已閉、active release、images/jobs、無舊 tags、舊 credential 不可寫入。確認新 producer/consumer 的 epoch 一致後，database resume → queues resume → schedulers resume 並 read-back。寫入 DEPLOYED；若尚未驗證 paused RunJob，允許 clean 完成，但後續 rolling-upgrade 仍需真實驗證該 contract，不可自動設 true。

## 6. 舊 Cloud Tasks 與 GCS 隔離（不可省略）

目前 Completion payload `{schema:1,eventId}` 可能重用 bigint ID；Graph payload `{schema:1,jobId}` 也無 deployment epoch。Queue pause 不取消已 dispatch 的 request。因此建議加入 durable reset epoch（UUID），由 preparation 初始化，保存在不會與舊值碰撞的部署狀態，所有新 producer/task handler、reconciliation 共享同一 DB authority。兩種 task payload 使用新版 schema 並包含 epoch；嚴格驗證 business token、schema、epoch 後才 claim。舊 schema/epoch 在已完成 authentication 且可證明是舊任務時安全 ACK，不得查詢/修改新工作的 ID。普通 rolling-upgrade 不旋轉 epoch；舊版到新版的 rolling 路徑須有清楚相容或排空策略，不可靜默丟工作。DB 不可用時不能誤 ACK。跨 Host/Runtime evidence 交付也要校驗 epoch 或使用等效不可重用 identity。

保留兩個現有 queues；不要求 purge（現有 CI role 刻意沒有 purge/delete）。若有大量 stale tasks，可由另行明確授權的 operator 清理，非必要路徑。舊 GCS objects 使用新 epoch prefix 或等效隔離機制；確認舊 evidence 不被 list/import/reconcile 誤攝取、同名 object 不覆蓋。檢查 runtime/host bootstrapping 是否有自動匯入舊 Bot、session 或 local snapshots，clean 不可意外恢復被丟棄資料。不得刪除整個 bucket 或其他 prefix。

## 7. Recovery 與重入

FAILED_SAFE：destructive boundary 前阻擋且未開始維護；已開始維護即 RECOVERY_REQUIRED，保留階段證據。失敗後停止 services、pause queues/schedulers、取消 executions、封鎖舊 identities；若 schema 尚未存在，不依賴 seal 成功才 containment，記錄 unavailable/incomplete。不得開放部分重建 schema，不回滾至舊 image/pointer。

Journal 要在 reset schema 之外（例如專用 GCS deployment journal prefix，使用 generation preconditions、最小權限，無 credentials）；記錄每個 reset phase / epoch / destructive transaction commit 證據。若 crash 發生於 commit 與 journal 之間，用 DB catalog/ledger/epoch 核對；不確定即停止。復原使用同 operation ID 與明確 recovery 授權，從已驗證階段向前執行；不得重複 drop 已完成 reset 的 schema，尤其禁止已 resume admission 的 operation 再 drop。保留現有 migration/release idempotency。需要重建新的資料世代時，必須另行 dispatch/確認。

## 8. 實作檔案與驗收

主要改動 `.github/workflows/llm-images.yml`、`scripts/ci/llm_rollout.py`、`scripts/ci/database_rollout.py`（可拆 `clean_bootstrap.py`）、`scripts/ci/completion_rollout.py`、Runtime deployment CLI/operations、Host migration/reset CLI、task producers/handlers、必要 additive migrations/grants、GCP provisioning 與 docs。沿用既有 CI gates，不擴增無關全量 E2E，不修改 Hermes agent loop 或 Graph Parser/Retriever/Compiler prompts。

| ID | 驗收 |
|---|---|
| C01 | 舊 Host/Worker 無 capability、舊 schema 有資料且 drift；clean 有明確授權時可進入隔離並重建，不執行舊 drain。 |
| C02 | push、錯誤確認、非 main、錯 project/DB、無核准或 stale manifest：無 destructive mutation。 |
| C03 | 真 PG17：同一 database OID、roles、extensions、非 Hermes sentinel schema/table 資料保留；舊 Hermes data/ledgers 清除，最新 schema/ledger/grants 全通過。 |
| C04 | 非 Hermes 跨 schema dependency、owner 權限缺失或 unknown producer 阻擋，不能 drop。 |
| C05 | 舊連線/consumer 未停止或舊 credential 仍可寫入，阻擋 destructive boundary；真 PG 測試驗舊 writer 無法污染新 schema。 |
| C06 | 舊 Completion ID 與新 ID 碰撞、舊 Graph task、in-flight/stale task、舊 GCS evidence 都不得處理新資料；新 epoch 正常完成 ingest。 |
| C07 | 新 DB control release 初始化、Bot seed 行為符合契約；新版 capability、auth、fence、immutable digests 全通過。 |
| C08 | reset/migrate/release/service/resume 各階段 failure injection：維持 containment，報告可判斷已提交階段，無舊 image rollback。 |
| C09 | crash/replay/recovery、同次成功 workflow rerun：不重複 drop、不丟新資料；新操作須重新授權。 |
| C10 | 下一次 push 使用 rolling-upgrade，保留新的 Bot/Session/Graph Memory，schema 相同跳過不必要 DDL、release 相同無額外 bootstrap。 |
| C11 | Fake GCP 驗證完整指令順序與 fail-closed；真 PG17 測試實際 schema、權限、epoch、reset 隔離。真 GCP IAM/停止服務/事件路徑未測則如實列為 operator verification，不宣稱 deployed。 |

## 9. 交付要求

提供 `docs/CICD_CLEAN_BOOTSTRAP_REPORT.md`：source commit、改動清單、實測命令與結果、原地 reset SQL allowlist/依賴核對、journal/recovery 設計、實際所需 IAM/Secret provisioning 增量、GitHub Actions 操作步驟、未驗證 GCP 假設。目標是既有 GCP 設定最大程度沿用，操作者只需一次性必要權限補齊與 workflow dispatch，無人工 SQL/migration/consumer bootstrap；之後 push 自動走保資料的 rollout。不得自行觸發 production reset、部署或 push main；由操作者審閱後執行。
