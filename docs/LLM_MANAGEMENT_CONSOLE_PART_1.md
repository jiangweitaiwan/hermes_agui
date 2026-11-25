# LLM Management Console — Part 1：動態模型管理與 Release Control Plane

## 0. Codex 執行契約

- Repo: `jiangweitaiwan/hermes_agui`；branch: `codex/graph-memory-v2`。
- 設計基準：`839d36297a01e9edb27551d64f798d3d5c9543b3`（LLM Unification Part 2）。開始前記錄實際 HEAD、工作樹、既有 migration head；若後續 commit 有差異，以實際 source 為準，記錄調整，不回退使用者修改。
- 先讀 `docs/LLM_UNIFICATION_GRAPH_VALIDATION_PLAN.md`、`docs/llm-unification-deployment.md`、`docs/llm-unification-part-2-operations.md`、`docs/llm-unification-part-2-report.md`、`docs/llm-call-inventory.md`、`deploy/gcp/`。盤點現有 routes、Firebase membership、Bot lifecycle、Agent session/cache、Graph job ledger/lease、DB roles、Docker entrypoints、測試。以下新路徑及 API 為設計契約，不宣稱已存在。
- 本階段完成後獨立可用；不得提前實作 Part 2 的 Prompt 編輯器或重複打造 Provider Adapter。不得部署 production、改真實 IAM、清除資料或使用 production credentials。實際雲端測試缺資源時標記 BLOCKED，不以 mock/skip 充數。

## 1. 目標與範圍

從現有 static JSON/YAML registry 升級為 PostgreSQL-backed control plane。管理員可在既有 Vercel 前端查看七個角色、設定 Provider/Model/timeout/retries/maxTokens/fallback、驗證、發布、回滾；不用重新建置 Image 或建立 Cloud Run revision。新 Run/Job 使用發布版本；執行中或重送的 Job 不混用版本。保留既有 Hermes native loop、Graph V2/V3、ACL、evidence validation、Cloud Tasks 與直接呼叫供應商的路徑。

角色固定為 `agent_primary`, `graph_parser`, `graph_matcher`, `graph_relations`, `graph_query`, `graph_story`, `graph_embedding`；不將 legacy analysis/generation/merge 誤當新增模型角色。Part 1 Prompt/Schema/Validator 固定於當前 code contract；Embedding 設定唯讀（含所有影響向量 key 的 provider/project/location/model/dimension/version），遷移留 Part 2。

不在本階段提供 per-Bot 自訂路由、任意第三方 endpoint、API key 明文輸入、自動 IAM、LLM proxy、Prompt 動態編輯或 production rollout。

## 2. 現況與架構

已核對基準檔案：
- `examples/copilotkit/server/llm/config.ts`：ModelRegistry、taskRegistry、canonical fingerprint、模型/能力 allowlist。
- `examples/copilotkit/server/llm/deployment.ts`：configureLLMDeployment 啟動時注入 Graph routes 與 templates。
- `examples/copilotkit/server/llm/providers/vertex.ts` / `openai-compatible.ts`：既有 transport；Python `hermes_agui/core/llm_registry.py`、`agent/vertex_adapter.py`：native route/ADC。
- `examples/copilotkit/server/llm/prompts/registry.ts`、`schema/registry.ts`、`validation/pipeline.ts`：code-defined task contract。

目標：Browser → Runtime admin API → PostgreSQL immutable releases / active pointer。Runtime / Worker / Host 各自取得 trusted release snapshot，直接走既有 transport。管理 API 不轉送 inference。Host 與 Runtime 不共用資料庫 owner 帳號；若採直接讀 DB，授 Host 專屬 SELECT/view 權限，不能寫控制面；若現有 DB 邊界阻止跨庫，採 Runtime 內部 authenticated read API，記錄取捨，禁止直接擴張 owner 權限。Worker 只讀控制面、依既有權限寫 job。

## 3. 儲存與版本契約

建議以五張邏輯表實作（可依 repo naming convention 合理合併，必須記錄理由）：

