# LLM Unification — Part 2 驗收報告

## 基準、範圍與驗收狀態

交付分支為 `codex/graph-memory-v2`。以已驗收 Part 1 HEAD **`44be792596e8ea1cbecc85b5415e415e631f876e`** 為基礎，開始時工作樹乾淨。
計畫的 `820b9f4` 是 Part 1 前的規劃基準；本次未回退或覆蓋 Part 1。實作範圍是 Graph Prompt Registry、
四層 validation、review/reject、版本／觀測與回歸；未再設計 Provider API、Agent Loop 或 RPC。

**離線實作與測試交付；正式雲端驗收仍 blocked。** 未提供這次可用的真實 Vertex 測試設定、disposable
PostgreSQL/GCS 與 Cloud Run rollout 環境；live / cloud tests 的 skip 不算 pass，也沒有部署到正式環境。
詳細數據見 [機器可讀結果](../artifacts/llm-unification-part-2/results.json) 與
[golden 評估](../artifacts/llm-unification-part-2/golden-results.json)。

## 實作與相容性

| 項目 | 最終行為與程式位置 |
|---|---|
| Prompt Registry | `server/llm/prompts/registry.ts` 集中通用 instruction 與 parser/matcher/relations/query/story/legacy merge 規則。每個 prompt 有 id/version；system 指令與 user source/query envelope 分開，維持 untrusted data 宣告。literal grounding 限制不改變原本 event/stable 分類與模型路由。 |
| Task 組合 | `llm/config.ts` 的 immutable task contracts 綁定既有 role、schema v1、prompt v1、validator v1；未知／缺漏／不相容組合 fail startup。model config fingerprint 不變；新增獨立 task fingerprint，包含 prompt 本文及生成的 output schema。 |
| Output | 延用 Part 1 唯一 Zod schema，集中 `validateOutput` 與 compiler 呼叫的大小／abort 邊界；未知權限欄位與非法 ref 不能進下一層。legacy/V2/registry transport 不新增 Provider API。 |
| Evidence / Semantic | 保留 UTF-16 slice、quote hash 與可信 sourceVersion；檢查重複句的位置、extractive claim/description、人物 identity/alias、actor、方向、因果、否定與 uncertainty。非 literal paraphrase、不足以機證者 review。不是把 quote 存在當作 entailment 證明。 |
| Domain | 沿用 matcher、temporal resolver、Wiki merge；補 explicit identity mismatch 禁止強制 merge、ref/anchor/state-event 檢查、publication graph integrity、event/edge/evidence/source-version/hash/temporal interval 檢查。ID/hash/time/ACL 仍由 server 產生。 |
| Persistence | scope/source-version/hash preflight；store transaction 仍是 ACL、revocation、CAS、lease、foreign reference 與 atomic publish 權威，未用 preflight 取代鎖或授權。SQLite/PostgreSQL 既有 `error` TEXT 可記規範化 V2 validation summary。 |
| Review / reject | `accepted / needs_review / rejected` + issue codes + stage + checkedLayers；整次候選 publication 拒絕發布，保留原 source/job。延續 pending/backoff/第三次 failed，人工修正後走既有 scoped retry，無 approve bypass、新 queue state 或遺失事件。 |
| 版本／觀測 | job/attempt/sourceVersion 關聯 provider_attempt、stage_output、publication；AsyncLocalStorage 隔離並行 scope。記 prompt/schema/validator、task/config hashes、實際 model/provider/fallback、timestamp/latency、可用 token usage，估價缺省 null。結構化 stderr INFO 保留 CLI stdout JSON 契約。 |
| Retrieval V3 | 保留 query literal/source-ref 檢查、grounded storyteller、attribution、uncertainty、revocation、namespace isolation 與原 deterministic/lexical fallback；不讓生成 story 重新取得持久化權限。 |

