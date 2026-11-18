# Cloud-native Part 2 前置驗收報告

> 最新狀態（2026-11-18）：依 owner 指示停止測試；Part 1／Part 2 前置尚未通過。詳本文末段最新紀錄。

查核基準為 `ab24d4adac6c39b7d3074c2d90fad49388775533`，開始時工作樹乾淨。
依 [Part 1 計畫](CLOUD_NATIVE_PART_1.md)、[Part 1 實作報告](cloud-native-part-1-report.md)、
[儲存盤點](cloud-native-inventory.md)及 [Part 2 計畫](CLOUD_NATIVE_PART_2.md)查核現行程式碼。

**Part 1 整體閘門未通過。** 目前已有靜態 Host 持久化和 Runtime PostgreSQL registry，
但動態 Bot 和 Graph Memory 還不能一併從外部儲存重建。Part 2 實作及最終驗收須等這項前置條件達成。

## 第一階段閘門

| 項目 | 判定與證據 |
| --- | --- |
| 靜態 Host 與原生 session | `hermes_agui/host_runtime.py` 已接上 durable run 路徑。`ProfileObjects` 沿用原生 SQLite 一致性快照；`PostgresRunStore` 在成功回合終止前提交 manifest 與 completion outbox。工具副作用至回合提交之間仍有快照未更新的窗口。 |
| 動態 provisioning | **部分覆蓋。** Runtime 和 opt-in 動態 Host 均有 PostgreSQL registry，使用相同秘密 seed 派生憑證。Host 在 run admission 核對 Bot revision。跨服務 operation ID 和全量對帳仍待完成。 |
| Graph 持久化與 job | **未通過。** Host outbox 已可交付 `SessionIngestor`，`compiler.ts` 已有 scoped `processJob`，但 `wiki-store.ts` 與 `ingest-queue.ts` 仍依賴本機 SQLite 與檔案。目前 `application.ts` 會拒絕同時啟用 PostgreSQL Bot registry 和 Graph evolution。缺少 Graph PostgreSQL/GCS 發布、索引與可跨實例接管的 job store。 |
| 完整遷移與對帳 | **未通過。** 已有 Host managed profile／registry 與 Runtime metadata 的離線匯入命令。完整 thread 歷史、Graph 資料及跨服務全量對帳仍待完成。 |
| 雙服務重建與隔離 | **部分覆蓋。** 既有測試以真 PostgreSQL 和 filesystem object adapter 驗證靜態 Host 委派、提交後回放 Graph ingestion 與同 thread 續聊。該情境保留 Graph store，尚無清除兩服務容器可寫層後復原動態 Bot、原生記憶／技能及 Graph 的驗收紀錄。 |

接續 Part 1 應沿用 `hermes_agui/storage/` 的 object/profile/run/outbox adapters、
Runtime 的 PostgreSQL registry 與 mappings、Graph compiler 的 `processJob`，
以及 `test_profile_objects.py`、`test_delegation.py`、`test_dynamic_runtime.py`、
`postgres_storage_probe.py` 和繁中 `wiki-evaluate.ts` fixture。

## 本輪重驗

使用既有 Hermes PM 測試直譯器、Node 22.18.0 和一次性本機 PostgreSQL Unix socket，
沿用 Host 與 Runtime migration 001–003。初次啟動 PostgreSQL 時 sandbox 拒絕建立共享記憶體；
允許本機共享記憶體及 loopback 後成功啟動測試。Docker CLI 可用，但 daemon 未連線。

| 命令與範圍 | 結果 |
| --- | --- |
| `python -m tests.hermes_agui.postgres_storage_probe` | PASS。真 PostgreSQL 上驗證 run admission、fencing、profile CAS、outbox 及 scope 隔離。 |
| `scripts/run_tests.sh tests/hermes_agui` | PASS。23 檔、88 項通過、0 失敗。含 PostgreSQL 靜態 Host 委派／續聊、Runtime registry 與 profile snapshot。Docker 情境未執行。 |
| `npm test -- --reporter=dot`（CopilotKit，含 PostgreSQL 測試庫） | PASS。16 檔、105 項全數通過。 |
| `npm run build`（CopilotKit） | PASS。TypeScript 與 Vite 完成，Vite 回報部分 chunk 超過 500 kB。 |
| `node --import tsx tests/fixtures/wiki-evaluate.ts`（CopilotKit） | PASS。既有 SQLite 繁中 fixture 的 recall@3 為 keyword 0.50、hybrid 0.9167、hybrid + graph 1.00。 |
| `npm run test:e2e`（預設與指定模式） | PASS。首輪缺少 Playwright 指定的 Chromium，改用已安裝的 Chrome 重跑。預設 6 通過、4 條件跳過。指定 Graph、動態 Bot、多 Bot 模式分別通過 3、2、1 項，覆蓋預設跳過的案例。 |
| 刪除雙服務容器可寫層後重建 | NOT RUN。Docker daemon 未連線，且現行 Graph 持久化與動態 Host provisioning 尚未接通外部儲存。 |
| Part 2 雲端最終驗收 | NOT RUN。包含真 GCS/IAM、Cloud Tasks、分散式 replay/cancel、Firebase/Vercel E2E、還原與成本負載測試。 |

