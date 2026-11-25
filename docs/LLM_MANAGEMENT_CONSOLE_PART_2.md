# LLM Management Console — Part 2：Prompt 管理、Schema Viewer、Playground 與 Embedding Gate

## 0. Codex 執行契約

Repo `jiangweitaiwan/hermes_agui`，branch `codex/graph-memory-v2`。以已驗收 Part 1 實際 commit 為基準（不得猜 commit）。先讀 `LLM_MANAGEMENT_CONSOLE_PART_1.md`、Part 1 report/operations、原 `docs/llm-unification-part-2-operations.md` 與現有 source。確認 dynamic release、run/job pin、admin API、static compatibility 已完成；若存在 blocking defect，先修補並記錄，不重新開發相同 control plane。不可部署 production 或使用 production source/credentials；雲端 gate 缺資源標 BLOCKED。

## 1. 目標

從同一 LLM Management Console 可編輯各 Graph Stage 的 Prompt、查看完整 Effective Prompt、唯讀檢視 Schema/Validator、透過 Playground 使用相同正式 Adapter/Validator 比較 baseline/candidate，建立 release 並在新 Run/Job 生效。Agent primary 開放有限的全域 instruction slot，不取代 native harness。Embedding 支援受控 migration；沿用現有 vector fingerprints 與 CLI，禁止一鍵直接切換未完成索引。

不允許前端任意修改 JSON Schema、Zod、validator code、ACL、tools、SQL、Graph storage contracts。此階段不新增第二個 LLM reviewer、不引入新的 LLM proxy、Firestore 或獨立服務，不自動重編全部歷史 memory。

## 2. 現有 source 與任務映射

基準 `examples/copilotkit/server/llm/`：`prompts/registry.ts`（instruction/rules/grounding/promptFor/systemPrompt）、`config.ts`（taskRegistry/taskFingerprint）、`schema/registry.ts`（outputSchema）、`validation/pipeline.ts` 及 evidence/domain/persistence/retrieval modules。Python native prompt 路徑由 Part 1 盤點實際位置，不假定它共用 TS Prompt Registry。

| Stage ID | Model Role | Schema file | 管理方式 |
|---|---|---|---|
| v2-parser | graph_parser | parser.ts | editable task instructions |
| v2-subject-disambiguation | graph_matcher | matcher.ts | editable task instructions |
| v2-relations | graph_relations | relations.ts | editable task instructions |
| v3-query | graph_query | query.ts | editable task instructions |
| v3-story | graph_story | story.ts | editable task instructions |
| analysis/generation/merge | graph_parser | legacy.ts | 保留相容；先唯讀，不誤稱 V2 各 stage |
| agent_primary | agent_primary | native tool contracts | 有限 instruction slot；完整 runtime prompt 不任意公開 |
| embedding | graph_embedding | encoder contract | 無 chat prompt；獨立遷移 |

## 3. Prompt Registry 改造

將 effective Graph system prompt 拆成三層：
1. Protected core：不可信 source/query envelope、禁止自選工具/ACL/credentials/路徑、不得捏造 evidence、schema-valid JSON。
2. Editable task instruction：管理員可調整抽取、匹配、檢索、敘事策略與例子。
3. Protected contract/grounding：UTF-16 offsets、literal evidence、identity/alias support、actor attribution、negation/uncertainty、state/event、query literal spans、story exact claims 等現有強制契約。將基準 rules 中必要限制移至 protected 層，而非只保留 grounding object；逐 stage 盤點，不遺漏原有安全限制。

保持 system/user envelope 分離；不把 untrusted source 拼入 system instruction。Prompt 本身不是安全邊界，真正約束仍由 deterministic validators/ACL/store transaction 執行。禁止 browser 以 placeholder 讀 secret、注入 template code 或任意工具；使用純文字與固定組裝，不執行 eval。

Bootstrap 必須使 v1 effective prompt 與 baseline 語義及必要契約相容，優先保持 byte-identical；若因重新拆層導致字串/順序改變，記錄差異、以新版本識別且跑 golden corpus，不聲稱同 hash。Static mode 保持原 prompt 行為。

