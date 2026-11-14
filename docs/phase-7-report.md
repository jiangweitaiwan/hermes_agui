# Phase 7：Human-in-the-loop

## Implementation Summary

基準 commit：`5af33943d8cc`（`add:phase 6`）。依計畫第 9 節新增原生 approval、clarify、
interrupt、resume 與 cancellation，沿用官方 AG-UI SDK 與已鎖定的 CopilotKit 1.83.0。

- 原生 callback 進入有期限的等待，SSE 以官方 `RUN_FINISHED.outcome.interrupts` 結束。
- 同 Thread 的 `resume[]` 經 authentication、authorize hook、interrupt ID 與 payload
  驗證後，繼續同一原生 worker／工具；不重跑 Tool Dispatch、不重新注入 UI messages。
- Approval 只提供 once／deny。原生 hardline、deny rules、smart、allowlist 與操作者
  配置的 bypass 語意仍由 Hermes 管理，不新增平行安全決策系統。
- 已使用／未知／過期的 interrupt、跨 Thread 回覆、重複 runId、非法 payload 都拒絕。
- 保留原生工具堆疊、session lease 與執行歷史；等待預設 90 秒，逾時、shutdown、取消
  及 mailbox overflow 都 fail closed。一般執行中的連線斷線仍合作式取消。
- 前端使用官方 `useInterrupt`，提供問題回覆、允許一次、拒絕及取消互動的表單。
- 新增已驗證身份的 `POST /threads/{threadId}/cancel`，可在 interrupt stream 結束後
  取消整個原生 turn；互動的 `status: cancelled` 則交由原生工具回報拒絕／取消並繼續。

## Files Changed

新增：

- `hermes_agui/human_input.py`：thread-safe、序列化、具期限的等待與決策驗證。
- `examples/copilotkit/frontend/HumanInput.tsx`：互動表單，防止重複提交及呈現提交失敗。
- `tests/hermes_agui/test_human_input.py`：6 項真實 native／HTTP 行為驗收。
- `docs/agui-human-input.md`：wire format、授權、continuation、時限與部署限制。
- `docs/phase-7-report.md`：本報告。

修改：

- `hermes_agui/event_bridge.py`：checkpoint event、跨 stream mailbox 與 toolCallId 狀態保留。
- `hermes_agui/adapter.py`：matching continuation admission、重複與容量檢查。
- `hermes_agui/server.py`：resume routing、授權重檢、paused stream lifecycle、取消 endpoint。
- `hermes_agui/config.py`：trusted `human_input_timeout` 設定與有限正數驗證。
- `hermes_agui/core/service.py`：原生 clarify／approval callbacks 綁定與還原；修正 unavailable
  clarify fallback 使用 normalized `qid`。
- `tools/approval_context.py`：明確綁定 trusted host human channel，原生 worker 透過既有
  context／thread callback propagation 取得它，turn 結束時還原，不修改 process env。
- `examples/copilotkit/frontend/ThreadChat.tsx`：官方 interrupt hook、等待時禁止送新訊息。
- `tests/hermes_agui/copilotkit_fixture.py` 與 `examples/copilotkit/tests/browser/chat.spec.ts`：
  原生 clarify、protected instruction write approval 與官方 Runtime resume 瀏覽器驗收。
- `docs/agui-architecture.md`、`docs/agui-server.md`、`docs/agui-native-capabilities.md`、
  `examples/copilotkit/README.md`：更新能力與限制，移除已過時的 resume 不支援說明。

沒有刪除檔案，沒有新增依賴、模型工具或 system prompt 變更。

## Architecture Notes

現有原生同步 callback 可保留工具堆疊，卻沒有可序列化的通用 Python continuation API。
因此本階段選擇有期限的 process-local continuation：只在同一 server process 存活期間
可 resume，restart／其他 instance 回覆 409，不會重播工具。不是跨重啟 checkpoint；
部署需單程序或 sticky routing。等待期間占用原生 worker 與 admission capacity，維持有界。
原始歷史與 admission tombstones 仍沿用既有 SQLite，不另建 Memory／History 系統。

