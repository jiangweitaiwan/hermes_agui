# Graph Memory Part 2 進度報告

日期：2026-11-17。範圍：`GRAPH_MEMORY_PART_2.md`，不包含 Part 3。
Part 2 實作、相關測試與回歸已完成；根目錄檢查的既有阻礙另列，不能宣稱全專案 CI 全綠。
未 commit、push，未使用真實付費 API。

## 開始前核對 Part 1

- 已讀 `docs/GRAPH_MEMORY_IMPLEMENTATION_PLAN.md`、`docs/GRAPH_MEMORY_PART_2.md`、`docs/graph-memory-part-1.md`、根 AGENTS.md、`tests/AGENTS.md`，以及目前存在的兩份 Runtime Memory 報告：`docs/runtime-memory-part-1.md`、`docs/runtime-memory-bot-manager-part-2.md`。
- `IMPLEMENTATION_PLAN.md` 不存在。與 Part 1 報告不同，兩份 Runtime Memory 報告目前可讀；以目前 checkout 為準，沒有重做前階段。
- 起始 branch `main`，commit `af268de145d10dcfab38e9801a65f9ecf73cbf20`（`add:graph memory part1`），起始 `git status --short` 為空。檢查歷史確認 Part 1 的單 session source／write disabled 是預留分期的設計。
- Part 1 報告記載 Node 30/30、原生 AG-UI 78/78、TypeScript/build 通過；本次修改前重跑 `npm test -- --reporter=dot`，**7 files / 30 tests 全通過**。初次 sandbox 有 11 個 localhost listen EPERM；在允許 loopback 的執行環境重跑後全綠，沒有將環境失敗算通過。
- 沿用 Node 22.18.0、現有 `node:sqlite`／FTS5、Zod、YAML、Vitest、原生 PM test environment，無新增依賴。Hermes system prompt、工具列表、原生 memory/skills/agent loop/session SQLite 路徑均未修改。

## 實作與發布契約

### 1. 文件來源、管理入口與 bridge

`DocumentIngestor` 接收 server-resolved namespace 與獨立 upload JSON；上傳者不能提交 ACL、server path 或任意來源種類。
入口是可信本地管理 CLI，沿用 Part 1 的 OS 管理員邊界，未新增公開 HTTP endpoint 或新登入機制。
部署管理設定決定 principal/project/visibility/bot，與 upload 檔分離；shared 必須管理員明確指定。
只接受 Markdown/text（`text/markdown`、`text/plain`），內容最多 1 MiB UTF-8，禁止 NUL；標題最多 512 bytes。
安全路徑檢查拒絕 symlinks，upload `sourceId` 僅 UUID，不可控制落地路徑。

Source ID、SHA-256、整數版本、request idempotency key 分離。原始來源版本保存在 SQLite，不覆寫內容；撤銷另標 deleted。
同 namespace 的相同內容／標題重送回原 job；重用 key 但改內容會拒絕；更新 source 需其 scoped ID 與新 key。
未捏造文件 thread/run ID。

GraphHit 增設完整 `sources`，保留原單 session source 形狀。單 session context 仍使用 v1；文件／多來源改為 v2，攜帶 document ID、版本、hash、title 及每個原始 session/document reference。
Hermes 同時接受 v1/v2，保留 HMAC、bot/thread/run/principal/project binding、expiry、大小、strict schema 與 private source 檢查。
來源未被提升成可信指令，仍僅進本輪 user row 的傳送副本；不寫入原生 history、不改 system prompt。
舊 Hermes 不支援 v2，會拒絕，不採有損降級；部署順序與 README 已說明。

### 2. Durable queue

SQLite additive tables：`document_sources`、`ingest_jobs`、`ingest_keys`；既有 layout/schema_version 1 和 immutable Part 1 revisions 不重寫。
Enqueue 在 transaction 中保存 source 與 job，完成持久化後才回 accepted；accepted 不代表已編譯。
狀態 pending/running/completed/failed/cancelled，唯一 `(namespace, source, version)` 與 scoped request key。

