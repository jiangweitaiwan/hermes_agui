# Part 2 最終本地驗收（2026-11-20—21）

結論：**SOURCE NOT READY / CLOUD NOT VALIDATED**。
封裝、啟動與主要回歸已通過，但 L02–L10 的完整 Part 2 整合矩陣尚未全數完成，不能依計畫簽核可部署。

候選 HEAD：`73c86e08be8017af2aaf5f758c3d1c522ca75d6f`，包含 Part 1 基線
`0e7eea48af480b73e72090fffd76c2f25553fd11`。本輪新增驗收測試與測試工具修正，尚未 commit。
起始未追蹤的 `host-config.yaml`、`tests/runtime.json` 為既有使用者檔案。前者只在兩個固定容器
scratch 路徑補上 lint 說明註解，設定值未改；後者未修改。兩者皆未用於服務啟動測試。
未呼叫 GCP／Vercel、未部署、未修改 IAM/DNS，未使用真實憑證。

## 環境與證據

證據目錄：[`artifacts/part2-final-local-20261120`](../artifacts/part2-final-local-20261120/)。
Node 22.18.0、PM 測試 Python 3.14.9；兩個獨立的 native PostgreSQL 18.6 測試 cluster，另建立
`hermes-part2-local-pg-20261120` PostgreSQL 17 容器。資料皆為合成測試資料。
Docker VM 為 2 CPU／約 3.84 GiB。首輪並行執行造成宿主機嚴重 swap，可用記憶體約 16 MiB；
首輪結果不能解讀為產品缺陷或成功驗收。保留原 log，停止本輪程序後依序重驗。

已確認的結果：

| 檢查 | 結果／證據 |
|---|---|
| 正式 Host／Runtime fresh migrator | PASS，exit 0。native PG 與 PG17 容器均套用 Host 001–006／Runtime 001–008；見 `*-migration.log`、`pg17-*-migration.log`。 |
| migrator 重跑 | PASS，exit 0，無新增 migration；見 `*-migration-rerun.log`。 |
| 正式 DB grants | PASS，exit 0。`deploy/gcp/database-grants.sql` 可執行；兩服務角色皆無 schema CREATE 權限。Host role 實際 admission／append／cancel／finish／replay／reconcile 成功。 |
| 真 PG run／profile／outbox probe | PASS，exit 0；`postgres-probe.log`。涵蓋競爭 admission、fencing、manifest CAS、交易失敗與 scope 隔離。 |
| replay／cancel／crash reconcile | PASS，2 tests、exit 0；`events-contract.log`。不同 pool 共享 DB，不等於雙獨立服務 process。 |
| Worker／Tasks contract | PASS，9 tests、exit 0；`worker-contract-corrected.log`。真 PG job／delivery trigger、enqueue transport failure、duplicate delivery、最小 payload；Google transport mock。 |
| Runtime 失敗項與 identity 聚焦重驗 | PASS，4 files／24 tests、exit 0；`runtime-focused-recheck.log`。含 Graph bounds、CLI、跨 Runtime registry、Firebase／service identity mock。 |
| 完整 Runtime 回歸 | PASS，23 files／133 tests、exit 0；`runtime-serial.log`、`serial-results.json`。關閉重型 build 後嚴格串行執行，未放寬測試 timeout。 |
| 最終完整 Python AG-UI 回歸 | PASS，27 files／95 tests、0 failed、exit 0；`python-fresh-final.log`。新建第三個隔離 native PG cluster、正式 migrations、單 worker、未重試。 |
| TypeScript | PASS，`npx tsc --noEmit`，exit 0；`typecheck.log`。 |
| 前端正式 build | PASS，exit 0；`frontend-serial.log`。TypeScript + Vite，9071 modules；保留大 chunk 提示，不當作功能失敗。 |
| cloud browser auth | PASS，1 test、exit 0；`browser-cloud.log`。真 Chrome 執行登入、refresh、Runtime bearer 與登出；Google/Firebase/Runtime 回應皆 mock，阻擋其餘外部網路。 |
| 預設 browser regression | PASS，6 passed／5 條件 skipped，exit 0；`browser-serial.log`。其他模式另行執行，不能把 skipped 當作通過。 |
| 指定 browser 模式 | PASS，Graph 3／dynamic Bot 2／multi-Bot 1，各 exit 0；`browser-graph.log`、`browser-dynamic.log`、`browser-multi.log`。覆蓋預設跳過的案例；cloud auth 另跑 1 項。 |
| PG17 dump／restore | PASS，exit 0；`restore-probe.log`、可重現的 `restore-probe.py`。備份還原後 ledger、manifest、generation、checksum 與原生 SQLite 內容一致。外置 filesystem object double，不是 GCS/PITR 或 image rollback 演練。 |
| 部署 Compose parser | PASS，exit 0；`environment-and-compose-corrected.log`。只使用暫存 placeholder env/config；未啟動 staging。 |
| 正式 images | PASS，兩個 `linux/amd64` builds 均 exit 0；`host-build-serial.log`／`runtime-build-serial.log`、`image-results.json`。Worker 共用 Runtime image。 |
| 三正式 cloud-mode 入口 | PASS，exit 0；`startup-probe.log`、`startup-images.json`。使用預設 Host／Runtime 命令與正式 Worker 命令、全新 PG17 DB、image 內 migrators 與正式 grants、非預設 PORT、read-only root；宿主機經映射 port 存取 health 成功。Runtime 匿名 API 與 Worker 缺憑證被拒；Worker 有業務憑證 reconcile 成功。 |
| production 缺設定 | PASS，image 未掛測試 double、僅設 K_SERVICE 時，Host／Runtime 均非零退出且要求 cloud config；`startup-probe.log`。 |
| 當前 images 的 Part 1 雙容器重建回歸 | PASS，1 test、exit 0；`legacy-restart.log`、`legacy-restart-exit.txt`。重新建立 PG／object volume，刪除並重建 Host／Runtime writable layers，恢復對話、原生 memory／skill、Graph／mapping，驗證停用 Bot 與 scope 隔離。使用既有 Part 1 fixture 入口，不能代替 Part 2 正式 cloud-mode 串接驗收。 |
| Repository checks | PASS，17 checks、exit 0；`repository-check-final-pass.log`。先前 scratch-path／驗收腳本 lint 失敗保留於其他 check logs，修正後才標 PASS。 |

