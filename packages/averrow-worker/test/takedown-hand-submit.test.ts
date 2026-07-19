// TK2 (Phase 4 / Wave 2 S2.2) — analyst hand-submit takedown path.
//
// handleAdminSubmitTakedown dispatches a REAL external action, so it must be
// airtight on authorization. These tests assert the standing/consent gates
// Sparrow Phase G enforces are re-run here and NEVER bypassed by the human
// path, and that the ONLY thing dropped is the automation gate
// (auto_submit_enabled / auto-policy). The submitter dispatcher is mocked so
// no real send occurs.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the submitter dispatcher: assert dispatch happened / didn't, with
//    no real outbound send. dispatchSubmission normally records the
//    takedown_submissions row + honors TAKEDOWN_SEND_MODE; here it's a spy.
const dispatchSubmission = vi.fn(async () => ({
  result: {
    outcome: "queued" as const,      // draft outcome (ship-dark default)
    submitter_kind: "email_draft",
    submitter_target: "abuse@registrar.example",
    request_summary: "draft",
  },
  submission_id: "sub-1",
}));
vi.mock("../src/lib/takedown-submitters", () => ({ dispatchSubmission }));

// resolveProvider is only reached when provider_name is unset / unmatched;
// mock it so no DNS/network happens even on that fallback path.
const resolveProvider = vi.fn(async () => ({
  hosting_provider: null, hosting_ip: null, hosting_country: null,
  registrar: null, abuse_contact: null,
}));
vi.mock("../src/lib/provider-resolver", () => ({ resolveProvider }));

import { handleAdminSubmitTakedown } from "../src/handlers/takedowns";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

const ANALYST: AuthContext = {
  userId: "u-analyst", email: "soc@averrow.local", role: "analyst",
  orgId: null, orgRole: null, embeddedScope: undefined,
};

// ── KV mock (getActiveAuthorization caches through env.CACHE) ──
class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

interface TakedownRow {
  id: string; status: string;
  org_id: number | null; brand_id: string; module_key: string | null;
  target_type: string; target_value: string; target_url: string | null;
  evidence_summary: string; evidence_detail: string | null;
  provider_name: string | null; provider_abuse_contact: string | null;
  provider_method: string | null; severity: string;
}

interface Fixture {
  takedownRow: TakedownRow | null;
  ownsBrand?: boolean;
  authModules?: string[] | null;        // active authorization scope.modules; null = no auth
  capMax?: number | null;               // scope.max_takedowns_per_month; null = unlimited
  capUsed?: number;                      // this-month submitted count
  providerAutoSubmit?: number;           // takedown_providers.auto_submit_enabled (0/1)
  hasProvider?: boolean;                 // takedown_providers row exists for provider_name
  priorSubmission?: boolean;             // an existing submitted/queued submission row
}

interface CapturedRun { sql: string; binds: unknown[] }

