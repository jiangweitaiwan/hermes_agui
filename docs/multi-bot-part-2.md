# Part 2：跨 Bot 委派與 GraphMemoryPort

基於 Part 1 commit `6825773`；沿用單 Python host、每 Bot service/profile/workspace，
以及 CopilotKit 多 Bot UI。程式變更保留在 checkout，未自動提交。

## 啟動

1. 在 `examples/agui/multi-bot/.env` 提供原有 `RESEARCHER_TOKEN`、`REVIEWER_TOKEN`、
   `OPENAI_API_KEY`，並新增獨立的服務間 secret `DELEGATION_TOKEN`。
2. `cd examples/agui/multi-bot && docker compose up -d --build`。
   YAML 的 `delegation.url` 指向 `http://host.docker.internal:3001/internal/delegations`；
   Compose 增加 Linux host-gateway 映射，profile/workspace 的四個 volume 不變。
3. 在 Node shell 載入相同的三個服務 token，進入 `examples/copilotkit`，
   `AGUI_BOTS_CONFIG=./bots.example.json npm run dev`。
   browser 為 `http://127.0.0.1:3000`，內部 listener 為 `:3001`。
4. 分別選 researcher 與 reviewer 直接交辦，再要求 researcher 將短任務交給 reviewer，
   取得結果後繼續完成原任務。反方向亦可。

全本機版本：複製 Bot YAML，將各 home/cwd 設為獨立的絕對路徑，
`delegation.url` 改為 `http://127.0.0.1:3001/internal/delegations`；
Node JSON 的 `delegation.listenHost` 改為 `127.0.0.1`。
用既有 `python -m hermes_agui.server --bots-config /absolute/path/bots.yaml` 啟動。
兩邊同時移除 `delegation` 區塊可回到 Part 1。Graph 無須部署任何服務。

## 委派契約

- `hermes_agui/delegation.py` 在 host 啟動時為啟用服務的 profile 註冊原生
  `agui_bots/message_bot(target_bot_id, task)`；不更動 stock core tools 或 system prompt。
  schema 從 session 建構起固定，子 Run 亦保留相同 schema；服務端拒絕子 Run 再委派。
- host 透過原生 ContextVar 傳遞綁定來源 Bot、Thread、Run、stop 與原生 tool call ID。
  模型不能設定身分或深度。工具呼叫送出來源 Bot token；Node 依方向性 allowlist
  及 Python 受驗證的 active parent 查詢核對。一般 browser forwardedProps 仍被拒絕。
- Node 為每次委派建立 UUID delegation/run 與獨立 `delegation-*` thread，
  只傳明確 task，不帶父歷史、記憶或 UI state。目標經自己的 token 與額外
  `X-Hermes-Delegation` secret 標記深度 1。Python 路由拒絕偽造標記。
- `GET /bots/{bot_id}/delegation/parent?thread_id=...&run_id=...` 是 bearer 保護的
  後端父 Run 查證接口，只在委派啟用時可用；保留既有 Thread 授權 hook。
- 結果為 JSON 原生 tool result：`completed` 含最後 assistant 文字，或
  `failed`、`human_required`、`timeout`、`cancelled`、`busy`、`result_too_large`、
  `denied`、`depth_exceeded`、`invalid_request`、`capacity`。執行過的子 Run 回傳
  `delegationId`、`threadId`、`runId`。以 AG-UI terminal event 判定結果；缺 terminal
  不是成功。文字上限 32768 UTF-8 bytes、SSE 總量 1 MiB、task 上限 16384 bytes。
- 父取消／斷線會中止 Python → Node 請求，Node 中止子串流並另送 cooperative cancel；
  HITL 立即回 `human_required` 並取消子 Run。取消仍等待原生 worker 清理，
  不宣稱強制終止非合作工具。每 Bot worker 數與 admission 上限相同，host
  同步准入；父佔滿容量時子立即 `busy`，不排隊互等。
- 依 `(source Bot, parent Thread, parent Run, tool call ID)` 程序內去重；相同 payload
  共用原 promise/result，換 payload 拒絕。去重上限預設 1024（`maxRecords`）；
  完成五分鐘後僅在確認父 Run 已結束時清除，活躍父的 dedup 不因時間失效。
  超出保留容量回 `capacity`。不提供跨重啟保證。

## GraphMemoryPort

`examples/copilotkit/server/application.ts` 是組裝點；受信任後端可注入：

```ts
const app = createApplication(bots, {
  graph: { provider: graphAdapter, authorize: scope => hasProjectAccess(scope), timeoutMs: 2000 },
});
const scope = app.graph.scope({ principal, botId, projectId, threadId, runId });
const written = await app.graph.write(scope, {
  content: "Validated project fact", visibility: "project_shared",
  source: { botId, threadId, runId }, idempotencyKey: "fact-1",
});
const found = await app.graph.query(scope, { text: "project fact", limit: 10 });
```

`scope()` 只供後端在解析已認證的身分與 project membership 後呼叫；每次 query/write
仍呼叫 authorize。scope 不經 HTTP 暴露，入口只接受自身建立且凍結的 scope。

- query 結果：`ok` + hits（空陣列是成功無匹配）、`disabled`、`unavailable`，或
  `rejected` + `unauthorized | invalid_request`。
- write 結果：`accepted` + recordId，或相同停用／不可用／拒絕類型。
- query text 上限 4096 bytes，limit 1–50；entry/hit 內容上限 16384 bytes，
  ID 上限 512 bytes。write source 必須匹配當前 Bot/Thread/Run。
