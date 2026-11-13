# Phase 5：CopilotKit Integration

## Implementation Summary

基準 commit：`9ef1a2679399`（`add:phase 4`）。

完成計畫第 7 節的本機整合範例：官方 CopilotKit React UI → Node CopilotRuntime v2 →
官方 AG-UI HttpAgent → Hermes HTTP/SSE → 原生 AIAgent / Provider / Tool / SessionDB。
沒有修改 Python Adapter、Agent Loop、Tool Dispatch、Prompt、Memory 或 Skills。

查核 npm 套件 metadata（透過可連線鏡像）時，最新穩定版為 CopilotKit 1.87.1
（2026-11-12）；本範例依 14 天
release-age 原則選用 **1.83.0（2026-10-28）**，其已提供 v2 APIs。
JS AG-UI 鎖定 **1.0.2**，Python 維持 **1.0.0**；以真實 HTTP/browser 測試驗證相容性。
React 19.2.0、Vite 7.1.12、TypeScript 5.9.3 與測試依賴位於獨立 package／lockfile，
未增加 Hermes Python 依賴或變動 uv.lock。

## Files Changed

新增 `examples/copilotkit/`：

- `server/runtime.ts`：官方 v2 Runtime、per-request HttpAgent factory、有界 InMemoryAgentRunner、
  固定本機身份、server credential 與入站 header policy。
- `server/index.ts`：loopback Node HTTP、同來源 Runtime／Vite 開發與靜態建置服務、Host/Origin 檢查。
- `frontend/`：CopilotKit provider、thread-scoped useAgent、CopilotChatView、送出／停止、
  工具 renderer、錯誤顯示及獨立 Thread 切換。
- `tests/runtime.test.ts`：真實官方 Runtime/HttpAgent 的 loopback contract test。
- `tests/browser/chat.spec.ts`、`playwright.config.ts`：完整瀏覽器驗收。
- package.json / package-lock.json、TypeScript/Vite/Vitest 設定、.npmrc、.env.example、README。

另新增 `tests/hermes_agui/copilotkit_fixture.py`：只供 E2E 使用的 loopback FakeLLMServer +
真實 Hermes server；temporary profile、禁用外部 hostname resolution，以及可由瀏覽器
放行的 native streaming callback gate。不是替換 Agent Loop 的假 Agent。

修改 `.gitignore`：僅開放 `examples/copilotkit/` 與其獨立 npm lock，其他 examples 仍忽略。
更新 `docs/agui-architecture.md`、`docs/agui-server.md` 與本報告。沒有刪除既有檔案。

## Architecture Notes

- Hermes SQLite 是模型歷史權威；Node runner 的事件歷史只服務 UI，前端完整 messages
  仍只由原有 Python reconciliation 選取最新 user text，避免重複歷史。
- 每 Thread 使用獨立的 scoped agent，路由到相同 runtime key `hermes`；切換時保留各自
  messages。重新整理建立新 Thread，不宣稱持久 UI thread 列表或跨 Node 重啟恢復 UI。
- 採用官方 `CopilotChatView` + `useAgent` + `copilotkit.runAgent`，避免 `CopilotChat`
  預設空訊息初始化 Run；Python 對有效新 user message 的要求不變。
- 官方 core 會加入 `forwardedProps.__copilotkitRequestId`；官方 HttpAgent middleware 僅移除
  此 transport correlation metadata。其餘 forwardedProps／state／tools／context 不被靜默
  丟棄，仍由既有 Hermes 驗證拒絕。不改動模型工具集合或 prompt prefix。
- wildcard tool renderer 只顯示 native events，不是 frontend tool。預設公開 payload
  `[withheld]`，模型收到原始 native tool result；授權公開策略沿用 Python host 投影。
- Node 保留 AGUI_API_KEY，browser 不持有服務 token。入站 authorization／x-* 不轉發。
  測試曾確認 `allow: []` 不會關閉官方 header forwarding，已改為明確 deny policy 並驗證。
- 單使用者 loopback 範例，固定本機身份；Host/Origin 限制不取代對外部署所需的身份與 ACL。
  不加入 Copilot Cloud／Intelligence／MCP、A2UI 或共享 state。
