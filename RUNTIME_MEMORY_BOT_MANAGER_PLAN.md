# Hermes AG-UI — Runtime Memory & Dynamic Bot Manager Implementation Plan

**文件名稱：** `RUNTIME_MEMORY_BOT_MANAGER_PLAN.md`  
**目標專案：** `jiangweitaiwan/hermes_agui`  
**參考專案：** `jiangweitaiwan/_openbot`  
**實作方式：** 分成 Part 1、Part 2，分別執行、測試及驗收  
**狀態：** Proposed

---

# 1. 專案背景

目前 Hermes AG-UI 已具備以下架構：

```text
CopilotKit Frontend
        |
        v
CopilotKit Runtime
        |
        v
AG-UI HTTP Agent
        |
        v
HermesAgentService
        |
        v
Hermes AIAgent
```

既有功能包括：

- Hermes Agent 透過 AG-UI 協定獨立提供服務。
- CopilotKit Runtime 可連線至 Hermes AG-UI。
- Multi-Bot Host 支援多個 Hermes Bot。
- 以 `bot_id` 區分 Bot，以 `thread_id` 區分 Session。
- 各 Bot 具有獨立的 Home、Workspace、原生 Memory、Skills 與 SQLite Session。
- `message_bot` 可透過 DelegationCoordinator 呼叫其他 Bot。
- 已有 `GraphMemoryPort` 介面，但尚未接入執行流程。
- Bot Registry 主要透過部署設定建立，尚無使用者自助新增 Bot 的完整機制。

## 1.1 現有設計的限制

### Memory

Hermes 的原生 Memory 存在於 Hermes Harness 內部。

如果未來接入 LangGraph、Mastra 或其他 AG-UI Agent，各個 Harness 可能有不同的記憶機制。

因此，不適合把跨 Bot 的 Graph Memory 全部實作在 Hermes `_memory_manager` 中。

### Bot Management

目前新增 Bot 需要修改 Host 與 Runtime 設定。

這無法提供使用者自行建立 Bot 的體驗。

## 1.2 本次改造目標

新增兩個 Runtime 級別的核心模組：

1. `RuntimeMemoryManager`
2. `BotManager`

使 CopilotKit Runtime 成為跨 Harness 的協調中心。

---

# 2. 目標架構

```text
                    Frontend
                       |
                       v
                CopilotKit Runtime
                       |
            +----------+----------+
            |                     |
            v                     v
        BotManager        RuntimeMemoryManager
            |                     |
        BotRegistry          GraphMemoryPort
            |                     |
        AgentResolver        MemoryRetriever
            |                     |
            |                ContextAssembler
            |                     |
            +----------+----------+
                       |
                       v
               Trusted Context
                       |
                       v
               AG-UI Transport
                       |
             +---------+---------+
             |         |         |
             v         v         v
           Hermes   LangGraph   Other
             |
       Native AIAgent
             |
       Native Memory
       Native Skills
       Native Tools
       Native Sessions
```

## 2.1 架構原則

### 原則 A：Runtime 管理共享記憶

CopilotKit Runtime 負責：

- 使用者及 Bot 身分解析。
- 記憶檢索。
- 記憶可見性與 ACL。
- 記憶排序與去重。
- Context Token Budget。
- Context 組裝。
- 注入目標 Agent。

### 原則 B：Harness 保留原生記憶

Hermes 仍負責：

- `MEMORY.md`
- `USER.md`
- SQLite Session History
- Context Compression
- Skills 與 Skill Evolution
- Native Tool Registry
- Agent Loop

禁止因新增 Runtime Memory 而移除上述功能。

### 原則 C：共享記憶是資料，不是指令

Graph Memory 內容必須以明確的低信任資料區塊提供給 Agent。

不得允許 Graph Memory 修改 System Policy、工具授權或 Bot 身分。

### 原則 D：維持獨立部署

Hermes AG-UI 必須仍可不經 CopilotKit Runtime 獨立執行。

直接呼叫時可以沒有 Runtime Graph Context，但原生記憶及 Agent Loop 必須正常。

---

# 3. 實作範圍

## Part 1：Runtime Memory Layer

目標：

在 CopilotKit Runtime 加入共享記憶的檢索、組裝及注入流程。

**本階段只實作 Graph Read Path，不實作真正的 Graph DB 與自動知識抽取。**

工作項目：

