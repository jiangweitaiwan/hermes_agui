# Graph Memory Part 1 進度報告

日期：2026-11-17。範圍：僅 `GRAPH_MEMORY_PART_1.md`。Part 1 實作與相關測試／回歸已完成；根目錄工具的既有阻礙另列。未執行 Part 2 / Part 3，未 commit、push。

## Checkout 與架構確認

- 起始 branch：`main`；commit：`d7440843bcd4b2055c0aae0ebf06178aad64ee5d`；起始 `git status --short` 為空。
- 已讀 `docs/GRAPH_MEMORY_IMPLEMENTATION_PLAN.md`、`docs/GRAPH_MEMORY_PART_1.md` 與提供的根目錄開發規範。`examples/copilotkit` 及其 server/tests 無額外適用的 AGENTS.md；另參考 `tests/AGENTS.md`、`pm/AGENTS.md` 的測試與依賴規範。
- 計畫要求的 `IMPLEMENTATION_PLAN.md`、`docs/runtime-memory-part-1.md`、`docs/runtime-memory-bot-manager-part-2.md` 不存在於此 checkout，不能據此宣稱已閱讀。README 原本也有指向缺失文件的連結；未擴大範圍重構。
- 現有入口為 `examples/copilotkit/server/index.ts`、`application.ts`；普通及 delegated Run 共用 `prepareRunInput` → middleware → manager/retriever → `GraphMemoryPort`。最後一筆 user text 用於查詢，resume 跳過，HMAC envelope 放入 forwardedProps。
- `graph-memory.ts` 限制 trusted scope、2000ms 預設 timeout、50 hits、每筆 content 16384 bytes；assembler 保留 20 筆／4096 UTF-8 JSON bytes。Hermes 原生 system prompt/session SQLite/memory/skills/agent loop 未修改。
- 現有 Bot registry 使用 `node:sqlite` 的 `DatabaseSync`，本次沿用；實測 FTS5 可用。現有 provider 輸入接線確實會替換基礎 authorize；已檢查相關 git history，並以 base 失敗的行為測試確認。

## 實作結果

1. **儲存與發布**：schema v1 記錄 namespaces、pages、immutable revisions（含 hash/路徑）、active pointers、edges、FTS sections。安全 opaque namespace hash 分隔 principal/project/visibility/private bot。所有發布以 SQLite `BEGIN IMMEDIATE` 序列化，逐頁檢查 expected revision CAS；Markdown 驗證、fsync、原子 rename 後，單一 SQLite transaction 發布 pointers/indexes。失敗留下的檔案不會被查詢；cleanup 在 writer lock 下移除無引用 revision 檔案。保留已提交歷史 revision。
2. **解析與索引**：新增有 major 上限的 `yaml` 依賴，safe core schema、禁 aliases/custom tags、strict Zod frontmatter。解析正文 wikilinks 與 related、支援顯示 alias；slug 只接受文字／數字／底線／連字號。跨 namespace/path link 不會產生可擴展 edge；broken targets 不參與擴展；cycles 僅走一階。FTS5 使用英文詞與繁中 CJK bigrams，不在 request path 全庫掃描 Markdown。
3. **檢索**：在已授權的 private/shared namespace 取 8 個 lexical seed paragraphs，每 seed 最多 3 個 outgoing neighbors。鄰居仍需 lexical 命中，依覆蓋詞數、neighbor discount、hub degree penalty 排序，再以 namespace/page/段落序穩定決勝。去重且按段落回傳；最多 50 hits、64 KiB provider JSON、16 KiB 單段；沿用 assembler 20／4096 限制。支援 AbortSignal／elapsed deadline，無生成 API 或外部服務呼叫。
4. **接線與授權**：`WikiGraphProvider implements GraphMemoryPort`，write 固定 disabled。`index.ts` 從既有 server JSON registry 的 graph 區塊啟用 provider，並於 shutdown 關閉。預設停用時不建立 store/DB；store unavailable fail soft，ACL rejected fail closed。自訂 authorize 必須與基礎 Bot/principal/project 授權同時成立，無法由 frontend forwardedProps 或 Markdown 自述決定 ACL。保留 FakeGraphProvider 與既有測試。
5. **管理與文件**：可信本地 CLI 支援 manifest import、reindex、唯讀 aggregate diagnose、cleanup；無新增 HTTP/model tool。manifest 明確指定 namespace、session source 與每頁 expectedRevision。seed dataset 對應整合測試實際完成的 local stub session。README 補上設定、匯入、重建、備份恢復、schema/version、來源限制與下一階段邊界。

