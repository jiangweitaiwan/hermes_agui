# Frontend Workspace Part 2 — Graph Memory Browser API

日期：2026-11-17。範圍僅 `FRONTEND_WORKSPACE_PART_2.md`；沒有實作 Part 3 UI，沒有 commit 或 push，沒有新增依賴或呼叫付費 API。

## 基線與閱讀

- 起始 commit：`e398b3ed42a9bfa7dea3b0edeb8b06fd682def3e`；起始 `git status --short` 為空。
- 已讀總計畫、Part 2、`docs/frontend-workspace-part-1.md`、GraphMemory Part 1–3 完成報告，核對 root／tests AGENTS.md，以及 server index/application、Bot auth/manager、provider/WikiStore/retriever/types/markdown/evolution/health/ingest-queue/provenance。example 沒有其他區域 AGENTS.md。
- 現有 WikiStore、SQLite active pointers、immutable Markdown、FTS/CJK bigrams、BotAuthentication、BotManager.owned 及 retained-owner/evolution revocation 均重用。沒有新增 production store instance、獨立 ACL、migration、GraphMemoryPort 操作、fake run/thread、LLM 或 embedding 呼叫。

## 實作與安全契約

新增 `examples/copilotkit/server/graph/`：

- `browser-types.ts`：Part 3 可共用的 summaries/details/network/stats/health/jobs DTO。
- `browser-query.ts`：strict query schema、Unicode page ID、scope/filter/endpoint/owner/Bot 綁定的 cursor。
- `browser.ts`：scoped active-page reader、列表、FTS 搜尋、網路、詳細頁及 bounded diagnostics。
- `api.ts`：managed authentication、ownership、可信 runtime namespace resolution、HTTP dispatch、JSON/no-store、transaction snapshot 與最後授權重驗證。

`application.ts` 把同一個 provider/store 接到 Browser，與 evolution 共用既有 retained-owner 函式。Graph deployment ACL 的型別只要求 principal/project/bot，移除原本內部 `ingest` 的假 thread/run 欄位；agent scope/query/write 的實際驗證與 retrieval ranking 不變。Browser 同時受 query policy 與既有 retained/write policy 約束；沒有放寬原來撤銷政策。只要配置 graph，就拒絕同 principal/project 對應不同 managed owner 的歧義部署，包括 evolution 關閉時。

`index.ts` 明確把 `/api/graph` 與 `/api/graph/*` 分派給原有 Node handler adapter，不落入 Vite 或 production SPA fallback，外層 Host/Origin 防護保留。

來源與權限：

1. identity 只來自現有 Bearer 或 server session；Bot 以 `manager.owned` 查核，再核對 runtime memory principal/project。client 不能提交 principal、namespace、path 或 revision。
2. private namespace 僅選中 Bot；shared namespace 仍限相同 principal/project。同名頁保留不同 `visibility:pageId`，不跨 namespace 造 edges。
3. disabled Bot 的合法 retained owner 可唯讀；deleted、owner-access/project/principal/policy 改變皆拒絕。混合來源中任一 owner 失效，整頁不可讀。
4. 每頁只經 WikiStore.active/read、checksum 與原有 Markdown schema。document evidence 需要同 namespace 的非撤銷 version/hash；tracked session evidence 需要 live source。evolution 關閉仍執行這些檢查；缺少可驗證的 document source table 時拒絕。Legacy session-only 匯入維持既有可信本地管理員 attest 契約，不新增 native session DB 查詢。
5. evolution 啟用時先沿用既有 reconcile。HTTP 沒有新增寫入動作；reconcile 可能按原有機制撤下失效來源及混合頁。撤銷仍是停止存取，不抹除 audit/history。
6. 每個 response 在既有 SQLite connection 的同步 `BEGIN IMMEDIATE` snapshot 中完成，與其他程序的 publication/revocation 序列化；回傳前重讀 selected Bot 與所有已使用的 source owners。沒有 async encoder/LLM 工作，也沒有跨請求 private cache。

## HTTP／DTO

所有路由為 `GET /api/graph/:botId/` 下，接受 `scope=all|bot_private|project_shared`，預設 all。完整契約與操作說明見 example README 的「Frontend Workspace Part 2」。