| Table | 欄位與責任 |
|---|---|
| llm_providers | scope, id, draft provider config, revision, updated_by/at |
| llm_models | scope, role, draft model config, revision, updated_by/at |
| llm_prompt_versions | 預留或在 Part 2 migration 建立；immutable prompt versions，不做編輯 API |
| llm_releases | scope, release_id, parent_release_id, immutable snapshot JSONB, model_fingerprint, task_fingerprint, release_fingerprint, contract compatibility, created_by/at, reason |
| llm_active_release | scope PK, release_id FK, generation, updated_by/at |

另外須有 append-only 管理 audit（沿用既有 audit 若存在；否則新增 llm_admin_events），記錄 draft update、validate、publish、rollback、actor、timestamp、old/new release、reason、request ID，不含 secret 或 source body。draft 可以是一份原子 JSONB aggregate，以單一 revision 防止多表 torn reads；不要求為五表而強行拆碎。全域管理 scope 為 deployment，非普通 workspace owner；如實際系統多租戶，不把全域寫權限授予租戶。

Release snapshot 應完整包含原有 `llm` config、各 task 的 role/schema/prompt/validator version、code task fingerprint、相容版本及不可變 prompt 內容或可驗證引用（Part 1 使用 code baseline）。獨立 release fingerprint 覆蓋完整 snapshot，沿用原有 model fingerprint，不重定義既有 vector fingerprint。TS/Python canonical hash 必須有跨語言 golden fixtures。禁止更新已發布 payload；rollback 是重新切 active pointer 並新增 audit，不是覆寫歷史。

發布以 transaction + CAS expected generation/draft revision 實作；同時發布兩份 draft 只能有一份成功。FK/unique constraints、migration idempotence、DB grants、backup/rollback SOP 都需驗證。active pointer 不得指向不同 scope 或未驗證 release。不得把任意 key、token、憑證內容存入 snapshot。

## 4. Bootstrap 與相容性

提供 feature flag（建議 `AGUI_LLM_CONFIG_MODE=static|managed`，實際命名依現有慣例），static 為預設，維持原有 JSON/YAML 啟動行為。提供可信管理 CLI 匯入完整現有 registry；先 dry-run 驗證，再明確建立 release-001 並啟用；不得每次 cold start 自動覆寫 DB。legacy 未啟用 registry 的部署繼續 static；不可猜測其路由後自動遷移。

Managed mode 不允許同一角色存在衝突的 legacy routing 或無聲 fallback 到 static。保存既有 Bot ID、template ID、thread、namespace、principal、profile credential seed；盤點已存在 Bot 的固定 model/provider 是否須遷移至 role，區分 legacy Bot 與 managed Bot，提供可稽核、可重複執行的 opt-in migration，不改 identity 或 ACL。

啟動檢查 DB schema、release/contract 相容性。跨 revision rolling deploy 先部署相容 reader 再啟用 managed；未相容 consumer 不得接新工作。依既有服務身分保護 internal resolve API；不要信任 browser 傳來的 release_id/model/provider。

## 5. Execution Pinning（核心）

### 5.1 Agent Run / Retrieval
- Runtime 在可信 request boundary 解析 active release 一次，固定於 run context；memory query parser、retrieval embedding、storyteller、Host native Agent primary 均使用同一 snapshot（若 embedding selector 獨立，仍須納入相容 release）。
- Runtime → Host 的既有 AG-UI/內部 metadata 只傳經驗證的 release reference；由 service identity/ACL 保護，Host 自行解析與核對 fingerprint。禁止 user messages 或公開 request 覆寫 release。
- Python session/native client cache key 納入 release/model fingerprint；在新 run 邊界安全建立/更新 client，保留 thread history、tools、skills、memory、native prompt assembly。in-flight tool loop 不變更 provider；並發不同 run 不得污染全域 env 或其他 profile。
- 檢查 native timeout/retry/maxTokens 實際語義；UI 不宣稱未接線參數生效。保留 agent_primary fallback=[]；native auxiliary、delegation、resumed runs 逐一盤點，未納入者標明仍由 native config 管理，不可假稱全數統一。
- 恢復同一 persisted run 時沿用原 pin；新的獨立 run 才讀新 active。Delegation 若屬同一 run，繼承 pin；獨立子 run 的選擇策略明文記錄且測試。

