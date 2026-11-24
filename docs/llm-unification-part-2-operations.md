# Part 2 部署、review、版本查詢與回滾 SOP

本 SOP 承接 [Part 1 操作指南](llm-unification-deployment.md)。Part 2 不需要 SQL migration、重建
既有 embedding、修改 IAM/ACL、Bot ID 或 Cloud Tasks payload。部署單位仍是現有 Host、Runtime、Graph
Worker；Completion、Scheduler、Reconcile 的責任不變。以下是操作程序，**不代表已實際部署驗收**。

## 1. 發布前保存與核對

1. 保存目前 Host / Runtime / Worker 的 image digest、revision、流量比例、設定檔版本及 registry
   fingerprint。記錄 DB migration head、compilerVersion、retrievalMode、wiki/edge embedding keys 和 GCS
   object generations；分開保存，不能用單一「版本」替代全部。rollback image 基準為已驗收 Part 1
   `44be792596e8ea1cbecc85b5415e415e631f876e`。
2. 使用相同 release artifact 建置 Runtime / Worker。`ModelRegistry` 啟動驗證 task → role / prompt /
   schema / validator 組合。`configureLLMDeployment` 在 legacy 與 registry 設定均輸出
   `graph_task_contract.fingerprint`；TS 工作者必須一致。Python Host 的既有 `llm_config` 仍核對 model
   config fingerprint，Python 不執行 TS Graph prompt，毋須假裝有同一個 Graph prompt fingerprint。
3. Registry 路徑另核對 `llm_config.fingerprint`，延續 Part 1 的 `llmFingerprint` 啟動 gate。Model
   fingerprint 不包含 prompt；`graph_task_contract` 包含 prompt 本文、stage output JSON schema 與
   validator version。發布清單必須同時保存兩者及 image digest；validator 行為改動必須升 validator
   version，不能只靠相同 fingerprint 判斷程式相同。
4. 執行完整離線 suite、typecheck 和 repository checks。於 staging 另執行下列真實服務 gate。缺少
   credentials / disposable resources 時維持 blocked，不能把 skip 當 pass。僅呼叫模型的既有 Service
   Account 需要所選 inference project 的 `roles/aiplatform.user`，沿用 ADC / Workload Identity；
   不部署固定 access token 或 SA JSON，保留既有 SQL / Storage / Tasks 最小權限。

從 `examples/copilotkit` 執行（Node 支援 `node:sqlite`）：

```sh
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
./node_modules/.bin/tsc --noEmit
# 以下環境變數只用於可選測試；先設定至受信任的測試資源，勿使用 production DSN/bucket。
# AGUI_VERTEX_SMOKE_CONFIG：包含所需 Graph model roles 的 registry JSON 檔案。
# HERMES_AGUI_TEST_RUNTIME_DATABASE_URL：已套用既有 migration 的 disposable PostgreSQL。
# AGUI_GCS_BUCKET：disposable GCS bucket，與 PostgreSQL 指向同一測試環境。
npm test -- tests/llm-vertex-flow.test.ts --reporter=verbose
npm test -- tests/llm-embedding-durable.test.ts tests/llm-validation-cloud.test.ts --reporter=verbose
npm test -- tests/graph-v2-postgres.test.ts tests/graph-v3-postgres.test.ts --reporter=verbose
```

真實 PG/GCS 測試會保留隨機 tenant 的 immutable objects / history；回收是另一次限定 tenant 的管理作業。
`llm-validation-cloud` 的第一項使用 scripted inference + 真實 PG/GCS；第二項才是 Vertex + PG/GCS，
且正例必須 `completed`，`needs_review` 不冒充正向 live acceptance。這些測試仍不能代替 Cloud Run
traffic、Cloud Tasks delivery 和 production IAM 的 staging 演練。

## 2. Staging 與逐步 rollout

1. 使用既有 delivery 控制暫停／drain 新 ingest，讓 running jobs 完成或按既有 lease/shutdown 規則恢復；
   不直接 UPDATE token、lease、attempt，不改 Task payload。此步用於協調多服務 release，無新排程器。
