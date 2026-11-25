# LLM Management Console Part 2 階段交付報告

分支 `codex/graph-memory-v2`。Part 1 最終實作基準為
`529375cb53d012fa9604144c8a6986f7d04c20d2`；開始 HEAD
`b011cbed4abc` 為 Part 1 報告提交，沒有回退 source。此次實作目前為其上的 working-tree patch，
未虛構最終 commit；實際 source SHA-256 與檢查結果見
[results.json](../artifacts/llm-management-console-part-2/results.json)。

開始工作樹已有四份文件刪除及兩份未追蹤計畫書；全部保留。已閱讀 Part 1 計畫／report／operations、
Unification deployment／Part 2 operations／report、caller inventory、實際 TS/Python/control-plane source，
並用 git log 核對原 Prompt Registry 的設計。Runtime source migration head 011 → 012，Host 維持 006；
沒有存取既有正式部署 DB，不把 source head 當 production ledger head。

## 階段一：沿用 Part 1 與相容性

Configuration Store、immutable release/pointer、CAS、audit、deployment-admin auth、provider allowlist、
SSRF guard、Run/Job pin、原 Graph/Native adapters 與 validators 全部沿用。沒有第二個控制面、proxy、
Firestore、core tool、scheduler 或自動 IAM，也沒有重新實作抽取引擎。

Part 1 snapshots 仍以原 `management-part-1` 完整驗證，原 baseline hash 與 static effective prompt 不變。
Part 2 snapshots 以 `management-part-2` 識別，另帶 prompts、codeTaskFingerprint；taskFingerprint 覆蓋有效
文字與 code schema/validator。model fingerprint 與向量 key 定義不變。Prompt selection 透過 execution-local
AsyncLocalStorage 從 immutable pin 取得，沒有 process-global mutable latest；舊 job/run/retry 不改 pin。
Native Host 核對簽章、persisted pin、release hash、code fingerprint，再傳入獨立 instruction slot。

## 階段二：實作／API／檔案索引

| 檔案／範圍 | 實作 |
|---|---|
| `server/llm/prompts/{registry,context}.ts` | Protected core → editable guidance → 原完整 protected rules；空 slot byte-identical；純文字，不解析模板。所有現有 stage callsites 經原 promptFor/systemPrompt 取得 pin。 |
| `prompt-contract.ts`, `control-contract.ts`, `config.ts`, `execution-release.ts` | 六個可編輯 slots、長度與 strict key validation、內容位址版本、protected/effective hash、code/dynamic task fingerprints、legacy snapshot reader。 |
| `control-store.ts`, Runtime `012_llm_prompts.sql` | additive draft prompts、immutable versions（parent/reason/actor/contract metadata）、immutable revision+candidate-bound regression receipts、CAS publish、歷史與 rollback 相容性檢查。 |
| `prompt-regression.ts`, `prompts/regression-v1.json` | 原 golden corpus 移至正式可重用資源，既有 validation tests 改讀相同資源；新增 forged contracts、UTF-16、假 quote、negation fixtures。原安全規則不降版。 |
| `playground.ts` | 正式 RegistryLLM、parser、matcher、relations、query、story adapters/validators；baseline/candidate 同 input/context，bounded、取消、approved transport、no publication。 |
| `control-api.ts` | 沿用 auth/origin/error/body/rate boundary；Prompt/Schema/history/Playground/Embedding plan endpoints；metadata-only audit。 |
| `embedding-migration.ts` | approved encoder plan、舊/new fingerprint、persistent status；無全域 coverage/write-fencing 證明時 activationEnabled=false。 |
| `frontend/LLMPrompts.tsx`, `LLMEmbedding.tsx`, `LLMManagement.tsx` | Prompts editor／locked sections／effective diff／歷史選字、Schemas viewer/copy、Playground compare/cancel、Embedding plan/status、candidate diff；真實 API、reload persistence、errors/permission/CAS。 |
| `hermes_agui/{server,message_adapter,adapter}.py`, `core/{managed_llm,service,factory}.py`, `storage/isolated_service.py` | 可信 instruction 自 Host resolver 傳入原 ephemeral_system_prompt seam，含 isolated child；cache identity 含 release/slot，原 Bot role/tools/skills/memory/history 保留，新 run 才換 slot。 |
| `deploy/gcp/llm-control-grants.sql`、operations | 最小 grants、相容 reader 順序、staging/production SOP、drain／備份／觀察／rollback；不部署。 |