1. 建立 `RuntimeMemoryManager`。
2. 建立 `MemoryRetriever`。
3. 建立 `ContextAssembler`。
4. 建立 `RuntimeMemoryMiddleware`。
5. 設計通用的 `MemoryContext` 契約。
6. 建立 Hermes Trusted Context Bridge。
7. 串接現有 `GraphMemoryPort`。
8. 建立 Fake Graph Provider。
9. 完成整合測試。

## Part 2：Dynamic Bot Manager

目標：

使用者可以透過 API 或前端建立 Bot，不需要手動修改 YAML 後重新啟動整個系統。

工作項目：

1. 建立持久化 `BotRegistry`。
2. 建立 `BotManager`。
3. 建立 Bot CRUD API。
4. 建立 Hermes Profile Provisioner。
5. 支援 Hermes Host 動態註冊與卸載。
6. 支援 CopilotKit Runtime 動態解析 Bot。
7. 新增前端 Bot Management UI。
8. 將新 Bot 自動接入 Runtime Memory。
9. 確保既有 DelegationCoordinator 仍能運作。
10. 完成生命週期、隔離與整合測試。

---

# 4. Part 1 — Runtime Memory Layer

## 4.1 參考原始碼

參考 `_openbot`：

```text
server/src/memory/tools.ts
server/src/memory/runtime.ts
server/src/memory/ingestion.ts
server/src/agents/agent-resolver.ts
server/src/copilot.ts
```

重點參考：

```typescript
PersonalMemoryMiddleware
```

以及：

```typescript
built.use(
  new PersonalMemoryMiddleware(...)
)
```

但不得直接假設所有遠端 AG-UI Agent 都能接受 System Message 或 Context。

## 4.2 新增模組

建議新增：

```text
examples/copilotkit/server/
    memory/
        types.ts
        runtime-memory-manager.ts
        retriever.ts
        assembler.ts
        middleware.ts
        policies.ts
        fake-provider.ts
```

允許 Codex 依現有專案慣例調整路徑。

## 4.3 MemoryContext 契約

定義 Harness 無關的記憶資料結構。

示意：

```typescript
interface MemoryRecord {
  id: string;
  content: string;

  sourceBotId: string;
  sourceThreadId: string;

  visibility:
    | "bot_private"
    | "project_shared";
}

interface MemoryContext {
  version: 1;
  records: MemoryRecord[];
}
```

這是內部資料契約，不代表 AG-UI 標準已定義此結構。

所有欄位必須經過驗證。

## 4.4 RuntimeMemoryManager

建議介面：

```typescript
interface RuntimeMemoryManager {
  prepare(
    scope: GraphScope,
    query: string
  ): Promise<MemoryContext>;
}
```

工作流程：

```text
User Message
     |
     v
Resolve Identity
     |
     v
Resolve Bot / Project / Thread
     |
     v
GraphMemoryPort.query()
     |
     v
Validate Hits
     |
     v
Deduplicate
     |
     v
Rank / Limit
     |
     v
ContextAssembler
     |
     v
MemoryContext
```

要求：

- Query Scope 必須由可信任的後端建立。
- 不接受前端直接指定 Graph ACL。
- 只讀取授權範圍內的記憶。
- 設定查詢超時。
- 限制記憶筆數與 Token Budget。
- Graph 不可用時，允許 Agent 使用原生記憶繼續執行。
- Graph 授權失敗與服務暫時不可用必須區分；不得以忽略 ACL 錯誤的方式降級。

## 4.5 ContextAssembler

負責將 Graph Hits 組裝成可注入內容。

要求：

- 去除重複記憶。
- 保留來源 Bot、Thread、Record ID。
- 限制最大 Context 大小。
- 防止 Graph 資料冒充系統指令。
- 不把 Graph Context 寫入使用者原始 Message。
- 不把 Graph Context 寫入 Hermes SQLite 對話歷史。
- 不能依賴 LLM 才能完成基本組裝。

初版可使用確定性的組裝邏輯。

未來可加入 Reranker 或 LLM Summary。

## 4.6 RuntimeMemoryMiddleware

參考 `_openbot` 的 Middleware 方式。

示意：

```typescript
class RuntimeMemoryMiddleware extends Middleware {
  run(input, next) {
    // 1. Resolve trusted scope
    // 2. Retrieve graph memory
    // 3. Assemble memory context
    // 4. Inject through supported transport
    // 5. Continue to agent
  }
}
```

要求：

