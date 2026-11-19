# Hermes AG-UI Cloud Native Part 2 — Source Code Readiness

Repository: https://github.com/jiangweitaiwan/hermes_agui.git

## 1. 任務與邊界

本計畫取代原 CLOUD_NATIVE_PART_2.md。Codex 僅在 repository 內改造程式碼、封裝、設定樣板、測試與文件；交付可由使用者手動部署的 Cloud Run Ready repository。不得建立 GCP 資源、執行遠端部署、修改 IAM/DNS、要求真實金鑰或產生雲端費用。所有真實 GCP/Vercel 驗收標記 NOT RUN，交由使用者。不得宣稱 production ready。

以 Part 1 最終驗收 commit 0e7eea48af480b73e72090fffd76c2f25553fd11 為歷史基線；開始時記錄實際 HEAD，閱讀 CLOUD_NATIVE_PART_1、REMAINING、FINAL_ACCEPTANCE 與最新報告、migration、fixture 和正式入口。若 HEAD 不包含驗收成果或基線有回歸，先報告阻塞，不重寫 storage layer。保留 PostgreSQL registry、lease/fencing、outbox、GCS snapshot/manifest、Graph Memory、Bot manager、原生 skill/memory、local mode 與 AG-UI contract。不得把 snapshot 說成已完成 SQL transcript 遷移。

## 2. 目標架構

```text
Vercel React/Vite + Firebase Auth
  | HTTPS / Firebase ID token / AG-UI stream
  v
Cloud Run Runtime (public ingress + application ACL)
  | Google ID token + bot/management credential
  v
Cloud Run Hermes Host (private IAM)
  | completion outbox -> authenticated Runtime callback
  |
  +-- Cloud SQL + GCS profile snapshots
Runtime -- Cloud SQL + GCS graph objects
Runtime durable jobs/outbox -> Cloud Tasks -> private Memory Worker
Cloud Scheduler -> private Worker reconcile endpoint
```

三個服務；Worker 可與 Runtime 共用 image，不共用常駐 timer。Hermes Host 的 completion dispatcher 可採獨立可執行命令供 Scheduler/Cloud Run Job 呼叫，或以私有 Host endpoint 接收 Scheduler；選一個並記錄，不依賴 request 結束後仍有 CPU。PostgreSQL 為狀態權威，GCS 為版本化物件權威，容器磁碟只是 scratch。Vercel 不持有服務端秘密。

## 3. Work package A — 正式入口與封裝

- 盤點 hermes_agui/server.py、examples/copilotkit/server/index.ts、Dockerfile.agui、examples/copilotkit/Dockerfile 與測試入口，核對實際符號及路徑後修改，不新增平行 production harness。
- 正式服務支援 0.0.0.0:$PORT、單一 ingress port、HTTPS reverse proxy、明確 trusted origin/host 設定；將 loopback internal delegation listener 的雲端路由改為經認證的同 port endpoint，local mode 保留相容性。
- 啟動時驗證必要設定、依賴與 schema version；health 不洩漏內容；提供 startup probe 可用端點。SIGTERM 停止接新 run、best-effort flush/release，可靠性不得依賴 shutdown。
- 檢查 Cloud SQL Unix socket/connector DSN 在 Python/Node driver 的實際用法，GCS ADC 與 bucket/prefix 設定；缺少 durable backend 時 cloud mode fail closed，不允許默默改用本地資料。
- Docker image 包含正式入口、migration、worker/dispatcher 命令與所需依賴；非必要不加入測試 fixture 或秘密；以容器實際啟動測試驗收。DB migration 獨立執行，避免每個 replica 競爭。

## 4. Work package B — IAM、Firebase、前端

