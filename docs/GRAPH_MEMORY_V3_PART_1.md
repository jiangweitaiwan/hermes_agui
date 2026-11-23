# GRAPH_MEMORY_V3_PART_1 — Query Parser、雙管線 Retriever、時間語意與 Memory Net

> 先讀 `GRAPH_MEMORY_V3_OVERVIEW.md`。本 Part 只完成 `Message -> QueryPlan -> Wiki/Edge -> MemoryNet`；**不接 Storyteller、不改 AG-UI 注入契約**。驗收通過後停止。不可部署正式 GCP。

## A. 執行前盤點

1. 確認分支／HEAD／未提交變更、現有 V2 Runtime Parser、Edge embedding、時間資料格式、SQLite+PG Schema（001–010）、授權讀取、`GraphMemoryPort` 與既有回歸測試。
2. 先跑 V2 targeted baseline（或記錄不可執行理由）；保留 `artifacts/graph-memory-v2-part-2/{retrieval-a,retrieval-c}.json` 作語意對照。
3. 在既有 modules 下新增內部服務，不改 Python Hermes、AG-UI、Graph Browser API 或 cloud deployment config 的對外合約。
4. 將 `graphCompilerVersion`（控制寫入 V1/V2）與 `retrievalMode`（控制讀取 V2/V3）獨立；新增 setting 必須 schema 驗證、server-owned、default V2；Codex 須沿 `server/bootstrap.ts` 和實際 registry config 的設定結構接線，不可硬塞未驗證環境變數。

## B. 目標資料模型（示意契約，具體 naming 以既有 TypeScript/Zod 習慣為準）

```ts
interface QuerySubject {
  ref: string; name: string; type?: SubjectType; aliases?: string[];
  // query 不是來源事實，不可由使用者文本決定永久 subjectId / namespace
}
interface QueryTime {
  kind: 'unspecified'|'exact'|'range'|'as_of'|'before_event'|'after_event'|'previous_event'|'current'|'history'|'unknown';
  originalText?: string; from?: string; to?: string;
  anchorRef?: string; timezone?: string; confidence?: 'certain'|'uncertain';
}
interface QueryNarrative {
  ref: string; text: string; subjectRefs: string[];
  intent: 'find_event'|'find_state'|'explain_cause'|'describe_history'|'general';
  time: QueryTime;
}
interface MemoryQueryPlan {
  subjects: QuerySubject[]; narratives: QueryNarrative[];
  temporal: QueryTime; // 可為 unspecified
}
interface MemoryNet {
  query: MemoryQueryPlan;
  subjects: Array<{ subjectId:string; wikiPageId:string; sectionKey:string; visibility:string }>;
  wikiSections: Array<{ pageId:string; sectionKey:string; revision:string; text:string; evidenceRefs:string[]; visibility:string }>;
  edges: Array<{ edgeId:string; eventId?:string; description:string; fromSubjectId:string; toSubjectId:string;
    time:unknown; view:string; evidenceRefs:string[]; visibility:string; seedScore:number }>;
  events: Array<{ eventId:string; edgeIds:string[] }>;
  // 每份 claim / section/edge 的 evidence 及 provenance 皆有 typed 參照；不得複製跨 scope 未授權資料
  provenance: unknown[];
  partial: boolean; warnings: string[];
}
```

此介面是**內部型別設計樣板**，非公開 AG-UI payload。可作必要修正，但必須保留 Subject/Narrative 分流、QueryTime 的未知狀態、可追蹤的 evidenceRefs、帶 scope 的 Wiki/Edge、部分結果標示及有界大小。每個 ID 必須透過已授權儲存層取得，LLM 不可生成持久 ID 或 ACL。

## C. 工作包 1 — Parser 共用核心、Query mode 明確分流

**建議調整**：`server/graph/parser.ts`、新增 `server/graph/query-parser.ts`、`server/graph/query-types.ts`（名稱可按現有慣例調整）。

