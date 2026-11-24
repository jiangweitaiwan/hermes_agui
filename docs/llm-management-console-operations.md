# LLM Management Console Part 1 維運

本文件是操作程序，不是 GCP 部署證明。先讀
[Unification 部署](llm-unification-deployment.md)、[review/reject SOP](llm-unification-part-2-operations.md)
與 [Part 1 報告](llm-management-console-part-1-report.md)。不得使用 production credentials 做測試。

## 設定及權限

沒有 `llmControl` 時仍為原 static 行為，無控制面資料庫依賴。
Runtime 的 `llmControl`：`mode: static|managed`（預設 static）、固定 `scope: deployment`、
`admins: principal[]`（部署層級身分，不能直接使用 workspace owner 清單）、`approved: RegistryConfig`。
`approved` 是運維批准的 provider/project/location/endpoint/secret-reference/model 選單，不能經管理 API 擴張。
既有 `llm` 是 bootstrap baseline；managed 啟用後，新工作以 DB active release 為準。
`llmFingerprint` 仍核對啟動 baseline，release 另有完整 snapshot hash。

範例：[Runtime](../deploy/gcp/runtime.managed.example.json) 預設 static，避免複製後意外啟用；
[Host](../deploy/gcp/host.managed.example.yaml) 是 bootstrap 完成後使用的 managed 範例。
Host 的 `llmControl` 僅含 `mode: managed`、`approved`、`taskFingerprint`；後者必須來自相容 image
的 `taskFingerprint()`，不是從 browser 接收。範例沒有任何真實憑證。
保留現有 template ID、Bot ID、principal、project、profile seed 和 thread mappings。

| Consumer | 新 secret reference（僅 DSN，值不放 config） | DB 身分 |
|---|---|---|
| Runtime inference / run pins | `AGUI_LLM_DATABASE_URL` | `hermes_llm_runtime`：SELECT 控制面、INSERT run pins |
| Runtime admin API／可信 CLI | `AGUI_LLM_ADMIN_DATABASE_URL` | `hermes_llm_admin`：draft/pointer 寫入、release/audit/opt-in INSERT |
| Worker／Completion／Reconcile | `AGUI_LLM_DATABASE_URL` | `hermes_llm_reader`：SELECT 控制面 |
| Host | `AGUI_LLM_DATABASE_URL` | `hermes_llm_host_reader`：SELECT releases/active/run pins |

運維先在 disposable/staging DB 建立獨立 LOGIN identities，再由 schema owner 套用
[Runtime 011](../examples/copilotkit/server/storage/migrations/011_llm_control.sql) 與
[最小 grants](../deploy/gcp/llm-control-grants.sql)。原 `hermes_runtime` 只新增 active pointer SELECT，
供 Graph enqueue 在原 transaction 中綁 pin；不授 Host owner 存取 Runtime DB。
Worker 不掛載 admin DSN，不可改 draft 或 pointer。Host 的唯讀 DSN 指向 Runtime DB，原 Host DSN 不變。
新 tables 與 triggers 不由冷啟動建立；既有 migrator ledger 保證 migration transaction 及重跑冪等。
Runtime／Worker 的 Graph ledger、control reader 與 admin DSN 必須使用相同 host/socket、port、database
destination（credentials 可不同）；啟動／執行邊界會拒絕不同目的地，避免同名 release-001 在不同 DB 混用。
Host 則用專屬 reader 連此 Runtime database，原 Host run/profile database 繼續獨立。

Vertex 使用原 ADC／Workload Identity 與既有 `aiplatform.user`，不部署 SA JSON／固定 access token。
Secret Manager 沿用服務原掛載流程：API 只顯示 reference 名稱／是否掛載，不回傳值。
OpenAI-compatible 僅允許已批准 HTTPS origin/path，不能傳任意 endpoint 或 key。
Node 使用 connection-time DNS guard（IPv4，拒絕 private/reserved、numeric URL、redirect；不走 ambient proxy）；
Host native custom route 重用 `tools.url_safety.create_ssrf_safe_client`，不另寫 Provider Adapter。
目前 Node managed transport 對 IPv6-only endpoints fail closed；部署 allowlist 應使用有 public IPv4 的服務。
Provider 變更仍需管理員確認資料傳送授權；新 secret 尚未掛載時 probe／inference 會失敗，不會自動加 IAM。

