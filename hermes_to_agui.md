# Hermes Agent → AG-UI Agent 改造計畫書

**專案名稱：** Hermes AG-UI Adapter  
**原始專案：** https://github.com/NousResearch/hermes-agent  
**整合目標：** CopilotKit + AG-UI Protocol  
**實作方式：** Python Agent Core + AG-UI Adapter + HTTP/SSE  
**執行對象：** Codex  
**開發策略：** Incremental Refactoring（漸進式重構）

---

# 1. 專案目標

## 1.1 背景

Hermes Agent 是一套具備完整 Agent Harness 的開源 AI Agent，包含：

- LLM Provider 與 Model Invocation
- Agent Conversation Loop
- Tool Registration / Dispatch / Execution
- Conversation History
- Memory
- Skills
- Context Management
- Tool Execution Feedback
- Session Management

目前 Hermes 具有自己的 CLI、Gateway 等執行入口。

本專案希望將 Hermes 改造成一個可以透過 AG-UI Protocol 存取的 Headless Agent，使 CopilotKit 能夠將 Hermes 視為遠端 Agent。

目標架構：

```text
User
  │
  ▼
CopilotKit Frontend
  │
  ▼
CopilotKit Runtime (Node.js)
  │
  │ AG-UI / HTTP
  ▼
Hermes AG-UI Server (Python)
  │
  ▼
AG-UI Adapter
  │
  ▼
Hermes Agent Core
  ├── Agent Loop
  ├── LLM Provider
  ├── Tool Registry
  ├── Tool Executor
  ├── Memory
  ├── Skills
  └── Session / Context
```

## 1.2 核心原則

**保留 Hermes 的 Agent 執行能力，替換外部互動介面。**

本專案不應重新實作 Hermes Agent Loop、Tool System 或 Memory System。

應透過 Adapter 將既有功能轉換成 AG-UI Protocol。

原則如下：

1. 保留 Hermes 原生 Agent Harness。
2. 不重新實作 Agent Loop。
3. 不重新實作 Tool Registry / Tool Dispatch。
4. 優先重用 Hermes 原生 Memory、Skills、Session。
5. 將 CLI、Gateway 等平台入口與 Agent Core 解耦。
6. 透過 AG-UI Event Stream 向 CopilotKit 傳遞執行結果。
7. 不修改 Hermes 核心邏輯，除非現有介面無法支援必要功能。
8. 優先使用官方 AG-UI Python SDK，避免自行實作 Protocol。
9. 每個階段必須通過測試後才能進入下一階段。
10. 不得在未確認依賴關係前大量刪除原始碼。

## 1.3 MVP 範圍

第一版必須支援：

- CopilotKit 可以連線至 Hermes。
- Hermes 可以接收使用者訊息。
- Hermes 可以呼叫 LLM。
- Hermes 可以執行原生 Tools。
- CopilotKit 可以即時顯示文字 Streaming。
- CopilotKit 可以觀察 Tool Call / Tool Result。
- 同一 Thread 可以延續對話。
- 不同 Thread 的對話互相隔離。
- Agent 執行失敗時能回傳 AG-UI Error Event。

第一版暫不要求：

- 多 Agent Orchestration
- 複雜 Shared State
- 完整 Human-in-the-loop
- Browser-side Tool Execution
- 跨節點分散式 Session
- 多租戶權限管理
- 長期任務排程

上述功能應保留未來擴充空間。

---

# 2. Phase 0：原始碼分析與架構盤點

**本階段必須在修改任何程式碼之前完成。**

Codex 必須先檢查實際 GitHub Repository 與目前 Checkout 的程式碼。

不得直接假設本文列出的檔案、函式或參數一定存在於目前版本。

## 2.1 優先檢查的模組

