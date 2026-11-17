# Runtime Memory Layer — Part 1

本階段實作 Graph **read path**，不包含 Bot Manager、Graph DB 或自動抽取／寫入。

## 執行路徑

`createApplication` 建立既有 `GraphMemoryPort` 邊界、`MemoryRetriever`、
`ContextAssembler`、`RuntimeMemoryManager` 及 `RuntimeMemoryMiddleware`。
宣告 `memory` 能力的 Bot 每次新 Run 都會查詢；沒有 Context cache。
查詢 scope 的 Principal、Project、Bot 由後端部署設定決定，Thread、Run 來自本輪傳輸識別。
這個範例延續既有的 local-owner／loopback 身分模型，沒有新增多使用者登入系統。

Graph 層先驗證授權及 scope，再套用兩秒 timeout（可設定）。停用、故障及 timeout 回傳空記憶；
授權拒絕、無效請求及 provider 跨 ACL 回傳則停止本輪，不能當成一般故障降級。
FakeGraphProvider 只提供測試用的唯讀資料，正式 Provider 可替換既有 port。

Assembler 保留 provider 的相關性順序，依 record ID 和完整 content 去重，最多 20 筆。
Context JSON 的 UTF-8 byte 數預設限制為 4096，保守作為 token 上界（不依賴 LLM）。
查詢文字最多取前 4093 UTF-8 bytes；使用者原文不變。

## Trusted Context Bridge

使用 AG-UI 官方 `forwardedProps.runtimeMemory`，內容為 `{payload, signature}`：

- payload 是 base64url JSON，包含 Bot、Thread、Run、Principal、Project、expires、MemoryContext。
- signature 是對 payload 的 HMAC-SHA256，採用獨立於 Bot Bearer token 的後端 signing key。
- Hermes 驗證目標與有效期，拒絕額外欄位及不符 schema 的 records。
- envelope 最多 16000 characters；解碼後 Context JSON 最多 8192 bytes。
- 既有持久化 admission receipts 阻止相同 Run／Message 的重放，包括程序重啟後。
- 瀏覽器不能提交自製 forwardedProps；一般 tools、context、state 的限制保持原有行為。
- 中斷 resume 沿用原本執行中的 Context，不重新檢索或替換它。

只有部署方明確宣告 `memory` 的 Agent 才會獲得此通道；其他 Agent 維持原路徑。
若遠端 Agent 不支援此契約，請勿宣告此能力。Bridge 驗證失敗不會聲稱注入成功。
簽章只證明資料來源；記憶文字仍為低信任參考資料，不能授權工具或改變 policy。
請使用 TLS 保護跨機器傳輸，並為每個 Bot 配置獨立 signing key。

## 設定

CopilotKit 的 bots JSON（例如啟動時 `AGUI_BOTS_CONFIG` 指向的檔案）：

```json
{
  "bots": [{
    "id": "researcher",
    "agentUrl": "http://127.0.0.1:8000/bots/researcher/agent",
    "tokenEnv": "RESEARCHER_API_KEY",
    "memory": {
      "keyEnv": "RESEARCHER_RUNTIME_MEMORY_KEY",
      "principal": "local-owner",
      "projectId": "alpha"
    }
  }]
}
```

Hermes Host YAML 的對應 Bot：

```yaml
bots:
  - id: researcher
    token_env: RESEARCHER_API_KEY
    agent:
      home: ./researcher-home
      cwd: ./researcher-workspace
      principal: local-owner
    server:
      runtime_memory_key_env: RESEARCHER_RUNTIME_MEMORY_KEY
      runtime_memory_project: alpha
```

上述環境變數只存 secrets；行為設定仍在 JSON／YAML。兩端 signing key 必須相同。
若透過 Python 工廠建構，可設定 `ServerConfig.runtime_memory_key` 與
`runtime_memory_project`；透過 TypeScript 工廠可設定 `RuntimeSettings.memory`。

Provider 由後端 composition 注入，不接受瀏覽器指定：

```typescript
createApplication(bots, {
  graph: {
    provider: new FakeGraphProvider(records),
    authorize: scope => scope.principal === "local-owner" && scope.projectId === "alpha",
    timeoutMs: 2000,
  },
});
```

未提供 Provider 時仍可宣告能力，送出空 records 並使用 Hermes 原生記憶。
未設定 memory 的直接 AG-UI 呼叫完全不需要 signing key。

