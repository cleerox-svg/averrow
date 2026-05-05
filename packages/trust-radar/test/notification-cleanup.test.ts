import { describe, it, expect, vi } from "vitest";
import { reconcileNotificationsForDismissedAlerts } from "../src/lib/notification-cleanup";
import type { D1Database } from "@cloudflare/workers-types";

// Mock DB helper that records the SQL+bind sequence for assertions.
// Returns canned alert rows from the SELECT and a configurable
// `meta.changes` count from each UPDATE.
function makeMockDb(opts: {
  alerts: Array<{ id: string; brand_id: string; created_at: string }>;
  changesPerUpdate?: number[];
}): { db: D1Database; calls: Array<{ sql: string; binds: unknown[] }> } {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  let updateIdx = 0;

  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      all: async () => {
        calls.push({ sql, binds });
        return { results: opts.alerts };
      },
      run: async () => {
        calls.push({ sql, binds });
        const changes = opts.changesPerUpdate?.[updateIdx++] ?? 0;
        return { success: true, meta: { changes } };
      },
    }),
  });

  return {
    db: { prepare } as unknown as D1Database,
    calls,
  };
}

describe("reconcileNotificationsForDismissedAlerts", () => {
  it("returns zeros when no dismissed alerts exist", async () => {
    const { db, calls } = makeMockDb({ alerts: [] });
    const r = await reconcileNotificationsForDismissedAlerts(db);
    expect(r.alerts_checked).toBe(0);
    expect(r.notifications_cleared).toBe(0);
    // Only the SELECT ran — no UPDATEs triggered.
    expect(calls.length).toBe(1);
    expect(calls[0]!.sql).toContain('SELECT id, brand_id, created_at');
  });

  it("issues one UPDATE per matching alert and sums their changes", async () => {
    const { db, calls } = makeMockDb({
      alerts: [
        { id: 'a1', brand_id: 'brand_one', created_at: '2026-05-05 10:00:00' },
        { id: 'a2', brand_id: 'brand_two', created_at: '2026-05-05 11:00:00' },
        { id: 'a3', brand_id: 'brand_three', created_at: '2026-05-05 12:00:00' },
      ],
      changesPerUpdate: [3, 0, 5],
    });
    const r = await reconcileNotificationsForDismissedAlerts(db);
    expect(r.alerts_checked).toBe(3);
    expect(r.notifications_cleared).toBe(8);
    // 1 SELECT + 3 UPDATEs.
    expect(calls.length).toBe(4);
    expect(calls.slice(1).every((c) => c.sql.includes('UPDATE notifications'))).toBe(true);
  });

  it("UPDATE binds the brand_id and time-window edges", async () => {
    const { db, calls } = makeMockDb({
      alerts: [{ id: 'a1', brand_id: 'brand_one', created_at: '2026-05-05 10:00:00' }],
      changesPerUpdate: [2],
    });
    await reconcileNotificationsForDismissedAlerts(db, { windowMinutes: 30 });
    const update = calls[1]!;
    // UPDATE binds: brand_id, created_at, windowMinutes, created_at, windowMinutes.
    expect(update.binds[0]).toBe('brand_one');
    expect(update.binds[1]).toBe('2026-05-05 10:00:00');
    expect(update.binds[2]).toBe(30);
    expect(update.binds[3]).toBe('2026-05-05 10:00:00');
    expect(update.binds[4]).toBe(30);
  });

  it("only sweeps notifications with state='unread'", async () => {
    const { db, calls } = makeMockDb({
      alerts: [{ id: 'a1', brand_id: 'b', created_at: '2026-05-05 10:00:00' }],
      changesPerUpdate: [0],
    });
    await reconcileNotificationsForDismissedAlerts(db);
    const update = calls[1]!;
    expect(update.sql).toContain("state = 'unread'");
  });

  it("respects custom lookbackHours", async () => {
    const { db, calls } = makeMockDb({ alerts: [] });
    await reconcileNotificationsForDismissedAlerts(db, { lookbackHours: 24 });
    const select = calls[0]!;
    // First bind on the SELECT is the lookback hours.
    expect(select.binds[0]).toBe(24);
  });

  it("clamps limit to safe bounds", async () => {
    const { db, calls } = makeMockDb({ alerts: [] });
    await reconcileNotificationsForDismissedAlerts(db, { limit: 999_999 });
    const select = calls[0]!;
    // limit is the second bind on the SELECT after lookback hours.
    expect(select.binds[1]).toBe(2000);
  });

  it("uses default values when opts is undefined", async () => {
    const { db, calls } = makeMockDb({ alerts: [] });
    await reconcileNotificationsForDismissedAlerts(db);
    const select = calls[0]!;
    expect(select.binds[0]).toBe(168); // default lookback hours = 7 days
    expect(select.binds[1]).toBe(1000); // default limit
  });

  it("only considers auto-dismissed alerts (resolution_notes LIKE 'auto:%')", async () => {
    const { db, calls } = makeMockDb({ alerts: [] });
    await reconcileNotificationsForDismissedAlerts(db);
    const select = calls[0]!;
    expect(select.sql).toContain("resolution_notes LIKE 'auto:%'");
    expect(select.sql).toContain("status = 'false_positive'");
  });
});