| 模組 / 檔案 | 分析目的 |
|---|---|
| `run_agent.py` | 確認 AIAgent 入口與公開介面 |
| `agent/agent_init.py` | 確認 Agent 初始化與依賴 |
| `agent/conversation_loop.py` | 確認 Agent Loop 執行流程 |
| `agent/turn_*.py` | 確認單次 LLM Turn 與工具處理 |
| `model_tools.py` | 確認 Tool System 初始化 |
| `tools/registry.py` | 確認工具註冊與 Dispatch |
| `agent/callbacks.py` | 若存在，確認 Streaming / Tool Callback |
| `hermes_state.py` | 確認 Session 與持久化 |
| `agent/prompt_builder.py` | 確認 Prompt 組裝 |
| `agent/context_engine.py` | 確認 Context Management |

如果檔案已移動或更名，應搜尋實際定義與呼叫位置。

## 2.2 必須回答的問題

### A. Agent 初始化

1. Hermes Agent 如何建立？
2. 是否能不經過 CLI 直接初始化？
3. 初始化時是否依賴 Terminal UI 或 Gateway？
4. 是否有 import-time side effects？
5. Provider、Tools、Memory、Skills 在哪裡載入？

### B. Agent Loop

1. 哪個函式是實際執行入口？
2. Agent Loop 是同步還是非同步？
3. 一次 Request 如何進入 Loop？
4. Loop 如何呼叫 LLM？
5. Tool Call 如何執行？
6. Tool Result 如何回填 Messages？
7. Loop 如何判斷任務完成？
8. 是否支援 Cancellation？

### C. Streaming

1. 是否已有 Token Streaming Callback？
2. 是否已有 Tool Call Callback？
3. 是否能取得 Tool Call ID、Name、Arguments？
4. 是否能取得 Tool Execution Result？
5. Callback 是從哪個執行緒呼叫？
6. 是否可以注入自訂 Callback？

### D. Session

1. Hermes 如何辨識不同對話？
2. Session ID 如何產生？
3. Conversation History 如何儲存？
4. 是否可載入既有 Session？
5. 是否能讓外部指定 Session ID？
6. 是否支援同時執行多個 Session？

## 2.3 交付成果

建立：

`docs/architecture-audit.md`

內容必須包含：

- 真實模組依賴圖
- Agent 初始化流程
- Agent Loop 呼叫路徑
- Callback / Streaming 可用介面
- Session Persistence 實作
- CLI / Gateway 耦合點
- 可重用與需修改的元件
- 實際檔案路徑與函式名稱
- 版本或 Commit SHA
- 風險與待確認事項

**驗收標準：** 能夠從實際程式碼追蹤一次 User Request → LLM → Tool → LLM → Final Answer。

---

# 3. Phase 1：建立 Headless Hermes Agent

## 3.1 目標

讓 Hermes Agent 不依賴 CLI、Gateway 或其他 UI，就能被 Python 程式直接呼叫。

預期使用方式（概念介面，非現有 API）：

```python
agent = HermesAgentService(config)

result = agent.run(
    session_id="session-001",
    message="請分析目前目錄有哪些檔案"
)
```

以上為目標介面。Codex 應根據 Hermes 真正公開的 API 設計 Wrapper，不得直接假設存在 `HermesAgentService`。

## 3.2 建議新增模組

```text
hermes_agui/
  ├── core/
  │   ├── service.py
  │   └── factory.py
```

`factory.py`：

- 建立 Hermes Agent Instance
- 載入 Configuration
- 初始化 Provider
- 初始化 Tools / Memory / Skills
- 避免每個 Request 重複初始化昂貴資源

`service.py`：

- 封裝 Hermes Agent 的執行入口
- 接收 Session ID
- 接收使用者訊息
- 注入 Streaming Callbacks
- 傳遞 Cancellation
- 回傳執行結果

## 3.3 實作要求

- 不得在 Service 中重新實作 Agent Loop。
- 不得自行重新建立 Tool Dispatch。
- 必須保留 Hermes 原生 Context Management。
- 必須保留原生 Provider Configuration。
- 必須確認 Agent Instance 是否可安全重用。
- 不可假設 Agent Instance 在不同 Session 間天然隔離。
- 如果原生 Agent 是同步執行，應使用適當的 Thread Executor，不得阻塞 FastAPI Event Loop。

