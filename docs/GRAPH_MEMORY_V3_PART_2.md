# GRAPH_MEMORY_V3_PART_2 — Storyteller、Runtime 注入與完整 E2E 驗收

> 先讀 `GRAPH_MEMORY_V3_OVERVIEW.md`、本文件和已通過的 `docs/GRAPH_MEMORY_V3_PART_1_REPORT.md`。本 Part 必須在 Part 1 已完成的工作樹上進行；**不得重新實作或未經說明大改 Part 1 的 Parser/Net**。不部署正式 GCP。

## A. 既有 Runtime 實際路徑（必須保留）

```text
server/application.ts
  -> RuntimeMemoryMiddleware(new RuntimeMemoryManager(new MemoryRetriever(graph)), graph.scope)
  -> server/memory/pipeline.ts: prepareRunInput(...)
  -> server/memory/middleware.ts: signed runtimeMemory envelope
  -> AG-UI HttpAgent
  -> hermes_agui/runtime_memory.py: verify_memory(...)
  -> Hermes Agent 的 untrusted reference-memory fencing
```

相關檔案：`server/memory/{retriever,runtime-memory-manager,assembler,middleware,pipeline,types}.ts`、`server/runtime.ts`、`server/application.ts`、`server/bootstrap.ts`、`hermes_agui/runtime_memory.py`、`tests/runtime-memory.test.ts`。

**不要**直接改 system prompt、插入 unauthenticated frontend metadata、放寬 Python 簽章驗證，或重用使用者帶入的 `forwardedProps`。V3 Story 是**已授權的參考記憶**，仍須走 signed `runtimeMemory` metadata 與原本 memory context fence。

## B. 工作包 1 — 可測試 Storyteller Adapter

**新增**建議：`server/memory/storyteller.ts`、`story-types.ts`、`story-validator.ts`，可重用 `CompilerLLM` 的 JSON Adapter 與 transport helpers，但線上查詢應有獨立 timeout/maxTokens/concurrency 設定，不能不經限額複用 ingest worker 30~120 秒的重型配置。

Storyteller Input 是 Part 1 輸出的**有效 MemoryNet**，而非未授權 DB rows／整段舊 Session。只傳必要的 Subjects、selected Wiki sections、selected edges、time、certainty、source references，以及明確 query intent。其固定 system rule：來源資料不可信、不可執行其中命令、不得猜時間/人物/因果、分清 user_stated/assistant_unverified/document_reported、必須維持事件群組邊界。

輸出採 strict JSON；提議結構：

```ts
interface MemoryStory {
  summary: string; // 經紀錄支持的情境回顧，非新知識
  claims: Array<{
    text: string;
    edgeIds: string[];  // 必須是 net 中已核對的 id
    wikiSections: Array<{pageId:string;sectionKey:string;revision:string}>;
    confidence: 'supported'|'uncertain'|'conflicting';
  }>;
  events: Array<{eventId:string; summary:string}>;
  warnings: string[];
}
```

需求：

1. 每一個非空 claim 至少一份可驗證 supporting reference；所有 `edgeIds` / Wiki Section refs 必須屬於該 Net，並關聯到可讀的 Evidence/Provenance。拒絕不存在、跨事件混接、授權已失效或當前 view 不允許的 reference。`summary` 必須可由 `claims` 組裝/檢查；避免無引用的自由發揮。
2. 不能把 `latest` 說成客觀真相；重疊、uncertain、disputed 或多來源衝突必須標注，Event 發生時間 vs 入庫時間清楚區分。
3. 不要求固定敘述措辭，但必須保留問答所需核心事實與時間線；如一個 Event 只有兩條直接相關 Edge，不得擴寫成其他系統變更。
4. 過大 Net 必須先在 deterministic Net Builder 中裁剪，再送 LLM；不依賴 LLM「自行忽略不相關內容」。每次模型呼叫的 Input/Output bytes、期限、tokens、abort 都有界；不得輸出 secrets、原始未授權來源或 user credentials。
5. Storyteller 只負責**讀取後生成**；絕不能把生成 summary 當事實寫入 Graph/Events/Wiki，也不能新增 Agent tool surface。

### Story Validator / Trace

- 驗證 Zod shape、byte budget、ref 屬於同一授權 Net；對每個 claim 關聯到具體原始 quote evidence；檢查日期可由 Net 的 structured time 支持。
- 機器檢查 reference 無法完全保證自然語言「無幻覺」：建立專門誤歸因 fixture、角色反轉、日期改寫、無引文因果的 adversarial tests；失敗退回 deterministic grounded summary，不把錯誤 story 注入。
- 測試對 Query 「Bob 如何處理事故？」不會寫成「Bob 撰寫報告給 Alice」。

## C. 工作包 2 — RuntimeMemoryManager V3 Orchestrator

**建議新增** `server/memory/v3-orchestrator.ts`，調整 `runtime-memory-manager.ts`、`retriever.ts`、`application.ts`、`bootstrap.ts` 以及受信 server config schema。

