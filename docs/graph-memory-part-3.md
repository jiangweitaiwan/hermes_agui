# Graph Memory Part 3 完成報告

日期：2026-11-17。範圍僅 `GRAPH_MEMORY_PART_3.md`，沒有提前擴充其他階段。
已完成自動 session 學習、授權分享/撤銷、hybrid retrieval、管理 CLI、測試與回歸。
未 commit、push，沒有使用付費模型 API。根目錄 CI 檢查有既有缺檔阻礙，不能宣稱全專案 CI 全綠。

## 開始前確認 Part 2

- 已讀 `GRAPH_MEMORY_IMPLEMENTATION_PLAN.md`、`GRAPH_MEMORY_PART_3.md`、`graph-memory-part-2.md`，以及兩份 Runtime Memory 報告、根 AGENTS.md 與 tests/AGENTS.md。根 `IMPLEMENTATION_PLAN.md` 仍不存在，按目前 checkout 執行。
- 起始 branch `main`，commit `7122b8c1df6f9dc438b91269f6df7c303df72a0e`（`add:part2`），工作目錄乾淨。檢視歷史確認 provider write disabled 是分期設計，沒有把原有停用視為 bug 或重做 Part 2。
- Part 2 報告記載 Node 51 passed、原生 AG-UI 81 passed、TypeScript/build 通過；核對 queue/compiler、不可變 revision、v1/v2 bridge 均已存在。
- 修改前重跑 Node baseline：sandbox 中 13 項 localhost 測試因 `listen EPERM` 失敗；允許 loopback 後 **9 files / 51 passed**。沒有把環境失敗算成通過。
- 沿用 Node 22.18.0、現有 node:sqlite/FTS5、Zod、YAML、RxJS、Vitest、PM test interpreter，無新增依賴。保留原生 Hermes loop、MEMORY/skills、session SQLite、system prompt 與 tools surface。

## 完成內容

### 真實 Run completion 與 durable session ingestion

一般 Run 在 `runtime.ts` 的 `next.run(prepared)` 真實 Observable 上收集事件，完整流正常結束後才入列；
不監聽 connect/replay。Delegation 在 `consumeResult()` 驗證成功後呼叫同一 observer/service，沿用原本 timeout/cancel/HITL/result limits。
兩條路徑都從 server-owned Bot settings 取得 principal/project/bot，使用實際 thread/run/message ID。

只收集本輪最後一筆原始 user 文字與該 Run 的所有完整 assistant text messages。
Observer 建立於 `prepareRunInput` 之前，不抓取注入 memory、歷史、forwardedProps、reasoning 或 tool output；
第一版 tool allowlist 為空。限制 user 16 KiB、assistant 合計 64 KiB、最多 32 messages。
驗證 RUN_STARTED/RUN_FINISHED 身份、outcome、message start/content/end；錯誤、未結束訊息、取消、斷線、interrupt 不入列。
缺省 outcome 按既有 AG-UI 契約視為成功，有 outcome 時必須明確為 success。

完成後先同步 SQLite durable enqueue，不等待 LLM；authorization/SQLite ingestion 故障只記錄安全 error counter，不破壞成功 Run。
沿用 Part 2 的 source version/jobs/idempotency、lease/heartbeat/fencing、CAS publication、有限重試和崩潰恢復。
以 namespace + run identity 的固定 request key 防止同 Run 重複學習；不同 Run 的相同 user/answer 也去重。
Session completion 不允許透過 document update 改寫。
原始學習資料放 Runtime 的 wiki SQLite，不修改 Hermes 原生 history。

沿用 raw source/jobs 儲存，加上 `session_origins`、`session_evidence`、`session_knowledge`、
`source_owners`、`source_versions`、`page_owners`、`completion_times` 與 `embeddings` additive tables。
編譯時仍輸出真正 session provenance，沒有將 session 偽裝成 document，也沒有捏造 thread/run ID。

Policy 保守過濾閒聊、短輸出、缺乏可重用線索及常見明文 credentials；敏感模式命中時整筆跳過，
不是保存遮罩周邊原文。明確的 user confirmation 與 assistant-unverified finding 分別保存證據標記；
compiler 依原始角色證據標記 claim，LLM 不可自行授予 verified 狀態。
精確重複由程式處理，語意上的無價值/重複判斷沿用 compiler 的 analysis/merge/no-op。

### 分享、生命週期與撤銷

所有 session 預設 private。管理員只能明確分享原始 source，分享會重新檢查敏感模式，
再於 shared namespace 重新編譯，保留真實原始 provenance。
不複製已 merge 的 private wiki 頁，shared compiler 不讀 private context。

