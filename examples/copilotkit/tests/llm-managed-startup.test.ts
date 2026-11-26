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

test.each([true, false])("deployment startup requires existing control without initialization (writer=%s)", async (runtimeWriter) => {
  const { openControl } = await import("../server/llm/control-bootstrap");
  const { ControlStore } = await import("../server/llm/control-store");
  const { controlFixture } = await import("./fixtures/llm-control");
  const { policy, llm } = controlFixture();
  vi.stubEnv("AGUI_LLM_DATABASE_URL", "postgresql://reader@127.0.0.1:9/control");
  vi.stubEnv("AGUI_LLM_ADMIN_DATABASE_URL", runtimeWriter ? "postgresql://admin@127.0.0.1:9/control" : "");
  vi.spyOn(ControlStore.prototype, "ready").mockResolvedValue(undefined);
  const initialize = vi.spyOn(ControlStore.prototype, "ensureInitialRelease");
  vi.spyOn(ControlStore.prototype, "draft").mockResolvedValue({ config: policy.approved, prompts: null, revision: 1, generation: 1, release_id: "existing" });
  vi.spyOn(ControlStore.prototype, "active").mockRejectedValue(new Error("No active release"));
  try {
    await expect(openControl(policy, llm, runtimeWriter, true)).rejects.toThrow("No active release");
    expect(initialize).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