新增 API 與 typed payload 詳見 [operations](llm-management-console-operations.md)。沒有 Schema mutation endpoint，
provider projection 直接來源為已部署 Zod；Zod refinements 與語義檢查並不宣稱和 wire schema 完全等價。
Native UI 僅公開 deployment slot 與組裝說明，不 dump 私有 runtime system prompt。

## 階段三：驗收範圍與證據

機器可讀結果及原始 logs 是數字的依據。Node 22.16.0，既有 2 workers／15 秒一般 timeout；Python 一律
使用 `scripts/run_tests.sh` 與暫存 HERMES_HOME，不用 bare pytest、不新增 raw pip/uv 安裝。
Native 新 instruction 測試使用真實原生 loop + 本機 scripted wire provider；不冒稱實際模型品質。
PG gate 為真實 PostgreSQL 17.12 隨機 disposable databases、實際 grants／transaction／多 connections/processes。
Chrome gate 為真實 UI → admin API → PG → Graph compiler；inference 是 scripted wire，objects 為 filesystem。

| 驗收 | 本地範圍／限制 |
|---|---|
| P2-01 | Static baseline／Part 1 canonical golden、原 validation/evidence/temporal/revocation/persistence regression；空 slot byte-identical。 |
| P2-02 | Browser 編輯 Parser → dry-run → validate/publish → 新 job 實際 systemInstruction 含新版；不重啟。 |
| P2-03 | 原 pin suite、並行 ALS context、real-PG replicas／CAS／immutable releases；Native in-flight tool loop 固定舊 slot。 |
| P2-04 | Protected sections 不可經 PATCH 修改，原 golden negatives、forged schema/ACL、UTF-16/negation/identity/actor/direction gates 保留。 |
| P2-05 | Code-derived schema、未知 task/version 拒絕、schema mutation 404；不相容 snapshot 拒絕。 |
| P2-06 | 正式 adapters/validators；runner 不取得 store/queue/tool capabilities；明列 not_run，fallback 不當 accepted publication。 |
| P2-07 | Real-PG candidate/revision receipts、未驗證不能發、草稿修改失效、既有非管理員/origin/SSRF/secret checks。 |
| P2-08 | 同 Native thread 新 run 換 slot、保留工具/歷史；tool callback 暫停時另排新版 run，舊 loop 不變。 |
| P2-09 | 原 pointer rollback／pin 留存、immutable Prompt history、TS/Python incompatible image fail closed；不重跑 review/rejected。 |
| P2-10 | **部分 PASS／activation BLOCKED**：plan/status/approval、新舊 fingerprint、未證明 coverage 禁止切換。未實作安全 verified→activated 或 rollback coverage oracle。 |
| P2-11 | 真實 Chrome/API/PG editor/schema/playground/release/reload/403/CAS；scripted provider，不是 live benchmark。 |
| P2-12 | 真實 disposable PG PASS；真實 GCS、Vertex、compatible provider staging smoke、Cloud Run 多副本 rollout/rollback **BLOCKED**，未提供合法測試資源。 |

完整 Node/Python、PG、Chrome、typecheck/build、repository checks 的最終狀態與命令見 results.json。
既有 optional cloud skips 不算 PASS。初輪在 build／多組重型檢查同時執行時一項既有 CLI test 逾時；
保留原 log，沒有增加 timeout，減少同時重型工作後完整重跑。Browser fixture 先遇到共用 admin 限流，再遇到
原 source 去重不進 inference；分離測試 admin／namespace，UI 也刪除儲存後無必要的多份重讀，沒有放寬
產品限流或停用去重。初次 code health handler CC=21 已拆出 budget helper，後續 0 blocking/0 advisory。
Repository 六個 no-tmp hits 為基線 host-config/tmpdir 問題，與新增變更分開列出。

## 階段四：明確偏差、雲端 gate 與交付限制

為避免拆層遺失必要限制，原每個 stage 的完整 rules 都留在 protected contract；editable guidance 初始為空，
可以增加策略／例子，不能刪除原限制。未變動 slot 的 effective bytes 不變，但 Part 2 manifest 使用新的版本
識別與 metadata，不宣稱 Part 1/Part 2 release hash 相同。Schema/validator code version 仍 1，沒有改 validator 行為。