function makeDb(fx: Fixture) {
  const runs: CapturedRun[] = [];
  // Simulates D1's atomic compare-and-swap on the claim UPDATE: the first
  // caller to flip the row out of draft/requested gets changes=1, everyone
  // else gets 0. Shared across all statements from this db instance so two
  // concurrent handler calls on the SAME env contend for it.
  let claimed = false;
  function prepare(sql: string) {
    const isClaim = sql.includes("UPDATE takedown_requests") && sql.includes("status = 'submitted'");
    return {
      bind: (...binds: unknown[]) => ({
        run: async () => {
          runs.push({ sql, binds });
          if (isClaim) {
            const changes = claimed ? 0 : 1;
            claimed = true;
            return { success: true, meta: { changes } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        first: async <T>() => {
          if (sql.includes("FROM takedown_requests") && sql.includes("WHERE id = ?")) {
            return fx.takedownRow as T | null;
          }
          if (sql.includes("FROM takedown_submissions") && sql.includes("outcome IN ('submitted', 'queued')")) {
            return (fx.priorSubmission ? ({ 1: 1 } as unknown) : null) as T | null;
          }
          if (sql.includes("SELECT COUNT(*)") && sql.includes("FROM takedown_submissions")) {
            return ({ n: fx.capUsed ?? 0 } as unknown) as T;
          }
          if (sql.includes("FROM org_brands")) {
            return (fx.ownsBrand ? ({ 1: 1 } as unknown) : null) as T | null;
          }
          if (sql.includes("FROM takedown_authorizations")) {
            if (fx.authModules == null) return null;
            const scope = { modules: fx.authModules, max_takedowns_per_month: fx.capMax ?? null };
            return {
              id: "auth-1", org_id: fx.takedownRow?.org_id ?? 0,
              agreement_version: "msa-2026-05", status: "active",
              signed_at: "2026-05-07T00:00:00Z", signed_by_user_id: "u-owner",
              signed_ip: null, signed_user_agent: null,
              scope_json: JSON.stringify(scope),
              revoked_at: null, revoked_by_user_id: null, revoked_reason: null,
              created_at: "2026-05-07T00:00:00Z", updated_at: "2026-05-07T00:00:00Z",
            } as unknown as T;
          }
          if (sql.includes("FROM takedown_providers")) {
            if (fx.hasProvider === false) return null;
            return {
              id: 7, provider_name: "GoDaddy", provider_type: "registrar",
              abuse_email: "abuse@registrar.example", abuse_url: null,
              abuse_api_url: null, abuse_api_type: null,
              auto_submit_enabled: fx.providerAutoSubmit ?? 0,
            } as unknown as T;
          }
          return null;
        },
        all: async <T>() => ({ results: [] as T[] }),
      }),
    };
  }
  return { prepare, runs };
}

function makeEnv(fx: Fixture): { env: Env; runs: CapturedRun[] } {
  const db = makeDb(fx);
  const env = {
    DB: db,
    AUDIT_DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true }) }) }) },
    CACHE: new MockKV(),
  } as unknown as Env;
  return { env, runs: db.runs };
}

function submitReq(): Request {
  return new Request("https://averrow.com/api/admin/takedowns/td1/submit", {
    method: "POST",
    headers: { Origin: "https://averrow.com" },
  });
}

const flipRuns = (runs: CapturedRun[]) =>
  runs.filter((r) => r.sql.includes("UPDATE takedown_requests") && r.sql.includes("status = 'submitted'"));

function baseRow(overrides: Partial<TakedownRow> = {}): TakedownRow {
  return {
    id: "td1", status: "requested", org_id: 42, brand_id: "brand-1",
    module_key: "domain", target_type: "domain", target_value: "evil.example",
    target_url: null, evidence_summary: "phish", evidence_detail: null,
    provider_name: "GoDaddy", provider_abuse_contact: null, provider_method: "email",
    severity: "HIGH", ...overrides,
  };
}

beforeEach(() => {
  dispatchSubmission.mockClear();
  resolveProvider.mockClear();
});

