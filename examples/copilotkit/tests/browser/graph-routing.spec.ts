import { expect, test } from "@playwright/test";

test("Graph routes return unavailable JSON rather than the workspace SPA", async ({ request }) => {
  const response = await request.get("/api/graph/hermes/pages");
  expect(response.status()).toBe(process.env.DYNAMIC_BOT_TEST === "1" ? 401 : 503);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.text()).not.toContain("<!doctype html>");
  const root = await request.get("/api/graph");
  expect(root.headers()["content-type"]).toContain("application/json");
});

test("Graph route retains local Host and Origin guards", async ({ request }) => {
  const origin = await request.get("/api/graph/hermes/pages", { headers: { Origin: "https://other.example" } });
  expect(origin.status()).toBe(403);
  const host = await request.get("/api/graph/hermes/pages", { headers: { Host: "other.example" } });
  expect(host.status()).toBe(403);
});
