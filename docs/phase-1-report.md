# Phase 1 交付報告

## Implementation Summary

新增純 Python `HermesAgentService`，直接使用原生 `AIAgent.run_conversation`：

- 原生設定、provider resolution/fallback、toolsets、Memory、Skills 與 ContextEngine。
- 原生文字／工具 Callback 注入，不自行產生 AG-UI JSON。
- 每 Service 一個可信 principal/profile，每 Session 一個 Agent；同 Session 串行。
- Hermes SQLite 為 history 權威，外部 ID 穩定映射，支援 eviction 後與 Service 重建後恢復。
- 原生 durable lease、有界背景 executor、帶 run ID 的 active-run cancellation。
- profile scope 包含 construction/run/cancel/eviction/shutdown，caller context 不被改寫。

使用方式與限制見 [agui-architecture.md](agui-architecture.md)。本階段不包含 HTTP/SSE、
AG-UI encoder、完整 queued-run cancellation、request retry 去重或 CopilotKit 範例。

## Files Changed

新增：

- `hermes_agui/__init__.py`、`hermes_agui/core/__init__.py`。
- `hermes_agui/core/factory.py`、`hermes_agui/core/service.py`。
- `hermes_agui/session_manager.py`、`hermes_agui/execution_manager.py`。
- `tests/hermes_agui/test_headless_agent.py`、`test_session_lifecycle.py`、`test_execution_manager.py`。
- `tests/agent/test_headless_history_admission.py`。
- `tests/gateway/test_multiplex_session_id.py`。
- 本報告與 `docs/agui-architecture.md`。
- `scripts/ci/list_os_marked_tests.py`、`scripts/ci/profile_scope_patterns.json`：補回 checkout
  缺少、但現有 runner/code-health 無條件引用的 upstream 檔案，讓測試與針對性靜態檢查可重現。

修改：

- `agent/turn_facade.py`：公開 turn 入口增加預設 False 的 `reload_history`，只轉交 admission。
- `agent/turn_facade_lease.py`：storage-owned caller 可要求即使無 contention，也在取得 lease
  後讀取 canonical history。既有 caller-owned history 預設不變。
- `gateway/session_context.py`：multiplex 模式設定 session ID 時只更新 ContextVar，
  不寫入共用 `os.environ`；保留單一 CLI 的既有 fallback。
- `pyproject.toml`：將 `hermes_agui` 納入 setuptools package discovery。
- `docs/architecture-audit.md`：補充 Phase 1 動態驗證後的發現。

未刪除原始 Hermes 模組，未改動 conversation loop、tools dispatch、system prompt 或工具表。
未新增第三方 Python 依賴。已執行 `hermes pm lock`，結果為 lock 已符合 metadata，`uv.lock` 無變更。

## Tests

測試環境透過 `pm.build_env` 建立，Python 3.14.6，fake provider 只綁 loopback，不消耗模型 token。
原生 lease 歷史讀取契約先在 base 證明紅燈：新選項尚不存在時，1 failed / 1 passed；
加入實作後兩項均通過。
另新增 caller context 契約先抓出原生 session ID helper 對 `os.environ` 的寫入，
在修正前實際失敗；以 multiplex／legacy CLI 契約及既有 delegation/context 測試驗證修正。

原生回歸與 Headless 整合：

```bash
HERMES_PYTHON=/private/tmp/hermes-agui-test-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/ \
  tests/agent/test_headless_history_admission.py \
  tests/agent/test_cross_process_turn_lease.py \
  tests/hermes_state/test_session_turn_lease.py \
  tests/gateway/test_multiplex_session_id.py \
  tests/gateway/test_delegation_session_id_leak.py \
  tests/gateway/test_session_context_inheritance.py \
  tests/ci/test_list_os_marked_tests.py
```

最終結果：**76 passed / 0 failed**（10 個檔案；helper 另有平台條件跳過）。包含真實 provider streaming transport、file tool 成功／失敗、
inline memory 寫入、skill_view、history 恢復／隔離、原生 lease、授權拒絕、有界 executor、
並發與 active cancellation。並發測試以 Event 同步；冷啟動與全庫掃描同時執行曾超過 30 秒，
已將等待界線放寬為 120 秒，不以重試掩蓋測試失敗。