## 匯入及 Bot opt-in

先備份 DB 與其參照的 GCS generations、image digests/revisions、流量與 config artifacts。
Runtime/Host 分庫備份及 object generations 必須保持一致參照，不自行清除 sources、evidence 或 vectors。
先部署**相容但仍 static**的 readers，保留目前 routing，完成測試後再啟用。
沒有既有完整 registry 的 legacy 部署，必須先明確提供 registry，工具不會猜路由。

以下從 `examples/copilotkit` 執行，`RUNTIME_CONFIG` 為管理員審核過的檔案；DSN 由現有 secret 掛載：

```sh
node --import tsx server/storage/migrate-cli.ts
node --import tsx server/llm/control-cli.ts bootstrap "$RUNTIME_CONFIG"
# 審核 dry-run 的 candidate hash、七角色、provider、embedding selector 後：
node --import tsx server/llm/control-cli.ts bootstrap "$RUNTIME_CONFIG" --apply
node --import tsx server/llm/control-cli.ts opt-in "$RUNTIME_CONFIG" "$BOT_ID"
node --import tsx server/llm/control-cli.ts opt-in "$RUNTIME_CONFIG" "$BOT_ID" --apply
```

`bootstrap --apply` 明確建立 `release-001`、draft revision 1 與 active generation 1；同一 baseline 重跑
不更新 active／draft，內容不同回 409。CLI 沒有自動 cold-start bootstrap。
`opt-in` 盤點既有 native Bot 的 principal/template/原 model/provider，`--apply` append-only 建立
`llm_bot_roles` 並寫 audit；重跑不重複 audit。沒有改 Bot record、identity、credentials、ACL 或 thread。
每個 Bot（包括新建立的 Bot）必須明確 opt-in；未 opt-in 的 Bot 在 managed Runtime 拒絕新 run。
不能將 remote AG-UI Bot 誤當 Hermes native Bot。static 部署的 Bot 不受此表影響。

managed 啟用前 drain pending/running 未 pin Graph jobs；startup 會拒絕這些 rows。
保留 historical completed/failed rows，禁止任意補 pin 或在 retry 時讀新 active。
歷史未 pin job 若需執行，先在相容 static revision 完成處理及 review，再進 managed 切換。
managed 下人工 retry 只保留原 pin；本階段沒有「用新設定重跑相同 source version」API。
需要新設定的新 ingest 必須建立新的 source/version 工作，不可直接 UPDATE 舊 pin。

既有 scoped `ingest-cli.ts` 支援同一 `llmControl` 設定；compiler 必須是
`{registry: BASELINE_REGISTRY, role: "graph_parser", managed: true}`，如提供 embedding 也必須是
對應的 registry `graph_embedding` route。沒有 managed reader 的 static CLI 拒絕執行／發布 pinned job，
pre-011 的 static database 不需新 tables。Worker `process/tick/reconcile` 的 one-shot entrypoint
會關閉新增 reader/admin pools；不修改 Completion／Scheduler／Reconcile topology。

## 啟用與發布

1. 核對所有 Runtime／Worker／Host image 的 code contract、task/model hashes、DB grants 及 approved policy。
   Host managed startup 用專屬 reader 核對 active snapshot；Runtime startup 同樣驗證 schema 與 contract。
2. 停止新 admission／delivery，drain 舊 jobs，完成 bootstrap 及 Bot opt-in。
3. Host 使用 managed 範例；Runtime／Worker 同步把 `llmControl.mode` 改 managed，保留原 native loop、
   Graph config、ACL、review gate、Cloud Tasks topology；確認全部 consumer 相容後才恢復新工作。
