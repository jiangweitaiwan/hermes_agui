# GraphMemory × LLM Wiki Implementation Plan

適用專案：`jiangweitaiwan/hermes_agui`｜執行者：Codex｜分三次獨立實作



**本次只執行 Part 2。** 先讀取並驗證 Part 1 的完成報告，不重做前階段。

## Part 2 — External Document Ingest & LLM Wiki Compiler

### 目標

將 Markdown/text 外部文件編譯成具 provenance 的 Wiki pages，支援增量更新、衝突保留、工作佇列。PDF/HTML 解析先列後續選配，不擴大 MVP。

### 實作順序

1. 擴展 source schema 及 bridge（見共同契約），提供 server-owned DocumentIngestor；新增已驗證身份的上傳或管理 CLI/API，scope 從 server 決定，限制 MIME/大小，區分 source ID、內容 hash、版本與 ingest idempotency key。不得讓任意上傳控制路徑。
2. SQLite durable queue：pending/running/completed/failed/cancelled，transaction enqueue、唯一 key、lease + heartbeat、重啟續跑、有限次 backoff retry、dead-letter/人工重試；同一 source 重送不得重複發表。`write()` 若已可支援 session entry，僅 durable enqueue 後回 accepted（不是已編譯）；未達持久化不可回 accepted。外部文件走專用 API，不套用假 session。
3. WikiCompiler：獨立 OpenAI-compatible LLM adapter，支援 OpenRouter base URL、model、secret env、timeout/token budget；注入 mock。Analysis：從 raw source 取 entities/concepts/decision/finding/procedure 等、有證據的主張及衝突；Generation：根據允許範圍的現有頁面生成結構化 upsert proposals；Merge：保留時間、來源和衝突、避免覆蓋已驗證資訊；無價值內容可 no-op。大型文件先分段與 digest。嚴格 schema 驗證 JSON、頁數/字數限制；LLM 不得直接操作 filesystem、決定 ACL 或執行命令。對 prompt injection 視所有原始來源和既有 Wiki 為不可信資料。
4. Wiki schema：entity、concept、decision、finding、procedure、preference、task、source。頁面包含 stable ID、title、type、tags、related、source references、revision、verification state；事實與推測區分。`index.md` / `log.md` 若提供由程式決定性生成，不交給 LLM 全量重寫。每次取回候選既有頁做增量 merge，而不是整庫進 prompt。
5. 發布使用共同架構的 revision protocol；編譯失敗不影響現有查詢；可查 job status、重試與 source deletion/rebuild（撤銷來源必須使衍生知識停止被檢索，必要時重新編譯）。來源內容、secret 不寫入 debug log。

### 驗收

- 匯入文件 A 生成 source + entity/concept，B 更新同一 entity 並建立 link；矛盾文件 C 保留來源與衝突；重複 A 不新增 revision；Agent 可引用文件來源。
- Mock LLM malformed/schema-invalid output、path traversal、prompt injection、timeout、取消、worker crash、lease 重取、重複 enqueue、併發 merge、磁碟失敗；不得暴露 half-published 版本。
- 文件來源的 MemoryContext/bridge 相容測試；不同 ACL scope 的 compiler/retrieval/deletion 測試；真實 API 測試可選且不預設執行。
- 報告：`docs/graph-memory-part-2.md`。完成後停止。

## 最終 Definition of Done

從乾淨 checkout 可依文件安裝、配置、啟動 runtime 與 Hermes；graph feature 關閉仍可正常運作；啟用後可手動匯入文件、觀察編譯、檢索及自動 session 學習。所有持久化、權限、失敗降級、回歸測試可重現；不依賴實際 API key 的 CI 測試覆蓋完整核心路徑。README 補充資料目錄備份/恢復、migration、模型選擇及刪除/撤銷機制。將各 Part 的未完成事項如實記錄，不以示意程式碼代替實作。

## 設計假設與待確認事項

本計畫依前次 GitHub 原始碼評估撰寫，未重新 checkout 或執行測試。Markdown + SQLite、TypeScript、private-by-default、分三階段及初始搜尋參數是設計決策；具體 driver、版本、現有測試命令與 API route 需由 Codex 核對。使用者已同意總體方案；若需改動既有 bridge 信任模型、引入額外服務、改變 ACL 或破壞相容性，先提出差異並等待確認。