Worker 由 CLI `work` 每次領一個到期 job；lease 30 秒，heartbeat 5 秒，使用隨機 token fencing。
崩潰後 lease 到期重領，舊 worker 不可發布；最多三次 attempt，有限 exponential backoff，failed 作 dead-letter，可人工 retry。
取消／撤銷／rebuild 都撤銷 token；SIGINT/SIGTERM 取消當前 job。沒有啟用 Part 3 session observer。
Part 1 的 provider `write()` 原本不支援 session entry，本次維持 disabled；外部文件走專用管理入口。

### 3. WikiCompiler 與模型邊界

獨立 OpenAI-compatible adapter，支援 OpenRouter base URL、model、secret env、timeout/output token budget、可注入 transport／mock。
不共用或改動 Hermes agent harness。HTTP response 以串流限 128 KiB，非成功 response、非 JSON、非法 schema 均失敗。

- Analysis：每 12000 字元分段，輸出 evidence digest（最多 24 claims/chunk、全文件 96），逐字 quote 必須存在原 chunk。
- Generation：只取同 namespace 最多八個 lexical 候選頁，每頁 context 最多 4000 字元；結構化 proposals 最多八頁，嚴格驗證 slug/type/tags/related/claim indices。
- Merge：逐頁根據現有尾段 context 選擇有證據的新增主張。程式保留原正文、時間與所有 provenance，LLM 不能覆寫既有證據或指定驗證狀態。矛盾標為 disputed，fact/inference 分別標記；無價值結果可 no-op。

支援 entity/concept/decision/finding/procedure/preference/task，source 摘錄頁由程式生成，使用保留的 `source-UUID` ID。
頁面保留 stable ID、title/type/tags/related/sources/created/updated/verification；revision ID 位於 SQLite committed manifest。
未提供新的 index.md/log.md，未交由 LLM 重寫索引。頁面字數以 claim 字元上限、總頁 bytes、段落數與段落 bytes 共同限制。
所有 source/wiki 資料均放在 untrusted data message；LLM 無 filesystem、ACL、command 工具。

### 4. 一致性、失敗與撤銷

沿用 Part 1 revision protocol：驗證 Markdown → immutable temp file fsync/rename → SQLite writer transaction CAS → active pointers/FTS/edges。
本次把 fenced job completion 加入同一 publication transaction；多頁任一失敗，所有 pointers/index/job completed 一起 rollback。
無頁面的 no-op 也以 transaction 完成 job。檔案系統與 SQLite 不是天然跨資源原子交易；失敗留下的 orphan 不可檢索，沿用 cleanup 清理。

撤銷來源會取消 jobs，撤下所有包含該 source 的 active 衍生頁、FTS 與 edges；混合來源頁整頁撤下，其他獨立來源頁保留。
發布前再驗證全部 transitive document provenance，防止編譯期間撤銷後復活。
Scoped rebuild 先撤下文件衍生頁，再排入未撤銷來源的各版本重新編譯；reindex 不會恢復已撤下頁。
查詢失敗維持 unavailable/fail soft；ACL 失敗仍 fail closed；編譯失敗不更動既有查詢結果。
錯誤只保存一般代碼，CLI 不輸出原文、model response 或 secrets。

## 變更檔案

