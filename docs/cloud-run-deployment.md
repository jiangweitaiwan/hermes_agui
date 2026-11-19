# Cloud Run 手動部署操作

本交付僅修改 repository。依使用者最新指示，L01–L10 與 C01–C07 均 **NOT RUN**；沒有建立 GCP 資源或部署 Vercel，不代表 production ready。下列遠端命令是供操作者閱讀與手動執行的參考，Codex 未執行。

## 必填參數

目前 repository 不包含使用者的 GCP project、服務 URL、Firebase UID、Secret Manager 版本或 bucket 名稱，不能填成虛構的實際值。請先填寫下表；只有 region 與程式入口已有明確預設。

| 參數 | 填寫來源／用途 |
|---|---|
| `PROJECT_ID`、`PROJECT_NUMBER` | 使用者的 GCP project |
| `REGION=asia-east1` | 可調；Cloud Run、Tasks、SQL 儘量同區 |
| `HOST_URL`、`RUNTIME_URL`、`WORKER_URL` | Cloud Run `status.url` 原值，不加尾端 `/`；同時作 audience |
| `HOST_IMAGE`、`RUNTIME_IMAGE` | 使用者 Artifact Registry 的 immutable digest；Worker 共用 Runtime image |
| `SQL_CONNECTION_NAME` | `PROJECT:REGION:INSTANCE`；預先建立 PostgreSQL DB |
| DB credentials | migration owner 與 `hermes_host`／`hermes_runtime` 分離；Worker 用 Runtime role |
| `GCS_BUCKET` | 使用者預先建立且啟用版本保留的 bucket；Host prefix 為 `profiles`，Graph 沿用既有 object keys |
| `HOST_SA`、`RUNTIME_SA`、`WORKER_SA` | 三服務執行身分；不得使用 project owner |
| `TASKS_SA`、`SCHEDULER_SA` | Tasks OIDC caller、Scheduler caller |
| Firebase project／UID | 啟用 email/password；UID 對應 `cloud.members` 與 `management.users` 的同一 owner/principal/project |
| Vercel production origin | 精確 HTTPS origin；不使用 preview wildcard |
| queue／deadline | 預設 `hermes-memory`／600 秒；有效範圍 30–1800 秒 |
| Secret Manager reference | 由操作者配置並記錄實際版本，不將 secret 值填進 git |

設定樣板與完整對照在 [deploy/gcp](../deploy/gcp/README.md)。複製並替換 `host.example.yaml`、`runtime.example.json` 與各 env example；不得把 placeholder 用於真實服務。行為設定放在 YAML/JSON，秘密才放 env／Secret Manager。

## 正式入口與權限

| 服務／命令 | 正式入口 | 存取控制／健康檢查 |
|---|---|---|
| Host | image 預設 `python -m hermes_agui.server --bots-config /etc/hermes/host.yaml --host 0.0.0.0` | private IAM + 現有 Bot/management credentials；GET `/health` |
| Runtime | image 預設 `npm start` → `tsx server/index.ts --production` | public ingress + Firebase JWT／server ACL；GET `/health` |
| Worker | `node --import tsx server/index.ts --production --worker` | private IAM + `X-Worker-Token`；GET `/health` |
| Host completion Job | `python -m hermes_agui.storage.completion_delivery --once --audience "$RUNTIME_URL"` | Host SA；每次最多交付一筆，非零退出表示失敗 |
| Host reconcile Job | `python -m hermes_agui.storage.reconcile` | Host SA；收回過期 lease、補 terminal replay、事件保留 30 天 |
| Bot reconcile | Worker `/internal/jobs/reconcile` 內呼叫既有 `reconcileNow()`；亦可執行 `node --import tsx server/bots/reconcile-cli.ts` | Worker 業務 credential／受信任 CLI |

三服務皆使用 `PORT`（Cloud Run 通常注入 8080）、`0.0.0.0`、一個 ingress port。`/health` 只回覆 status，初始化成功後才 listen。設定 startup HTTP probe 指向 `/health`。Host cloud allowlist 必須包含真服務 hostname 與 loopback probe hostname；Runtime 的 `cloud.hosts` 填真服務 Host header，不信任轉送來的任意 Host/Origin。Cloud Run TLS 終止後的內部 HTTP 不影響 bearer 身分判斷。不要把應用 `--host` 設成外部 URL。

