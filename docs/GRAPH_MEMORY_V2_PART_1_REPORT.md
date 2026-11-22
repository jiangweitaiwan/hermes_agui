# Graph Memory V2 — Part 1 實作及驗收報告

執行範圍：**只實作 Part 1 — Memory Write V2**。Part 2 的 Runtime Retriever、current/history View、向量索引器及 Graph Browser UI 未啟動。未部署 GCP、未連線正式 Cloud SQL、未執行正式 Migration。

## 基準與工作區

- 計畫基準與開始 HEAD 均為 `933d967945cfdef4e67cde9d5f0571304caa7238`。
- Remote 為 `git@github.com:jiangweitaiwan/hermes_agui.git`。
- 開始前已有 `host-config.yaml`、`tests/runtime.json` 修改；未納入本次提交、未覆蓋。輸入計畫書亦保留在工作區。
- 閱讀既有 Compiler、IngestStore、SQLite/PostgreSQL Queue、Wiki Store、Source Store、Session Ingestor、Markdown/Provenance、Worker/Evolution、Embedding、Migration 004–008、授權及既有測試後，沿用原發布與授權機制。

## 實作

### Persistence / Migration

新增 `examples/copilotkit/server/storage/migrations/009_graph_memory_v2.sql`，未修改歷史 Migration。

新增 `graph_subjects`、`graph_subject_aliases`、`graph_events`、`graph_fact_edges`、`graph_edge_evidence`、`graph_subject_attribute_evidence`、`graph_edge_embeddings`，以及 Namespace compiler version 與可信來源時間表。

SQLite 對應 schema 位於 `v2-sqlite-schema.ts`。`v2-store.ts` 提供共同 Store Adapter 與 SQL 操作序列；PostgreSQL 以既有交易的同一個 Client 執行，SQLite 同步執行序列，**不將 async callback 交給同步 SQLite transaction**。Namespace／Subject／Event／Source Version 使用外鍵；identity、semantic hash、來源級 evidence 使用唯一約束。Subject canonical name/type、時間及 alias/evidence 查詢索引獨立保存。原 `graph_edges`／SQLite `edges` 仍僅是 Wiki Links 的衍生索引。

更新 `deploy/gcp/database-grants.sql`：事實、身分與 Evidence 為 SELECT/INSERT；可重建的 Edge Embedding 索引另有 UPDATE/DELETE。未新增對核心模型的 tool surface，未改 CopilotKit Runtime／AG-UI 合約。

### Parser / Time / Matcher

- `parser.ts`：Zod strict contracts；Subject、Narrative、Stable Attribute 均帶 quote 與 UTF-16 source position；驗證原文切片與 quote 相等。
- `temporal-resolver.ts`：保存原始文字、timezone、anchor、confidence。以可信 referenceTime 解析日期、前一個日曆週、隔天；未知年份不採用匯入時間。日／週使用 UTC midnight 作**日曆日期標記**，不是宣稱事件精確發生於 UTC 午夜；timezone 另存。只有完整日期才可在沒有外部年份時解析。
- `subject-matcher.ts`：Namespace 內 identity／active aliases 候選，歧義時進行受限 LLM disambiguation；回傳 matched/create/unresolved。component 身分包含 parent Subject ID，防止不同系統同名元件共用 ID。無法判斷時不發布猜測結果。Vector candidates 尚未啟用，符合可選條件。
- 永久 Subject ID 與 Wiki Page ID 分離；明確 component-of 的子 Subject 保留 ID 與 section key，與父 Subject 共用 Wiki。新身分的最小 Wiki 僅記錄有引文的名稱；不將事故句當成 Profile。

### Profile / Fact / Publication

- `wiki-rewriter.ts`、`wiki-merger.ts`：以有效 Attribute Evidence 重組受管理 sections，拒絕覆寫未被 Registry 管理的舊內容，保留 section keys。沒有新 Profile 內容便不產生新 Wiki Revision；新 Evidence 仍持久化。
- 完整 Attribute/Evidence 關係不受 20-source frontmatter 視窗限制。PageSchema、Page/Section size、Runtime GraphHit 上限未放寬。
- `relation-abstractor.ts`：將臨時 Ref 轉永久 Subject ID，保存有方向的 relation、description、Event、factKind、stateSlotKey、occurred/observed/recorded time、certainty、attribution、semantic hash 與 evidence。
- 同一來源重試冪等；不同來源同語意同時間可合併 Evidence；時間不明時不以 recordedAt 推定相同事件。Event identity 納入來源時間，避免相同原文於不同時間被誤作同一上下文。
- `compiler-v2.ts` 接入既有 `WikiCompiler` 的 heartbeat／timeout／cancel／shutdown／retry 流程。
- `IngestStore.publish()` 接受 V1 Page Array 或 V2 GraphPublication。GCS Objects 依舊先建立，Wiki CAS、Subject/Event/Fact/Evidence 寫入及 Job 完成在同一 DB transaction；最後 lease/source 檢查失敗會回滾全部可見資料。孤兒 Objects 延用既有不可變物件清理機制。

