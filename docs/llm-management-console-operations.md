# LLM Management Console 維運（Part 3 managed 自動納管）

本文件是操作程序，不是 GCP 部署證明。先讀
[Unification 部署](llm-unification-deployment.md)、[review/reject SOP](llm-unification-part-2-operations.md)
與 [Part 1 報告](llm-management-console-part-1-report.md)。不得使用 production credentials 做測試。

Production CI/CD 改造目前只加入離線 CI 與 source-bound BUILT candidate manifest，
**未完成 staging／production 驗收，不得啟用 production 自動部署**。
查看 [實作盤點](CICD_PRODUCTION_AUTOMATION_INVENTORY.md)、
[初始化與 gate 說明](../deploy/gcp/cicd/README.md) 與
[本次報告](CICD_PRODUCTION_AUTOMATION_REPORT.md)。
既有 `managed_rollout_confirmed` 沒有被固定為 true；它也不能取代計畫要求的 live acceptance、
maintenance fencing、durable recovery 或 jobs template 驗證。

## 設定及權限

沒有 `llmControl` 時仍為原 static 行為，無控制面資料庫依賴。
Static 沒有明確 control DSN 時不開 pools；已 provisioned 的 optional static Console 保留原管理功能，
發布只改控制面，不更換 static inference，也不觸發自動初始化。
Runtime 的 `llmControl`：`mode: static|managed`（預設 static）、固定 `scope: deployment`、
`admins: principal[]`（部署層級身分，不能直接使用 workspace owner 清單）、`approved: RegistryConfig`。
`approved` 是運維批准的 provider/project/location/endpoint/secret-reference/model 選單，不能經管理 API 擴張。
既有 `llm` 是 bootstrap baseline；managed 啟用後，新工作以 DB active release 為準。
`llmFingerprint` 仍核對啟動 baseline，release 另有完整 snapshot hash。

範例：[Runtime](../deploy/gcp/runtime.managed.example.json) 明確設定 managed；
[Host](../deploy/gcp/host.managed.example.yaml) 於 Runtime 完成自動初始化後啟動。原 static examples 保持不變。
Host 的 `llmControl` 僅含 `mode: managed`、`approved`、`taskFingerprint`；後者必須來自相容 image
的 `taskFingerprint()`，不是從 browser 接收。範例沒有任何真實憑證。
保留現有 template ID、Bot ID、principal、project、profile seed 和 thread mappings。

| Consumer | 新 secret reference（僅 DSN，值不放 config） | DB 身分 |
|---|---|---|
| Runtime inference / run pins | `AGUI_LLM_DATABASE_URL` | `hermes_llm_runtime`：SELECT 控制面及可信 Bot registry、INSERT run pins |
| Runtime admin API／可信 CLI | `AGUI_LLM_ADMIN_DATABASE_URL` | `hermes_llm_admin`：draft/pointer 寫入、release/audit INSERT；自動初始化 |
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

## Managed 部署自動初始化與 Bot 納管

`llmControl.mode: managed` 本身就是 deployment-level opt-in，沒有逐 Bot 啟用開關。
正常部署不執行 bootstrap／opt-in CLI，不需要 SQL 補 rows 或前端初始化按鈕。
保留全部既有 Bot ID、principal、template、credential seed、ACL、thread、release、draft、audit 和 pin。
外部 remote AG-UI Bot 保留其 remote routing；Runtime 管理的 Graph stages 仍使用 durable release pin。
Native auxiliary/compression/MOA 的額外模型依舊 unmanaged。

最短程序：

1. 由既有 schema owner migrator 套用 001–012 及更新後 grants；建立獨立 LOGIN，設定可信 `llm`
   baseline、approved policy、admin principals、ADC／Secret Manager。沒有新 DDL migration，啟動不執行 DDL。