## 3.4 驗收測試

建立：

`tests/test_headless_agent.py`

至少測試：

1. 不啟動 CLI 即可初始化 Agent。
2. 可以完成普通文字對話。
3. 可以完成一次 Tool Call。
4. 可以取得 Tool Result。
5. 可以在同一 Session 延續對話。
6. 不同 Session 不會混用 History。

---

# 4. Phase 2：建立 AG-UI Server

## 4.1 技術選型

- Python
- FastAPI
- Uvicorn
- AG-UI Python SDK
- HTTP + Server-Sent Events

必須先檢查目前官方 SDK 版本及介面。

優先採用官方 SDK 的事件型別、編碼器、Request Model 與 Endpoint 整合方式。

不得自行定義與 AG-UI 不相容的事件 JSON。

## 4.2 建議新增目錄

```text
hermes_agui/
  ├── server.py
  ├── adapter.py
  ├── event_bridge.py
  ├── message_adapter.py
  ├── session_manager.py
  ├── execution_manager.py
  └── config.py
```

## 4.3 HTTP Endpoint

預期提供：

```text
POST /agent
GET  /health
```

`POST /agent`：

- 接收 AG-UI Run Input
- 驗證 Request
- 建立或取得 Session
- 呼叫 Hermes Agent
- Streaming 回傳 AG-UI Events

`GET /health`：

- 回傳 Server 健康狀態
- 不應暴露 API Key、Prompt 或其他敏感資訊

## 4.4 Request Adapter

將 AG-UI Input 映射到 Hermes：

| AG-UI | Hermes |
|---|---|
| `threadId` | Session ID 或其映射 |
| `runId` | 本次執行 ID |
| `messages` | 使用者輸入 / Conversation Context |
| `state` | 可選的共享狀態 |
| `tools` | 可選的前端工具宣告 |
| `context` | 可選的執行 Context |

應依目前 SDK 的實際 Input Schema 實作。

特別注意：

**不得將 AG-UI Messages 與 Hermes 已保存的 Session History 無條件串接。**

必須先確定 History 的權威來源，避免重複訊息與 Context 膨脹。

MVP 建議以 Hermes Session Storage 作為執行歷史的權威來源。

如果 CopilotKit 傳入完整 Messages，應有明確的 Reconciliation Strategy。

---

# 5. Phase 3：AG-UI Event Bridge

## 5.1 目標

將 Hermes 原生執行事件轉換為 AG-UI Event Stream。

這是本專案最重要的 Adapter。

## 5.2 Event Mapping

預期支援以下 AG-UI 事件：

| Hermes 執行行為 | AG-UI Event |
|---|---|
| Agent 開始執行 | `RUN_STARTED` |
| 執行階段開始 | `STEP_STARTED`（可選） |
| 開始輸出 Assistant 訊息 | `TEXT_MESSAGE_START` |
| LLM Token Delta | `TEXT_MESSAGE_CONTENT` |
| Assistant 訊息完成 | `TEXT_MESSAGE_END` |
| Tool Call 開始 | `TOOL_CALL_START` |
| Tool Arguments Streaming | `TOOL_CALL_ARGS` |
| Tool Call 結束 | `TOOL_CALL_END` |
| Tool 執行結果 | `TOOL_CALL_RESULT` |
| 執行階段完成 | `STEP_FINISHED`（可選） |
| Agent 執行完成 | `RUN_FINISHED` |
| Agent 發生錯誤 | `RUN_ERROR` |

以上是預期語意映射，不代表 Hermes 已原生提供相同事件。

Codex 必須確認目前 AG-UI SDK 的事件結構與順序規範。

## 5.3 Event Bridge 要求

建立：

`hermes_agui/event_bridge.py`

職責：

