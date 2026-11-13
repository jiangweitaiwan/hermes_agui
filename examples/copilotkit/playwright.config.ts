import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

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
      env: { AGUI_URL: "http://127.0.0.1:8765/agent", AGUI_API_KEY: "browser-test-only" },
      url: "http://127.0.0.1:3000",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