2. 新部署沒有舊 jobs 時不需 drain；既有 static → managed 須先停止 admission/delivery，處理 pending/running
   unpinned jobs，備份 PG/GCS 一致參照與 image/config。不可把歷史 job 補成最新 pin。
3. 以相容 images/config maintenance rollout：**先 Runtime**，使用 inference DSN 與獨立 admin DSN；
   registry、thread mappings、control plane 必須是同一 Runtime DB destination，不能跨 ledger 納管。
4. Runtime 在同一交易內取得 control advisory lock，重讀 state；空控制面從可信 baseline 原子建立
   release-001、draft revision 1、active generation 1 及一筆 actor=`system:managed-runtime` 的 bootstrap audit。
   多 replica 只初始化一次。active 存在則驗證 immutable snapshot/hash/policy/code 與 draft 存在，完全不改
   active/generation/draft/history；合法未發布 draft 不用與 baseline 或 active 相同。
5. Runtime 就緒後才啟動 Host、Worker、Completion/Reconcile。它們只讀，不掛 admin DSN。
   採**部署順序**而非內建 retry：active 缺失時立即 fail readiness（0 次重試）；每個 DB connect 上限 2 秒、
   statement 上限 5 秒。修正 Runtime 初始化或部署順序後由既有 orchestration 重啟，沒有無限應用重試。
6. 確認全部 consumer revision 相容才恢復 traffic/delivery。登入前端 LLM Management 直接編輯／驗證／發布；
   任一既有或新建、active 且授權正確的 Native Hermes Bot 自動繼承 `agent_primary`，不用改 Bot record。

缺 active 但有 release/draft/audit/pin/prompt/embedding plan/舊 opt-in 或 pinned job 歷史，一律 fail closed；
不重新建立初始版本、不回退 static、不自動修復。baseline 無效、schema/grants 缺漏、DB down 或 snapshot
不相容也拒絕 startup/admission。一般 logs/API 不輸出 DSN、secret、prompt/source 原文。
若已完成舊版手動初始化，升級前後比對 active hash/generation、draft revision 與歷史 count，必須不變。

舊 `llm_bot_roles` 與 bot_opt_in audit 原樣保留，正常 inference 不讀它作為 gate；沒有批量偽造 opt-in。
`opt-in` CLI deprecated，只輸出不再需要，連 DB 都不開。`bootstrap` 僅保留離線診斷（預設 dry-run）／受控
初始空庫復原的相容入口；apply 與 Runtime 共用 serialization／驗證，不重設既有 active 或未發布 draft，
缺 pointer 而有歷史時拒絕。這些都不是部署前置步驟。

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
2. 停止新 admission／delivery，必要時 drain 舊 unpinned jobs；Runtime 自動初始化，沒有 Bot opt-in。
3. Host 使用 managed 範例；Runtime／Worker 同步把 `llmControl.mode` 改 managed，保留原 native loop、
   Graph config、ACL、review gate、Cloud Tasks topology；確認全部 consumer 相容後才恢復新工作。
4. 在 Vercel 現有 AppShell 開啟 **LLM Management**。維持既有 `VITE_RUNTIME_URL` 與 Firebase public config；
   不新增 browser secret／DB DSN。Firebase `uid → principal` 仍由 Runtime server mapping 決定，
   只有明列在 deployment `admins` 的 principal 可操作 API。
5. Tasks 修改 model/provider／timeoutMs／retries／maxTokens／fallback → 儲存草稿 → 驗證已儲存草稿 →
   審核 active diff/hash → 確認 vendor 授權與 reason → 發布。後端回 201 才算成功。
   409 必須重新載入並驗證；不能覆寫別人的 revision。Embedding／Schema／Validator 保持 readonly；Prompt 使用 Part 2 的 protected slot 流程。

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

