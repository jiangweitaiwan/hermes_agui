# Phase 3：AG-UI Event Bridge

## Implementation Summary

基準 commit：`5dda84370d67`（本地提交標題為 `add:phase 3`，其檔案內容是 Phase 2
的 buffered HTTP Server）。本階段實作計畫書 M3，未進入 Phase 4/5。

新增 `EventBridge`，將 Hermes 原生 callback 正規化到有界 mailbox，再由 ASGI loop
轉成官方 SDK 1.0.0 的事件。文字在 native turn 完成前送出；不重送整份 final response。
原生沒有增量工具參數 callback，因此完整安全投影一次送為 `TOOL_CALL_ARGS`，接著
`TOOL_CALL_END`；執行結果獨立送 `TOOL_CALL_RESULT`，不轉成 assistant final answer。

事件規範依據：[AG-UI 官方 Events](https://docs.ag-ui.com/concepts/events)。
實際 SDK 的事件模型與 SSE encoder 維持原依賴，測試以官方 `Event` union 驗證輸出。

## Files Changed

新增：

- `hermes_agui/event_bridge.py`：callback mailbox、文字/tool IDs、事件順序與去重、容量失敗。
- `tests/hermes_agui/test_event_bridge.py`：增量抵達、平行/多輪工具、順序、投影及滿載測試。
- `docs/phase-3-report.md`：本報告。

修改：

- `hermes_agui/adapter.py`：每個 Run 擁有 bridge，向原生 Service 注入 callback。
- `hermes_agui/server.py`：即時消費 bridge，保留既有 ASGI disconnect watcher。
- `hermes_agui/config.py`：可信 host 的容量與工具公開投影設定。
- `tests/hermes_agui/test_server.py`：native 多輪工具、成功/失敗工具、推理不公開及串流驗證。
- `tests/hermes_agui/test_http_lifecycle.py`：首個 delta 後斷線、ASGI 2.0/2.4、滿載取消。
- `docs/agui-server.md`、`docs/agui-architecture.md`：更新行為與嵌入方式。

沒有刪除檔案、修改原生 Agent Loop、Tool Dispatch、Memory、Skills、Context 或 persistence。
沒有新增依賴，`pyproject.toml` / `uv.lock` 不變。

## Tests

測試使用 Phase 2 的 PM 隔離環境與 loopback FakeLLMServer，沒有消耗真實模型 token。
命令：

```bash
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/
.venv/bin/python scripts/check --only ruff,health --base HEAD
git diff --check
```

最終完整回歸：**7 files、43 passed、0 failed**（50.6 秒，3 workers）。
Ruff / code health：0 blocking、0 advisory；`git diff --check` 通過。

曾有一筆新增測試的 assertion 錯把第二次 read_file 的原生去重結果當成完整內容；
確認原生回傳 `status=unchanged` 後修正預期，最終完整重跑通過，沒有停用 native 去重。
Sandbox 下的首次 runner 被 OS 拒絕建立子程序，沒有收集測試；
重新在允許子程序與 loopback 的環境執行，不能把首次的零收集視為通過。

另執行 `.venv/bin/python scripts/check --base HEAD`：17 個檢查中 11 個通過，
6 個因 baseline 已缺少下列 helper 而無法執行，與 Phase 2 相同，**不宣稱完整 CI 綠燈**：

- `scripts/ci/check_os_marker_fakes.py`
- `scripts/ci/check_agents_md_size.py`
- `scripts/ci/check_line_endings.py`
- `scripts/ci/check_lazy_deps_imports.py`
- `scripts/ci/check_profile_archive_boundary.py`
- `scripts/ci/check_blob_size.py`

驗證重點：

- 首個文字 delta 在 native future 完成前可讀，不是完成後切字串假串流。
- 同一訊息 start/content/end 的 ID 穩定，已串流文字不再輸出整份 final；prefix fallback 只補尾段。
- 多輪 native read_file 成功與失敗均保留模型的 tool result，UI 僅見安全投影。
- 平行 callback 保持每個 call 的 start → args → end → result；相同 ID 不重送。
- 斷線與 queue overflow 都保留 Adapter 的工作所有權，等待 native future settled。
- partial/provider 例外與投影例外以泛化 RUN_ERROR 結束，不再 RUN_FINISHED。

尚未進行 CopilotKit UI、遠端真實 Provider、Docker 或完整平台測試；屬後續里程碑。

## Architecture Notes

### Native 邊界

只注入四個既有 callback：

| Native callback | 事件 |
|---|---|
| `stream_delta_callback(text/None)` | 文字 start/content/end；None 關閉目前文字段落 |
| `interim_assistant_callback(text, already_streamed=...)` | 未顯示 commentary 的文字訊息，已串流則只關閉 |
| `tool_start_callback(call_id, name, args)` | start + 完整投影 args + end |
| `tool_complete_callback(call_id, name, args, result)` | result，沿用 native call ID |

`agent/stream_delivery.py` 的 native 顯示 delta 已通過 think/context scrubber；不註冊
reasoning callback，也不發布可能含推理的 tool_progress/status/notice、raw messages。
Native callback 的 blocked/invalid/skipped 路徑缺口維持原限制，沒有虛構執行結果；
因此這是 executed-tool observer，不是完整審計日誌。Tool 失敗可由原生模型繼續處理，
不等同整個 Run 失敗。

### Backpressure 與生命週期

Native worker 只在 lock 下寫 deque，使用 `loop.call_soon_threadsafe` 喚醒 ASGI；不從
worker 寫 asyncio.Queue。只在 mailbox 空 → 非空時喚醒，避免無界通知堆積。
預設 pending 256 項、UTF-8 payload 合計 1 MiB；另限制單一回覆文字 1 MiB、每 Run
追蹤 256 個 tool IDs（ID bytes 合計最多 1 MiB）。consumer 每次取出的 batch 同樣受限。

採「容量滿即失敗並合作取消」策略，不靜默丟棄後宣告成功，也不阻塞 provider reader。
已公開的 partial text 無法撤回，會先關閉文字訊息再 RUN_ERROR；非合作工具仍可能延遲
取消與 shutdown。Response disconnect 不取消 Adapter task，直到 native future settled。

### 公開資料策略與風險

工具輸出任意且可能包含檔案與秘密，預設 arguments/result 都輸出合法 JSON
`{"content":"[withheld]"}`。可信 Python host 可提供 `tool_projection(kind, name, value)`，
只公開經審核的欄位；投影同步在 callback 所在 thread 執行，必須 thread-safe、快速且
無互動。錯誤/不可序列化/NaN 投影終止 Run，不紀錄原始值或例外內容。
這是 UI 投影，不改變模型收到的原生參數/結果。預設 UI 能觀察 call/result 的存在，
無法讀取原始 payload；並不宣稱通用 secret redaction 能安全公開任意工具輸出。

native 關閉 stream 或 hold_stream 時使用 completed final fallback；已有可見 final delta
時不再次發送整份完成文字；若 fallback 僅補齊前綴，則只送缺少的尾段。已送 delta 無法用最終修訂文字覆寫，變換輸出的 native plugin
應沿用原生 hold_stream 機制。文字內容仍由 profile owner 決定工具/provider 的可信範圍。

## Next Step

Phase 4：檢查並補齊 Thread/Session 的持久對應、跨重啟重送策略、授權與並發行為。
目前 admission/receipts 仍為單程序記憶體狀態，仍只支援單 ASGI worker、一個固定
principal/profile。Phase 3 不改變這些範圍；尚未開始 CopilotKit integration。
