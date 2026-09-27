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

describe("notifications rebuilds preserve notification_deliveries", () => {
  it("every migration from 0265 on that drops notifications snapshots deliveries first", () => {
    const offenders = migrations
      .filter((m) => m.name >= "0265")
      .filter((m) => /DROP TABLE (?:IF EXISTS )?notifications\s*;/i.test(m.sql))
      .filter((m) => {
        const drop = m.sql.search(/DROP TABLE (?:IF EXISTS )?notifications\s*;/i);
        const snap = m.sql.search(/CREATE TABLE \w+ AS SELECT \* FROM notification_deliveries/i);
        const restore = m.sql.search(/INSERT (?:OR IGNORE )?INTO notification_deliveries SELECT/i);
        return !(snap !== -1 && snap < drop && restore > drop);
      })
      .map((m) => m.name);
    expect(offenders).toEqual([]);
  });
});