Runtime 在可信 run preparation boundary，按 principal+Bot+Host thread+run ID 原子 INSERT durable pin；pin transaction 與 Bot lifecycle
共用 `(53859273,1)` advisory lock，重查 registry principal/harness/active/deletedAt，避免已停用或刪除 Bot 新建 pin，
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
舊 image 仍要求逐 Bot opt-in，不能直接恢復 managed admission，也不為程式回滾補造 opt-in。
必要時保留新版相容 reader，停止新 admission 並依 SOP 回到已保存可用 static revision。
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

## Console Part 2：Prompt／Schema／Playground

Part 1 基準 source 為 `529375cb53d012fa9604144c8a6986f7d04c20d2`，報告 HEAD 為
`b011cbe`。Part 2 沿用相同 control plane、admin allowlist、CAS、run/job pins、provider approval。
本節為部署操作文件，**不是已完成 GCP 部署的證明**。Cloud gate 未通過不可宣稱 production ready。

相容 reader 須支援 `management-part-1` 與 `management-part-2`。Graph protected contract 為
`graph-v1`，schema/validator 仍為 code v1；Native slot 為 `native-slot-v1`。空 Graph slot 的有效字串
與原 v1 byte-identical；有修改時版本為 `p2-<SHA256(effective text)>`。Prompt version 不等於 code contract
version。release 的 taskFingerprint 包含所有有效文字、schema 及 validator；codeTaskFingerprint 另記部署基線。
舊 image 無法解析 Part 2 release，必須先換相容 reader，不能先發布再讓舊 worker 消耗重試次數。

部署前保存 PG PITR／備份及 GCS generations 一致參照、Runtime/Worker/Host image digests、所有流量、
設定與 active generation/release、舊向量 keys。只在經確認的 disposable/staging 資源測試；不使用 production
source/credentials 做 smoke。部署仍使用現有 GCP build/deploy 流程，不新增 service、scheduler、IAM 或秘密。

1. 用現有 admission／delivery 控制 drain 新工作，列出仍在處理的 pinned jobs/runs；不可只停 queue
   就假定所有 writes 已停止。Prompt rollout 不要求重建索引。
2. Schema owner 透過既有 migrator 套用 additive `012_llm_prompts.sql`（runner 擁有 migration transaction），
   再套用更新後 `deploy/gcp/llm-control-grants.sql`。新增 draft prompts、immutable prompt versions、
   immutable candidate evaluations、immutable embedding plans。Host/Worker 不授任何新寫入權。
   Fresh/rerun 與最小 grants 要在 disposable PG 驗證；既有 migration/table/history 都保留。
3. 相同 artifact 部署 Runtime、Worker、Host 相容 readers，先不發布 Part 2 release。
   Host 既有 policy.taskFingerprint 保持 image 的 **code** fingerprint，不能改填 active dynamic fingerprint。
   保留原 SQL/Secret Manager/ADC 身分、pool/max-instances 預算、Vercel variables、Bot ID/template/profile seed。
4. 在 staging 用 Console Prompts 編輯 slot、儲存、Playground 對照、Tasks 驗證、發布（reason 必填）。
   PATCH body 沿用 expectedRevision/config，另帶完整 `prompts` map；不帶 map 保留已存 slot。
   `prompts` 僅接受五個 Graph stages 與 agent_primary；legacy analysis/generation/merge 唯讀。
   Protected sections 沒有修改 endpoint；輸入為 literal text，`{{...}}` 不作秘密查詢或 template execution。
5. `/validate` 執行 `prompt-safety-v1` deterministic golden/negative suite，紀錄 candidate hash、draft revision、
   suite version、checked/not-run layers。修改 draft 後須重新驗證。此結果不是模型 semantic accuracy；
   正式 provider 品質／p95／token gate 應在已標註 corpus 的 staging 另跑，缺少資源記 BLOCKED。
6. 確認新 job/run 取得新 prompt，原 pin、retry、restart 使用原 release；跨 replica 同樣核對。
   Native slot 走原 ephemeral_system_prompt seam，原 role/tools/skills/memory/history 保留，新 run 才換 slot；
   Graph-only 變更不重建 Native Agent。auxiliary/compression/delegation 的額外 prompts 仍 unmanaged。
