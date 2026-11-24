import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/acceptance/llm-control.pg.ts"],
  maxWorkers: 1, testTimeout: 15000, hookTimeout: 30000 } });
