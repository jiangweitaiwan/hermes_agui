# 第二次執行｜跨 Bot 委派與 Graph 記憶接口

適用專案 [jiangweitaiwan/hermes_agui](https://github.com/jiangweitaiwan/hermes_agui)

從第一次交付所在的 checkout 開新 Codex 對話。優先讀 `docs/multi-bot-handoff.md`，重用其中的雙 Bot 啟動方式與測試。第一輪交付前提為一個 Python AG-UI host、每 Bot 一個 `HermesAgentService`、兩個隔離的 profile/workspace，以及可以獨立操作兩個 Bot 的 CopilotKit UI。若前提缺漏，指出具體缺項再處理相依工作。

本輪交付有時限的跨 Bot 委派與可插拔 graph 記憶接口。跨重啟委派、背景排程、分散式 worker 與 graph 記憶實體系統留待後續。

## 5. 里程碑 C — Bot 互相委派

## 6. 里程碑 D — CopilotKit 開放 graph 記憶接口



## 最終驗收與交付

使用第一輪部署設定，驗證雙 Bot 各自接單、委派子 Run 結果回到原任務，以及 GraphMemoryPort 的契約測試。跑受影響的 Python、Node 和 UI 回歸。更新部署／接口文件，列出變更、測試結果和後續 graph provider 接入點。測試替身與實際 provider 結果分別記錄。
