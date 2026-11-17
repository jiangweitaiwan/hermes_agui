# Cloud-native Part 1 實作與驗收報告

**狀態：部分完成，第一階段上線閘門尚未通過。** 起始 commit 為
`b433a7873a5250e925bb0c3e2bf17cdca4a49d2f`。變更留在工作樹，保留既有 docs 刪除及兩份
Cloud Native 計畫。現有部署繼續使用 SQLite / filesystem。
資料 ownership、現有 schema 與耦合見 [儲存盤點](cloud-native-inventory.md)。

## 已實作

| 檔案 | 行為 |
| --- | --- |
| `hermes_agui/storage/objects.py` | 不可變 object create 與限量、指定 generation 的 read。GCS 使用 ADC、generation-match 預條件與 timeout。Filesystem 以獨占硬連結發布已寫完的資料。 |
| `hermes_agui/storage/profile.py` | `ProfileObjects.stage/hydrate` 以 project、principal、Bot 隔離 object namespace。manifest 記錄 generation、SHA-256 與 size。預設包含 SOUL、MEMORY、USER 與完整 native state.db。技能與 workspace 檔案需逐一列入 server allowlist。拒絕 dotfiles、非正規檔案、symlink、hardlink、路徑逃逸與超額資料。 |
| `hermes_agui/core/factory.py`、`core/service.py` | `session_home_identity` 支援搬遷後保留原生 session ID 輸入。舊資料可用原始絕對 home 字串，本地 caller 沿用原有 mapping。 |
| `hermes_agui/storage/migrations/001_host.sql`、`runs.py` | Host schema `hermes_agui_host` v1、Bot scope 主鍵、thread 查詢索引、run/lease 記錄。`PostgresRunStore.begin/get/renew/finish/profile` 接收有界 psycopg pool，使用資料庫時鐘、row lock 和單調 fence。過期 run 在下次 admission 標記 interrupted。終止與可選 profile CAS 一起 commit。 |
| `tests/hermes_agui/test_profile_objects.py`、`postgres_storage_probe.py` | Fake LLM 原生續聊、檔案復原、不可變儲存、scope 和竄改測試。另有真 PostgreSQL 競態、lease takeover、舊 writer、重送與 CAS probe。 |

### Native SQLite 過渡契約

以 SQLite backup API 建立獨立快照，保留原生 schema 與 transcript。呼叫端需關閉原生 service
與所有寫入者，在獨占的新私有目錄 hydration，再以部署模板與 secret 注入重建 config.yaml
及憑證。原生資料庫以外的 sidecars 與插件狀態需逐項驗證。工具不會自動辨識對話、記憶或
允許檔案裡的秘密。

快照整份上傳，每個 profile 共 64 MiB、最多 256 個清單項目。上傳到 SQL commit 之間失敗
可能遺留未發布物件，舊 manifest 繼續可讀。hydration 失敗時呼叫端需丟棄暫存目錄。
未引用物件的 retention/GC 待實作。正式 Host 寫入邊界、工具完成 checkpoint 與 terminal
event 的持久化等待仍需接線，因此服務崩潰時尚無跨 instance 保證。後續 PG session backend
需逐項驗證原生 resume、branch、compression、工具結果、查詢及清理行為。

## 第一階段剩餘交付

- Runtime registry、登入／thread mapping、Host registry、credential reference 與雙 registry operation reconciliation。現有 registry payload 含憑證，不能直接匯入一般 PostgreSQL registry。
- Cloud Host 的 lazy hydration、bot-wide lease 整合、subprocess 隔離、checkpoint 與 AG-UI terminal 邊界。目前 admission/cancel/receipt 仍由本機介面提供。
- Graph metadata、繁中 PG 搜尋、immutable source/wiki publication、job/outbox 與 migration CLI。SQLite golden fixture 僅驗證現有搜尋行為。
- 刪除兩服務 writable layer 後重建、真 GCS generation/IAM、跨 app scope、kill before terminal、job retry 及遷移對帳。
- 正式 local/gcp 設定、.env.example 與服務 role grants。目前提供獨立 adapter 驗收。Part 2 尚未開始。