| suffix | 回傳及查詢 |
| --- | --- |
| `stats` | active validated pages、private/shared count、可見端點 edges、partial |
| `network` | nodes、namespace-local directed edges、nextCursor、truncated；type/verification/q filters；paired pageId/visibility focus，depth 1–2 |
| `pages` | summaries、nextCursor、partial；type/verification/q filters |
| `pages/:visibility/:pageId` | summary、active revisionId、title/type/tags/verification/body、可見 related、完整且 scoped provenance |
| `search` | required q、scoped summaries、每筆最多 320 Unicode 字元 snippet；只用現有 FTS terms，不呼叫 retriever/LLM/encoder |
| `health` | visible-page health、FTS drift、bounded pending/failed/lag counts、partial；partial 時無法判定的 brokenLinks/isolated 為 null |
| `jobs` | 最近最多 50 筆 retained-owner job summaries：id、安全 state、createdAt（有紀錄才提供） |

預設 limit 100，上限 300；jobs 最多 50；query 最多 512 字元／2048 UTF-8 bytes。拒絕未知或重複 query、非法 enums、path、cursor、limit、depth 及不完整 focus。Cursor 只作 pagination，不能授權；綁定 owner/principal/project/Bot/endpoint/scope/所有 filters（含 limit）。固定排序與 SQLite UTF-8 byte ordering 一致，包含 BMP／supplementary CJK；不同 requests 是 live view，不保留舊 revision。

未登入 401；無權／不存在／deleted Bot 及不可見 page 統一 404；Origin 拒絕 403；非法參數 400；非 GET 為 405 + Allow: GET。static mode 不提供資料，回 503；graph disabled/unavailable、store/checksum／budget failure 回 503，提供 disabled/unavailable status。health/jobs 在 evolution disabled 時明確 503 unavailable，不假造零。API responses 均 JSON + Cache-Control: no-store。

## 上限與限制

- 每個 window 最多掃描 300 candidates，最多 650 次 Markdown parses（含 focus/related），8 MiB parsed work、2 MiB response、300 nodes、1500 edges；超限 503 fail closed。
- Stats/health 僅掃描前 300 scoped candidates，partial=true 時 numeric counts 是 lower bounds。Health 只診斷已通過 provenance 驗證的可見頁，因此 staleProvenance=0；不是全庫 stale-source inventory。Health indexDrift 檢查 FTS sections；完整 edges/provenance repair 仍由管理 CLI 處理。
- Health jobs/lag 取各 namespace 最近 50 筆候選，再以 retained ownership 過濾及合併上限 50。沒有 enqueue time 的 legacy jobs 不納入 lag。partial 計算保守，brokenLinks/isolated 在 partial 時回 null；不能把不完整資料當零。
- Network edges 僅包含同一 response 中可見端點，不回傳跨分頁 edges。Focus 最多收集 301 candidates，超出保留 truncated；paging 完這個 bounded neighborhood 後不承諾能繼續列出全部高 degree 鄰居。不經無權節點擴展，也不生成 typed/cross-namespace relations。
- 沿用受信任本地 DATA_ROOT、單 Runtime writer 模型；沒有 distributed ACL transaction、全庫大型效能 SLA 或付費模型品質驗證。
- Markdown 不可信；README 已規定 Part 3 必須禁 raw HTML／安全 sanitize、連結 protocol allowlist、不可執行 script/event handlers，以及身份/Bot/scope/logout 切換時清除 private state/in-flight results。這次未新增 Graph UI。

## 測試與實際結果

Node 22.18.0 darwin-x64，既有 npm/package-lock、SQLite/FTS5、Chrome 150，Python 使用先前 Hermes PM 建立的隔離 interpreter；未以 raw pip/uv 修改環境。所有模型為本機 fake/mock。npm 指令於 `examples/copilotkit` 執行，Node PATH 指向既有暫存 toolchain。