2. 部署候選 revisions 至 staging，保存啟動的 task / model fingerprints。先驗證既有資料讀取、來源撤銷、
   私有／共享 namespace、不同 Bot / principal 的隔離，再用測試來源跑 worker → publication → retrieval
   → grounded story。核對 source attribution、uncertainty 與 untrusted-data warning 沒有被輸出轉述消除。
3. 故障演練分開執行：401/過期 token 不跨供應商、429/5xx 只走 allowlist+既有 deadline、malformed
   output、不合法 evidence、in-flight revoke、publish CAS/lease 失敗、兩 worker 競爭、重送與 reconcile。
   每次檢查原始 source/job 仍可追溯，沒有部分 active rows/pointers；不要只看 HTTP 成功。
4. embedding 設定不變時不要 reindex。若另行改 embedding model，仍遵守 Part 1：先建另一個 key 空間、
   再切 selector、保留舊向量；不可因本次 prompt 發布清理 index 或混用空間。
5. 核對 release manifest 後，按既有部署程序逐步切 Runtime / Worker 流量並恢復 delivery。逐服務切換
   不等於跨服務原子切換；尚未對齊 fingerprint 時不要恢復 processing。觀察 review/reject 比例、queue
   backlog、重試率與模型呼叫量，再增加流量。門檻取 staging 基線，未量測前不宣稱通用數值 SLO。

## 3. Review / reject 與安全重試

- `accepted` 僅表示通過 `checkedLayers` 中的檢查，不宣稱客觀真實。`provider_attempt` 或
  `stage_output` 的 accepted 通常只有 output 格式；只有 `phase=publication` 成功才表示原子發布完成。
- `needs_review` 不進 active/supported。整次候選 publication 不發布；source/job 保留，延續原本
  pending/backoff，第三次失敗轉 `failed`。`rejected` 同樣沿既有 retry/failed 契約。沒有新 queue state、
  強制 approve API 或直接把 review 轉 active 的入口。
- V2 job 的既有 `error` TEXT 欄位可為 JSON validation summary：`stage`、`validatorVersion`、
  `checkedLayers`、`verdict`、`issues[{stage,layer,code,verdict}]`。V1 的 `compile_failed` 字串保留。
  UI/管理腳本應容許既有字串與 JSON 字串兩種值；不依賴 error.message 猜 verdict。
- Source-span / ref / schema / source-version / state-slot 等硬性錯誤使用 `rejected`；非 extractive
  paraphrase、inferred certainty、無法確認的 alias/identity、actor/cause/custom-label 則 review。
  原有時序 resolver 與 store transaction 的錯誤也轉為固定 issue code，不把任意錯誤本文放入觀測紀錄。
- 人工複核透過既有 scoped Graph browser / ingest CLI 取 source、evidence 與 status。核對引用、UTF-16
  位置、人物身分、方向、時序、模型／prompt／schema／validator 版本；撤銷來源不得重新啟用。
  確認並修正可信來源／parser 或 prompt 後，使用既有 `retry`；所有 gates 必須再跑一次。已發布的錯誤
  資料走原有 revoke/rebuild，而不是直接修改 edge 或 active pointer。

既有本機管理 CLI，從 `examples/copilotkit` 執行。`DATA_ROOT`、`GRAPH_ADMIN_CONFIG` 是管理員確認的
路徑；config 包含既有 namespace、`graphCompilerVersion: "v2"`、compiler 設定。GCP backend 延續
`AGUI_STORAGE_BACKEND=gcp`、既有 runtime DSN/bucket 設定，切勿把 browser/model 輸入當 namespace。

```sh
node --import tsx server/graph/ingest-cli.ts "$DATA_ROOT" "$GRAPH_ADMIN_CONFIG" status "$JOB_ID"
node --import tsx server/graph/ingest-cli.ts "$DATA_ROOT" "$GRAPH_ADMIN_CONFIG" jobs
# 僅在 failed/cancelled 且來源仍有效、問題已處理時執行：
node --import tsx server/graph/ingest-cli.ts "$DATA_ROOT" "$GRAPH_ADMIN_CONFIG" retry "$JOB_ID"
node --import tsx server/graph/ingest-cli.ts "$DATA_ROOT" "$GRAPH_ADMIN_CONFIG" process "$JOB_ID"
```

