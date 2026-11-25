# LLM Management Console Part 3 實作與驗收報告

## 範圍、基準與交付狀態

- Branch：`codex/graph-memory-v2`。
- 開始及交付 HEAD：`a149486198a48cc8f32d63a28908fd09a23e129a`；本次交付是該 commit 上的 working-tree 修改，未自行建立 commit。規格檔 `LLM_MANAGEMENT_CONSOLE_PART_3.md` 原先已是 untracked，保留原內容。
- 不執行 GCP 部署、不使用 production DB／憑證、不改 IAM，不刪除產品歷史資料。
- Machine-readable 結果：[results](llm-management-console-part-3-results.json)。P3-01–P3-13 本機驗收 PASS；repository check 保留既有 no-tmp FAIL，雲端 gate BLOCKED，不宣稱 production ready。

交付 source/config/tests/operations 的 SHA-256 digest：`d3514a4eb160d66bd49b2bf98675cd1d75462f2e71b81e385dcac74a0897fec3`。
逐檔 hash、每次檢查摘要及 log hash 見 machine results；digest 不包含本報告、results 或未修改的使用者規格。

## 四個核心問題

1. **是否仍須手動 bootstrap？不需要。** managed Runtime 的啟動路徑呼叫 `ensureInitialRelease()`。CLI bootstrap 僅為離線診斷／受控空庫初始化的相容入口，不是正常部署步驟。
2. **是否仍須 Bot opt-in？不需要。** 已刪除 `optInBot()` 寫入實作及 `pinRun()` 的 role-row gate；舊 CLI opt-in 僅輸出 deprecated，沒有 DB 操作。
3. **合格既有與新 native Bot 是否自動使用 active release？是。** Caller/thread 仍走原 Runtime 身分／owner／thread mapping；pin transaction 再核對 registry principal、harness、active 狀態與 tombstone，原生 inference 由已簽署且持久化的 release pin 取 `agent_primary`。舊 Bot model/provider 不參與新 route 判斷。Template 的 `llmManaged` 只是從 deployment mode 派生的顯示 metadata，不能由 BotInput 修改，也不控制授權或路由。
4. **是否還有 execution path 依賴舊表作為 opt-in gate？沒有。** `llm_bot_roles` 僅在初始化檢查歷史完整性／schema grants、原 migration／grants 和升級測試 fixture 中保留。正常 pin、Host resolver、native cache、Graph job claim/retry/reconcile 都不查該表決定是否可推論。

## 架構與安全契約

`mode: managed` 是唯一部署層級啟用開關。沒有新增 per-Bot 開關、初始化按鈕、背景服務、核心 model tool、非秘密環境變數或 Provider Adapter。

Runtime 是唯一初始化 writer：專用 admin DSN 與 inference reader 必須同 DB destination，且 Runtime registry/thread/control plane 必須同 ledger。Worker 共用 composition 時明確傳入 `controlReaderOnly: true`，即使誤掛 admin DSN 也不開啟 admin pool。Host 保持 read-only resolver。Static 不增加必要 DB 依賴；沒有明確 control DSN 時不開 pools，已有 DSN 的 optional static Console 維持原功能，且不自動初始化。

初始化與 CLI apply 共用既有 `pg_advisory_xact_lock(92017011)` 及單一 transaction：

- 完全空的控制面：可信 baseline 經原 candidate validator、approved policy、embedding selector、schema/grants 檢查後，建立 release-001、draft revision 1、active generation 1、一筆 bootstrap audit。
- actor 固定 `system:managed-runtime`，不是偽造登入管理員；audit 不存 DSN、secret 或 source/prompt 原文。
- 有 active：驗證 snapshot/hash/model/task/code/policy、draft 存在與所需 grants，不更新任何 release、draft、pointer 或 audit。未發布 draft 合法，不與 active／baseline 比對相等。
- 缺 active 卻有任一 control 歷史（含舊 role rows、prompt versions/evaluations、embedding plans 或 pinned jobs）：拒絕，不修復、不重新初始化、不 fallback static。
- 插入、audit 或驗證失敗整筆 rollback，可以安全重試；schema/grants/DB 故障拒絕 readiness。

