/**
 * Delivery tracking for `alert.created` org events (lib/alerts.ts).
 *
 * createAlert never awaits webhook / integration delivery (a slow customer
 * endpoint must not stall a scanner loop). A caller holding an
 * ExecutionContext passes `waitUntil` directly. Every other caller — agents
 * and scanners, which have no ctx — gets its delivery promise tracked here:
 *
 *   - Per run: executeAgent (lib/agentRunner.ts) runs the agent inside
 *     `runInAlertScope`, an AsyncLocalStorage scope, so the deliveries that
 *     run starts are recorded in a set of its own. After execute() it calls
 *     `drainAlertScope` with a deadline (ALERT_SCOPE_DRAIN_DEADLINE_MS): a
 *     single snapshot raced against a timer. A run therefore never waits on
 *     another run's or request's deliveries, and a hung customer endpoint
 *     can delay a run by at most the deadline.
 *   - Per invocation: every tracked delivery is also in an isolate-wide set.
 *     The Worker's `scheduled` and `fetch` entrypoints (src/index.ts) hand a
 *     single-snapshot `drainAlertEvents()` to `ctx.waitUntil` on the way
 *     out, which picks up whatever a run's deadline left behind and
 *     deliveries from scanners called outside executeAgent.
 *
 * Guarantee (best-effort): each alert gets at most one delivery attempt per
 * owning org, ATTEMPTED within the invocation that created it. Completion is
 * bounded by the runtime's waitUntil budget; there is no retry and no
 * durable queue. Not covered: the legacy queue consumer, Workflows and
 * Durable Objects (none create alerts today) — their deliveries are
 * fire-and-forget.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Bound on the in-run drain in executeAgent. */
export const ALERT_SCOPE_DRAIN_DEADLINE_MS = 20_000;

export type AlertScope = Set<Promise<unknown>>;

const isolatePending = new Set<Promise<unknown>>();
const scopeStorage = new AsyncLocalStorage<AlertScope>();

export function trackAlertEvent(promise: Promise<unknown>): void {
  const scope = scopeStorage.getStore();
  const tracked: Promise<unknown> = promise.catch(() => undefined).finally(() => {
    isolatePending.delete(tracked);
    scope?.delete(tracked);
  });
  isolatePending.add(tracked);
  scope?.add(tracked);
}

/** Run `fn` with its own delivery scope. Returns the result and the scope. */
export async function runInAlertScope<T>(fn: () => Promise<T>): Promise<{ result: T; scope: AlertScope }> {
  const scope: AlertScope = new Set();
  const result = await scopeStorage.run(scope, fn);
  return { result, scope };
}

/**
 * Wait for one scope's deliveries — a single snapshot, bounded by
 * `deadlineMs`. Never throws. Returns how many were still pending at the
 * deadline (they keep running and are drained by the entrypoint).
 */
export async function drainAlertScope(
  scope: AlertScope,
  deadlineMs: number = ALERT_SCOPE_DRAIN_DEADLINE_MS,
): Promise<{ timedOut: boolean; pending: number }> {
  const snapshot = Array.from(scope);
  if (snapshot.length === 0) return { timedOut: false, pending: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  try {
    const outcome = await Promise.race([
      Promise.allSettled(snapshot).then(() => "done" as const),
      deadline,
    ]);
    return { timedOut: outcome === "timeout", pending: outcome === "timeout" ? scope.size : 0 };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Entrypoint drain: one snapshot of the isolate-wide set (handed to
 *  ctx.waitUntil, so the runtime bounds it). Never loops. */
export async function drainAlertEvents(): Promise<void> {
  await Promise.allSettled(Array.from(isolatePending));
}

/** Test/diagnostic helper. */
export function pendingAlertEventCount(): number {
  return isolatePending.size;
}
