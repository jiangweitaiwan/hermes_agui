import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DelegationCoordinator } from "./delegation";

export interface InternalRoute {
  maxBytes: number;
  handle: (request: Request) => Promise<Response>;
}

export function createInternalServer(routes: ReadonlyMap<string, InternalRoute>) {
  return createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (req.method !== "POST" || !route || req.headers.origin) {
      res.writeHead(404).end(); return;
    }
    void handle(req, res, route).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}
export function createDelegationServer(coordinator: Pick<DelegationCoordinator, "handle">) {
  return createInternalServer(new Map([
    ["/internal/delegations", { maxBytes: 20_000, handle: request => coordinator.handle(request) }],
  ]));
}
async function handle(req: IncomingMessage, res: ServerResponse, route: InternalRoute) {
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  req.setEncoding("utf8");
  let bytes = 0;
  const chunks: string[] = [];
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > route.maxBytes) { res.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  const response = await route.handle(new Request(`http://internal${req.url}`, {
    method: "POST", body: chunks.join(""), headers: { authorization: req.headers.authorization ?? "" }, signal: controller.signal,
  }));
  res.writeHead(response.status, { "Content-Type": "application/json" }).end(await response.text());
}
