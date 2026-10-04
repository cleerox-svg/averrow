// Tenant bulk alert update + resolveTenantUserLabels stay under D1's
// 100-bound-parameter limit. The SQLite harness itself allows ~32K binds,
// so the D1 here is wrapped to throw like production D1 does above 100.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/lib/org-events", () => ({
  emitOrgEvent: vi.fn(async () => {}),
}));

import {
  handleTenantBulkUpdateAlerts,
  resolveTenantUserLabels,
  AVERROW_SOC_LABEL,
} from "../src/handlers/tenantData";
import type { AuthContext } from "../src/middleware/auth";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const TABLES = ["users", "brands", "alerts", "org_brands", "org_members"];
const D1_MAX_BINDS = 100;

/** Wrap a D1 so any statement bound with >100 params throws (prod D1 behaviour). */
function bindLimited(db: D1Database, maxSeen: { n: number }): D1Database {
  return {
    ...db,
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          maxSeen.n = Math.max(maxSeen.n, args.length);
          if (args.length > D1_MAX_BINDS) throw new Error(`too many SQL variables (${args.length})`);
          return stmt.bind(...args);
        },
      } as D1PreparedStatement;
    },
  } as D1Database;
}

let raw: SqliteDb;
let env: Env;
let auditRuns: number;
let maxBinds: { n: number };

function makeEnv(): Env {
  auditRuns = 0;
  maxBinds = { n: 0 };
  const auditDb = {
    prepare: () => ({
      bind: () => ({
        run: async () => { auditRuns++; return { success: true, meta: {} }; },
      }),
    }),
  } as unknown as D1Database;
  return {
    DB: bindLimited(d1FromSqlite(raw), maxBinds),
    CACHE: fakeKv(),
    AUDIT_DB: auditDb,
  } as unknown as Env;
}

function seed(db: SqliteDb, alertCount: number): void {
  db.exec(`
    INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Brand One', 'one.example');
    INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b1');
  `);
  const user = db.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, ?, 'active')");
  user.run("t_alice", "alice@cust.example", "Alice Customer", "client");
  user.run("t_bob", "bob@cust.example", "Bob Customer", "client");
  db.prepare("INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (7, 't_alice', 'admin', 'active', 'manual')").run();
  db.prepare("INSERT INTO org_members (org_id, user_id, role, status, provisioned_by) VALUES (7, 't_bob', 'analyst', 'active', 'manual')").run();
  const alert = db.prepare(
    `INSERT INTO alerts (id, brand_id, user_id, org_id, alert_type, severity, title, summary, status, created_at, updated_at)
     VALUES (?, 'b1', 't_alice', NULL, 'phishing_detected', 'high', ?, 'summary', 'new', datetime('now'), datetime('now'))`,
  );
  for (let i = 0; i < alertCount; i++) alert.run(`al_${i}`, `Alert ${i}`);
}

const CLIENT: AuthContext = {
  userId: "t_alice", email: "alice@cust.example", role: "client",
  orgId: "7", orgRole: "admin", embeddedScope: undefined,
} as AuthContext;

function req(body: unknown): Request {
  return new Request("https://averrow.com/api/orgs/7/alerts/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `al_${i}`);
const countWhere = (where: string): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE ${where}`).all()[0] as { n: number }).n;

describe.skipIf(!hasSqlite())("tenant bulk alert update — D1 100-bind limit", () => {
  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    seed(raw, 91);
    env = makeEnv();
  });

  it("91 alert_ids → 400, nothing changes, no audit", async () => {
    const res = await handleTenantBulkUpdateAlerts(req({ alert_ids: ids(91), status: "resolved" }), env, "7", CLIENT);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("Too many alerts (max 90 per call)");
    expect(countWhere("status = 'new'")).toBe(91);
    expect(auditRuns).toBe(0);
  });

  it("90 alert_ids with the widest UPDATE (status + notes + assignee) → 200, stays ≤100 binds", async () => {
    const res = await handleTenantBulkUpdateAlerts(
      req({ alert_ids: ids(90), status: "resolved", notes: "batch closed", assigned_to: "t_bob" }),
      env, "7", CLIENT,
    );
    expect(res.status).toBe(200);
    expect((await res.json<{ data: { updated: number } }>()).data.updated).toBe(90);
    expect(countWhere("status = 'resolved' AND assigned_to = 't_bob' AND resolution_notes = 'batch closed'")).toBe(90);
    expect(countWhere("status = 'new'")).toBe(1);
    expect(maxBinds.n).toBeLessThanOrEqual(D1_MAX_BINDS);
    expect(auditRuns).toBe(1);
  });

  it("duplicate ids are collapsed before the cap", async () => {
    const res = await handleTenantBulkUpdateAlerts(
      req({ alert_ids: [...ids(90), "al_0", ""], status: "acknowledged" }),
      env, "7", CLIENT,
    );
    expect(res.status).toBe(200);
    expect((await res.json<{ data: { updated: number } }>()).data.updated).toBe(90);
  });
});

describe.skipIf(!hasSqlite())("resolveTenantUserLabels — chunked lookups", () => {
  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    const user = raw.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, ?, 'active')");
    for (let i = 0; i < 149; i++) user.run(`u_${i}`, `u${i}@cust.example`, `User ${i}`, "client");
    user.run("u_staff", "sam@averrow.local", "Sam Staffer", "super_admin");
    env = makeEnv();
  });

  it("resolves 150 ids without exceeding 100 binds; staff stay masked", async () => {
    const all = [...Array.from({ length: 149 }, (_, i) => `u_${i}`), "u_staff", "u_0", null, "u_missing"];
    const labels = await resolveTenantUserLabels(env, all);
    expect(Object.keys(labels)).toHaveLength(150);
    expect(labels["u_0"]).toEqual({ name: "User 0", isStaff: false });
    expect(labels["u_148"]).toEqual({ name: "User 148", isStaff: false });
    expect(labels["u_staff"]).toEqual({ name: AVERROW_SOC_LABEL, isStaff: true });
    expect(labels["u_missing"]).toBeUndefined();
    expect(maxBinds.n).toBeLessThanOrEqual(90);
  });
});
