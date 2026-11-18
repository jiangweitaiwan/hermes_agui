# Cloud-native Part 2 前置驗收報告

**結論：Part 1 未通過服務端驗收，Part 2 尚未開始。** 查核基準為 `e9408177d4d23adfca1a3d4bc780350da87c4b84`，開始時工作樹乾淨。已完整核對 [Part 1 計畫](CLOUD_NATIVE_PART_1.md)、[Part 1 實作與驗收報告](cloud-native-part-1-report.md)、[Part 2 計畫](CLOUD_NATIVE_PART_2.md)及 [儲存盤點](cloud-native-inventory.md)。本次變更僅包含此報告。

| 第一階段閘門 | 目前程式碼與驗收證據 | 結果 |
| --- | --- | --- |
| 原生 session、profile 與 run lease | `ProfileObjects` 已有 native SQLite 快照與 hydration，`PostgresRunStore` 已有 fenced lease 與 manifest CAS。現有引用限於測試。正式 Host 執行路徑仍在 `hermes_agui/host_runtime.py` 建立本機 `ReceiptStore`，終止事件前的 profile checkpoint 尚未接線。 | 未通過 |
| Registry 與資料遷移 | `hermes_agui/management.py` 仍使用 `registry.sqlite3`，`examples/copilotkit/server/bots/registry.ts` 仍使用 `node:sqlite`。現有 PostgreSQL migration 只建立 Host run 與 bot state，缺少 Runtime registry、credential reference、雙 registry 對帳及離線遷移 CLI。 | 未通過 |
| Graph 儲存及 durable job/outbox | `examples/copilotkit/server/graph/wiki-store.ts` 仍使用同步 SQLite transaction。缺少 PostgreSQL metadata 與繁中搜尋、GCS graph revision 發布，以及 Part 2 Cloud Tasks 所需的 durable job/outbox 與共用 job 執行入口。 | 未通過 |
| 跨服務重建、隔離及故障恢復 | 先前的快照測試在新目錄驗證原生續聊、memory 和 skill。仍缺少兩服務移除 writable layer 後的端到端重建，以及正式持久化路徑上的跨 scope、終止前中斷及 job 重試驗收。 | 未執行 |

後續修補應沿用 `hermes_agui/storage/{objects,profile,runs}.py`、`hermes_agui/storage/migrations/001_host.sql`、`tests/hermes_agui/test_profile_objects.py`、`tests/hermes_agui/postgres_storage_probe.py` 與 `examples/copilotkit/tests/fixtures/wiki-evaluate.ts`。保留原生 SQLite snapshot 契約和其已記載的 crash window，先接通服務端持久化與隔離，再重跑第一階段驗收。兩階段計畫以這項驗收作為開始 Part 2 的條件。

## 本次重跑

| 命令 | 結果 |
| --- | --- |
| `scripts/run_tests.sh tests/hermes_agui` | PM 初始化嘗試寫入使用者的 Hermes home，被 sandbox 拒絕。 |
| `HERMES_PYTHON="$PWD/.venv/bin/python" scripts/run_tests.sh tests/hermes_agui` | 在 sandbox 內有 23 個測試檔因 `PermissionError` 無法啟動。允許本機程序與 loopback 後，20 項通過（含 3 項 profile 快照測試）、0 項 assertion 失敗，15 個檔案因缺少 `ag_ui` 在收集時出錯。整體 exit code 為 1。 |
| 在 `examples/copilotkit` 執行 `npm test -- --reporter=dot` | 目前環境找不到 `npm`，Vitest 未執行。 |
| `python -m tests.hermes_agui.postgres_storage_probe` | 未執行。本機測試環境缺少 `psycopg` 和 PostgreSQL CLI，先前 adapter probe 的通過紀錄見 Part 1 報告。 |

Part 2 的最終驗收、GCP／Cloud Run／Vercel 部署教學與部署均待前置條件達成。雲端案例均為 NOT RUN，沒有部署 URL，也未建立付費資源。