7. 觀察 review/reject、backlog、retry exhaustion、p95、provider_attempt usage、quota 與錯誤。
   無 price book 的 cost=null，未知 usage=null，只加總 provider_attempt，不重複累計 publication。
   本版不自動重跑歷史 jobs、不修改 evidence/wiki、不清理舊索引。

新增 APIs（同 `/api/admin/llm` deployment-admin、origin、限流、redacted error 邊界）：

| API | 說明 |
|---|---|
| GET `/prompts/:task` | Active、saved draft、locked contract、version；Native 僅 slot 與組裝說明 |
| GET `/prompts/:task/versions?before=...` | immutable release history，25 筆 keyset page；選舊文字編輯新 draft |
| GET `/schemas/:task` | 部署 Zod 的 provider projection/hash、examples、validator summaries；無 mutation API |
| POST `/playground` | draftRevision、mode、synthetic input、vendorEgressAcknowledged=true |
| GET/POST `/embedding/migrations` | 持久化 plan/status，**不啟用 selector** |

Playground 每 replica 同時一個比較，每個 baseline/candidate arm 最多 10 秒，各 provider request 最多
3 秒、retries=0、fallback=[]、maxTokens<=2048；輸入 4000 UTF-16 units、raw structured output 64KiB，
沿用 API 64KiB body 與 30 requests/min/admin。可取消；各 arm 順序執行。無 store/queue/tool capability，
不寫 source/job/wiki/edge/vector，不發 Cloud Tasks。單 stage 與 bounded ingest/retrieval 重用正式
RegistryLLM/parseSource/resolveSubjects/abstractRelations/QueryParser/Storyteller/validators。
Matcher 使用固定 homonym context、relations 使用空 parsed context、story 使用空 MemoryNet；ingest
由 parser 串 matcher/relations，retrieval 由 query 串空 net story。向量搜尋、ACL、lease、persistence、
publication、完整 Native harness 均 not_run。fallback 不冒稱 semantic success；結果不永久保存，
audit 只記 actor/action，不存 raw input/output。不要把真實 session 或秘密貼入測試。

## Embedding migration gate 與回滾

第一版採 **既有 vectors CLI**，沒有安全的既有 all-writer drain／global watermark oracle，因此 UI 僅
建立 immutable plan，activationEnabled=false，coverage/checkpoint/errors/verifiedAt=null。
不接受瀏覽器自行宣告「verified」，不能一鍵切換 encoder。部署批准清單不能被 plan 擴張；provider、
model、region、dimension/version 都先經 registry/approval 檢查，fingerprint 相同時 changed=false。
此版本未實作 verified → activated，也不把 CLI 的 status=ok 冒稱全域覆蓋完成。

運維可以用現有 CLI 在**獨立候選 config/key** 分批、可重入建立缺少 rows，舊空間持續保留：

```sh
node --import tsx server/graph/ingest-cli.ts "$DATA_ROOT" "$CANDIDATE_GRAPH_CONFIG" vectors
```

`CANDIDATE_GRAPH_CONFIG` 是經部署審核的運維檔案，不來自 browser；不要呼叫 destructive rebuild/delete。
每個 private/shared namespace 都需盤點 wiki、V2 edge、V3 narrative，核對 active revision、source/revoke
水位、coverage/count/error、checkpoint。只停 Cloud Tasks 並不能防止其他寫入路徑，所以缺少真正全域
write fencing 與切換 transaction 的完整證明時，**保持舊 selector，記錄 BLOCKED**。不得手改 active pointer
或 config 繞過 managed Embedding readonly gate。完整 activation／rollback coverage 演練尚未交付驗收。