Runtime 呼叫 Host 的 run／管理／delegation parent／cancel／history 都使用 audience-scoped ADC ID-token client，置於 `X-Serverless-Authorization`，`Authorization` 保留業務 token。Host 回呼 public Runtime 使用 `X-Hermes-Service-Identity` 的 Google ID token，Runtime 驗簽、issuer、audience、expiry 與 service-account email allowlist，再驗既有業務 scope/token。瀏覽器不能用 Firebase token 呼叫 internal routes。

Tasks 使用其 `oidcToken` 呼叫 private Worker；`X-Worker-Token` 是額外業務 credential。Scheduler reconcile 也要帶該 header。Worker IAM 只授權 Tasks/Scheduler SA；Host invoker 授予 Runtime SA（Worker 對帳亦需 Host invoker）。Runtime 的公開存取不免除 Firebase／callback 應用驗證。

## Images 與 migration（本地命令，未執行 build）

```bash
# repository root；tag 由操作者指定，不含秘密。
docker build -f Dockerfile.agui -t hermes-host:part2 .
docker build -f examples/copilotkit/Dockerfile -t hermes-runtime:part2 examples/copilotkit

# 只適用新 DB：migration DSN 使用 schema owner，服務不能持有此帳號。
docker run --rm --env-file /secure/host-migration.env \
  --entrypoint python hermes-host:part2 -m hermes_agui.storage.migrate
docker run --rm --env-file /secure/runtime-migration.env \
  --entrypoint node hermes-runtime:part2 --import tsx server/storage/migrate-cli.ts

# 接著由 schema owner 執行（先建立 LOGIN roles，密碼由操作者安全設定）：
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/gcp/database-grants.sql
```

migration env 的實際 key 分別為 `AGUI_HOST_DATABASE_URL`、`AGUI_RUNTIME_DATABASE_URL`。Host 001–006、Runtime 001–008 以單一 transaction、DB advisory lock 與獨立 migration ledger 執行；application startup 不跑 migration。Cloud SQL Unix socket 必須掛載 `/cloudsql/CONNECTION_NAME`；本地 docker 未掛載該 socket 時請用本機代理／可達的測試 TCP DSN，不能直接使用 Cloud Run socket DSN。

Part 1 既有 DB 沒有新 ledger 時，**不要執行 fresh migrator**；先備份，由 owner 確認已套用 Host 001–005／Runtime 001–007，再僅手動執行 Host `006_run_events.sql` 與 Runtime `008_task_deliveries.sql`，然後更新 grants。fresh deployment 仍是 Part 1 核准範圍，沒有宣稱完成既有使用者全量遷移。

Python DSN：`postgresql://ROLE:PASSWORD@/DB?host=/cloudsql/CONNECTION_NAME`。
Node DSN：`postgresql://ROLE:PASSWORD@localhost/DB?host=/cloudsql/CONNECTION_NAME`。
密碼含保留字元時須 URI percent-encode；實際 DSN 放 Secret Manager。Python 使用 psycopg、Node 使用 pg 的 Unix-socket host query。GCS 使用 ADC，Cloud Run 不需要掛 service-account key；由各服務 SA 取得 bucket 權限。不要設定 production filesystem object adapter。

## 手動 Cloud Run 命令參考（NOT RUN）

以下假設 images 已由操作者 push、SQL／bucket／SA／secrets／queue 已建立。secret 名稱可調，必須替換為現存 reference。

