# LLM Management Console — Part 3: Managed Mode Simplification

## 0. Codex 執行契約

- Repository: `jiangweitaiwan/hermes_agui`。
- Branch: `codex/graph-memory-v2`（若實際工作分支不同，先記錄，不擅自切換或覆寫使用者變更）。
- 基準 commit: `a149486198a48cc8f32d63a28908fd09a23e129a`。若 HEAD 已前進，先核對差異，以實際 source 為準。
- 先讀 `docs/LLM_MANAGEMENT_CONSOLE_PART_1.md`、`docs/LLM_MANAGEMENT_CONSOLE_PART_2.md`、兩階段報告、`docs/llm-management-console-operations.md`、現行 migrations/grants、Runtime/Host/Worker 啟動與 Bot lifecycle。
- 本階段只修改 source、tests、config examples、必要 additive migrations/grants 與文件。不得操作 production DB、部署 GCP、使用正式憑證或刪除歷史資料。
- 不重做既有 Provider Adapter、Prompt Registry、Schema Viewer、Playground、Release Control Plane 或 Graph Memory。
- 下文函式名稱與新路徑為設計建議，實作前核對現有 callsites；不得假設未查證的函式存在。

## 1. 目標與語義

`llmControl.mode = managed` 是唯一的部署層級 LLM 管理啟用開關。所有符合資格的 native Hermes Bot（既有及未來新增）自動使用 active release 的 `agent_primary`。Graph ingest/retrieval 各階段繼續使用 release 中對應角色。

| 行為 | static | managed |
|---|---|---|
| 初始 release | 無需控制面 | Runtime 自動初始化一次 |
| 既有與新增 native Hermes Bot | 原設定 | 自動使用 agent_primary |
| 手動 Bootstrap | 不需要 | 不需要 |
| 手動 Bot Opt-in | 不需要 | 不需要 |
| Model/Provider/Prompt | 原 static 行為 | 前端 draft/validate/publish |
| Run/Job 版本 | 原契約 | immutable release pin |
| 外部 AG-UI Agent | 原行為 | 不強制套用 Hermes primary；Runtime 管理的 Graph stages 仍依既有契約 |

不新增 per-Bot LLM opt-in 開關、不新增 Bootstrap/Opt-in UI 按鈕、不新增背景服務。保留 static 相容性，不擴張 native auxiliary 等尚未統一的模型範圍。Provider allowlist、IAM、Secret Manager、schema/validator 與 embedding migration gate 維持原安全契約。

## 2. 現況與改造入口

基準 commit 已核對：
- `examples/copilotkit/server/llm/control-cli.ts`：`bootstrap|opt-in` 手動入口。
- `examples/copilotkit/server/llm/control-store.ts`：`bootstrap()` 建立 release-001、draft revision 1、active generation 1 和 audit；`pinRun()` 先讀 `llm_bot_roles`，無匹配則回 503；`optInBot()` 讀 `bot_registry` 並登記 role。
- `examples/copilotkit/server/llm/control-contract.ts`：`ControlSettings`、`candidate()`、`verifySnapshot()` 與 approved policy。
- `docs/llm-management-console-operations.md`：目前明訂每個 Bot（包括新 Bot）均須 opt-in，且 managed startup 需先有 release。

Codex 必須搜尋所有 `llm_bot_roles`、`optInBot`、`bootstrap`、`pinRun`、`llmControl`、`Bot requires explicit role migration` 的 Node/Python/SQL callsites、grants、tests、UI 錯誤訊息與部署文件；不能只刪一個 if 判斷。

## 3. 自動初始化 Active Release

### 3.1 Runtime 是唯一初始化寫入者

建議在 Runtime managed 啟動流程加入 `ensureInitialRelease()`，使用既有 `AGUI_LLM_ADMIN_DATABASE_URL` 與 ControlStore transaction。初始化完成且 verified active release 可解析後才接受 managed admission。Host、Worker、Completion、Reconcile 均維持 reader 身分，不授 admin DSN，不自行建立 release。

