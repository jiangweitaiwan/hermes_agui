# Hermes AG-UI Cloud-native 改造計畫 — Part 2

> Cloud Run Production Deployment：事件驅動、分散式 Run、Firebase Auth、GCP + Vercel
>
> Repository: https://github.com/jiangweitaiwan/hermes_agui.git
> 前置：`CLOUD_NATIVE_PART_1.md` 已實作並驗收；讀取實際 Part 1 report，不重新設計已通過的 storage layer。

## 1. 目標與非目標

部署三個獨立 Cloud Run services：CopilotKit Runtime（公開 API、應用層驗證）、Hermes Host（private IAM）、Memory Worker（private IAM）。Cloud SQL PostgreSQL、GCS 為權威資料來源；Cloud Tasks 觸發 memory job；Firebase Auth 供前端登入；Vercel 保留現有 React/Vite workspace。保留 local mode。

第一版支援正常多 Bot、多 instance、重新部署後資料保留、可靠 job 重試、run cancellation 與事件重連。只對已存在且可明確序列化的 HITL checkpoint 提供 resume；任意 Python stack/tool 執行中崩潰後不可無縫接續，標 interrupted 並提供安全 retry UI。不得自動重放有外部副作用的工具。正式 production readiness 以實際測試及安全條件判定，無雲端權限時僅交付 deployable code，不宣稱已部署。

## 2. 依賴檢查與沿用成果

閱讀 Part 1 inventory/report、真實 source、migration schema、adapter/lease/job API、fixtures 與現有 frontend/delegation contract；記錄 HEAD。若 Part 1 的原生 session 採用 GCS snapshot 過渡，明確沿用限制與鎖，不能無聲改稱 Cloud SQL transcript 已完成。不得為了雲端服務再做一組 storage interface 或重複 migration。保留共享 scenario runner；只增加雲端特有的 test cases，最終完整回歸一次。

## 3. Work package A：Cloud Tasks / Memory Worker

將 Part 1 job dispatcher 接至 Cloud Tasks；獨立 worker HTTP entrypoint 呼叫既有 `processJob(jobId)`，不複製 compiler。Cloud Run request-based billing 模式下禁止依賴 request 結束後的 timer。Runtime 寫 durable job/outbox 與 run completion（若 ownership 不同，採明確事件及冪等接收），嘗試 enqueue；Cloud Scheduler 定期以 IAM 呼叫私有 reconciler 回補未發送 outbox/過期 lease（避免 dispatch 失敗永久遺失）。可共用 worker service 的私有 endpoint，不必增加第四個 service。task payload 只帶 job ID/必要 schema，從 DB 取得 scope，不放 secrets/transcript。

Cloud Tasks HTTP target 使用專用 service account OIDC；worker 驗證服務身分，禁止匿名呼叫。設定 queue retry/backoff、rate/concurrency、dispatch deadline；worker 於持久化成功或已完成 job 才回 2xx，暫時失敗返回可重試狀態，永久失敗先持久化 terminal reason。task name 唯一屬輔助，DB idempotency 才是權威。測試重複 delivery、timeout 後重送、enqueue 中斷、過期接管、queue exhausted（可觀測並可人工重送）。Cloud Tasks HTTP 任務時間須遵循實際服務上限，過長工作切 checkpoint/chunk 或改用 Cloud Run Jobs，勿以無限 timeout 掩蓋問題。

## 4. Work package B：Distributed Run / AG-UI Streaming

沿用 Part 1 RunStore、lease/fence。建立 durable event log（runId + monotonically increasing seq、scope、attempt、event type/payload/timestamp）；敏感內容按明確 retention/ACL，token delta 可有界批次持久化、terminal 事件須可靠保存；保證 event replay 不重複、不亂序，明確定義已發出未落盤的窗口（建議先保存再送）。仍保持 AG-UI event schema，不破壞現有 CopilotKit client；如需新增 replay endpoint/client adapter，先確認套件支援與真實 transport，再透過版本化擴充實作，不假設 Last-Event-ID 原生可用。

跨 instance cancel：授權 endpoint 原子設 cancelRequested，owner 於 bounded interval/工具邊界讀取，傳遞 cancellation token，必要時終止隔離 subprocess；terminal transition CAS。外部工具可能已執行副作用，回覆 cancelled 不等於撤銷。client disconnect 與 cancel 分開；定義 disconnect grace 與 agent request ownership。第一版執行仍繫於活躍的 HTTP request，instance/請求中斷時 durable events 可重讀，未完成 run 由 reconciliation 標 interrupted。不要在回傳 response 後靠 background thread 繼續 agent。若要支援長時間離線自主運作，另採 durable execution job + streaming subscriber 並取得 scope 同意。

