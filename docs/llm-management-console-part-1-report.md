# LLM Management Console Part 1 交付報告

## 基準及階段一：現況核對

分支：`codex/graph-memory-v2`。實際開始 HEAD 為計畫指定的
`839d36297a01e9edb27551d64f798d3d5c9543b3`（LLM Unification Part 2）。開始工作樹只有兩份
未追蹤的 `LLM_MANAGEMENT_CONSOLE_PART_1.md`／`PART_2.md`；未回退使用者內容、未實作 Part 2。
最終實作 commit：`529375cb53d012fa9604144c8a6986f7d04c20d2`。其後的報告提交不改 source。逐檔 SHA-256 收錄在 [機器可讀驗收結果](../artifacts/llm-management-console-part-1/results.json)。

已核對 Unification validation plan、deployment、Part 2 operations/report、call inventory 與 `deploy/gcp/`。
Source migration head 是 Runtime **010**、Host **006**；沒有取得既有部署 DB 的測試連線，故未將 source
head 假稱為正式 DB 的 ledger head。測試只建立自己的 disposable PostgreSQL cluster／隨機 database。

| 既有接點 | 核對結果／本次保留的責任 |
|---|---|
| `llm/config.ts`, `deployment.ts`, provider clients | 七角色、model fingerprint、allowlist、ADC、retry/fallback；Part 2 task fingerprint 包含 code prompt/schema/validator。原先在啟動建 clients，不能單靠修改 JSON 達成動態發布。 |
| `index.ts`, `cloud.ts`, `bots/auth.ts` | Runtime `/api/copilotkit`、Bot/Graph APIs；Firebase uid 經 server member mapping 轉 identity，origin／cookie 或 Bearer 授權。新增 deployment admin allowlist，未將一般 member/owner 自動升權。 |
| `bots/manager.ts`, `storage/bot-registry.ts`, Host provisioner | Bot/template/owner/principal/profile credential seed 與 lifecycle；原 record model/provider 是既有配置資料，不能直接更換 Bot identity 做模型遷移。 |
| `core/service.py`, `session_manager.py` | 同 profile/principal/external thread 對應穩定 native ID；session lock 包住整個 native turn，Agent 實例留存，native DB 擁有歷史。原 cache 不含 release，須在新 run 邊界處理。 |
| `storage/host_runs.py`, `isolated_service.py` | durable run lease/fence、hydrate/stage profile、獨立 native child process、completion outbox；本次只傳入已驗證 registry，不改 Host run schema／lease／profile publication。 |
| `postgres-ingest-queue.ts`, `compiler.ts`, `evolution.ts` | source/version/job 唯一性、idempotency、pending/running/completed/failed/cancelled、最多三次 attempt、30 秒 lease／5 秒 heartbeat、120 秒 compiler deadline、source revoke/review 與原子 publication。 |
| Tasks／Worker／Completion／Reconcile | 原 job/delivery ledger、OIDC、reconcile entrypoints 和 shutdown fencing 保留；新 pools 加入 one-shot close，不新增 Task routing payload 或 queue state。 |
| DB roles／Docker | Host／Runtime owner 邊界分離；image/entrypoints 不自動 migration/bootstrap。以獨立 SELECT-only Host reader 連 Runtime 控制面，未擴張 Host owner。 |

## 階段二：實作及架構差異

新增 Runtime **011_llm_control.sql**。原計畫 providers/models 兩表合併為單一原子 JSONB draft + revision，
避免 torn reads。六張新表：`llm_drafts`、`llm_releases`、`llm_active_release`、`llm_admin_events`、
`llm_run_pins`、`llm_bot_roles`；Graph jobs additive nullable scope/release FK。Prompt versions table 留給
Part 2，沒有 Prompt 編輯 API。發布 payload／audit／run pin／Bot role binding append-only，job pin 不可更新。
active pointer 的 scope+validated FK、transaction/advisory lock、expected generation/revision/hash CAS
防止併發發布覆蓋，rollback 只切 pointer／加 audit。