1. 從現有 Ingest Parser 提取共用的 Subject、Narrative、Time Expression Zod primitives / prompt helpers；**不要直接用 Ingest strict ParsedSchema 解析問題**。Ingest 是有 Evidence quote/span 的陳述；Query 是意圖抽取，不允許把疑問句當已發生事實。
2. Query Parser 使用可注入 `CompilerLLM` 風格的受限 JSON adapter，具有明確的模型設定、總 byte/array budget、abort、timeout；對 `subjects=[]`、`narratives=[]` 各自合法；禁止捏造 subjectId、時刻或不存在的 actor。
3. Query output：`subjects[]`（名稱、可選 type、短 alias）；`narratives[]`（檢索自然語言事件、涉及 query-subject refs、query intent、Time Expression）；頂層 temporal intent。允許有多個 Narrative，且不要將 Query 中疑問詞全寫進 embedding。
4. Query Parser 異常、無效 JSON、不能解析時間時採**安全回退**（Part 1 先有可測的 fallback plan；Part 2 串 V2）。沒有可信時間就 `unknown/unspecified`，不可偷用 ingestion clock 或目前 DB recordedAt。
5. Ingest Parser 新增**向後相容**的 optional `timeExpression`，保留 `timeText`、`anchorRef`、UTF-16 evidence 驗證和既有 Fixture；LLM 可輸出 date/date-range/relative，但正規化由 deterministic resolver 完成；不得把 LLM 日期當作未經驗證的真實 UTC 時刻。

**測試**：普通 Subject + Narrative、純 Subject、純事件、兩個 Narrative、無 Subject、「上次」「事故之前」「上週三」、未明年份、惡意 prompt injection、違法 refs、LLM 憑空補人物、輸出截斷、超時／abort。

## D. 工作包 2 — 結構化時間語意

**建議調整**：`server/graph/temporal-resolver.ts`、`temporal-view.ts`；新增 `query-temporal-resolver.ts` 或共用 `time-expression.ts`。

1. 現有 FactEdge 的 `time` (`occurredFrom/To`, `originalTimeText`, `timezone`, `confidence`) 為權威；`recordedAt` 與 `observedAt` 不能取代事件有效時間。
2. 把「LLM 解析出的時間語句」轉成可驗證的 `exact/range/as_of/before_event/after_event/previous_event/current/history/unknown` 條件。對 `11/4`、`11/1 至 11/10`、`截至 11/6`、`上週三`、`回滾之前`，使用可信 query-time anchor、timezone、已匹配 Event 的有效時間，分步解算。若前置 Event 不明，就保留 unresolved/uncertain，不把日期猜成 today。
3. `exact/range/as_of` 使用資料庫有界候選 + structural time validation/filter/rerank；對 current/state slot 仍使用現有 Temporal View；未知／重疊／disputed 事實不能宣稱客觀 latest。
4. 設計 **two-pass** anchor retrieval：先找帶有「Bob 回滾」語意的 Event，再解析「回滾之前」並檢索對應 State。避免先查不到日期就丟棄 Event。對「上次」應以相關且可比較的 Event 有效時間排序，未知時間不做確切排序。
5. 小心日期區間端點、日曆日與 UTC timestamp 的差異，保留時區，測試 Asia/Taipei 及跨年／跨月。

**測試期待**：Fixture C 的 current=v2、history=v1→v2、as-of 2026-11-06=v1；同時間與重疊日期標 uncertain；獨立 rollback event 不會因新版狀態被隱藏；unknown anchor 不自動套 current。

## E. 工作包 3 — Subject / Narrative 分流檢索

**建議調整**：`subject-retriever.ts`、`edge-retriever.ts`、`v2-retrieval-store.ts`、`retriever.ts`、`provider.ts`；新增 `structured-retriever.ts`。保留 V2 query 行為可回退。