## 變更檔案

- `examples/copilotkit/server/graph/types.ts`：namespace/frontmatter/manifest schema 與 options。
- `examples/copilotkit/server/graph/markdown.ts`：YAML、段落／links、CJK tokenization。
- `examples/copilotkit/server/graph/wiki-store.ts`：SQLite schema、revision store、CAS publication、reindex/cleanup。
- `examples/copilotkit/server/graph/retriever.ts`：scope FTS、bounded 一階 expansion、relevance 排序。
- `examples/copilotkit/server/graph/provider.ts`：GraphMemoryPort adapter、feature loading/failure/lifecycle。
- `examples/copilotkit/server/graph/diagnostics.ts`、`cli.ts`：唯讀診斷與本地管理 CLI。
- `examples/copilotkit/server/application.ts`、`index.ts`：不可繞過授權、production wiring/shutdown。
- `examples/copilotkit/fixtures/wiki/{manifest.json,database.md}`：local stub seed dataset。
- `examples/copilotkit/tests/wiki-graph.test.ts`、`wiki-runtime.test.ts`：新增驗證。
- `examples/copilotkit/tests/graph-memory.test.ts`：原注入 provider 測試改用合法 local-owner identity，保留原有 provider 能力驗證。
- `examples/copilotkit/package.json`、`package-lock.json`：YAML parser 依賴與 npm 產生的 lock 更新。
- `examples/copilotkit/README.md`、本報告。

## 測試環境與結果

原 shell 無 node/npm；暫存下載 Node 22.18.0 darwin-x64，未改使用者全域環境。以下 Node 命令於 `examples/copilotkit` 執行；需將該 Node bin 加入 PATH。測試不依賴付費 API。sandbox 最初禁止 localhost bind/tsx IPC；HTTP stub 測試在允許 localhost 的執行環境重跑。

| 驗證 | 指令 | 結果 |
| --- | --- | --- |
| 修改前 Node baseline | `npm test -- --reporter=dot` | 5 files / 21 tests 全通過；sandbox 失敗的 10 個 listen EPERM 已在正常 localhost 環境排除 |
| Base 授權回歸證明 | 原始 HEAD application 配合 `npm test -- tests/wiki-graph.test.ts -t 'custom policy'` | 按預期紅燈：偽造 principal 應 rejected 卻得到 disabled；已恢復本次實作 |
| 最終 Node 回歸 | `npm test -- --reporter=dot` | 7 files / 30 tests 全通過 |
| TypeScript | `./node_modules/.bin/tsc --noEmit` | 通過 |
| Production build | `npm run build` | 通過；Vite 既有大型 chunks warning，未更動 frontend |
| CLI smoke | `node --import tsx server/graph/cli.ts import DATA_ROOT fixtures/wiki/manifest.json`，再執行 `reindex`、`diagnose`、`cleanup` | 全成功；diagnose 僅輸出 schema/counts（1 namespace、1 page、1 revision、2 sections、0 edges） |
| 文件路徑規則 | `.venv/bin/python scripts/check_no_tmp_literals.py examples/copilotkit/README.md` | 通過 |
| whitespace | `git diff --check` | 通過 |

新增測試覆蓋英文／繁中、段落、無命中、alias/broken/cycle/cross-scope links、同名不同 scope、穩定排序、超出 seeds 的一階鄰居、弱關聯排除、Bot A/B private/shared 與 owner/project 隔離、schema/path/symlink/偽造 scope/非法 bot、namespace limits、abort/timeout/disabled/unavailable、write disabled、輸出預算、CAS/重啟/重建、未提交版本不可見、發布回滾與 orphan cleanup。

`wiki-runtime.test.ts` 先完成 source stub Run，再以其實際 thread/run ID 匯入 wiki；普通和 delegated Run 都經真正 CopilotKit runtime/application 接到 HTTP AG-UI stub。驗證 signed context 含 wiki paragraph、HMAC 與目標 run identity 一致、原始 messages 不變且不含注入文字。

Python 原測試環境初次無法收集（缺少 `ag_ui`），未把零收集視為通過。以 PM 建立完整隔離環境後重跑，未以 raw pip/uv 修改既有環境：

