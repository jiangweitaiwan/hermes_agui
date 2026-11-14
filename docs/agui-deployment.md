# AG-UI Runtime 部署（Phase 8）

`Dockerfile.agui` 是獨立的 Python HTTP/SSE runtime；啟動原生 headless service，
不啟動 Hermes CLI、Messaging Gateway、ACP、Cron scheduler、dashboard 或 setup wizard。
CopilotKit Node Runtime／UI 仍使用 [既有範例](../examples/copilotkit/README.md)。

## 建置及啟動

需要可執行 Linux containers 的 Docker daemon 及 Compose v2。首次建置需要網路，
PM 依 `pm/lock.json` 取得驗證 hash 的 Python／安裝工具／ripgrep，依 `uv.lock`
安裝 core + `agui` extra；不選擇 `[all]`、messaging、ACP、dev 或 test groups。

```bash
cd examples/agui
cp .env.example .env
# 編輯 .env：設定兩個不同用途的 token；不要提交 .env。
# 編輯 config.yaml：將 model.default 換成帳號可用的模型 ID。
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 hermes-agui
curl --fail http://127.0.0.1:8000/health
```

可直接從 repository root 建置 `docker build -f Dockerfile.agui -t hermes-agui:local .`。
Dockerfile 專用 ignore 檔採允許清單；一般 Dockerfile 的 context 規則保持不變。
Dockerfile 同時使用明確的 COPY 清單，讓未支援專用 ignore 的舊版 builder
也只把 native runtime 放入 image。
映像建置會驗證 native Agent、HTTP server、terminal tool 可匯入，以及 final runtime
SQLite 版本。沿用原 Dockerfile 的 Debian digest 與 SQLite 3.53.4 source/hash，
避免退回發生 WAL-reset 問題的 distro SQLite。

Compose 的 AG-UI port 只映射到 host loopback。`.env` 用於 Compose 的環境代換，
只將 `AGUI_API_KEY` 與 `OPENAI_API_KEY` 傳入 server；不將秘密寫入 image/build args。
`AGUI_PORT` 是 Compose host port，預設 8000。Provider/model/base URL、toolsets 等
行為設定放在 native `config.yaml`，不是新設的 `HERMES_*` 變數。
範例明確設定 `terminal.backend: local` 與 `terminal.cwd: /srv/workspace`：
HTTP `--cwd` 是 Agent workspace，Shell backend 仍以原生 terminal policy 為準。

設定範例使用原生 OpenAI provider。相容 endpoint 可在 `config.yaml` 選擇 `custom`
並設定 `model.base_url`。需要其他 provider SDK 或工具 extras 時，在建置階段明確擴充
PM 的 `--extra` 選擇並重新建置；此 baseline 沒有預裝所有遠端服務或 Browser runtime。
不在 production 啟動時安裝依賴，也不宣稱精簡 core dependency closure 已完成。

## 連接 CopilotKit

在 host 的 `examples/copilotkit` 按既有 README 安裝鎖定依賴及啟動 Node Runtime。
Node 程序使用相同 `AGUI_API_KEY`，`AGUI_URL=http://127.0.0.1:8000/agent`。
瀏覽器只連 Node 的同來源 UI／Runtime，不取得後端 token。
範例 Node server 維持 loopback 與 Host/Origin 檢查；本 Compose 不將它對外發布。
若 Node 在另一容器中，透過相同 Docker network 使用 `http://hermes-agui:8000/agent`，
並自行提供可信 frontend ingress；不可直接把既有 loopback-only Node 範例當公開服務。

可從 host 驗證 SSE（先將 token 安全地加入當前 shell）：

```bash
curl -N --fail http://127.0.0.1:8000/agent \
  -H "Authorization: Bearer $AGUI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"deploy-check","runId":"run-1","state":{},"tools":[],"context":[],"forwardedProps":{},"messages":[{"id":"u1","role":"user","content":"Hello"}]}'
```

成功時收到 `RUN_STARTED`、文字事件與 `RUN_FINISHED`；模型失敗可能在 HTTP 200 的
SSE 內回報 `RUN_ERROR`。Health 只表示 server 存活，不表示 credentials、model 或
特定 tool 已可使用。驗收工具時可請模型在 `/srv/workspace` 建立並讀回一個檔案，
確認 UI tool events 與實際檔案；預設 tool payload 在 UI 遮蔽。

## 資料、權限與生命週期

- `/srv/hermes/profile`：named volume，保存 native session SQLite、AG-UI receipts、
  memory、profile skills 等。`config.yaml` 另外以唯讀 bind mount 提供。
- `/srv/workspace`：獨立 named volume，供原生 shell／file tools 使用；不自動掛載 host repo。
- `HERMES_HOME`、`HERMES_RUNTIME_DIR` 使用既有原生路徑機制。前者是資料 volume；
  後者指向 image 內 root-owned 的 build-time PM tool store。