Bot deletion、project/principal 變更、部署端 policy 或 owner-access 撤銷，在管理生命週期回呼、
啟動、查詢前後與 worker tick 重新檢查；取消來源工作、撤下所有相關 mixed pages 與 FTS/edges/vectors。
Embedding 等待期間的權限變更也會在回傳前重新核對 active pointers。
`revoke` 會撤銷同 principal/project 的 session 分享副本，不能以 reindex/rebuild 復活。
停用 Bot 暫停 private worker，保留合法知識；刪除才永久撤銷。

管理模式拒絕同 project 中不同 owner 共用同一 principal 的歧義部署，維持既定 principal/project namespace 邊界，
未改變 bridge 信任模型或允許瀏覽器/LLM 建立 ACL。
歷史 Part 2 來源依 namespace metadata 與 committed provenance 回填 ownership；回填在 transaction 內。
新增版本記錄精確 author，保留不同 Bot 在同一授權 shared namespace 更新文件的行為。若歷史 source 歸屬有歧義，拒絕再編譯並要求管理員以新 source 重新匯入；不猜測作者。

### Embedding、hybrid retrieval 與一致性

獨立 OpenAI-compatible embedding adapter 支援部署端 model/dimension/version、最多 32 inputs/batch、
有限 retry、timeout、response byte limit，並檢查 response model、batch index、向量維度及 finite/nonzero values。
可注入獨立本地 Encoder；CI 全部使用 mock，不需要實際 API key。

SQLite vectors 綁定 namespace/page/ordinal/active revision/model/dimension/version。
背景非同步更新，發布或撤銷時同步使舊 vectors 失效；encoder 回來後再次檢查 revision。
查詢只掃描已授權 private/shared namespaces，各最多 4096 vectors，不能混用不同模型版本。
Embedding 查詢最多等 750ms；不可用、維度/版本不合或 timeout 時回退 keyword + graph。
模型更換可 scoped rebuild；整庫可以逐 namespace 執行 vectors 重建，reindex 也會使 vectors 失效並由 worker 續建。

Keyword/vector seeds 以 RRF 合併，預設 k=60、seed=8，再展開一階最多 3 鄰居、降低 hub 權重並排序。
這些值可配置，neighbors=0 可關閉 expansion。
無有效向量時保留原 lexical expansion 行為；有 semantic seeds 時可帶回不含 query 關鍵詞的已連結片段。
維持完整 provenance、片段去重、GraphHit 與 assembler 既有 byte/count budgets、HMAC bridge 及低信任 user-row 注入。
沒有修改 system prompt，也沒有宣稱原有 runtime-only 注入的跨輪 provider prefix cache 取捨已消失。

### 管理、健康與部署

沿用可信本地 OS 管理 CLI，沒有新增公開 HTTP endpoint、登入機制或管理 UI。
保留 Part 2 manual ingest/status/cancel/retry/delete/rebuild，新增：

- `jobs`：指定 namespace 最近 50 個 job/source IDs 與安全狀態，不回傳 lease token 或原文。
- `share` / `revoke`：明確分享原始 session source；撤銷時處理分享副本。
- `reindex` / `vectors`：scoped FTS/graph 修復與全部批次向量重建，模型失效回報 partial。
- `health`：broken links、孤立頁、conflicts、過期/無法追溯 provenance、index drift、pending/failed/lag；不自動刪除知識。

Runtime 會啟停背景 compiler/vector worker，退出時 abort 並等待 worker，再關閉 SQLite。
每分鐘只記錄 query latency/hits/errors、job states/lag、session skip/error、worker 狀態、compiler API token usage 與 embedding counters；
不記錄全文、scope 名稱或 credentials。編譯失敗不計為 compiled success。

完整安裝、雙 Bot smoke、設定範例、model selection、管理指令、additive migration、
整個 DATA_ROOT 備份/恢復與 rollback 已加入 `examples/copilotkit/README.md` Part 3。
`evolution.enabled=false` 停止自動學習，移除 embedding 回到 keyword，`graph.enabled=false` 關閉整個 graph。

## 測試與回歸結果

Node PATH 使用 `/private/tmp/node-v22.18.0-darwin-x64/bin`；Python 使用先前由 Hermes PM 建立的
`/private/tmp/hermes-graph-test-env/bin/python`，沒有使用 raw pip/uv 修改環境。
HTTP 測試在允許 loopback/subprocess 的環境執行；全部 mock providers，不連付費服務。

