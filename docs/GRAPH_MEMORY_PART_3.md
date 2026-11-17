# GraphMemory × LLM Wiki Implementation Plan

適用專案：`jiangweitaiwan/hermes_agui`｜執行者：Codex｜分三次獨立實作



**本次只執行 Part 3。** 先讀取並驗證 Part 2 的完成報告，不重做前階段。

## Part 3 — Automatic Memory Evolution & Hybrid Retrieval

### 目標

成功 Run 自動累積可重用知識，支援已授權跨 Bot 共用與 vector + graph search。不改造 Hermes agent loop。

### 實作順序

1. RunCompletionObserver：一般 Run 在 `runtime.ts` 的 HttpAgent middleware 的 `next.run(prepared)` 真實事件流上監聽（不是 connect/replay）；delegation 在 `delegation.ts` 的 `consumeResult()` 成功路徑接入同一 ingestion service。以 server-owned scope、thread/run/message ID 收集本輪原始 user 與 assistant 最終內容；tool results 僅明確 allowlist、redaction 之後保存。不要抓 hidden reasoning、credential、注入 memory、完整歷史及未授權工具輸出。
2. 校驗 RUN_FINISHED 身份與 outcome、去重；interrupt/HITL、RUN_ERROR、取消、串流斷線不得誤當成功。resume 的最終成功只 ingest 一次（若無法可靠收集完整必要資料則明確跳過並記錄）。在短時間內 durable enqueue，不 await LLM。以 run scope + source revision unique key 保證至少一次投遞下不重複學習。Runtime crash 在 enqueue 前仍可能漏記：設計 durable completion journal 或利用可靠可授權 session API reconciliation；若 checkout 無法保證，報告此限制，不宣稱 exactly-once。
3. SessionIngestor 以 policy 過濾閒聊、重複知識與低品質輸出；保留 user-confirmed decision 與 assistant-unverified finding 的差異。預設 private，使用者/管理員明確分享才轉入 shared；分享應保留來源並重新檢查敏感資料。Bot deletion、project changes、ACL revocation 應撤銷待處理任務、已索引知識及 caches。
4. Embedding adapter（OpenAI-compatible 或獨立本地 encoder；具 model/dimension/version metadata、batch/retry），第一版可使用 SQLite 儲存向量並有限規模 cosine search，或相容向量索引。只在授權 namespace 搜索；索引更新非同步但不允許過期或已撤銷版本被回傳。embedding unavailable 或版本不符，降級 keyword + graph。模型更換可重建；不可混用跨模型向量。
5. Hybrid retrieval：keyword + vector seeds 用 RRF 合併，再進一階 graph expansion 並 re-rank；示例 RRF k=60、seed 8、neighbor 3 均為初始可配置值，實測調整。候選片段註記 provenance、避免重複、符合 runtime budget。建立 Wiki lint：broken links、孤立頁、過期 provenance、衝突、索引漂移；不自動刪除高價值知識。
6. 最小管理功能：job 狀態、manual ingest、share/revoke、reindex、健康與指標；沿用既有 auth，管理 UI 可選，新增 endpoint 必須驗證 owner/project。記錄 query latency、命中數、job lag/error，不記錄敏感全文。保留 on/off 與 rollback 配置。

### 驗收

- A 成功研究一項新技術 → queue → wiki → A 新 thread 取得知識；B 在分享前無法取得，授權分享後取得；C 不同 project/owner 永遠無法取得。測試 standard/delegation 路徑。
- 重播、取消、interrupt/resume、失敗、多 assistant message、重啟恢復、重複 run、撤銷權限、私有頁 merge contamination 皆測。
- 建立固定中英文 evaluation corpus，對 keyword-only 與 hybrid 比較 Recall@K/MRR、graph expansion 的增益與噪音；量測 p50/p95 query latency、queue lag、compiler cost，目標 query p95 小於現有 2 秒 timeout（實測環境須註明，不假造數值）。
- 模型失效、向量維度錯誤、全庫重建、資料撤銷；runtime/Hermes 原有測試通過。提供雙 Bot 端到端 smoke test 與部署指令。
- 報告：`docs/graph-memory-part-3.md`。完成後停止。

## 最終 Definition of Done

從乾淨 checkout 可依文件安裝、配置、啟動 runtime 與 Hermes；graph feature 關閉仍可正常運作；啟用後可手動匯入文件、觀察編譯、檢索及自動 session 學習。所有持久化、權限、失敗降級、回歸測試可重現；不依賴實際 API key 的 CI 測試覆蓋完整核心路徑。README 補充資料目錄備份/恢復、migration、模型選擇及刪除/撤銷機制。將各 Part 的未完成事項如實記錄，不以示意程式碼代替實作。

## 設計假設與待確認事項

本計畫依前次 GitHub 原始碼評估撰寫，未重新 checkout 或執行測試。Markdown + SQLite、TypeScript、private-by-default、分三階段及初始搜尋參數是設計決策；具體 driver、版本、現有測試命令與 API route 需由 Codex 核對。使用者已同意總體方案；若需改動既有 bridge 信任模型、引入額外服務、改變 ACL 或破壞相容性，先提出差異並等待確認。