```bash
# 操作者自行設定 PROJECT_ID、REGION、HOST_SA、RUNTIME_SA、WORKER_SA、
# SQL_CONNECTION_NAME、GCS_BUCKET、HOST_IMAGE、RUNTIME_IMAGE。
gcloud run deploy hermes-host --project "$PROJECT_ID" --region "$REGION" \
  --image "$HOST_IMAGE" --service-account "$HOST_SA" --no-allow-unauthenticated \
  --port 8080 --timeout 3600 --concurrency 4 --max-instances 2 \
  --add-cloudsql-instances "$SQL_CONNECTION_NAME" \
  --set-env-vars "AGUI_STORAGE_BACKEND=gcp,AGUI_GCS_BUCKET=$GCS_BUCKET" \
  --set-secrets '/etc/hermes/host.yaml=host-config:VERSION,AGUI_HOST_DATABASE_URL=host-db-url:VERSION,AGUI_BOT_CREDENTIAL_SEED=bot-seed:VERSION,AGUI_HOST_MANAGEMENT_TOKEN=host-management:VERSION,OPENROUTER_API_KEY=openrouter:VERSION,AGUI_DELEGATION_TOKEN=delegation:VERSION' \
  --args=--bots-config,/etc/hermes/host.yaml,--host,0.0.0.0

gcloud run deploy hermes-runtime --project "$PROJECT_ID" --region "$REGION" \
  --image "$RUNTIME_IMAGE" --service-account "$RUNTIME_SA" --allow-unauthenticated \
  --port 8080 --timeout 3600 --concurrency 8 --max-instances 2 \
  --add-cloudsql-instances "$SQL_CONNECTION_NAME" \
  --set-env-vars "AGUI_BOTS_CONFIG=/app/config/runtime.json,AGUI_STORAGE_BACKEND=gcp,AGUI_GCS_BUCKET=$GCS_BUCKET" \
  --set-secrets '/app/config/runtime.json=runtime-config:VERSION,AGUI_RUNTIME_DATABASE_URL=runtime-db-url:VERSION,AGUI_BOT_CREDENTIAL_SEED=bot-seed:VERSION,AGUI_HOST_MANAGEMENT_TOKEN=host-management:VERSION,AGUI_GRAPH_COMPLETION_TOKEN=graph-completion:VERSION,AGUI_WORKER_TOKEN=worker-token:VERSION,AGUI_DELEGATION_TOKEN=delegation:VERSION,OPENROUTER_API_KEY=openrouter:VERSION'

# Worker 使用相同 durable config/secrets/SQL 掛載，與上行 Runtime 相同；
# 使用 --no-allow-unauthenticated、--service-account "$WORKER_SA"、
# --concurrency 1、--timeout 610，並覆寫：
# --command node --args=--import,tsx,server/index.ts,--production,--worker
```

上例 instance／concurrency 是初始設定值，非容量實測承諾；總 DB connection budget 見 deploy README。Worker timeout 應大於 Tasks deadline；Compiler 自身也有界。維持 queue max dispatch 與 Worker capacity 相容，不能把所有長工作塞進無限 timeout。

雙向 URL bootstrap：先使用無 Bot、無流量的設定發布三服務取得 `status.url`（初次 Host 可暫不啟用 delegation）；不要呼叫 run。將實際 URL／hostnames／audiences 寫回設定的新 Secret Manager 版本，再更新三服務，最後開放操作。Worker URL 在 Tasks 設定中；Runtime URL 同時出現在 Host delegation 與 completion Job。用 `gcloud run services describe SERVICE --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)'` 讀取，不能猜 URL。

由操作者授權必要 caller 的 `roles/run.invoker`，並確認 Tasks service agent 具有產生 TASKS_SA OIDC token 的必要權限，執行者有 `actAs`，各執行 SA 只有所需 SQL client、bucket object、secret version 存取與 Tasks enqueue 權限。以最小權限建立 queue／Scheduler；本交付不自動修改 IAM。

Tasks adapter POST v2 CreateTask，payload 僅 `{schema:1,jobId}`，OIDC audience 為 `workerUrl`。Scheduler 手動配置 POST `WORKER_URL/internal/jobs/reconcile`、OIDC audience `WORKER_URL`，header `X-Worker-Token` 用同一 secret；不要在公開 shell history 中填 secret。另排程執行兩個 Host Cloud Run Jobs（completion `--once`、reconcile），以獨立 Job command 覆寫 image 的 Python entrypoint。completion Job 需 Host env、`AGUI_GRAPH_COMPLETION_URL`／`AGUI_GRAPH_COMPLETION_TOKEN` 與 `--audience RUNTIME_URL`。排程呼叫 Jobs API 需要適當的 Job 執行權限，不能把 service invoker 當成 Jobs API 權限。Job 失敗需告警，完成 outbox 的 terminal failed 狀態需人工檢視。

## Vercel 與使用限制

