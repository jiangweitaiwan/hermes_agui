import { defineConfig } from "@playwright/test";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const dynamicDirectory = process.env.DYNAMIC_BOT_TEST === "1" ? mkdtempSync(join(tmpdir(), "hermes-managed-browser-")) : undefined;
const dynamicConfiguration = dynamicDirectory ? join(dynamicDirectory, "bots.json") : "";
if (dynamicDirectory) {
  writeFileSync(dynamicConfiguration, JSON.stringify({ bots: [], management: {
    registryPath: join(dynamicDirectory, "registry.sqlite3"), hostUrl: "http://127.0.0.1:8765",
    hostTokenEnv: "BROWSER_MANAGER_TOKEN", users: [{ ownerId: "browser-owner", principal: "browser-owner",
      projectId: "browser-project", tokenEnv: "BROWSER_USER_TOKEN" }],
    templates: [{ id: "native", name: "Native test model", harness: "hermes", model: "fake-model",
      provider: "custom", skills: [], toolsets: ["memory", "skills"] }],
  } }), { mode: 0o600 });
  process.once("exit", () => rmSync(dynamicDirectory, { recursive: true, force: true }));
}

export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  retries: 0,
  timeout: 360_000,
  expect: { timeout: 120_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: [
    {
      command: `${process.env.HERMES_PYTHON ?? "python"} -m tests.hermes_agui.copilotkit_fixture --port 8765`,
      cwd: resolve("../.."),
      url: "http://127.0.0.1:8765/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: process.env.COPILOTKIT_TEST_PRODUCTION === "1" ? "npm start" : "npm run dev",
      env: { ...(process.env.DYNAMIC_BOT_TEST === "1" ? { AGUI_BOTS_CONFIG: dynamicConfiguration,
        BROWSER_MANAGER_TOKEN: "browser-manager-secret", BROWSER_USER_TOKEN: "browser-owner-secret" } : {}),
        ...(process.env.MULTI_BOT_TEST === "1" ? { AGUI_BOTS_CONFIG: "./bots.test.json", RESEARCHER_TOKEN: "researcher", REVIEWER_TOKEN: "reviewer", DELEGATION_TOKEN: "browser-delegation-only" } : {}), AGUI_URL: "http://127.0.0.1:8765/agent", AGUI_API_KEY: "browser-test-only" },
      url: "http://127.0.0.1:3000",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
