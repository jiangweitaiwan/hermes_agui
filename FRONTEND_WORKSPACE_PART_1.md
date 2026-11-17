# Part 1 — Multi-Bot Workspace

## 任務
先讀總計畫與 repository instructions；核對目前 examples/copilotkit/frontend/main.tsx、BotManagement.tsx、BotEditor.tsx、ThreadChat.tsx、HumanInput.tsx、style.css、server/bots/api.ts、types.ts、manager.ts、tests/browser/bot-management.spec.ts。只做本期，不實作 Graph API。

## 工作項目
- 建立 AppShell / Sidebar / Navigation，可切換 Chat、Bot Manager、Graph Memory（本期僅清楚標記尚未開放）。桌面左側導覽、行動版可收合，鍵盤操作與焦點可見；沿用 React/Vite，不加入 Next.js。
- 重用 BotEditor 與 BotManagement 的驗證、登入、API；必要時拆成 bots/、workspace/、api/。建立 Bot 清單、卡片、CreateBotDialog、編輯與狀態列，避免重複維護表單。
- 依實際 API 契約使用 GET/POST /api/bots、GET /api/bots/options、GET/PATCH /api/bots/:id、POST enable/disable、DELETE。只提交 BotInputSchema 允許的 name、description、harness、templateId、skills、toolsets、delegationTargets；可選值由 server options 驅動，切換 template 清除不合法選項。不向使用者要求 host token 或模型 API key。
- 顯示 provisioning/active/disabled/failed，防止重複 submit，處理失敗、重試、401/403、空清單；刪除前確認，說明既有永久記憶撤銷語意；停用與刪除不可混淆。建立成功依 server 回傳狀態更新列表，僅 active 才能開始對話。
- Sidebar 依 Bot 顯示 threads，新增 thread、切換 Bot 與 thread；保留現有 thread ID 與 conversation state，不將一個 Bot 的對話交給另一個 Bot。不得因切頁使活躍 run 重複發送或串流遺失；採既有 thread 掛載策略或明確保留狀態。登出清除敏感 UI state；不要持久化 credential。若既有 thread 歷史僅本地索引，不新增虛構的 server history API。
- managed mode 使用既有登入/session；static mode 維持既有對話，隱藏管理寫入操作並提示配置。README 提供安全本機配置範例及啟動方式。

## 驗收
使用既有 mock host/Playwright fixture：登入→新增 A/B→各自對話→切換 thread→編輯→停用→重啟用→確認刪除；測試模板 allowlist、非 active 不可聊天、錯誤與重複點擊、登出、跨身份隔離；測試 run 中切頁與 HITL、static mode 及窄螢幕。保留既有測試的實質覆蓋；可依新 UI 更新 selectors。執行 Node tests、tsc、build、browser tests，完成 docs/frontend-workspace-part-1.md。Graph placeholder 不能宣稱已實作。
