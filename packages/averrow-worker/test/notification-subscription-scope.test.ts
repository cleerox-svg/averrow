/**
 * Brand subscriptions (N5) are org-scoped for tenant users.
 *
 * A `notification_subscriptions` row is a recipient grant: tenant-audience
 * notifications keyed by a brand fan out to its subscribers. Before this
 * guard a `client` could PUT a subscription on any brand id (only existence
 * was checked) and receive a competitor's tenant notifications.
 *
 *   1. Write gate — handleUpdateSubscription: staff may watch any brand; a
 *      client only a brand owned by an org they actively belong to.
 *   2. Fan-out — createNotification(audience='tenant') drops client
 *      subscribers whose orgs don't own the brand, by default, so rows
 *      written before the gate are inert. Staff subscribers unaffected.
 *   3. List — a client never sees a brand name for a row they may not watch.
 *
 * Runs against a migration-derived SQLite schema so the org_members ×
 * org_brands predicate is exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@averrow/shared", () => ({
  NOTIFICATION_EVENT_DEDUP: { brand_threat: "-1 hour", intel_recommended_action: "-1 hour" },
  NOTIFICATION_EVENTS: [{ key: "brand_threat" }, { key: "intel_recommended_action" }],
  USER_TOGGLEABLE_EVENTS: [],
  NOTIFICATION_CHANNELS: [],
}));
vi.mock("../src/lib/push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/push")>();
  return { ...actual, dispatchPush: vi.fn(async () => ({ sent: 0, failed: 0, expired: 0 })) };
});

import type { Env, UserRole } from "../src/types";
import { createNotification } from "../src/lib/notifications";
import { userMayWatchBrand } from "../src/lib/brand-subscription-access";
import {
  handleListSubscriptions,
  handleUpdateSubscription,
} from "../src/handlers/notifications";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";

const ORG_A = 101;
const ORG_B = 202;
const BRAND_A = "brand_a"; // owned by org A
const BRAND_B = "brand_b"; // owned by org B (the "competitor")
const BRAND_UNCLAIMED = "brand_unclaimed"; // catalog brand, no org

function setup(): { raw: SqliteDb; env: Env } {
  const raw = openDerivedDb([
    "users", "brands", "org_members", "org_brands", "notification_subscriptions",
    "notification_preferences", "notification_preferences_v2", "notifications",
    "notification_deliveries", "notification_type_mutes",
  ]);
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    raw.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...cols.map((c) => row[c]));
  };
  for (const [id, role] of [
    ["usr_a", "client"], ["usr_b", "client"], ["usr_staff", "analyst"],
  ] as const) {
    insert("users", { id, email: `${id}@example.test`, name: id, role, status: "active" });
  }
  for (const id of [BRAND_A, BRAND_B, BRAND_UNCLAIMED]) {
    insert("brands", { id, name: `Name of ${id}`, canonical_domain: `${id}.example` });
  }
  insert("org_members", { org_id: ORG_A, user_id: "usr_a", role: "analyst", status: "active" });
  insert("org_members", { org_id: ORG_B, user_id: "usr_b", role: "analyst", status: "active" });
  insert("org_brands", { org_id: ORG_A, brand_id: BRAND_A });
  insert("org_brands", { org_id: ORG_B, brand_id: BRAND_B });

  const db = d1FromSqlite(raw, {
    swallow: (sql) => /notification_deliveries|push_|platform_config/i.test(sql),
  });
  return { raw, env: { DB: db } as unknown as Env };
}

function putRequest(level = "watching"): Request {
  return new Request("https://averrow.test/api/notifications/subscriptions/x", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level }),
  });
}

function subs(raw: SqliteDb, userId: string): string[] {
  return (raw.prepare(`SELECT brand_id FROM notification_subscriptions WHERE user_id = ? ORDER BY brand_id`)
    .all(userId) as Array<{ brand_id: string }>).map((r) => r.brand_id);
}

function recipients(raw: SqliteDb): string[] {
  return (raw.prepare(`SELECT user_id FROM notifications ORDER BY user_id`).all() as Array<{ user_id: string }>)
    .map((r) => r.user_id);
}

async function put(env: Env, brandId: string, userId: string, role: UserRole): Promise<Response> {
  return handleUpdateSubscription(putRequest(), env, brandId, userId, role);
}

describe.skipIf(!hasSqlite())("brand subscriptions — write gate", () => {
  let raw: SqliteDb;
  let env: Env;
  beforeEach(() => { ({ raw, env } = setup()); });

  it("client may subscribe to a brand its org owns", async () => {
    const res = await put(env, BRAND_A, "usr_a", "client");
    expect(res.status).toBe(200);
    expect(subs(raw, "usr_a")).toEqual([BRAND_A]);
  });

  it("client subscribing to another org's brand gets 403 and no row", async () => {
    const res = await put(env, BRAND_B, "usr_a", "client");
    expect(res.status).toBe(403);
    expect(subs(raw, "usr_a")).toEqual([]);
  });

  it("client subscribing to an unclaimed catalog brand gets 403", async () => {
    expect((await put(env, BRAND_UNCLAIMED, "usr_a", "client")).status).toBe(403);
  });

  it("client gets 403 (not 404) for a nonexistent brand id — no enumeration", async () => {
    expect((await put(env, "brand_does_not_exist", "usr_a", "client")).status).toBe(403);
  });

  it("an inactive org membership does not grant access", async () => {
    raw.prepare(`UPDATE org_members SET status = 'suspended' WHERE user_id = 'usr_a'`).run();
    expect((await put(env, BRAND_A, "usr_a", "client")).status).toBe(403);
  });

  it("staff may subscribe to any brand, including unclaimed ones", async () => {
    for (const b of [BRAND_A, BRAND_B, BRAND_UNCLAIMED]) {
      expect((await put(env, b, "usr_staff", "analyst")).status).toBe(200);
    }
    expect(subs(raw, "usr_staff")).toEqual([BRAND_A, BRAND_B, BRAND_UNCLAIMED].sort());
  });

  it("staff still get 404 for a nonexistent brand", async () => {
    expect((await put(env, "brand_does_not_exist", "usr_staff", "admin")).status).toBe(404);
  });

  it("userMayWatchBrand short-circuits for every staff role without a D1 read", async () => {
    const throwingDb = { prepare: () => { throw new Error("no D1 for staff"); } } as unknown as D1Database;
    for (const role of ["super_admin", "admin", "analyst", "sales", "support", "billing", "auditor"] as const) {
      await expect(userMayWatchBrand(throwingDb, "u", role, BRAND_B)).resolves.toBe(true);
    }
  });
});

describe.skipIf(!hasSqlite())("brand subscriptions — tenant fan-out filter", () => {
  let raw: SqliteDb;
  let env: Env;
  beforeEach(() => { ({ raw, env } = setup()); });

  const insertSub = (userId: string, brandId: string, level = "default") =>
    raw.prepare(`INSERT INTO notification_subscriptions (user_id, brand_id, level) VALUES (?, ?, ?)`)
      .run(userId, brandId, level);

  async function notifyBrand(brandId: string): Promise<void> {
    await createNotification(env, {
      type: "brand_threat", severity: "high", title: "t", message: "m",
      audience: "tenant", brandId, groupKey: `brand_threat:${brandId}`,
    });
  }

  it("a pre-gate cross-tenant subscription is inert: org-B's brand never reaches the org-A client", async () => {
    insertSub("usr_b", BRAND_B);
    insertSub("usr_a", BRAND_B); // written before the PUT gate existed
    await notifyBrand(BRAND_B);
    expect(recipients(raw)).toEqual(["usr_b"]);
  });

  it("staff subscribers keep receiving brands no org of theirs owns", async () => {
    insertSub("usr_staff", BRAND_B);
    insertSub("usr_staff", BRAND_UNCLAIMED);
    await notifyBrand(BRAND_B);
    await notifyBrand(BRAND_UNCLAIMED);
    expect(recipients(raw)).toEqual(["usr_staff", "usr_staff"]);
  });

  it("a client stops receiving once their org membership is no longer active", async () => {
    insertSub("usr_a", BRAND_A);
    raw.prepare(`UPDATE org_members SET status = 'suspended' WHERE user_id = 'usr_a'`).run();
    await notifyBrand(BRAND_A);
    expect(recipients(raw)).toEqual([]);
  });

  it("a client stops receiving once their org releases the brand", async () => {
    insertSub("usr_a", BRAND_A);
    raw.prepare(`DELETE FROM org_brands WHERE org_id = ? AND brand_id = ?`).run(ORG_A, BRAND_A);
    await notifyBrand(BRAND_A);
    expect(recipients(raw)).toEqual([]);
  });

  it("explicit opts.userId is untouched by the subscriber filter", async () => {
    await createNotification(env, {
      userId: "usr_a", type: "brand_threat", severity: "high", title: "t", message: "m",
      audience: "tenant", brandId: BRAND_B, groupKey: "brand_threat:direct",
    });
    expect(recipients(raw)).toEqual(["usr_a"]);
  });
});

describe.skipIf(!hasSqlite())("brand subscriptions — list", () => {
  it("a client's list omits rows on brands their org doesn't own; staff see all", async () => {
    const { raw, env } = setup();
    const insertSub = (u: string, b: string) =>
      raw.prepare(`INSERT INTO notification_subscriptions (user_id, brand_id, level) VALUES (?, ?, 'watching')`).run(u, b);
    insertSub("usr_a", BRAND_A);
    insertSub("usr_a", BRAND_B); // stale cross-tenant row
    insertSub("usr_staff", BRAND_B);
    insertSub("usr_staff", BRAND_UNCLAIMED);

    const req = () => new Request("https://averrow.test/api/notifications/subscriptions");
    const clientBody = await (await handleListSubscriptions(req(), env, "usr_a")).json() as {
      data: Array<{ brand_id: string; brand_name: string | null }>;
    };
    expect(clientBody.data.map((r) => r.brand_id)).toEqual([BRAND_A]);
    expect(JSON.stringify(clientBody)).not.toContain(`Name of ${BRAND_B}`);

    const staffBody = await (await handleListSubscriptions(req(), env, "usr_staff")).json() as {
      data: Array<{ brand_id: string }>;
    };
    expect(staffBody.data.map((r) => r.brand_id).sort()).toEqual([BRAND_B, BRAND_UNCLAIMED].sort());
  });
});