- Middleware 必須在每次 Run 時執行。
- 不得只在 Runtime 初始化時檢索記憶。
- 不得信任瀏覽器提交的 System Message。
- 不得在不同 Bot、使用者或 Thread 間共用未隔離的 Context Cache。
- 對未宣告支援 Memory Context 的 Agent，使用明確的相容策略，不可默默丟棄並聲稱注入成功。

## 4.7 Hermes Trusted Context Bridge

目前：

```text
hermes_agui/message_adapter.py
```

會拒絕非空的：

```python
context
forwarded_props
tools
state
```

而且只採用最後一條 User Message。

因此必須建立可信任的 Context 傳遞機制。

### 建議實作

採用受驗證的 Runtime-to-Agent Metadata 通道。

可以考慮：

- AG-UI `forwardedProps` 中的受限欄位。
- 經驗證的自訂 HTTP Header 搭配 Context Payload。
- 獨立的內部 Trusted Context Envelope。

由 Codex 評估現有 AG-UI SDK 的傳輸能力，選擇最小改動方案。

**安全要求：**

1. 只有已認證的 Runtime 可以提交 Trusted Memory。
2. Runtime 身分必須與目標 Bot 綁定。
3. Context 必須綁定 `thread_id`、`run_id`。
4. 一般瀏覽器不能偽造 Trusted Context。
5. 不允許透過 Memory Context 修改 Tools 或 Agent Policy。
6. 不得直接放寬 `message_adapter.py` 對所有 Context 的限制。
7. 必須有 Payload Size Limit。
8. 不得將秘密金鑰或完整記憶內容寫入一般日誌。
9. Context 傳輸必須防止跨 Run 重放或錯誤綁定。
10. 即使 Context 來自可信任 Runtime，其記憶文字仍必須視為不可信資料。

注意：Bearer Token 只能驗證呼叫者，不能單獨證明任意 Context 內容都具有 System Policy 權限。

## 4.8 Hermes Prompt Injection

不要直接修改使用者訊息：

```python
message = memory + user_message
```

應建立獨立的 Runtime Context 通道，並在 Hermes 原生 Prompt 組裝流程中提供低優先序參考資料。

概念：

```text
Hermes System Prompt
    |
    +-- Native Instructions
    |
    +-- Native Skills
    |
    +-- Native Memory
    |
    +-- Runtime Shared Memory
    |      (untrusted reference data)
    |
    +-- Current User Message
```

實作時必須注意 Hermes 的 System Prompt Cache。

每個 Run 的 Graph Context 不能因快取而沿用上一輪的內容。

也不能破壞 Hermes 的原生 Context Compression、Session Recovery 與 Tool Call Loop。

## 4.9 Part 1 測試

至少完成：

- 無 Graph Provider 時，Hermes 正常回答。
- Graph Provider 有資料時，記憶能進入 Agent Context。
- 不同 Bot 不會讀到彼此的 `bot_private` 記憶。
- 同一 Project 的授權 Bot 可以讀取 `project_shared` 記憶。
- 不同 Principal / Project 不會交叉讀取。
- Graph Timeout 不會讓 Agent 永久等待。
- 一般使用者無法偽造 Trusted Context。
- 重複 Run 不會沿用錯誤的 Context。
- Hermes SQLite History 不會被注入內容污染。
- Hermes Native Memory / Skills 保持正常。
- 直接呼叫 Hermes AG-UI 仍可正常執行。

### Part 1 驗收標準

使用 Fake Graph Provider：

```text
Graph Memory:
"Project Alpha 使用 PostgreSQL"
```

使用者向 Researcher 詢問：

```text
Project Alpha 使用什麼資料庫？
```

CopilotKit Runtime 必須：

1. 檢索 Graph Memory。
2. 組裝 MemoryContext。
3. 傳給 Hermes AG-UI。
4. Hermes 能在本輪使用該資訊。
5. 原生 Session History 保持正確。

測試必須驗證實際模型輸入路徑包含正確的記憶內容，而不只是 Mock Middleware 有被呼叫。

---

# 5. Part 2 — Dynamic Bot Manager

## 5.1 目標

讓使用者可以透過 UI 建立 Bot。

例如：

```text
Bot Name: Financial Analyst

Model: qwen / openrouter

Harness: Hermes

Description:
專門分析公司財務報表

Skills:
financial-analysis

Memory:
Native Memory + Runtime Graph Memory
```

建立後自動：

```text
BotManager
     |
     v
BotRegistry
     |
     v
Hermes Profile Provisioner
     |
     v
HermesAgentService
     |
     v
CopilotKit Agent Resolver
     |
     v
Frontend Bot List
```