### 撤銷及權限

- Edge／Attribute／Alias 的有效讀取 join 未撤銷的 Source Version；保留歷史 Rows，不刪除舊事件或狀態。
- 來源撤銷同步清除受影響 Edge Embeddings，並安全下架所有受影響 Wiki，包含未出現在前 20 份 frontmatter 引用的來源貢獻。
- 其他有效來源的 Attribute Evidence 保留，對應 Job 重設排程後重新組成 Wiki；重建前有短暫 Wiki 不可用窗口，不會返回已撤銷內容。
- 原有 revokeCopies、Bot lifecycle reconciliation、Namespace ACL 及 PostgreSQL authorizePublication 繼續使用。
- `activeEdges()` 是有界、供 Part 1 驗收使用的 trusted storage lookup；不是新增公開 API，也不是 Part 2 Runtime Retriever。授權 Namespace 由現有服務層決定。

### 可信 Session 時間與設定

Host 從原始 RunRecord.created_at 將 referenceTime 寫入不可變 Completion Evidence；Outbox 延遲重送不改變它。Runtime 的相容 Completion API 接受此可選 metadata。CLI 及本機觀察器亦沿用原 Source／Queue。

新設定：`graph.evolution.graphCompilerVersion: "v1" | "v2"`，預設 `v1`；可信 ingest CLI 設定根層有相同 key。第一次成功發布後固定 Namespace compiler version，阻止無規則混用。現有 V1 Namespace 切換需另外制定明確的管理員重建／遷移程序；單改 feature flag 不會偷偷重編已完成的來源。未增加非秘密的核心 HERMES 環境變數。

## 具體驗收產物

位於 `artifacts/graph-memory-v2-part-1/`，**模型均為明確標記的 Mock LLM**；Queue、SQLite/PostgreSQL、交易、Markdown Parser、Worker 及 HTTP Adapter 為真實程式碼。

- `fixture-a-standalone.json`：Fixture A 單次 Ingest 的 Raw Source、Parser JSON、完整 GraphPublication、7 個 Subjects、實際 DB Edge Rows 及 Evidence Rows。
- `wiki_*.md`：上述單次 Ingest 產生的可解析 Wiki Markdown；FeatureHub 與快取同頁，具不同 section keys。
- `fixture-a.json`：先匯入 Fixture B 的穩定元件特性，再匯入 A 的中間資料、Rows 與 Bob 的 storage lookup 結果。
- `featurehub.md`：Fixture B→A 的 FeatureHub Wiki，保留 TTL／存取層設計，沒有把回滾事故寫入 Profile。
- `postgres-snapshot.json`：隔離 PostgreSQL 的實際 Subject/Alias/Event/Fact/Evidence/Source Time Rows（Mock 資料）。
- `verification/`：完整測試、Build、Lint、基準重現及 code health 日誌。
- `file-list.txt`：本次實際修改／新增檔案完整清單。

預期／實際核心關係：Alice→搜尋推薦服務 `reported_issue`；FeatureHub 快取→搜尋推薦服務 `caused_degradation`；Bob→FeatureHub `rolled_back`；AI 助理→事後檢討文件 `drafted`；文件→Alice `delivered_to`。沒有 Bob→Alice 的代寫報告 Edge。五條 Edge 共用事故 Event。

referenceTime 為 2026-11-03 時，隔天為 2026-11-04，上週為 2026-10-26..2026-11-01；會後保留 relative/uncertain。C 的 v1/v2 是兩條 state edges、同一 slot、不同有效日期，原始 evidence 都保存；current/history 選擇留待 Part 2。

## 測試結果