沒有改 SQL schema、GraphData/Evidence 持久化欄位、ACL、Bot 身分、Cloud Tasks topology 或向量 keys。
`CompilerLLM.json`、`Encoder`、Vertex/OpenAI-compatible `generate` 呼叫簽章不變；Provider 僅新增從已讀
response 取得 token counts 的小型 instrumentation，不換 driver、認證、retry/fallback 或 deadline 策略。
Python native resolver、per-conversation prompt cache 不受 Graph 的 stateless stage prompt 版本化影響。

Relation evidence bridge 使用**既有 narrativeRef**：必須屬於 parser narrative，主客體也必須屬於該
narrative；server 從該 narrative 建立 evidence/source/version/hash。不另新增可由模型填寫的 source IDs
或 persistence `evidenceRefs` 欄位，避免與現有 Evidence model 重複及破壞相容性。

既有自訂 label 測試的 `maintains/responsible_for` 並未出現在來源中。這次保留自訂 relation 功能，但將
該正例改用來源中實際存在的「回滾／報告／原因是／草擬／交給」；非 literal label 現在需要 review。
這是明確的 grounding gate 收緊，未放寬 negative tests 或改 enum/domain schema。

## 測試證據與失敗紀錄

使用相同 Node 22、15 秒一般 test timeout 執行 baseline / candidate。基線及早期候選用 2 workers；
最後為排除 worker stall 改用 1 worker，並僅在測試期間防止 idle sleep，未提高 timeout。測試由本機 scripted HTTP
providers、真實 Hermes native session、SQLite、既有 Graph V2/V3 pipeline 組合，保留既有 ACL、revoke、
lease fencing、CAS rollback、worker retry、embedding-space 與 retrieval/story regression。

| 驗證 | 結果 |
|---|---|
| 乾淨 Part 1 HEAD 完整 suite | **171 passed、27 skipped**，27 files passed / 9 skipped。 |
| 新公開行為 contract 在 Part 1 HEAD | **預期 red**：有效 quote + 捏造敘述／反向因果仍完成 publication；測試要求 pending 且無 graph rows，實得 completed。只 import 原有 public API，非因缺少新模組而失敗。 |
| Candidate 早期完整 suite | 191 passed、27 skipped；再加入 cloud/review contract 後 192 passed、29 skipped。其後仍繼續修正與擴充，這些不是最終快照的替代證據。 |
| 最終完整 Graph/golden regression | **196 passed、29 skipped**，30 files passed / 10 skipped（1 worker，15 秒 timeout）。 |
| 最終 focused golden/persistence | **25 passed、0 failed**。全套後再修正 UTC 小數秒區間必須按 instant 而非字串排序；反例及所有新 gates 重跑通過，另重跑 typecheck。 |
| Python 相容性回歸 | **19 passed、0 failed**，registry/headless agent/Vertex adapter 三檔，使用 `scripts/run_tests.sh`、隔離 HERMES_HOME/RUNTIME_DIR。 |
| TypeScript | `tsc --noEmit` **exit 0**。 |
| Repository check | 17 checks 中既存 `no-tmp` 6 hits 持續失敗；新 CC violations 已拆分修復，health 0 blocking / 0 advisory。最終結果見 results。 |
| Vertex live、PG/GCS、Cloud Run rollout/rollback | **未執行／blocked**，不可算離線通過或已完成正式部署。 |

原始環境失敗保留：sandbox 阻擋 loopback listen 與 Python runner 子程序，放行本機測試後 baseline
通過。一次後續 candidate 執行有 Vite worker fetch/onTaskUpdate timeout、native Python 子程序 timeout，
兩項 V3 測試及 worker RPC 的長時間停頓，以及新增觀測 stdout 破壞 ingest CLI 單一 JSON 的真實 regression；修正為 stderr INFO，再跑受影響套件與
完整 suite。未提高測試門檻以隱藏產品錯誤。既存 no-tmp hits 僅在舊驗收 artifacts / host-config，未修改。