GCP、Cloud Run、Vercel 正式部署教學須根據第二階段完成後的實際入口、服務身分、
migration、環境變數與 smoke test 編寫。目前的靜態 Host 與 Runtime 設定可查
[Part 1 實作報告](cloud-native-part-1-report.md)及[既有 AG-UI 部署文件](agui-deployment.md)。
本輪未建立付費資源或部署服務，沒有部署 URL。

## 依 Part 1 收尾契約重驗

候選為 `7d74a8d9ba94559a6997424e98ad747f82a4c226` 加上本輪尚未提交的工作樹。具體檔案、
設定、migration 順序及證據見 [Part 1 收尾候選紀錄](cloud-native-part-1-report.md#part-1-收尾候選紀錄)。

**Part 2 前置閘門未通過。** PostgreSQL Wiki revision、物件 manifest、索引及檢索已通過底層聚焦驗證。SQLite 與 PostgreSQL 的同一繁中 fixture 三組召回結果一致。

| Part 2 依賴 | 前置狀態 |
| --- | --- |
| Runtime Graph storage 與權威 ACL | **FAIL**。原始來源、撤銷、browser、Runtime context injection 與 PG+evolution 待接通。 |
| Durable Graph job 與 Host completion | **FAIL**。欠缺真 PG 雙 worker、fenced publication、重送及 outbox ACK 後收斂證據。 |
| Desired/applied provisioning | **FAIL**。欠缺 operation ID、desired revision、Host applied status 與 ACK loss 對帳。 |
| 持久化與重建 | **NOT RUN**。Docker daemon 無法連線，尚無雙服務可寫層清除後的共享 E2E。 |
| 歷史遷移 | **NOT RUN**。owner 尚未核准遷移 scope。 |
| 完整回歸與 build | **NOT RUN**。本輪停留在 A 的聚焦驗證。 |
| 真 GCS generation/IAM 與 Part 2 實雲驗證 | **NOT RUN**。本輪以外部 filesystem object contract double 驗證。 |

目前可重用 `PostgresWikiStore.import` 的同 client 發布交易、`GraphObjects` 與
`wiki-evaluate.ts --postgres`。Runtime durable job worker 和 provisioning reconcile
尚未達到可供 Part 2 接線的狀態。


## 2026-11-18 最新前置驗收（依 owner 指示停止測試）

**Part 2 前置條件仍未通過，不進入 Part 2。** 起始／目前 HEAD 為
`ae7d7ae51eca59c49a79ef47f7d086fb23f0798a`，候選是尚未提交的工作樹。
本輪已接通 A/B/C 的主要實作並建立 D 的共享 runner；完整證據、失敗歷史與尚未跑的增量測試見
[Part 1 最新紀錄](cloud-native-part-1-report.md#2026-11-18-收尾進度依-owner-要求停止測試)、
[驗收操作](cloud-native-part1-validation.md)及[驗收快照](cloud-native-part1-status.json)。

| 前置項目 | 目前判定 |
| --- | --- |
| PG/GCS Graph backend 與 current ACL | 已實作並有聚焦證據；**最終完整閘門 NOT RUN**。保留 CJK/embedding 演算法、private/shared/source provenance；沒有 SQLite fallback。 |
| Durable Graph job／completion | 已實作 DB clock、claim token、同交易 publication/completion、await enqueue 後 ACK、雙 process takeover 及外部 caller 入口；聚焦有 PASS，**最終候選整體重驗未完成**。 |
| Desired/applied provisioning | 已實作 operation/revision/status/CAS/reconcile，主要 focused tests 通過；**最終完整閘門 NOT RUN**，後增 busy-run 斷言未重驗。 |
| 雙服務 restart | **FAIL**。已有刪除重建兩容器後部分資料復原證據，但完整 scenario 未過；最新 run 為 PG readiness timeout。沒有核准容器延期例外。 |
| Legacy regression | **FAIL**。Runtime 115 passed、2 timeout，另有 worker RPC error；完整 Python/probe 未在本輪整體回歸完成。Browser 預設 6、Graph 3、dynamic 2 passed，multi-Bot 未完成。 |
| Migration scope／importer | **NOT RUN／未核准**。Owner 未明確核准 fresh 或 preserve-existing；新增 importer 相容性 tests 尚未跑。歷史全量匯入不能標 N/A。 |
| Build/check | Host/Runtime images、TypeScript/Vite 有 PASS；repository-wide check 因 HEAD 缺 helper/root manifest 等失敗，**Build 總體未通過**。 |
| 真 GCS/IAM、Cloud Tasks、實雲還原 | **NOT RUN，留 Part 2**；local object double 不作實雲 PASS。 |

Part 2 可檢視但尚不能視為已驗收契約的交接入口：

- `server/graph/worker-cli.ts process JOB_ID | tick | reconcile`：共用 bootstrap、MemoryEvolution、原 WikiCompiler，指定 job 從 DB 取 scope，不啟動 timer。
- `server/bots/reconcile-cli.ts`：protected Host status、同 operation 重送與 desired revision CAS。
- `python -m hermes_agui.storage.completion_delivery --once`：Host durable outbox 補送；Part 2 需定期喚醒。
- Host migrations 001–005、Runtime 001–007；`agui-cloud` extra、既有 PG/GCS/seed/completion 環境變數、fixture grants 與共享容器 scenario。

停止時沒有新增 Cloud Tasks/Scheduler、Firebase、正式 IAM service identity、SSE replay、跨 instance cancel 或 GCP/Vercel 部署。先補完 Part 1 尚未通過的項目，才開始 Part 2。
