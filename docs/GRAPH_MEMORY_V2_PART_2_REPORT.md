# Graph Memory V2 — Part 2 實作及驗收報告

本次完成 Retrieval V2、Temporal View、Runtime 整合、Edge Embedding／詞彙索引、Graph Browser/API 與背景索引恢復。未部署 GCP、未連正式 Cloud SQL、未執行正式 Migration。所有重型測試依序執行，Vitest 使用單一 worker。

## 基準與安全邊界

- Part 2 獨立分支：`codex/graph-memory-v2-part-2`，由 Part 1 HEAD 建立。
- 開始 HEAD：`5129338689d5bfe8854aa986cf2b81f5ac85e842`，接續已完成 Part 1。計畫基準 `933d967...` 已包含於歷史。
- 原有 `host-config.yaml`、`tests/runtime.json` 修改及未追蹤的計畫書保持原狀，不納入提交。
- 保留既有 GraphMemoryPort、GraphQuery、GraphHit、AG-UI、Session History、Namespace、來源撤銷與 Wiki CAS 合約。
- 不修改 Migration 001–009；新增 `010_graph_fact_tokens.sql`。只對隔離的本機 PostgreSQL 16 測試叢集套用 Runtime 001–010，再重跑 010；資料物件使用 FilesystemGraphObjects 模擬不可變 GCS。

## 實作與實際檔案

完整清單見 `artifacts/graph-memory-v2-part-2/file-list.txt`。

- `v2-retrieval-store.ts`：共用 SQLite/PostgreSQL 適配器；Subject/alias、詞彙、Subject endpoint、state slot、Event 查詢。有效 Evidence join 未撤銷 Source Version；讀取每一份有效 Evidence，驗證引文並檢查 Namespace、來源 Bot、Requester、來源有效性及管理員授權。PostgreSQL 重查 Bot registry 的 active status／principal／project／owner。顯示名稱選自仍有授權來源支持的 alias，避免撤銷後返回舊 alias。不可變來源物件最多快取 32 份，每次重用仍重新查 DB 有效性與 ACL。
- `edge-embedding.ts`：固定欄位順序的文字模板、model/dimension/version key、內容 hash、32 筆批次、期限、向量形狀驗證、重建與獨立重試。JSONB 欄位順序與 SQLite 不同，不影響 hash。向量搜尋先檢查 model、dimension、content hash，再由 Retriever 重新授權 Evidence。
- `graph_fact_tokens`：與 Fact 發布同一交易寫入的衍生詞彙索引；既有 V2 Facts 以每批 32 筆補建。`graph_edges` 仍僅是 Wiki links。SQLite schema 與 PostgreSQL 010 都有 `(ns,token,edge_id)` 主鍵及 Fact 外鍵。
- `subject-retriever.ts`、`edge-retriever.ts`、`temporal-view.ts`：Subject/alias + lexical + vector 的 reciprocal-rank fusion；擴展 Event 與完整 state slot，再選時間 View。Subject 亦提供 Wiki profile seeds。History 結果依有效時間排序；current 跨 namespace 比較相關排名。
- `provider.ts`、`retriever.ts`：Provider 內接 V2，V1 Wiki 檢索保留。Wiki 與 Edge 檢索共用請求期限；每次 Edge query embedding 可跨兩個授權 namespace 重用。外部 await 後重新檢查 ACL、有效來源、目前 state slot 與 immutable Wiki active pointer。回傳仍遵守每個 content 16 KiB、最多 20 sources、request.limit 及 64 KiB 總結果預算。
- `evolution.ts`、`tasks.ts`、`worker-http.ts`、`ingest-cli.ts`：Tick／Cloud worker 接入索引。完成編譯但缺詞彙或目前模型 Edge vector 的 Job，可由既有 Cloud Tasks reconciliation 再派送，來源與 Job 保持權威狀態；不新增公開 Worker 路由。CLI `reindex` 補建 Edge tokens；`vectors` 重建 Wiki 與 Edge vectors，失敗回報 partial。
- `v2-browser.ts`、`browser-types.ts`、`browser-query.ts`、`api.ts`：新增唯讀 `/api/graph/:bot/facts`。同一 endpoint 以 subjectId／pageId／edgeId／eventId 提供 Subject Detail、Edge Detail、Event Timeline；維持 scope、綁定 query/owner/bot 的游標、掃描與輸出預算。回應前重新驗證參與組裝的來源與 Subject。Network 可疊加已授權 Fact Edge，Wiki Node 不因子 Subject 重複。Health 提供有界且標示 partial 的 Fact／Subject／Event 數與向量啟用狀態。
- `FactTimeline.tsx`、`MemoryExplorer.tsx`、`GraphView.tsx`、`MemoryDashboard.tsx`：最新／歷史切換連動主圖；紫色 Fact relations、共用 Wiki 內的子 Subject、Subject 關係與同事件篩選、發生時間／區間、certainty、attribution、來源引文及後續 Evidence 視窗。較早狀態可跳到歷史明細。
- `README.md`、GCP README／grants：文件化 010、既有資料補索引、設定、端點、窗口與部署順序。沒有新增非秘密環境設定；沿用 embedding model/dimension/version 與原有 V2 compiler flag。