1. 接收 Hermes Callback。
2. 將 Callback 正規化為內部事件。
3. 將內部事件轉成 AG-UI Event。
4. 維護 Message ID。
5. 維護 Tool Call ID。
6. 確保事件順序正確。
7. 避免重複發送相同結果。
8. 確保每個 Run 正確結束。

特別注意：

- Token Delta 不得重複組合成完整訊息後再次輸出。
- Tool Call 必須有穩定的 Call ID。
- Tool Call Arguments 必須是合法的序列化資料。
- Tool Result 不得被誤當成 Assistant Final Answer。
- 如果 Hermes 沒有提供增量 Tool Arguments，不得假裝存在真正的增量事件；可以在參數完整時一次輸出。
- 不應把原始 Chain-of-Thought 或內部推理內容直接輸出到 UI。
- 必須避免在 Tool Result 中洩漏敏感資訊。

## 5.4 Streaming 架構

建議資料流：

```text
Hermes Agent Loop
      │
      ▼
Hermes Callbacks
      │
      ▼
Event Bridge
      │
      ▼
Async Event Queue
      │
      ▼
AG-UI Event Encoder
      │
      ▼
FastAPI SSE
      │
      ▼
CopilotKit
```

如果 Hermes 使用同步 Callback：

- Agent Loop 可在背景 Thread 執行。
- Callback 透過 thread-safe 方式傳送事件到 Async Queue。
- FastAPI 使用 Async Generator 消費 Queue。
- 不得直接從背景執行緒操作非 Thread-safe 的 AsyncIO Queue。
- 必須處理 Queue Backpressure。
- 必須處理 Client Disconnect。
- 必須處理執行例外。
- 不得因為 HTTP 連線結束而遺留失控的背景工作。

## 5.5 驗收測試

建立：

`tests/test_event_bridge.py`

至少測試：

1. 普通文字 Streaming。
2. 單次 Tool Call。
3. 多次連續 Tool Call。
4. 多輪 Agent Loop。
5. LLM 呼叫失敗。
6. Tool Execution 失敗。
7. Client Disconnect。
8. Event 順序與 ID 一致性。

---

# 6. Phase 4：Session 與 Conversation History

## 6.1 目標

支援 CopilotKit Thread 與 Hermes Session 的正確映射。

概念：

```text
CopilotKit Thread
      │
      ▼
Session Manager
      │
      ▼
Hermes Session
      │
      ▼
Conversation History
```

## 6.2 Session Manager

建立：

`hermes_agui/session_manager.py`

職責：

- 將 Thread ID 映射至 Hermes Session
- 載入既有 Session
- 建立新 Session
- 確保不同 Thread 的 Context 隔離
- 管理 Run 與 Session 的關係
- 處理並發請求
- 避免 History 重複寫入

## 6.3 必須定義的策略

### History Ownership

MVP 優先由 Hermes 管理執行時的 Conversation History。

CopilotKit 可以持有 UI Messages，但 Adapter 必須避免兩套 History 被重複注入模型。

### Session Isolation

不同 Thread 必須具有獨立的 Conversation Context。

### Concurrent Runs

同一 Thread 同時出現兩個 Run 時，必須有明確策略：

- 序列化執行；或
- 拒絕第二個 Run 並回傳明確錯誤。

MVP 建議同一 Thread 序列化執行。

### Multi-user Safety

不得單純相信外部傳入的 Thread ID 就授予 Session 存取權。

即使 MVP 只供本機開發，也必須預留身份與授權檢查介面。

---

# 7. Phase 5：CopilotKit Integration

## 7.1 目標

讓 CopilotKit Runtime 可以透過 AG-UI 連線到 Hermes Server。

目標：

```text
CopilotKit Runtime
      │
      ▼
AG-UI HttpAgent
      │
      ▼
Hermes AG-UI Endpoint
```

## 7.2 實作要求

建立獨立的 CopilotKit Integration Example：

```text
examples/
  └── copilotkit/
      ├── package.json
      ├── server/
      ├── frontend/
      └── README.md
```