Snapshot 包含完整 registry、原 model fingerprint、獨立 release hash、code task manifest／fingerprint，
含 baseline prompt 內容與 output schema。跨語言 golden fixture 同時由 TS/Python 驗證；未重定義向量 key。
每個新 run 讀 active、持久化 run pin；Graph source/job 同一可信 transaction 存 pin。Worker 重送／重啟／
retry 以 ledger pin 解析 snapshot。既有 static CLI 也拒絕處理／發布 pinned job，避免 sibling entrypoint
繞過 pin。publication 再比對 immutable release hash，保留原 ACL、evidence、lease 和 review gates。
DB 另有 transaction-local compatible-reader／verified-release marker gate；舊 image 的 claim／complete SQL
不能直接執行 pinned jobs，已在真實 PG 反例驗證。

Runtime run preparation 內的 retrieval/query/story 與 Host primary 共用 release；Runtime 只簽署 reference，
Host 自行以獨立 reader、binding、persisted run pin、snapshot hash／contract 驗證。不信任 browser model/provider
或 forwarded pin。Python cache key 納入 release/model hash，在 session turn lock 的新 run 邊界建立 client，
保留 native session/history/tools/skills/memory。執行中的 tool loop 不換模型。Host resolver 有 admission budget，
HTTP cancellation 不會提前釋出仍在執行 DB query 的額度。
Graph-only release 不重建 native Agent，只更新 release/cache metadata；primary route 改變才於新 run 邊界
建立 client，避免不必要地重載 cached prompt/tools/skills。

Node managed transport 加 connection-time DNS/IP guard、TLS、redirect denial；native custom provider 重用既有
SSRF-safe HTTP client seam，仍執行原 Hermes loop／Provider Adapter。任何 provider/model/secret reference
只能選部署批准清單；Embedding 全部參數與其 provider 唯讀，native fallback 保持空陣列。
DB/resolve/missing/incompatible snapshot fail closed，沒有 cached active／static silent fallback。

檔案索引：

| 範圍 | 主要檔案 |
|---|---|
| Contract／hash／policy | `server/llm/control-contract.ts`, `database-target.ts`, `tests/fixtures/llm-control-golden.json` |
| DB／CAS／audit／CLI | `control-store.ts`, `control-cli.ts`, Runtime migration 011 |
| API／啟動／HTTP | `control-api.ts`, `control-bootstrap.ts`, `control-http.ts`, `bootstrap.ts`, `index.ts` |
| Run／Graph pin | `run-pinning.ts`, `execution-release.ts`, `runtime.ts`, `application.ts`, `client.ts`, `observability.ts`, Graph queue/compiler/worker/ingest entrypoints |
| Host native | `core/managed_llm.py`, `core/service.py`, `core/factory.py`, `host.py`, `server.py`, `adapter.py`, `session_manager.py`, `provisioner.py`, `storage/isolated_service.py` |
| UI | `frontend/LLMManagement.tsx`, `workspace/AppShell.tsx`；Tasks／Providers／Releases、唯讀 contracts、diff、conflict reload、確認與 audit |
| GCP | `llm-control-grants.sql`, `llm-control.env.example`, `runtime.managed.example.json`, `host.managed.example.yaml`；Vercel 沿用現有 public variables |
| Tests | `tests/llm-control.test.ts`, `tests/acceptance/llm-control.pg.ts`, `tests/browser/llm-control.spec.ts`, `tests/hermes_agui/test_managed_llm.py` |

API prefix `/api/admin/llm/`，完整 payload、status codes、啟用及回滾見
[維運 SOP](llm-management-console-operations.md)。所有 endpoints 均在後端檢查 deployment-admin；前端入口不作授權。
沒有新的 core model tool、LLM proxy、任意 endpoint/key 編輯、per-Bot 自訂 route 或 IAM 自動化。

## 階段三：驗收與失敗紀錄

最終數字以 results.json／各原始 log 為準。完整 baseline 在未修改 HEAD 的 archive 副本重現，
Node 22.16.0、2 workers、15 秒一般 test timeout；沒有為通過而提高 timeout 或移除既有檢查。
本地 inference 是 scripted wire/native fixtures，PG 為真實 PostgreSQL，browser 為真實 Chrome。
它們不是 Vertex／GCS／Cloud Run 的替代證明。

