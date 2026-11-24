import { AsyncLocalStorage } from "node:async_hooks";
import type { Release } from "./control-store";
const context = new AsyncLocalStorage<Release>();
export const executionRelease = () => context.getStore();
export function withRelease<T>(release: Release, run: () => T): T { return context.run(release, run); }