- `examples/copilotkit/server/graph/provenance.ts`：相容 session 與 document provenance schema。
- `graph/ingest-queue.ts`：來源版本、durable jobs、lease/fencing、retry/cancel/revoke/rebuild。
- `graph/compiler.ts`：LLM adapter、analysis/generation/merge、deterministic source pages。
- `graph/ingest-cli.ts`：可信本地管理入口與部署設定。
- `graph/types.ts`、`wiki-store.ts`、`retriever.ts`：頁面種類／verification、多來源、原子 job publication callback、檢索 provenance。
- `server/graph-memory.ts`、`memory/types.ts`、`memory/assembler.ts`：additive GraphHit 與 v1/v2 bridge，保留既有預算與 ACL。
- `hermes_agui/runtime_memory.py`：v1/v2 驗簽後 schema／private provenance 驗證。
- `tests/wiki-ingest.test.ts`、`wiki-ingest-cli.test.ts`、`wiki-runtime.test.ts`、`tests/fixtures/wiki-document-probe.ts`：Node 與跨語言驗收。
- `tests/hermes_agui/test_runtime_memory.py`：原生 request、session 不污染與 v2 拒絕契約。
- `examples/copilotkit/README.md`、本報告。

上述 `graph/`、`memory/` 與 Node `tests/` 短路徑均位於 `examples/copilotkit/server/` 或 `examples/copilotkit/tests/`。

## 測試指令與結果

Node PATH：`/private/tmp/node-v22.18.0-darwin-x64/bin`；Python test interpreter：`/private/tmp/hermes-graph-test-env/bin/python`。
沿用 Part 1 已由 PM 建立的隔離環境，未用 raw pip/uv 修改環境。可改成部署機器自己的等效路徑。
HTTP 測試需要允許 loopback 與 subprocess；測試全部使用 mock LLM，不接付費服務。

| 驗證 | 指令 | 結果 |
| --- | --- | --- |
| Part 1 baseline | example 中 `npm test -- --reporter=dot` | 7 files / 30 passed |
| 最終 Node 回歸 | 同上 | 9 files / 51 passed；最後 byte schema 更新後 ingest 19/19 與 tsc 再次通過 |
| TypeScript | example 中 `./node_modules/.bin/tsc --noEmit` | 通過 |
| Production build | example 中 `npm run build` | 通過；Vite 既有大 chunk warning |
| CLI 端到端 | 包含於 `wiki-ingest-cli.test.ts` | 真實 CLI subprocess + loopback mock API，enqueue/work/status/delete/rebuild、冪等、未知 job 拒絕皆通過 |
| Native Memory targeted | `scripts/run_tests.sh tests/hermes_agui/test_runtime_memory.py`，環境如下 | 6 passed / 0 failed |
| Python lint | `.venv/bin/ruff check hermes_agui/runtime_memory.py tests/hermes_agui/test_runtime_memory.py` | 通過；另跑 C901 通過 |
| TS complexity | 使用現有 `scripts/code_health/ts_units.mjs`，指定 example 的 TypeScript module 測量 17 個檔案 | 所有 units CC≤20、lines≤300、nesting≤6 |
| 文件路徑 | `.venv/bin/python scripts/check_no_tmp_literals.py examples/copilotkit/README.md` | 通過 |
| whitespace | `git diff --check` | 通過 |

原生回歸命令：

```bash
export PATH=/private/tmp/node-v22.18.0-darwin-x64/bin:$PATH
HERMES_HOME=/private/tmp/hermes-graph-part2-home \
HERMES_RUNTIME_DIR=/private/tmp/hermes-graph-part2-runtime \
HERMES_PYTHON=/private/tmp/hermes-graph-test-env/bin/python \
scripts/run_tests.sh tests/hermes_agui/
```

第一輪完整原生回歸為 80 passed / 1 failed；失敗為新 probe 對 SSE 原始字串搜尋 `PostgreSQL`，
實際回覆被合法拆為 `PostgreS`／`QL`。已修正為解析事件並串接 deltas；不是修改產品規避驗證。
修正後 Runtime Memory 整檔 6/6 通過，包含真實 Runtime → 文件 compiler/provider → Hermes → native model request，並確認 SQLite 不含文件 context。
普通與 delegated Run 的文件 v2 簽章／identity／原 messages 不變也有 HTTP integration test。

