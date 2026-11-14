# 第一次執行｜單伺服器雙 Bot 與 CopilotKit UI

使用者已驗證 Hermes AG-UI、Node Runtime 和 Web UI，從目前 checkout 推進。先記錄 git 狀態並核對相關入口，沿用既有啟動設定和測試 fixtures。

這次只完成下列兩個里程碑。兩個 Bot 各自可被呼叫且驗收通過後，交付交接紀錄並結束此次 Codex 對話。

## 3. 里程碑 A — 單一 Python 程序承載多 Bot

## 4. 里程碑 B — CopilotKit 路由與 Web UI



## 部署與交接

更新雙 Bot 設定範例與啟動文件，讓一個 Python host 搭配一個 Node Runtime 可重現。記錄各 Bot 的 endpoint、設定及 volume。用既有 fake provider 跑 Python、Node 和瀏覽器回歸，列出測試命令、結果與未執行項目。

在 repo 內留下 `docs/multi-bot-handoff.md`，控制在一頁左右，包含：

- 第一輪交付的 branch/commit（有 commit 時）、變更入口和啟動命令。
- Bot、principal、Thread、Run 的命名空間及取消／resume 路由。
- Node agent 註冊、可信 Bot 身分來源、Python Service 建構及並發上限的檔案與符號。
- 驗收結果、未完成項目，以及第二輪需要保留的相容性行為。
