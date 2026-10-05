/**
 * takedown_requests.module_key — every writer sets it from target_type.
 *
 * Every send path (Sparrow Phase G auto-submit, staff mark-submitted, staff
 * hand-submit) refuses a takedown whose module_key is NULL. The customer
 * route (POST /api/orgs/:orgId/takedowns) and the ops bulk-takedown route
 * (POST /api/alerts/bulk-takedown) never set it, so their drafts could never
 * be sent. Pins:
 *   - the shared mapping (lib/takedown-module-key.ts),
 *   - both creation paths writing module_key (real handlers over a
 *     migration-derived node:sqlite schema — test/sqlite-d1-harness.ts),
 *   - migration 0284 backfilling NULLs with the SAME mapping, never
 *     overwriting a set key, idempotent.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/lib/org-events", () => ({
  emitOrgEvent: vi.fn(async () => {}),
}));

import {
  moduleKeyForTargetType,
  TAKEDOWN_TARGET_TYPE_MODULE_KEYS,
} from "../src/lib/takedown-module-key";
import { MODULE_KEYS } from "../src/lib/entitlements";
import { handleCreateTakedown } from "../src/handlers/takedowns";
import { handleBulkTakedown } from "../src/handlers/alerts";
import type { AuthContext } from "../src/middleware/auth";
import type { Env } from "../src/types";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";

const MIGRATION = readFileSync(
  join(__dirname, "..", "migrations", "0284_takedown_module_key_backfill.sql"),
  "utf8",
);

// ─── Helper ─────────────────────────────────────────────────────

describe("moduleKeyForTargetType", () => {
  it("maps every known target_type to the module Sparrow has always written", () => {
    expect(moduleKeyForTargetType("domain")).toBe("domain");
    expect(moduleKeyForTargetType("url")).toBe("domain");
    expect(moduleKeyForTargetType("social_profile")).toBe("social");
    expect(moduleKeyForTargetType("mobile_app")).toBe("app_store");
    expect(moduleKeyForTargetType("paste")).toBe("dark_web");
  });

  it("returns null for a target_type with no module (keeps the send paths refusing it)", () => {
    expect(moduleKeyForTargetType("email")).toBeNull();
    expect(moduleKeyForTargetType("something_new")).toBeNull();
    expect(moduleKeyForTargetType("")).toBeNull();
    expect(moduleKeyForTargetType(null)).toBeNull();
    expect(moduleKeyForTargetType(undefined)).toBeNull();
  });

  it("is not fooled by Object.prototype keys", () => {
    expect(moduleKeyForTargetType("toString")).toBeNull();
    expect(moduleKeyForTargetType("__proto__")).toBeNull();
    expect(moduleKeyForTargetType("constructor")).toBeNull();
  });

  it("only ever yields canonical MODULE_KEYS", () => {
    for (const key of Object.values(TAKEDOWN_TARGET_TYPE_MODULE_KEYS)) {
      expect(MODULE_KEYS).toContain(key);
    }
  });

  it("every Sparrow creator's literal (module_key, target_type) pair agrees with the mapping", () => {
    const src = readFileSync(join(__dirname, "..", "src", "agents", "sparrow.ts"), "utf8");
    // Column order in every Sparrow INSERT: id, org_id, brand_id, module_key, target_type, …
    const pairs = [...src.matchAll(/VALUES \(\?, \?, \?, '([a-z_]+)', '([a-z_]+)'/g)]
      .map((m) => ({ moduleKey: m[1], targetType: m[2] }));
    expect(pairs.length).toBe(6);
    for (const { moduleKey, targetType } of pairs) {
      expect(moduleKeyForTargetType(targetType), `Sparrow target_type '${targetType}'`).toBe(moduleKey);
    }
  });

  it("migration 0284 encodes exactly the same mapping", () => {
    const pairs = [...MIGRATION.matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+'([a-z_]+)'/g)]
      .map((m) => [m[1], m[2]] as const);
    expect(Object.fromEntries(pairs)).toEqual({ ...TAKEDOWN_TARGET_TYPE_MODULE_KEYS });
    const inList = /target_type IN \(([^)]*)\)/.exec(MIGRATION)?.[1] ?? "";
    const listed = [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(Object.keys(TAKEDOWN_TARGET_TYPE_MODULE_KEYS).sort());
  });
});

// ─── Creation paths ─────────────────────────────────────────────

const TABLES = ["users", "brands", "alerts", "org_brands", "takedown_requests"];

const CLIENT: AuthContext = {
  userId: "t_alice", email: "alice@cust.example", role: "client",
  orgId: "7", orgRole: "analyst", embeddedScope: undefined,
} as AuthContext;

function req(body: unknown): Request {
  return new Request("https://averrow.com/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function moduleKeyOf(db: SqliteDb, where: string, ...p: unknown[]): unknown[] {
  return db.prepare(`SELECT module_key FROM takedown_requests WHERE ${where}`).all(...p)
    .map((r) => (r as { module_key: unknown }).module_key);
}

describe.skipIf(!hasSqlite())("takedown creation paths write module_key", () => {
  let raw: SqliteDb;
  let env: Env;

  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    raw.exec(`
      INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Brand One', 'one.example');
      INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b1');
    `);
    // No AUDIT_DB — audit() swallows its own errors.
    env = { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
  });

  describe("customer route — POST /api/orgs/:orgId/takedowns", () => {
    // target_type 'domain' is not exercised here: its provider auto-detect
    // reads `provider_abuse_contacts`, a table no migration creates, so the
    // derived schema can't run that branch (pre-existing, tracked separately).
    // The insert binds module_key through the same helper for every type.
    const cases: Array<[string, string | null]> = [
      ["url", "domain"],
      ["social_profile", "social"],
      ["mobile_app", "app_store"],
      ["email", null],
    ];
    for (const [targetType, expected] of cases) {
      it(`${targetType} → ${expected ?? "NULL"}`, async () => {
        const res = await handleCreateTakedown(
          req({
            brand_id: "b1", target_type: targetType, target_value: "evil.example",
            target_platform: targetType === "social_profile" ? "tiktok" : undefined,
            evidence_summary: "impersonation",
          }),
          env, "7", CLIENT,
        );
        expect(res.status).toBe(201);
        const { data } = await res.json<{ data: { id: string } }>();
        expect(moduleKeyOf(raw, "id = ?", data.id)).toEqual([expected]);
      });
    }
  });

  describe("ops route — POST /api/alerts/bulk-takedown", () => {
    it("every bulk draft carries module_key matching its target_type", async () => {
      const alert = raw.prepare(
        `INSERT INTO alerts (id, brand_id, user_id, org_id, alert_type, severity, title, summary, status, created_at, updated_at)
         VALUES (?, 'b1', 't_alice', ?, 'social_impersonation', 'high', ?, 'summary', 'new', datetime('now'), datetime('now'))`,
      );
      alert.run("a1", 7, "Fake account one");
      alert.run("a2", null, "Fake account two");

      const res = await handleBulkTakedown(req({ alert_ids: ["a1", "a2"] }), env, "u_staff", null);
      expect(res.status).toBe(200);
      expect((await res.json<{ data: { takedowns_created: number } }>()).data.takedowns_created).toBe(2);

      const rows = raw.prepare(
        "SELECT source_id, target_type, module_key FROM takedown_requests ORDER BY source_id",
      ).all();
      expect(rows).toEqual([
        { source_id: "a1", target_type: "social_profile", module_key: "social" },
        { source_id: "a2", target_type: "social_profile", module_key: "social" },
      ]);
    });
  });
});

// ─── Migration 0284 backfill ────────────────────────────────────

describe.skipIf(!hasSqlite())("migration 0284 — module_key backfill", () => {
  let db: SqliteDb;

  function seed(id: string, targetType: string, moduleKey: string | null, status = "draft"): void {
    db.prepare(
      `INSERT INTO takedown_requests (id, brand_id, target_type, target_value, evidence_summary, status, module_key)
       VALUES (?, 'b1', ?, 'v', 'e', ?, ?)`,
    ).run(id, targetType, status, moduleKey);
  }

  beforeEach(() => {
    db = openDerivedDb(["takedown_requests"]);
    seed("d", "domain", null);
    seed("u", "url", null, "submitted");
    seed("s", "social_profile", null);
    seed("m", "mobile_app", null);
    seed("p", "paste", null);
    seed("e", "email", null);
    // Already-set keys are never overwritten, even if they disagree with the map.
    seed("keep", "social_profile", "trademark");
  });

  const snapshot = () =>
    Object.fromEntries(
      db.prepare("SELECT id, module_key FROM takedown_requests ORDER BY id").all()
        .map((r) => [(r as { id: string }).id, (r as { module_key: unknown }).module_key]),
    );

  it("fills NULLs from target_type, leaves unknown types NULL, never overwrites", () => {
    db.exec(MIGRATION);
    expect(snapshot()).toEqual({
      d: "domain", u: "domain", s: "social", m: "app_store", p: "dark_web",
      e: null, keep: "trademark",
    });
  });

  it("is idempotent", () => {
    db.exec(MIGRATION);
    const first = snapshot();
    db.exec(MIGRATION);
    expect(snapshot()).toEqual(first);
  });

  it("agrees with moduleKeyForTargetType for every seeded NULL row", () => {
    db.exec(MIGRATION);
    const rows = db.prepare("SELECT target_type, module_key FROM takedown_requests WHERE id != 'keep'").all() as
      Array<{ target_type: string; module_key: string | null }>;
    for (const r of rows) expect(r.module_key).toBe(moduleKeyForTargetType(r.target_type));
  });
});