HITL：盤點既有 interrupt/resume 支援，僅從明確持久化 checkpoint 恢復，校驗原 owner、thread/run、checkpoint 版本、一次性 resume token/operation；同一 resume 不能執行兩次。若 repo 無完整 resume 原語，交付安全 interrupted/unsupported 行為，列為未支援，不以 event replay 假裝恢復執行。

Delegation：將原 loopback/internal listener 改為可經 Cloud Run 單一 ingress port 路由的受保護 internal endpoint。Hermes→Runtime public service 必須應用層驗證 Google service identity/audience 與允許的 principal（不可僅依 Cloud Run IAM，因 Runtime 公開）。Runtime→private Hermes 使用短效 Google ID token 與 invoker role，保留既有 bot authorization、delegation scope 與 correlation IDs；若另有業務 bearer，採明確獨立 header，避免覆蓋 cloud authentication。防止 bot cycle/depth、deadline、同 Bot lease 導致 nested delegation deadlock；驗證 A→B 成功、拒絕未授權、循環和 timeout。不得開放 terminal 任意操作給未受信任的租戶。

## 5. Work package C：Firebase Auth、API 與 Vercel

使用 Firebase Auth 登入（初期 email/password 或 Google sign-in，依環境設定）；runtime Admin SDK 驗證 ID token、issuer/audience/expiration，必要時處理撤銷。uid 透過 server-side membership 映射現有 principal/owner/project，不直接信任 client 宣告 role；新增 Bot、Graph、歷史、run、cancel/replay 等所有路由進行 ACL，防止 IDOR。原 local token/cookie 僅在明確 local mode 保留，production 不允許 fallback。處理 token refresh，避免 URL/query/log 放 bearer。應用層 rate limit、run quota、input size、審計，不把 Origin 當身分驗證。

修改現有 loopback-only Host/Origin gate，使 production 在 `0.0.0.0:$PORT` bind，允許配置的 HTTPS frontend origin，保留 local 行為。CORS 精確 allowlist、OPTIONS、Authorization/Content-Type 與必要 header；不使用 wildcard + credentials。正常 browser 請求推薦 direct HTTPS fetch 至 Runtime，避免 Vercel rewrite 對長 SSE 的額外 timeout；測試現有 CopilotKit/AG-UI client 是否能注入 Firebase bearer 並正確處理 stream。若現有 client 限制必須使用 proxy，先驗證其 timeout、取消與 auth forwarding，記錄取捨，不能臆造套件 API。Vercel 環境只放公開 Firebase client settings、API base URL；不放 LLM key、DB URL、service account key。preview origin 明確 opt-in，不允許任意 *.vercel.app。

現有 workspace 增強最小必要功能：登入/登出、憑證逾期、thread list/history 從授權 server API 恢復（若原先只在頁面內存放，補 server-backed API）、interrupted/reconnect/cancel 顯示、errors。保留現有新增 bot、graph browser、chat UI；不重做設計系統。

## 6. Work package D：GCP deployment artifacts

以 repo 原有 Dockerfile/建置工具為起點，新增/修正 Runtime 與 Worker entrypoint（可共享 image）、Hermes image、cloud build/deploy scripts、環境樣板及 Vercel config。選用一種可重跑部署方式（建議 gcloud scripts + 明確參數，若 repo 已有 IaC 則沿用），不要同時建兩套無人維護的 deployment stack。所有資源名稱、region、project、domain 可參數化；初始 region 可採 asia-east1，實際服務 availability、配額與費用在部署前確認。

### 資源及初始設定（可調整，非容量保證）

| Resource | 初始策略 |
|---|---|
| Cloud Run runtime | 1–2 vCPU、1–2 GiB、concurrency 8、min 0/max 2、request timeout 依 run deadline 測試 |
| Cloud Run hermes | 2 vCPU、4 GiB、初始 concurrency 1、min 0/max 2；確認 subprocess、工具 memory 與 CPU |
| Cloud Run memory-worker | 1–2 vCPU、2 GiB、concurrency 1–2、min 0/max 2；queue deadline 早於/匹配實際 handler 限制 |
| Cloud SQL PostgreSQL | 同 region、backups/PITR、migration role 與 service role 分離；依 pool 與 max instances 算 connection ceiling |
| GCS | 同 region、uniform bucket access、public access prevention、版本/retention/lifecycle 依資料政策 |
| Cloud Tasks / Scheduler | rate limit、retry/backoff、outbox reconciliation；專用 OIDC identity |
| Secret Manager | LLM/OpenRouter keys、DB credentials 等；按 service 最小授權 |
| Artifact Registry / Cloud Build | immutable image tag/commit SHA、可追溯版本、分離 deploy/build/runtime SA |