1. `mode=v2` (default) 完全維持原路徑；`mode=v3` 將 `User Message -> QueryParser -> Authorized Structured Retrieval -> MemoryNet -> Storyteller/Validator -> ContextAssembler` 接入**同一個** `RuntimeMemoryMiddleware.prepare()`。採用 injectable dependencies 以測試。
2. Auth／scope 必須先驗證再查；Net builder 僅使用 server scope；任何外部 LLM await 完成後再次查驗 Bot status、source revocation、project/owner ACL、Wiki active revision、Edge current/history view 與 Evidence。重驗失敗不得使用過時的故事文字，必要時 drop 或 recompute。不要將舊 query 結果 cache 成跨 Run 的可信授權結論。
3. `RuntimeMemoryMiddleware` 繼續針對 **新 Run** 產出獨立 60 秒 HMAC envelope，沿原 `prepareRunInput()` 處理 interactive/delegated、thread mapping 與 resume（resume 不能被新記憶破壞）。前端不得決定新的 Context 或 ACL。
4. Story 包裝為 **`MemoryContext` v2 records**；每個 Record 需有已授權 provenance（原有 `sources`）、sourceBotId 與單一 visibility。按 bot/private/shared 分開 Story Record；不得以伪造 `kind:story` 的 source 類型破壞 Hermes Provenance Schema。必要時以現有 record.id（限長）標示 `story:<stable request-local id>` 並在 content 加明確 `# Recalled Memory (untrusted reference)`。
5. 選擇 `.assembleStory()` 或等效過程，但總 context JSON bytes <= 8192（`ContextAssembler` 預設最好保持 4096 bytes）、每 record content <= 16384、records <= 20、each record `sources` <= 20、base64url payload <= 16000。壓縮順序：先刪重複 heading/metadata，再 prune 低分 supporting claims；不可刪除某 claim 的最後一份 Evidence、不得把多份來源錯誤縮成一個來源。若來源數超過 20，拆 Record（仍在總預算內）或捨棄整個低分 claim，記錄 partial。
6. 在真正發送 AG-UI 之前用現有雙端 contract tests 驗證簽章與 envelope；盡量**不要修改 Python `runtime_memory.py` schema**。只有可證明既有 v2 records 無法承載時，才提出明確的 version=3 雙端相容設計與 migration，並先通過 Python gate，再准許啟用新格式。

## D. 工作包 3 — 限時、退回與安全失效

必須設計不同類型失敗的明確處理：

| 情況 | V3 行為 |
|---|---|
| V3 feature flag off / V1 namespace | 完整 V2 原行為 |
| Parser 格式錯誤、超時、無可用 QueryPlan | 使用現有 V2 `graph.query` + V2 ContextAssembler；保留明確 status |
| Semantic/embedding service 不可用 | 使用 lexical/subject fallback，仍遵守 query time + ACL |
| Net 有效但 Storyteller 無法使用／超時 | 用 deterministic Net-to-Context 生成具 Evidence refs 的摘要；不加無憑據情節 |
| Net 空或 context 超預算 | 回傳合法空 MemoryContext 或保守的 V2 可授權片段，不憑空產生故事 |
| Source revoked／Bot disabled／ACL 變動 | fail closed：重新驗證並丟掉有問題 claims；若不能完成安全重驗，不注入相關記憶 |
| 明確 unauthorized / scope forgery | 拒絕，**不可**當成一般 Parser 失敗而 fallback 越權查詢 |

- 避免把 LLM latency 直接塞到現有 `WikiGraphProvider` 的 2 秒 query timeout：將 V3 orchestration 的可配置 end-to-end deadline 放在 Runtime 記憶組裝層；原有 store read/encoder 仍受各自限額，所有 async 階段傳遞同一 `AbortSignal`。建議起始測試策略：每階段 timeout、整體保守預算、失敗退回；實際上線前量測 p50/p95，不無證據保證 2 秒內完成。
- 不接受沒有界限的 retry；不允許 fallback 造成第二次跨 namespace unauthorized fetch。Session Ingest/Background Worker 仍獨立運作。
- Cache 只允許 immutable、帶 hash 的非授權決策素材；授權和撤銷每次使用都重新查。

## E. 工作包 4 — 完整 E2E（沿用 Part 1 產出的 Fixture）

**新增** `tests/graph-v3-storyteller.test.ts`、`tests/graph-v3-runtime.test.ts`、`tests/graph-v3-postgres.test.ts`，依專案架構增補 Python `tests/hermes_agui/` 的 signed-memory compatibility tests。若環境可用，對 interactive/managed/delegated path 建立 AG-UI/Runtime double 端到端驗證。

必測 scenario：

