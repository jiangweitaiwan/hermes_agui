import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DelegationCoordinator } from "./delegation";

export function createDelegationServer(coordinator: DelegationCoordinator) {
  return createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/internal/delegations" || req.headers.origin) {
      res.writeHead(404).end(); return;
    }
    void handle(req, res, coordinator).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}
async function handle(req: IncomingMessage, res: ServerResponse, coordinator: DelegationCoordinator) {
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  req.setEncoding("utf8");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 20_000) { res.writeHead(413).end(); return; }
  }
  const response = await coordinator.handle(new Request("http://internal/internal/delegations", {
    method: "POST", body, headers: { authorization: req.headers.authorization ?? "" }, signal: controller.signal,
  }));
  res.writeHead(response.status, { "Content-Type": "application/json" }).end(await response.text());
}