```bash
SSL_CERT_FILE=/etc/ssl/cert.pem \
HERMES_HOME=/private/tmp/hermes-graph-test-home \
HERMES_RUNTIME_DIR=/private/tmp/hermes-graph-runtime \
.venv/bin/python -m pm.build_env --source . \
  --out /private/tmp/hermes-graph-test-env --python "$PWD/.venv/bin/python" \
  --group dev --group test --extra agui

HERMES_HOME=/private/tmp/hermes-graph-test-home \
HERMES_RUNTIME_DIR=/private/tmp/hermes-graph-runtime \
HERMES_PYTHON=/private/tmp/hermes-graph-test-env/bin/python \
scripts/run_tests.sh tests/hermes_agui/
```

上述是本機實際使用的暫存路徑；重現時選擇自己的全新隔離輸出。Node PATH 同樣需存在；HTTP stub 及 runner 子程序需允許 localhost/process 啟動。原先 Python CA 路徑缺失，改用系統可信 CA 解決；完整環境建立曾等待 cryptography source build，最終成功。

原生 AG-UI 回歸最終結果：**21 files / 78 tests passed / 0 failed**，197.0 秒。包含既有真正 Hermes native provider 的 Runtime Memory 驗簽、注入與 session 不污染測試。

### 根目錄檢查的既有阻礙

`.venv/bin/python scripts/check` 無法全通過：checkout 缺少 `scripts/ci/check_os_marker_fakes.py`、`check_agents_md_size.py`、`check_line_endings.py`、`check_lazy_deps_imports.py`、`check_profile_archive_boundary.py`、`check_blob_size.py`。補上 Node PATH 後單獨 `scripts/check --only health` 仍因不存在的根目錄 `package.json` 失敗。新增 README 的 no-tmp finding 已修正並獨立驗證通過。未替此 Part 新增無關工具／根 package 來掩蓋問題；不能宣稱全專案所有檢查已通過。

自動審查曾拒絕從 HEAD 重建 package manifests 的整理命令，理由為可能抹除未提交修改；未執行該命令，保留 npm 輸出的依賴變更，沒有繞過審查。

## 設定與限制

設定位置為現有 `AGUI_BOTS_CONFIG` JSON 的 `graph`：`enabled` 預設 false；啟用需 `dataRoot`；`timeoutMs` 預設 2000（1–30000）；`maxPages` 預設 1000（1–10000，每 namespace）；`maxPageBytes` 預設 262144（最多 1048576）；每頁最多 128 paragraphs。Bot 仍需現有 memory signing key/principal/project 設定。完整命令與 manifest/frontmatter 範例見 README/fixtures。

- 本階段保持 GraphHit/MemoryContext v1，僅允許一個真實 session source；多來源頁／document provenance 會拒絕，未捏造外部文件 run ID。CLI 由可信管理員 attest 來源，未跨服務讀取 Hermes session DB 查驗來源是否存在。
- SQLite manifest 與 Markdown 是共同恢復所需資料。跨資源不是天然原子交易：先持久化 immutable file，再發布 SQLite pointer；失敗後依 committed manifest 清理 orphan。重建以原始 Markdown＋committed revisions 為準。
- 全域 SQLite writer lock 比 per-namespace serialization 更嚴格；Part 1 以小型本地 store 為目標，尚無大型效能壓測。
- `DatabaseSync` 的查詢／讀檔是同步工作，timeout/abort 是 bounded operations 間的合作式檢查，會丟棄逾時結果，並非能中斷每一條 SQL 的硬即時保證。
- 資料目錄由可信本地管理員持有；拒絕 symlinks/path traversal，不承諾抵抗具有同目錄寫入權限的惡意本地程序同時替換 filesystem。備份時停止服務及匯入，整個 data root 一起備份／恢復。
- 未新增刪除／撤銷 API、GUI、ingest queue、compiler、session observer、embedding、hybrid/vector search；未改既有信任模型、system prompt 或 session history。

## 下一階段銜接

後續 Part 2 可沿用 store/CAS/manifest/FTS/retriever，在另行指示後加入 document discriminated provenance、durable ingest queue 與 compiler；多來源／文件資料須先設計相容的 provenance bridge，不能降級成假 session。Part 3 自動 session 學習與 embedding 尚未開始。本次完成後停止等待指示。