describe("TK2 — handleAdminSubmitTakedown", () => {
  it("(a) authorized org → dispatches, flips status, returns 200", async () => {
    const { env, runs } = makeEnv({
      takedownRow: baseRow(), ownsBrand: true, authModules: ["domain"], capMax: null,
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);
    const body = await res.json() as { success: boolean; data?: { outcome: string } };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.outcome).toBe("queued");
    expect(dispatchSubmission).toHaveBeenCalledTimes(1);
    expect(flipRuns(runs).length).toBe(1);
  });

  it("(b) org with NO authorization → 403, NO dispatch, NO status flip", async () => {
    const { env, runs } = makeEnv({
      takedownRow: baseRow(), ownsBrand: true, authModules: null,
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);

    expect(res.status).toBe(403);
    expect(dispatchSubmission).not.toHaveBeenCalled();
    expect(flipRuns(runs).length).toBe(0);
  });

  it("(b2) authorization does not cover the module → 403, NO dispatch", async () => {
    const { env } = makeEnv({
      takedownRow: baseRow({ module_key: "social" }), ownsBrand: true, authModules: ["domain"],
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);

    expect(res.status).toBe(403);
    expect(dispatchSubmission).not.toHaveBeenCalled();
  });

  it("(c) over the signed monthly cap → 409, NO dispatch", async () => {
    const { env, runs } = makeEnv({
      takedownRow: baseRow(), ownsBrand: true, authModules: ["domain"],
      capMax: 5, capUsed: 5,
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);

    expect(res.status).toBe(409);
    expect(dispatchSubmission).not.toHaveBeenCalled();
    expect(flipRuns(runs).length).toBe(0);
  });

  it("(d) already-submitted takedown → 409 idempotent, NO dispatch", async () => {
    const { env, runs } = makeEnv({
      takedownRow: baseRow({ status: "submitted" }), ownsBrand: true, authModules: ["domain"],
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);

    expect(res.status).toBe(409);
    expect(dispatchSubmission).not.toHaveBeenCalled();
    expect(flipRuns(runs).length).toBe(0);
  });

  it("(d2) existing successful submission row → 409 idempotent, NO dispatch", async () => {
    const { env } = makeEnv({
      takedownRow: baseRow(), ownsBrand: true, authModules: ["domain"], priorSubmission: true,
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);

    expect(res.status).toBe(409);
    expect(dispatchSubmission).not.toHaveBeenCalled();
  });

  it("(e) does NOT require auto_submit_enabled — dispatches with provider.auto_submit_enabled=0", async () => {
    const { env } = makeEnv({
      takedownRow: baseRow(), ownsBrand: true, authModules: ["domain"], capMax: null,
      providerAutoSubmit: 0, // the Phase-G automation gate would REJECT this
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);

    expect(res.status).toBe(200);
    expect(dispatchSubmission).toHaveBeenCalledTimes(1);
  });

  it("(f) orgless SOC takedown → 422, NO dispatch (authorization is org-scoped)", async () => {
    const { env } = makeEnv({
      takedownRow: baseRow({ org_id: null }), ownsBrand: true, authModules: ["domain"],
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);

    expect(res.status).toBe(422);
    expect(dispatchSubmission).not.toHaveBeenCalled();
  });

  it("(g) org does not own the target brand → 403, NO dispatch", async () => {
    const { env } = makeEnv({
      takedownRow: baseRow(), ownsBrand: false, authModules: ["domain"],
    });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);

    expect(res.status).toBe(403);
    expect(dispatchSubmission).not.toHaveBeenCalled();
  });

  it("(h) missing takedown → 404", async () => {
    const { env } = makeEnv({ takedownRow: null });
    const res = await handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST);
    expect(res.status).toBe(404);
    expect(dispatchSubmission).not.toHaveBeenCalled();
  });

  it("(i) F1 — two concurrent submits of the SAME takedown → exactly one dispatches, the other 409s", async () => {
    // Both requests pass the standing gates (they read the same unchanged
    // state); the atomic claim is the real guard. Only the winner dispatches.
    const { env, runs } = makeEnv({
      takedownRow: baseRow(), ownsBrand: true, authModules: ["domain"], capMax: null,
    });

    const [r1, r2] = await Promise.all([
      handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST),
      handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST),
    ]);
    const statuses = [r1.status, r2.status].sort();

    // Exactly one real dispatch — no double abuse report under live mode.
    expect(dispatchSubmission).toHaveBeenCalledTimes(1);
    // One winner (200) + one loser (409).
    expect(statuses).toEqual([200, 409]);
    // Only one row-claim UPDATE mutated the row (changes=1); the loser's
    // claim ran but changed nothing.
    const claimRuns = runs.filter(
      (r) => r.sql.includes("UPDATE takedown_requests") && r.sql.includes("status = 'submitted'"),
    );
    expect(claimRuns.length).toBe(2); // both attempted
  });
});
