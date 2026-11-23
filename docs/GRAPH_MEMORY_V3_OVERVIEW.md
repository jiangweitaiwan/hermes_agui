# Graph Memory V3 — 架構總綱與 Codex 執行順序

> 本文件與 `GRAPH_MEMORY_V3_PART_1.md`、`GRAPH_MEMORY_V3_PART_2.md` 為一組可交由 Codex 執行的工程規格。**先 Part 1、驗收並提交；再 Part 2。** 不要一輪實作兩階段。

## 0. 任務基準

- Repository：`https://github.com/jiangweitaiwan/hermes_agui.git`
- 基準分支：`codex/graph-memory-v2`
- 精確基準 commit：`476004ac214573a8e7f4be6fed087cefb374ee07`
- 既有進度報告：`docs/GRAPH_MEMORY_V2_PART_1_REPORT.md`、`docs/GRAPH_MEMORY_V2_PART_2_REPORT.md`
- 原有 V2 驗收素材：`artifacts/graph-memory-v2-part-2/`，特別是 `retrieval-a.json`、`retrieval-c.json`、`featurehub.md`
- 對於執行時 HEAD、工作區未提交修改、環境限制，先盤點並保留；**不要重設或覆蓋使用者的工作**。若分支已前進，記錄差異並以實際工作區為準，遇實質衝突先回報。
- 工作以程式碼、測試、文件為範圍：**不得自動部署 GCP、變更正式 Cloud SQL／GCS、使用正式憑證或呼叫付費模型進行驗收**。

## 1. 目標與非目標

目標：將 V2 的 `raw query -> mixed Wiki/Fact GraphHits -> bounded Context` 升級成：

```text
User Message
  -> Query LLM Parser
       -> QuerySubjects  -> Subject Matcher -> Authorized Wiki Section Retrieval
       -> QueryNarratives -> Semantic/Lexical Edge Retrieval
                            + Typed Temporal Constraints -> Temporal View
  -> Memory Net Builder (seed -> expand -> prune, authorized Evidence)
  -> LLM Storyteller (evidence-grounded and schema-validated)
  -> Runtime MemoryContext v2 (bounded, signed envelope)
  -> AG-UI Hermes Agent (existing reference-memory fencing)
```

**語意匹配以 Narrative Description 與事件時間文字為主，不以固定 Relation Enum 為主要檢索 Key。** Relation 保留圖結構、方向性、粗分類、State Slot／Event 擴展用途。

非目標：替換 Hermes 原生 Agent Loop、改變 AG-UI 協定、重寫 Graph V2 存入儲存系統、跨頁無審核 Subject 合併、真正的事實真偽推理、將 Storyteller 摘要回寫為權威證據、開發完整雙時間（bi-temporal）資料庫、正式雲端部署。V3 是**讀取／組裝路徑升級 + 小幅向後相容的寫入欄位加強**，不是新一套長期記憶儲存庫。

## 2. 已核對的 V2 主要實作（Codex 開始前須重讀）

- `examples/copilotkit/server/graph/parser.ts`：Ingest Parser、source quote/UTF-16 span 驗證。
- `examples/copilotkit/server/graph/compiler-v2.ts`：Parser、Matcher、Relation、Wiki 編譯。
- `examples/copilotkit/server/graph/temporal-resolver.ts`：目前有限的相對時間解析。
- `examples/copilotkit/server/graph/relation-abstractor.ts`：方向關係／有效時間／state slot。
- `examples/copilotkit/server/graph/v2-types.ts`：Fact Edge、Relation Enum、Time Schema、Evidence。
- `examples/copilotkit/server/graph/edge-embedding.ts`：目前已有 Description + Relation + Subject IDs + 時間的 JSON Embedding；改造重點是**Query Narrative 分流**與可靠的時間約束，而非聲稱 V2 沒有時間向量。
- `examples/copilotkit/server/graph/subject-retriever.ts`、`edge-retriever.ts`、`temporal-view.ts`、`v2-retrieval-store.ts`、`retriever.ts`、`provider.ts`：現有檢索及授權讀取。
- `examples/copilotkit/server/graph-memory.ts`：後端受信 Graph Scope、GraphMemoryPort、GraphHit 合約。
- `examples/copilotkit/server/memory/{retriever,runtime-memory-manager,assembler,middleware,pipeline,types}.ts`：Run 記憶查詢、組裝、簽章；`server/application.ts`、`server/bootstrap.ts` 負責串接。
- `hermes_agui/runtime_memory.py`：解碼、HMAC、Bot/Thread/Run 身分、時效和內容驗證。

## 3. 不可違反的安全／相容性約束

