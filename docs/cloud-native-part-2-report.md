# Cloud Native Part 2 — Source 改造報告

> 最新狀態（2026-11-19）：已交付 Cloud Run source 改造、部署設定與手動操作文件。依使用者更新範圍，L01–L10、C01–C07 均 NOT RUN；沒有 production ready 宣告。詳細變更與局部檢查見本文末「Part 2 Source 交付」。

## 歷史前置驗收紀錄

以下保留各候選當時的判定，並非本次 Source 交付的當前狀態。

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


## 2026-11-19 最終前置驗收 — PASS（停止於交接）

Tested code SHA：`c9e7a56d46d4eb70e6ac9f26edb29c0a685796c9`；source digest：`3dfd47ac67b3e26de62b0e42d7a10ff800f001e201df846757a8259eaeb96795`。
依 [Part 1 Final Acceptance](cloud-native-part-1-report.md#2026-11-19-final-acceptance--pass)、
[status JSON](cloud-native-part1-status.json) 與 [證據索引](../artifacts/part1-final-20261119/INDEX.md)，
同候選 **G1–G8 全部 PASS，Part 1 accepted／Part 2 prerequisites accepted**。此前的 FAIL/NOT RUN 為歷史紀錄，未作本候選 PASS 證據。

| 前置契約 | 結果 |
| --- | --- |
| Legacy／Storage／Graph／Job／Provisioning | PASS：完整 Runtime 118、Python AG-UI 91、真 PG probe、四種 browser 模式及故障注入。 |
| 雙服務重建 | PASS：真 PG／外部 object double，刪除兩應用與全部可寫層，原 session/transcript/memory/skill、Graph reference／授權與 Host disable 完整復原。 |
| Migration | Owner 核准 fresh_deployment；既有本機資料保留，歷史全量遷移 N/A；importer compatibility／fresh schema／restart PASS，不能直接切換既有使用者。 |
| Build／check | 正式 Host/Runtime 與 fixture images、production smoke/native probe、TS/Vite、17 repository checks、diff checks PASS。 |
| Graph injection contract | Owner 核准 run-local untrusted reference，實際 provider request 驗證完整知識／provenance，system prompt 不變；Core 未改。 |
| 真 GCS/IAM/PITR 與 Part 2 實雲 | NOT RUN，沒有部署 URL 或付費資源。 |

可接線入口仍為 Graph worker-cli `process/tick/reconcile`、Bot reconcile-cli、Host completion_delivery `--once`、Host 001–005／Runtime 001–007 schema、分權角色與 PG/GCS config。Cloud Run 的可靠工作不能依賴 response 後 timer。成功 turn snapshot、未提交變更遺失窗口、seed 保管／輪替、網路分割窗口與 objects retention 限制見 Part 1 報告。

**本輪未開始 Part 2。** Cloud Tasks/Scheduler、Firebase/Vercel、正式 IAM service identity、SSE replay/cross-instance cancel、真 GCS generation/IAM、備份/PITR 還原、成本／負載驗收皆待後續明確啟動。

## 2026-11-19 新版 Part 2 起始盤點（未完成）

狀態：**SOURCE NOT READY / CLOUD NOT VALIDATED**。
實際 HEAD：`0e7eea48af480b73e72090fffd76c2f25553fd11`，與指定 Part 1 基線相同。
開始時工作樹只有 owner 修改的 `docs/CLOUD_NATIVE_PART_2.md`；保留該修改。
Part 1 最新驗收已通過；本節不推翻其成果，也不將其歷史 PASS 當作 Part 2 驗收。
本輪僅完成初步原始碼盤點，沒有完成工作包或執行測試，沒有修改 Storage Layer。

已核對的正式入口與缺口：

- Host：`python -m hermes_agui.server`；目前 CLI port 預設 8000，Docker CMD 固定 8000，尚未完成 PORT 契約。
- Runtime：`examples/copilotkit/server/index.ts`；已讀取 PORT，但 listener 綁定 127.0.0.1，Host/Origin 僅允許 loopback；delegation/completion 另開 internal port。
- Host cancel endpoint 使用 adapter.active，尚非跨 instance durable cancel。
- Runtime image 仍包含 Part 1 fixture；未完成三服務正式 image 驗收。

| 工作包 | 本輪狀態 |
|---|---|
| A 正式入口與封裝 | 未完成 |
| B IAM、Firebase、前端與 ACL | 未完成 |
| C Cloud Tasks / Worker / reconcile | 未完成 |
| D durable events / replay / distributed cancel | 未完成 |
| E 經 parser 與 schema 驗證的手動部署交付包 | 未完成 |
| L01–L10 最終本地驗收（每一項） | NOT RUN |
| C01–C07 真實雲端驗收（每一項） | NOT RUN |

盤點命令 `git rev-parse HEAD`、`git merge-base --is-ancestor 0e7eea48af480b73e72090fffd76c2f25553fd11 HEAD` 均退出 0。
上述判斷來自正式入口原始碼，並非執行結果。本輪沒有 image build、migration、整合、回歸或 browser E2E 的 PASS 證據。
交付尚未完成，不可依本節部署；後續須完成 A–E，再對同一候選執行 L01–L10。

## 2026-11-19 Part 2 Source 交付（依更新範圍，免執行整合驗收）

本節取代上一節「僅盤點、尚未改造」的當前狀態；歷史紀錄保留。
使用者明確調整要求為「把 source code 改成 Cloud Run Ready repository，不需要 L01–L10 本地驗收及 C01–C07」。
因此本次交付是 **Cloud Run source package / ACCEPTANCE NOT RUN / CLOUD NOT VALIDATED**，不宣稱 production ready，也不套用原計畫需要 L01–L10 PASS 才可使用的驗收標籤。

基線及目前 HEAD 均為 `0e7eea48af480b73e72090fffd76c2f25553fd11`，交付為未提交工作樹。
owner 對 `docs/CLOUD_NATIVE_PART_2.md` 的既有基線修訂保留。Part 1 Storage Layer 的 snapshot／manifest／registry／lease／outbox 架構沒有重新設計。

### Source 變更對照

| 工作包 | 實作與正式接線 |
|---|---|
| A | Host CLI 支援 PORT 與範圍驗證；Host image 移除固定 port CMD、health 使用 PORT。Runtime cloud listener 綁 0.0.0.0；internal callbacks 在同 ingress port。精確 Host/Origin allowlist、cloud backend 與 schema readiness、K_SERVICE 缺 cloud config fail closed。Runtime image 移除 Part 1 fixture；新增明確 migration CLI，不在 replica startup 遷移。 |
| B | Firebase Admin SDK 驗證 browser ID token，再經 server UID→owner/principal/project 映射接回既有 Bot／Graph／run ACL；cloud 不接受 local bearer/cookie login。ADC audience-scoped Google ID token 使用獨立 X-Serverless-Authorization；所有 Runtime→Host 呼叫共用 hostFetch。Host→Runtime delegation/completion 帶獨立 service identity，Runtime 驗簽、issuer/audience/expiry/SA allowlist 後仍檢查業務憑證。Firebase／storage emulator 在 cloud 模式拒絕。前端 email/password、記憶體 token refresh、登出、直接 HTTPS streaming transport、server-backed threads/history、重新連線及取消。 |
| C | Runtime migration 008 以 trigger 在 job 同交易新增 durable task delivery row；提交後 best-effort CreateTask，失敗保留待 Scheduler reconcile。Worker 使用正式 index.ts --production --worker，處理 process/reconcile endpoint，沿用 compiler/processJob/CAS/lease。Cloud mode 不啟 evolution 或 metrics timer。Tasks payload 僅 schema/jobId，OIDC + 業務 credential；bounded deadline signal。Host completion dispatcher 支援 --audience；提供獨立 Host reconcile CLI 供 Jobs 排程。 |
| D | Host migration 006 增加 durable scoped event log、attempt/monotonic seq/time/type/payload、user input 投影與 cancel_requested。事件先持久化再串流；replay 有 after 分頁，terminal 防重複。cancel 寫 DB，owner 每兩秒輪詢並沿既有 isolated-process cancel 中止；terminal publication 在鎖內核對 cancel。Host reconcile 收回過期 lease、補遺失 terminal、保留事件 30 天。不自動重播外部工具；durable HITL 無 checkpoint 時明確 409。既有 delegation scope/depth/deadline/correlation 邏輯保留並改走認證 transport。 |
| E | deploy/gcp 提供 Host YAML、Runtime JSON、三服務 env examples、前端公開 env、分權 grants、手動 staging compose 與 README；cloud-run-deployment.md 提供參數來源、images、migration、手動 gcloud 參考、URL bootstrap、IAM、queue、備份／rollback／retention／pool sizing 與 smoke 操作。沒有 Terraform／CI deploy／實際 provisioning。 |

正式入口：Host `python -m hermes_agui.server`；Runtime `npm start`；Worker `node --import tsx server/index.ts --production --worker`。
Host migration `python -m hermes_agui.storage.migrate`；Runtime migration `node --import tsx server/storage/migrate-cli.ts`。
Host completion／reconcile 採獨立 Cloud Run Job 命令供 Scheduler 呼叫，不依賴 response 後 CPU。

### 局部開發檢查與限制

本輪不是最終 integration/regression acceptance。局部檢查結果如下；未執行項目不可由本表推論 PASS。

| 命令／範圍 | 結果 |
|---|---|
| `vitest run tests/cloud.test.ts tests/runtime.test.ts --maxWorkers=1 --no-file-parallelism` | PASS：2 files、7 tests。涵蓋正式設定 schema、pg Unix-socket DSN parser、cloud 拒絕 local login/cookie、未授權 service／origin／目的地、Firebase Admin 成功與失敗結果的 ACL 接線、獨立 IAM/business headers、production emulator 拒絕，並保留既有 Runtime HttpAgent transport tests。Firebase/ADC 均 mock，不是雲端驗證。 |
| `HERMES_PYTHON=/private/tmp/hermes-part1-final-test-env/bin/python scripts/run_tests.sh tests/hermes_agui/test_cloud_config.py` | PASS：2 tests。Host YAML 經正式 parser、預設工具 allowlist、cloud 缺 durable storage／wildcard hosts 拒絕。ADC adapters 被替換為 unit double，沒有啟動 DB/GCS。 |
| `python -m compileall -q hermes_agui` | PASS，exit 0；僅語法編譯。 |
| `git diff --check` | PASS，exit 0。 |
| `npm run build`（CopilotKit） | PASS，exit 0：TypeScript + Vite，9071 modules；Vite 提示部分 chunks 超過 500 kB。不是 image 或 browser 驗收。 |
| Host 006／Runtime 008 實際 DB migration、grants、備份還原 | NOT RUN，隨使用者免除 L01–L10；SQL 未在真 DB 執行。 |
| image build／容器啟動、三正式入口整合、browser E2E、完整回歸 | NOT RUN，依使用者更新範圍。 |
| L01、L02、L03、L04、L05、L06、L07、L08、L09、L10 | 每項均 NOT RUN，使用者明確免執行。 |
| C01、C02、C03、C04、C05、C06、C07 | 每項均 NOT RUN；沒有真 GCP／Vercel 測試或部署。 |

首次局部 Python runner 因 sandbox process inspection 被拒（exit 1，0 tests）；授權本地 process 存取後同命令 2 PASS。
首次 Runtime transport unit tests 因 loopback EPERM 失敗，授權 loopback 後同範圍 7 PASS。
首次 cloud schema unit tests 發現樣板 service-account placeholder 含 underscore，修正後通過；新增 Firebase Admin 及 emulator 測試後再通過最新範圍。
npm 下載首次 DNS 受限失敗，授權下載後成功更新 package.json／lockfile；沒有聯絡 Firebase service 或取得實際金鑰。

重要限制：歷史 API 是最近 20 回合／最多 2 MiB 的文字事件投影，不重建工具／HITL 完整 UI，也不是原生 transcript 的 SQL 遷移。完整 native transcript 沿用 Part 1 snapshot。
單 run 事件最多 8 MiB／10000、每頁 1000；保留 30 天。超量應以 replay API 分頁，不能假裝完整歷史已載入。
斷線 grace=0，停止當前 request-owned run；崩潰後只重讀已提交事件，沒有 Python stack 恢復。取消不能撤銷副作用。
原生 memory/skills 仍依 Part 1 allowlist；多 Bot 不構成 OS sandbox，不支援不可信 arbitrary code 多租戶。
Firebase 前端初始 provider 是 email/password；refresh token 只留記憶體，重新整理須重新登入。
新 DB 用 fresh migrator；既有 Part 1 DB 無 ledger 時必須確認既有版本後僅套增量 006／008，不能直接執行 fresh migrator。
部署樣板經 schema／parser 的局部驗證，不等於 images、DB grants、IAM 或實際 deployment 已驗證。

完整操作說明與雲端手動待驗步驟見 [cloud-run-deployment.md](cloud-run-deployment.md)。本次未建立 GCP 資源、未修改 IAM/DNS、未部署遠端服務，沒有部署 URL 或容量／成本測量。

補充設定檢查：Compose YAML 首次解析發現 flow-list volume 未加引號，已修正；`docker compose config --quiet` 使用暫存 placeholder env files 驗證退出 0，沒有啟動任何容器。psycopg `conninfo_to_dict` 的 Unix-socket DSN 解析亦通過；這些不代表連線或 migration/grants 已執行。

最終局部補驗：`scripts/run_tests.sh tests/hermes_agui/test_cloud_config.py tests/hermes_agui/test_delegation_bridge.py` 退出 0，2 files／7 tests PASS；新增 service audience/destination 驗證後保留既有 delegation bridge 行為。最終 cloud unit 範圍 5 tests PASS；最後 Python compileall 與 diff whitespace check 均退出 0。