| 驗證 | 指令 | 結果 |
| --- | --- | --- |
| 完整 Node 回歸 | `npm test -- --reporter=dot` | 15 files / 98 passed / 0 failed，44.86s；含新增 10 個 Browser tests |
| Browser 最後補強 | `npm test -- --reporter=dot tests/graph-browser.test.ts` | 最終 11 passed / 0 failed（27.48s），含 301-candidate focus 分頁終止及 job-window partial 契約 |
| TypeScript | `./node_modules/.bin/tsc --noEmit` | 通過，build 亦包含此檢查 |
| Production build | `npm run build` | 通過；補強後重建亦通過（1m12s），保留既有 large chunk warning |
| Playwright | `npm run test:e2e` | 5 passed / 2 skipped，2.9m；包含新增 graph routing JSON/no-store/Host/Origin，及既有 native chat/tool/thread/HITL/workspace |
| Hermes 原生相關回歸 | `HERMES_PYTHON=... scripts/run_tests.sh tests/hermes_agui/test_dynamic_runtime.py tests/hermes_agui/test_graph_evolution.py` | 2 files / 2 passed / 0 failed，77.2s；真實 Runtime/Host/SQLite + fake model |
| 根 CI | `.venv/bin/python scripts/check`（含 Node PATH） | 17 checks，10 通過、7 既有阻礙，見下節 |

Playwright 的兩個 skipped 是 managed lifecycle／multi-Bot 專屬模式；本次未以額外模式重跑，不把 skipped 當通過。HTTP API 的 managed lifecycle/ownership 測試使用真實 application、BotRegistry、WikiStore 與原有 Node handler，而不是 Graph UI mock。

新增 Browser tests 涵蓋 A/B 同 principal/project、C 不同 owner/project、所有 endpoints 的 auth/ACL/no-store、同名 private/shared ID、中文搜尋與 injection 字串、cursor 跨 scope/Bot/filter/endpoint、strict inputs/path traversal、graph disabled/unavailable/static mode、evolution off、disabled/delete/project/principal/policy、mixed-source owner 撤銷、document/session revoke 後禁止重新匯入復活、來源 owner 最後重驗證、active revision、未發布 Markdown、同 connection snapshot 與另一 SQLite connection publication、300 candidate windows、dense graph 1500 edges cap、safe jobs，以及不呼叫 agent retriever／不改 active 原始資料。

測試過程：初次有 4 passed、2 failed，分別為 fixture 用錯 `mimeType`（實際契約為 `mime`）及 sandbox loopback listen EPERM；修正 fixture 並允許本機 HTTP 後驗證。後續 job test 發現實際已有 createdAt，改為驗證允許的安全時間欄位。305 頁的真實 fsync fixture 超過 Vitest 預設 5 秒，該新測試使用 30 秒上限，未放寬產品 budgets。一次命令在根目錄誤跑 npm、一次 tsc 路徑誤用均未列為通過。沒有降低既有測試標準。

## 根檢查阻礙

與前期報告相同，以下六個 scripts 仍缺失：

- `scripts/ci/check_os_marker_fakes.py`
- `scripts/ci/check_agents_md_size.py`
- `scripts/ci/check_line_endings.py`
- `scripts/ci/check_lazy_deps_imports.py`
- `scripts/ci/check_profile_archive_boundary.py`
- `scripts/ci/check_blob_size.py`

health 因根 `package.json` 不存在而失敗。沒有新增無關 CI/package 檔來掩蓋問題；不能宣稱全專案 CI 全綠。另以現有 TS metrics engine 搭配 example TypeScript 直接檢查本次 units，結果於最終確認記錄。

## 操作與 rollback

沿用 README 的 managed registry、Bot login、graph dataRoot 與 evolution 配置。用原有 session cookie 或 Bearer credential 呼叫上述 GET routes；沒有新增 browser 設定或寫入入口。evolution 關閉可保留唯讀 pages/search/network/stats，health/jobs unavailable；整體 graph 關閉則不提供資料。Bot deletion／來源撤銷仍透過原有管理／CLI 路徑。

本期不需 migration 或重新匯入。Rollback 可回復本期 example server/API/README/test 變更並重建，不回復或刪除既有 WikiStore、SQLite、Markdown、Bot registry 與 audit/history。若 reconcile 已依既有授權撤銷知識，rollback 不應復活該資料。服務重啟後沿用既有登入 session lifecycle。沒有提交或推送任何變更。

## 最終確認

- 既有 TypeScript metrics engine 最終量測 189 個 units，無 CC>20、lines>300 或 nesting>6 的 finding。
- 補強後 production build 通過（1m12s）；最後 job-window 診斷小幅修正後，TypeScript noEmit 與 Browser tests（11/11）再次通過；完整 Node 回歸的 98 項與 build 為該小幅補強之前的實際結果。
- README／本報告的 `scripts/check_no_tmp_literals.py` 與 `git diff --check` 通過。
- 保留 Graph UI placeholder，沒有 Part 3 實作、commit 或 push。