示意（非現行 source）：

```ts
if (policy.mode === "managed") {
  await verifyControlSchemaAndDatabaseDestination();
  await ensureInitialReleaseFromTrustedBaseline();
  await verifyActiveReleaseAndContracts();
}
```

資料庫 migration/grants 仍由既有部署流程事先完成；不得在 Cloud Run 冷啟動時以 owner 身分執行 DDL。Static mode 不因本功能增加任何 DB 依賴。

### 3.2 初始化狀態機與交易

以 deployment scope 為單位，在單一 transaction 內取得 transaction-scoped advisory lock 或等效可靠 DB serialization，再重新查詢 state：

| DB 狀態 | 處理 |
|---|---|
| 無 release、draft、active，且無殘留依賴控制面歷史 | 使用可信 runtime config 的 llm baseline，經現有 candidate/contract validation，原子建立 release-001、draft、active、audit |
| active 存在且控制面狀態完整 | 驗證 active snapshot、hash、policy、code compatibility；直接使用，不重建、不更新 draft 或 pointer |
| 已有 release/draft/pin 等歷史但 active 遺失、或其他不一致 | fail closed，回傳去敏診斷，不自動修復、不重新 bootstrap |
| baseline 無效、schema/grant 缺失、DB 不可用 | fail closed，不回退 static，不接新工作 |

檢查現有 draft/release 狀態與 schema 約束，避免把合法未發布 draft 誤判為異常。不得以 bootstrap baseline 是否與目前 active 相同作為已初始化部署的通過條件；前端已發布的合法版本才是來源。現有 baseline 啟動契約與 approved policy 相容性檢查仍保留。

多 Runtime replica 同時冷啟動時只允許一筆初始化 audit；其他 replica 讀同一 release。失敗 transaction 必須完全 rollback。使用明確 system actor，不偽造登入管理員；不記錄 secrets 或 prompt/source 原文於一般 logs。

若 Host/Worker 先於 Runtime 啟動且 DB 尚無 active，使用有限、明確的 readiness/retry 或依部署順序等待 Runtime 初始化；不得改用 static 推論。記錄實際採用策略及 timeout，不能無限重試。

### 3.3 CLI 相容性

原 bootstrap CLI 可保留為離線診斷/受控復原工具，標示非正常部署必要步驟；若保留 apply，須與自動初始化共用 serialization 與驗證契約，不能重設已發布版本。opt-in CLI 可標示 deprecated 或移除入口，更新 usage/docs/tests；不可再作為運作前置條件。

## 4. 移除逐 Bot Opt-in

### 4.1 Managed Run 授權

`pinRun()` 不再要求 `llm_bot_roles` 有匹配記錄。改以既有 Bot Manager 的可信 registry、principal、ACL、Bot lifecycle、native harness 判斷為依據。

在可信 run admission boundary 驗證 caller 可存取該 Bot/thread，Bot 存在、非刪除/停用、native Hermes eligible；不可信任 browser 提供的 harness、principal、model/provider 或 release ID。維持原 Host 的獨立授權、run lease、簽署 reference 與 persisted pin 驗證。注意授權與 pin transaction 的競態，沿用既有 lifecycle fencing 或適當 locking，不能讓已撤權/刪除 Bot 取得新 run。既有 in-flight 行為依原契約，不任意延長授權。

若 Host/SQL trigger/其他 run path 仍依賴 `llm_bot_roles`，同步消除其 opt-in gate，以等價或更嚴格的可信授權替代。檢查 delegation、重送、native cache、Bot 建立及離線匯入流程，不新增身份管理的第二套真相。

### 4.2 Model routing

```text
Native Hermes Bot → trusted admission → durable run pin
                 → immutable release → agent_primary → native adapter
```