Codex 必須根據目前 CopilotKit 官方版本選擇正確的 Runtime API。

優先使用官方 `HttpAgent` 或目前等價的遠端 AG-UI Agent 整合方式。

不得自行建立一套與官方 Runtime 不相容的 Agent Protocol。

## 7.3 驗收測試

必須完成以下 End-to-End 流程：

```text
User
  │
  ▼
CopilotKit UI
  │
  ▼
CopilotKit Runtime
  │
  ▼
Hermes AG-UI Server
  │
  ▼
Hermes Agent Loop
  │
  ├── LLM Call
  │
  ├── Tool Call
  │
  └── Final Answer
  │
  ▼
AG-UI Events
  │
  ▼
CopilotKit UI Rendering
```

驗收項目：

1. CopilotKit 成功連線 Hermes。
2. 使用者可以送出訊息。
3. Assistant 回答以 Streaming 顯示。
4. Tool Call 可以被 UI 觀察。
5. Tool Result 可以正確傳回。
6. 同一 Thread 可以繼續對話。
7. 切換 Thread 不會混用 History。
8. Agent Error 可以被 UI 正確處理。

---

# 8. Phase 6：保留 Hermes 原生能力

## 8.1 Tools

Hermes 必須繼續使用原生 Tool Registry。

不得將所有 Hermes Tools 重新註冊成 CopilotKit Tools。

MVP 中：

- Hermes 負責決定是否呼叫 Tool。
- Hermes 負責執行 Tool。
- CopilotKit 負責觀察與呈現 Tool Events。

未來如需 Browser-side Tools，再另行設計 Frontend Tool Bridge。

## 8.2 Memory

優先保留 Hermes 原生 Memory。

Adapter 不應重新建立另一套 Memory System。

需確認：

- Memory 如何讀取
- Memory 如何寫入
- Memory 是否綁定 Session
- Memory 是否可能跨使用者共享
- Memory Flush 是否依賴 CLI / Gateway

## 8.3 Skills

保留 Hermes Skills Loading 機制。

需確認：

- Skills 如何 Discovery
- Skills 如何載入
- Skills 如何注入 Prompt
- 是否依賴本機路徑
- 是否存在全域狀態或 Session 隔離問題

## 8.4 Context Management

保留：

- Prompt Building
- Context Window Management
- Context Compression
- Tool Result Context
- Conversation History Management

不得因為接入 AG-UI 而重新實作 Context Management。

---

# 9. Phase 7：Human-in-the-loop（第二階段功能）

此階段不阻擋 MVP 上線。

但架構設計必須預留：

- Tool Approval
- User Clarification
- Interrupt
- Resume
- Cancellation

若 Hermes 原本透過 CLI Callback 等待使用者確認，AG-UI Adapter 必須將此流程轉換為前端可處理的互動。

不得直接使用阻塞式 Terminal Input。

需根據 AG-UI 與 CopilotKit 當前支援的 Human-in-the-loop 機制設計。

至少需要：

1. 產生等待使用者操作的事件。
2. 保存可恢復的執行狀態。
3. 接收使用者決定。
4. 恢復或取消原本的執行。
5. 處理逾時、斷線及重複提交。
6. 避免未經授權的高風險 Tool Execution。

---

# 10. Phase 8：移除非必要元件

**此階段必須在 MVP 整合成功後進行。**

不要在 Phase 0 或 Phase 1 直接刪除大量 Hermes 檔案。

## 10.1 優先保留

- Agent Loop
- LLM Provider
- Tool Registry
- Tool Execution
- Memory
- Skills
- Session
- Context Management
- Configuration
- 必要的 Persistence
- 必要的 Error Handling

## 10.2 候選移除或排除

以下需先確認依賴：

- CLI Entry Point
- Terminal UI / Skin
- Messaging Gateway Adapters
- ACP Entry Point
- Interactive Setup Wizard
- 不使用的 Messaging Platform Integrations
- 不使用的 Batch / Cron Entry Points
- 不必要的 Development Utilities