三入口啟動使用明確唯讀掛載的 SDK startup double：Host 的 GCS factory 指向測試 filesystem；Node 的
GoogleAuth getClient 只允許初始化，任何 Google API request 立即拋錯。這些檔案不在正式 image，
只在 NODE_ENV=test 的測試掛載中啟用。沒有放寬正式程式的 cloud validation、業務憑證或 ACL；
這項 PASS 不代表 GCS/ADC/IAM 真雲驗證，也沒有完成帶有效 Firebase 身分的完整 run 流程。

## 修正的驗收工具

- 跨 Runtime lifecycle 測試改用唯一 Bot ID，避免重跑時讀到上一輪的 disabled 狀態。
- restart scenario 的 fixture roles 補上 `run_events`／`task_deliveries` 權限。
- Runtime fixture 改由 scenario 唯讀 bind mount，配合正式 image 不再內建 test fixtures。
- profile unit test 的舊 RunStore double 補齊事件、狀態查詢與 ready signal 介面；不改正式 storage 行為。
- 新增 scoped event／cancel／reconcile、Worker／Tasks、service identity 與 cloud browser auth 測試。
- 部署 YAML 與既有 Host config 的固定容器暫存路徑加上明確 scratch 註解；驗收腳本補上 timeout，設定與正式執行邏輯不變。

## 首輪失敗與限制

`python-regression.log`：首輪測試使用的 socket 預期 port 5432，而隔離 PG 使用 55433；
修正為另一個符合契約的獨立 socket cluster，不修改產品 DSN 行為。
`events-role-contract.log` 首輪為 2 skipped：runner 不傳遞任意 DSN env；已改用既有
`HERMES_AGUI_TEST_DB_SOCKET` seam，重驗 2 passed，不將 skipped 算作成功。
`worker-contract.log` 首輪連到已停止的歷史測試 socket而失敗；改為本輪獨立 DB 後 9 passed。
`environment-and-compose.log` 首輪因 PyYAML 未安裝而退出 1；改用專案既有 ruamel.yaml 後退出 0，沒有新增依賴。