## 5.2 BotRegistry

新增持久化 Registry。

建議介面：

```typescript
interface BotRecord {
  id: string;
  name: string;

  harness: "hermes" | "remote_ag_ui";

  status:
    | "provisioning"
    | "active"
    | "disabled"
    | "failed";

  ownerId: string;
  projectId: string;

  endpoint?: string;
}
```

實際資料結構可以擴充：

- Model / Provider。
- Profile ID。
- Skills。
- Toolsets。
- Workspace。
- Memory Policy。
- Delegation Permissions。
- CreatedAt / UpdatedAt。

不得直接在 API 回傳 Token 或 Provider API Key。

Registry 必須持久化，重新啟動後仍能還原。

## 5.3 BotManager

建議介面：

```typescript
interface BotManager {
  createBot(input): Promise<BotRecord>;

  getBot(id): Promise<BotRecord | null>;

  listBots(ownerId): Promise<BotRecord[]>;

  updateBot(id, changes): Promise<BotRecord>;

  disableBot(id): Promise<void>;

  deleteBot(id): Promise<void>;
}
```

建立 Bot 時必須：

1. 驗證使用者。
2. 驗證建立權限及配額。
3. 產生合法且唯一的 Bot ID。
4. 建立 Registry Record。
5. Provision Agent Profile。
6. 註冊至對應 Harness Host。
7. 啟用 Runtime Agent Resolver。
8. 更新 Bot 狀態。

若 Provision 失敗，必須記錄失敗狀態並提供安全重試或回滾。

## 5.4 Hermes Profile Provisioner

新增：

```text
HermesBotProvisioner
```

負責：

- 建立 Bot Home。
- 建立 Workspace。
- 初始化 Profile。
- 配置 Model。
- 配置 Skills。
- 配置 Toolsets。
- 配置 Memory。
- 設定 Bot Principal。
- 建立或綁定 Bot 憑證。

範例：

```text
/srv/hermes/bots/
    bot-001/
        config.yaml
        MEMORY.md
        USER.md
        skills/
        state.db

    bot-002/
        config.yaml
        MEMORY.md
        USER.md
        skills/
        state.db
```

檔案依 Hermes 原生初始化流程產生。

不要求 Provisioner 手動建立所有原生檔案。

安全要求：

- 使用者不能直接提交任意絕對路徑。
- Home / Workspace 必須在允許的 Root 下。
- 禁止 Path Traversal。
- 禁止利用 Symlink 逃逸。
- Toolsets 使用 Allowlist。
- Provider Secrets 必須由後端安全配置。

## 5.5 Hermes Host 動態註冊

目前 Hermes Host 主要從 YAML 讀取 Bot 設定。

需要新增受保護的管理能力：

```text
register_bot()
unregister_bot()
get_bot()
list_bots()
```

函式名稱可依現有架構調整。

要求：

- 新增 Bot 不必重新啟動整個 Hermes Host。
- 不影響其他正在執行的 Bot。
- 新 Bot 建立自己的 HermesAgentService。
- 同一 Bot 的不同 Thread 仍共用其 Profile。
- Session 持久化及隔離保持正常。
- 不允許在 Bot 有 Active Run 時直接破壞其資源。
- 重新啟動後可以從持久化 Registry 還原。
- 管理端點不得暴露給未授權使用者。

## 5.6 CopilotKit 動態 Agent Resolver

目前：

```typescript
new CopilotRuntime({
  agents: () => ...
})
```

應改造成透過 Registry 解析。

概念：

```typescript
new CopilotRuntime({
  agents: async () => {
    return botRegistry.resolveAgents();
  }
})
```

但不能只修改這一段。

現有 Runtime 還有：

```text
singleHandler()
handlers Map
BotRunner
```

等靜態 Bot 路由及 Thread 隔離機制。

Codex 必須一併檢查：

- 動態新增 Bot 是否能被路由。
- Stateful Run 是否仍使用正確的 BotRunner。
- 不同 Bot 的 Thread Store 是否隔離。
- 新增 Bot 是否會造成既有 Run 中斷。
- Disabled Bot 是否會拒絕新 Run。
- 刪除 Bot 後歷史 Thread 如何保留或清除。

不得直接以全域單一 Runner 取代目前的隔離設計。

## 5.7 Bot Management API

建議新增：