## 原生模型與儲存

驗證後的 Context 透過 ContextVar 隨原有 ExecutionManager 的 thread scope 傳遞，
不寫入 AIAgent 的可變全域屬性。原生 request assembly 只修改目前 user row 的結構化
**傳送副本**，新增明確標記為 untrusted reference 的 text part；不串接使用者原文，
不建立假的對話列，也不修改 system prompt、工具清單或 Hermes Agent Loop。

SQLite、session history、回傳的原始 messages 與原有 api_content sidecar 不含 Graph records。
原生 MEMORY.md、USER.md、Skills、Session Recovery 及 Compression 保留。
同一 Run 的 tool loop 重複使用同份 Context；下一 Run 重新檢索，不沿用上一輪 records。

### 已知取捨

「完全不持久化 Graph Context」與「下一輪回放 byte-identical 的完整 provider request prefix」
無法同時成立：下一輪歷史中的 user row 不帶上輪參考 text part，可能造成該位置之後的 cache miss。
System Prompt 及原生歷史前綴不重建，但不能宣稱整個 request prefix cache 完全不受影響。
本實作優先遵守計畫的零 history 污染與無陳舊 Context 要求。

此入口針對共用原生 request assembly；跨語言驗收使用 Chat Completions 的 fake model。
未逐一驗證所有外部 provider／特殊 native transport 對 text parts 的支援。
Compression 不讀取 runtime-only records，因為它們不屬於 canonical history。
資料區塊與簽章不提供 LLM 對 prompt injection 的形式化保證。

既有 DelegationCoordinator 仍直接呼叫 Hermes；Child Run 的 Runtime Memory pipeline 接入
依計畫 §5.10 留在 Part 2。本階段沒有改變 delegation 行為。

## 驗證

- Vitest：Graph ACL、跨 Bot／Principal／Project 隔離、去重、budget、timeout、停用、簽章與每輪更新。
- Python native HTTP：驗證實際 fake-model request 含 Graph records、下一輪清除、System Prompt 不變及 SQLite 無污染。
- Bridge：偽造／跨 Bot／Thread／Run 的 envelope 拒絕，已接收 Run 重放拒絕。
- 跨語言驗收：Python 啟動真實 Hermes HTTP Host，Node 執行官方 CopilotKit Runtime 與 FakeGraphProvider；
  確認「Project Alpha 使用 PostgreSQL」進入原生 provider request，並檢查 SQLite。
  這不僅驗證 middleware 被呼叫；模型是 loopback fake provider，不需要真實 API credentials。

執行：

```bash
cd examples/copilotkit
npm test
npm run build
cd ../..
HERMES_PYTHON=/path/to/agui-test-env/bin/python scripts/run_tests.sh tests/hermes_agui/
python scripts/check
```

跨語言驗收需要 Node 在 PATH 且已安裝 example 的 node_modules，否則該項會明確 skip。
完整執行結果會在本文件末尾記錄。

## 本次執行結果（2026-11-17）

- TypeScript：4 個檔案、17 個測試全部通過。
- `npm run build`：通過；最終修改後 `tsc --noEmit` 再次通過。
- AG-UI 完整回歸：既有測試通過；首次執行新增跨語言測試遇到 fixture 問題，
  修正後整個新增測試檔重跑 3/3 通過，包含實際 Runtime → Hermes → fake model → SQLite 驗收。
  分次執行合計 74 個測試通過；容器測試未啟用。
- 修改範圍的 Ruff 與 `git diff --check` 通過。
- `scripts/check` 已執行：17 項中 10 項通過，7 項因現有 checkout 缺檔無法完成。
  缺少 `scripts/ci/check_os_marker_fakes.py`、`check_agents_md_size.py`、
  `check_line_endings.py`、`check_lazy_deps_imports.py`、`check_profile_archive_boundary.py`、
  `check_blob_size.py`，以及 TypeScript health resolver 需要的根目錄 `package.json`。
  未替本階段重建這些專案基礎設施，故不能宣稱完整 CI checks 全綠。

Part 2 尚未開始。正式 Graph DB、動態 Bot CRUD、Delegation Child Run 的共用 Runtime pipeline，
以及特殊 provider transport 的逐一驗證仍屬後續工作。

後續進度：Part 2 已續作，請參閱 [Dynamic Bot Manager 報告](runtime-memory-bot-manager-part-2.md)。