1. **Subject Pipeline**：QuerySubjects -> namespace-scoped identity/alias candidates -> disambiguation（如需）-> verified subject IDs -> 所屬 Wiki Page + **相關 Sections**。Subject 只做身分／Wiki 檢索，不拿整段 message 當作 Subject Match。命中同一 Wiki 的父／子 Subject 不重複載入整頁。
2. **Narrative Pipeline**：每個 QueryNarrative.text（加上有意義的 QueryTime 文字）單獨做 Lexical + Vector candidate retrieval + RRF，必要時與匹配 subject IDs soft-boost，不可硬性取交集造成純 Narrative Query 漏召回。**Relation Enum 不是主要 semantic match 欄位**。
3. 先採用 V2 已授權的 store、evidence join 和 source validity；不得使用新的裸 SQL 直接回傳沒有 ACL 驗證的 Edge／Wiki。多 namespace 只查受信 Bot 授權的 `bot_private` 與 `project_shared`。
4. 選定 Seed Edges 後按同一 eventId、stateSlotKey、subject relation **有界擴展**；必須區分 seed 與 supporting，避免 Event 裡 30+ 決策全部佔滿 Top-K。候選算分、event support score、時間匹配得分應可解釋／測試。
5. 先於內部開一條**typed structured read interface**，由既有 GraphScope/ACL gate 包裹並保留 GraphMemoryPort V2 `query(text,limit)` 不變；新增 service 不得直接被 HTTP/browser 呼叫，禁止不經過 `createGraphMemory`/等效授權 guard 私下繞路。
6. 嚴格限制：Query 文字 bytes、Subject/Narrative 個數、每個 Namespace seeds/expansions、Wiki sections、Evidence、Net bytes。延用現有 V2 64 subject/128 sibling/96 evidence/256 runtime expansion 等保守預算；不可無限制 DB Scan。

## F. 工作包 4 — Memory Net Builder

**新增** `server/graph/memory-net.ts`、`net-builder.ts`（具體依專案慣例）。

1. Input：已授權 subject candidates、wiki sections、edge seeds、related edge candidates、query temporal constraints。
2. `seed -> expand -> prune`：先選與 Narrative/Subject 直接相關的 Seed，沿 eventId/stateSlotKey/subject 取 supporting edges，再依 query intent 和 context relevance 保留必要 Wiki section（如「支援回滾」），不要無條件注入 `# Bob`、`- Bob`、所有 TTL 及不相關人物史。
3. Net 必須有**事件群組隔離**：同名 Subject 參與多次獨立事故，不能只因 subject 相同就將不同 Event 說成同一次事故。可以做關聯 context，但須標註 event boundaries。
4. Net 以 `edgeId/eventId/subjectId/wikiPageId/sectionKey/semanticHash` 和 evidenceRefs 關聯，附 query seeds、relation/direction、有效時間、certainty、attribution、source provenance、visibility/namespace、confidence、partial/truncated 原因。
5. **合法 Net** 必須能在 source revoke / Bot disable / project rebind 下重新驗證；應提供 `validateNet(scope, net)` 並能在下一階段外部 LLM call 後使用。驗證發現任何來源失效則刪除相關 claim，必要時重建 Net；絕不把撤銷事實送到 Storyteller。
6. 支援空 Net、純 Wiki、純 Edge、混合 Net；不允許 fabricated evidenceRefs、跨 ACL 擴展或把 unauthorized source 混入 provenance。

## G. 工作包 5 — Edge Embedding V3 與 Relation 語意分離

**建議調整**：`edge-embedding.ts`、`relation-abstractor.ts`、`v2-types.ts`，CLI/Index worker 視需要調整。

1. 改用**版本化、可讀、固定模板**產生向量文字：`description + relevant subject names + occurred date / time range + original time expression`。不要只 embedding opaque Subject ID；`recordedAt` 不作為 event semantics。保留 Relation Label 作可選背景，不作為主要 match key。
2. Query Embedding 和 Edge Embedding 必須採相同的時間表達規則（例如 `2026-11-04`、時間區間與 timezone），另以 structured time matching 校正；**不能指望 cosine score 能精確比較日期先後**。
3. 新 Template 有獨立 index version/key/content hash，不讓 V2 vector 混入。沿現有 `graph_edge_embeddings`、`EdgeVectorIndex`/CLI reindex 及 bounded batches 完成回填；須測試中斷恢復、Index partial fallback 到 lexical、model/version mismatch、撤銷後不再命中。不要無預警刪掉正式 V2 vectors。
4. Relation 模型改為**backward-compatible**：保留現有 `relation` legacy 值及 V2 JSON/storage 可讀性；新增 optional `relationType`（有限結構分類）與 `relationLabel`（受限長度的語意標籤，如 `maintains`、`rolled_back`），可擴充的 label 不作為 hard-coded Retriever 匹配鍵。未能映射既有 Enum 的新寫入可用 legacy `related_to`，但 semantic hash 必須包含新 label/type，避免所有 `related_to` 產生語意混淆；既有 Edge ID/hash 不回寫變動。
5. 事件／狀態分離仍由 `factKind`/`stateSlotKey` 控制；**不能因 relationLabel 自由化，讓互不相干的 rollback events 互相覆蓋**。新增 Ingest Relation Output 一樣須有 narrativeRef、fromRef、toRef 的引文支持，嚴禁虛構 Actor。
6. 若採資料庫新增欄位，新增 011 migration + local schema/update grants + tests；若純擴充既有 JSON 載荷可以免 migration，需於報告明確寫明理由與 rolling upgrade 的相容性。

