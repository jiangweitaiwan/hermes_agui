# Phase 8：獨立 Runtime Packaging 與非必要元件排除

## Implementation Summary

基準 commit：`4697e79f630c`。依計畫第 10 節優先交付獨立 AG-UI runtime，
並一併補齊第 12 節的 Dockerfile、Compose、環境範例與部署說明。

- 新增 multi-stage `Dockerfile.agui`，只啟動單一 Python HTTP/SSE host；不啟動 CLI、
  Gateway、ACP、TUI sidecar、Cron scheduler、dashboard 或 setup wizard。
- 明確的 COPY 允許清單排除 desktop／web／UI、tests、evals、docs、examples、Git 與
  開發環境；另提供 Dockerfile 專用 ignore 檔供支援它的 builder 精簡 context。
- 透過既有 PM 取得 hash 驗證的 Python／ripgrep 與 resident manager runtime，
  從既有 `uv.lock` 安裝 core + `agui`；不選 `[all]`、messaging、ACP、dev 或 test groups。
- 保留 Bash、Git、原生 Terminal Tool、Tools／Memory／Skills／Session／Context。
  映像以 UID/GID 10000 執行；tini 處理 signals，Compose drop capabilities、禁止新權限，
  只映射 loopback port，profile／workspace 使用持久 volumes。
- 沿用原 Dockerfile 固定的 Debian digest、SQLite 3.53.4 source 與 SHA256，
  build-time 檢查 native imports 及 final runtime SQLite，不退回舊版 distro SQLite。
- 沒有刪除 repository 原始碼、修改原生 loop／tool dispatch、增加 Python 依賴、
  改動 prompt／tools surface 或變動 `pyproject.toml`／`uv.lock`。

本階段完成的是 runtime 排除與部署封裝；不宣稱已拆解 upstream core dependency closure。

## Files Changed

新增：

- `Dockerfile.agui`、`Dockerfile.agui.dockerignore`。
- `examples/agui/compose.yaml`、`.env.example`、`config.yaml`、`README.md`。
- `tests/hermes_agui/test_runtime_entrypoint.py`：真實 server 子程序驗收。
- `tests/hermes_agui/test_runtime_container.py`：opt-in、針對已建置 image 的驗收。
- `tests/hermes_agui/container_probe.py`：容器內 stdlib probe，唯讀掛入測試用 fake provider。
- `docs/agui-deployment.md`、本報告。

修改：

- `.gitignore`：允許追蹤獨立 `examples/agui/`，實際 `.env` 仍保持忽略。
- `docs/agui-server.md`、`docs/agui-architecture.md`：連結獨立 runtime 部署說明。

沒有刪除檔案。

## Architecture Notes

### 依賴確認與排除策略

原生 core factory 使用 `hermes_cli.config`／provider resolution／toolset configuration；
service 使用 `gateway.session_context`；MCP discovery／delegation 會動態載入
`tui_gateway.launch_profile_policy`。因此保留這些 Python helpers 及原生 plugin／cron
依賴，不以「沒有啟動 UI」推定整個目錄可刪除。未打包 ACP entrypoint、UI build inputs
及 Node runtime，但沒有改寫 native provider／tool discovery 或重建另一套 memory。

`pyproject.toml` 的 core dependencies 仍包含 prompt_toolkit、croniter 及 browser 相關
套件。只選 `agui` extra 並不會移除這些 core dependencies；真正 pruning 需另行拆開
import edges 並以原生能力契約驗證。Browser、MCP、非 OpenAI SDK 與完整 skills 外部
腳本環境並未全部預裝，操作者需明確增加所需 extras／工具並重新建置。

### 驗收中確認的兩個行為

本機 Docker Engine 24.0.5 的 builder 沒有採用專用 ignore 檔，首輪實際載入的是一般
`.dockerignore`。因此增加明確 COPY 清單，再重新建置及驗證 image 中沒有非 runtime
目錄；不只依賴 ignore 的文字內容。一般 Dockerfile 的打包行為沒有改動。

原生 Shell policy 的預設 cwd 是 OS home；HTTP `--cwd` 不會取代 `terminal.cwd`。
新增測試的初版正確取得 tool success，但 marker 不在預期 workspace。
確認 native scope 實作後，改由測試與部署範例明確設定原生 `terminal.cwd`，未改變核心
語意或略過工具執行驗收。該輪測試產生的單一 marker 已核對內容並清除。