4. 在 Vercel 現有 AppShell 開啟 **LLM Management**。維持既有 `VITE_RUNTIME_URL` 與 Firebase public config；
   不新增 browser secret／DB DSN。Firebase `uid → principal` 仍由 Runtime server mapping 決定，
   只有明列在 deployment `admins` 的 principal 可操作 API。
5. Tasks 修改 model/provider／timeoutMs／retries／maxTokens／fallback → 儲存草稿 → 驗證已儲存草稿 →
   審核 active diff/hash → 確認 vendor 授權與 reason → 發布。後端回 201 才算成功。
   409 必須重新載入並驗證；不能覆寫別人的 revision。Embedding／Prompt／Schema／Validator 唯讀。

管理 API prefix `/api/admin/llm/`：GET tasks/providers/draft/releases（`before` 是不透明的 timestamp+ID keyset cursor，25 rows）；
PATCH draft `{expectedRevision, config}`；POST validate `{}`；POST releases
`{expectedGeneration,draftRevision,candidateHash,reason}`；POST rollback
`{target,expectedGeneration,reason}`；POST providers/test `{providerId,draftRevision}`。
固定 deployment scope，未知欄位／scope 拒絕；沿用 Firebase Bearer 或本機 HttpOnly SameSite cookie／origin
檢查。401 未登入、403 非 deployment-admin／origin、409 CAS、413 input >64 KiB、422 typed input 錯誤、
429 限流、503 resolver/config 不可用。錯誤不回傳 DB／provider 原始 exception。
每 principal 每程序 30 requests/min，probe 每程序最多 2 並行、5 秒、32 output tokens、無 retry/fallback。
多副本總量還須用 max instances／現有 ingress rate controls 控制，這不是新建全域流量協調器。

Provider probe 使用固定 synthetic input，不讀真實 session，不代表模型品質／quota／完整 Graph 驗收。
模型 availability、ADC refresh、quota 與跨服務 rollout 仍需 staging live gate。

## Run／Job 與故障

Runtime 在可信 run preparation boundary，按 principal+Bot+Host thread+run ID 原子 INSERT durable pin，
同一 persisted run 重送讀原 pin；snapshot 由 server resolver 載入並核對完整 hash／code contract。
retrieval parser、storyteller 與 native Agent primary 使用同一 release。Embedding selector 以 bootstrap baseline
固定，candidate 不得改任何 embedding model/provider/project/location/dimension/version。
每個新 run 讀 active，無 TTL active cache；snapshot 沒有不受限 process cache。

Runtime 用 Bot-specific memory signing key 簽署 60 秒 reference（不傳 snapshot／route），Host 自行用
專屬 SELECT 身分核對 DB persisted pin、binding、hash 與 baseline task contract。browser forwardedProps
不能覆寫。Host session client key 包含 release ID/model fingerprint；安全的新 run 邊界建立 native client，
native DB 保持相同 session ID／history／tools／skills／memory；執行中的 native tool loop 不換 provider。
如果只修改 Graph route、Agent primary route 完全相同，只更新 release/cache metadata 並沿用原 Agent，
避免重新初始化 native prompt、tools 或 skills，維持 conversation prefix。
native 會按自身規則在新 run 更新 runtime model identity，並非在 in-flight 重組 prompt。

timeoutMs 是 native provider request scope，retries 對應 native `_api_max_retries = retries + 1`，
maxTokens 接 native output cap；不是整個 run 的 deadline。`agent_primary.fallback=[]`。
native auxiliary、compression、MOA／delegation 工具的額外模型仍由 native config 管理，不宣稱全數統一。
AG-UI delegation 使用既有獨立 child run/thread ID：child 在自身可信 boundary 讀 active、獨立 pin；
parent in-flight pin 不變。原 pause/resume 的同一 native invocation 不更換 pin；managed checkpoint resume
明確拒絕（durable Host 原本就不支援 checkpoint resume），不假稱能重建中斷的 tool loop。