- Runtime -> Host：以 ADC 取得短效 Google ID token，audience 為目標服務 URL（可配置正式 audience）；以 X-Serverless-Authorization 承載 Cloud Run IAM token，保留 Authorization 的現有 bot/management 憑證。逐一覆蓋 run、管理、delegation、completion 等呼叫；token cache 依 audience 隔離並更新，不記錄 token。
- Host -> Runtime：Runtime 公開時不能只依 Cloud Run IAM；以獨立應用層 header 傳遞 Google ID token，server 驗證簽章、issuer、audience、expiry、允許的 service account identity，並維持既有業務憑證與 scope 驗證。內部路由拒絕匿名及 browser credentials。Worker/dispatcher/reconciler 採 private IAM 與適用的業務授權。
- Firebase Admin 驗證 ID token，server-side uid -> principal/owner/project membership；所有 Bot、Thread、Graph、run、replay、cancel、delegation 路由均做 ACL。禁止 client 自行指定身份；過期/錯 audience/錯 scope 拒絕。雲端不得 fallback 到 local token/cookie。移除 production 對 process-local login Map 的依賴。
- CORS 精確 allowlist、OPTIONS、必要 headers；不信任 Origin 作為身份；不允許任意 Vercel preview。前端直接 HTTPS fetch Runtime，確認實際 CopilotKit transport 的 bearer/stream 支援，若需 proxy 記錄 timeout 取捨。
- 保留既有 UI，補登入/登出、token refresh、server-backed thread/history、reconnect/cancel/interrupted/error 狀態；不重做 UI。Firebase provider 可配置，以 email/password 為初始樣板。只公開 Firebase client config/API URL。
- 安全閘門：拒絕 IDOR、SSRF、path traversal、跨租戶讀取與任意 toolset 提權；預設 allowlist memory/skills 等經審核工具，未隔離 terminal/code execution 禁用。多 Bot 不等於 OS sandbox；不可信 arbitrary code 多租戶不在本期範圍。

## 5. Work package C — Durable background work

沿用 Part 1 job/outbox/lease APIs，Cloud Tasks adapter 只送 job ID/schema，不送 transcript/secret。Worker 正式 HTTP 入口呼叫既有 compiler/processJob 邏輯；以專用 OIDC identity 授權。DB CAS/lease/fence 為冪等權威，不靠 task name 去重。成功持久化或已完成才 2xx；暫時失敗回可重試狀態，永久失敗先保存 terminal reason。處理 timeout 重送及 queue exhausted 的人工重送。

Runtime 持久化 job/outbox 後 enqueue，失敗不丟已提交 job。Scheduler 呼叫 reconciler 補送、接管過期 lease、處理 Host completion delivery。Cloud mode 禁止依賴 Runtime evolution timer；local mode 保留。若 Host dispatcher 需要獨立命令，提供正式 CLI、image entrypoint、退出碼與文件。Cloud Tasks deadline 需有界；超限工作安全停止或明確列為需 chunk/Jobs 的限制，不設無限 timeout。

## 6. Work package D — Distributed Run / AG-UI

- 沿用 run lease/fencing；新增必要 migration（只增量），durable event log 有 runId、scope、attempt、monotonic seq、event type/payload/time。先持久化再送，delta 可有界 batch；terminal 與 replay 有明確順序、去重與 retention。驗證真實 AG-UI client 後實作 replay API/client，不假設 Last-Event-ID 原生支援。
- 跨 instance cancel 以 DB 原子 cancelRequested，owner 有界輪詢及工具邊界檢查，terminal CAS、必要時終止隔離 subprocess；取消不等於撤銷副作用。
- Run 仍由活躍 HTTP request 持有；client 斷線不等同 cancel，定義 grace 和 ownership。實例崩潰由 reconcile 標 interrupted，已提交事件可重讀；不得假裝任意 Python stack 可續跑或自動重放外部副作用工具。
- HITL 只恢復已有且可序列化 checkpoint，校驗 scope/version/一次性 resume operation；沒有原語則安全回 unsupported/interrupted，列明限制。
- Delegation 保留 A→B scope、correlation ID、獨立 run、結果寫回 contract；驗證 cycle/depth/deadline、同 Bot lease deadlock、未授權拒絕。

## 7. Work package E — 手動部署交付包