### 部署界線

維持單一 ASGI worker；HITL continuation 是 process-local，不能跨 restart 恢復。
Thread history 隔離不等於 profile memory／skills 或 OS 權限隔離。認證 token 可使用
該可信 profile 的工具與秘密；Compose 沒有掛載 host root、Docker socket 或主機 repo。
取消仍是合作式；停止逾時可被 Docker 強殺，不能保證非合作工具無副作用。

## Tests

Python 使用前階段的獨立 test environment；所有模型 transport 均為 loopback fake，
不使用個人 profile 或真實 provider credentials，不消耗付費模型 token。

```bash
HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=3 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/

docker build -f Dockerfile.agui -t hermes-agui:phase8 .

HERMES_PYTHON=/private/tmp/hermes-agui-phase2-env/bin/python \
HERMES_TEST_WORKERS=1 HERMES_TEST_FILE_RETRIES=0 \
scripts/run_tests.sh tests/hermes_agui/test_runtime_container.py -m integration

AGUI_API_KEY=validation-only OPENAI_API_KEY=validation-only \
docker compose -f examples/agui/compose.yaml config --quiet

.venv/bin/python scripts/check --only ruff,health --base HEAD
.venv/bin/python scripts/check --base HEAD
git diff --check
```

- 完整 AG-UI 回歸：**15 files、59 passed、0 failed**，141.4 秒；
  Docker integration 契約預設由 marker 排除，另外明確執行並通過。
- 新增 host process 契約單獨重跑：**2 passed、0 failed**，75.1 秒。
- Docker image：Linux/amd64 multi-stage build 成功；映像另保留原始 `LICENSE`。
- 容器驗收：**1 passed、0 failed**，90.6 秒。驗證 UID 10000、未打包的非 runtime
  目錄、native Shell 真正建立檔案、HTTP 認證、AG-UI tool events、server SIGTERM／
  restart、history 與 replay receipts。沒有在 image 安裝 pytest 或打包 tests；
  只唯讀掛載兩個 probe 檔案。
- Compose 設定檢查通過。沒有使用真實 API key 啟動 Compose 的模型對話；
  容器契約使用同一 image 的真實 HTTP server 及 loopback provider。
- Ruff／code health：**3 measured files、0 blocking、0 advisory**；diff whitespace 通過。
- 完整 check：**17 項中 11 項通過、6 項因既有缺檔無法執行**：
  `check_os_marker_fakes.py`、`check_agents_md_size.py`、`check_line_endings.py`、
  `check_lazy_deps_imports.py`、`check_profile_archive_boundary.py`、`check_blob_size.py`。
  沒有略過規則或宣稱完整 CI 綠燈。

初輪完整回歸是 58 passed／1 failed，失敗為上述 cwd 測試假設；修正後單獨重跑通過，
並重新執行完整回歸。sandbox 曾阻擋 runner／Docker socket；取得本機執行權限後重跑。
Docker Desktop 起初未啟動，已開啟並完成實際建置與容器驗收，不再以 daemon 缺席作為
未驗收的理由。只驗證本機 Linux/amd64 image，未實測 ARM64。

CopilotKit TypeScript／UI 未變更，未重跑其 production browser suite；既有 Phase 5／7
證據仍見各階段報告。本階段新增的是 Python runtime 與容器邊界驗收，尚未將兩者整合成
完整 Docker Compose frontend E2E pipeline。容器測試的 restart 發生於同一容器內，
未宣稱已動態驗證跨容器 named-volume restore 或跨程序 HITL checkpoint。

## Next Step

依原計畫 Phase 0–8 的順序，此階段之後沒有另一個編號 phase。
後續可進行最終 MVP 部署驗收：以實際 provider configuration 將 CopilotKit Node Runtime
接到此 Docker endpoint，驗證 UI 的 streaming／tool／thread／error／HITL 全流程，
以及在指定部署主機演練 volume 備份還原。

真正的 dependency pruning、ARM64 build、跨容器資料還原及跨重啟 HITL checkpoint
是明確的後續範圍，不能靠重新執行有副作用的工具代替恢復。