## 時間及來源語意

- 只有相同 `stateSlotKey` 的 state edges 互相比較；使用 occurred/valid time，不使用 recordedAt。
- 唯一可比較的最新主張顯示 latest，並附較早狀態提示；同時刻、區間重疊、未知時間或 disputed 主張顯示 uncertain，不能直接強選真假。
- 獨立 event 不相互覆寫；history 保留不同日期的回滾與舊狀態。
- `as of 2026-11-06`／`截至 2026-11-06` 依有效時間重建；`2026-11-01 至 2026-11-10` 為相交區間的歷史查詢。未知時間保留不確定性。原始 observedAt、attribution、certainty 仍隨 Edge 顯示，未將來源主張升格為客觀驗證。
- Runtime 提供一份完整引文與總 Evidence 數、最多兩筆較早狀態摘要及總變更數。Browser 每窗四份引文、最多 20 份 provenance，附來源總數；後續視窗使用 evidenceStart。**輸出視窗不代表只授權前 20 份來源**，完整 Evidence 持久保存；超過讀取預算時 fail closed。
- 撤銷來源立即使失效 Evidence 不參與檢索；若尚有其他合法來源，保留其貢獻。停用來源 Bot 也不回傳其 V2 Fact。V1 既有「停用 Bot 可瀏覽舊 Wiki」語意保持不變。

## 具體驗收產物

模型全部為明確標記的 Mock LLM；SQLite／PostgreSQL、Compiler、Publisher、Provider、HTTP API 與 Chrome UI 使用真實程式碼。

- `artifacts/graph-memory-v2-part-2/retrieval-a.json`：實際 Runtime GraphHits 與 Browser 回應。查「Bob 如何處理搜尋推薦服務延遲？」返回五條事故 Edge、共同 Event ID、來源引文及 session provenance，沒有 Bob→Alice 代寫關係。
- `retrieval-c.json`：DB state rows、current、history、as_of 的實際 JSON。current 為 v2，changes 包含 v1；history 是 v1→v2；截至 11/6 為 v1。兩筆原始 Fact 不刪除。
- Fixture A 的完整 Raw Source、Parser JSON、GraphPublication、Wiki Markdown 與 DB Evidence rows，本次亦由既有 Part 1 測試重新產生於此目錄的 `fixture-a-standalone.json`、`fixture-a.json`、`wiki_*.md`、`featurehub.md`；查詢測試透過相同 Mock 模型與真實 Queue 發布後檢索，不是手填結果。
- `browser.png`：真實 Chrome 截圖；FeatureHub／快取為同一 Wiki Node，歷史狀態、事故原文與子 Subject 可展開。
- `verification/`：Migration、基準紅測、完整回歸、最終目標測試、Playwright、Build、專案檢查日誌。

## 驗證