在 Vercel 對 `examples/copilotkit` 執行 `npm ci`、`npm run build`，output `dist`；只公開 `VITE_RUNTIME_URL` 與 `VITE_FIREBASE_API_KEY`。Firebase 開啟 email/password，使用者帳號由管理員建立；沒有公開註冊路由。JWT 存在記憶體，refresh token 自動更新 ID token，登出清除；刷新頁面需重新登入。Firebase UID 必須由 server config 映射，不能由 client 自報 principal。

瀏覽器直接 HTTPS fetch Runtime；CopilotKit HttpAgent 的 fetch transport 帶 bearer，保留串流 body；沒有 Vercel proxy，因而不依賴 Vercel function timeout。設定 Runtime 精確 CORS allowlist。所有真實 browser／Vercel streaming 測試 **NOT RUN**。

歷史 API 是成功／中斷回合的投影事件與 user input，**不是 SQL transcript 遷移**；原生完整 transcript 仍在 Part 1 snapshot。UI 載入最近 20 回合、最多 2 MiB 的文字投影，工具／HITL 完整畫面不從該投影重建；超量需使用 paged replay API。單 run 最多 8 MiB／10000 事件，事件保留 30 天，原生 snapshot retention 不由此修改。replay 回傳 monotonic `seq`，每頁最多 1000；以 `after` 翻頁及 seq 去重，不假設 AG-UI SDK 支援 Last-Event-ID。重連只讀事件，不重跑外部工具。

run 仍由 HTTP request 持有。斷線 grace 為 0：安全停止並標 interrupted，不保存可續跑 Python stack；不等同持久化 cancelRequested 操作，取消亦不能撤銷既有副作用。owner 崩潰由 Host reconcile 收回過期 lease。Durable HITL 沒有 checkpoint 原語，resume 安全回 409 unsupported。預設只開 memory/skills；多 Bot 並不是 OS sandbox，不支援不可信 arbitrary code 多租戶。

真 IAM/Firebase、SQL/GCS generation、Tasks/Scheduler、OpenRouter、Vercel streaming、scale/recovery、成本與備份還原演練全部 **NOT RUN**。先由操作者驗證合法／錯 audience 身分、跨 owner ACL、重複 task、lease takeover、stream timeout、restore manifest 對帳與 rollback，再考慮導入實際使用者。

## 操作者 smoke 與雲端待驗項（NOT RUN）

以下只列出操作契約，不在本次執行：

```bash
curl --fail "$RUNTIME_URL/health"
# HOST_ID_TOKEN 由獲授 invoker 的 caller ADC／gcloud 取得，audience 必須為 HOST_URL。
curl --fail -H "X-Serverless-Authorization: Bearer $HOST_ID_TOKEN" "$HOST_URL/health"
# FIREBASE_ID_TOKEN 是已列入 cloud.members 的 UID 所取得之短效 ID token。
curl --fail -H "Authorization: Bearer $FIREBASE_ID_TOKEN" "$RUNTIME_URL/api/bots"
# WORKER_ID_TOKEN 為 Worker 的 IAM caller token；業務 token 不可省略。
curl --fail -X POST -H "Authorization: Bearer $WORKER_ID_TOKEN" \
  -H "X-Worker-Token: $AGUI_WORKER_TOKEN" "$WORKER_URL/internal/jobs/reconcile"
```

| 項目 | 手動操作與預期 | 本次 |
|---|---|---|
| C01 IAM/Firebase | 合法雙憑證可用；錯 audience／過期／未列 SA／未列 UID／跨 owner 均拒絕 | NOT RUN |
| C02 SQL/GCS | 重建 revision 後 snapshot／Graph manifest 與 generation 可讀；服務 role 不可 DDL 或跨 schema 寫入 | NOT RUN |
| C03 Tasks/Scheduler | 中斷 enqueue、重送同 job、過期 lease、Scheduler 補送；只有一次 fenced publication | NOT RUN |
| C04 OpenRouter | 真模型執行 memory/skills、completion ingestion 與 Graph retrieval；秘密不進 log | NOT RUN |
| C05 Vercel streaming | 登入／refresh／歷史／重連／取消；長串流及 CORS 行為符合實際平台限制 | NOT RUN |
| C06 revision/scale/recovery | 雙實例競爭、owner kill、interrupted replay、備份還原與 image rollback；不重播工具副作用 | NOT RUN |
| C07 負載／成本 | 逐步提高 queue 與 concurrency，觀察 SQL pools、latency、quota、費用與告警 | NOT RUN |
