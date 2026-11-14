# Hermes AG-UI Docker Example

從此目錄複製 `.env.example` 為 `.env`，填入入口 token 及 provider key，
將 `config.yaml` 的 model ID 改成可用模型，執行：

```bash
docker compose up -d --build
curl --fail http://127.0.0.1:8000/health
```

完整建置、CopilotKit 連線、資料備份、工具權限與驗收限制見
[部署說明](../../docs/agui-deployment.md)。此範例使用單 ASGI worker、非 root 程序與持久 volumes。