新 pin 使用既有 Bot lifecycle 的 `(53859273,1)` advisory lock，在交易內重讀 registry，與 disable/delete/provisioning transition 序列化。取得鎖前的舊 process cache 不能繞過已停用／刪除狀態。維持原 API principal/owner ACL、thread scope、delegation allowlist、Host 獨立 admission／lease、60 秒簽署 reference 與 persisted pin binding；既有 run 重送保留原 pin，不擴張授權期間。

Remote AG-UI Bot 僅 pin Runtime Graph context，不簽署 Hermes primary reference、不改 remote endpoint/model。Native checkpoint resume 維持原拒絕契約，remote 不額外套用 native checkpoint 限制。Native auxiliary/compression/MOA 仍 unmanaged。

保留 Part 1/2 的 provider allowlist／SSRF／Secret Manager／ADC 邊界、deployment-admin、CAS、audit、protected prompt、schema readonly、Playground bounds、embedding migration gate、Graph publication ACL/review/revoke/lease fences、immutable run/job pins 與跨語言 hash。沒有 DDL migration、沒有 drop／UPDATE immutable history。必要 grants 只新增 inference identity 對 registry 的 id/principal/record SELECT，及 initializer 對 graph_jobs.llm_release_id 的 SELECT；沒有將 admin 寫權授予 Worker/Host/Bot。

## Readiness、升級與回滾

採 Runtime-first 部署順序；Host/Worker 沒有應用層 retry（0 次），沒有 active 就立即 readiness 失敗。現有 orchestration 在 Runtime 完成後再啟動／重啟 consumer。Control DB connection timeout 2 秒、statement/query timeout 5 秒，沒有無限等待或 static inference fallback。

全新部署先套用 001–012 與 grants，提供可信 baseline／approved／admin principals／既有 secrets，設定 managed，Runtime 就緒後才啟動其他相容 consumers、恢復 traffic/delivery。前端直接使用 LLM Management 及 Bot Manager；日常 model/provider/prompt publish 不必 redeploy。

既有 static → managed 仍需一次性停止新 admission/delivery、drain pending/running unpinned jobs；不能補 pin 為最新 release。已 managed 的部署保留 active hash/generation、draft revision、legacy role rows、audit 與 pins，不重新匯入。混合舊 opt-in-gated images 不視為相容，須 maintenance rollout 後才接新工作。

設定 rollback 仍只 CAS active pointer 並加 audit，不回退 draft。程式 rollback 停止 admission/delivery，保留相容 reader drain 舊 pins，再回已保存 static revision；不補造 opt-in、不 drop 表、不清 pin、不重寫來源或向量。

最短部署 SOP 與完整權限／故障步驟：[operations](llm-management-console-operations.md)。

## 檔案與 callsite 索引

| 責任 | 檔案／callsite |
|---|---|
| 自動初始化／state machine／grants／registry pin fence | `examples/copilotkit/server/llm/control-store.ts`: bootstrap, ensureInitialRelease, verifyInitializer, ready, pinRun |
| Runtime 初始化、reader-only composition、destination binding | `server/llm/control-bootstrap.ts`: parseControl/openControl；`server/bootstrap.ts`；`server/graph/worker-cli.ts` |
| Native／remote 分流、原 ACL/thread/delegation boundary | `server/application.ts`: managedRun；`server/llm/run-pinning.ts`: managedRunPreparation |
| Host readiness 診斷；原獨立 resolver/persisted pin 不變 | `hermes_agui/core/managed_llm.py`: ready_host/resolve_run |
| CLI 相容入口 | `server/llm/control-cli.ts`（opt-in deprecated/no DB） |
| Bot Manager 正確顯示 inherited route | `server/llm/deployment.ts`, `server/bots/types.ts`, `server/bots/api.ts`, `frontend/BotEditor.tsx`, `frontend/BotManagement.tsx` |
| 去除前端手動匯入指示 | `frontend/LLMManagement.tsx` |
| 最小 grants、明確 managed 範例、維運 | `deploy/gcp/llm-control-grants.sql`, `llm-control.env.example`, `runtime.managed.example.json`, `README.md`；operations/unification deployment docs |
| 真實 PG／多程序／歷史／授權／fault tests | `tests/acceptance/llm-control.pg.ts`；`tests/llm-managed-startup.test.ts`（無 registry／DB 的 static startup） |
| 真實 browser → API → PG → native Host → local scripted vendor | `tests/browser/llm-control.spec.ts`, `tests/fixtures/llm-control-browser*`, `llm-managed-host.py` |

