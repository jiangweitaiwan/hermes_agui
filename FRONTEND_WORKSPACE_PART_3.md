# Part 3 — Graph Memory Explorer

## 前置
讀總計畫、Part 1/2 報告和已實作 DTO，先驗證 API/Workspace baseline。本期不另造 API 或放寬 ACL；若契約缺陷需最小修正附回歸測試。

## UI 實作
在 frontend/memory/ 建立 MemoryExplorer、GraphView、WikiPageList、WikiPageViewer、MemorySearch、ProvenancePanel、MemoryDashboard，以及 api/graph.ts（名稱可調整）。沿用 Workspace sidebar。使用 React + Vite；推薦 react-force-graph-2d、react-markdown、remark-gfm，先檢查既有 React 版本及 lockfile，相容才安裝；icon 套件可重用。依賴有問題採最小替代並記錄，不重寫 framework。

- Bot selector 與 scope tabs（All / Bot Private / Shared），沿用目前登入身份；All 僅所選 Bot 的 private + 授權 shared。以 Bot/scope/query 作為 request key，AbortController 與 stale-response guard，切換時清空 graph/page/job；登出立即清除，不寫 localStorage 記憶內容。
- Graph：force layout、pan/zoom、drag、fit、click node、type/visibility filter、搜尋、局部鄰居載入；以 visibility 區分色彩與文字圖例，degree 可調節點大小；只畫 API 提供 edges，標示 truncated 及 load more，合併分頁時不得跨 scope 或殘留已撤銷頁。限制渲染規模，清理 animation/resize listeners，窄螢幕提供 list fallback；鍵盤可透過等價清單操作。
- Wiki：可分頁列表、搜尋 title/body snippet、詳細 Markdown、tags/type/verification、revision、related pages、provenance（session bot/thread/run 或 document title/version/sourceId，以 API 安全 DTO 為準）。Wiki links 點擊只導航到同 scope 已授權頁；broken link 不猜測內容。不是完整原始 session viewer。Markdown 禁 raw HTML、javascript/data URL、任意 iframe、外部圖片自動請求；外連明確使用者操作，安全 rel。未核實的內容顯示 verification，不當成已證實事實。
- Dashboard：stats、health（broken links、isolated、conflicts、stale provenance、index drift）、jobs pending/running/completed/failed 等真實狀態。手動 refresh，頁面可見且登入時才以合理間隔輪詢（建議15秒），離開停止、錯誤退避；禁用 evolution 顯示 not available。第一版不做假歷史曲線、不額外保存統計歷史。
- Loading/empty/error/disabled/unauthorized/truncated 狀態清晰；刷新權限失敗清空已載入資料而非沿用 private cache；不提供 graph 寫入、share、revoke、delete、ingest、reindex 操作。

## 端到端驗收
以真實 Runtime + mock LLM/compiler/encoder + fixture Host 建立 A/B/C。A 成功 run → durable job → compiler → 前端可查看新增 Wiki/edge/provenance；A 的另一 thread 可檢索記憶（沿用既有 E2E）。B 不見 A private；授權 shared fixture 可見；C 不見其他 project；透過既有可信 CLI revoke 或刪除來源後刷新不可看舊頁。測 graph 節點/zoom/list/filters/search/related links、同名頁、pagination、權限錯誤、慢回應切換、惡意 Markdown、evolution disabled、unavailable、空 graph、mobile/keyboard。Bot 建立和聊天、HITL、delegation、原本 memory assembly 不回歸。不得用 mock UI 冒充整合驗收；若環境不支援真實路徑則明記未驗證。

## 交付
執行完整 Node suite、tsc、production build、Playwright 及原生 tests/hermes_agui 回歸（依 README/既有 PM 指令），記錄根 CI 既有阻礙。提供 README 從 managed mode + graph + evolution 配置到啟動、建立 Bot、聊天、瀏覽記憶的操作流程，使用安全 placeholder；記錄 mock vs real provider 驗證差異。docs/frontend-workspace-part-3.md 含完成清單、測試證據、依賴理由、已知限制、操作截圖若可取得、rollback。最終確認無 secret、無 raw private storage HTTP、無修改 Hermes core。
