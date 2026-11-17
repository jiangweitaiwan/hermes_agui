# Frontend Workspace Part 1 — Multi-Bot Workspace

日期：2026-11-17。範圍僅 `FRONTEND_WORKSPACE_PART_1.md`，未實作 Frontend Part 2／3。
本期實作與驗收完成；根目錄 CI 的既有阻礙另列。未 commit 或 push，未新增 dependencies，未呼叫付費 API。

## 基線與閱讀範圍

- Branch `main`，起始 commit `601accf3d14a331a007b5896cf0b099a388a480b`。
- 已核對根 `AGENTS.md`、總計畫／Part 1、`examples/copilotkit/README.md`、package scripts／lockfile、frontend 元件、Bot API／types／manager／authentication、Runtime 接線及 browser fixtures。此 example 沒有額外的區域 AGENTS.md；測試遵循 `tests/AGENTS.md`。
- 已參考 `docs/graph-memory-part-1.md`、`part-2.md`、`part-3.md` 的既有成果與限制。工作目錄中的兩份 Runtime Memory 報告已被刪除，使用 `git show HEAD:docs/runtime-memory-part-1.md` 及 `git show HEAD:docs/runtime-memory-bot-manager-part-2.md` 閱讀已提交版本，沒有還原或修改使用者刪除。
- 開始時已有六份 docs 刪除及四份未追蹤 Frontend 計畫書；完整保留。未修改 Hermes core、system prompt、session SQLite、GraphMemoryPort、retrieval ranking、native/remote harness 或 delegation pipeline。

## 實作與 API

- `frontend/workspace/AppShell.tsx`：Chat／Bot Manager／Graph Memory 導覽、active Bot 清單、桌面側欄與行動版可收合導覽，使用 `aria-current`、`aria-expanded` 和可見鍵盤焦點。Graph Memory 僅明確的尚未開放頁面，沒有 Graph HTTP API。
- `frontend/BotThreads.tsx`：由既有 main 元件拆出，保留每個 Bot 的 CopilotKit provider 與每個 thread 的 `ThreadChat`；thread 導覽透過 portal 放入側欄。切頁、切 Bot、切 thread 只改顯示狀態，不重送 Run、不重建 thread ID，也不卸載串流或 HITL。沿用本頁索引，沒有虛構 server history。
- `BotManagement.tsx`／`BotEditor.tsx`：沿用既有驗證、登入、server options 與表單，改為卡片清單及共用建立／編輯 modal。顯示 lifecycle、說明、harness／模型及忙碌狀態；ref 鎖與 disabled 防止重複提交。編輯先讀單一 Bot；失敗後重新取得 server lifecycle，保留相同 options 時的表單草稿。
- 使用原有 `GET/POST /api/bots`、`GET /api/bots/options`、`GET/PATCH/DELETE /api/bots/:id`、`POST /api/bots/:id/enable|disable`。表單僅提交 name、description、harness、templateId、skills、toolsets、delegationTargets；切模板清理 capability，提交前再依 options／active targets 過濾。沒有自由 endpoint、system prompt、Host token 或模型 key 輸入。
- 非 active Bot 不提供對話入口；provisioning 不可重試。failed 可重試，空清單、載入／操作錯誤、401 登入及 403 拒絕均有 UI 回應。刪除須經確認 modal，說明停用保留知識、刪除永久撤銷衍生記憶／分享副本、稽核資料仍保留。
- `workspace/Dialog.tsx` 使用原生 modal dialog 的焦點限制、Escape 與關閉行為，操作期間禁止關閉；建立與編輯重用同一份 BotEditor。
- 既有 `POST /api/bot-session` 不變；新增 `DELETE /api/bot-session`，沿用同來源檢查，撤銷該 cookie 對應的 server session，回 204 及 HttpOnly／SameSite=Strict／Path=/api／Max-Age=0 cookie。其他 session 不受影響。登出清空 Bot、thread、options、草稿、選取及 credential state；沒有 localStorage credential。
- Static mode 保留既有對話，Bot Manager 僅顯示配置提示；不提供管理寫入按鈕。README 補充 local-only 配置、啟動、限制與操作方式。

