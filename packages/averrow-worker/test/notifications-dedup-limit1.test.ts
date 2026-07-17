/**
 * Tests for the createNotification dedup query (PR-BM).
 *
 * Two hot dedup paths in `lib/notifications.ts`:
 *   1. group_key path (canonical): SELECT 1 ... LIMIT 1
 *   2. metadata LIKE fallback:     SELECT 1 ... LIMIT 1
 *
 * Pre-PR-BM both used SELECT COUNT(*), which scanned every matching
 * row in the (type, group_key) prefix of idx_notifications_dedup —
 * ~21K rows per call × 612 calls/day = 13M D1 rows/day.
 *
 * The change is purely a query-shape optimization; semantics are
 * identical: if any row exists in the dedup window we return 0 to
 * skip the new notification.
 */

import { describe, it, expect, vi } from "vitest";

// Mock the @averrow/shared module so the test doesn't need the
// shared package to be built. Only the dedup window + a single
// known event key is required.
vi.mock("@averrow/shared", () => ({
  NOTIFICATION_EVENT_DEDUP: {
    brand_threat: "-1 hour",
    platform_feed_at_risk: "-1 hour",
  },
  NOTIFICATION_EVENTS: [
    { key: "brand_threat" },
    { key: "platform_feed_at_risk" },
  ],
  USER_TOGGLEABLE_EVENTS: [{ key: "brand_threat" }],
}));

vi.mock("../src/lib/push", () => ({
  dispatchPush: vi.fn().mockResolvedValue(undefined),
  isInQuietHours: () => false,
}));

import { createNotification } from "../src/lib/notifications";

interface Call {
  sql: string;
  bindArgs: unknown[];
}

interface EnvOpts {
  /** Result of the dedup SELECT — null means "no recent notification". */
  dedupHit?: boolean;
  /** Result of the user resolution SELECT — defaults to a single team user. */
  teamUsers?: Array<{ id: string }>;
}

function makeEnv(opts: EnvOpts = {}) {
  const calls: Call[] = [];

  const fakeStmt = (sql: string) => {
    return {
      bind(...bindArgs: unknown[]) {
        const record: Call = { sql, bindArgs };
        calls.push(record);
        return {
          first: async () => {
            // Mute check — table may not exist, return null to fall through.
            if (sql.includes("notification_type_mutes")) return null;
            // Platform_config push lookup — return push disabled to short
            // the push path (we only care about dedup behavior).
            if (sql.includes("platform_config")) return { push_enabled: 0 };
            // Dedup query — both group_key and metadata-LIKE paths read
            // `SELECT 1 AS hit ... LIMIT 1`. PR-BM regression guard:
            // the SQL must contain LIMIT 1 (binary probe, not COUNT).
            if (/SELECT 1 AS hit FROM notifications/.test(sql)) {
              return opts.dedupHit ? { hit: 1 } : null;
            }
            return null;
          },
          all: async () => {
            if (sql.includes("FROM users")) {
              return { results: opts.teamUsers ?? [{ id: "user1" }] };
            }
            return { results: [] };
          },
          run: async () => ({ meta: { changes: 1 }, success: true }),
        };
      },
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 }, success: true }),
    };
  };

  const env = {
    DB: { prepare: (sql: string) => fakeStmt(sql) },
    CACHE: {
      get: async () => null,
      put: async () => undefined,
    },
  };
  return { env, calls };
}

describe("createNotification dedup (PR-BM LIMIT 1)", () => {
  it("group_key dedup path uses SELECT 1 ... ORDER BY created_at DESC LIMIT 1 (not COUNT)", async () => {
    const { env, calls } = makeEnv({ dedupHit: true });

    // group_key resolves from brandId.
    await createNotification(env as never, {
      type: "brand_threat" as never,
      brandId: "brand-x",
      severity: "high" as never,
      title: "t",
      message: "m",
    });

    const dedupCalls = calls.filter((c) =>
      /SELECT 1 AS hit FROM notifications/.test(c.sql),
    );
    expect(dedupCalls.length).toBe(1);
    expect(dedupCalls[0].sql).toContain("LIMIT 1");
    // PR-BN: ORDER BY created_at DESC is required for the planner to
    // short-circuit on idx_notifications_dedup. Without it, LIMIT 1
    // alone still scans the (type, group_key) prefix.
    expect(dedupCalls[0].sql).toContain("ORDER BY created_at DESC");
    expect(dedupCalls[0].sql).not.toMatch(/SELECT COUNT\(\*\)/);
    // Binds: (type, group_key, window)
    expect(dedupCalls[0].bindArgs).toEqual(["brand_threat", "brand_threat:brand-x", "-1 hour"]);
  });

  it("dedup HIT short-circuits — returns 0 and writes no rows", async () => {
    const { env, calls } = makeEnv({ dedupHit: true });

    const result = await createNotification(env as never, {
      type: "brand_threat" as never,
      brandId: "brand-x",
      severity: "high" as never,
      title: "t",
      message: "m",
    });

    expect(result).toBe(0);
    // No INSERT into notifications should have happened.
    const inserts = calls.filter((c) => /INSERT INTO notifications/i.test(c.sql));
    expect(inserts.length).toBe(0);
  });

  it("dedup MISS proceeds to user resolution + INSERT path", async () => {
    const { env, calls } = makeEnv({ dedupHit: false });

    await createNotification(env as never, {
      type: "brand_threat" as never,
      brandId: "brand-x",
      severity: "high" as never,
      title: "t",
      message: "m",
    });

    // We don't assert the full INSERT shape here (createNotification has
    // a long downstream path). What matters: the dedup query did NOT
    // short-circuit, so SOMETHING beyond the dedup probe ran.
    const dedupIdx = calls.findIndex((c) =>
      /SELECT 1 AS hit FROM notifications/.test(c.sql),
    );
    expect(dedupIdx).toBeGreaterThanOrEqual(0);
    expect(calls.length).toBeGreaterThan(dedupIdx + 1);
  });

  it("metadata-LIKE fallback (no group_key) also uses ORDER BY + LIMIT 1", async () => {
    const { env, calls } = makeEnv({ dedupHit: true });

    // No brandId, no groupKey, but metadata.feed_name → rateKey path.
    await createNotification(env as never, {
      type: "platform_feed_at_risk" as never,
      severity: "high" as never,
      title: "t",
      message: "m",
      metadata: { feed_name: "taxii_otx" },
      audience: "team",
    });

    const dedupCalls = calls.filter((c) =>
      /SELECT 1 AS hit FROM notifications/.test(c.sql) && /metadata LIKE/.test(c.sql),
    );
    expect(dedupCalls.length).toBe(1);
    expect(dedupCalls[0].sql).toContain("LIMIT 1");
    expect(dedupCalls[0].sql).toContain("ORDER BY created_at DESC");
    expect(dedupCalls[0].sql).not.toMatch(/SELECT COUNT\(\*\)/);
    // Binds: (type, window, "%"+rateKey+"%")
    expect(dedupCalls[0].bindArgs[0]).toBe("platform_feed_at_risk");
    expect(dedupCalls[0].bindArgs[1]).toBe("-1 hour");
    expect(String(dedupCalls[0].bindArgs[2])).toContain('"feed_name":"taxii_otx"');
  });
});
