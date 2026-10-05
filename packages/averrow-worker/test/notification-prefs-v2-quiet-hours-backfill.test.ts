/**
 * Migration 0281 — copy complete legacy (v1) quiet-hours windows into
 * notification_preferences_v2 (owner decision D4: prefs consolidate on v2).
 *
 * Runs the REAL migration file over a migration-derived schema in node:sqlite
 * (the repo's D1 test lane — there is no miniflare harness). Pins: the copy,
 * never overwriting a complete v2 window, never touching an existing v2
 * critical flag, seeding the flag from v1 for a brand-new v2 row (so the
 * effective behaviour `v2 ?? v1` is unchanged), idempotence, and that
 * resolveQuietHours agrees before and after.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";
import { resolveQuietHours } from "../src/lib/notifications";

const MIGRATION = readFileSync(
  join(__dirname, "..", "migrations", "0281_notification_prefs_v2_quiet_hours_backfill.sql"),
  "utf8",
);

type Row = Record<string, unknown>;
const one = (db: SqliteDb, sql: string, ...p: unknown[]): Row =>
  (db.prepare(sql).all(...p)[0] ?? {}) as Row;

function addUser(db: SqliteDb, id: string): void {
  db.prepare(`INSERT INTO users (id, email, name, role, status) VALUES (?, ?, 'T', 'analyst', 'active')`)
    .run(id, `${id}@example.com`);
}
function addV1(db: SqliteDb, id: string, f: { start?: string | null; end?: string | null; tz?: string | null; crit?: number; push?: number }): void {
  db.prepare(
    `INSERT INTO notification_preferences
       (user_id, quiet_hours_start, quiet_hours_end, quiet_hours_tz, critical_breakthrough, push_notifications)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, f.start ?? null, f.end ?? null, f.tz ?? null, f.crit ?? 0, f.push ?? 0);
}
function addV2(db: SqliteDb, id: string, f: { start?: string | null; end?: string | null; tz?: string; crit?: number; push?: string } = {}): void {
  db.prepare(
    `INSERT INTO notification_preferences_v2
       (user_id, quiet_hours_start, quiet_hours_end, quiet_hours_timezone, critical_bypasses_quiet, push_severity_floor)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, f.start ?? null, f.end ?? null, f.tz ?? "UTC", f.crit ?? 1, f.push ?? "low");
}
const v2 = (db: SqliteDb, id: string): Row =>
  one(db, `SELECT * FROM notification_preferences_v2 WHERE user_id = ?`, id);

/** The row shape lib/notifications.ts feeds resolveQuietHours (v1 LEFT JOIN v2). */
function resolved(db: SqliteDb, id: string) {
  const r = one(
    db,
    `SELECT p.quiet_hours_start, p.quiet_hours_end, p.quiet_hours_tz, p.critical_breakthrough,
            v.quiet_hours_start AS v2_quiet_hours_start, v.quiet_hours_end AS v2_quiet_hours_end,
            v.quiet_hours_timezone AS v2_quiet_hours_timezone, v.critical_bypasses_quiet AS v2_critical_bypasses_quiet
       FROM notification_preferences p
       LEFT JOIN notification_preferences_v2 v ON v.user_id = p.user_id
      WHERE p.user_id = ?`,
    id,
  );
  const q = resolveQuietHours(r as unknown as Parameters<typeof resolveQuietHours>[0]);
  // push.ts isInQuietHours evaluates a null tz as UTC, so compare the EFFECTIVE zone.
  return q && { ...q, tz: q.tz || "UTC" };
}

