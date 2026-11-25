import { createHmac } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/core";
import type { RuntimeSettings } from "../runtime";
import { ControlError } from "./control-contract";
import type { ControlStore } from "./control-store";
import { withRelease } from "./execution-release";

export interface ManagedRunBinding { principal: string; harness: "hermes" | "remote_ag_ui" }
export type PrepareManagedRun = (id: string, settings: RuntimeSettings, input: RunAgentInput,
  prepare: (input: RunAgentInput) => Promise<RunAgentInput>, binding?: ManagedRunBinding) => Promise<RunAgentInput>;
export function managedRunPreparation(store: ControlStore): PrepareManagedRun {
  return async (id, settings, input, prepare, binding) => {
    const props = input.forwardedProps ?? {};
    if (Object.keys(props).some(key => key !== "__copilotkitRequestId")) throw new ControlError(422, "Browser routing metadata denied");
    const native = !binding || binding.harness === "hermes";
    if (native && !settings.memory) throw new ControlError(503, "Managed run requires trusted Bot signing settings");
    if (native && input.resume?.length) throw new ControlError(409, "Managed checkpoint resume requires the original persisted run");
    const release = await store.pinRun(binding?.principal ?? settings.memory!.principal, id, input.threadId, input.runId, binding?.harness);
    return withRelease(release, async () => {
      const prepared = await prepare({ ...input, forwardedProps: {} });
      if (!native) return prepared;
      const payload = Buffer.from(JSON.stringify({ version: 1, scope: store.policy.scope, botId: id,
        principal: settings.memory!.principal, projectId: settings.memory!.projectId,
        threadId: input.threadId, runId: input.runId, releaseId: release.release_id,
        releaseFingerprint: release.release_fingerprint, expires: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
      const signature = createHmac("sha256", settings.memory!.key).update(payload).digest("hex");
      return { ...prepared, forwardedProps: { ...prepared.forwardedProps, llmRelease: { payload, signature } } };
    });
  };
}