| 最終檢查 | 結果 |
|---|---|
| 完整 Node regression | **206 PASS、29 既有 SKIP**；31 files passed／10 skipped；2 workers、15 秒一般 timeout。 |
| Registry/control contracts | 先前 focused **19 PASS**；最後新增 embedding log contract 一併納入完整 regression。 |
| Native／registry／headless／Vertex Python | **25 PASS、0 FAIL**，最終關閉 file retries，一次通過。 |
| HTTP／dynamic provisioning 補充 | **11 PASS、2 既有 durable Host fixture SKIP**（不重複計 native tests）；兩個外部 fixture gate 明列 BLOCKED，不當作 cloud 通過。 |
| 真實 disposable PostgreSQL | **7 PASS、0 SKIP**；含 fresh/rerun 011、實際 grants、Python reader、兩 process CAS、in-flight pin、pre-011 static、pagination tie。 |
| 真實 Chrome → API → PG | **2 PASS**，含發布後 Graph compile；inference 為 scripted corpus、objects 為 filesystem。 |
| TypeScript／前端 production build | **PASS**；Vite 既有大型 chunk warning 保留，沒有提高 warning limit。 |
| Repository check | **16 checks PASS；no-tmp FAIL**，只有六個基線 hits；最新 health **0 blocking / 0 advisory**。 |
| 真實 Vertex／GCS／Cloud Run | **BLOCKED**，未部署、未執行；不可用以上本地數字代替。 |

| 驗收 | 本地證據 |
|---|---|
| P1-01 | 原 static Node/native regression；真實 pre-011 PG schema 完整 compile，沒有控制面 tables 仍 completed。 |
| P1-02 | bootstrap dry-run/apply/重跑；immutable/secret-free snapshot、TS/Python golden hash、invalid config、embedding change 拒絕。 |
| P1-03 | 真實 admin API／browser owner 403；scope/CSRF/typed input/pin forgery；真實 Host reader + signed binding；private IP/DNS 與 native connect-time guard；probe concurrency budget。 |
| P1-04 | Chrome → real API → PG draft/validate/publish → 新 job 經原 compiler/provider adapter 使用 Parser Pro 並 completed，服務不重啟。provider 切換另由 allowlist/compatible-adapter contract 驗證。 |
| P1-05 | 原 native loop 於 tool callback 暫停，後續 call 保持舊 model；同 native thread 下一個 run 換新 model、rollback 後恢復，歷史/tools 保留；Runtime preparation／Host signature/DB reference 串接驗證。 |
| P1-06 | 真實 PG 在 parser/relations 之間 publish，舊 job 全 stage 保持 Flash、新 job 使用 Pro；原 pin 經 idempotency、retry／新 queue instance 留存。 |
| P1-07 | 兩個獨立 Node processes、獨立 DB pools 競爭 CAS，一成功一 409；active 一致；並行 execution context 不污染。 |
| P1-08 | missing/incompatible snapshot、DB connection failure、未 pin 舊 job、不同 DB destination 拒絕；無 inference／無部分 Graph publication；source 保留。 |
| P1-09 | real pointer rollback、歷史 run/job pin 留存；原 ACL/revoke/review／embedding regression 未改；Embedding candidate 不可切換。 |
| P1-10 | 真實 Chrome/API/PG publish/rollback/conflict/403；append-only audit、release/model/task 日誌；同 timestamp 分頁不漏資料。 |
| P1-11 | 真實 disposable PG migration/grants/replicas **PASS**；真實 Vertex ADC／GCS／Cloud Run staging **BLOCKED**。 |

命令（Node 命令在 `examples/copilotkit`；Python/check 在 repo root）：

