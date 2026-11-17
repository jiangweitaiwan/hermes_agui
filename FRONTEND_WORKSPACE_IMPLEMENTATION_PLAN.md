# Hermes Workspace — Implementation Plan

Repository: https://github.com/jiangweitaiwan/hermes_agui.git

## 目標與基線
以目前 main 的 GraphMemory Part 3 完成狀態為起點，建立 React/Vite/TypeScript 工作空間。先核對 checkout、AGENTS.md、docs/runtime-memory-part-*.md、docs/graph-memory-part-*.md、examples/copilotkit/README.md、package.json 與實際 API；文件名稱以實際 checkout 為準。不得假定舊完成報告等於當前測試結果。

## 架構
Frontend Workspace (Chat / Bot Manager / Graph Explorer) → CopilotKit Runtime (既有 Bot API / 新唯讀 Browser API / 既有 run pipeline) → AG-UI agents 與 WikiStore (SQLite + immutable Markdown)。Browser API 與 GraphMemoryPort 分離；不新增 Neo4j、不改 Hermes core、system prompt、session SQLite 或 retrieval ranking。保留 native/remote harness、HITL、delegation、memory evolution。

## 分期與交付
1. FRONTEND_WORKSPACE_PART_1.md：Workspace 與 Bot 管理。
2. FRONTEND_WORKSPACE_PART_2.md：唯讀、scoped Graph Browser API。
3. FRONTEND_WORKSPACE_PART_3.md：Graph/Wiki/Search/Dashboard 與 E2E。
每次只執行一份，前一階段驗收後再進下一階段。各階段先讀本總計畫、前期報告、git status；保留使用者修改，不自行 reset、commit 或 push。使用既有 package manager、lockfile、測試與 fixture，避免付費 API。新增依賴需說明理由、版本相容性及安全性。

## 共通安全與驗收
沿用 managed login、server-owned identity及 Bot ACL；不把 credentials、filesystem path、raw session/tool/reasoning、lease token、embedding vector 暴露給瀏覽器。維持 local-only host/origin 限制；公開部署另案。所有 graph 查詢限已授權 active revisions；撤銷後不得返回舊內容。UI 清除切換身份/Bot/scope 的舊資料與 in-flight response。不得降低現有測試標準。

在 examples/copilotkit 依現有 scripts 執行 npm test、TypeScript noEmit、build、Playwright；根 AGENTS.md 要求的檢查及 Hermes 回歸依變更風險執行，最終階段完整回歸。記錄實際命令、環境、passed/failed/skipped、已知既有 CI 缺檔、未驗證事項。各期更新 README 與 docs/frontend-workspace-part-N.md（基線 commit、變更、API、測試、操作、限制、rollback）。不宣稱未跑的測試通過。

## 非目標
Graph 編輯、文件匯入 UI、分享/撤銷 UI、模型金鑰管理、自由 remote URL、自訂 system prompt、歷史趨勢資料庫、跨 namespace edges 均延期。第一版只以既有模板建立 Bot。