Cloud Run runtime 對 browser public ingress，應用 Firebase auth；Hermes 和 Worker 不允許 unauthenticated invocation。服務之間依實際 ingress/network 設定可達、使用最小 IAM invoker binding；不要誤將 internal ingress 與 IAM private 視為同一件事。Cloud SQL 採官方 connector/Unix socket + IAM/secret 配置，或經核准的 private network path，禁止直接公開 DB port。ADC 透過 attach SA，避免長期 key。健康檢查不洩漏資料；readiness/startup 設計依 Cloud Run 支援機制，migration 由獨立命令/job 執行一次。設定 graceful SIGTERM 僅作 best effort，可靠性不能依賴 shutdown 時間。

部署 script 順序：檢查專案/billing/API/region→registry/SA/IAM→DB/GCS/Secret→build images→DB migration→部署 runtime/hermes/worker（必要時先設服務 URL 後更新環境，處理雙向 callback bootstrap）→queue/scheduler→Vercel env/build→smoke。實作 dry-run 或顯示資源變更，避免自動刪除 DB/bucket；實際建立付費資源需使用者授權。記錄官方文件及實際執行命令，不能以示意命令冒充已驗證指令。

## 7. 租戶隔離與可靠性安全閘門

多 Bot 邏輯隔離不等於不可信使用者的 OS sandbox。Cloud Run container 可存取自身 service credentials。預設只啟用現有受控 memory/skills 等 allowlisted toolsets；terminal/code execution、任意網路/檔案工具若無安全隔離，僅可信單租戶模式或預設禁用。對不可信多租戶 arbitrary code 需要獨立隔離策略與最低權限（不屬此兩階段默認範圍）。驗證 SSRF/token exposure、path traversal、prompt injection 導致的工具權限提升、跨租戶查詢。Production public exposure 之前必須通過 auth/ACL/IAM/security gate，否則限 private staging。

觀測：structured logs 帶 correlation/run/job IDs、redact secrets/content；metrics 關注 run latency/error、hydration time、DB pool、stream reconnect、job age/retry、LLM token/cost、instance memory。加入 alert 與人工 retry/reconcile runbook。設定備份/PITR、GCS revision retention，測試還原至隔離環境；不要依賴 DB/GCS 跨服務原子備份，透過 manifest/revision 對帳。rolling deploy 使用 backward-compatible schema（expand/contract），rollback image 前確認 schema 相容，不自動刪資料。

## 8. 最終驗收（沿用 Part 1 測試）

| Case | 驗收條件 |
|---|---|
| Cloud restart / scale | 真實 staging GCS/PG；更換 revision/instance 或清空 writable layer，原 bot/session/memory/skills/graph 可讀 |
| Multi-instance | 強制兩個 instance 或兩個獨立 process，same bot lock/fencing、different bot concurrency、取消跨 instance；可驗證 request routing |
| Task delivery | 真 Cloud Tasks OIDC；重送、暫時錯誤、outbox 補送、無重複 graph publication |
| Auth & isolation | 未登入 401、錯 scope 拒絕、token 過期、非允許 origin、private service IAM 拒絕、delegation ACL |
| End-to-end | Vercel 登入→建 Bot A/B→對話→原生 memory/skill fixture→Graph evolution→新 thread 檢索→授權 delegation→reload history |
| Stream | 連續事件、長 run 實測（選一個超過一般 proxy timeout 的受控 fixture）、中途斷線 replay、cancel race、instance kill 後 interrupted |
| Recovery | DB/object restore drill、revision rollback、未發布 object/過期 run 清理；不丟已提交資料 |
| Cost & load | 記錄 cold/warm latency、N 個不同 Bot 並行、DB 連線/記憶體峰值；比較預定資源配置，無憑據不承諾 SLA |

共享 local/cloud contract 與原有 regression suite 在合併前完整執行一次；GCP 無權限時以 integration harness 驗證可用部分，雲端 case 一律標 NOT RUN 和需使用者執行的命令，不可標 PASS。可配置 fake LLM 做 deterministic regression，另做一次授權的 OpenRouter 真實 smoke（有預算限制）。

## 9. 交付清單與停止條件

- Cloud Tasks adapter/worker/reconciler、durable event replay/cancellation、Firebase Auth、IAM service-to-service、frontend 最小整合。
- Docker/build/migration/deploy/smoke scripts、環境樣板、`docs/cloud-run-deployment.md`（從新 GCP project 與 Vercel 開始逐步操作）、rollback/backup/restore/security runbook。
- `docs/cloud-native-part-2-report.md`：git commit、實際變更、服務及 IAM 配置、實測紀錄、部署 URL（只有真部署才填）、成本/限制、PASS/FAIL/NOT RUN、剩餘風險。
- 未經允許不建立付費資源、不變更 DNS、不部署 public production、不提交 secrets。若不能通過資料持久化、跨租戶隔離、auth 或 job 冪等 gate，停止 public 上線並回報；不得用簡化 mock 或停用功能掩蓋失敗。