**注意：Terminal Tool 與 Terminal UI 是不同概念。**

不能因為移除 CLI，就把 Agent 執行 Shell Command 的工具一起刪掉。

## 10.3 建議策略

優先建立獨立的 Runtime Packaging / Docker Image。

只安裝 AG-UI Server 所需依賴。

若原始專案存在複雜的隱性依賴，可先保留檔案，但不在 Runtime 啟動相關服務。

最後再進行真正的 Dependency Pruning。

---

# 11. 專案目錄規劃

建議第一版直接在 Hermes Repository 中新增 Adapter，而不是立即 Fork 並搬移所有 Core Files。

```text
hermes-agent/
│
├── agent/                  # 原生 Agent Core
├── tools/                  # 原生 Tool System
├── model_tools.py          # 原生 Tool Initialization
├── run_agent.py            # 原生 Agent Facade
├── hermes_state.py         # 原生 State / Persistence
│
├── hermes_agui/            # 新增
│   ├── __init__.py
│   ├── server.py
│   ├── adapter.py
│   ├── event_bridge.py
│   ├── message_adapter.py
│   ├── session_manager.py
│   ├── execution_manager.py
│   ├── config.py
│   └── core/
│       ├── factory.py
│       └── service.py
│
├── examples/
│   └── copilotkit/
│
├── tests/
│   └── agui/
│
├── docs/
│   ├── architecture-audit.md
│   ├── agui-architecture.md
│   └── agui-deployment.md
│
└── Dockerfile.agui
```

這是建議目錄，不是現有 Repository 的完整目錄快照。實際位置應根據 Phase 0 的分析調整。

---

# 12. Docker 與部署

## 12.1 部署架構

```text
Docker Network
│
├── copilotkit-runtime
│   └── Node.js
│
└── hermes-agui
    ├── FastAPI
    ├── Hermes Agent Core
    ├── LLM Provider Client
    ├── Tools
    └── Session Storage
```

## 12.2 要求

建立：

- `Dockerfile.agui`
- Docker Compose Example
- `.env.example`
- Deployment README

環境變數至少應涵蓋：

- LLM Provider Configuration
- Hermes Data Directory
- AG-UI Server Host / Port
- Session Storage Configuration
- Logging Level
- 必要的 Authentication Configuration

不得把 API Keys 寫死在程式碼或 Dockerfile。

如果 Hermes Tools 需要 Shell、Browser、Filesystem 等權限，必須清楚記錄容器權限與隔離風險。

---

# 13. 測試計畫

## 13.1 Unit Tests

測試：

- Message Conversion
- Event Mapping
- Event Ordering
- Tool Call ID
- Session Mapping
- Error Handling
- Callback Thread Safety

## 13.2 Integration Tests

測試：

- Hermes Headless Execution
- LLM Provider Integration
- Tool Execution
- Session Persistence
- AG-UI HTTP Endpoint
- SSE Streaming

## 13.3 End-to-End Tests

測試：

- CopilotKit → Hermes 普通對話
- CopilotKit → Hermes Tool Call
- Multi-turn Conversation
- Multiple Threads
- Agent Failure
- Client Disconnect
- Cancellation（若版本支援）

## 13.4 測試原則

- Unit Tests 應盡量使用 Mock Provider。
- 不應要求每次執行 Tests 都消耗真實 LLM API Token。
- 必須有可重現的測試方式。
- 對無法自動測試的 UI 行為，提供手動驗收步驟。

---

# 14. 里程碑與完成定義

| 里程碑 | 交付成果 | 完成標準 |
|---|---|---|
| M0 | Architecture Audit | 完成真實 Source Code 依賴分析 |
| M1 | Headless Hermes | 無 CLI 可直接執行 Agent + Tool |
| M2 | AG-UI Server | Endpoint 可以接收 Run Input |
| M3 | Event Bridge | 文字與 Tool Events 正確 Streaming |
| M4 | Session Manager | 多輪對話與 Thread 隔離 |
| M5 | CopilotKit Integration | UI 可完整執行 Hermes Agent |
| M6 | Runtime Packaging | Docker 可獨立啟動 |
| M7 | Dependency Cleanup | 非必要平台依賴可安全移除 |
| M8 | HITL Enhancement | Approval / Interrupt / Resume |