```sh
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
./node_modules/.bin/tsc --noEmit
npm run build
npm test -- --config vitest.llm-control.config.ts --reporter=verbose
./node_modules/.bin/playwright test --config playwright.llm-control.config.ts
scripts/run_tests.sh tests/hermes_agui/test_llm_registry.py tests/hermes_agui/test_headless_agent.py tests/hermes_agui/test_managed_llm.py tests/agent/test_vertex_adapter.py
scripts/run_tests.sh tests/hermes_agui/test_managed_llm.py tests/hermes_agui/test_server.py tests/hermes_agui/test_dynamic_host.py
.venv/bin/python scripts/check --base 839d36297a01e9edb27551d64f798d3d5c9543b3
```

環境失敗及修正保留在 artifacts：sandbox loopback EPERM、baseline archive 缺少硬編碼 `.venv` 路徑，
已在原 HEAD archive 補連結並重跑到 **196 passed / 29 existing skipped**。早期 browser fixture 的 Vite root
與 select locator 錯誤已修正，沒有放寬 timeout。新 native test 最初誤要求換模型後 system prompt
字節相同；native 原有 runtime identity 更新是刻意行為，改驗新 run 正確 identity、相同 thread/history/tools，
另證明 in-flight tool call model 不變。PM cloud test environment 的 standalone Python 下載遇到 TLS CA
錯誤，沒有停用 TLS；真實 PG Host reader 改使用既有、與 uv.lock 一致的 staged psycopg 3.3.9。
HTTP 測試改用既有 AG-UI test environment，native-only `.venv` 不含 `ag_ui` 的 collection failure 不算產品通過。
初次併行 native suite 有一個 test file 自動重試才通過：`read_file` 首用的真實 shell environment 建立花了
18 秒，超過該新 routing test 的 15 秒 future bound。已保留 flaky 原始 log；改用原生 `todo_list` 真工具
隔離 routing 契約，保留 read_file 的既有 headless regression，**沒有提高 timeout**。其後 standalone 六項
與完整四檔 25 項均以 `HERMES_TEST_FILE_RETRIES=0` 一次通過。

既有 Node 29 skips 及 HTTP suite 兩項既有 durable Host PG fixture skips **不算雲端 PASS**；後者缺少其專用
Host pool/socket fixture，列為 BLOCKED。這次新增的獨立 real-PG gate 缺資源會直接失敗並標示 BLOCKED，
不新增 skip。新 code health violations 已拆分修正；repository `no-tmp` 六個基線 hits 分開記錄，未放寬規則。

## 階段四：部署交付、限制及 Part 2 接口

GCP 只交付 additive migration／grants／Secret references／ADC／pool budget／Vercel 設定／rollout 與兩種
rollback SOP。未部署 production、未改真實 IAM、未使用 production credentials、未清除既有資料。
目前沒有提供 disposable Vertex smoke config、GCS bucket 或 Cloud Run staging rollout 資源：
**實際 cloud gate BLOCKED，禁止宣稱 production ready**。

部署先相容 static readers，再明確 bootstrap／Bot opt-in／drain 未 pin jobs，最後協調 consumer 切 managed。
新 Bot 同樣需 opt-in；舊 Bot record model/provider 保留作遷移前 metadata，實際 managed route 以 release 為準。
沒有自動改 Bot identity 或憑證。managed delegation 是既有獨立 child run，在 child boundary 自行 pin active；
parent 保持原 pin。durable checkpoint resume 原本不支援，managed 明確拒絕，不假稱能恢復已中斷的 native loop。
native auxiliary/compression/MOA 等額外模型仍由 native config 管理；不是全呼叫面的動態統一。

Embedding selector／vectors 保持 baseline，沒有 embedding migration 或歷史 repin API。
Node managed transport 目前要求 public IPv4，IPv6-only endpoint fail closed。
管理 rate/probe limits 是每 replica，總量須配合既有 ingress/max-instances budget。
真實 ADC refresh/quota、跨 Cloud Run revisions、Tasks redelivery、GCS/PITR restore／完整服務 rollback 尚待 staging。

Part 2 應以本次實作 commit 為基準，沿用 release/pointer/CAS/audit/pin 和相容性契約；目前 prompt/schema/
validator 只可讀 code baseline。未建立 Prompt editor、prompt editing API、embedding selector 切換或任意 endpoint
管理，也沒有重做 Provider Adapter／native loop／Graph compiler／ACL／Evidence Validation。