```http
POST   /api/bots
GET    /api/bots
GET    /api/bots/{bot_id}
PATCH  /api/bots/{bot_id}
POST   /api/bots/{bot_id}/disable
DELETE /api/bots/{bot_id}
```

所有管理 API 必須驗證使用者身分及資源所有權。

建議初版採用軟刪除，避免意外刪除 SQLite History、Skills 或長期記憶。

## 5.8 Frontend

新增：

```text
Bot List
    |
    +-- Create Bot
    |
    +-- Edit Bot
    |
    +-- Disable Bot
    |
    +-- Delete Bot
    |
    +-- Open Chat
```

建立 Bot 的表單初版只需要：

- Bot Name。
- Description。
- Harness Type。
- Model / Provider（從允許的設定中選擇）。
- Skills / Toolsets（可選）。

避免讓使用者直接輸入伺服器路徑、任意指令或憑證。

初版優先完整支援 Hermes Bot。

`remote_ag_ui` 可以先支援受管理員核准的 Endpoint 註冊，暫不允許一般使用者填入任意 URL，以避免 SSRF 與憑證外洩。

## 5.9 Bot 與 Runtime Memory 整合

新增 Bot 後，應自動具備 Runtime Memory 接入能力。

```text
New Bot
   |
   v
BotRegistry
   |
   v
Runtime Agent Resolver
   |
   v
RuntimeMemoryMiddleware
   |
   v
GraphMemoryPort
```

每個 Bot 必須有明確的：

```text
principal
botId
projectId
```

並遵守：

```text
bot_private
project_shared
```

記憶權限。

新增 Bot 不代表自動獲得其他 Bot 私有記憶的存取權。

## 5.10 Delegation 相容性

既有 `message_bot` 機制必須保留。

例如：

```text
Researcher
    |
    | message_bot("reviewer", task)
    v
DelegationCoordinator
    |
    v
Reviewer
```

改造後必須確保：

- DelegationCoordinator 可解析動態 Bot Registry。
- 目標 Bot 存在且為 Active。
- 來源 Bot 具備呼叫目標 Bot 的權限。
- Child Run 使用獨立 Thread。
- Child Run 經過自己的 Runtime Memory Pipeline。
- 不會直接繼承來源 Bot 的私有記憶。
- 不破壞既有單層 Delegation 限制。

**重要：** 目前 Delegation 路徑可能直接呼叫 AG-UI Endpoint，因此需要確認 Child Run 是否真的經過 Runtime Memory Middleware。若沒有，應讓 DelegationCoordinator 呼叫共用的受信任 Run Pipeline，而不是繞過記憶層。

---

# 6. 不在本次範圍

以下功能延後：

- Neo4j / GBrain 正式整合。
- Graph Knowledge Extraction。
- Graph Memory 自動寫入。
- LLM Memory Consolidation。
- Graph Embedding / Reranking。
- Graph Visualization UI。
- Bot Marketplace。
- Bot Template Marketplace。
- 多層 Recursive Delegation。
- 自動 Agent Orchestration Planner。
- 取代 Hermes 原生 Memory。
- 將 Hermes Skills 遷移到 CopilotKit。

但必須預留未來擴充接口。

---

# 7. 建議執行順序

## 第一次 Codex 執行：Part 1

只實作 Runtime Memory。

順序：

1. 閱讀既有架構與測試。
2. 確認 AG-UI SDK 的 Middleware 與 Metadata 傳輸能力。
3. 定義 MemoryContext。
4. 建立 RuntimeMemoryManager。
5. 建立 Retriever / Assembler。
6. 串接 GraphMemoryPort。
7. 建立 Runtime Middleware。
8. 實作 Hermes Trusted Context Bridge。
9. 接入 Hermes Prompt 組裝流程。
10. 完成 Fake Provider 整合測試。

完成後停止。

不得提前實作 Bot Manager。

### Part 1 交付物

- 可執行程式碼。
- 單元測試。
- Runtime → Hermes 整合測試。
- 記憶注入與安全測試。
- `docs/runtime-memory-part-1.md`。
- 未完成項目與限制說明。

## 第二次 Codex 執行：Part 2

在 Part 1 通過後執行。

順序：

1. 閱讀 Part 1 進度報告。
2. 建立 BotRegistry。
3. 建立 BotManager。
4. 建立 Hermes Profile Provisioner。
5. 實作 Hermes Host 動態註冊。
6. 改造 Runtime Agent Resolver。
7. 建立 Bot CRUD API。
8. 建立 Bot Management UI。
9. 修正 Delegation 動態路由。
10. 驗證新 Bot 自動接入 Runtime Memory。
11. 完成生命週期及端到端測試。

