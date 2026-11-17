# GraphMemory × LLM Wiki Implementation Plan

適用專案：`jiangweitaiwan/hermes_agui`｜執行者：Codex｜分三次獨立實作

## 0. 任務與執行規則

在 CopilotKit Runtime 建立 headless Wiki Engine，將外部文件及 Agent 工作成果編譯為可持續更新的 Markdown 知識網路，於 AG-UI Run 前檢索並透過既有 Memory Bridge 注入。保留 Hermes 原生 session SQLite、memory、skills 與 agent loop。不引入另一個 agent harness，不依賴 Tauri、Neo4j 或 llm_wiki 桌面程式。不直接複製 GPL 原始碼；僅參考設計。

每次只執行指定 Part。開始前讀取 `AGENTS.md`（若存在）、`IMPLEMENTATION_PLAN.md`、`docs/runtime-memory-part-1.md`、`docs/runtime-memory-bot-manager-part-2.md`，確認 git status、當前 branch/commit、依賴及測試指令。以當前 checkout 為準，若與本計畫不同，先記錄差異，不任意重構。不得覆蓋未提交的使用者修改。每階段先跑既有測試取得 baseline，再做新增測試與回歸測試；未通過不得宣稱完成。不要自動 push。每階段產出獨立報告，列出檔案、測試指令及結果、已知限制、配置和下一階段銜接；完成後停止，等待下一次指令。

參考：

- https://github.com/jiangweitaiwan/hermes_agui
- https://github.com/nashsu/llm_wiki/blob/main/src/lib/ingest.ts
- https://github.com/nashsu/llm_wiki/blob/main/src/lib/wiki-graph.ts
- https://github.com/nashsu/llm_wiki/blob/main/src/lib/graph-relevance.ts
- https://github.com/nashsu/llm_wiki/blob/main/src-tauri/src/api_server.rs

## 1. 共同架構與不可破壞的契約

```text
Frontend → CopilotKit Runtime → prepareRunInput()
  → RuntimeMemoryMiddleware → RuntimeMemoryManager
  → MemoryRetriever → GraphMemoryPort.query()
  → WikiGraphProvider → WikiRetriever → scoped SQLite indexes + Markdown
  → ContextAssembler → signed forwardedProps.runtimeMemory → AG-UI Agent

External document / successful run → durable IngestQueue
  → WikiCompiler (analysis → generation → merge)
  → validated revision → atomic publication → searchable graph
```

現況依前次原始碼評估，需在 checkout 再驗證：`examples/copilotkit/server/graph-memory.ts` 定義 GraphScope、GraphEntry、GraphHit、query/write；預設 timeout 2000ms；query 最多 50 hits、每筆 content 最大 16384 bytes。`memory/assembler.ts` 預設 4096 bytes（非 tokenizer 計算的 tokens）、最多 20 筆；`memory/pipeline.ts` 使用最後一筆 user text，一般 Run 與 Delegation 共用；resume 目前跳過注入。`memory/middleware.ts` HMAC 簽署 runtimeMemory。Hermes 目前注入本輪 user message 的傳送副本，不修改原生 system prompt，不寫回 session history。維持此行為，不將記憶提升為高信任指令。非 Hermes Agent 必須實作對應驗簽與 context bridge 才能使用。

`application.ts` 目前自訂 graph options 可能取代預設 authorize；重構為不可繞過的基礎授權，再與可選額外政策取 AND。`index.ts` 負責 production provider wiring、啟停與配置。Graph disabled 時維持原行為；unavailable 時 fail soft；unauthorized 時 fail closed。不要從前端 forwardedProps 或 LLM 文字建立權限。

### 1.1 建議目錄

```text
examples/copilotkit/server/graph/
  provider.ts         wiki-store.ts       repository.ts
  graph-index.ts      retriever.ts        types.ts
  compiler.ts         ingest-queue.ts     document-ingestor.ts
  session-ingestor.ts run-observer.ts     embedding.ts
  prompts/analysis.md generation.md merge.md
```

可依現有慣例調整名稱，避免空殼及不必要依賴。Node/TypeScript 優先，沿用現有 SQLite driver；檢查 FTS5 是否可用。測試不得依賴真實付費 API。

### 1.2 儲存、權限與一致性

每個 namespace 由 server 驗證的 principal + projectId + visibility +（private 時 botId）構成。路徑使用安全編碼或 opaque ID，不直接拼接使用者輸入。Shared 與 private 分離；任何查詢、graph expansion、compiler context、merge、embedding、管理 API 必須在授權範圍內執行。私人編譯可讀授權共享內容，但不得反向寫入共享頁；共享編譯不得讀 private。禁止 symlink/path traversal。預設 session private；共享需要明確授權，不由 LLM 決定。

Markdown 是知識內容主儲存，SQLite 管理 namespace、source、revision、active pointer、edges、FTS 和 jobs。原始 source 不覆寫；revision 使用 immutable 檔案，先寫入並驗證（原子 rename），再以單一 SQLite transaction 發布 active revision、更新 graph/FTS、job 狀態。讀者僅讀已發布版本；崩潰後清理未引用檔案並可重建索引。不要聲稱 filesystem + SQLite 天然具跨資源原子性。每 namespace commit 序列化並檢查 revision CAS 防止 lost update；索引可從已提交 manifest 與 Markdown 重建。

建議 schema：namespace、sources（kind/hash/locator/visibility/status）、pages（stable ID/slug/type）、revisions（page ID/version/path/hash）、page_sources、edges（from/to/type）、FTS sections、ingest_jobs（idempotency key/state/attempt/lease/error）。外部來源用 discriminated union `session | document`，保留 session bot/thread/run ID；不可捏造外部文件的 run ID。GraphHit 與 MemoryContext 如需 v2，採 additive/versioned contract、舊版相容及 Hermes bridge 測試；Part 1 在仍使用 v1 時只注入具有真實 session provenance 的 fixtures。Part 2 引入 document provenance；若需舊版降級，明確標示來源並採經驗證的相容策略，不能以假 ID 欺騙現行驗證。合併頁應保留多來源；v1 單一 source 不足時不得丟失 ACL 語意。

## Part 1 — WikiGraphProvider & Retrieval

### 完整步驟，請看GRAPH_MEMORY_PART_1

## Part 2 — External Document Ingest & LLM Wiki Compiler

### 完整步驟，請看GRAPH_MEMORY_PART_2

## Part 3 — Automatic Memory Evolution & Hybrid Retrieval

### 完整步驟，請看GRAPH_MEMORY_PART_3

## 最終 Definition of Done

從乾淨 checkout 可依文件安裝、配置、啟動 runtime 與 Hermes；graph feature 關閉仍可正常運作；啟用後可手動匯入文件、觀察編譯、檢索及自動 session 學習。所有持久化、權限、失敗降級、回歸測試可重現；不依賴實際 API key 的 CI 測試覆蓋完整核心路徑。README 補充資料目錄備份/恢復、migration、模型選擇及刪除/撤銷機制。將各 Part 的未完成事項如實記錄，不以示意程式碼代替實作。

## 設計假設與待確認事項

本計畫依前次 GitHub 原始碼評估撰寫，未重新 checkout 或執行測試。Markdown + SQLite、TypeScript、private-by-default、分三階段及初始搜尋參數是設計決策；具體 driver、版本、現有測試命令與 API route 需由 Codex 核對。使用者已同意總體方案；若需改動既有 bridge 信任模型、引入額外服務、改變 ACL 或破壞相容性，先提出差異並等待確認。
