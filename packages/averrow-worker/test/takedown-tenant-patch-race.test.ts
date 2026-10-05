// Tenant takedown PATCH is pinned to the status it read (2026-10-05).
//
// The handler validates the transition against the status it SELECTed,
// then UPDATEs. Without `AND status = ?` a concurrent change between the
// two (e.g. staff / Sparrow claiming the row to 'submitted') would be
// overwritten by a transition validated against stale state — a customer
// withdraw would clobber a live submission. Now: 409, row untouched.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/org-events", () => ({ emitOrgEvent: vi.fn(async () => undefined) }));

import { handleUpdateTakedown } from "../src/handlers/takedowns";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

const CUSTOMER: AuthContext = {
  userId: "t_cust", email: "cust@cust.example", role: "client",
  orgId: "42", orgRole: "admin", embeddedScope: undefined,
};

const READ_SQL = /FROM takedown_requests tr\s+JOIN org_brands/;

function setup(onRead?: (raw: SqliteDb) => void): { raw: SqliteDb; env: Env; audits: string[] } {
  const raw = openDerivedDb(["takedown_requests", "org_brands", "users"]);
  raw.exec("INSERT INTO org_brands (org_id, brand_id) VALUES (42, 'b1')");
  raw.prepare(
    `INSERT INTO takedown_requests (id, org_id, brand_id, target_type, target_value, evidence_summary,
       provider_name, module_key, status, severity, requested_at, requested_by)
     VALUES ('td1', 42, 'b1', 'domain', 'td1.example', 'phish', 'GoDaddy', 'domain', 'requested', 'HIGH',
       datetime('now'), 't_cust')`,
  ).run();

  const db = d1FromSqlite(raw);
  // Run `onRead` right after the handler's SELECT returns — i.e. a write
  // from another actor landing between the read and the UPDATE.
  const racingDb = {
    ...db,
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      if (!onRead || !READ_SQL.test(sql)) return stmt;
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            ...bound,
            first: async <T>() => {
              const row = await bound.first<T>();
              onRead(raw);
              return row;
            },
          };
        },
      };
    },
  };

  const audits: string[] = [];
  const AUDIT_DB = {
    prepare: () => ({ bind: (...b: unknown[]) => ({ run: async () => { audits.push(b[2] as string); return { success: true }; } }) }),
  };
  return { raw, env: { DB: racingDb, AUDIT_DB, CACHE: fakeKv() } as unknown as Env, audits };
}

const withdraw = (env: Env) =>
  handleUpdateTakedown(
    new Request("https://averrow.com/api/orgs/42/takedowns/td1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "withdrawn" }),
    }),
    env, "42", "td1", CUSTOMER,
  );

const row = (raw: SqliteDb) =>
  raw.prepare("SELECT status, resolution, requested_by FROM takedown_requests WHERE id = 'td1'").all()[0] as Record<string, unknown>;

describe.skipIf(!hasSqlite())("tenant takedown PATCH — status pin", () => {
  it("a concurrent claim to 'submitted' makes the customer's withdraw 409 and leaves the row submitted", async () => {
    const { raw, env, audits } = setup((r) => {
      r.exec("UPDATE takedown_requests SET status = 'submitted', submitted_at = datetime('now') WHERE id = 'td1'");
    });
    const res = await withdraw(env);
    expect(res.status).toBe(409);
    expect(row(raw)).toEqual({ status: "submitted", resolution: null, requested_by: "t_cust" });
    expect(audits).not.toContain("takedown_update");
  });

  it("without a race the withdraw still succeeds", async () => {
    const { raw, env } = setup();
    const res = await withdraw(env);
    expect(res.status).toBe(200);
    expect(row(raw)).toEqual({ status: "withdrawn", resolution: "withdrawn", requested_by: null });
  });
});
