# AG-UI 的 Hermes 原生能力（Phase 6）

AG-UI 僅負責輸入映射與事件公開。模型決策、工具執行、記憶／技能與 context management
都由 `AIAgent.run_conversation` 的既有路徑執行；CopilotKit 只觀察原生 callback。
Phase 6 以真實 Agent／HTTP／SQLite 和 loopback 模型驗證，沒有建立另一套記憶或壓縮系統。

## Tools

`hermes_agui/core/factory.py` 使用原生 provider/config resolver 與 `AIAgent` constructor。
未指定 `AgentConfig.enabled_toolsets` 時，沿用 `api_server` 的原生平台工具設定；可信 host
也可明確指定 enabled／disabled toolsets。前端 `RunAgentInput.tools` 不會變成 Hermes tools。

原生 `model_tools.get_tool_definitions`／`tools.registry` 提供 schemas 與 dispatch；
`agent/tool_executor.py` 執行工具，`agent/inline_tool_executors.py::_memory` 等原生 inline
executor 處理 agent-owned store。Adapter 不重新註冊這些工具，也不自行調用它們。

工具結果以 tool role 回到下一次模型請求；EventBridge 沿用 call ID 發出觀察事件。
預設公開投影 `[withheld]` 不會改變模型收到的原始結果。完整結果公開需由可信 host 的
`ServerConfig.tool_projection` 明確選擇，不從 browser request 授予權限。

## Memory：profile 級持久資料，conversation 級 prompt snapshot

原生 built-in memory 位於 `get_hermes_home()/memories/MEMORY.md` 與 `USER.md`。
`agent.agent_init._init_memory` 建立 `MemoryStore` 並 `load_from_disk()`；
`tools/memory_tool_store.py` 保存本 conversation 的 frozen system-prompt snapshot。

模型透過原生 `memory` tool 寫入，使用原生鎖與持久化操作。工具結果讓本輪模型知道
寫入是否成功；正在進行的 conversation 不因寫入或另一個 Thread 的修改而重讀 memory
並重建 system prompt。新建 Agent／Thread 可讀到磁碟的新記憶。

| 資料／資源 | 範圍與所有權 |
|---|---|
| 原生執行 history、工具 task state | 每個 Thread 對應獨立 native Session |
| 目前 Agent 的 memory／auto-loaded skills／context-file prompt snapshot | 每個 Agent 的 conversation；原生 compression 是允許的重建邊界 |
| built-in MEMORY.md、USER.md | profile home；同一 profile 的 Thread 共用 |
| 同一 home 的不同 `principal` | history ID 不同，但 built-in memory／skills 仍共用 |
| 外部 memory provider | 原生 provider／MemoryManager 決定 backend、租戶與 session scope |
| workspace、project skills／AGENTS.md | 可信 host 指定的 cwd 與原生搜尋根目錄 |

因此，`principal` 或 `threadId` 本身不提供長期記憶／檔案系統的租戶隔離。需要分離
使用者資料時應使用不同可信 home，並分配合適的 workspace／OS 權限；AG-UI 不更改
Hermes 的 profile 共享語意。

### 外部 provider 與 flush

`memory.provider` 沿用原生選擇機制：`agent.agent_init_memory_provider.resolve_memory_provider`
解析 provider，`MemoryManager` 初始化、注入工具與執行生命週期。每個 Agent 擁有獨立
provider instance，provider 必須遵守原生 profile binding 契約。

- `system_prompt_block` 是靜態內容；動態 recall 走原生 prefetch／user context，維持 prefix。
- 完整原生 turn 透過 `sync_all` 排入 `sync_turn` 與後續 prefetch，使用原生 context-bound
  worker；中斷／未完成 turn 的記憶同步策略仍由 core 決定。
- `HermesAgentService.evict()`／`close()` 在 owning profile scope 中呼叫 `agent.close()`。
  原生 `shutdown_memory_provider` 呼叫 `on_session_end`，`shutdown_all` 先處理背景佇列再
  關閉 provider，並通知 context engine 的 `on_session_end`。重複 close 不重複 extraction。
- HTTP Run 完成或斷線不等於 session end，不會每個 request 都重新抽取／重載記憶。
  原生 session rotation／compression checkpoint 若產生生命週期事件，仍由 core 處理。
- built-in memory tool 寫入當下即持久化，不需要 CLI 的額外 flush。外部 provider 的
  extraction／flush 經原生生命週期運作，也不需要啟動 CLI 或 Messaging Gateway。
  具體 provider 的外部服務與 credentials 仍由該 provider 管理。

驗收 provider 是實作原生 ABC 的本機觀察器，只替換 loader seam；MemoryManager、
Agent、背景 worker 與 teardown 都是真實實作。這驗證宿主的延伸介面，並非聲稱所有
第三方 provider 的遠端服務或資料隔離都已逐一驗證。

## Skills：原生 discovery、auto-load 與按需載入

`tools.skills_tool.skill_search_dirs` 與 `agent.skill_utils.get_skill_search_roots` 使用原生
搜尋順序、啟用狀態與 profile／project／plugin roots；AG-UI 沒有另建 skill catalog。
技能依賴本機／宿主可讀的路徑，workspace 與 profile 的可見範圍由可信 host 決定。

- 系統 prompt 內的 available-skills index 由原生 prompt builder 建立。
- `skills.auto_load` 經 `agent.skill_commands.build_auto_load_prompt` 與
  `agent.system_prompt._auto_load_parts` 注入；一個 Agent lifecycle 只解析一次。
- 模型按需執行 `skill_view`，以原生 tool result 讀取技能內容，不修改舊 system prompt。
- 原生 `skills_index_delta` 可將安裝／移除的差異送在後續 user-note channel；Adapter
  不強制刷新 index 或替換快取 prefix。
- 原生 catalog 有 process-wide cache，但搜尋簽章包含實際 roots／檔案與 disabled 狀態。
  驗收在同一程序、不同 profile 讀取同名但不同內容的技能，確認工具結果不混用。
  不清空全域 cache 來讓隔離測試通過。

## Context Management

原生 prompt builder 組裝 system prompt、memory snapshot、skills 與 workspace AGENTS.md；
Agent 保留 prompt／tool snapshots。HTTP 測試在執行中更新技能與 workspace context file，
確認既有 Thread 的 system prompt／tools 不變，新 Thread 才載入新快照。

`agent.agent_init._build_context_engine` 沿用 `compression` 與 `context.engine` 原生設定。
內建 `ContextCompressor` 管理 token window、tail protection、tool-result pruning、摘要與
持久化；自訂 context engine 仍透過原生 loader 和 ContextEngine hooks 運作。
沒有新增 AG-UI compression endpoint 或另一套 context window 算法。

壓縮驗收由 loopback provider 回報高 context usage，驅動下一輪原生自動壓縮；確認：

1. 實際發生 auxiliary summary call，並非 Adapter 刪除訊息。
2. 摘要進入模型請求及 SQLite 的 model history，後續請求確實縮小。
3. 原始完整對話保留在原生 display history，沒有當作模型 context 再次注入。
4. HTTP app 重建後，從 native SessionDB 恢復摘要並繼續對話。

自訂 engine 驗收另確認每個 Thread 有自己的 instance、請求選擇／usage／turn-complete
hooks 仍運作，且 eviction／shutdown 在 owning scope 觸發 session-end。

執行方式與結果見 [Phase 6 report](phase-6-report.md)。Phase 6 沒有擴大原生 unattended 權限。
Phase 7 的 tool approval、clarify 與 interrupt resume 見 [HITL](agui-human-input.md)。