1. **Graph V1/V2 保留**。新增後端 `retrievalMode: "v2" | "v3"` 類型設定，預設 `v2`，僅在受信配置且 V2 namespace 已啟用時開 V3；**不強迫把現有 `graphCompilerVersion: "v2"` 改為 `v3`**。
2. 保留 GraphMemoryPort、GraphQuery、GraphHit、AG-UI 及 Hermes 原本 API。若需要 typed Net 新服務，應由已完成 scope/ACL 驗證的受信 Runtime adapter 暴露，**不能直接讓瀏覽器提供 namespace、subjectId、evidence 或 MemoryNet**；不能直接繞過 `createGraphMemory` 的授權邊界。
3. 每個 Source 的 Bot、Principal、Project、Visibility、revocation、版本與來源有效性均須經現有 `V2RetrievalStore.read` / `WikiStore.validateRead` 等已授權路徑核對。**在任何外部 LLM await 後、送入簽章 envelope 前重新驗證**。一旦失權或撤銷，不能保留舊 Storyteller 內容。
4. 私有來源不跨 Bot；project_shared 僅依既有授權。對多來源 Story 分開管理 visibility/provenance，**不得把 private 與 shared 混在一筆 Story Record，或用單一假來源代表多份證據**。
5. 保留原生 Hermes Memory 驗證與 `<memory-context>` 類型防指令注入隔離。Story 是低信任的**參考資料**，不得取代 system instructions、授權資料或引用的原文。對「忽略系統指令」等來源注入保持資料處理。
6. Memory Context 簽章形狀維持 version 1/2 之一，**優先用現有 v2 records**；目前 `ContextAssembler` 預設 `tokenBudget=4096`（實為 JSON UTF-8 bytes）、max 20 records；Hermes 端限制總 context JSON 8,192 bytes、每 Record 16,384 字元級大小檢查、envelope payload 16,000 base64url chars、簽章有效期 60 秒。不要只檢查 Story 正文長度而漏掉 metadata/base64 膨脹。
7. `recordedAt` 是入庫時間，不能當事件有效時間；`occurredFrom/To`、`observedAt`、`originalTimeText`、`confidence` 各司其職。Embedding 可召回，但不可當作精確的 date ordering 或 truth judgment。
8. SQLite / PostgreSQL 同時支援；若新增 SQL migration，沿既有順序新增，不改動 001–010 歷史 migration；須含重跑／權限／回填／rollback-friendly 步驟。本次優先利用 V2 已有 JSON Edge 與 embedding 索引，不為了 Query Parser 新增無用的事實資料表。
9. 有界查詢、abort、期限、最大候選／Evidence／Net 大小、No unbounded scan；維持 V2 fail-closed／fallback 語意，與工作者持久化分離。`Graph Browser` 保留 V2 查詢相容性。
10. LLM 全部可注入 Mock Adapter。Unit/E2E 用 deterministic fixtures 驗證；真實模型測試僅作可選的手動 smoke，不宣稱已完成。

## 4. 兩階段交付物

| 階段 | 必要產出 | 驗收 Gate |
|---|---|---|
| Part 1 | 共用時間語意契約、Query Parser、分流 Subject/Narrative Retriever、Embedding V3、Memory Net Builder、Relation 補強、SQLite/PG 對等測試 | `query -> authorized MemoryNet` 可輸出且不誤連事件；V1/V2 regression 全綠 |
| Part 2 | Storyteller、Story Grounding Validator、Context Budget、Runtime signed injection、timeout/fallback、multi-Bot／撤銷 E2E、總結報告 | `query -> signed reference context -> Hermes` 可由 Mock 完整追蹤；已有 V2 報告測試不回歸 |

## 5. Codex 執行規則

每一階段：

1. 先 read plan + 實際原始碼／測試；提交簡短 design notes，遇計畫與實碼不同先解決差異。
2. 測試先行或最小 vertical slice 後逐步擴增；沿既有 package manager、版本、Vitest／Python／PostgreSQL 測試模式；**不要降低舊 assertion、擴大 timeout 來掩飾失敗，或默默 skip**。
3. 本階段完成前執行要求的 targeted/full suite、Build、lint/check。環境造成的未完成項目須標示 `not run` 與原因，不得寫 passed。
4. 交付變更清單、關鍵流程圖、測試產物、已知限制、效能與安全結果、commit SHA；報告寫入 `docs/GRAPH_MEMORY_V3_PART_{1|2}_REPORT.md`。
5. 不進入下一個階段、不部署正式環境。等待使用者逐階段驗收後再執行下一個 Part。

**開始 Part 1 指令：**「請閱讀 `docs/GRAPH_MEMORY_V3_OVERVIEW.md` 及 `docs/GRAPH_MEMORY_V3_PART_1.md`，以指定 commit 為基礎執行 Part 1，產出報告並在 Part 1 驗收門檻完成後停止。」

**開始 Part 2 指令：**「請先閱讀 `docs/GRAPH_MEMORY_V3_OVERVIEW.md`、`docs/GRAPH_MEMORY_V3_PART_2.md` 與已完成 `docs/GRAPH_MEMORY_V3_PART_1_REPORT.md`，以通過 Part 1 的實際 HEAD 為基準執行 Part 2。不得重做 Part 1 或默認未驗收。」