### 5.2 Graph Job / Worker
- 在建立 ingest job 的同一可信 transaction 中持久化 llm_release_id（可加 nullable migration 相容歷史 rows），與 source/version/job identity 綁定。
- Worker 按持久化 job pin 取得 immutable release，勿以 Cloud Tasks payload 或當前 active 取代；重試、重送、lease recovery、reconcile 必須沿用原 pin。Parser/Matcher/Relations/validation 共享 context。
- 既有未 pin 的 job：managed 啟用前 drain 或按明確 migration policy 原子補 pin，不能在每次 retry 任意重選。人工用新設定重跑應建立新的受控 job/attempt lineage，不偷偷修改舊 pin，不繞過 revoke/review gate。
- 若 embedding 在 compilation 外另有索引任務，核對其 fingerprint/selector 與工作綁定，維持舊 index space 不混用。

### 5.3 Cache 與故障
每個新 execution 讀 active pointer；immutable snapshot 可 bounded cache（key=scope+release_id+hash）。不靠 TTL 才更新 active；DB/內部 API 不可用時，新 managed execution fail closed、可安全重試，不默默使用舊 active。已 pin 且 snapshot 已驗證的進行中 execution 可依原 deadline 完成；若 job pin 無法解析不得 publish。取消、timeout、pool 連線預算延續現有契約。

## 6. Provider / Model 安全與驗證

沿用既有 registry Zod/Python parser；禁止未知 role/capability、dangling fallback、超限 budgets。Vertex 使用 ADC、配置 project/location allowlist；目前基準允許 Gemini 2.5 Flash/Pro、regional gemini-embedding-001，實際部署查 model availability/quota，不單純放寬 allowlist。新模型需經 adapter/contract tests。

OpenAI-compatible endpoint 只允許部署方預先批准的 HTTPS origin/path；拒絕私有網段、metadata endpoint、redirect escape、任意 DNS/URL；secret reference 必須在部署 allowlist，且讀取 scope 匹配。使用既有 env/Secret Manager 注入；新增尚未掛載的 secret/IAM 可能需要運維部署，UI 不自行授權。禁止顯示 secret value；test endpoint 不接受任意 URL/key 或真實 session；限制 timeout、速率、並發、token budget；errors redacted。跨 vendor 傳送資料須由管理員明確確認授權的 provider。

## 7. API 與前端

在既有 Runtime route/auth 層加入 `/api/admin/llm/*`（命名可調整）：

| Method/path suffix | 契約 |
|---|---|
| GET /tasks | 七角色、active route、contract versions、managed/static 狀態 |
| GET /providers | 已批准 provider/能力/可選 model/secret reference 狀態（不含 secret） |
| GET /draft | 完整草稿、revision、active generation |
| PATCH /draft | expectedRevision + typed changes；原子驗證並存草稿 |
| POST /providers/test | draft/provider id；服務端 bounded synthetic probe，回 redacted status/latency |
| POST /validate | 完整 candidate validation、diff、blocking issues；回 candidate hash |
| POST /releases | expectedGeneration、draftRevision、candidateHash、reason；重新驗證後發布 |
| GET /releases | 分頁歷史、版本與 audit 摘要 |
| POST /rollback | target release + expectedGeneration + reason；重驗相容性，CAS 切換 |

所有端口 server-side deployment-admin allowlist/role 檢查；普通 Firebase member/owner、Bot、agent tool 均無權；401/403、跨 scope、CSRF（依既有 auth transport）、rate limit、409 CAS、輸入大小限制。前端隱藏入口不是授權。禁止 browser 直接存取 DB/Secret Manager。

