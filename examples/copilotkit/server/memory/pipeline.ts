import type { RunAgentInput } from "@ag-ui/core";
import type { RuntimeSettings } from "../runtime";
import type { RuntimeMemoryMiddleware } from "./middleware";

/** Common path for interactive and delegated runs; identity always comes from the target. */
export async function prepareRunInput(botId: string, settings: RuntimeSettings,
  input: RunAgentInput, middleware?: RuntimeMemoryMiddleware): Promise<RunAgentInput> {
  const { __copilotkitRequestId: _requestId, ...forwardedProps } = input.forwardedProps ?? {};
  if (!settings.memory || input.resume?.length) return { ...input, forwardedProps };
  if (Object.keys(forwardedProps).length) throw new Error("Frontend forwardedProps are unsupported");
  if (!middleware) throw new Error("Memory middleware missing");
  const last = input.messages.at(-1);
  if (last?.role !== "user" || typeof last.content !== "string") throw new Error("Memory requires terminal text user input");
  const runtimeMemory = await middleware.prepare(botId, settings.memory, input.threadId, input.runId, last.content);
  return { ...input, forwardedProps: { runtimeMemory } };
}
