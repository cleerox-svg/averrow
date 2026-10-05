/**
 * H2 (account redesign review): PATCH /api/notifications/preferences was a
 * full upsert — every toggle missing from the body was written as its
 * PREF_DEFAULTS value, so flipping one event reset every other event toggle
 * and both channel flags. It is now a partial upsert: a first write inserts
 * defaults + the given values; later writes touch only the columns present.
 *
 * Runs over the migration-derived schema in node:sqlite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import { handleUpdatePreferences } from "../src/handlers/notifications";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

function patch(body: unknown): Request {
  return new Request("https://x/api/notifications/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!hasSqlite())("handleUpdatePreferences — partial update (H2)", () => {
  let raw: SqliteDb;
  let env: Env;
  const row = (id: string): Row | undefined =>
    raw.prepare("SELECT * FROM notification_preferences WHERE user_id = ?").all(id)[0] as Row | undefined;

  beforeEach(() => {
    raw = openDerivedDb(["users", "notification_preferences"]);
    raw.prepare("INSERT INTO users (id, email, name, role, status) VALUES ('u1', 'u1@example.com', 'U', 'analyst', 'active')").run();
    env = { DB: d1FromSqlite(raw) } as unknown as Env;
  });

  it("PATCH {feed_health:false} leaves every other stored toggle untouched", async () => {
    raw.prepare(
      `INSERT INTO notification_preferences (user_id, feed_health, campaign_escalation, push_notifications, browser_notifications)
       VALUES ('u1', 1, 0, 1, 1)`,
    ).run();
    const res = await handleUpdatePreferences(patch({ feed_health: false }), env, "u1");
    expect(res.status).toBe(200);
    const r = row("u1")!;
    expect(r.feed_health).toBe(0);
    expect(r.campaign_escalation).toBe(0);     // was reset to the default (1) before the fix
    expect(r.push_notifications).toBe(1);      // was reset to the default (0) before the fix
    expect(r.browser_notifications).toBe(1);
  });

  it("first-ever PATCH creates the row with defaults plus the given value", async () => {
    expect(row("u1")).toBeUndefined();
    const res = await handleUpdatePreferences(patch({ push_notifications: true }), env, "u1");
    expect(res.status).toBe(200);
    const r = row("u1")!;
    expect(r.push_notifications).toBe(1);
    expect(r.browser_notifications).toBe(0);   // channel default
    expect(r.feed_health).toBe(1);             // event default
    expect(r.campaign_escalation).toBe(1);
  });

  it("a quiet-hours-only PATCH doesn't touch toggles (and seeds a missing row)", async () => {
    raw.prepare(
      `INSERT INTO notification_preferences (user_id, campaign_escalation, push_notifications) VALUES ('u1', 0, 1)`,
    ).run();
    await handleUpdatePreferences(patch({ quiet_hours_start: "22:00", quiet_hours_end: "07:00" }), env, "u1");
    const r = row("u1")!;
    expect(r.campaign_escalation).toBe(0);
    expect(r.push_notifications).toBe(1);
    expect(r.quiet_hours_start).toBe("22:00");
    expect(r.quiet_hours_end).toBe("07:00");
  });

  it("ignores body keys outside the allowlist and rejects a non-object body", async () => {
    const res = await handleUpdatePreferences(patch({ "feed_health = 0; --": true, bogus: false }), env, "u1");
    expect(res.status).toBe(200);
    expect(row("u1")!.feed_health).toBe(1);
    expect((await handleUpdatePreferences(patch([1, 2]), env, "u1")).status).toBe(400);
  });
});