`llm_prompt_versions`（Part 1 若未建，本階段 additive migration）：scope、task_id、version_id、parent_id、editable_text、protected_contract_id/hash、effective_prompt_hash、compatible schema/validator versions、created_by/at、change_reason。已建立版本 immutable；draft 指向候選文字/版本，發布 snapshot 固定完整內容或 immutable 引用及 hash。禁止按 mutable latest 取 prompt。

改造 `promptFor`、`systemPrompt`、`validateTaskContracts`、`taskFingerprint` 與所有 stage callsites，使其以 execution snapshot/explicit task context 選擇版本，不依 process-global mutable registry。原 schemaVersion=1、validatorVersion=1 的 code allowlist 保留；動態 prompt version 與 code contract version 分離。release fingerprint 應覆蓋 effective text、schema hash、validator version；model fingerprint 維持既有定義。舊 release 必須能解析原 protected contract，若 image 不支援則明確拒絕，不默默替換成新版。validator behavior 改動需升 code version。

## 4. Native Agent Instruction

新增 deployment-level instruction slot（建議 agent_instruction，名稱依實際 Host contract）。由可信 release pin 傳入 Python native prompt assembly，保留原有 Bot role、tools、skills、memory、history 與 harness security sections。不能把 TS Graph prompt 套入 Agent。限制長度，明確 precedence，原有 instruction 不被 override；cache invalidation 納入 release/prompt hash。同 thread 新 run 可用新 instruction，in-flight run 保留舊版本。全量有效 Agent Prompt 可能含私有 memory、工具或內部內容，因此 UI 僅顯示靜態/可編輯 slot 與組裝結構，禁止跨使用者 dump 真實 session system prompt。Auxiliary prompt 未接入者標示 unmanaged。

## 5. Schema / Validator Viewer（唯讀）

Schema 以已部署 Zod source `schemas` + `outputSchema` 產生，禁止維護第二份手寫 JSON schema。顯示 task、schemaVersion、JSON schema/hash、欄位/required/type、範例、validatorVersion、Output/Evidence/Domain/Persistence 檢查摘要。說明 provider wire JSON Schema 不包含所有 Zod refinements 或 semantic constraints；可同時呈現 provider projection 與 server-side 規則摘要，不冒充完整等價。

Schema/Validator 規則為 code-defined；無 PATCH/POST schema endpoint。UI 顯示 active release 與目前 image 支援的 contract，若不相容阻止發布。若未來變更 schema，仍由 source change、migration（若必要）、tests、image deployment 完成。不可前端修改 schema 來逃過 validation。

## 6. Playground / 品質驗證

### 6.1 執行模式
- 支援單 stage dry-run，及 Graph ingest/retrieval 的 bounded pipeline dry-run（依 stage dependency 提供 synthetic upstream context）。baseline 與 candidate 使用同一測試 input、同一可比 context，呈現實際 model/provider/prompt/schema/validator versions。
- 重用正式 `CompilerLLM` / Graph adapter / parser / matcher / relations / query / storyteller / validators，不能另寫 simplified extraction engine。
- Dry-run 以明確 no-publication boundary、in-memory/isolated test stores 實作；禁止寫 production source/job/wiki/edge/vector、禁止發 Cloud Tasks、禁止 tool side effects。持久化/ACL/lease gates 若未真實執行，標記 not_run，不冒充 accepted publication。測試 Agent instruction 時僅允許受控無工具或無副作用 harness，標示不代表完整 native agent run。
- 預設 synthetic fixtures；若未來允許真實 session，需獨立資料授權及明示 vendor egress，第一版不提供跨租戶真實 source browse。輸入/輸出大小、timeout、token、並發/速率限制、取消；使用固定 approved provider，不接受任意 URL/key。若使用者切換第三方供應商須明示資料去向。

### 6.2 顯示與發布 Gate
UI 顯示 raw structured JSON（安全 text rendering）、output/evidence/domain verdict、issue code、checked/not-run layers、latency、token usage（unknown=null）、有效 prompt diff。不要把 accepted rate 當 objective accuracy；語義評測需標註 golden corpus。不得將 raw source/output/prompt body 寫入一般 Cloud Logging；Playground result 預設不永久保存原文。