`python-regression-corrected.log`：27 files、94 passed／1 failed，exit 1。唯一失敗為舊 profile unit double
缺少 Part 2 介面；已修正測試 double，後續重驗結果另記，不將這份完整 suite 改寫為 PASS。
`profile-recheck.log`：修正後 4 tests PASS，exit 0；最終完整 Python 回歸另記。
`python-final.log`：重用已有資料的測試 DB，outbox claim 取得前輪留下、但對應物件已由 temp fixture 清除的 event；
該輪失敗後停止，不能視為產品資料遺失或完整 PASS。改用全新 DB、串行執行的 `python-fresh-final.log`
才是本候選最終 Python 證據（95 passed）。真實部署的同一 Host DB 必須共享同一 object backend，不能混用 fixture 物件目錄。

`runtime-regression.log`：119 passed／4 timeout，exit 1。
`runtime-regression-final.log`：130 passed／3 failed，exit 1；其中兩項 timeout，另一項為
固定 Bot ID 導致的測試資料污染。後續聚焦重驗通過，不把先前完整 suite 改寫成 PASS。
`browser-local.log`：停止前僅一項 PASS，其餘未完成，不算 browser suite PASS。
`frontend-build.log`：tsc 成功、9071 modules transformed 後停止 Vite 以釋放記憶體，不算 build PASS。
首輪兩個 Docker build 先有下載／連線 reset／重試，後因記憶體壓力主動取消；
`host-build.log`／`runtime-build.log` 的 context canceled 不代表 Dockerfile 語意已驗證或已失敗。
之後單獨建置的兩個正式 image 均成功，才作為本輪 image PASS 證據。

## 閘門

下表是完整情境閘門，部分底層測試成功仍不等於該整合情境完成。

| ID | 完整情境狀態／尚缺證據 |
|---|---|
| L01 | PASS（本地 SDK doubles）：正式 images、三正式入口、PORT／外部 ingress／health／config／image migrations／正式 DB grants／缺設定 fail-closed，見 startup 與 image 證據。 |
| L02 | NOT RUN（完整 Part 2）：當前 images 的 Part 1 共用 scenario 與 legacy／Graph／native tests 通過；三正式 cloud-mode 入口完整 authenticated run 串接仍缺。 |
| L03 | NOT RUN（完整 Part 2）：Part 1 雙容器 writable-layer 刪除重建回歸通過；尚缺 cloud-mode 正式入口／Worker 的同情境。 |
| L04 | NOT RUN：真 PG contention／多 pool 與既有跨 Runtime 測試通過；完整雙 Host／雙 Runtime 獨立 process＋cancel 尚缺。 |
| L05 | NOT RUN：outbox／Tasks adapter／Worker handler 局部通過；正式 Worker 入口故障重送完整情境尚缺。 |
| L06 | NOT RUN：Firebase／IAM mock 與 scope／Origin contracts 通過；正式三入口完整雙憑證情境尚缺。 |
| L07 | NOT RUN：durable replay／cancel／expired lease 通過；正式 stream 斷線、取消競態與 kill owner 全情境尚缺。 |
| L08 | NOT RUN：Graph ACL、原生 delegation 與 allowlist 相關測試有證據；同整合 scenario 的完整安全驗收尚缺。 |
| L09 | NOT RUN：完整 Python／Runtime、build、全部 browser 模式與 image build 均通過；cloud history／reconnect／cancel 的完整 UI→正式 Runtime→Host 情境仍缺。 |
| L10 | NOT RUN：PG17 dump/restore＋manifest 對帳通過；image rollback／完整 Graph object 還原演練尚缺。 |

L01–L10 尚未全部通過。三正式服務已能以本地 SDK doubles 啟動；尚缺完整 authenticated run→Host callback→Tasks→Worker→Graph
正式入口整合、cloud-mode 容器 writable-layer 刪除重建、雙獨立實例的完整 cancel／owner-kill／stream
故障情境、完整 browser cloud flow 與 image rollback。不得使用歷史 Part 1 PASS 或底層 SDK mock 代替這些整合證據。

C01–C07 每項均 **NOT RUN**，維持 [手動雲端驗收步驟](cloud-run-deployment.md#操作者-smoke-與雲端待驗項not-run)。
只有本地 L01–L10 全部通過後才能標 SOURCE READY / CLOUD NOT VALIDATED；目前不可宣告
已確保能部署到 GCP，也不可宣告 production ready。

交付未 commit；保留兩個本地 Part 2 images 與證據目錄供 review。沒有執行 push／GCP 或 Vercel 部署。