| 檢查 | 實際結果 |
|---|---|
| 完整 CopilotKit Suite（SQLite + 隔離 PostgreSQL，單 Worker） | **25 files / 147 passed / 0 failed / 0 skipped**，118.58 秒 |
| V2 專屬測試 | SQLite/Session E2E 12 項、PostgreSQL 2 項，全部包含於上列 147 項 |
| Build（tsc + Vite） | 通過；既有 frontend chunk size warning，無型別錯誤 |
| 最新獨立 tsc --noEmit | 通過 |
| 新增 Python Source Time Test | **1 passed**；原生 Runtime E2E 另有 1 collection error，不能視為通過 |
| Migration 001–009 + 重跑 009 | 隔離本機 PostgreSQL 通過 |
| scripts/check | 17 checks；只失敗於既有 no-tmp guard，其餘通過 |
| code health | 0 blocking / 0 advisory；另附最終重跑日誌 |
| 基準 no-tmp | 在基準 commit archive 重現同樣兩筆，未引入新 finding |
| Git diff whitespace | 通過 |

第一次完整回歸與 Lint/Build 同時執行時，有 144 passed / 2 timeout（既有 Browser traversal 30 秒及 CLI 60 秒）。保留測試原逾時與斷言、改為單 Worker 後 147 項全部通過，未放寬測試。

測試命令：

```bash
npm --prefix examples/copilotkit test -- --maxWorkers=1 --reporter=verbose
npm --prefix examples/copilotkit run build
HERMES_PYTHON=<test-python> scripts/run_tests.sh -j 1 tests/hermes_agui/test_graph_source_time.py
python scripts/check
```

PostgreSQL 測試需將既有 `HERMES_AGUI_TEST_RUNTIME_DATABASE_URL` 指向**隔離的本機測試 DB**，先由測試管理員套用 Runtime 001–009。此次使用 Unix socket 與測試資料庫 `graph_v2_final`，Objects 為 `FilesystemGraphObjects`（模擬 GCS 的 create-only/generation/hash contract）。009 重跑成功，未對正式資料庫執行任何 SQL。

V2 測試涵蓋 A–D、無新 Wiki 的 Edge Job、重複來源、跨來源 evidence 合併、22 份來源、同名不同系統元件、重啟、Lease 搶占、CAS 競爭、錯誤 LLM JSON、虛構引文、取消、編譯中撤銷、shared copy 撤銷及跨 Bot 隔離。PG 驗收包含雙連線併發與 Object 已寫入但 DB lease 驗證失敗後無半發布及可重試。

基準紅測：在 `933d967...` 的獨立 archive 放入 V2 測試後執行，確實因缺少 compiler-v2 模組失敗；日誌保留，屬新增功能尚不存在的紅測，並非宣稱既有 V1 行為測試失敗。

## 限制及回歸風險

1. 未執行正式 GCP／Cloud SQL／IAM 實機驗收。GCS Adapter contract 由本機不可變物件適配器及既有測試驗證，不能等同雲端實機已通過。
2. 既有 Python 原生 Runtime E2E 起初因 `ag_ui` 缺失而不能收集。依專案 PM 嘗試建置完整隔離測試環境後，鎖定的 cryptography 50.0.2 在此 macOS 主機原生編譯失敗；沒有修改依賴版本、繞過 TLS 或使用 raw pip。新增來源時間 Python 單元測試有實際通過，完整原生 Runtime E2E **不標記通過**。
3. `scripts/check` 的 no-tmp guard 在既有 `host-config.yaml` 第 8、11 行有兩筆基準已存在的 `/tmp` literals；不改動任務外設定。其他檢查與 code-health 結果見日誌。不得將整組 Lint 寫成全綠。
4. Parser／Disambiguator／Relation LLM 仍可能在語意上誤判；Zod／Ref／span／hash／transaction 只保證結構、出處可驗證及發布完整性，不等於獨立證實來源主張。assistant_unverified 不升格 verified。
5. Matcher 的 Namespace scan 有 1,000 Subjects／20,000 aliases 上限，Attribute scan 有 1,000 Rows 上限；超限 fail closed，不默默裁切後判定不存在。更大 Namespace 需要 Part 2 有界候選索引。
6. V2 只重寫 Registry 管理的 Profile；未提供無人審核的跨頁實體合併／搬移操作。遇不相容舊頁、歧義或版本衝突採拒絕／重試，保留既有 immutable history。
7. Edge Embedding schema 已提供；索引器及 Runtime 混合檢索依計畫留待 Part 2。Part 1 的 storage lookup 不依賴向量，不能拿來宣稱 Part 2 查詢／UI 驗收完成。

完成 Part 1 報告後停止；不自動進入 Part 2。