- 可見範圍為 `bot_private` 與 `project_shared`。provider 查詢須按 principal/project
  和 Bot 篩選，入口再次檢查回傳 provenance/visibility；異常資料整筆 `unavailable`。
  目前共享限同 principal、同 project。provider 負責 scope 內 idempotency key 的寫入去重。
- provider 接收 AbortSignal；入口有獨立期限，即使 provider 未合作仍回 `unavailable`。
  provider 例外不外洩。測試替身只在測試，預設 provider 缺席。

後續從實體 graph provider、持久化與記憶觸發時機開始。尚不提供公開 graph HTTP route、
graph DB/schema/embedding/抽取、Run 自動檢索或模型工具；AG-UI context/state 的拒絕不變。
跨重啟委派、背景排程、分散式 worker 與耐久 HITL 亦留後續。

## 驗證紀錄

使用 `/private/tmp/hermes-agui-phase2-env/bin/python`（`HERMES_PYTHON`）及
`/private/tmp/hermes-agui-js/bin`（加到 PATH）；Python 一律透過正式 runner，
file retries 關閉。Node 命令在 `examples/copilotkit` 執行。

| 驗證 | 結果 |
|---|---|
| `scripts/run_tests.sh tests/hermes_agui`（workers=2） | 17 檔：63 passed、3 failed；詳見下方重跑 |
| `scripts/run_tests.sh -j 1 tests/hermes_agui/test_runtime_entrypoint.py tests/hermes_agui/test_delegation.py` | 4 passed、0 failed，109.8 秒 |
| `scripts/run_tests.sh -j 1 tests/hermes_agui/test_delegation_bridge.py` | 5 passed、0 failed |
| `npm test` | 14 passed、0 failed（Runtime 2、委派 8、Graph 4） |
| `npm run build` 與最終 `tsc --noEmit` | 通過；Vite 有既有 large-chunk 提示 |
| production Playwright `chat.spec.ts` | 2 passed |
| production Playwright `MULTI_BOT_TEST=1 multi-bot.spec.ts` | 1 passed；含 UI 雙向委派 |
| Compose `config --quiet`、受影響 Python Ruff、`git diff --check` | 通過 |
| `python scripts/check` | 10/17 通過；6 個既有 CI 腳本缺檔，health 缺根目錄 package.json |

首次全套的兩項既有 CLI restart 測試，在建置與全庫檢查並行時發生 40 秒讀取逾時；
無資源競爭的逐檔重跑全部通過。委派容量驗收另曾在測試執行中兩端載入不同版查證
路由時得到 `denied`；固定最終版本後逐檔通過，包含 `/`／中文 Thread ID。
另有一項 Node 組裝測試曾把 SDK 動態載入計入 5 秒測試期限；已改為收集階段載入，
最終 14 項全數通過。合計 18 檔、71 項 Python 契約已有通過紀錄，並非單次全綠結果。

Playwright 使用 `COPILOTKIT_TEST_PRODUCTION=1`、上述 `HERMES_PYTHON`，以及
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。

委派整合以同一 Python host、真實 Node 入口及原生 Hermes loop，驗證雙向並發、
獨立子歷史、父結果、直接接單、深度、偽造標記、HITL、逾時、父取消與容量不足。
Node 測試另覆蓋 allowlist、來源 token、去重／不同 payload 拒絕、上限、過大輸出與
活躍串流斷線取消。Graph 替身驗證私有、同專案共享、跨專案限制、空結果、停用、
拒絕、provider failure／timeout，及應用組裝的注入路徑。

所有自動化 model 呼叫使用 loopback fake provider，Graph provider 為測試替身。
真實 provider smoke、Docker 新映像與資料卷權限驗收未執行。


全庫檢查的缺檔為 `scripts/ci/check_os_marker_fakes.py`、`check_agents_md_size.py`、
`check_line_endings.py`、`check_lazy_deps_imports.py`、`check_profile_archive_boundary.py`、
`check_blob_size.py`。health 初次未找到 Node；補上 Node PATH 重跑 `--only health`，
確認停在讀取不存在的根目錄 `package.json`。這些缺項與 Part 1 交接一致，未改動
無關的檢查基礎設施。受影響 Ruff 與 TypeScript 檢查另行通過。

## 變更檔案

- Python：`hermes_agui/delegation.py` 新增工具與非同步 HTTP bridge；
  `adapter.py` 綁定可信執行上下文與深度；`server.py` 管理工具生命週期、驗證標記及
  active parent 查證；`host.py` 載入可信 delegation 設定。
- Node：`examples/copilotkit/server/delegation.ts` 協調生命週期、去重與 SSE 結果；
  `delegation-http.ts` 提供內部認證入口；`graph-memory.ts` 定義記憶契約與邊界；
  `application.ts` 組裝可注入服務；`index.ts` 接線與 listener 啟停。
- 測試：`tests/hermes_agui/test_delegation.py`、`test_delegation_bridge.py`、
  `copilotkit_fixture.py`；`examples/copilotkit/tests/delegation.test.ts`、
  `graph-memory.test.ts`、`browser/multi-bot.spec.ts`，以及 `playwright.config.ts`。
- 設定／文件：`examples/agui/multi-bot/{bots.yaml,compose.yaml,.env.example}`、
  `examples/copilotkit/{bots.example.json,bots.test.json,README.md}`，
  `docs/agui-deployment.md`、`docs/multi-bot-handoff.md` 與本文件。
