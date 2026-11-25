import { expect, test, vi } from "vitest";
import { bootstrap } from "../server/bootstrap";

test("legacy static startup needs neither registry nor control database", async () => {
  vi.stubEnv("AGUI_STORAGE_BACKEND", "local");
  vi.stubEnv("AGUI_API_KEY", "static-fixture-token");
  vi.stubEnv("AGUI_LLM_DATABASE_URL", "postgresql://unavailable@127.0.0.1:9/unavailable");
  vi.stubEnv("AGUI_LLM_ADMIN_DATABASE_URL", "postgresql://unavailable@127.0.0.1:9/unavailable");
  try {
    const instance = await bootstrap(undefined, { evolutionTimer: false });
    try {
      await instance.application.ready;
      expect(instance.releases).toBeUndefined();
      expect(instance.adminStore).toBeUndefined();
      expect(instance.settings.hermes.token).toBe("static-fixture-token");
    } finally { await instance.application.close(); await instance.wiki?.close(); await instance.threadMappings?.close(); }
  } finally { vi.unstubAllEnvs(); }
});
