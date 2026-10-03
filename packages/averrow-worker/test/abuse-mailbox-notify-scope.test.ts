/**
 * Abuse-mailbox verdict notifications are tenant-scoped: a brand-bound
 * capture notifies brand subscribers ONLY when they are active members of
 * the reporting org (plus opted-in super_admins), and the forwarded
 * subject never appears in the notification title.
 *
 * Recipient resolution runs against a migration-derived SQLite schema so
 * the org_members filter is exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@averrow/shared", () => ({
  NOTIFICATION_EVENT_DEDUP: { abuse_mailbox_verdict: "-1 hour", brand_threat: "-1 hour" },
  NOTIFICATION_EVENTS: [{ key: "abuse_mailbox_verdict" }, { key: "brand_threat" }],
  USER_TOGGLEABLE_EVENTS: [],
}));
vi.mock("../src/lib/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/push")>();
  return { ...actual, dispatchPush: vi.fn(async () => ({ sent: 0, failed: 0, expired: 0 })) };
});

import type { Env } from "../src/types";
import { notifyAbuseVerdict } from "../src/lib/abuse-mailbox-notify";
import { createNotification } from "../src/lib/notifications";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";

const ORG_A = 101;
const ORG_B = 202;
const BRAND = "brand_shared";

function setup(): { raw: SqliteDb; env: Env } {
  const raw = openDerivedDb([
    "users", "org_members", "org_brands", "notification_subscriptions", "notification_preferences",
    "notification_preferences_v2", "notifications", "notification_deliveries", "notification_type_mutes",
  ]);
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    raw.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...cols.map((c) => row[c]));
  };
  for (const [id, role] of [["usr_a", "client"], ["usr_b", "client"], ["usr_sa", "super_admin"]] as const) {
    insert("users", { id, email: `${id}@example.test`, name: id, role, status: "active" });
  }
  insert("org_members", { org_id: ORG_A, user_id: "usr_a", role: "analyst", status: "active" });
  insert("org_members", { org_id: ORG_B, user_id: "usr_b", role: "analyst", status: "active" });
  // Both orgs own (monitor) the SAME brand — the case restrictToOrgMembers
  // exists for — and both orgs' users subscribe to it.
  insert("org_brands", { org_id: ORG_A, brand_id: BRAND });
  insert("org_brands", { org_id: ORG_B, brand_id: BRAND });
  for (const uid of ["usr_a", "usr_b"]) {
    insert("notification_subscriptions", { user_id: uid, brand_id: BRAND, level: "default" });
  }
  // The super_admin opted into the tenant firehose.
  insert("notification_preferences_v2", { user_id: "usr_sa", show_tenant_notifications: 1 });

  const db = d1FromSqlite(raw, {
    // Push / delivery-audit side tables are outside this unit.
    swallow: (sql) => /notification_deliveries|push_|platform_config/i.test(sql),
  });
  return { raw, env: { DB: db } as unknown as Env };
}

function recipients(raw: SqliteDb): Array<{ user_id: string; title: string }> {
  return raw.prepare(`SELECT user_id, title FROM notifications ORDER BY user_id`).all() as Array<{ user_id: string; title: string }>;
}

describe.skipIf(!hasSqlite())("abuse-mailbox verdict notifications — tenant scope", () => {
  let raw: SqliteDb;
  let env: Env;
  beforeEach(() => { ({ raw, env } = setup()); });

  it("org-A capture notifies the org-A subscriber and opted-in super_admin, never the org-B subscriber", async () => {
    await notifyAbuseVerdict(env, {
      messageId: "msg-a",
      orgId: ORG_A,
      brandId: BRAND,
      inboundAlias: "verify-a@averrow.com",
      classification: "phishing",
      severity: "HIGH",
      confidence: 90,
      action: "escalate",
      message: "Links match infrastructure already confirmed malicious in threat intelligence.",
      classifiedBy: "rules",
    });
    const rows = recipients(raw);
    expect(rows.map((r) => r.user_id)).toEqual(["usr_a", "usr_sa"]);
    expect(rows.map((r) => r.user_id)).not.toContain("usr_b");
    // Title never carries the (attacker-controlled) forwarded subject.
    expect(rows[0]!.title).toBe("Phishing confirmed — abuse mailbox report");
  });

  it("an inactive org membership does not qualify", async () => {
    raw.prepare(`UPDATE org_members SET status = 'suspended' WHERE user_id = 'usr_a'`).run();
    await notifyAbuseVerdict(env, {
      messageId: "msg-a2", orgId: ORG_A, brandId: BRAND, inboundAlias: null,
      classification: "malware", severity: "CRITICAL", confidence: 90, action: "escalate",
      message: "x", classifiedBy: "rules",
    });
    expect(recipients(raw).map((r) => r.user_id)).toEqual(["usr_sa"]);
  });

  it("createNotification without restrictToOrgMembers is unchanged (all brand subscribers)", async () => {
    await createNotification(env, {
      type: "brand_threat", severity: "high", title: "t", message: "m",
      audience: "tenant", brandId: BRAND, groupKey: "brand_threat:test",
    });
    expect(recipients(raw).map((r) => r.user_id)).toEqual(["usr_a", "usr_b", "usr_sa"]);
  });
});
