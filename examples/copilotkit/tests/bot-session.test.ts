import { expect, test } from "vitest";
import { BotAuthentication } from "../server/bots/auth";
import { createBotApi } from "../server/bots/api";
import type { BotManager } from "../server/bots/manager";

test("logout revokes the server session, expires the cookie and keeps other owners isolated", async () => {
  const auth = new BotAuthentication(["a", "b"].map(id => ({ ownerId: id, principal: id, projectId: "p", token: id })));
  const api = createBotApi({} as BotManager, auth);
  const login = (token: string) => auth.login(new Request("http://local/api/bot-session"), token);
  const cookieA = login("a").headers.get("set-cookie")!.split(";")[0];
  const cookieB = login("b").headers.get("set-cookie")!.split(";")[0];
  const request = (cookie: string, origin = "http://local") => new Request("http://local/api/bot-session", {
    method: "DELETE", headers: { cookie, origin },
  });
  expect((await api(request(cookieA, "http://other"))).status).toBe(403);
  expect(auth.authenticate(request(cookieA))?.ownerId).toBe("a");
  const result = await api(request(cookieA));
  expect(result.status).toBe(204);
  expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(auth.authenticate(request(cookieA))).toBeUndefined();
  expect(auth.authenticate(request(cookieB))?.ownerId).toBe("b");
});