- 程序以 UID/GID 10000 執行，drop 全部 capabilities、禁止取得新權限，tini 負責轉送
  signals 及回收子程序。首次 named volume 會沿用 image 目錄 ownership；既有 bind mount
  需操作者先授予 UID 10000 適當權限，server 不會在啟動時 root chown 主機目錄。
- Shell tool 是 Agent 的執行能力；精簡映像仍保留 Bash、Git、PM ripgrep 與 Python。
  它可讀取該程序能讀取的檔案及 secrets，也可連出網路。不要掛載 Docker socket、
  host root 或無關秘密；token 授予的是整個可信 profile 的能力。
- 同一 profile 的長期記憶／skills 共用。需要多使用者資料隔離時使用獨立 profile、
  workspace、credentials 及 OS/container 權限；Thread ID 並不提供此隔離。

必須單 process／單 ASGI worker；不可直接橫向擴充共用 profile。
HITL 是 process-local continuation，restart 後不能恢復 Python tool stack。
Compose 給 SIGTERM 兩分鐘的停止時間；合作式取消及 native flush 在 lifespan shutdown
執行，非合作工具可能超時被 Docker 強殺，不能承諾所有副作用都回滾。
等待 interrupt 時也應先完成／取消再部署。詳見 [HITL](agui-human-input.md)。

```bash
docker compose stop
# 保留 volumes 的重建／更新：
docker compose up -d --build
# 移除容器與 network，保留對話及工作檔：
docker compose down
```

不要使用 `down -v`，除非刻意刪除全部持久資料。備份前先停止服務，備份完整 profile
volume 與 workspace，包含 SQLite 伴隨檔；只複製某一個 `.db` 不是可靠的在線備份。

## 排除與保留的依賴

排除 image context：ACP entrypoint、desktop/UI、Node modules、CopilotKit
example、tests、evals、docs、Git metadata、開發環境、個人 `.env`、一般建置 utilities。
只保留 `scripts/bundles/payload.py` 供 build-time resident PM sealing 使用。
root Python modules、agent、provider、tools、原生 config／profile 模組、gateway／tui_gateway helpers、
cron helpers、plugins、skills 與 locales 保留：

- `core/factory.py` 使用 `hermes_cli.config`、runtime provider resolution 與 toolset 選擇。
- `core/service.py` 及原生 loop 使用 `gateway.session_context`；保留目錄不代表啟動 gateway。
- 原生 MCP discovery／delegation 也會動態載入 `tui_gateway.launch_profile_policy`，
  因此保留 Python helpers；沒有啟動 TUI sidecar 或包含 JS UI。
- 原生工具 discovery／approval／memory 使用跨模組 helpers，不能靠資料夾名稱推定可刪除。
- `pyproject.toml` 的 core dependencies 包含 prompt_toolkit、croniter、browser 相關套件；
  只選 `agui` extra 仍會包含它們。此階段沒有擅自改變 upstream 的依賴政策。

下一步的真正 pruning 需對這些 import edges 逐一拆分，再於精簡環境驗證完整 native
capability suite，不能用刪除 Terminal Tool 或停用 Memory／Skills 來讓 build 通過。
目前 image 不提供 Browser、MCP、messaging 或全部 skills 腳本所需的完整外部工具環境。

## 驗證範圍

`tests/hermes_agui/test_runtime_entrypoint.py` 透過真實 `python -m hermes_agui.server`
子程序、loopback model、原生 terminal 與 SQLite 驗證認證、SSE、shell file side effect、
SIGTERM／重新啟動、history 與 receipts 持久化。全部使用 temporary home/workspace。
這是 host process 驗證，不能替代 Linux image build／container permissions 驗收。
容器驗收透過另一個 opt-in integration test，將 stdlib probe 與 loopback fake provider
唯讀掛入 `/probe`，不在 production image 安裝 pytest 或打包 tests：

```bash
docker build -f Dockerfile.agui -t hermes-agui:phase8 .
HERMES_PYTHON=/absolute/path/to/test-env/bin/python \
HERMES_TEST_WORKERS=1 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/test_runtime_container.py -m integration
```

可透過測試專用 `AGUI_TEST_IMAGE` 選擇其他已建置的 image tag。此測試不使用 host secrets，
驗證容器 UID、未打包的非 runtime 目錄、原生 Shell、HTTP/SSE、認證、server restart、
history 及 receipts。測試的 server restart 發生在同一容器內；Compose 的跨容器 volume
生命週期另外由 named volume 配置提供，並未宣稱跨節點或跨程序 HITL checkpoint。
本次實際執行結果見 [Phase 8 report](phase-8-report.md)。
