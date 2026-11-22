# Part 1 design notes

基準與實際 HEAD 均為 476004ac214573a8e7f4be6fed087cefb374ee07。既有工作區修改保持原狀。

沿用 V2RetrievalStore.read/subject 與 WikiStore.validateRead，不建立另一套資料庫。Query Parser 使用獨立 strict schema，共用 ingest 的文字/ref/time primitives；LLM 提議的日期必須經 deterministic resolver。未提供可信 reference 時不補年份。

受信 structured adapter 透過 createGraphMemory 同一個 WeakSet scope 與 authorize gate，保持 query/write 與 HTTP API。Part 1 不將 Net 轉為 GraphHit 或 memory envelope。retrievalMode 與寫入 compilerVersion 分離，預設 v2；v3 必須明確配置 Query Parser model。

Namespace 內先獨立匹配 subjects 及 narrative RRF seeds，再沿 event/state slot bounded expansion。不同 event 不融合。Wiki 僅取匹配頁面的相關 section；所有輸出與 provenance 以 namespace 隔離。validateNet 重讀並重建，不信任外傳 Net 的文字或 evidence。

Embedding V3 以獨立 template key 共存於既有表；不變更歷史 migration 或舊向量。Relation 新欄位只擴充 JSON，舊 edge hash 在未設定新欄位時保持一致。

實碼差異與決策：

- 既有先 profile 後 incident fixture 是 8 Subjects / 6 Wiki Pages；incident 單獨為 7 Subjects。新增的 access component 屬同一 FeatureHub Wiki，不刪除它以湊 7。
- 實際 page.sections 可能只含 bullet，標題已拆開。Section selection 去掉 canonical-name identity bullets，並從 Edge 檢索背景移除 actor 名稱，避免只因名稱命中而灌入 Bob、TTL 等無關片段。
- retrievalMode=v3 啟用 server-only structured service；既有 GraphMemoryPort.query 仍維持 V2 行為。直到 Part 2 才由 Runtime 消費 Net；本階段不做 Story 或簽章注入。
- 001 為建立 schema 的歷史 migration，不可直接重跑整組 SQL。隔離 DB 先完整 apply 001–010，再重跑既有冪等的 009/010；保留全組直接重播的錯誤日誌，不修改歷史 migration。