UI 依既有 UI framework、路由與 design conventions 新增 LLM Management：Tasks（依 Agent/Ingest/Retrieval/Embedding 分組）、Providers、Releases。顯示 active 與 draft diff、validation errors、loading/empty/error、conflict reload、publish/rollback confirmation、release hash、actor/time；Embedding 和 Prompt/Schema/Validator version 唯讀，尚未支援功能不顯示假成功。前端不硬編模型清單，以後端能力為準。操作成功必須以後端回覆為準。

## 8. 測試與驗收

先重現 baseline，再新增 focused tests，最後跑一次完整 regression；不要為了通過而放寬既有檢查或 timeout。使用現有測試 runner、可重現的 fixtures。

| ID | 必須證明 |
|---|---|
| P1-01 | static legacy/registry 原行為、相同 Bot/thread、無新控制面依賴 |
| P1-02 | bootstrap 冪等、secret-free snapshot、TS/Python fingerprint 一致、invalid config 拒絕 |
| P1-03 | 非管理員/跨 scope/偽造 pin/SSRF/secret leak 全部拒絕 |
| P1-04 | UI 修改 Parser model/provider → draft → validate → publish → 新 job 使用新 route，無需重啟服務 |
| P1-05 | Run A 已 pin Flash，發布 Pro，A 後續 tool call 保持 Flash，Run B 使用 Pro；同 thread 可續聊 |
| P1-06 | Graph job 執行中發布新 release，所有 stage 與 restart/retry 仍用原 pin；新 job 用新 release |
| P1-07 | 多 Runtime/Worker replicas、並行 publish CAS、一致 active pointer、無跨 run cache 污染 |
| P1-08 | DB/resolve failure、missing snapshot、incompatible image fail closed；不部分發布 Graph |
| P1-09 | rollback 舊 release，新 run 生效，歷史 pin、ACL/revoke/review、舊向量保留 |
| P1-10 | UI E2E（實際 API + browser）、管理 audit、模型執行 logs 帶 release_id/fingerprints |
| P1-11 | 真實 disposable PostgreSQL migration/grants/兩副本；真實 Vertex ADC + Graph smoke（獨立 gate） |

既有 Node tests（`examples/copilotkit`）：`npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000`、`./node_modules/.bin/tsc --noEmit`；Python 走 `scripts/run_tests.sh`（registry/headless/vertex 及新增測試）；`python scripts/check --base <baseline>`。依 repo 實際 runner 增加前端 build/E2E。真實 Vertex、PG/GCS、Cloud Run tests 依既有 SOP，不可拿 mock 代替。已知基準 repo check 有既存 no-tmp 問題，分開記錄新舊缺陷。

## 9. GCP 交付與回滾

提供 additive SQL migration、最小 grants、static/managed config examples、Secret reference/ADC 說明、Host/Runtime/Worker IAM 與 DB pool budget、Vercel 前端變數（不得含秘密）。先備份 PG/GCS 一致參照及 revisions，部署相容 readers，staging bootstrap，驗證所有 consumer，drain 後切 managed，驗證新工作及 rollback。Completion/Reconcile/Scheduler topology 不改，但其 entrypoints 若讀相同 config 需相容測試。

回滾分兩類：設定 rollback 只 CAS pointer；程式 rollback 需先停止新 managed 工作、隔離未完成 pinned jobs、恢復相容 static revisions/config，再依 SOP drain/retry。保留 tables/releases、source/evidence、job ledger、vector spaces。不得用回滾繞過 review/rejected gate。

## 10. Codex 交付物

- Source、migration/grants、前端、tests、必要 config examples。
- `docs/llm-management-console-part-1-report.md`：基準/最終 commit、架構差異、檔案索引、API、實際測試命令及 PASS/FAIL/SKIP/BLOCKED、未完成風險、Part 2 接口。
- `docs/llm-management-console-operations.md`：部署/匯入/發布/回滾/權限/故障 SOP。
- 不含 production secret 的 machine-readable acceptance results；若 repo 慣例不同可調整。

完成 P1-01 至 P1-10 的本地可重現驗收及 P1-11 環境可用部分後，才標示離線交付；真實 cloud gate 未通過時禁止宣稱 production ready。Part 2 以實際 Part 1 commit 為基準，不重做 control plane。