發布前強制完整 candidate hash / contract compatibility / registry validation / protected instructions presence；對修改的 task 執行版本化最小 regression suite（含 negative fixtures），記錄結果與實際 checked layers，與 candidate hash 綁定。改 draft 使舊測試失效。不能用一個模型生成的正例代替安全測試；測試失敗阻止發布。真實 provider quality/latency staging gate 依運維政策獨立記錄；無憑證不可顯示 PASS。管理員 rollback 仍須檢查 code/schema/validator compatibility，不能繞過已 review/rejected job。

## 7. Embedding Migration

沿用現有 administrator `vectors` CLI 與 encoder/index key；不改維度相同就可共用向量的假設。先實作唯讀 status + migration plan/gate，再以既有可重入 indexing job/CLI 建候選 index。若有安全的現有背景 job 接口可重用，可提供 admin trigger；若無，第一版由運維執行 CLI，UI 顯示明確命令、進度/verification 並禁止未驗證切換，不新增 scheduler 或長時間 HTTP request。此取捨需在 report 說明。

Migration state 建議 `planned → backfilling → catching_up → verified → activated`，另有 failed/cancelled；每次以 candidate release + target encoder fingerprint + scope + retrieval mode 綁定，保存 counts、coverage、errors、last checkpoint、驗證時間，不存 secret。所有受影響 namespaces（私有/共享、wiki/V2 edge/V3 narrative）均須計入，ACL 不變。

1. 驗證候選 provider/model/region/dimension/version/task policy；未改 encoder key 不觸發遷移。
2. 建新 index 空間，分批 idempotent backfill；舊向量持續服務，不使用 destructive rebuild/delete。
3. 處理 backfill 期間新增/更新/revoke：可採受控 drain/final catch-up 或現有可驗證雙寫；以 source version/active revision 水位證明無缺口。
4. 在切 pointer 前以 transaction/受控維護窗口核對 candidate hash、完整性、revocation、coverage、新資料水位；過期驗證不可發布。若使用 drain，明確阻止新 writes 至驗證完成，不只暫停 queue 卻允許其他寫路徑。
5. 切 active release，後續新 run 用新 encoder；已 pin 的 execution 不混用。舊 index 保留，rollback 前確認舊空間對新增資料 coverage，必要時 catch-up；fallback lexical 明確顯示，不能宣稱完整向量檢索。

不自動清理舊索引。無法完成全域 coverage 就保持舊 selector，記錄 BLOCKED。模型 allowlist、IAM、quota 仍由部署管理，不因 UI 加入新模型而自動授權。

## 8. API / UI 增量

沿用 Part 1 deployment-admin auth、CAS、audit、error format、provider allowlist。建議端口後綴（按實際 repo 調整）：

| Method/path | 功能 |
|---|---|
| GET /prompts/:task | active/draft/effective protected text、版本 metadata |
| PATCH /draft | Part 1 API 擴充 editable prompt/Agent slot；expectedRevision |
| GET /prompts/:task/versions | 歷史分頁、diff、選舊版作新 draft |
| GET /schemas/:task | code-derived readonly contract |
| POST /playground | bounded baseline/candidate dry-run，回 checked layers/metrics |
| POST /validate | 擴充 candidate contract/golden evaluation 與 embedding gate |
| GET /embedding/migrations | 進度與 coverage |
| POST /embedding/migrations | 建立 migration plan（不直接切 active） |
| POST /releases | 沿用 Part 1 CAS；新增 prompt/embedding 相容性與測試 gates |

前端新增 Prompts/Schemas tabs、Playground、Embedding Migration；Tasks detail 顯示 active vs draft route、prompt version、schema/validator、effective prompt。Prompts 提供 diff、protected sections lock、editor、reset-to-version（只改 draft）、歷史、測試。Schemas 只有 viewer/copy，無 edit。Releases 顯示模型、prompt、contract、migration diff 及 blocking issues。所有 loading/error/permission/conflict/timeout/empty 狀態真實可用；不能用本地 state 假裝已發布。