表內 `server/`、`frontend/`、`tests/` 相對於 `examples/copilotkit/`。舊 migrations 011/012 完全保留。

## 驗收證據與實際命令

測試只使用本機新建 disposable PostgreSQL 17.12 的隨機 database、真實 Chrome、真實 Node Runtime API 與 Python native Hermes Host。供應商回應為本機 scripted HTTP wire；測試 Host 以 fixture 取代 ADC 與外部 HTTP transport，不把它當 Vertex/SSRF 的整合驗收。SSRF 邊界由既有獨立安全回歸驗證。Graph objects 使用 filesystem，不能當 GCS gate。

Node 使用既有 Node 22.16.0。Python 使用既有 PM test environment（含 declared ag-ui extra），PG reader 使用已存在、與 lockfile 相同的 staged psycopg 3.3.9；沒有 raw pip/uv 或修改 dependency lock。

```sh
# examples/copilotkit
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
npm test -- --config vitest.llm-control.config.ts --reporter=verbose
./node_modules/.bin/playwright test --config playwright.llm-control.config.ts
npm run build
# repository root
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh tests/hermes_agui/ tests/agent/test_vertex_adapter.py
.venv/bin/python scripts/check --base a149486198a48cc8f32d63a28908fd09a23e129a
git diff --check
```

`AGUI_LLM_TEST_ADMIN_URL` 指向本機新建的測試 cluster，`AGUI_LLM_TEST_HOST_PYTHON` 指向具備所需 extra 的既有 PM test interpreter。Chrome executable 由原 Playwright 設定選取。本次沒有提高 testTimeout、hookTimeout 或 browser readiness timeout。

| ID | 本機驗收 | 證據 |
|---|---|---|
| P3-01 | PASS | migrated fresh DB，兩個 Runtime `openControl()` 啟動程序直接初始化；Browser 直接登入 Console |
| P3-02 | PASS | 兩個獨立 Node startup processes 同指向 release-001，僅一筆 system bootstrap audit；audit fault 全交易 rollback 後成功重試 |
| P3-03 | PASS | publish 後保存未發布 native slot，restart ensure 回 applied=false，active/generation/draft/history 完全相等 |
| P3-04 | PASS | 舊 llm_bot_roles 與 bot_opt_in audit 升級 fixture 保留；沒有重新初始化／變更 pointer |
| P3-05 | PASS | Browser 的既有 native Bot 在自動初始化前已存在，legacy model/provider 不在新 route 中；真正 native HTTP inference 使用 primary |
| P3-06 | PASS | 真實 Bot Manager 建立新 Bot、對話及同 thread 第二回合，role table count=0；未呼叫 CLI |
| P3-07 | PASS | registry principal／missing Bot／deleted／disabled lock race 拒絕；原 owner ACL／delegation 與 Host foreign-thread signature binding 回歸 |
| P3-08 | PASS | remote preparation 有 Graph release context，無 native reference；pre-011 static PG 與無 registry/DSN static startup 正常 |
| P3-09 | PASS | Browser 發布 model/native slot 新回合生效；PG in-flight Graph publish、retry/restart、old-run resend 保留原 pin |
| P3-10 | PASS | missing active+history、invalid baseline、incompatible active、schema 缺失、撤銷 INSERT grant、DB down 拒絕；不修復或 fallback |
| P3-11 | PASS | 真實 executor role 可 pin 但不能初始化；Host INSERT 拒絕；Worker 即使有 admin env 不開 admin pool；active 缺失 reader 失敗；舊 unpinned job gate 保留 |
| P3-12 | PASS | 真實 Chrome + API + disposable PG + Python native Host，4 browser cases 全數通過；vendor wire scripted，無 GCP 聲明 |
| P3-13 | PASS | Node 210 PASS/29 既有 SKIP，focused 15 PASS；Python 全域 relevant regression 原 107 PASS/3 timeout/10 SKIP，兩個失敗檔案以 -j1 重跑 10 PASS，三項逾時均通過；PG 14、browser 4 PASS |