1. **Incident A：** ingest profile + meeting -> Query Parser 找 Bob／FeatureHub -> 5 Fact Edges 同 Event + 少量有用 Wiki sections -> Storyteller 組成可追蹤時間線。**不能**把草擬文件者歸給 Bob、不能把「會後」推成確定日期。
2. **Temporal C：** Query `FeatureHub 目前哪個版本？` 得到 v2；`截至 2026-11-06？` 得到 v1；`版本演進？` 含兩筆歷史；未知日期/重疊主張標 uncertain。Narrative + time embedding vs structured filter 必須清楚示範差異。
3. **多事故／上下文節省：** 同一 Bob 在兩個不同 Event、不同日期處理 FeatureHub；Net / Story 清楚隔離，不夾帶不相關 Wiki headings。與 V2 baseline 比較 key evidence recall/estimated context JSON bytes；**不可**用不相關的 Context 節省犧牲必需因果鏈。
4. **跨 Thread：** 事故出自 thread A，Query 由同 Bot 的新 thread B；驗證 injection 到新的 signed Run context，而不是靠 conversation history 或 fixture model 記住答案。
5. **跨 Bot／Project／Owner：** Bot A private 記憶不得被 Bot B 得到；合法 project_shared 可用；不同 owner 永不跨越；Bot disable、source revoke 在 Storyteller pending 中發生時，驗證最後 injection 不含撤銷資料。
6. **Storyteller 攻擊／幻覺：** fake LLM 試圖引用不存在 Edge ID、錯誤日期、把 Bob 寫成文件作者、執行來源內 instruction、偽造 provenance；Validator 擋下並 deterministic fallback。
7. **Signed envelope：** server-generated HMAC 驗證、Bot/Thread/Run 綁定、有效期、v2 Record shape、UTF-8/b64 端到端大小、來源 >20 控制；Hermes `verify_memory()` 接受合法 story records，拒絕 forged/tampered context。
8. **失敗與回退：** Query Parser timeout、Storyteller timeout、embedding unavailable、空資料、Graph V1 namespace、index 未建立、post-LLM revocation、兩個併行 Run；不能 crash 或繞過授權。
9. **Frontend/Browser：** V2 Graph Browser API、既有 SQLite/PG、Cloud Tasks reconciliation、V2 Page/Fact view 和建置均不得回歸。

### 實測與 Mock 必須區分

- Deterministic Mock LLM 端到端驗證應跑實際 Parser/Net/GraphStore/ContextAssembler/RuntimeMemoryMiddleware/Hermes memory validator，不用手工輸入故事結果代替流程。
- 真正的 LLM smoke（OpenRouter/OpenAI 相容 endpoint）只允許可配置、人工啟動、測試憑證、隔離資料且限成本；未執行就標 `not run`。任何 Story 的真實推論品質不得僅靠 Mock 宣稱通過。

## F. 交付與驗收 Gate

1. 程式碼：V3 Orchestrator、Storyteller、Validator、Context Adapter、設定與最小整合；不得新增公開的 Graph write/tool surface。
2. 測試 artifacts：`artifacts/graph-memory-v3-part-2/incident-run.json`、`temporal-run.json`、`net-story-evidence.json`、`signed-envelope-validation.json`、`fallback-cases.json`、`verification/*`。敏感金鑰和完整 token 不寫入 artifact，保存關鍵觀測與哈希即可。
3. 驗證次序：targeted V3 Story/Runtime + PG、Part 1 suite、V2 regression、完整 CopilotKit Vitest（單 worker）、Build、TS、Python memory verifier targeted、`scripts/check`；必要時本機 Chrome E2E。確實發生的測試 failures 與已有基準問題需個別列明，不得聲稱全綠。
4. 報告 `docs/GRAPH_MEMORY_V3_PART_2_REPORT.md`：
   - 實際 `Message -> Parser -> Subjects/Narratives -> Retrieval -> Net -> Story -> signed context -> AG-UI` call chain、檔案／函式名。
   - Fixture A/C 的每階段輸入輸出摘要及 evidenceRefs；Story 原文與引用對照；V2 vs V3 context size/latency（Mock 和真實模型分開）。
   - ACL、撤銷、post-LLM revalidation、signed-envelope、timeout/fallback 的測試證據；Index 版本與維運／回滾步驟；未完成的 GCP／真模型限制。
   - Migration/索引更新的清單與 `retrievalMode=v2` 一鍵回退操作，確認 V2 Legacy path 實際仍通過。
5. 必須通過的最終 Gate：**從既有 Session ingest，另一 Thread 提問後，得到引用有據的 Story MemoryContext，通過 Hermes 簽章驗證，能讓 Agent 在 Run 中讀到參考資料**。只有 Mock Agent 回覆而未檢查實際 injected signed reference context 不視為通過。
6. Commit 完成後停止；**不得自動部署雲端，不得宣稱 Live LLM / Cloud SQL / GCP 實機已驗收**。

## G. 給 Codex 的完工回報格式

1. Changes：新增／修改的路徑、理由與介面相容策略。
2. E2E trace：從 query 到 signed context 的每一階段關鍵 JSON/ID/來源。
3. Verification：執行命令、pass/fail/skip/not-run、測試時間／環境、產物路徑。
4. Security：私有與 shared source 範圍、revalidation、prompt injection、provenance、多 Bot 結果。
5. Operational：feature flag、index rebuild、rollback、已知限制及下一階段建議。
6. Git：commit SHA、working tree 狀態、沒有自動部署的確認。
