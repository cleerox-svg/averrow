/**
 * Batch A2 — push stickiness, truthful push delivery audit, and
 * service-account exclusion from audience fan-out.
 *
 *   1. STICKY_PUSH_TYPES: platform-health alerts (platform_ai_calls_failing)
 *      stay `high` severity — `critical` would auto-create a public status
 *      incident — but their push payload carries `requireInteraction: true`
 *      so the SW keeps the notification on screen.
 *   2. createNotification used to stamp push `succeeded` whenever
 *      dispatchPush resolved. dispatchPush never throws, so users with zero
 *      devices got false `succeeded` rows. The status now comes from the
 *      returned counts.
 *   3. Synthetic service users (`service_account_*`) are filtered out of
 *      audience fan-out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@averrow/shared", () => ({
  NOTIFICATION_EVENT_DEDUP: {
    platform_ai_calls_failing: "-1 hour",
    platform_feed_at_risk: "-1 hour",
  },
  NOTIFICATION_EVENTS: [
    { key: "platform_ai_calls_failing" },
    { key: "platform_feed_at_risk" },
  ],
  USER_TOGGLEABLE_EVENTS: [],
}));

const dispatchPushMock = vi.fn();
vi.mock("../src/lib/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/push")>();
  return {
    ...actual,
    dispatchPush: (...args: unknown[]) => dispatchPushMock(...args),
  };
});

import {
  STICKY_PUSH_TYPES,
  isStickyPushType,
  pushDeliveryOutcome,
} from "../src/lib/push";
import {
  buildNotificationPushPayload,
  createNotification,
  isServiceAccountUserId,
} from "../src/lib/notifications";

interface Call {
  sql: string;
  bindArgs: unknown[];
}

function makeEnv(users: Array<{ id: string }>) {
  const calls: Call[] = [];
  const fakeStmt = (sql: string) => {
    const first = async () => {
      if (sql.includes("notification_type_mutes")) return null;
      if (/SELECT 1 AS hit FROM notifications/.test(sql)) return null;
      // Preferences row: v2 floor 'info' → push allowed for every severity.
      if (sql.includes("notification_preferences_v2 pv")) {
        return { v2_push_severity_floor: "info" };
      }
      return null;
    };
    const all = async () =>
      sql.includes("FROM users") ? { results: users } : { results: [] };
    const run = async () => ({ meta: { changes: 1 }, success: true });
    return {
      bind(...bindArgs: unknown[]) {
        calls.push({ sql, bindArgs });
        return { first, all, run };
      },
      first,
      all,
      run,
    };
  };
  return { env: { DB: { prepare: fakeStmt } }, calls };
}

/** Final push audit row per user: last `notification_deliveries` write on channel 'push'. */
function pushAudit(calls: Call[]): Map<string, { status: unknown; reason: unknown }> {
  const out = new Map<string, { status: unknown; reason: unknown }>();
  for (const c of calls) {
    if (!c.sql.includes("INSERT INTO notification_deliveries")) continue;
    // binds: (id, notification_id, user_id, channel, status, reason, completed_at)
    if (c.bindArgs[3] !== "push") continue;
    out.set(String(c.bindArgs[2]), { status: c.bindArgs[4], reason: c.bindArgs[5] });
  }
  return out;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("sticky push payload (STICKY_PUSH_TYPES)", () => {
  it("allowlists platform_ai_calls_failing", () => {
    expect(STICKY_PUSH_TYPES.has("platform_ai_calls_failing")).toBe(true);
    expect(isStickyPushType("platform_ai_calls_failing")).toBe(true);
    expect(isStickyPushType("platform_feed_at_risk")).toBe(false);
    expect(isStickyPushType(undefined)).toBe(false);
  });

  it("sets requireInteraction for an allowlisted type without raising severity", () => {
    const p = buildNotificationPushPayload(
      { type: "platform_ai_calls_failing" as never, severity: "high", title: "t", message: "m" },
      "n1",
    );
    expect(p.requireInteraction).toBe(true);
    expect(p.severity).toBe("high");
  });

  it("omits the key entirely for non-allowlisted types (payload shape unchanged)", () => {
    const p = buildNotificationPushPayload(
      { type: "platform_feed_at_risk" as never, severity: "critical", title: "t", message: "m" },
      "n2",
    );
    expect("requireInteraction" in p).toBe(false);
  });
});

describe("pushDeliveryOutcome — audit status mapping", () => {
  it("sent > 0 → succeeded", () => {
    expect(pushDeliveryOutcome({ sent: 2, expired: 0, failed: 0, configured: true, subscriptions: 2 }))
      .toEqual({ status: "succeeded", reason: null });
  });

  it("sent > 0 with some losses → succeeded with a partial note", () => {
    const o = pushDeliveryOutcome({ sent: 1, expired: 1, failed: 1, configured: true, subscriptions: 3 });
    expect(o.status).toBe("succeeded");
    expect(o.reason).toContain("partial");
  });

  it("no subscriptions → skipped 'no_subscriptions'", () => {
    expect(pushDeliveryOutcome({ sent: 0, expired: 0, failed: 0, configured: true, subscriptions: 0 }))
      .toEqual({ status: "skipped", reason: "no_subscriptions" });
  });

  it("push not configured → skipped 'push_not_configured'", () => {
    expect(pushDeliveryOutcome({ sent: 0, expired: 0, failed: 0, configured: false, subscriptions: 0 }))
      .toEqual({ status: "skipped", reason: "push_not_configured" });
  });

  it("every device failed/expired → failed with a reason", () => {
    const o = pushDeliveryOutcome({ sent: 0, expired: 1, failed: 2, configured: true, subscriptions: 3 });
    expect(o.status).toBe("failed");
    expect(o.reason).toBe("all_devices_failed: failed=2 expired=1");
  });

  it("legacy 3-field result: zeros → no_subscriptions, failures → failed", () => {
    expect(pushDeliveryOutcome({ sent: 0, expired: 0, failed: 0 }).reason).toBe("no_subscriptions");
    expect(pushDeliveryOutcome({ sent: 0, expired: 0, failed: 1 }).status).toBe("failed");
  });
});

describe("createNotification — push audit uses dispatchPush's result", () => {
  beforeEach(() => dispatchPushMock.mockReset());

  const cases: Array<[string, object, string, string | null]> = [
    ["sent>0", { sent: 1, expired: 0, failed: 0, configured: true, subscriptions: 1 }, "succeeded", null],
    ["no devices", { sent: 0, expired: 0, failed: 0, configured: true, subscriptions: 0 }, "skipped", "no_subscriptions"],
    ["all failed", { sent: 0, expired: 0, failed: 3, configured: true, subscriptions: 3 }, "failed", "all_devices_failed: failed=3 expired=0"],
  ];

  for (const [label, result, status, reason] of cases) {
    it(`${label} → push ${status}`, async () => {
      dispatchPushMock.mockResolvedValue(result);
      const { env, calls } = makeEnv([{ id: "u1" }]);
      const created = await createNotification(env as never, {
        type: "platform_ai_calls_failing" as never,
        audience: "super_admin",
        severity: "high",
        title: "t",
        message: "m",
        groupKey: `g-${label}`,
      });
      await settle();
      expect(created).toBe(1);
      expect(pushAudit(calls).get("u1")).toEqual({ status, reason });
    });
  }

  it("passes the sticky flag through to dispatchPush for the allowlisted type", async () => {
    dispatchPushMock.mockResolvedValue({ sent: 1, expired: 0, failed: 0, configured: true, subscriptions: 1 });
    const { env } = makeEnv([{ id: "u1" }]);
    await createNotification(env as never, {
      type: "platform_ai_calls_failing" as never,
      audience: "super_admin",
      severity: "high",
      title: "t",
      message: "m",
      groupKey: "g-sticky",
    });
    expect(dispatchPushMock).toHaveBeenCalledTimes(1);
    expect(dispatchPushMock.mock.calls[0]?.[2]).toMatchObject({ requireInteraction: true, severity: "high" });
  });
});

describe("service accounts are excluded from audience fan-out", () => {
  beforeEach(() => {
    dispatchPushMock.mockReset();
    dispatchPushMock.mockResolvedValue({ sent: 0, expired: 0, failed: 0, configured: true, subscriptions: 0 });
  });

  it("recognises the service_account_ id prefix only", () => {
    expect(isServiceAccountUserId("service_account_mcp")).toBe(true);
    expect(isServiceAccountUserId("usr_abc")).toBe(false);
    expect(isServiceAccountUserId("my_service_account_x")).toBe(false);
  });

  for (const audience of ["super_admin", "team", "all"] as const) {
    it(`audience=${audience} skips service_account_mcp`, async () => {
      const { env, calls } = makeEnv([{ id: "owner" }, { id: "service_account_mcp" }]);
      const created = await createNotification(env as never, {
        type: "platform_feed_at_risk" as never,
        audience,
        severity: "high",
        title: "t",
        message: "m",
        groupKey: `g-sa-${audience}`,
      });
      expect(created).toBe(1);
      const recipients = calls
        .filter((c) => /INSERT INTO notifications/.test(c.sql))
        .map((c) => c.bindArgs[1]);
      expect(recipients).toEqual(["owner"]);
    });
  }

  it("an explicit userId is still honoured", async () => {
    const { env, calls } = makeEnv([]);
    const created = await createNotification(env as never, {
      userId: "service_account_mcp",
      type: "platform_feed_at_risk" as never,
      severity: "high",
      title: "t",
      message: "m",
      groupKey: "g-explicit",
    });
    expect(created).toBe(1);
    expect(calls.some((c) => /INSERT INTO notifications/.test(c.sql) && c.bindArgs[1] === "service_account_mcp")).toBe(true);
  });
});
