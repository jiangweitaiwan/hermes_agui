import { expect, test } from "@playwright/test";

test.skip(!process.env.VITE_RUNTIME_URL, "Cloud frontend configuration required");
test("cloud login refreshes bearer for direct Runtime requests and logout clears access", async ({ page }) => {
  const headers: string[] = [];
  let refreshes = 0;
  await page.route("**/*", route => ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  const cors = { "Access-Control-Allow-Origin": "http://127.0.0.1:3000",
    "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
  await page.route("https://identitytoolkit.googleapis.com/**", route => route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 204, headers: cors })
    : route.fulfill({ headers: cors, json: {
      idToken: "expired-soon", refreshToken: "browser-only-refresh", expiresIn: "1",
    } }));
  await page.route("https://securetoken.googleapis.com/**", route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    refreshes++;
    expect(route.request().postData()).toContain("refresh_token=browser-only-refresh");
    return route.fulfill({ headers: cors, json: { id_token: "refreshed-local-token", refresh_token: "rotated-refresh", expires_in: "3600" } });
  });
  await page.route(`${process.env.VITE_RUNTIME_URL}/api/**`, async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    headers.push(route.request().headers().authorization ?? "");
    await route.fulfill({ json: [], headers: cors });
  });
  await page.goto("/");
  await page.getByLabel("Email").fill("local@example.test");
  await page.getByLabel("密碼").fill("local-test-only");
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await expect(page.getByText("尚無 Bot，請新增第一個 Bot。")).toBeVisible();
  expect(refreshes).toBe(1);
  expect(headers.length).toBeGreaterThan(0);
  expect(headers.every(value => value === "Bearer refreshed-local-token")).toBe(true);
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  const count = headers.length;
  expect(await page.evaluate(async () => {
    try { await fetch("/api/bots"); return false; } catch { return true; }
  })).toBe(true);
  expect(headers).toHaveLength(count);
});