**M0–M6 是 MVP 的主要交付範圍。**

M7、M8 可以在 MVP 完成後進行。

---

# 15. Codex 執行規範

## 15.1 禁止事項

Codex 不得：

1. 在未檢查原始碼前重寫 Hermes Agent Loop。
2. 自行重新實作 Tool Registry。
3. 大量刪除未分析依賴的檔案。
4. 假設不存在的 Hermes API。
5. 使用未驗證的 AG-UI Event Schema。
6. 將所有工具結果直接當成 Assistant Message。
7. 在每次 Request 無必要地重新初始化所有 Provider 和 Tools。
8. 將不同使用者的 Session 混合。
9. 在日誌或 AG-UI Events 中輸出 API Keys。
10. 未經測試即宣稱整合完成。

## 15.2 開發工作流程

每個 Milestone 應依照以下流程：

1. 閱讀相關 Source Code。
2. 確認真實 API 與依賴。
3. 說明預計修改的檔案。
4. 進行最小範圍實作。
5. 建立或更新 Tests。
6. 執行 Tests。
7. 更新文件。
8. 回報結果與未解決問題。

## 15.3 每階段回報格式

每完成一個 Milestone，請回報：

**Implementation Summary**
- 完成的功能
- 主要設計決策

**Files Changed**
- 新增檔案
- 修改檔案
- 刪除檔案（如有）

**Tests**
- 執行的測試指令
- 通過 / 失敗數量
- 尚未執行的測試與原因

**Architecture Notes**
- 與原始 Hermes 架構的關係
- 新增的依賴
- 發現的技術風險

**Next Step**
- 下一階段建議工作
- 是否存在阻塞問題

---

# 16. 第一個 Codex 任務

請先執行 Phase 0，不要立即開始大量修改程式碼。

具體任務：

1. 檢查目前 Hermes Repository 的 Commit SHA 與目錄結構。
2. 找出 Agent 的真正初始化入口。
3. 追蹤一次 User Request 到 Agent Loop 的完整執行路徑。
4. 找出 LLM Streaming 與 Tool Execution Callbacks。
5. 找出 Session / Conversation History 的持久化機制。
6. 分析哪些元件依賴 CLI / Gateway。
7. 評估是否能直接建立 Headless Agent。
8. 建立 `docs/architecture-audit.md`。
9. 提出 Phase 1 的具體檔案修改計畫。

**Phase 0 完成後，先提交分析結果與實作建議，等待確認，再開始 Phase 1。**

---

# 17. 最終驗收標準

當以下條件全部成立，MVP 才視為完成：

- Hermes 可以作為獨立 Python AG-UI Server 執行。
- 不需要啟動 Hermes CLI 或 Messaging Gateway。
- CopilotKit Runtime 可以透過 AG-UI 連線。
- 可以完成 LLM 對話。
- 可以即時 Streaming 回答。
- 可以執行 Hermes 原生 Tools。
- 可以顯示 Tool Call / Result。
- 可以延續同一 Thread 的對話。
- 不同 Thread 不會互相污染。
- Memory / Skills / Context Management 未因改造而失效。
- 有完整的測試與部署說明。
- 可以透過 Docker 啟動。
- 核心 Agent Loop 不需要重寫。

## 最終架構原則

**Hermes 負責 Agent Intelligence 與 Execution。**

**AG-UI Adapter 負責 Protocol Translation。**

**CopilotKit 負責 Runtime Integration 與 User Interface。**

整個改造的核心不是創造新的 Agent Harness，而是讓 Hermes 原本的 Harness 可以被 CopilotKit 使用。