## 9. Observability / 版本語義

沿用 `llm_execution` 與 `graph_task_contract` 日誌。每個 provider_attempt/stage_output/publication 關聯 release_id、model/task/release fingerprints、prompt id/version/hash、schema/validator versions、actual provider/model/fallback、job/run/attempt/sourceVersion、latency、usage。避免重複累計 usage；沒有 price book 則 estimatedCost=null。動態 release 的 task fingerprint 不得仍固定為 process-startup 常數；startup code contract hash 與 execution effective contract hash 分開。歷史舊資料無版本記錄標 legacy/unknown，不回填虛構值。保留原 job.error validation summary、review/backoff/retry 行為；不得因發布新 prompt 自動重跑全部舊 jobs 或 rewrite wiki。

## 10. 驗收矩陣

| ID | 必須證明 |
|---|---|
| P2-01 | baseline v1 prompt/legacy path 保持相容，原 golden/negative fixtures 通過 |
| P2-02 | 管理員編輯 Parser prompt → dry-run → publish → 新 job 用新版，無需 restart/redeploy |
| P2-03 | 已 pin 的 job/run、retry/restart 仍用舊 prompt，跨 replica 無污染 |
| P2-04 | protected instructions 無法刪改；惡意 source、假 quote、反向因果、錯 actor、偽造 refs/ACL 仍被 gate 擋下 |
| P2-05 | Schema Viewer 直接來源於 Zod；未知 task/version、incompatible contract 拒絕；無 schema mutation API |
| P2-06 | Playground 真實共用 adapters/validators，no publication/no tools/no Cloud Tasks；標明 not-run checks |
| P2-07 | draft 更改使驗證失效；錯誤 candidate/並行 CAS/非管理員/SSRF/secret leak 拒絕 |
| P2-08 | Agent instruction 新 run 生效，原 tools/skills/memory/history 保留，active run 不變 |
| P2-09 | prompt rollback 不刪歷史、不修改原 job pin、不繞過 review；舊 code incompatibility 明確阻止 |
| P2-10 | embedding 未完成/水位過期禁止切換；完成 backfill/catch-up 後使用新 key；舊 key 保留、rollback coverage 驗證 |
| P2-11 | browser E2E：Tasks→Prompts→Schemas→Playground→Release、真實 API、reload persistence、錯誤/權限 |
| P2-12 | 真實 disposable PG/GCS、Vertex + compatible provider smoke（具備合法測試資源時）、Cloud Run 多副本 rollout/rollback 演練 |

先 focused tests，再一次完整 Node/Python regression、typecheck、frontend build/E2E、repo checks，沿用 Part 1 runner；不提高 timeout 掩蓋缺陷。保留原 LLM Part 2 validation/evidence/temporal/revocation/persistence 測試，另測 UTF-16/Unicode、negation/identity、time/state/event、malformed JSON、provider failure 與 review exhaustion。真實 Vertex 品質需標註 corpus，不以 scripted fixtures 宣稱模型 benchmark。

## 11. GCP 與交付

沿用現有 Vercel、Runtime、Host、Worker、Cloud SQL、Secret Manager、Logging、Cloud Tasks。新增 additive migration/grants（如必要），部署相容 reader/image 後才發布新 prompt contract；不得在舊 consumer 仍處理工作時啟用不相容 release。提供 staging/production 操作 SOP：備份、drain、測試、發布、觀察 review/reject/backlog/p95/usage、rollback。保留舊 source/evidence/graph/indices，禁止 destructive SQL rollback。回滾若降低 validator gate，隔離既有 review/rejected jobs。

交付 source、tests、migration/config examples、更新 `docs/llm-management-console-operations.md`、新增 `docs/llm-management-console-part-2-report.md` 及 machine-readable results，記錄實際 commits、API/file index、設計偏差、每項 PASS/FAIL/SKIP/BLOCKED、剩餘 cloud gate、Embedding Migration 是否採 CLI。未經真實雲端驗收不可宣稱 production ready。完成後不得自行增加 Part 3 範圍。