## 測試環境與實際結果

使用現有 Node 22.18.0 darwin-x64（PATH 加入 `/private/tmp/node-v22.18.0-darwin-x64/bin`）、npm／package-lock、Chrome 150，以及先前由 Hermes PM 建立的 `/private/tmp/hermes-graph-test-env/bin/python`。沒有 raw pip／uv 安裝。
瀏覽器測試使用本機 Python 原生 Hermes fake-model Host、真實 CopilotKit Runtime 與 Chrome；管理 UI 的錯誤／allowlist／窄螢幕測試另以 Playwright route mock 管理 API。兩種覆蓋明確分開，沒有用 mock 取代真實 lifecycle 驗收。

以下 npm 指令於 `examples/copilotkit` 執行；browser 設定：

```bash
export HERMES_PYTHON=/private/tmp/hermes-graph-test-env/bin/python
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

| 驗證 | 實際指令 | 結果 |
| --- | --- | --- |
| Node 完整回歸 | `npm test -- --reporter=dot` | 14 files，88 passed，0 failed，57.29s |
| TypeScript | `./node_modules/.bin/tsc --noEmit` | 通過；另包含於 build |
| Production build | `npm run build` | 通過；既有 large chunk warning，最終版本重建結果見下方補記 |
| TypeScript | `./node_modules/.bin/tsc --noEmit` | 通過；`npm run build` 亦再次包含此檢查 |
| Static mode／native chat／HITL | `npm run test:e2e` | 3 passed / 2 skipped（managed 與 multi-Bot 使用獨立配置另跑）；含最新 mock 403、disabled／provisioning 不可對話 |
| Production browser | `COPILOTKIT_TEST_PRODUCTION=1 npm run test:e2e`（最終 `npm run build` 後） | 3 passed / 2 skipped，1.2 分鐘；同樣兩項分模式另跑，不以 skipped 當通過 |
| 雙 Bot 串流／HITL／delegation | `MULTI_BOT_TEST=1 npm run test:e2e -- tests/browser/multi-bot.spec.ts` | 1 passed，含執行中切 Graph placeholder 再返回 |
| 文件／whitespace | `scripts/check_no_tmp_literals.py docs/frontend-workspace-part-1.md examples/copilotkit/README.md`、`git diff --check` | 通過 |
| 登出 base 紅燈證明 | 相同 session contract 搭配 `HEAD` 的 API（暫存檔測試後已移除） | 按預期失敗：原始 API 回 404，預期為 204 |
| Managed lifecycle 與 UI 錯誤／行動版 | `DYNAMIC_BOT_TEST=1 npm run test:e2e -- tests/browser/bot-management.spec.ts` | 2 passed；真實 A/B 建立與獨立對話、thread 返回、編輯、停用、重啟用、確認刪除及登出 |
| Static browser 回歸 | `npm run test:e2e` | 執行中，完成後補記 |
| Python 動態 Host／Runtime | 根目錄 `HERMES_PYTHON=... scripts/run_tests.sh tests/hermes_agui/test_dynamic_host.py tests/hermes_agui/test_dynamic_runtime.py` | 2 files，4 passed，0 failed，114.0s |
| TS complexity | `scripts/code_health/ts_units.mjs`，使用 example 的 TypeScript | frontend 所有函式 CC≤12，未超出 CC≤20／300 lines／nesting≤6 規範 |
| Whitespace | `git diff --check` | 通過 |

測試過程與限制：

- sandbox 第一輪 Node 有 72 passed／15 failed，全部失敗為 loopback listen EPERM；允許本機 fixture 後重跑 87 個原有測試全通過。加入登出測試後曾有既有 CLI 測試在 build／多套測試同時負載下超過原有 60 秒；未放寬 timeout，完整重跑 88/88 通過。
- managed B Bot 最初未勾 toolset，既有 FakeLLMServer 將無 tools 的請求當 auxiliary，回摘要而非指定 Beta 回覆。測試改用與 A 一樣的核准 memory toolset，保留原生執行及預期回覆驗證，之後通過。
- 曾同時啟動兩組 browser fixture，第二組因 8765 已占用而未啟動；改為依序執行，沒有開啟 reuseExistingServer 掩蓋配置差異。
- 一次 Python 指令引用不存在的 `test_management.py`，沒有算成測試通過；正式結果使用上列現存的兩份測試。
- 根 `.venv/bin/python scripts/check`：17 項中 10 通過，六個既有缺失腳本失敗（check_os_marker_fakes.py、check_agents_md_size.py、check_line_endings.py、check_lazy_deps_imports.py、check_profile_archive_boundary.py、check_blob_size.py），health 初次找不到 Node。補 PATH 執行 `scripts/check --only health` 後，仍因根 `package.json` 不存在而失敗，與前期報告一致。沒有補無關 CI 檔案或降低檢查標準。
- 登出契約在 HEAD API 的暫存副本上執行：預期紅燈（DELETE 回 404，測試要求 204）；已移除暫存 source／test，真正實作納入 88/88 綠燈。
- 初次 Node sandbox 執行 72 passed／15 failed，均為 loopback `listen EPERM`；允許 loopback 後既有 87/87 通過。加入 session 測試後一次完整回歸出現原有 CLI 測試 60 秒逾時（當時並行 build／browser），保留原 timeout 重跑後 88/88 通過。
- 第一次 managed A/B 測試中 B 未選 toolset，既有 fake provider 將沒有 tools 的請求視作 auxiliary summary；測試改為與 A 一樣選核准 memory toolset，未修改產品或放寬預期。一次提早啟動 browser 因前一套 fixture 尚占用 8765 而未開始；後續依序執行通過。
- TypeScript metrics engine 對本期 frontend functions 量測，CC 最大 13，未超過 20；無新增高複雜度函式。
- 本次只修改 example frontend 及 session logout；執行與風險相關的 Python 動態 Host／Runtime 回歸，沒有宣稱重跑整個 Hermes 測試庫。

## 操作、限制與後續注意事項

1. 依 README 先啟動既有 Host，再以 `AGUI_BOTS_CONFIG` 指向管理員持有的 JSON，配置核准模板與 owner secret env，執行 `npm run dev` 或 `npm run build && npm start`。維持 `127.0.0.1` 與既有 host/origin 防護；公開部署另案。
2. 登入後在 Bot Manager 新增 Bot；建立成功只有 server 回 active 才開啟對話。新增 thread 與 Bot 切換各自隔離；切管理頁不會停止進行中的 Run。
3. thread 索引及 UI state 僅在本頁有效。重新整理、登出、停用／刪除造成對話元件移除後，不提供本地 transcript 恢復；後端原生 session 行為不變。新 thread 才採用更新後的 Bot 模板配置。
4. 沒有背景 lifecycle polling；每次管理操作後重新載入，錯誤可重試載入。其他程序變更 Bot／ACL 仍由 server 授權執行；本頁不是權限來源。
5. session 登出僅撤銷該 session cookie，並非 owner credential 輪替或全裝置登出。沒有憑證管理 UI、外部登入供應商或持久化 credential。
6. Graph Memory placeholder 不代表 Graph Browser 已完成。後續收到指示才可加入唯讀 scoped Browser API（Part 2），再做 Graph／Wiki／Search／Dashboard（Part 3）。
7. 測試環境既有 Python SQLite 3.50.4 的 WAL-reset 警告仍存在；Hermes 依既有保護改用 journal_mode=DELETE。另有 Node SQLite experimental warning 與 Vite 大型 chunk warning；本期未更改 SQLite runtime 或 CopilotKit bundle 結構。
8. 不需要資料庫 migration。Rollback 可回復本期 frontend、auth/API 與 README 程式變更並重建 assets；既有 Bot Registry／WikiStore／immutable Markdown 不變。服務重啟會清除既有 in-memory login sessions，需重新登入。不要回復使用者原有 docs 刪除或計畫書。