## 可重複執行的驗收命令

本地服務沿用 [AG-UI 部署](agui-deployment.md) 與 [CopilotKit 操作方式](../examples/copilotkit/README.md)。
使用 Hermes PM test interpreter 與 Node 22.18。

```bash
scripts/run_tests.sh tests/hermes_agui
scripts/run_tests.sh tests/hermes_agui/test_profile_objects.py
cd examples/copilotkit
npm test -- --reporter=dot
npm run build
npm run test:e2e
GRAPH_MEMORY_TEST=1 npm run test:e2e -- tests/browser/memory-explorer.spec.ts
DYNAMIC_BOT_TEST=1 npm run test:e2e -- tests/browser/bot-management.spec.ts
MULTI_BOT_TEST=1 npm run test:e2e -- tests/browser/multi-bot.spec.ts
node --import tsx tests/fixtures/wiki-evaluate.ts
```

以 migration owner 連往全新的測試 DB 執行 001。Probe 從
`HERMES_AGUI_TEST_DATABASE_URL` 取得同一資料庫的連線字串，需在裝有
`psycopg[binary,pool]` 的獨立 Python 環境執行。Probe 會插入 fixture rows，重跑請使用新的
測試資料庫，完成後刪除測試 DB 或測試容器。

```bash
psql -X -v ON_ERROR_STOP=1 -f hermes_agui/storage/migrations/001_host.sql
python -m tests.hermes_agui.postgres_storage_probe
```

`GCSObjects.from_adc(bucket_name)` 使用 google-cloud-storage 與 ADC。

## 驗收結果

| 驗收項目 | 實際結果 |
| --- | --- |
| 起始 sandbox 基線 | Vitest 83 passed、16 failed，均為 loopback listen EPERM。Python runner 的 22 個檔案在執行測試前遇到 sandbox PermissionError。兩套皆重跑並保留下列結果。 |
| PostgreSQL adapter | 18.6 真實伺服器搭配 psycopg 3.3.9，migration、同 Bot 競態、跨 scope 並行、過期接管、拒絕舊 writer、重送、終止、profile CAS 與注入 SQL 寫入失敗後的交易 rollback 全數通過。Docker Desktop 的容器啟動卡住，改用一次性本機 Unix socket。測後已停止 PostgreSQL 並移除暫存 cluster。 |
| 既有 Hermes AG-UI | 22 files、82 passed、0 failed，Docker integration 未在預設模式執行。包含 dynamic Host/Runtime、delegation、原生 session、壓縮與 Graph evolution。 |
| CopilotKit Vitest | 15 files、99 passed、0 failed。 |
| Native profile 快照 | 1 file、3 passed、0 failed。刪除原 home 後在另一個路徑建立原生 service，使用同 Thread 和 Session ID 續聊。搬遷前由原生 memory 工具寫入，還原後由原生 skill_view 讀取技能。另驗證錯誤 scope、checksum、symlink 與重複寫入。 |
| CopilotKit build | TypeScript 與 Vite build 通過。Vite 回報既有 bundle 大小警告。 |
| Playwright 預設模式 | 6 passed、4 skipped，跳過的情境需要指定 managed、graph 或 multi-Bot 模式。 |
| Playwright 指定模式 | Graph Explorer 3 passed，managed Bot 2 passed，多 Bot 1 passed。已執行預設模式跳過的四項。 |
| 現有 Graph retrieval fixture | `wiki-evaluate.ts` 成功，recall@3 為 keyword 0.50、hybrid 約 0.92、hybrid + graph 1.00。使用 deterministic fixture encoder 與現有 SQLite。 |
| 靜態檢查 | 變更的 Python 檔案通過 Ruff。工作樹通過 `git diff --check`。 |

快照測試首輪發現非法清單項目前可能已上傳其他檔案。修正為先驗證所有清單路徑再上傳，
重跑後三項通過。