最終 Service 的 task/session scope、無 terminal input、caller context、multiplex publication
與 legacy CLI／delegation 相容性，以及補回 runner helper 的既有測試，均在上述最終結果內。

`scripts/check --only ruff,health --base HEAD` 通過，0 blocking / 0 advisory；`git diff --check` 通過。

**完整 scripts/check 尚不能宣稱通過。** 此 checkout 原本缺少整個 `scripts/ci`。
為排除基礎設施問題，曾暫時下載 upstream 檢查腳本；它們在 checkout 外會因原生
`__file__.resolve()` 的 repo 定位方式而失效，不應將該情況當成實作通過。
補回上述兩個必要 dependency 後，其餘 6 個完整 CI helper 仍未納入本次改動：
`check_os_marker_fakes.py`、`check_agents_md_size.py`、`check_line_endings.py`、
`check_lazy_deps_imports.py`、`check_profile_archive_boundary.py`、`check_blob_size.py`。
完整檢查須先由專案另行恢復這些 baseline 檔案；沒有跳過或放寬它們的規則。
最終再次執行 `scripts/check --base HEAD`：11 checks 通過，6 checks 因上述檔案不存在失敗；
當次 code-health 仍為 0 blocking / 0 advisory。
臨時驗證工具與多餘的 `.venv-headless` 已從 checkout 移除。

包裝驗證：PM 新建 editable environment 後，從 checkout 外成功匯入
`hermes_agui.core`，且匯入時沒有載入 `run_agent`。一般 wheel build 被原生 `setup.py`
明確禁止，因此沒有假設或繞過 build guard；Nix wheel／Docker 是後續 runtime packaging 範圍。

補回的 upstream helper 來源為 NousResearch/hermes-agent `main`，下載日期 2026-11-14：

- [list_os_marked_tests.py](https://github.com/NousResearch/hermes-agent/blob/main/scripts/ci/list_os_marked_tests.py)
  SHA-256 `cfa4b25ca26d613151046b0878bad767218e7c9c561251329b6dbc3e14648606`。
- [profile_scope_patterns.json](https://github.com/NousResearch/hermes-agent/blob/main/scripts/ci/profile_scope_patterns.json)
  SHA-256 `1ae523c1d825da8738fbf9294b03dac7c212bfd4e79c9184ca2bff51fb45f401`；
  保留 upstream 原檔，未放寬 code-health policy。

## Architecture Notes

Phase 0 的靜態結論大致成立，但進一步發現「Adapter 先讀 history，再進 native lease」
仍有未競爭時的讀取競態，因此增加窄的 opt-in admission 選項。該選項不改 Loop、不自行鎖 DB、
不修改過去 messages 或 tools snapshot；實作在既有 lease sibling，facade 只委派。
另一個窄修正是 multiplex session ID publication：原生 helper 原本即使在私有 Context
仍會改寫程序環境，現改成 multiplex 模式僅更新 ContextVar，避免其他 request／caller
透過 legacy env fallback 看見該 ID。

工具進度仍是 native payload，可能含 reasoning 提示或未過對外授權的工具內容；不得直接
當作 wire event。blocked／invalid／skipped 工具的完整事件補帳、message boundaries、
async queue backpressure、disconnect 都仍屬後續 Event Bridge 的工作。

跨 profile 的記憶／技能／憑證路徑隔離有測試；跨租戶 OS sandbox、真實外部 memory providers、
所有 terminal/browser backend 的最壞取消時間，並未因此獲得保證。x86_64 macOS 的 native
Relay wheel 不在依賴適用平台內，本次走既有 no-op Relay fallback；SQLite 使用原生
journal fallback policy，未為測試強制改 WAL。

## Next Step

Phase 1 的純 Python功能可供後續 Adapter 使用。進入 Phase 2 前，應先恢復 checkout
缺少的完整 CI helper，並鎖定官方 AG-UI SDK／CopilotKit 相容版本。
Phase 2 的 execution manager 需補排隊、建構與 active 狀態間的完整取消機制及 request 去重，
再接 HTTP/SSE；不得只對 awaitable 執行 cancel 就宣稱原生工作已停止。
