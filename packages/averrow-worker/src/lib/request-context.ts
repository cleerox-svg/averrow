// Averrow — request-scoped ExecutionContext (AsyncLocalStorage).
//
// The fetch entrypoint (src/index.ts) runs every request inside
// `runWithRequestContext(ctx, …)`, so code deep in the call tree — e.g.
// `requireAuth`, which takes only (request, env) and has dozens of call
// sites — can hand best-effort background work to `ctx.waitUntil` without
// threading ctx through every signature.
//
// Outside a scope (unit tests, scheduled/queue paths that never entered one)
// `runInBackground` falls back to a floating promise with its rejection
// swallowed — the same behaviour the callers had before this helper.

import { AsyncLocalStorage } from "node:async_hooks";

interface WaitUntilCapable {
  waitUntil(promise: Promise<unknown>): void;
}

const storage = new AsyncLocalStorage<WaitUntilCapable>();

/** Run `fn` with `ctx` reachable through `runInBackground`. */
export function runWithRequestContext<T>(ctx: WaitUntilCapable, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Schedule best-effort background work. Uses the enclosing request's
 * `ctx.waitUntil` when there is one, else lets the promise float. Never
 * throws, and the promise's rejection is always swallowed.
 */
export function runInBackground(work: () => Promise<unknown>): void {
  let promise: Promise<unknown>;
  try {
    promise = work().catch(() => undefined);
  } catch {
    return;
  }
  const ctx = storage.getStore();
  if (!ctx) return;
  try {
    ctx.waitUntil(promise);
  } catch {
    // waitUntil can throw once the request has completed; the promise
    // still runs as a floating promise.
  }
}
