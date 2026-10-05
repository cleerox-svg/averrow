/**
 * Delivery tracking for `alert.created` org events (lib/alerts.ts).
 *
 * createAlert never awaits webhook / integration delivery (a slow customer
 * endpoint must not stall a scanner loop). A caller holding an
 * ExecutionContext passes `waitUntil` directly. Every other caller — agents
 * and scanners, which have no ctx — gets its delivery promise registered
 * here, and the invocation drains it before it ends:
 *
 *   - executeAgent (lib/agentRunner.ts) awaits `drainAlertEvents()` after the
 *     agent's execute() returns, so an agent's deliveries finish inside its
 *     own run (before agent_runs is finalized);
 *   - the Worker's `scheduled` and `fetch` entrypoints (src/index.ts) hand
 *     `drainAlertEvents()` to `ctx.waitUntil` on the way out, which covers
 *     scanners called directly from cron or from request handlers.
 *
 * Guarantee: at most one delivery attempt per alert per owning org,
 * completed within the invocation that created the alert. Deliveries are
 * never retried after the invocation ends.
 *
 * The set is per-isolate. Draining another concurrent invocation's
 * promises only extends this invocation's lifetime; it never drops or
 * duplicates a delivery.
 */

const pending = new Set<Promise<unknown>>();

export function trackAlertEvent(promise: Promise<unknown>): void {
  const tracked = promise.catch(() => undefined).finally(() => {
    pending.delete(tracked);
  });
  pending.add(tracked);
}

/** Await every tracked delivery, including ones started while draining. */
export async function drainAlertEvents(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled(Array.from(pending));
  }
}

/** Test/diagnostic helper. */
export function pendingAlertEventCount(): number {
  return pending.size;
}
