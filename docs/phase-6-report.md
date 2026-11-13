# Phase 6：保留 Hermes 原生能力

## Implementation Summary

基準 commit：`de1e3057d713`（`add:phase 5`）。完成計畫第 8 節的原生能力盤點與動態驗收。

確認現有 AG-UI host 已透過原生 AIAgent 保留 Tools、Memory、Skills 與 Context Management；
本階段沒有找到需要修改 runtime 的缺口，因此新增實際行為驗收與文件，沒有另建平行系統，
也沒有修改 core／adapter、system prompt 或模型 tool surface。

驗收重點：

- HTTP Run 執行原生 memory 寫入與 skill_view；模型收到真實 tool result，UI 投影仍遮蔽。
- 原生 memory／skills.auto_load／workspace context 的現有 Thread prompt 與 tools 保持穩定；
  新 Thread 才讀到磁碟更新；新 Thread 的 history 不回填舊 Thread。
- 同一程序的不同 profile 讀取同名技能，內容與記憶都使用各自 home；不清除 catalog cache
  來迴避隔離測試。
- 原生 MemoryManager 的背景 sync、session-end extraction 及 shutdown 都使用 owning
  profile 的 home／秘密；eviction 與 close 會 flush，Run 完成不會提早 session-end。
- 配置的原生 ContextEngine 收到 request selection、usage、turn-complete 與 session-end
  hooks，且各 Thread instance 不共享 mutable state。
- 由模型回報高 context usage 驅動原生自動壓縮，實際呼叫 auxiliary summarizer；摘要保存於
  model history，完整舊回覆保留於 display history；HTTP app 重建後繼續使用壓縮歷史。

## Files Changed

新增：

- `tests/hermes_agui/conftest.py`：temporary profile/workspace 與 loopback provider 設定 fixture。
- `tests/hermes_agui/test_native_capabilities.py`：2 個 HTTP 行為契約，涵蓋 memory／skills／
  workspace prompt snapshot、tool result、profile 隔離及不變的 prompt/tool prefix。
- `tests/hermes_agui/test_native_memory_lifecycle.py`：原生 MemoryManager 的同步／抽取／
  shutdown 與 profile/secret/thread scope；僅 loader 回傳本機 ABC observer，manager／Agent
  與 worker 均為真實實作。
- `tests/hermes_agui/test_native_context_engine.py`：原生配置 loader 接入 ABC observer，
  驗證每 Thread engine state 及 native hooks，不替換 conversation loop。
- `tests/hermes_agui/test_native_compression.py`：真實 ContextCompressor、auxiliary HTTP、
  原生 SQLite model/display projections 與跨 app restart。
- `docs/agui-native-capabilities.md`：原生路徑、共享／隔離語意、配置、flush、cache 與壓縮說明。
- `docs/phase-6-report.md`：本報告。

修改 `docs/agui-architecture.md`、`docs/agui-server.md` 與
`examples/copilotkit/README.md`，連結能力說明並明確說明 Thread 與 profile 的差別。
沒有刪除檔案、增加依賴或修改 `pyproject.toml`／`uv.lock`／JS lockfile。

## Architecture Notes

### History 隔離不等於長期記憶隔離

原生 built-in MEMORY.md／USER.md 與 profile skills 屬於 home，不屬於 Thread。
同 home 即使使用不同 principal，仍共用這些檔案；Session ID 的 principal namespace
只隔離執行歷史。多使用者若需要分離資料，必須分配不同可信 home、workspace 與權限。
本階段保留原生語意，不以重新載入 memory 或更動 prompt 來模擬 Thread 私有記憶。

### Prompt caching 與 lifecycle

`_init_memory`／MemoryStore、system_prompt 的 skills auto-load、原生 prompt builder
仍負責快照；工具執行與動態 recall 不重建舊 prefix。壓縮是原生允許的 cache-break 邊界。
Service 在 owning scope 呼叫 agent.close，原生 MemoryManager 與 ContextEngine 處理
session end。session-end 不需要啟動 CLI／Gateway process，亦不等於每個 HTTP request 結束。

### 驗證界線

外部 provider／engine 的 loader observer 用於驗證現有延伸介面與生命週期；沒有聲稱所有
第三方 plugin 的遠端服務、credentials 或 tenant 隔離都已逐一驗證。壓縮、built-in memory、
skills、工具執行、HTTP 與 persistence 都使用真實原生實作，僅模型 transport 為 loopback fake。

本次不改變 approval、clarify 或 tool execution policy；完整 HITL／resume 留在 Phase 7。
不重跑沒有程式碼變更的 CopilotKit JS/browser suite；Phase 5 的 UI E2E 證據保留於前階段報告。

## Tests

命令：

```bash
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/
.venv/bin/python scripts/check --only ruff,health --base HEAD
.venv/bin/python scripts/check --base HEAD
git diff --check
```

環境沿用前階段的隔離 Python test env；所有測試使用 temporary HERMES_HOME 與 loopback，
不寫入個人 profile，不使用真實 Provider token。

新增壓縮測試曾因過度重複的 fake answer 觸發原生 repetition guard；改用不重複內容後
保留防護繼續驗收。另一個 assertion 曾把多行訊息與 Python repr 比較；已改成直接比較
model/display message content，並確認 display 保留全部五份原回覆，model projection 已縮小。
沒有停用保護、略過測試，或將這些測試資料／assertion 問題當成 production bug。

最終完整回歸：**12 files、51 passed、0 failed**，137.7 秒，3 workers。
其中新增 **4 個測試檔／5 項行為契約**；全部使用真實原生流程，沒有消耗付費模型 token。
Ruff／code health 通過，**5 measured files、0 blocking、0 advisory**；
`git diff --check` 通過。

完整 `scripts/check --base HEAD`：17 項中 11 項通過，6 項因基準 checkout 缺少以下
helpers 而無法執行，與前階段缺檔一致，不宣稱完整 CI 綠燈：

- `scripts/ci/check_os_marker_fakes.py`
- `scripts/ci/check_agents_md_size.py`
- `scripts/ci/check_line_endings.py`
- `scripts/ci/check_lazy_deps_imports.py`
- `scripts/ci/check_profile_archive_boundary.py`
- `scripts/ci/check_blob_size.py`

本次僅新增 Python 測試與文件，標準 health 不需要讀取缺少的 root JS manifest；
因此這次可直接通過，不需要 Phase 5 的 TypeScript resolver 補充方式。

## Next Step

Phase 7：Human-in-the-loop。需依原生 approval／clarify／interrupt 的實際可恢復介面設計
等待事件、授權決策、timeout／disconnect／重送與 resume，而不使用 terminal input。
此階段依計畫屬第二階段功能，不代表 Docker／部署或整體 MVP 最終驗收已完成。