Managed mode 下既有 Bot record 的 model/provider 只保留為 legacy/static 相容資料；不可覆寫 active release，不因舊值不同拒絕合法新 run。核對 Host 真正的 native inference/client cache 使用 release route，不能只改 UI 顯示。新 Bot 不需額外 INSERT opt-in 記錄即可使用；Bot role/persona、skills、tools、memory、thread、credential seed、ACL 維持不變。

外部 AG-UI Bot 不被強制認定為 native，也不改寫其 remote model 配置。保持既有 remote routing 和 Graph 管理語義。Native auxiliary/其他未接管模型仍如實標示 unmanaged。

### 4.3 舊資料保留

保留 `llm_bot_roles` 歷史表和原 audit，不做 destructive migration，不批量偽造 opt-in、不改 Bot ID 或 principal。正常 managed run 不依賴該表。若舊 FK/trigger/grants 需調整，使用 additive migration，記錄跨版本 rollout 相容性及最小權限；不將控制面 admin 權限授予一般 Runtime inference、Bot 或 Worker。

## 5. 前端行為

保留現有 LLM Management Console 的 Tasks、Providers、Prompts、Schemas、Playground、Releases、Embedding 功能。

- managed 初始化完成後，所有既有管理功能直接可用。
- 可顯示 managed 狀態、active release、初始化失敗的可操作診斷（不揭露 DSN/secret），不新增初始化或逐 Bot 授權按鈕。
- Bot Manager 的新增 Bot 流程保持原本的使用體驗；若有 model/provider 欄位，在 managed native 模式下顯示繼承 `agent_primary` 或清楚標示 legacy-only，不讓使用者誤以為可覆寫全域路由。
- 保持 deployment-admin authorization；一般 Bot owner 不因此取得全域 LLM 管理權限。
- 保留 draft/revision、validation、CAS publish/rollback、protected prompts、schema readonly 及 embedding migration gates。
- 不要求前端更換 Cloud Run mode；mode 仍為部署設定，首次配置及變更需運維部署。日常 LLM 變更不需要 redeploy。

## 6. Run/Job Pinning 與 Graph 相容性

不得因本次簡化而刪除 `llm_run_pins`、Graph job pin、snapshot verification 或 active pointer。新 run/job 讀 active；既有 run/job、retry、reconcile 使用原 pin。禁止把未 pin 的歷史 job 自動綁定最新 release。

首次 static → managed 遷移仍需停止新 admission/delivery 並處理 pending/running unpinned Graph jobs；沿用現有 drain 與 fencing，更新文件清楚區分一次性資料遷移和已移除的 CLI 操作。新部署無舊 job 時不需 drain。若遇舊 job 或不相容 reader，啟動/切換 fail closed 並提供清楚診斷。不得藉自動 bootstrap 繞過 review/revoke/ACL/lease gates。

## 7. 部署與回滾契約

### 新部署
1. 依既有方式配置 DB migrations/grants、可信 baseline、approved providers、ADC/IAM、Secret Manager、admin principals。
2. Runtime、Host、Worker 及相關 Jobs 使用相容 image/config，設定 managed；Runtime 先完成初始化，再開放其他 consumer readiness。
3. 登入前端 LLM Management，直接修改/驗證/發布；既有與新建 native Bot 無需 opt-in。

### 既有部署升級
- 若已手動 bootstrap/opt-in：保留所有現有 release、draft、pins、audit；不重新匯入、不回復 release-001。核對既有 active hash/generation 與 draft revision 在升級後未變。
- 若尚未 bootstrap：經原本的 static→managed 安全遷移後，由 Runtime 自動初始化。
- 所有 consumer 必須相容後才接受新 managed 工作。舊 image 仍可能要求 opt-in，故不能假設混合版本無條件相容。採既有 drain/maintenance rollout，驗證全部 revision 後恢復 traffic/delivery。
- 設定回滾仍只切 active pointer；程式回滾需處理舊 image 的 opt-in 與 pin 相容性，不為回滾而自動補造歷史 opt-in。必要時保留新版相容 reader、停止新 admission 並依既有 SOP 回到可用 static revision。禁止 drop 表或清除 pin。