新增或沿用 deploy/gcp/ 下的 README、host.example.yaml、runtime.example.json、host/runtime/worker.env.example、database-grants.sql、compose.staging.yaml；名稱可依 repo 慣例調整並列出最終對照。設定樣板必須以真實 parser 驗證，不猜 env 名稱；提供各服務 secret/env、port、entrypoint、health、IAM caller/callee/audience、bucket/prefix、DB role、queue/deadline、Firebase/Vercel config 對照。Migration/grants 以正式 schema 驗證，migration role 與服務 role 分離。

提供本地 image build、migration、smoke 命令及手動操作所需 gcloud 命令參考（不得執行遠端命令）；不用 Terraform、自動 provisioning 或 CI/CD deploy pipeline。README 說明雙向 URL bootstrap、備份/還原、rollback/schema 相容、GCS retention、DB pool sizing、retry/reconcile 與 log redaction。初始 region asia-east1 可調，不承諾容量/費用。

## 8. 單次最終本地整合驗收

開發期間可執行 focused tests，完成全部 package 後執行一次完整 regression + production-entrypoint scenario。沿用 Part 1 共用 scenario runner，改用正式 Host/Runtime/Worker image 或正式入口，不用 fixture server 取代 production。真 PostgreSQL、外置持久化物件測試 adapter、fake LLM、mock IAM/Firebase/Cloud Tasks transport 可控注入且僅測試模式啟用。GCS/Google SDK adapter 的 unit/contract test 不等於真實服務驗收。前端 typecheck/build 加上實際 browser E2E（可使用測試 auth）；確認 production mode 無測試 bypass。

| ID | 必須通過的本地測試 |
|---|---|
| L01 | 三個正式入口在容器啟動，PORT/health/config/migration/grants 正確，缺必要設定 fail closed |
| L02 | 建 A/B、不同 thread 對話、原生 memory/skill、graph evolution/retrieval、reload history、delegation；保留 Part 1 最終 scenario 的證據 |
| L03 | 重建容器並刪除 writable layer，資料仍可讀、停用 Bot 不取得新 lease |
| L04 | 各 Host/Runtime 至少兩個獨立 process 共享 PG/object storage；same Bot fence、different Bot concurrency、跨 instance cancel |
| L05 | completion/outbox enqueue 中斷、duplicate delivery、timeout retry、expired lease、terminal failures；不重複 graph publication |
| L06 | IAM/Firebase mock 驗證合法/過期/錯 audience/錯 principal；雙憑證不覆蓋；匿名/跨 scope/不允許 origin 拒絕、production 無 bypass |
| L07 | AG-UI stream、replay 去重與順序、斷線、cancel race、kill owner 後 interrupted；副作用不自動重播 |
| L08 | delegation cycle/depth/timeout/ACL、tool allowlist、安全隔離、secret redaction |
| L09 | local mode regression、前端登入/登出/歷史/reconnect/cancel、image build、設定樣板解析 |
| L10 | 備份還原及 rollback 本地演練，manifest 對帳、migration backward compatibility/最小權限 |

雲端專屬驗收 C01–C07（真 IAM/Firebase、Cloud SQL/GCS、Cloud Tasks/Scheduler、OpenRouter、Vercel streaming、revision/scale/recovery、成本負載）一律 NOT RUN；列明操作步驟與預期結果，不得用 mock 標 PASS。每項記錄命令、退出碼、log 證據與限制；中途失敗修復後重跑受影響測試，最終完整 suite 確認交付版本。

## 9. 交付與停止條件

交付 source、tests、migration（如必要）、Dockerfiles、部署樣板、手動部署參數表、docs/cloud-run-deployment.md、docs/cloud-native-part-2-report.md。報告記錄基線與交付 commit（如未 commit 記錄狀態）、實際變更、正式入口、測試證據、PASS/FAIL/NOT RUN、雲端待驗收與風險。不得填寫虛構部署 URL、成本、實測結果。完成條件為 L01–L10 全通過且無未解決的資料遺失/auth/ACL/冪等阻塞；若不滿足，標 SOURCE NOT READY 並列出阻塞。滿足才標 SOURCE READY / CLOUD NOT VALIDATED。完成後停止，不接續實際 GCP 部署。