### Part 2 交付物

- 可執行程式碼。
- Bot CRUD API。
- 前端 Bot Management UI。
- Dynamic Registry。
- Hermes Dynamic Host。
- 多 Bot 隔離測試。
- Delegation 回歸測試。
- `docs/runtime-memory-bot-manager-part-2.md`。

---

# 8. 最終驗收情境

完成兩個 Part 後，必須能執行以下流程。

### Scenario A：新增 Bot

```text
User
  |
  v
Create Bot: Financial Analyst
  |
  v
BotManager
  |
  v
Hermes Profile Provisioner
  |
  v
Hermes Host Registration
  |
  v
CopilotKit Runtime Registration
  |
  v
Frontend Bot List
```

結果：

新 Bot 不需重啟整個系統即可開始對話。

### Scenario B：共享記憶注入

```text
User -> Financial Analyst
           |
           v
     CopilotKit Runtime
           |
           v
      Graph Query
           |
           v
     Memory Assembly
           |
           v
       Hermes AG-UI
           |
           v
       Native Agent
           |
           v
         Answer
```

結果：

Agent 可以使用授權的 Graph Context 回答。

### Scenario C：多 Bot 隔離

```text
Researcher
    Native Memory A

Reviewer
    Native Memory B

Financial Analyst
    Native Memory C
```

結果：

三個 Bot 的原生 Memory、Skills、Session 不互相污染。

Graph Memory 依 ACL 共享。

### Scenario D：Bot Handoff

```text
Researcher
    |
    v
message_bot("reviewer")
    |
    v
Reviewer Runtime Memory Retrieval
    |
    v
Reviewer Agent
    |
    v
Result -> Researcher
```

結果：

Reviewer 在獨立 Run 中取得自己有權使用的 Graph Context，完成任務並回傳結果。

### Scenario E：獨立 Hermes AG-UI

```text
Direct HTTP Request
       |
       v
Hermes AG-UI
       |
       v
Hermes Native Memory
       |
       v
Answer
```

結果：

不經 CopilotKit Runtime 也可以正常執行。

---

# 9. Codex 實作規範

1. 必須先閱讀現有程式碼，不得假設函式或介面存在。
2. 優先沿用現有 `GraphMemoryPort`。
3. 不得重寫 Hermes Agent Loop。
4. 不得移除 Hermes Native Memory / Skills。
5. 不得破壞 `bot_id`、`thread_id` 的隔離。
6. 不得將不可信 Context 提升為系統指令。
7. 不得為了通過測試而關閉身分驗證。
8. 不得以靜態 Mock 成功取代真正的端到端測試。
9. 所有新增 API 必須有權限驗證。
10. 既有 AG-UI Streaming、Tool Calls、Cancellation、Delegation 必須保持正常。
11. 每個 Part 完成後執行測試並產生報告。
12. 遇到現有架構限制時，優先最小改動，並在報告中說明權衡。
13. 不要將兩個 Part 合併成一次實作。
14. 不要在本階段引入正式 Graph Database。
15. 保持可替換 Harness 的設計，不要讓 Runtime Memory 依賴 Hermes 內部類別。

---

# 10. 完成定義

本階段完成時，系統應具備：

**Runtime Memory**

- CopilotKit Runtime 可在每次 Run 前檢索共享記憶。
- Runtime 可以組裝安全、受限的 MemoryContext。
- Hermes 可接收並使用 Trusted Memory Context。
- 不破壞 Hermes 原生 Memory、Skills、Session。
- Graph Provider 可以替換。

**Dynamic Bot Manager**

- 使用者可透過前端建立 Hermes Bot。
- 新 Bot 可動態註冊並開始執行。
- Bot Registry 可持久化。
- Bot 可停用及刪除。
- 不同 Bot 的 Profile、Memory、Skills、Thread 互相隔離。
- 動態 Bot 可以使用 Runtime Memory。
- 動態 Bot 可以參與授權的 `message_bot` Delegation。

**最終結果：**

CopilotKit Runtime 成為可擴充的 Multi-Agent Orchestration Layer，統一管理 Bot Registry 與共享記憶，而各個 AG-UI Agent 保留自己的 Harness、原生 Memory、Skills 和執行能力。

這將成為下一階段接入真正 Graph Memory Engine 的基礎架構。