| 驗證 | 指令 | 結果 |
| --- | --- | --- |
| Part 2 baseline | example：`npm test -- --reporter=dot` | 9 files / 51 passed |
| Part 3 Node 完整回歸 | 同上 | **13 files / 87 passed / 0 failed**，27.44 秒 |
| TypeScript | example：`./node_modules/.bin/tsc --noEmit` | 通過 |
| Production build | example：`npm run build` | 通過；既有 Vite large chunk warning |
| Hermes 原生完整回歸 | 下列 scripts/run_tests.sh 指令 | **22 files / 82 passed / 0 failed**，250.7 秒；容器未啟用 |
| 新增真實自動學習 E2E | `scripts/run_tests.sh tests/hermes_agui/test_graph_evolution.py` | 1 passed；另包含於上述完整回歸 |
| 固定中英文 evaluation | example：`node --import tsx tests/fixtures/wiki-evaluate.ts` | 通過，原始 JSON 見下節 |
| Python Ruff / CC | `.venv/bin/ruff check tests/hermes_agui/test_graph_evolution.py`，另 `--select C901` | 通過 |
| TypeScript metrics | 現有 `scripts/code_health/ts_units.mjs` + example TypeScript | 新增/修改 units 符合 CC≤20、lines≤300、nesting≤6；原有未修改 handle CC=26 |
| 文件與 whitespace | `scripts/check_no_tmp_literals.py`、`git diff --check` | 通過 |

原生回歸可重現指令：

```bash
export PATH=/private/tmp/node-v22.18.0-darwin-x64/bin:$PATH
HERMES_HOME=/private/tmp/hermes-graph-part3-home \
HERMES_RUNTIME_DIR=/private/tmp/hermes-graph-part3-runtime \
HERMES_PYTHON=/private/tmp/hermes-graph-test-env/bin/python \
scripts/run_tests.sh tests/hermes_agui/
```

過程中完整 Node 回歸曾抓到 source update 重複插入 source_owners unique key，造成兩項 Part 2 測試失敗；
已改為冪等 ownership 插入，保留 document version/update 行為，後續完整回歸通過。
另一次 connect/replay 測試最初只傳 threadId，被 SDK 正確拒絕缺少 runId/messages；已修正 fixture 傳入完整 RunAgentInput，產品未修改。
沒有刪除測試或降低產品驗證來掩蓋失敗。

新增測試涵蓋 standard/delegation 實際 Runtime SSE → queue → compiler → A 新 thread；
B 分享前後、C 不同 owner/project、原始 messages 不變、replay/run 去重、取消/斷線/error/interrupt/resume skip、
多 assistant messages、reasoning/tool 排除、secret/chitchat 過濾、user confirmation 分類、重啟、
Bot deletion/project/ACL/policy 撤銷、private merge contamination、in-flight compiler/encoder 撤銷、
embedding 模型失效/版本/維度/非法向量/重試/永不回覆、跨 scope 隔離、多 batch rebuild、health/index repair、
可信 CLI subprocess ingest/work/jobs/status/share/revoke/reindex/health/rebuild。

原生新測試使用真實 Runtime、Hermes Host、native provider assembly 與 SQLite，只把模型換為 loopback fake。
確認成功 native Run 自動建立 pending job，編譯後另一個 native thread 得到學習內容；
system prompt 相同、record IDs/claim reference labels 不進 native SQLite。
原生 assistant 原本的回答仍按既有行為保存，沒有以「零污染」為由刪除正常 session 資料。

### Retrieval evaluation

固定 corpus：7 頁、12 個中英文 queries，gold relevance 存於 `tests/fixtures/wiki-evaluation.json`。
可重現 harness 使用 **deterministic synonym fixture encoder**，是 ranking/隔離/降級流程測量，
不是實際 embedding 模型的品質評估。環境為本 checkout Node 22.18.0、內建 SQLite、in-process encoder；
同時有其他回歸負載，沒有 network/API latency。測量的是 retriever，不包含 HTTP/Hermes 全程與 owner reconciliation sweep。

| 模式 | Recall@3 | MRR | 回傳片段噪音比例 | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Keyword，無 expansion | 0.5000 | 0.5000 | 0.1429 | 5.18 | 6.35 |
| Hybrid，無 expansion | 0.9167 | 0.9583 | 0.0769 | 9.17 | 39.26 |
| Hybrid + graph | 1.0000 | 0.9583 | 0.1250 | 6.25 | 15.57 |

Graph 提升兩項 paraphrase 的相關鄰居召回，也增加片段噪音；因此保留 neighbors=0 設定。
此 fixture 的 p95 均低於 2000ms；不宣稱 production、remote encoder 或大型 corpus 已達此 SLA。
同次測量 queue lag 28ms、mock compiler 101.91ms、3 次模型呼叫、input 1461 bytes/output 403 bytes。
未計算假 token 或假價格，`billedCost=null`；真實 adapter 記錄 API 回傳 token usage，價格由部署模型決定。
完整未四捨五入的輸出：`docs/graph-memory-part-3-evaluation.json`。

### 根目錄 CI 既有阻礙

`.venv/bin/python scripts/check` 已執行，17 項中 10 項通過。以下六個 CI 腳本仍缺失：