| 驗證 | 結果 |
|---|---|
| 完整 CopilotKit Suite，SQLite + 隔離 PostgreSQL，單 Worker | **26 files / 156 passed / 0 failed / 0 skipped**；124.84 秒 |
| 最終目標驗證（Retriever／PG／Browser API／Worker） | **4 files / 30 passed / 0 failed**；39.72 秒 |
| Chrome 真實前端 E2E | **1 passed / 0 failed**；16.8 秒，附實際截圖 |
| Runtime 001–010 + 重跑 010 | 隔離本機 PostgreSQL 16 通過 |
| 基準 5129338 archive 紅測 | 1 suite failed，缺少新模組，exit 1；符合新增功能尚不存在 |
| 最後檢索驗證（排序拆分、as_of unknown、來源預算） | **2 files / 10 passed / 0 failed**；10.00 秒 |
| Build（tsc + Vite） | 通過；41.82 秒，僅既有 chunk size warning |
| scripts/check | **17 checks：16 通過，僅 no-tmp 基準失敗**；7 處原有 finding 位於原設定、Part 1 報告／日誌 |
| code health | **0 blocking / 0 advisory** |
| 最後 tsc --noEmit、Git diff whitespace | 通過 |

完整套件後，另針對最後的排序拆分、unknown as_of 與候選游標修正追加上述目標測試及 Chrome E2E。未執行正式雲端驗收，不能視為 GCP 實機已通過。

命令（每一項完成後才執行下一項重型測試）：

```bash
npm --prefix examples/copilotkit test -- --maxWorkers=1 --reporter=verbose
npm --prefix examples/copilotkit run test:e2e -- --config=playwright.graph-v2.config.ts
npm --prefix examples/copilotkit run build
.venv/bin/python scripts/check
```

`verification/check.log` 保留完整 lint 結果；`baseline-no-tmp.log` 對原有檔案重現同樣 7 處 finding。未修改這些任務外檔案，也未新增 lint 例外或放寬複雜度。初輪檢查的兩處 CC 與舊截圖大小問題已修正，初輪診斷保留於 `check-initial.log`。診斷使用 .log 格式保存，避免 lint 將診斷內容誤當產品設定。

Node 使用本機相容的 22.18.0；Chrome 使用本機 Google Chrome。PostgreSQL 測試將既有 `HERMES_AGUI_TEST_RUNTIME_DATABASE_URL` 指向隔離本機 Unix socket；沒有使用正式連線設定。`GRAPH_V2_ARTIFACT_DIR` 僅為測試輸出選項，非產品設定。

基準紅測在 `5129338...` 的獨立 archive 加入新檢索測試，因缺少 `temporal-view` 模組而失敗。這是功能尚未存在的紅測，不宣稱 V1 行為在基準損壞。

## 限制與回歸風險

1. 沒有正式 GCP／Cloud SQL／IAM／Cloud Tasks 實機驗收。PG + mock immutable GCS 與測試 Task enqueue 覆寫僅驗證 adapter／交易／排程選擇合約，不能代替雲端網路與權限驗收。
2. 詞彙回填每批 32；大量 Part 1 既有 Facts 在全部回填前可由 Subject 查到，但關鍵字召回尚未完整。管理員應先對選定 namespace 執行 reindex，再依需求重建 vectors。
3. 有界限制：Subject 候選 64、Event/slot siblings 128、每 Edge 有效 Evidence 96、向量掃描每 namespace/model 4,096；超限 fail closed 或放棄語意候選、保留可用詞彙路徑。Browser 初始候選 300、展開 512；Runtime 展開 256。更大規模需資料庫原生候選／向量後端及完整來源授權聚合，不能任意調高輸出上限。
4. Temporal intent 是明確詞彙／ISO 日期辨識，並非完整自然語言時間理解。as_of 語句缺少可解析日期時回傳 uncertain，不能偷偷改用 current。as_of 使用有效時間，不提供雙時間資料庫的「當時系統已知事實」快照；保留 observedAt 供使用者判讀。無法確立時間先後就不宣告 latest。
5. Embedding template 的語意改動需同步調整既有 embedding version 並重建；舊模型／版本／內容 hash 不符合的向量不參與搜尋。索引失敗不回滾已完成的 Graph publication。
6. Part 1 的混合來源 Wiki 撤銷後安全下架／排程重建窗口仍存在。前端結果是有界 live window；Refresh 或 scope 切換會重新取資料，不提供跨更新的完整快照。
7. 原生 Python Runtime E2E 未在 Part 2 重跑；本次未修改 Python。Part 1 報告中的原生測試環境建置限制仍適用。新增 Browser E2E 不假裝執行真實 Agent／真實模型。
