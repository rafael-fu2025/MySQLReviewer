import { AsyncLocalStorage } from 'node:async_hooks';

interface RuntimeIdentity {
  userId: string | null;
}

const runtimeIdentity = new AsyncLocalStorage<RuntimeIdentity>();

/** Runs one request branch with the account that owns its runtime work. */
export function runWithRuntimeUser<T>(userId: string | null, fn: () => T): T {
  return runtimeIdentity.run({ userId }, fn);
}

/** Account owning the current async request branch, when one is authenticated. */
export function currentRuntimeUserId(): string | null {
  return runtimeIdentity.getStore()?.userId ?? null;
}