更新 managed config examples 與維運文件，提供最短部署程序（不包含手動 bootstrap/opt-in）。不新增日常使用所需的外部 Cloud SQL 連線、CLI 工具或獨立服務。

## 8. 驗收矩陣

| ID | 必須證明 |
|---|---|
| P3-01 | fresh migrated DB + managed Runtime，未執行 CLI 即自動建立 release-001/draft/active/audit，前端可用 |
| P3-02 | 兩個獨立 Runtime processes 同時初始化，只建立一個初始版本與一筆 audit；失敗可安全重試 |
| P3-03 | 發布新版及保存未發布 draft 後 restart/scale-out，active、generation、draft revision、歷史均不變 |
| P3-04 | 已 bootstrap 的 DB（包括舊 opt-in rows）直接升級，不重設任何設定 |
| P3-05 | 既有未 opt-in native Bot 可以建立新 run，真正 inference 使用 agent_primary |
| P3-06 | 前端新建 native Bot，不執行 CLI、不插入 opt-in row，即可對話；同 thread 續聊正常 |
| P3-07 | 無權 principal、偽造 Bot/thread、deleted/disabled Bot、撤權競態依原授權契約被拒絕；不能偽造 release |
| P3-08 | remote AG-UI Bot 路由不受 native role 接管；static mode 無新 DB 依賴 |
| P3-09 | 前端發布新 model/prompt，新 run/job 生效；in-flight run、retry/reconcile 原 pin 不變 |
| P3-10 | DB 缺 active 但有歷史、invalid baseline、incompatible snapshot、grant/schema 不足、DB down 均 fail closed，不自動修復或回退 static |
| P3-11 | Host/Worker reader 不具有初始化寫權；Host 先啟動的 readiness/錯誤行為明確；舊 unpinned job gate 保留 |
| P3-12 | 真實 browser + API + disposable PG：managed 直接登入、管理 LLM、新增 Bot、對話、發布新版、reload persistence，無手動 bootstrap/opt-in |
| P3-13 | Part 1/2 regression：CAS、audit、provider allowlist、prompt protected contract、schema viewer、playground、embedding gate、Graph publication、ACL、跨語言 hash 不退化 |

測試先 focused，再一次完整 Node/Python regression、typecheck、frontend build/E2E、repo checks。沿用 repo 現有 runner 和 disposable PostgreSQL gate；並行初始化不可只用 mock 證明。真實 Vertex/GCS/Cloud Run gate 若缺資源標 BLOCKED，不宣稱 production ready，不連正式環境。記錄實際指令、結果與證據，不提高 timeout 掩蓋缺陷。

## 9. 交付物

- 完成 source、必要 additive migration/grants、config examples、tests。
- 更新 `docs/llm-management-console-operations.md`、相關 GCP deployment 文件與 CLI usage。
- 新增 `docs/llm-management-console-part-3-report.md` 與 machine-readable acceptance results，含實際基準/最終 commit、檔案與 callsite 索引、架構取捨、PASS/FAIL/SKIP/BLOCKED、剩餘部署風險及最短部署 SOP。
- 報告明確回答：是否仍需手動 bootstrap？是否仍需 Bot opt-in？是否所有合格既有與新 native Bot 都自動使用 active release？有沒有仍依賴舊表的 execution path？

## 10. Definition of Done

在完成一次性必要的 DB/部署配置且 consumer 相容後，使用者設定 `mode: managed` 即可登入前端管理 LLM，建立/使用 native Hermes Bot；不需要任何 bootstrap 或 opt-in CLI、SQL 手工補資料、初始化按鈕，也不需在每次修改 model/provider/prompt 時重新部署。現有版本、權限、資料及執行中工作不受破壞。

若任一必要驗收不通過，明列缺口，不以新增手動操作作為完成替代方案。完成後停止，不自行增加 Part 4。