Prompt rollback 仍用既有 `/rollback` expectedGeneration CAS，只切 pointer／加 audit，重新核對 reader/code
相容性。已 pin jobs/runs 不改，review/rejected job 不因 rollback 自動發布。程式 rollback 前停止新 admission，
保留能讀 Part 2 snapshots 的 consumers 直到 pinned 工作 drain，再逐服務回到已保存 revisions。
不 drop 012、不刪 prompt versions/evaluations/plans/releases/pins、不 destructive SQL rollback、不重寫 source、
evidence 或索引。未完成的 managed 工作不能交給只認 Part 1 的 image。

如需預先批准不同 encoder 的 **plan**，部署設定 `llmControl.embeddingCandidates` 可列出最多 16 個
`{provider, model, dimension, version}`；provider 的 project/location/secret reference 仍須存在原 `approved`
清單且不可由 UI 擴張。這個清單不改 `approved` 的 baseline graph_embedding，避免讓舊 release 因新增候選
而失去相容性。它只批准規劃，沒有授權 activate 或改變 IAM/quota。

## GitHub Actions → Cloud Build → Cloud Run 管線

`.github/workflows/llm-images.yml` 的 **LLM console CI/CD** 在 push `main` 時建置 images；
手動 **Run workflow** 可建置後部署。WIF 僅信任此 repository 的 `main` 及此 workflow，
不接受 PR／其他 branch。所有 runs 共用 concurrency group，避免 build／rollout 互相交錯。

部署座標（非 secrets，已寫入 workflow）：

| 項目 | 設定 |
|---|---|
| Project／number | `copilotkit-agui`／`746997613973` |
| Cloud Build／Cloud Run／Artifact Registry region | `asia-east1` |
| Artifact Registry repository | `hermes` |
| Source staging bucket／prefix | `copilotkit-agui-hermes-data/llm-source/` |
| Build SA | `746997613973-compute@developer.gserviceaccount.com` |
| GitHub CI SA | `github-hermes-cicd@copilotkit-agui.iam.gserviceaccount.com` |
| WIF provider | `projects/746997613973/locations/global/workloadIdentityPools/github-hermes/providers/github` |
| Services | `hermes-runtime`、`hermes-host`、`hermes-worker`（皆已存在） |

### 一次性 WIF／IAM 設定

由獲授權的專案管理員審閱後執行：

```sh
bash deploy/gcp/setup-github-cicd.sh
```

腳本建立專用 CI SA、WIF pool／provider，啟用必要 APIs，新增所需 IAM bindings。
Provider 同時限制 numeric repository ID `1456731156`、owner ID `108518895`、`main` ref、
精確 workflow_ref 與 `llm-build`／`llm-deploy` environment subject；不使用 SA JSON keys。
重跑時保留既有資源；同名 provider 的信任條件不同則拒絕覆寫，交由管理員審閱。

CI SA 權限：project 的 build editor、service usage consumer、Run viewer；
僅三個指定 services 的 Run developer；僅 build SA 與三個既有 workload SAs 的 actAs；
僅 `hermes` repository 的 Artifact Registry reader。Build SA 補該 repository writer、project logs writer。
這些是新增 bindings，不收回既有 SA 權限，也不更換 workload 身分或現有服務 IAM。

資料 bucket 的 uniform bucket-level access 須已開啟。CI SA 的 legacyBucketReader 只允許
bucket metadata／object 名稱 listing；objectCreator／objectViewer 以 IAM condition 限定
`llm-source/`。Build SA 的 source objectViewer 同樣限定該 prefix。
腳本不授 CI 刪除應用資料的權限；build SA 既有 project grants 的範圍不在此腳本中變更。

GitHub Environments 使用 `llm-build`、`llm-deploy`。建議設定僅允許 `main` 與 deployment reviewers；
即使 environment 未設 branch policy，GCP WIF 條件仍拒絕非 `main`。
所有座標已在 workflow，不需額外 GitHub Secrets／Variables。IAM 操作需要管理員明確授權，
腳本存在並不代表已在雲端執行。