- `scripts/ci/check_os_marker_fakes.py`
- `scripts/ci/check_agents_md_size.py`
- `scripts/ci/check_line_endings.py`
- `scripts/ci/check_lazy_deps_imports.py`
- `scripts/ci/check_profile_archive_boundary.py`
- `scripts/ci/check_blob_size.py`

Health 起初找不到 Node；補上 Node PATH 重跑 `scripts/check --only health` 後，
仍因根 `package.json` 缺失而失敗，與 Part 2 相同。
另直接使用現有 TS metrics engine 驗證修改範圍；沒有新增無關根 package/CI 腳本來掩蓋阻礙。

## 變更檔案

以下短路徑位於 `examples/copilotkit/`：

- `server/graph/session-ingestor.ts`：policy、原始來源分享、RunCompletionObserver。
- `server/graph/evolution.ts`：部署配置、worker lifecycle、ownership migration/reconciliation。
- `server/graph/embedding.ts`：OpenAI-compatible adapter、versioned SQLite vector index、有限 cosine search。
- `server/graph/health.ts`：scoped lint/health/reindex。
- `server/graph/ingest-queue.ts`、`compiler.ts`、`wiki-store.ts`：session evidence/provenance、ownership、revocation、索引失效與安全 publication。
- `server/graph/provider.ts`、`retriever.ts`、`types.ts`：hybrid、回傳前重驗證、metrics/config。
- `server/graph/ingest-cli.ts`：管理 commands。
- `server/runtime.ts`、`delegation.ts`、`application.ts`、`index.ts`、`bots/manager.ts`：共用 ingestion wiring、啟停、生命週期回呼。
- `tests/wiki-evolution*.test.ts`、`wiki-hybrid.test.ts`、`wiki-ingest-cli.test.ts`：policy/Runtime/CLI/ACL/vector 契約。
- `tests/fixtures/wiki-session-probe.ts`、`wiki-evaluate.ts`、`wiki-evaluation.json`：真實 native probe、固定 evaluation。
- `README.md`：部署與操作。

根目錄：`tests/hermes_agui/test_graph_evolution.py`、本報告、evaluation JSON。
沒有修改 Hermes native production code、prompt/tool snapshot 或依賴 lockfile。

## 已知限制與操作邊界

1. **未提供 exactly-once completion delivery。** Runtime 在收到完成到 SQLite enqueue 前崩潰可能漏記；無可靠 completion journal/session reconciliation API。已入列後可恢復、去重並 fenced publish。
2. **Resume 明確跳過。** 不把缺失原始本輪資料的 final success 當完整學習；有 resumeSkipped 指標。其他 HITL 行為保留。
3. 敏感資料規則與知識品質判斷是保守 heuristic + compiler，不保證識別所有 secrets、PII、prompt injection 或語意錯誤。分享仍需管理員審查；沒有內容真偽裁判。
4. 單 SQLite writer、單 Runtime 的受信任私有 DATA_ROOT；沒有增加分散式服務或大型 vector database。固定候選/namespace/page/source budgets 沿用，超限 fail safe。
5. 真實付費 API canary、production 模型召回/延遲/費用未測；報告中 fixture 數值不能外推。Embedding 中斷可降級，長期失效仍需管理員處理。
6. 撤銷為停止檢索和撤下索引，不是實體抹除；raw sources 與 immutable revisions 留存稽核。混合來源頁整頁撤下，其他有效知識可能需 rebuild。
7. Owner/project/ACL 仍由既有 deployment/management authority 決定；沒有新增 project 變更或 ACL 編輯 UI。移除存取須更新可信部署設定/registry/policy，不能靠修改前端 forwardedProps。
8. 歷史 Part 2 source 沒有精確 enqueue 時間，新增 lag 指標只涵蓋有 completion_times 的工作；歷史 shared source 所有權若有歧義需人工重新匯入。
9. Rollback 必須停止所有 workers，使用升級前完整 DATA_ROOT 備份；不可只還原 SQLite 或只還原 Markdown。Graph off 仍保留 Hermes 原生功能。

## 最終驗證確認

- 最後 Node 完整回歸：13 files / 87 passed / 0 failed，包含實際 connect/replay 不觸發 observer、跨 Bot shared document 版本作者保留，以及 ingestion authorization 故障不破壞成功 Run。
- 最後 TypeScript `tsc --noEmit` 通過；production build 已通過。
- 原生完整回歸 22 files / 82 passed / 0 failed；最後 ownership/fail-soft 補強後，真實 native 自動學習 E2E 再次 1/1 通過（22.9 秒）。
- 最終 TS metrics 測量 23 個檔案，只有原有未修改 `DelegationCoordinator.handle` CC=26；新增與修改 units 均符合上限。Ruff、文件暫存路徑檢查與 whitespace 通過。
- 沒有 commit、push 或啟動後續階段。Part 3 完成後停止，等待下一步指示。
