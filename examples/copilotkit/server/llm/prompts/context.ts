import { AsyncLocalStorage } from "node:async_hooks";
export interface PromptSelection { prompt: string; promptVersion: string; editableText?: string }
const context = new AsyncLocalStorage<{tasks:Record<string,unknown>; fingerprint:string}>();
export const promptContext = () => context.getStore();
export function withPromptContext<T>(tasks:Record<string,unknown>, fingerprint:string, run:()=>T):T {
  return context.run({tasks,fingerprint},run);
}