### 建置與發布

GitHub runner 在 auth 之前以 `git archive HEAD` 建立已追蹤 source，避免上傳 Action 產生的
WIF credentials 或本機未追蹤 config。請勿 commit 真實設定／secrets。
`deploy/gcp/cloudbuild.llm-images.yaml` 先建置 Host，透過 `Dockerfile.llm-ci` 在該候選 Host
加入固定版本 Node 執行 unit suite（含真實 Python／TypeScript contract）、型別檢查與前端 build；
跨語言測試將 interpreter path 正規化為絕對路徑，避免 standalone Python 3.14 的 prefix warning；
不抑制 stderr，也不跳過真實 Python verifier。最後建置 Runtime，全部成功後才發布以下 artifacts：

- `hermes-host`：根目錄 `Dockerfile.agui`，含 `agui-cloud` dependencies 與 native import checks。
- `hermes-runtime`：`examples/copilotkit/Dockerfile`，Runtime／Worker 共用 image。

Tag 為 `<commit SHA>-<GitHub run ID>-<attempt>`；不寫 `latest`。使用 Cloud Logging 儲存 build logs。
Action 從 build JSON 只接受 `SUCCESS` 且兩個完整 SHA256 digests 都存在的結果，再將 immutable
`image@sha256:...` 傳至 deployment。Push 不是 registry 原子交易，部分 artifact 成功不算候選集合。

### 手動 dispatch 與部署 gate

先確認 migration 001–012、grants、所需 acceptance gates，以及 admission／delivery 已停止、jobs 已 drain
（或確認為無流量／無 jobs 的測試環境）。然後在 `main` 執行 **Run workflow**：

- `deploy=true`：建置後部署。必須同時勾選 `managed_rollout_confirmed=true`，否則提交 build 前就失敗。
- `deploy=false`：只建置並發布 images，不需勾選 rollout confirmation。

Push `main` 只建置，不沿用之前某次 rollout 的人工確認。需要自動 CD 時由上述 dispatch 明確啟動。
GitHub CI SA 不讀 DSN 或 Secret Manager 值；部署只更新 image 與 HTTP startup probe，保留現有
config secret mounts、SQL attachment、workload SA、env、commands／args、資源預算與 ingress／IAM。
三個服務不存在任一個時，preflight 直接失敗，不用不完整 config 自動重建服務。

`scripts/ci/deploy_llm_cloud_run.sh` 依序更新 Runtime → Host → Worker，使用 `--no-traffic`
與明確啟用的 deployment health check。每個新 revision 必須通過 `/health` startup probe，
且 latestCreatedRevision 必須等於 latestReadyRevision，才建立下一個 consumer。
三個 candidates 都通過後，才依序將三個 services 的流量切至本次明確 revision（不使用模糊的 `latest`）。
Worker 沿用原有 command／args，不會以 Runtime mode 啟動。

Cloud Run 跨服務切流不是原子交易。失敗時 workflow 停止，不自動重送、不自動 schema rollback；
維持 admission／delivery 暫停，核對各服務 revision／traffic，再按前述 SOP 復原相容 image。
即使三個 startup gates 都成功，仍須完成跨服務驗收，才由操作人員恢復 admission／delivery。
保留原 revisions、DB、pins、GCS generations 與 Tasks topology。

Unit suite 與 Docker imports 不能替代 disposable PG、Playwright、Python 行為測試或
Vertex／GCS／Tasks／Cloud Run staging acceptance；未執行的 gate 仍記 BLOCKED，不宣稱 production ready。

參考：[Google WIF Action](https://github.com/google-github-actions/auth)、
[Cloud Build 自訂 SA 與 logs](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts)、
[Cloud Run startup probes](https://docs.cloud.google.com/run/docs/configuring/healthchecks)。
