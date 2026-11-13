# Phase 2 交付報告

基準 commit：`eb33d06`（Phase 1）。本階段範圍為計畫 M2：AG-UI Server，
不包含完整 Phase 3 Callback Event Bridge 或 Phase 5 CopilotKit 整合。

## Implementation Summary

- 新增 FastAPI `POST /agent`、`GET /health`，以及 `python -m hermes_agui.server` 啟動入口。
- 實際查核並安裝官方 `ag-ui-protocol 1.0.0`；使用其 `RunAgentInput`、事件型別及
  `EventEncoder`，不手寫協定 JSON。來源見 [Server 文件](agui-server.md#官方依據與驗證)。
- SSE 提供 Run lifecycle、完成後的 assistant text 與泛化 `RUN_ERROR`。
  沒有偽裝增量 token 或工具事件；Phase 3 才接 Callback。
- Hermes DB 擁有 history；前端完整 messages 僅取最後一筆新 user text，不重複匯入 UI history。
- 必填 Bearer secret，一個 app 綁定固定可信 profile/principal；不接受 client 指定身份或 provider。
- 同 thread active 時拒絕第二輪（409）；跨 thread 有界並發，容量用盡回覆 503。
- 有界程序內 Run/message 收據，拒絕重送，不靜默驅逐。不提供跨重啟 exactly-once。
- 持續監聽斷線，跨 queued/constructing/active 狀態重試合作取消；直到 native future settled
  才釋放 admission。Shutdown 等待所有追蹤工作，最後 close 原生 Service。

## Files Changed

新增：

- `hermes_agui/server.py`：FastAPI app factory、認證、validation、SSE response 與 CLI。
- `hermes_agui/adapter.py`：HTTP admission、程序內收據、工作追蹤、取消與 lifespan cleanup。
- `hermes_agui/message_adapter.py`：官方 input 轉本輪 user text，明確排除不支援輸入。
- `hermes_agui/config.py`：可信 server secret 與容量參數。
- `tests/hermes_agui/test_message_adapter.py`、`test_server.py`、`test_http_lifecycle.py`。
- `docs/agui-server.md`、本報告。

修改：

- `pyproject.toml`：可選 `agui` extra；官方 SDK／FastAPI 加入獨立 test group。
- `uv.lock`：透過專案 PM 解析，新增官方 SDK 1.0.0 與對應 metadata；既有套件版本未更動。
- `docs/agui-architecture.md`：連結 Phase 2 HTTP API，更新斷線取消說明。

沒有修改 Agent Loop、Tool Dispatch、Memory、Skills、Context Management 或 Phase 1 Service。
沒有刪除 Hermes 原始模組，沒有建立自製 event_bridge 或 CopilotKit 範例。

## Tests

PM 建立隔離環境：

```bash
SSL_CERT_FILE=/etc/ssl/cert.pem \
HERMES_HOME=/private/tmp/hermes-agui-dev-home \
HERMES_RUNTIME_DIR=/private/tmp/hermes-agui-runtime \
.venv/bin/python -m pm.build_env --source . --out /private/tmp/hermes-agui-phase2-env \
  --extra agui --group dev --group test --cache /private/tmp/hermes-agui-pm-cache \
  --python /usr/local/bin/python3.14
```

新增依賴後以同一 PM 的 `--lock-only` 操作更新 `uv.lock`；最後執行
`python -m hermes_cli.main pm lock`，確認 lock 已符合 pyproject，無額外寫入。未使用 raw pip/uv。
測試只連本機 FakeLLMServer，未消耗真實模型 token。

第一輪完整 Phase 1＋2：

```bash
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/
```

結果：**26 passed / 0 failed，6 個檔案**。包含 Phase 1 原生普通文字、工具、Memory、Skills、
history 持久化、跨 profile、executor，以及 Phase 2 HTTP/SSE、認證、語意 validation、
重送拒絕、真實 AIAgent 多輪與 thread 隔離、ASGI 2.0/2.4 斷線及 shutdown。

之後只新增測試：官方 `Event` union 驗證每筆 SSE、failed/partial/interrupted 不輸出 private
partial text、取消過程拋出例外仍追蹤並等待。針對更新的兩個測試檔執行：

```bash
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/test_server.py tests/hermes_agui/test_http_lifecycle.py
```

結果：**10 passed / 0 failed**。兩輪覆蓋最終 **30 個不同測試案例**（Phase 1 10 個、Phase 2 20 個）；
不是宣稱最後一次單獨指令跑了 30 個。所有取消／斷線測試以 Events 同步，不用固定 sleep。

靜態驗證：

```bash
.venv/bin/python scripts/check --only ruff,health --base HEAD
.venv/bin/python scripts/check --base HEAD
git diff --check
```

Ruff、code-health 通過（0 blocking / 0 advisory），`git diff --check` 通過。
完整 check 的 17 項中 11 項通過，6 項仍因 checkout 原先缺少以下 helper 而無法執行：

- `scripts/ci/check_os_marker_fakes.py`
- `scripts/ci/check_agents_md_size.py`
- `scripts/ci/check_line_endings.py`
- `scripts/ci/check_lazy_deps_imports.py`
- `scripts/ci/check_profile_archive_boundary.py`
- `scripts/ci/check_blob_size.py`

此限制與 Phase 1 相同，未宣稱全 CI 綠燈；本階段沒有擴充補回 CI infrastructure 的範圍。
另外已驗證 CLI `--help`；未執行 CopilotKit UI、Docker 或真實遠端 LLM 驗收，屬後續階段。

## Architecture Notes

新增 runtime 依賴為官方 AG-UI SDK；FastAPI/Uvicorn/Starlette 與既有 `web` extra 相同版本，
AnyIO 宣告為直接依賴並沿用鎖定版本。建構／turn／DB／tool execution 全部委託原生 Headless
Service，HTTP 不阻塞 event loop。HTTP 斷線不等於已終止 worker：Adapter 一直持有 future。

風險與界線：

- 收據是程序內、有容量上限，部署限單 worker；跨重啟重試／多節點需要 Phase 4 持久收據。
- 同 thread 採拒絕而非排隊，符合計畫允許的策略。若後續改排隊須保留取消與授權邊界。
- 原生非合作工具可能延遲 shutdown，不強殺 thread，也不虛報已釋放資源。
- Token 是該 profile 的 owner credential；多租戶身份解析與 OS 沙箱尚未實作。
- 原生工具仍可執行，但不對外公開工具事件或 raw results；Phase 3 需明確設計敏感資訊遮罩。
- 原生 Python 例外在 HTTP 邊界泛化；刻意不把 provider exception traceback 寫入 HTTP 或日誌，
  因其中可能包含秘密或 prompt。兩個 catch-all 均有具體 code-health 註解說明。

## Next Step

Phase 2 功能完成。Phase 3 應新增真正的 `event_bridge.py`，接原生文字與 tool callbacks，
實作 thread-safe bounded queue/backpressure、message/tool ID 及事件順序驗證，保留目前的
認證、run ownership 和 disconnect cleanup。需補多工具、多輪 Loop、provider/tool 失敗與
串流中途斷線測試。尚未進行 Phase 3 或 CopilotKit 接線。