原生 approval 判斷原先將 api_server 視為 unattended，只有安裝 CLI thread-local callback
不足以讓所有安全 gate 使用它。新增 scoped `bind_host_approval`，明確宣告可信 host 有
可回答的 channel；仍保留 api_server 身分及 profile scope。沒有 channel 的 host 回到
原有 unattended policy；cron／single-query 等原有禁止互動的條件仍保留。

## Tests

Python 命令：

```bash
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/

HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/tools/test_approval_unattended_presence.py \
  tests/tools/test_approval.py tests/tools/test_approval_mode_parity.py \
  tests/tools/test_approval_outcome_parity.py
```

- 完整 AG-UI 回歸：**13 files、57 passed、0 failed**，149.1 秒。
- 原生 approval 回歸：**4 files、184 passed、0 failed、1 skipped**，39.5 秒；
  skipped 為 Linux platform marker，本機 macOS 不假造 OS。
- 新增契約涵蓋：clarify 回覆確實進入原生 tool result、原始 user message／tool 不重跑、
  protected file 核准前未改動、核准／拒絕後的真實磁碟內容、錯誤／重複／跨 Thread 決策、
  authentication、撤銷授權、明確取消、等待逾時與 shutdown 釋放。

JS 命令從 `examples/copilotkit` 執行，Node 路徑加入 PATH：

```bash
npm test
npm run build
COPILOTKIT_TEST_PRODUCTION=1 \
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:e2e
```

- Runtime／HttpAgent Vitest 契約：**1 passed**。
- TypeScript／Vite production build：通過；沿用官方 UI bundle 大小 warning。
- Browser production 驗收：**2 passed**，總計 1.0 分鐘；包含既有多 Thread／streaming／
  tool／error 行為，以及真實 clarify 回覆與 protected write 拒絕經官方 Runtime resume。

所有模型請求為 loopback fake provider，Agent、原生工具、HTTP、SessionDB 及前端 Runtime
為真實實作。測試使用 temporary profile／workspace，不寫入個人資料、不消耗模型 token。
Sandbox 的 process／loopback 限制曾阻止啟動 runner／Vitest，允許本機測試後重跑。

初輪測試揭露需要同時傳播 ContextVar 與原生 thread-local callback，已補齊；保護檔案測試
另依原生 read-before-overwrite 契約先讀檔，沒有停用安全 guard。clarify streaming 保留原生
工具輪之間的空白分隔，驗收比對合併 deltas 的文字內容。Browser 驗收另發現動態 Thread 的 proxy 尚未註冊時不能呼叫官方 interrupt hook，
改為在 isReady 後掛載互動元件；保留多 Thread 回歸驗收。最終使用穩定 production build。

檢查：

```bash
PATH=/private/tmp/hermes-agui-js/bin:$PATH .venv/bin/python scripts/check --only ruff --base HEAD
PATH=/private/tmp/hermes-agui-js/bin:$PATH .venv/bin/python scripts/check --base HEAD
git diff --check
```

Ruff 通過；補充 code-health 指向範例已安裝的鎖定 TypeScript，**12 measured files、
0 blocking、0 advisory**。方式與 Phase 5 report 相同。`git diff --check` 通過。

完整 check 的 **17 項中 10 項通過、7 項無法通過**，與 Phase 5 基準缺檔一致：
六個 CI helpers（`check_os_marker_fakes.py`、`check_agents_md_size.py`、`check_line_endings.py`、
`check_lazy_deps_imports.py`、`check_profile_archive_boundary.py`、`check_blob_size.py`）不存在；
標準 health 另需缺少的 root `package.json`。沒有略過規則或宣稱完整 CI 綠燈。

## Next Step

依計畫下一階段是 Phase 8：先盤點獨立 runtime packaging／Docker，再考慮 dependency pruning。
這次不移除 CLI／Gateway／原生工具檔案。跨重啟 HITL checkpoint 是後續可選擴充，
需原生可序列化恢復介面；不能用重跑工具代替恢復。Docker／部署及最終 MVP 驗收仍未完成。