Graph source/version/job insert 的同一 DB transaction 持久化 release FK；Cloud Tasks payload 不帶 routing。
Worker 以 ledger pin 解析 snapshot，AsyncLocalStorage 隔離所有 stages／validation／observability。
retry、lease recovery、reconcile 保留 pin；source/revoke／review／fencing 仍由原 publication transaction 決定。
DB trigger 也要求 pinned claim 的相容 reader marker 與 publication 的 verified release marker，
兩者皆為 transaction-local；舊 image 的原 claim／complete SQL 會被拒絕，不靠 Task payload 宣稱相容。
logs 帶 release ID/hash、既有 model/task fingerprints；無原始 source／secret，native logs 帶 release ID/model hash。
Native run metadata 也包含已驗證的 release hash；embedding logs 保留原 selector fingerprint。
獨立 background index 沒有 run context 時明列 null release，不冒填當前 active，向量 key 仍是凍結的 baseline selector。

DB／resolver 故障時，新 managed run 不讀 static 或 cached active，安全失敗可重試。
已載入 snapshot 的 in-flight stages 可在原 deadline 下完成；Graph 若不能 renew lease／完成 publication
仍由既有 fencing 阻擋。missing/incompatible snapshot 不做 inference、不發布部分 Graph，job 依既有失敗／retry
契約處理，source 保留。pool connection budget：Runtime 既有最多 12 + reader 2 + admin 2；Worker
不掛 admin 時最多 12 + reader 2；Host resolver 最多隨既有 admission（預設 8）新增短期 read-only connections，
每個 resolver connection 2 秒 connect、5 秒 query timeout。總量乘 max instances，另保留 owner／scheduler headroom。

## 回滾與雲端 gate

設定回滾：Releases 選舊 release、審核 actor/time/hash、填 reason、expectedGeneration CAS。
只切 pointer 並新增 audit，舊 snapshots、run/job pins、sources/evidence、向量空間全部保留。
不回退 draft、不改歷史 payload，不繞過 revoked/review/rejected gate。

程式回滾：先停止新 managed admission／delivery，隔離未完成 pinned jobs；保留可讀新 snapshot 的 reader，
待原 pin drain/retry 完成，才恢復相容 static images/config。舊 image 不了解 pin 時不得接 managed job。
不 drop migration 011、不清 pin、不單獨回復舊 DB、不修改 vectors／Task topology。

測試命令（Node 22+，Python 使用既有 test environment）：

```sh
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
./node_modules/.bin/tsc --noEmit
npm run build
# Disposable real PG：缺少 URL 時此獨立 gate 直接失敗並標示 BLOCKED，不 skip。
npm test -- --config vitest.llm-control.config.ts --reporter=verbose
./node_modules/.bin/playwright test --config playwright.llm-control.config.ts
```

`AGUI_LLM_TEST_ADMIN_URL` 僅可指向允許建／刪 disposable DB/role 的測試 cluster；gate 在隨機 DB 執行
fresh migration 及 rerun、grants、兩個獨立 Node processes、真實 Python reader，並清理自身測試 DB。
browser gate 用 real Chrome + real API + real PG；只有 inference response 為 scripted local wire corpus，
object storage 是 filesystem，不能算 Vertex 或 GCS 驗收。
Host subprocess 預設使用 checkout 的 `.venv/bin/python`；必須包含 lockfile 中的 `agui-cloud` extra，
或用 `AGUI_LLM_TEST_HOST_PYTHON` 明確指定具備相同 declared dependencies 的測試 interpreter。
此次環境的 PM standalone Python 下載遇到 TLS CA 錯誤，未停用驗證或 raw pip 安裝；實際 PG gate
用既有 staged、與 `uv.lock` 一致的 psycopg 3.3.9，透過測試程序 `PYTHONPATH` 載入，沒有修改 Hermes environment。

獨立雲端 gate：既有 `AGUI_VERTEX_SMOKE_CONFIG`、真實 disposable PG/GCS、ADC／Tasks／Cloud Run staging
須另行提供並明確授權。缺少資源時維持 **BLOCKED**；既有 skip、scripted model 或 local PG 不能替代。
不得因此自動建立 IAM、掛 production credentials 或直接部署 production。
