# GraphMemory × LLM Wiki Implementation Plan

適用專案：`jiangweitaiwan/hermes_agui`｜執行者：Codex｜分三次獨立實作



**本次只執行 Part 1。** 先確認 baseline。

## Part 1 — WikiGraphProvider & Retrieval

### 目標

接上真實 provider，支援手動匯入已編譯 Wiki、全文搜尋、Graph 一階擴展、跨 session 檢索及既有 runtime 注入。不做 LLM compiler、session 自動寫入或 embedding。

### 實作順序

1. 建立 graph repository、migration、WikiStore、設定與 shutdown；新增 feature flag（預設關閉），data root、query timeout、namespace limits。設計 manifest 及 fixture import CLI（僅可信本地管理員，必須指定 namespace 與真實 session source）。
2. Markdown frontmatter 使用安全 YAML parser/schema validation：id/title/type/sources/tags/related/created/updated；解析正文 wikilinks、`related`，處理 alias、重複 slug、broken link、cycle、跨 namespace link。建立 FTS section index 和 edges，允許同名不同 scope；避免全文掃描每次請求。繁中搜尋須有 CJK bigram 或等價 tokenizer，加入中文測試。
3. WikiRetriever：先在 ACL scope 內找 keyword seeds（建議 8），再 expansion 一階（每 seed 最多 3）；去重、排序，抑制 hub、弱相關節點（無有效命中就回空），以段落而非整頁返回。使用明確可測的 relevance 排序；不得讓 graph 關聯完全取代 query relevance。限制查詢耗時、bytes、record 數，尊重 AbortSignal；不在 query path 呼叫生成 LLM。
4. WikiGraphProvider implements GraphMemoryPort；query 回傳合規 GraphHit；write 本階段明確 disabled。接入 createApplication/index，保留現有授權和 FakeGraphProvider 測試。Graph metadata 不信任 Markdown 自述 ACL。關閉 feature flag 時不建立資料庫、不改變應用行為。
5. 提供 seed fixtures、reindex CLI、read-only 診斷（不暴露私有內容）。驗證重啟與舊索引重建。

### 驗收

- 以既有 Memory Bridge 跑一次真實或本地 stub AG-UI Run，證明對應 signed context 含 wiki 命中，原始 messages 未污染；普通與 delegated run 都測。
- 繁中/英文搜尋、無命中、graph neighbor、broken links、cycles、重複 slug、排序穩定；4096-byte budget（含 JSON metadata）及 50/20 hits 限制。
- Bot A private 不可被 Bot B 搜到或透過 edge 推得；shared 可讀；不同 owner/project 隔離；惡意 path、偽造 scope、非法 bot、timeout、abort、disabled、unavailable。
- 重啟後結果一致、重建索引結果一致、未發布 revision 不可見；原測試全通過。
- 報告：`docs/graph-memory-part-1.md`。完成後停止。

## 最終 Definition of Done

從乾淨 checkout 可依文件安裝、配置、啟動 runtime 與 Hermes；graph feature 關閉仍可正常運作；啟用後可手動匯入文件、觀察編譯、檢索及自動 session 學習。所有持久化、權限、失敗降級、回歸測試可重現；不依賴實際 API key 的 CI 測試覆蓋完整核心路徑。README 補充資料目錄備份/恢復、migration、模型選擇及刪除/撤銷機制。將各 Part 的未完成事項如實記錄，不以示意程式碼代替實作。

## 設計假設與待確認事項

本計畫依前次 GitHub 原始碼評估撰寫，未重新 checkout 或執行測試。Markdown + SQLite、TypeScript、private-by-default、分三階段及初始搜尋參數是設計決策；具體 driver、版本、現有測試命令與 API route 需由 Codex 核對。使用者已同意總體方案；若需改動既有 bridge 信任模型、引入額外服務、改變 ACL 或破壞相容性，先提出差異並等待確認。
