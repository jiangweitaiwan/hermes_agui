# Part 2 — Graph Memory Browser API

## 前置
讀總計畫、Part 1 報告、GraphMemory Part 1–3 報告。核對 server/index.ts、application.ts、bots/auth.ts、bots/manager.ts、graph/{provider,wiki-store,retriever,types,markdown,evolution,health,ingest-queue,provenance}.ts。沿用既有 store instance；不可開第二個獨立寫入 store。

## 設計
新增 server/graph/browser.ts、browser-types.ts、api.ts（實際拆分依規範）。Browser API 與原有 GraphMemoryPort.query/write 分離，不建立偽 run/thread scope。由 managed auth 取得 identity，使用 manager.owned 驗證 Bot，從可信 runtime settings 解析 principal/project/bot；不能相信 client 提供的 namespace 或 principal。沿用既有 project policy、retained owner、active revision 與撤銷邏輯，抽取共用授權函式而非另造 ACL。disabled Bot 是否可瀏覽：允許合法 retained owner 唯讀已保存內容，但仍須符合部署 policy；deleted 不可讀。若現有 policy 明確更嚴格則維持並記錄。Graph disabled/unavailable、evolution disabled 分別處理；未啟用 managed mode 不公開 graph 資料。無 evolution 時也不得繞過 ownership 撤銷，若無法驗證則 fail closed。Reconcile 可沿用既有內部維護路徑；HTTP 不提供寫入操作。

## API 契約（提案，需與 Part 3 共用 DTO）
所有路由 GET /api/graph/:botId 下；scope=all|bot_private|project_shared，預設 all。嚴格驗證 query/path、cursor、limit。
- /stats：授權範圍內 active page/edge/private/shared counts（edge 僅計可見端點）。
- /network：nodes [{id,pageId,title,type,visibility,verification}], edges [{source,target}], nextCursor, truncated。支援 page filter、focus visibility/pageId、depth=1（最多2）、limit 預設100 上限300，edges 上限1500；不得包含未回傳或未授權端點。使用 namespace 內 edges；不生成 typed relation 或跨 namespace edge。Node ID = visibility:pageId（僅在目前 Bot response 有效）。
- /pages：分頁 summaries，按固定順序，回傳 nextCursor；支援 type/verification/q。
- /pages/:visibility/:pageId：active revision ID、title、type、tags、verification、body、可見 related pages、經 scope 檢查的 provenance。僅透過 WikiStore.active/read 取得校驗過的頁；不提供 raw path 或任意 revision 存取。
- /search?q=...：使用現有 terms/FTS 邏輯（含中文 bigrams），回傳 scoped page summaries + bounded snippets；不需打 embedding/LLM，也不改 agent retrieval。參數化 SQL，限制 query 長度與 result count。
- /health：scoped health counts；若掃描成本過高採 bounded 計算/標示 partial。/jobs：scoped recent job summaries（最多50），安全狀態、時間若存在；不回傳原文、secret 或 lease/error raw text。未啟用 evolution 則明確 unavailable，不假造 0。

## HTTP 與一致性
在 index.ts 明確分派 /api/graph/，不落 SPA fallback。重用現有 Node/Hono handler pattern、host/origin/session 驗證；回傳 JSON、Cache-Control: no-store；未登入401、無權/不存在統一404（遵循既有 API 策略）、不合法400、disabled/unavailable 503 或 typed status（文件固定一致）。其他 methods 405。每個 endpoint 都檢查 scope；cursor 不授權且綁定 scope/filter，限制輸出 bytes 與每次解析 Markdown 工作量；不能全庫無界掃描。SQLite active pointers 是 publication boundary，使用一致 snapshot 或回傳前重新檢查；禁止已撤銷或混合來源頁被讀取。若 async 工作期間 ACL/版本變更須再次驗證。不要 cache private response。Markdown body 不可信，前端安全渲染契約寫入 README。

## 驗收
建立 A/B 同 principal/project、C 不同 owner/project、同名 private/shared pages、broken links、撤銷/停用/刪除/未發布 revision fixture。逐 endpoint 測試 ACL、跨 scope cursor、同名 ID、來源、edge closure、搜尋中文、SQL injection/path traversal、unavailable、static mode、非法參數、上限與分頁、撤銷後讀取、並行 publication；測 Graph API 不經 LLM、不改 agent retrieval 或原始資料（既有 reconciliation 除外）。實際 HTTP + mock store fixtures，Node tests、tsc/build。輸出 DTO/API 文件及 docs/frontend-workspace-part-2.md；Part 3 不得先行開發。
