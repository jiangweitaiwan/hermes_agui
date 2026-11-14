import { AgentRunner, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import type { AgentRunnerRunRequest, AgentRunnerConnectRequest, AgentRunnerStopRequest,
  AgentRunnerIsRunningRequest, LocalThreadEndpointScope } from "@copilotkit/runtime/v2";
import type { BaseEvent } from "@ag-ui/core";
import { map } from "rxjs";

/** SDK stores are process-global, even across separate runner instances. */
export class BotRunner extends AgentRunner {
  private readonly runner = new InMemoryAgentRunner({ maxThreads: 128, maxRunsPerThread: 64, maxBytes: 16 * 1024 * 1024 });
  constructor(private readonly botId: string) { super(); }
  private key(threadId: string) { return JSON.stringify([this.botId, threadId]); }
  private external(event: BaseEvent, threadId: string): BaseEvent {
    return "threadId" in event ? { ...event, threadId } : event;
  }
  run(request: AgentRunnerRunRequest) {
    return this.runner.run({ ...request, threadId: this.key(request.threadId) }).pipe(
      map(event => this.external(event, request.threadId)));
  }
  connect(request: AgentRunnerConnectRequest) {
    return this.runner.connect({ ...request, threadId: this.key(request.threadId) }).pipe(
      map(event => this.external(event, request.threadId)));
  }
  isThreadAccessible(threadId: string, scope: LocalThreadEndpointScope) {
    return this.runner.isThreadAccessible(this.key(threadId), scope);
  }
  stop(request: AgentRunnerStopRequest) {
    return this.runner.stop({ ...request, threadId: this.key(request.threadId) });
  }
  isRunning(request: AgentRunnerIsRunningRequest) {
    return this.runner.isRunning({ ...request, threadId: this.key(request.threadId) });
  }
}