- 停用安裝腳本、server telemetry；瀏覽器驗收也檢查沒有外部 HTTP 請求。

## Tests

驗證環境：macOS、本機 Chrome、Node 24.22.1、npm 11.20.0，以及既有隔離 Python test env。
Hermes PM 的 Node 26 pin 在此 host 出現 libc++ 相容性錯誤，改用本機已存在的 Node；
沒有修改 PM lock 或系統安裝。官方 npm registry 在此網路逾時，因此安裝使用 registry
鏡像取得套件，lockfile 統一回官方 tarball URLs，保留 integrity hashes，再以離線
`npm ci --ignore-scripts` 重建驗證（1254 packages）。

命令（Node 目錄需在 PATH；JS 命令從 examples/copilotkit 執行）：

```bash
npm ci
npm test
npm run build
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:e2e
# repository root
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/
.venv/bin/python scripts/check --only ruff --base HEAD
git diff --check
```

已通過：

- `npm test`：1 file、1 contract test passed（官方 Runtime / HttpAgent，不 fake Runtime）。
- `npm run build`：TypeScript + Vite 通過；官方聊天 UI 的部分 bundle 超過 500 kB，
  Vite 提出非阻擋 chunk-size warning，沒有隱藏警告或宣稱已完成 bundle 最佳化。
- 開發模式 Playwright：1 browser test passed，39.4 秒（連啟動共約 1.1 分鐘）。
  同一測試走完八項 Phase 5 驗收；gate 確保 Run 未完成時 UI 已顯示文字。
- 最終 lockfile 離線重裝、重新建置後的 production 模式 Playwright：**1 browser test passed**，
  38.6 秒（連啟動共約 1.1 分鐘）。命令於上列 browser 命令加
  `COPILOTKIT_TEST_PRODUCTION=1`；亦驗證原始 read_file result 真正回填下一次模型請求。
- Python 回歸：8 files、46 passed、0 failed，72.1 秒，3 workers。
- Ruff 與 `git diff --check` 通過。

第一輪 JS contract test 曾在 sandbox 下因 loopback listen EPERM 而失敗，允許本機測試
網路後重跑。初版 header policy 的行為測試先紅後修正。第一輪 browser assertion 因
冷啟動超過 30 秒而失敗；fixture 改為只允許 loopback、停用非必要更新查詢並給冷啟動
合理上限後完整重跑通過；沒有略過驗收項目。

標準 code-health 在此 checkout 缺少 root `package.json`，無法解析它要求的 root
TypeScript pin。額外將 resolver 指向範例已安裝的鎖定 TypeScript，保留其餘規則與
比較流程，再跑同一 code-health CLI：**10 files、0 blocking、0 advisory**。
這是補充檢查，不將標準命令的錯誤視為通過。可重現方式：

```bash
.venv/bin/python - <<'PY'
from pathlib import Path
from scripts.code_health import cli, gitio, ts_measure
ts_measure.resolve_typescript = lambda _repo: Path('examples/copilotkit/node_modules/typescript').resolve()
repo = Path.cwd()
raise SystemExit(cli.run(repo, gitio.resolve_rev(repo, 'HEAD'), None))
PY
```

完整 `scripts/check --base HEAD`：17 項中 10 項通過，7 項未通過。六項是既有缺少
`scripts/ci/check_os_marker_fakes.py`、`check_agents_md_size.py`、`check_line_endings.py`、
`check_lazy_deps_imports.py`、`check_profile_archive_boundary.py`、`check_blob_size.py`；
另一項為上述 root package.json 缺失導致的標準 health 錯誤。不宣稱完整 CI 綠燈。

## Next Step

Phase 5 範圍為本機單使用者整合。尚未驗證遠端真實 Provider、公開部署、多租戶或 Docker；
沒有以此宣稱整體專案 MVP 全部完成。Phase 6 接續確認原生 Memory／Skills／Context 能力
的整合保留與隔離；Docker／部署與 HITL 依計畫後續處理。

官方參考與啟動說明見 [範例 README](../examples/copilotkit/README.md)。
