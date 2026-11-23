# GRAPH_MEMORY_V2_IMPLEMENTATION_PLAN.md

> 專案：[`jiangweitaiwan/hermes_agui`](https://github.com/jiangweitaiwan/hermes_agui)
>
> 計畫基準：`main` commit `933d967945cfdef4e67cde9d5f0571304caa7238`（2026-11-22 查核）。Codex 開始時先檢查 HEAD 與差異，勿直接假設檔案內容沒有改變。
>
> 交付方式：**Part 1（寫入）→ Part 2（檢索及前端）**。先完成 Part 1 驗收，再啟動 Part 2。不要求 Codex 實際部署 GCP，也不得自行對正式資料庫執行 Migration。

## 0. 目標、邊界與決策

### 目標

將目前「Raw Session/Document → Claims → Wiki Pages（內含事件）→ Page Links」改成：

```text
Session / Document
   → Raw Source + Provenance + Ingest Job（保留既有）
   → LLM Parser → Subjects + Evidence-backed Narratives
      ├─ Subject Matcher → Subject Registry + Wiki Page Grouping
      │    → Stable Attribute Extractor → Wiki Rewriter → Wiki Merger → Wiki Page Revision
      └─ Temporal Resolver → Relation Abstractor → Events + Fact Edges
                                              └→ Edge Embedding（可延後索引）
   → Atomic Graph Publisher（發布 Wiki/Subject/Event/Edge/Evidence，最後完成 Job）
   → Retriever V2（Subject + Wiki Profile + Temporal Semantic Edges）
   → CopilotKit Runtime 的 GraphHit → AG-UI Agent
```

**Wiki Page 是 Graph 視圖上的 Node；Subject 是可被唯一識別的實體／概念，數個具有真正從屬關係的 Subject 可以共用一張 Wiki。** Wiki 寫相對穩定的 Profile（背景、專長、組件特性等）；事件、互動、變動狀態寫在帶證據的 Fact Edge。保留 Event 作為多條 Edge 的共同上下文，不強迫將 Event 變成 Wiki Node。

### 使用者確認的兩項決策

1. **保留歷史 Edge，檢索時顯示最新狀態。** 只對代表同一可變狀態的 Edge 使用 `state_slot_key` 分組及時間排序；歷史事件（例如兩次回滾）是兩件獨立事實，不得簡單保留日期最新的一條。保留舊 Edge 供歷史查詢；遇矛盾、時間不確定或互不相容來源時，呈現來源與不確定性，不將「最新」直接視為「客觀真實」。
2. **Matcher 決定 Wiki 分組。** `FeatureHub`、`FeatureHub 的快取` 可以是不同 Subject ID，但共用 `FeatureHub` Wiki Page；快取維持獨立子章節及 Subject ID，Edge 仍可連到快取。Rewriter 依已分組的內容修改 Wiki；其後使用受限制的 Merger 驗證、整合版本，避免遺失其他章節。

### 不做的事

- 不將所有語意相近的 Subject 強行合併為一個實體；同名不同人、不同系統不得因向量相似而合併。
- 不把 `graph_edges` 直接改成事件表：它目前是 Wiki Links 的衍生索引，重索引時會刪除並重建。
- 不以 Embedding 向量取代 Edge 的可讀敘述／來源／時間欄位。
- 不重寫 CopilotKit Runtime、AG-UI 協定、Bot Manager、Cloud Run 架構或既有 Session History 的權威儲存。
- 不在 Part 1 要求調整前端全部功能；Part 2 再做 Graph Browser 與 Runtime 查詢整合。

## 1. 現有程式碼錨點（必須先閱讀）

路徑相對於 repository root：

| 現有檔案 | 已有能力／需要改的地方 |
|---|---|
| `examples/copilotkit/server/graph/session-ingestor.ts` | `RunCompletionObserver`、`SessionIngestor`，保留安全篩選、來源及去重；擴充可信的時間參考資訊 |
| `examples/copilotkit/server/graph/ingest-queue.ts`, `postgres-ingest-queue.ts`, `ingest-store.ts` | 保留 enqueue、lease、heartbeat、retry、idempotency；擴充 `publish()` 支援 Graph Publication |
| `examples/copilotkit/server/graph/compiler.ts` | 現有 `WikiCompiler` 只有 analysis/generation/merge；替換／以開關切換為 V2 pipeline |
| `examples/copilotkit/server/graph/types.ts`, `provenance.ts`, `markdown.ts` | 新增嚴格 Schema；保留既有 Markdown 格式與來源追溯 |
| `examples/copilotkit/server/graph/wiki-store.ts`, `postgres-wiki-store.ts` | 保留 Wiki immutable revisions / CAS；新增 Subject Registry、Event/Fact Edge 的儲存適配 |
| `examples/copilotkit/server/graph/embedding.ts` | 沿用 Encoder；新增 Edge Embedding indexing 與版本管理 |
| `examples/copilotkit/server/graph/retriever.ts`, `retrieval-store.ts`, `provider.ts` | V2 混合檢索；GraphHit 仍遵守 `graph-memory.ts` 的驗證與 ACL |
| `examples/copilotkit/server/graph/evolution.ts`, `worker-cli.ts`, `ingest-cli.ts` | 讓既有 Worker/CLI 能執行 V2；保留取消、逾時、重新排程語意 |
| `examples/copilotkit/server/graph/browser.ts`, `browser-types.ts`, `browser-query.ts`, `api.ts` | Part 2 擴充 Subject / Fact Edge / Event 瀏覽及歷史時間線 |
| `examples/copilotkit/server/storage/migrations/004_graph_wiki.sql`、`005_graph_sources.sql`、`006_graph_jobs.sql` | 既有 PostgreSQL；新增 Migration **`009_graph_memory_v2.sql`**，不可回頭修改已部署 Migration |
| `deploy/gcp/database-grants.sql`、相關部署與測試腳本 | 新表 runtime/worker 的最小權限，保持 Cloud Run 相容 |

原有 `PageSchema.sources` 限制 1–20 筆、Page size / section budgets、`GraphHit.sources` 最多 20 筆、GraphHit 內容 16 KiB：V2 必須設計完整 Evidence 的持久化與有界查詢，不得任意增加輸出上限或默默丟失來源。**目前來源撤銷可能將含來源的整個 Active Wiki Page 下架**；多來源 Wiki V2 需改為「來源級 Evidence 失效 + 有界重建／安全下架」，防止不相關資訊一起消失。

## 2. 新版資料模型

### 2.1 Subject 與 Wiki Page 是不同的識別層

新增 `graph_subjects`（`ns, subject_id, canonical_name, type, wiki_page_id, parent_subject_id?, section_key, created_at, updated_at`），及 `graph_subject_aliases`（`ns, subject_id, alias, alias_normalized, source_evidence...`）。

- `subject_id`：一旦發布不可因 Wiki 標題改動而變更；`wiki_page_id`：指向該 Subject 所屬的 Wiki Node；`section_key`：在 Wiki Body 內錨定子 Subject 的穩定章節 ID。
- 多個 Subject 可共用 Wiki Page；只在 **part-of／component-of／同一主題的細分** 且證據足夠時分組，不因字詞或向量相近就分組。
- 別名搜尋容許同名對應多個 Subject；Matcher 無法判斷時輸出 `unresolved`，不能假裝匹配成功。
- `parent_subject_id` 表示從屬關係；`wiki_page_id` 決定前端的 Wiki Node 群組。維護跨頁搬移、合併時的穩定 Subject ID 與完整映射。

預期結果：

```text
subject_featurehub          ───────┐
subject_featurehub_cache    ───────┴──→ wiki_page: featurehub
                                        # FeatureHub
                                        ## Overview
                                        ## Components
                                        ### FeatureHub 的快取 [stable section_key]
subject_bob                 ──────────→ wiki_page: bob
```

不要讓 Edge 指向 Markdown 標題字串；**Edge 的 from/to 引用永續 Subject ID，再由 Registry 決定要顯示哪一個 Wiki Page 及子章節**。

### 2.2 Event 與 Fact Edge

新增 `graph_events`（`ns, event_id, title, summary, occurred_from?, occurred_to?, time_precision, source_time_text, ...`）。

新增 `graph_fact_edges` 的至少欄位：

```ts
interface FactEdge {
  edgeId: string;
  eventId?: string;
  fromSubjectId: string;
  toSubjectId: string;
  relation: string;       // e.g. rolled_back, reported_issue, caused_degradation
  description: string;
  factKind: "event" | "state";
  stateSlotKey?: string;  // only for comparable mutable state
  occurredFrom?: string;  // ISO-8601; event time / interval
  occurredTo?: string;
  timePrecision: "instant" | "day" | "week" | "month" | "relative" | "unknown";
  originalTimeText?: string;
  observedAt?: string;    // source observation/statement time, if available
  recordedAt: string;     // ingest/publication time, NOT the event time
  attribution: "user_stated" | "assistant_unverified" | "document_reported";
  certainty: "reported" | "inferred" | "disputed";
  status: "active" | "superseded" | "disputed" | "retracted";
  semanticHash: string;
}
```

- `graph_edge_evidence`：`ns, edge_id, source_id, source_version, quote, quote_hash, position?, provenance, classification`；支援一條 Edge 多個獨立來源、去重、撤銷。Quote 必須可在 Raw Source 中驗證。
- `graph_edge_embeddings`：`ns, edge_id, model, dimension, vector, content_hash, indexed_at`；Embedding 應由描述＋關係＋必要的 Subject Display Name／時間摘要的**穩定文字模板**生成；向量值不可用於事實驗證。
- `graph_subject_attribute_evidence`（或等效的來源關聯表）：保留 Wiki Profile 各穩定屬性的來源，以便單一 Session 撤銷時能重新組成 Wiki，不抹掉其他合法來源。
- 對 `ns, subject_id`、Subject alias、`ns, from_subject`、`ns, to_subject`、`ns, event_id`、`ns, fact_kind, state_slot_key, occurred_from`、Source Evidence 等建立適當索引。語意查詢初期可沿用現有 VectorIndex / Encoder 的抽象；是否採 pgvector 應依真實依賴／部署能力決定，不作為 Part 1 前置條件。
- `ns`、外鍵、唯一性／去重、字串長度、允許 relation、查詢上限均以 Schema / SQL 約束；正式 Migration 補全 FK、CHECK、索引及撤銷語意。這裡列的是資料契約，不是可直接執行的完整 DDL。

### 2.3 同一狀態的最新版本與獨立事件的區別

例如 `FeatureHub 的部署版本` 是 mutable state：使用 `state_slot_key = subject_featurehub:deployed_version`。同一 slot 的舊、新主張都保留，但預設 current query 選擇有可信 valid/occurred time 的最新有效主張，並附上時間與證據；未能確定時間先後、來源矛盾時保留 conflict/uncertain，不能強選。

例如 `Bob 在 11/4 回滾 FeatureHub` 是歷史 event，日後又一次回滾也是另一個 Event，不屬於互相覆寫。`recordedAt` 不得用來取代 `occurredFrom`；沒有足夠時間的 edge 不可偷偷當作「最新」。歷史／趨勢／時間範圍查詢回傳必要的多個事件。

## 3. Part 1 — Memory Write V2（先執行並獨立驗收）

### P1-A. 建立 Schema / Persistence Adapter

1. 新增 `009_graph_memory_v2.sql`，涵蓋 Subject、Alias、Event、Fact Edge、Evidence、Attribute Evidence、Edge Embedding；新增本機 SQLite 對應 Schema／測試。
2. `graph_edges` 繼續維持原 Wiki Link 索引；不可將 Fact Edge 存於這張會因 Page reindex 被清除的表。
3. 新增 `subject-store.ts`、`fact-edge-store.ts`、`event-store.ts` 等介面及 PostgreSQL/SQLite 實作（可按現有命名慣例調整）。確保新表被 migration grant / health / cleanup / rebuild 路徑涵蓋。
4. 不改已部署 migration，migration 支援可重複檢查及測試，不在正式 DB 自行執行。

### P1-B. Parser + Temporal Resolver

新增 `parser.ts`、`temporal-resolver.ts` 與 Zod schemas。Parser 輸出 `subjects[{ref,name,type,span...}]`、`narratives[{text,subjectRefs,quote,sourceSpan...}]`，另可輸出 `stableAttributes` 候選；只輸出有來源支持的關係，Assistant 推論與使用者聲稱不可混淆。

- Narrative 可切成最小可辨識事件句，不強制一整個對話只有一段。
- 先從可信 metadata（文件日期、Session 事件時間等）得到 `referenceTime`，缺少年份不可自行補年份。**現有 Session 原始來源尚沒有足夠的可信事件時間 metadata，需要擴充相容的來源記錄**。
- 解析「11/3」、「上週」、「隔天」、「會後」，保留 `originalTimeText`、精度、時區、anchor 和解析信心。不確定則保持 unknown 或區間，不捏造日期。
- 每條引用 quote 要能在 Raw Source 定位；資料不可信，LLM 原文不得成為 SQL、工具命令或 ACL 指令。

### P1-C. Subject Matcher + Wiki Grouping

新增 `subject-matcher.ts`：

1. 限於同一授權 Namespace 的 Exact ID / Alias → Lexical Candidates → Vector Candidates（若啟用）→ LLM Disambiguation。
2. 回傳 `matched | create | unresolved`，及 `{subjectId, wikiPageId, parentSubjectId?, sectionKey}`。
3. 對 `FeatureHub` 與 `FeatureHub 快取` 使用 `component-of` 分組，**兩個 Subject ID、同一 Wiki Page**；人名同名但不同身份不可合併。
4. 新 Subject 同時被兩個 Worker 建立時，以唯一約束／交易處理衝突，重新匹配或安全重試，不產生雙重身分。
5. 群組決策在 Rewriter 之前完成；不要先生成多張 Wiki 再靠 LLM 事後模糊合併。

### P1-D. Stable Attribute Extractor → Rewriter → Merger

新增 `wiki-rewriter.ts`、`wiki-merger.ts`（或等效模組）。

- **僅允許穩定 Profile 屬性寫入 Wiki**：職務、背景、專長、興趣、系統設計／元件特性等；事件日期、故障、回滾、交付活動放 Edge。
- 輸入為 grouped subject + candidate stable attributes + matched Wiki + active revision + evidence；**沒有新穩定屬性時不發布不必要的 Wiki Revision**。
- `Rewriter` 產生目標 Wiki Sections；`Merger` 驗證保留原有其他 Subject Sections、Stable section keys、有效 evidence，執行版本比較與必要的合併。避免純 LLM 任意覆蓋舊文件。
- 維持 Wiki Markdown + YAML Frontmatter / `PageSchema` 可解析；改動 `sources` / provenance 上限時必須有完整 DB 級來源映射與檢索限制，不能默默丟棄超過 20 筆的 provenance。
- 新建 Wiki Page 時 `sources` 必須真實有效；沒有可發表 Page 也必須允許純 Fact Edge Job 成功。

### P1-E. Relation Abstractor + Event/Edge Normalization

新增 `relation-abstractor.ts`：輸入 Narrative、已解析時間、暫時 Subject Ref，輸出 `events[]` 與 `edges[]`，並在發布前把 Ref 映射到 Matcher 的永久 Subject ID。

- Relation 應有明確方向、語意、描述、事件／狀態類別、時間精度、可驗證原文、來源分類。
- `AI 助理撰寫報告交給 Alice` 不可誤寫成 `Bob → Alice`；若主詞缺失，標記未知或拆成「AI 助理→事後檢討文件」「文件→Alice」的有據關係。
- 對獨立重複 Session：同一來源重試要 idempotent；相同語意但不同來源可合併 Evidence；不同日期事件不能誤去重。
- Event 只是同組關係的共同 context，可以沒有獨立 Wiki Page。

### P1-F. 原子發布 / 撤銷 / 失敗恢復

將 `IngestStore.publish()` 由 Page-only 擴充成 `GraphPublication`（pages、subjects、events、edges、evidence、必要的 expectedRevision）。保留原有 IngestStore 的 lease token、heartbeat、source validity、Job state 與 namespace ACL：

1. 交易外建立不可變 GCS Wiki Objects（若有新 Page）。
2. 單一 PostgreSQL Transaction 中驗證 lease、source 未撤銷、權限、Subject 及 CAS expectedRevision；寫入 Wiki Revisions/active pointers、Subjects、Events、Edges、Evidence；最後完成 Job。
3. 若交易失敗，不能留下可見的半完成 Edge／Page；按照既有 retry/backoff 重新解析或重載 current revision 後重試。孤兒 GCS Objects 使用既有清理策略。
4. Edge Embedding 採持久化後的獨立可重試索引，**在向量尚未完成之前，文字／Subject 檢索仍應能查到 Edge**。
5. Source Revoke／Bot Disable／Project Share revoke：同步使失效 Evidence 與無有效證據的 Edge 不可檢索；混合來源 Wiki 只撤銷受影響的 Profile Attribute，重建或暫時安全下架待重建。不得洩漏其他 Bot 私有記憶。
6. 新舊模式 Feature Flag：`graphCompilerVersion = 'v1' | 'v2'`，預設維持舊模式直到驗收；不要在同一 Namespace 無規則地重複編譯同一來源。

### Part 1 必須通過的驗收

- 會議範例一次 Ingest 生成 Alice、Bob、搜尋推薦服務、FeatureHub、FeatureHub 快取等 Subject，快取從屬 FeatureHub 且 **兩者同一 Wiki Page**。
- 同一個 FeatureHub Wiki 只包含相對穩定的說明／快取子章節；事故報告、回滾和交付事件主要存在 Edge。
- 11/3 若可信年份為 2026，`隔天` 為 2026-11-04，`上週` 保留 2026-10-26 至 2026-11-01 範圍；缺年份不任意猜測。
- 有 `Alice → 搜尋推薦服務` reported_issue、`Bob → FeatureHub` rolled_back 等有引文的 Edge；**沒有無來源支持的 `Bob → Alice` 代寫報告 Edge**。
- 同一來源重跑／重啟／Worker 搶 Lease 不重複建 Subject 或 Edge；只有新 Edge 而無 Wiki 更新也可成功發表。
- Revision 衝突、LLM JSON 不合法、來源撤銷、取消、GCS 寫入成功但 DB 失敗時，無半發布且可安全重試。
- 本機 SQLite、PostgreSQL + 模擬 GCS / 測試容器均通過核心測試；既有 V1 測試繼續通過。

## 4. Part 2 — Retrieval V2、Temporal Latest View、Graph Browser

### P2-A. Edge Embedding Index

- 沿用現有 `OpenAIEncoder`/`VectorIndex` 的 API 契約；新增 Edge Embedding Store，支援 model、dimension、content hash、索引重建及有界批次。
- 先建立 Edge 的 lexical index / subject lookups；向量索引為加速與語意召回，不是唯一搜尋手段。
- Embedding 更新失敗時 Job 完整可恢復、舊向量因內容／模型不符不得混用。

### P2-B. Hybrid Temporal Retriever

新增 `subject-retriever.ts`、`edge-retriever.ts`，從 Query 辨識實體、事件、時間需求，採用：

```text
Query → Subject / Alias Resolution
      → Wiki Profile Retrieval + Edge Lexical + Edge Vector
      → ACL / Provenance Validation
      → Event Expansion
      → Temporal Selection（依查詢意圖）
      → Bounded GraphHits → CopilotKit Runtime
```

- `current` 查詢：對相同 **stateSlotKey** 的可比較 state edges 以 valid/occurred time 排序；只輸出優先狀態及必要的變動／衝突提示。不能依 `recordedAt` 直接宣告真假。
- `history` / `why` / `timeline` 查詢：保留相關不同事件、因果以及舊狀態，依時間順序整理，附上原文來源。
- `as_of` 查詢：依指定時間範圍重建當時可觀測狀態，沒有精確時間時明示未知。
- 忠實組裝 `GraphHit`，滿足 `graph-memory.ts` 長度、數量、來源與 Namespace 驗證；對每一條候選 Edge 的所有來源作授權檢查，避免跨 Bot 洩漏。先在 Provider 內接新版 Retriever，維持既有 AG-UI Contract。
- 舊版 Wiki links 仍可用作弱鄰居訊號，不可以取代 Fact Edge 描述與 Evidence。

### P2-C. 前端與管理介面

- `GraphBrowser`、`browser-types.ts`、`api.ts` 加入 Subject Detail、Wiki 內子 Subject、Edge Detail、Event Timeline 與來源證據；Graph 中多個 Subject 共享同一 Wiki Node 時，不重複渲染 Wiki Node，但能展開子 Subject。
- Edge 顯示 relation、description、occurred time/range、source/target Subject、Event ID、certainty、provenance、是否是某狀態最新版本。
- 支援「只看最新狀態」與「查看歷史」切換；所有查詢維持現有 scope、游標、pagination、ACL 及有界 scan 規則。

### Part 2 必須通過的驗收

1. 查「Bob 如何處理搜尋推薦服務延遲？」可從回滾 Edge + 同事故 Event 得到可追溯答案，不需把事件寫回 Bob Wiki。
2. 先匯入「FeatureHub 目前版本 v1」，再匯入有較晚有效時間的「目前版本 v2」：current 顯示 v2 並附變更資訊；history 顯示 v1 → v2。
3. 不同日期的兩次回滾：history 保留兩件事件；current 不將其中一件視作另一件的真假覆寫。
4. 較晚才匯入但實際發生更早的事件，不可被當作最新狀態；未知時間與有爭議來源標示 uncertain。
5. 未建立 Edge Embedding 時仍能 keyword / Subject 查到；建索引後向量相關排序可用且不跨 Namespace。
6. 停用 Bot／撤銷來源後，Edge、事件檢索與 Graph Browser 不再顯示已無授權證據的關係。
7. 保留既有 Graph API / Runtime GraphHit 合約，CI、GCP 模式的 smoke tests 與前端原有頁面無回歸。

## 5. 必備測試資料與預期輸出

### Fixture A：會議事故（將 `referenceTime` 指定為 `2026-11-03` 作為測試前提）

> 11/3，會議中，Alice 報告上週搜尋推薦服務的延遲飆高，原因是 FeatureHub 的快取失效。隔天 Bob 把 FeatureHub 回滾到舊版，延遲隨即恢復。會後由 AI 助理草擬了事後檢討文件交給 Alice。

**預期：**
- Subject：Alice、Bob、搜尋推薦服務、FeatureHub、FeatureHub 快取、AI 助理、事後檢討文件（可用 role/document 類型）；不是每個 Subject 都必須單獨成 Wiki Page。
- Wiki：FeatureHub 與 FeatureHub 快取同一 Page，快取是子章節；同一 Wiki 的 Section ID 維持穩定。
- Temporal：上週=2026-10-26..2026-11-01（前一個日曆週），隔天=2026-11-04；「會後」只有相對時間，不作無憑據的精確時刻。
- Edge：Alice 報告搜尋推薦服務異常；FeatureHub 快取失效與延遲相關（保留「來源聲稱的因果」）；Bob 回滾 FeatureHub；AI 助理草擬事後文件；文件交給 Alice。不得推論 Bob 委託 AI 交報告。
- 相關事故 Edge 有共同 Event ID；Quote 可追至 Raw Source。

### Fixture B：Subject 分組

> FeatureHub 的本機快取使用 TTL；FeatureHub 的存取層支援版本回滾。

**預期：** 同一 FeatureHub Wiki 兩個子章節／屬性；只有真實從屬關係才能同頁，不能把兩套同名但不同系統自動合併。

### Fixture C：狀態變更

> 11/05 FeatureHub 目前部署 v1。11/12 FeatureHub 目前部署 v2。

**預期：** 兩條 `factKind=state` Edge（必要時使用獨立值 Subject 或受限的 literal target 表達版本值；如採 literal，須明確定義兼容 Schema），同一 `stateSlotKey`；current=v2，history=v1/v2，保留兩個 Evidence。

### Fixture D：權限撤銷

同一 Wiki Profile 分別來自私人 Session A 與 B，撤銷 A：A 的貢獻不再檢索；B 的合法資料仍存在；跨 Bot 的 Project Shared copy 依法撤銷；不出現失效 Edge 的向量搜尋結果。

## 6. Codex 工作程序與交付物

### 開始前

1. `git status`、`git rev-parse HEAD`，確認與本計畫基準差異；閱讀 `AGENTS.md`（如有）及目前測試指令。
2. 快速列出實際觸及檔案與新增 Migration 的安全策略。禁止因實作方便而刪除既有測試、修改歷史 Migration 或放寬授權與資料長度限制。

### 執行順序

- **Part 1**：Schema → Stores → Zod Data Contracts → Parser/Temporal → Matcher/Grouping → Rewriter/Merger → Abstractor → Atomic Publisher → CLI/Worker → Fixtures/Tests → Part 1 Report。
- **Part 2**（Part 1 驗收通過後）：Edge Embedding → Temporal Retriever → Runtime Integration → Browser/API → Metrics/Health → E2E / GCP adapter acceptance → Part 2 Report。

### 各階段提交要求

每個 Part 要有：
- 實際修改檔案清單、Migration SQL、本機 SQLite 與 PostgreSQL 相容實作、必要 config / env 說明。
- 測試命令及完整通過／失敗數據；無法執行的 GCP 實機驗收要明確標示，不能寫已通過。
- 模擬 Fixture A 的 **具體 JSON 中間產物、Wiki Markdown、DB Edge Rows、檢索結果**（可用 Mock LLM，但須標註），不得只有流程圖。
- `docs/GRAPH_MEMORY_V2_PART_1_REPORT.md` 與 `docs/GRAPH_MEMORY_V2_PART_2_REPORT.md`，每份附尚未解決問題與回歸風險。
- 以獨立 commits/PR 保留審查點；不得自行執行生產 Cloud SQL migration 或正式部署。

## 7. 完成定義

**Part 1 Done：** Source → Parser → Subject Registry / grouped Wiki → Fact Edge + Event + Evidence → Atomic Published Storage，通過 Fixture A–D、去重、撤銷、併發、回滾、local+PostgreSQL 測試。

**Part 2 Done：** 依同一 Subject 找到 Wiki Profile 與相關 Edge；current 對同一可變狀態選最新可信版本，history 保留所有獨立事件；所有 GraphHits ACL、來源、時間及字節限制正確；前端可展示共用 Wiki Node 的子 Subject、Edge 及歷史；不破壞既有 Runtime 與部署路徑。

**最重要的技術約束：** Subject 身分與 Wiki Page 是兩層 ID、Edge 是獨立且有證據的歷史事實、最新狀態的選擇是檢索 View 而非刪除資料、Raw Source 撤銷必須傳遞到所有受影響的 Wiki 和 Edge。
