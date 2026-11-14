# 第一輪交接：單 host 雙 Bot + CopilotKit

交付位於 `main` 工作目錄（未建立 commit）；起點 `c83d555`。開工時已存在
`IMPLEMENTATION_PLAN.md` 刪除及三份 `HERMES_MULTI_BOT_*.md` 未追蹤文件，均保留。
本輪只涵蓋 A/B；委派與 graph port 留第二輪。

- **Python 入口**：`hermes_agui.server.create_host` 在同一 lifespan 建構每 Bot 的
  `HermesAgentService` / `AgentAdapter` / `ReceiptStore`；`host.BotConfig`、`load_host`、
  `validate_bots` 從可信 YAML 與 token environment 取得身分，拒絕重複 ID/token、
  canonical 跨 Bot 路徑碰撞。初始化失敗用 `AsyncExitStack` 關閉已建立的服務。
  `AgentAdapter.host_has_capacity` 同步准入；host 預設 8、範例每 Bot 4，HITL 佔名額。
- **路由與 namespace**：`POST /bots/{bot_id}/agent`（含 resume），
  `POST /bots/{bot_id}/threads/{threadId}/cancel`；各 Bot token 只能操作該 Bot。
  Bot → 唯一 canonical home + principal；native Thread namespace 仍為
  `(home, principal, threadId)`，Run/message receipts 在各 profile 內按 principal/thread
  持久化。因此不同 Bot 可重用相同 Thread/Run/message ID。cancel/resume/active/cache
  都經該 Bot adapter；resume 需要新 Run ID。`GET /health` 不變。
- **Node/UI**：`server/index.ts` 讀 `AGUI_BOTS_CONFIG`，`server/runtime.ts`
  `createRuntimeHandler` 建立官方 `HttpAgent` 並依可信 agent registry 分派。
  Browser 只能選已註冊 ID；`/api/bots` 只回 ID，URL/token 留在 Node。
  SDK 1.83.0 runner store 是 process-global；`server/bot-runner.ts:BotRunner`
  將 `(botId, threadId)` JSON key 一致套用到 run/connect/stop/isRunning/ownership，
  事件映回原 Thread ID，Python input 不改。`BotThreads` / `ThreadChat` / HITL hook
  依 Bot + Thread 保存狀態，切換保留進行中的元件；使用 explicit agent routes。

**可重現啟動**（secrets 先提供給兩個程序，勿提交）：

```bash
cd examples/agui/multi-bot
cp .env.example .env  # 填 token/provider key；修改兩份 native YAML 的模型
docker compose up -d --build
# 另一個 shell，在 repo root，載入相同 RESEARCHER_TOKEN / REVIEWER_TOKEN：
cd examples/copilotkit
AGUI_BOTS_CONFIG=./bots.example.json npm run dev
```

`researcher` / `local-researcher` → `:8000/bots/researcher/agent`，
`reviewer` / `local-reviewer` → `:8000/bots/reviewer/agent`。
四個 named volumes 為 `{researcher,reviewer}-{profile,workspace}`，對應
`/srv/hermes/{bot}` 與 `/srv/workspaces/{bot}`，各 native YAML 的 `terminal.cwd` 已配對。
瀏覽器 `http://127.0.0.1:3000`。非容器啟動用
`python -m hermes_agui.server --bots-config /absolute/path/bots.yaml`；詳見部署指南。

**驗收與命令**：使用既有 `/private/tmp/hermes-agui-phase2-env/bin/python`
（`HERMES_PYTHON`；workers=2、file retries=0）及 `/private/tmp/hermes-agui-js/bin`（加入 PATH），所有 provider
皆為既有 loopback fake；Node 命令在 `examples/copilotkit` 執行：

- `scripts/run_tests.sh tests/hermes_agui`：65 passed、0 failed（16 檔；157 秒）；涵蓋相同 ID 的並發、
  receipts、scope、取消/resume、default alias、真實 CLI 重啟與既有單 Bot 契約。
- `npm test`：2 passed（含相同 ID 的 run/connect 與固定 credential）；`npm run build`：通過。
- `COPILOTKIT_TEST_PRODUCTION=1 npm run test:e2e -- chat.spec.ts`：2 passed；
  同命令加 `MULTI_BOT_TEST=1` 並選 `multi-bot.spec.ts`：1 passed。
  兩者都設定 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。
- Compose `config --quiet`、Ruff、`git diff --check` 通過。
  `python scripts/check`：10/17 通過；6 個 `scripts/ci/check_*.py` 缺檔，
  health 缺根目錄 `package.json`，故整體未通過。

**第二輪相容性**：保留單 Bot `create_app`、`AGUI_URL`/`AGUI_API_KEY`、legacy
home/principal 歷史；多 Bot legacy agent/cancel 只有設定 `default_bot` 才啟用。
保留同 Thread busy/replay 拒絕、原始 AG-UI IDs/SSE、metadata 過濾、disconnect 合作取消、
process-local HITL、SQLite 歷史權威及固定 prompt prefix。此為可信 Bot 的應用層隔離，
共用 OS 權限與工具 registry。尚未交付委派、graph、跨重啟 HITL、分散式 worker 或
UI 完整歷史恢復。真實 provider 與新 Docker image/volume 權限驗收未執行。

## Part 2

委派與 Graph 接口的啟動、契約、測試及後續範圍見
[第二輪交接](multi-bot-part-2.md)。`bots.example.json`／範例 YAML 現已啟用委派；
使用新版範例須提供 `DELEGATION_TOKEN`，或同時移除兩邊 delegation 區塊保持停用。
