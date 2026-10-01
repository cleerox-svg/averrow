/**
 * Drift guard: every key in the shared notification-event registry must be
 * accepted by the notifications.type CHECK constraint of the latest
 * migration that (re)defines it.
 *
 * createNotification refuses unknown keys up front, but a key that IS in
 * the registry and NOT in the CHECK passes that guard and then fails at
 * INSERT — which the caller's try/catch swallows. The notification simply
 * never exists. That has now happened three times (0207 and 0215 each
 * re-synced by hand; 0265 fixed the spam-trap freshness alerts, which
 * fired into the void for ~10 weeks while captures were at zero).
 *
 * Static, like brand-threat-correlator-schema-contract.test.ts: this
 * package has no SQLite engine in devDeps, so we parse the migration SQL.
 *
 * It also pins the second trap in that recreate dance: DROP TABLE
 * notifications cascades into notification_deliveries (ON DELETE CASCADE,
 * not stopped by defer_foreign_keys), so any migration after 0265 that
 * drops notifications must snapshot deliveries first.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NOTIFICATION_EVENTS } from "@averrow/shared";

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrations = readdirSync(dir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((name) => ({ name, sql: readFileSync(dir + name, "utf8").replace(/--[^\n]*/g, "") }));

/** Extract the type CHECK literal list from a CREATE TABLE for notifications (or its swap table). */
function typeCheckValues(sql: string): string[] | null {
  const create = /CREATE TABLE (?:IF NOT EXISTS )?(notifications\w*)\s*\(([\s\S]*?)\n\);/g;
  let found: string[] | null = null;
  for (const m of sql.matchAll(create)) {
    const check = /\btype\s+TEXT[^,]*?CHECK\s*\(\s*type\s+IN\s*\(([\s\S]*?)\)\s*\)/.exec(m[2]!);
    if (check) found = [...check[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  }
  return found;
}

const latest = [...migrations].reverse().find((m) => typeCheckValues(m.sql));

describe("notifications.type CHECK ⊇ NOTIFICATION_EVENTS", () => {
  it("finds a migration that defines the CHECK", () => {
    expect(latest, "no migration defines notifications.type CHECK").toBeDefined();
  });

  it("accepts every registered event key", () => {
    const allowed = new Set(typeCheckValues(latest!.sql));
    const missing = NOTIFICATION_EVENTS.map((e) => e.key).filter((k) => !allowed.has(k));
    expect(
      missing,
      `Registered in notification-events.ts but rejected by the CHECK in ${latest!.name}. ` +
        "INSERTs for these are silently dropped — add a migration widening the CHECK.",
    ).toEqual([]);
  });
});

// Every table with an FK into notifications(id). Today only
// notification_deliveries (0131); a future child is covered automatically.
const childTables = [
  ...new Set(
    migrations.flatMap((m) =>
      [...m.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/gi)]
        .filter((c) => /REFERENCES\s+notifications\s*\(/i.test(c[2]!))
        .map((c) => c[1]!),
    ),
  ),
];

/**
 * idx_notifications_dedup has been lost once already. Created in 0167 to
 * kill a documented ~12M reads/day, it was NOT recreated by the 0186 /
 * 0207 / 0215 / 0265 rebuilds, so it was absent from 0186 until 0272
 * restored it — and every createNotification call full-scanned
 * notifications in between. All six surviving indexes lead with user_id,
 * while a platform-wide dedup lookup has group_key set and user_id NULL,
 * so none of them can serve it.
 *
 * Deliberately scoped to THIS index rather than "every index ever
 * created": idx_notifications_user / idx_notifications_created were also
 * dropped by those rebuilds, but they have no uncovered call site (the
 * schema moved from read_at to `state`, and idx_notifications_inbox
 * serves the inbox reads), so reviving them would be write cost for no
 * read.
 */
describe("notifications rebuilds preserve the dedup index", () => {
  const dropRe = /DROP TABLE (?:IF EXISTS )?notifications\s*;/i;

  it("the dedup index exists in the migration set at all", () => {
    const defining = migrations.filter((m) =>
      /CREATE INDEX (?:IF NOT EXISTS )?idx_notifications_dedup/i.test(m.sql));
    expect(defining.map((m) => m.name)).toContain("0272_notifications_add_ai_calls_failing.sql");
  });

  it("every migration that rebuilds notifications from 0272 on recreates it", () => {
    const offenders = migrations
      .filter((m) => m.name >= "0272" && dropRe.test(m.sql))
      .filter((m) => !/CREATE INDEX (?:IF NOT EXISTS )?idx_notifications_dedup/i.test(m.sql))
      .map((m) => m.name);
    expect(
      offenders,
      "DROP TABLE notifications drops its indexes; without recreating the dedup index " +
        "every createNotification call reverts to a full table scan",
    ).toEqual([]);
  });

  it("the index recreated by the newest rebuild still covers (type, group_key, created_at)", () => {
    const newest = [...migrations].reverse().find((m) =>
      /CREATE INDEX (?:IF NOT EXISTS )?idx_notifications_dedup/i.test(m.sql))!;
    const decl = /CREATE INDEX (?:IF NOT EXISTS )?idx_notifications_dedup\s+ON notifications\(([^)]*)\)/i
      .exec(newest.sql);
    expect(decl, "dedup index declaration not parseable").not.toBeNull();
    const cols = decl![1]!.split(",").map((c) => c.trim().replace(/\s+DESC$/i, ""));
    // Both hot dedup paths seek on (type, group_key) then order by created_at.
    expect(cols.slice(0, 3)).toEqual(["type", "group_key", "created_at"]);
  });
});

describe("notifications rebuilds preserve FK child tables", () => {
  it("knows about notification_deliveries", () => {
    expect(childTables).toContain("notification_deliveries");
  });

  it("every migration from 0265 on that drops notifications snapshots and restores each child", () => {
    const dropRe = /DROP TABLE (?:IF EXISTS )?notifications\s*;/i;
    const offenders = migrations
      .filter((m) => m.name >= "0265" && dropRe.test(m.sql))
      .flatMap((m) => {
        const drop = m.sql.search(dropRe);
        return childTables
          .filter((t) => {
            const snap = m.sql.search(new RegExp(`CREATE TABLE \\w+ AS SELECT \\* FROM ${t}\\b`, "i"));
            const restore = m.sql.search(new RegExp(`INSERT (?:OR IGNORE )?INTO ${t} SELECT`, "i"));
            return !(snap !== -1 && snap < drop && restore > drop);
          })
          .map((t) => `${m.name}: ${t}`);
      });
    expect(offenders, "ON DELETE CASCADE wipes these on DROP TABLE notifications").toEqual([]);
  });
});
