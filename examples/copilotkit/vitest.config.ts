import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/*.test.ts"], env: {
  COPILOTKIT_TELEMETRY_DISABLED: "true", DO_NOT_TRACK: "1",
} } });