describe.skipIf(!hasSqlite())("migration 0281: v1 quiet hours -> v2", () => {
  let db: SqliteDb;
  beforeEach(() => {
    db = openDerivedDb(["users", "notification_preferences", "notification_preferences_v2"]);
  });

  it("copies a complete v1 window (and tz) into an existing v2 row with no window, leaving the critical flag alone", () => {
    addUser(db, "u1");
    addV1(db, "u1", { start: "22:00", end: "07:00", tz: "America/Toronto", crit: 0 });
    addV2(db, "u1", { crit: 1 });
    const before = resolved(db, "u1");
    db.exec(MIGRATION);
    const row = v2(db, "u1");
    expect(row.quiet_hours_start).toBe("22:00");
    expect(row.quiet_hours_end).toBe("07:00");
    expect(row.quiet_hours_timezone).toBe("America/Toronto");
    expect(row.critical_bypasses_quiet).toBe(1);
    // Delivery resolution is identical before and after.
    expect(resolved(db, "u1")).toEqual(before);
  });

  it("never overwrites a complete v2 window", () => {
    addUser(db, "u2");
    addV1(db, "u2", { start: "21:00", end: "06:00", tz: "Europe/Paris" });
    addV2(db, "u2", { start: "23:30", end: "08:00", tz: "Asia/Tokyo", crit: 0 });
    db.exec(MIGRATION);
    const row = v2(db, "u2");
    expect(row.quiet_hours_start).toBe("23:30");
    expect(row.quiet_hours_end).toBe("08:00");
    expect(row.quiet_hours_timezone).toBe("Asia/Tokyo");
    expect(row.critical_bypasses_quiet).toBe(0);
  });

  it("overwrites a half-set v2 window (ignored by delivery) and keeps v2 tz when v1 has none", () => {
    addUser(db, "u3");
    addV1(db, "u3", { start: "22:00", end: "06:30", tz: null });
    addV2(db, "u3", { start: "10:00", end: null, tz: "Asia/Tokyo" });
    db.exec(MIGRATION);
    const row = v2(db, "u3");
    expect(row.quiet_hours_start).toBe("22:00");
    expect(row.quiet_hours_end).toBe("06:30");
    expect(row.quiet_hours_timezone).toBe("Asia/Tokyo");
  });

  it("inserts a v2 row when missing, seeding the critical flag from v1 and mirroring the v1 push toggle", () => {
    addUser(db, "u4");
    addV1(db, "u4", { start: "22:00", end: "07:00", tz: "America/Chicago", crit: 0, push: 0 });
    addUser(db, "u5");
    addV1(db, "u5", { start: "22:00", end: "07:00", crit: 1, push: 1 });
    const before4 = resolved(db, "u4");
    const before5 = resolved(db, "u5");
    db.exec(MIGRATION);

    const r4 = v2(db, "u4");
    expect(r4.quiet_hours_start).toBe("22:00");
    expect(r4.quiet_hours_timezone).toBe("America/Chicago");
    expect(r4.critical_bypasses_quiet).toBe(0);
    expect(r4.push_severity_floor).toBe("off");
    expect(r4.digest_mode).toBe("daily");
    expect(r4.email_severity_floor).toBe("high");

    const r5 = v2(db, "u5");
    expect(r5.critical_bypasses_quiet).toBe(1);
    expect(r5.push_severity_floor).toBe("low");
    expect(r5.quiet_hours_timezone).toBe("UTC");

    expect(resolved(db, "u4")).toEqual(before4);
    expect(resolved(db, "u5")).toEqual(before5);
  });

  it("ignores users without a complete v1 window (null, empty, half-set)", () => {
    for (const [id, f] of [
      ["n1", {}],
      ["n2", { start: "", end: "" }],
      ["n3", { start: "22:00", end: null }],
    ] as const) {
      addUser(db, id);
      addV1(db, id, f);
    }
    addV2(db, "n3");
    db.exec(MIGRATION);
    expect(one(db, `SELECT COUNT(*) AS n FROM notification_preferences_v2 WHERE user_id IN ('n1','n2')`).n).toBe(0);
    expect(v2(db, "n3").quiet_hours_start).toBeNull();
  });

  it("does not create a v2 row for a v1 row whose user is gone", () => {
    db.prepare(`INSERT INTO notification_preferences (user_id, quiet_hours_start, quiet_hours_end) VALUES ('ghost','22:00','07:00')`).run();
    db.exec(MIGRATION);
    expect(one(db, `SELECT COUNT(*) AS n FROM notification_preferences_v2`).n).toBe(0);
  });

  it("is idempotent", () => {
    addUser(db, "u6");
    addV1(db, "u6", { start: "22:00", end: "07:00", tz: "America/Toronto" });
    addV2(db, "u6");
    db.exec(MIGRATION);
    const first = v2(db, "u6");
    db.exec(MIGRATION);
    expect(v2(db, "u6")).toEqual(first);
  });
});