新增契約測試包括 A/B/C 增量與矛盾保留、來源更新／重送、source page、英文／既有繁中檢索回歸、
malformed/schema/path/evidence-invalid output、prompt injection 的資料／權限分離、byte/MIME/path 限制、
無價值 no-op、大文件分段、timeout/cancel、worker crash/reopen/lease/heartbeat/fencing、有限次重試、
並行 merge CAS、completed transaction 失敗回滾、實際 filesystem ENOTDIR 失敗、撤銷／reindex／rebuild／restart、
跨 bot/principal/project/shared compiler/query/update/status/deletion 隔離與多來源 private ACL。

### 根目錄檢查的既有阻礙

`.venv/bin/python scripts/check` 已執行，10/17 項通過；以下六個檔案仍不存在：

- `scripts/ci/check_os_marker_fakes.py`
- `scripts/ci/check_agents_md_size.py`
- `scripts/ci/check_line_endings.py`
- `scripts/ci/check_lazy_deps_imports.py`
- `scripts/ci/check_profile_archive_boundary.py`
- `scripts/ci/check_blob_size.py`

Health 最初無 Node PATH；補上後 `scripts/check --only health` 仍因根 `package.json` 缺失而失敗，與 Part 1 相同。
未新增無關 package 或 CI 腳本掩蓋這些問題。另以現有 TS metrics engine 搭配 example 已安裝的 TypeScript
直接檢查本次 source/tests units，修正 constructor CC 後全數符合上限。不能宣稱全專案 CI checks 全綠。

## 設定、操作與已知限制

完整 CLI／設定範例見 `examples/copilotkit/README.md` 的 Part 2 區塊。
Runtime graph disabled 時不啟用本功能；原生 session SQLite、MEMORY、skills 與既有 Bot/Delegation 操作保留。
無新公開 upload API、UI、常駐 worker，需管理員重複呼叫 `work`；這是本次選擇的管理 CLI 入口，不是自動 session 學習。

- Merge 是保守追加 evidence，保留既有驗證資料和衝突；不提供語意真偽裁判或 LLM prompt injection 的形式化保證。管理員仍須審閱模型判斷。
- 每頁最多 20 sources，沿用 page/paragraph/namespace 大小限制；超限 fail safe／進 failed，不自動截斷來源或丟棄舊知識。長期成長需人工整理。
- Compiler 僅使用同 namespace context；未開啟 private compiler 跨讀 shared 的選配能力，更不讓 shared 讀 private。
- 撤銷為停止檢索，不是實體抹除；raw source 和 immutable 歷史 revisions 留存稽核。混合來源頁可能暫時失去其他有效主張，需 rebuild 重編。
- 資料庫 layout 採 additive migration；舊程式不識別 document Markdown／v2 bridge。需先升級 Hermes；rollback 必須用升級前完整備份。
- 停止 Runtime／CLI worker 後整個 DATA_ROOT 備份與恢復；不能只複製 Markdown 或只複製 SQLite。恢復後 lease 到期續跑。
- 沿用單 SQLite writer/global serialization、合作式 query timeout 和可信本地資料目錄假設；沒有新增分散式 worker 或抵抗同目錄惡意本機 writer 的承諾。
- 真實模型 API canary 未執行；本次全部 mock。未新增 PDF/HTML parser、embedding/vector/hybrid、run observer 或自動 session 學習。

## 最終驗證更新

- 最後完整原生 AG-UI 回歸：**21 files / 81 passed / 0 failed**，198.1 秒；容器測試未啟用。
- 最後完整 Node 回歸：**9 files / 51 passed / 0 failed**；其後補強來源文字／標題的 UTF-8 512-byte 驗證，相關 ingest 測試 **19/19 通過**，最終 `tsc --noEmit` 通過。
- `npm run build` 已通過；Python Ruff、CC 及指定範圍 TypeScript metrics 通過。
- `scripts/check_no_tmp_literals.py` 同時檢查 README 與本報告通過，`git diff --check` 通過。
- 沒有新增 Part 3 能力、修改原生 agent loop 或 push。完成後停止，等待下一步指示。