固定 corpus `tests/fixtures/llm-part2/golden.json` 包含 Unicode/UTF-16、重複句、假 quote、假 claim、未知
membership、同名 identity、temporal anchor、event/profile、錯 actor、event/state-slot、inferred certainty。
另測 negation/nearest actor、invented time/alias、false merge/split、sourceVersion/hash、foreign refs、反向
時間區間、in-flight revoke、review exhaustion 和 source retention、原子 rollback、CLI JSON 與並行 context。

跨模型比較是 **scripted Vertex / OpenAI-compatible wire corpus**：輸出可選不同的重複句 span，仍必須
滿足相同證據/integrity gates。它驗證跨 driver 契約，**不是實際 Gemini vs OpenAI 品質 benchmark**。
Golden JSON 記錄 verdict accuracy、false accepts、review/reject rate、deterministic validation latency
p50/p95 與 scripted token counts。真實模型延遲、費用、identity/direction/temporal 品質指標仍須以 staging
標註集量測；不能用 mock token 值或 accepted rate 冒充 production accuracy / cost。

重現（從 `examples/copilotkit`；選用與 baseline 相同且支援 SQLite 的 Node）：

```sh
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
npm test -- tests/llm-validation.test.ts tests/llm-validation-persistence.test.ts tests/llm-review-contract.test.ts --reporter=verbose
./node_modules/.bin/tsc --noEmit
# 可選：AGUI_LLM_EVAL_OUTPUT 指向預先建立的評估檔案目錄，產生無原始 source 的統計 JSON。
```

Root：

```sh
HERMES_HOME="$TEST_HOME" HERMES_RUNTIME_DIR="$TEST_RUNTIME" HERMES_PYTHON="$PWD/.venv/bin/python" scripts/run_tests.sh tests/hermes_agui/test_llm_registry.py tests/hermes_agui/test_headless_agent.py tests/agent/test_vertex_adapter.py
python scripts/check --base 44be792596e8ea1cbecc85b5415e415e631f876e
```

## 維運、回滾與尚待驗收項

完整 [部署／review／版本查詢／回滾 SOP](llm-unification-part-2-operations.md) 隨本次交付；Part 1
部署指南已更新版本銜接說明。部署到 staging 前先執行新增的 real PG/GCS durable review test 與獨立 live
Vertex+PG/GCS positive test；完成 IAM、quota、token refresh、Task delivery、competing workers、partial
publish、revocation、embedding switch 和實際 Cloud Run revision rollback 演練，才進 production gate。

已知限制：

- Deterministic semantic checks 採有限語句／extractive 契約，不是通用自然語言 entailment engine。
  支援外的 paraphrase、alias、因果語法可能增加 false review；必須量測 staging review rate。相同表面
  名稱也不能證明現實世界同一人，明確 identity 分歧不可強制 merge；未取得額外區辨證據時不能將
  accepted 宣傳為 objective identity resolution。
- 本次沒有第二個 LLM reviewer，人工複核走保留的 failed job/source 和 gated retry。日後若加入 reviewer，
  需另外提供 feature flag、明確 role、bounded budget/timeout/usage 與 unanswered→review，不能默認接受。
- Review job 沿原重試上限，可能重複消耗 inference；未新增無界 review loop。未知／缺失 provider usage
  用 null；沒有價格表，成本為 null。Embedding 不在本 ingest job 中執行時 fingerprint 為 null，實際
  向量空間仍由原 encoder/index key 查詢，不宣稱新增跨 index transaction。
- 完整 per-attempt history 使用既有 Cloud Logging 收集 stderr，沒有新增 SQL audit table；需確保受限
  存取與留存。當次 V2 validation summary 在既有 job.error 持久化。舊資料的 prompt/model 版本若無紀錄
  即 legacy/unknown，不推算假版本、不自動 rebuild。
- 回滾 image/config 時必須繼續隔離 review/rejected jobs。Part 1 缺少本次 gate，盲目 retry 會重新暴露已
  擋下的資料；保留 source/job/evidence，待修正版重新驗證，不刪表或覆寫舊向量來回滾。