沒有自動第二個 LLM reviewer；此 release 用 deterministic checks + 人工複核，無額外 reviewer 模型、費用
或 timeout。未回答的 review 永遠不升級為 verified；日後引入 LLM reviewer 必須另外加 feature flag、
明確 role、token/deadline budget、usage 與失敗仍 review 的測試。

## 4. 版本查詢與觀測

Cloud Run 收集結構化 stderr（明確 `severity=INFO`，保留 CLI stdout 的單一 JSON 契約） `event=llm_execution`；按 `jobId + attempt + sourceVersion` join
provider、stage 和 publication records。非 ingest 的 query/story model calls 沒有 jobId，使用 executionId。
AsyncLocalStorage 隔離同一程序內不同 job 的 context，不改 model 路由或會話快取。

紀錄含 task/prompt/schema/validator version、prompt hash、taskFingerprint、實際 provider/model（包含
fallback）、config hash、起訖時間／latency、validation summary、可用的 token usage。缺少 usage 用 null，
不寫成零；沒有 price book，`estimatedCost=null`，不虛報已計價成本。Graph ingest 未執行 embedding 的
record `embeddingFingerprint=null`；向量版本查詢使用原有 encoder/index key，沒有假裝整個 ingest
重嵌入或跨索引空間的 transaction。Legacy provider/model 記在 stage_output；registry 實際 provider
記在 provider_attempt，兩者不混當 production模型品質比較。

結構化紀錄不含 source/session 本文、完整模型回覆、credentials 或原始 exception。不要開 HTTP body debug
來補 usage。營運應為執行紀錄設定適當的受限存取、保留時間與匯出；這版沒有新增每 attempt 的 SQL
history table，stderr 若未被收集會失去歷史模型用量。當次 V2 review/reject 原因仍持久化於 job.error。
需長期稽核時，先確認既有 Cloud Logging 留存可用，再恢復 delivery。

以 stage / taskFingerprint / model 分組計算 JSON pass、review/reject/retry、p50/p95 latency 與 token；
只累計 provider_attempt usage，勿將 stage_output/publication 重複加總。semantic/identity/direction/
時間準確率必須以已標註 corpus 或人工結果為分母，不能把 accepted rate 當 accuracy。

舊資料沒有這版的歷史 execution envelope，標示 legacy/unknown，勿回填虛構版本。查詢現有 source/job、
evidence version、compiler namespace 與 vector key 後，先在 staging 的獨立測試資源 replay 原始來源；
正式環境的既有 scoped `rebuild` 會影響 active pages，應另開維護窗口，重新驗證 ACL、revoke、CAS 和
讀取結果。本次部署不自動 rebuild/replay，也不讓 prompt 變動觸發 SQL migration。

## 5. 回滾

1. 暫停／drain delivery，保存候選 revision fingerprints、review summaries 與 queue 狀態。
2. 使用原部署工具將 Host / Runtime / Worker 切回保存的 Part 1 images / revisions / configs / traffic，
   核對原本 model config fingerprint 和 embedding selectors；不只換 provider 名稱。
3. 不刪表、不回退 DB migration、不覆寫 GCS generations、不清向量、不改 evidence/sourceVersion、
   Bot 身分或 ACL。V2 error JSON 是 TEXT，Part 1 仍可讀／重試，無 SQL schema rollback。
4. **隔離本次 review/rejected job IDs，暫不重試**：Part 1 缺乏新 semantic gate，盲目 retry 可能發布本次
   已擋下的不可信內容。先取消仍 pending 的這些 jobs（保留 source/history），待可信修正版部署後再
   逐項人工 retry。不得把回滾當作繞過 review 的 approve。
5. 驗證舊 active 資料、tenant isolation、source revoke、worker lease/CAS、retrieval/story、原向量 key
   可用；確認無部分發布，再恢復 delivery。記錄實際操作時間與 smoke 結果。清理舊索引／objects
   留待獨立管理作業。