Playground 是 bounded synthetic dry-run：matcher 固定 homonym context、relations 空 parsed context、story 空
MemoryNet；ingest 串 parser/matcher/relations，retrieval 串 query/story，但不做真實向量搜尋或 Graph publication。
ACL/lease/persistence/publication/native full harness 是 not_run；Native slot 沒有 browser inference harness，
僅有離線 native regression。結果不永久保存，accepted 不是 objective accuracy，價格未知 cost=null。

Embedding 採現有可重入 `vectors` CLI 建候選 key，沒有新增 HTTP indexing job。`embeddingCandidates` 是部署
方批准的 plan-only 清單，不能改原 approved baseline 或模型 IAM。沒有安全 all-writer drain／global source
watermark oracle，因此只交付 immutable planned 狀態及 fail-closed gate；counts/coverage/checkpoint/error/verifiedAt
未知為 null。**backfilling/catching_up/verified/activated 的可信進度、全域 coverage／revocation／水位驗證與安全
切換尚未完成，P2-10 完整驗收 BLOCKED。** 不能以 CLI status=ok、暫停 queue 或 UI 自填 counts 解除 gate。
舊 selector／indices 始終保留，也沒有自動清理歷史記憶或修改 ACL。

未執行 production deployment、IAM mutation 或資料清除；本文件不宣稱 Part 2 全部驗收完成或 production ready。
GCP 操作 SOP 已交付，真實 cloud gate 與上述 activation 工作仍須完成。未擴充 Part 3。

最終本地結果（完整 regression 後的小幅 gate／UI 修正，以相應 focused checks 補驗）：

| 檢查 | 結果 |
|---|---|
| 完整 Node regression | 210 PASS、29 既有 SKIP；32 files passed、10 skipped；原 timeout。 |
| 最終 Prompt/control/golden focused | 34 PASS。 |
| Native／registry／headless／Vertex Python | 完整 26 PASS；新增 in-flight instruction 後該檔 2 PASS（合計 27 個不同測試）。 |
| Host HTTP／dynamic provisioning | 11 PASS、2 既有 dedicated Host PG fixture SKIP；未當作雲端成功。 |
| 真實 disposable Runtime PG | 9 PASS，fresh/rerun migrations、grants、跨連線/CAS、Prompt receipts、Embedding plans。 |
| Chrome → real API → real PG | 3 PASS；新 namespace 的新 job 確實進入 adapter 並使用新 Prompt。 |
| Typecheck／前端 production build | PASS；保留既有大 chunk warning，未調整 threshold。 |
| Repository checks | 既有 no-tmp 六處 FAIL；新 health finding 已修復（0 blocking/0 advisory），其他檢查結果見 results.json。 |
| 基線 red proof | 在 `b011cbe` archive 執行新 candidate instruction 行為契約，預期失敗：舊 systemPrompt 不包含新指引；不是 import/collection failure。 |
| 真實 GCP／provider／完整 Embedding activation | BLOCKED；未用 mock／SKIP 冒稱驗收。 |

命令（Node 在 examples/copilotkit；Python/check 在 root）：

```sh
npm test -- --reporter=dot --maxWorkers=2 --testTimeout=15000
npm test -- tests/llm-prompts.test.ts tests/llm-control.test.ts tests/llm-validation.test.ts --reporter=dot --maxWorkers=2 --testTimeout=15000
npm test -- --config vitest.llm-control.config.ts --reporter=verbose
./node_modules/.bin/playwright test --config playwright.llm-control.config.ts
./node_modules/.bin/tsc --noEmit
npm run build
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh tests/hermes_agui/test_llm_registry.py tests/hermes_agui/test_headless_agent.py tests/hermes_agui/test_managed_llm.py tests/hermes_agui/test_managed_instruction.py tests/agent/test_vertex_adapter.py
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh tests/hermes_agui/test_managed_instruction.py
HERMES_TEST_FILE_RETRIES=0 scripts/run_tests.sh tests/hermes_agui/test_server.py tests/hermes_agui/test_dynamic_host.py
.venv/bin/python scripts/check --base b011cbe
```

測試 runtime 選用本機既有 Node 22、`.venv`／已存在含 `ag_ui` 的獨立測試 environment；PG Host reader
用既存 staged psycopg 3.3.9（與 lockfile 相同）經測試程序 PYTHONPATH 載入，沒有改 Hermes environment。
早期 sandbox 阻擋子程序／loopback 的嘗試不算通過，改以相同本機 disposable 資源執行。非正式 DB 及
Chrome fixture 都在驗收後停止；不保留對 production 的連線、部署或憑證。