## H. 必須通過的場景測試

| Case | Query / Source | 預期 |
|---|---|---|
| A | `Bob 如何處理搜尋推薦服務延遲？`，Fixture A | 同事故 5 條 Edge 可追溯、至少 1 關鍵 Wiki Section（如回滾能力，如有授權）、不虛構 Bob→Alice 代寫 |
| B | 先匯入 FeatureHub 穩定屬性，再匯入事故 | 7 Subject / 6 Wiki Page 關係維持；快取與父系統同 Wiki，不複製無關 Sections |
| C | 2026-11-05 v1、11-12 v2 | current=v2；as_of 11-06=v1；history 兩筆；不刪原事實 |
| D | query only Subject / query only Narrative | 兩種合法並各有有用 Net；subject missing 不硬性阻止 narrative recall |
| E | 回滾前／上次（相對 Event） | 有可信 anchor 才能排先後；未知時間 uncertain，不猜日期 |
| F | Bob 在相隔 10 天的兩次事故 | 不融合不同 Event 為單一事故；能清楚分組 |
| G | 新 Relation `maintains` / `responsible_for` | 在無新固定 enum 成員下仍可記錄自訂 label，保留方向及 source evidence |
| H | Source revoke、Bot disabled、cross owner | 任何候選與 Net 不洩漏，重驗證後 invalid claims 消失 |
| I | Embedding 失敗、未回填、版本 mismatch | lexical fallback，不把舊版本向量當 V3 |
| J | 不合法 LLM JSON、timeout、quote 虛構 | 不進 DB、不編出 resolved time/subject，並產生可供 Part 2 回退的 status |

## I. 交付成果與驗收 Gate

1. 新增實際測試檔（依現有命名如 `tests/graph-v3-query.test.ts`、`graph-v3-net.test.ts`、`graph-v3-postgres.test.ts`）及 deterministic Mock LLM fixture；不要只手寫 JSON 範例。
2. Test 產物存 `artifacts/graph-memory-v3-part-1/`：`query-a.json`、`net-a.json`、`temporal-c.json`、`relation-new.json`、`vector-index-compat.json`、verification 日誌；標 `mockLLM: true`，內容須由真實 Parser Contract/Store/Publisher/Net 程式運行產生。
3. 依序執行 targeted V3 Test、既有 V2 Retrieval／PG／GraphBrowser、完整 CopilotKit Suite（單 worker）、Build、型別檢查、`scripts/check`（按既有慣例使用相容 Python）。有 PostgreSQL 測試時使用隔離 DB，驗證 migration apply/replay。保留現有已知基準 lint 問題，不默默修任務外檔案。
4. 報告包含：邏輯路徑、型別／資料庫相容策略、V2→V3 retrieval 對照（seed recall、Net precision、evidence 召回）、新增索引版本與回填、ACL 驗證、實際測試摘要、限制與不執行事項。
5. Gate 必須實際驗收：**可從 QueryPlan 得到可驗證 MemoryNet**，Edge/Subject 分流有效，時間語意保留，跨 namespace／Bot 隔離，舊 V1/V2 測試不退化。未接 Storyteller 不是 Part 1 失敗；**不得提前進入 Part 2**。

**停止條件**：Part 1 驗收完成、紀錄 `docs/GRAPH_MEMORY_V3_PART_1_REPORT.md`、提交程式碼與測試產物；不部署、不變更 Python memory envelope、不接入正式 LLM。