Native browser scenario 明確先等待 create API 回傳的 Bot ID，再鎖定該 Bot 的 chat；每回合等待實際 SSE response
結束後斷言 UI，不使用固定 sleep 或放大 timeout。初期 fixture 的 portal target／空工具集合被 fake wire 當成 aux／
舊 Bot render transition／Task label locator 已修正，最終 4 cases 在原 timing budgets 全數 PASS。

Baseline red proof 使用相同有效 native registry row（沒有 opt-in）及真實 disposable PG：在
`a149486` archive 上回 `503 Bot requires explicit role migration`（預期 red，非 import/collection failure）；
相同 probe 在最終 source 回 release-001（green）。Source 已定位並移除原 gate，沒有以新增 UI 操作代替。

Repository check：17 checks，僅 **既有 no-tmp 六處 FAIL**，其餘通過；final health 重跑為 0 blocking／0 advisory。
六處是未修改的 `host-config.yaml` 兩行，以及 `artifacts/graph-memory-v2-part-1/verification/` 中兩份既有
baseline/check 記錄各兩行，與 Part 2 報告相同。未藉本次功能變更修改既有主機 scratch 配置或改寫歷史驗收檔。
Production frontend build PASS（原有 large-chunk warning 保留）；未調高 warning threshold。

Python 最初完整 relevant regression 使用 4 workers，與 repository checks 的多個全樹掃描及 build 同時執行，
其中 3 項 local HTTP/subprocess 測試逾時，沒有改產品邏輯或提高 timeout；待其餘掃描結束後，使用原 runner
`-j 1` 重跑 `test_runtime_entrypoint.py`、`test_runtime_memory.py`，10 PASS/0 FAIL（94.9 秒）。完整第一次
FAIL 與重跑 PASS 均保存在 machine results，不把重跑當作第一次全綠；涵蓋 110 個不同 Python 測試 PASS，
10 項既有 SKIP 不當成通過。Browser 曾有環境缺 ag-ui、同時多個檢查導致 readiness timeout，均以已有的
PM interpreter／原 timing budgets 重跑；未下載新套件或停用任何正式安全機制。

補充命令：

```sh
# examples/copilotkit：最後 source 的 focused regression
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000 tests/llm-managed-startup.test.ts tests/llm-control.test.ts tests/llm-prompts.test.ts
# root：只重跑失敗檔案，沒有放大 timeout
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh -j 1 tests/hermes_agui/test_runtime_entrypoint.py tests/hermes_agui/test_runtime_memory.py
.venv/bin/python scripts/check --only health --base a149486198a48cc8f32d63a28908fd09a23e129a
.venv/bin/ruff check examples/copilotkit/tests/fixtures/llm-managed-host.py hermes_agui/core/managed_llm.py
```

本次專用 PostgreSQL cluster 已停止；未留下測試 DB 連到 production，Native Host／Chrome fixture 均已結束。
Baseline archive 與 probe 只存在暫存測試目錄，沒有改動 checkout／分支或其他使用者變更。

## 保留限制與部署風險

真實 Vertex ADC／quota／供應商語義品質、GCS／Cloud Tasks／Cloud Run staging gates **BLOCKED**（未提供／未授權使用測試雲端資源），不宣稱 production ready。Part 2 原本未交付的全域 embedding coverage/watermark/activation 仍保持 BLOCKED；本次只保留其安全 gate，沒有以自動初始化繞過。
