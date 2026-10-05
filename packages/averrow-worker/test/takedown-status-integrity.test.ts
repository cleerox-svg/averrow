// TK1 (Phase 1 PR-B) — takedown status-flip integrity gate.
//
// handleAdminUpdateTakedown must NOT stamp status='submitted' (a claim
// that "Averrow sent this") unless the takedown has legal standing:
// an owning org, that owns the target brand, holding an active takedown
// authorization covering the module — the SAME standing Sparrow Phase G
// requires before any real dispatch. These tests are the compensating
// control: this change ships straight to prod, so the gate is verified
// here rather than in staging.

import { describe, it, expect } from "vitest";
import { handleAdminUpdateTakedown } from "../src/handlers/takedowns";
import { roleHasPermission } from "../src/lib/role-permissions";
import type { UserRole } from "../src/types";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

// ─── AuthContexts ────────────────────────────────────────────

const ANALYST: AuthContext = {
  userId: "u-analyst", email: "soc@averrow.local", role: "analyst",
  orgId: null, orgRole: null, embeddedScope: undefined,
};

// ─── KV mock (getActiveAuthorization caches through env.CACHE) ─

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

// ─── DB mock ─────────────────────────────────────────────────

interface TakedownRow {
  id: string; status: string;
  org_id: number | null; brand_id: string | null; module_key: string | null;
  // G21 consent inputs (optional — absent = draft-like, not customer-approved).
  severity?: string | null; requested_at?: string | null; requested_by?: string | null;
}

// mode 'auto' by default so these TK1 tests isolate the STANDING gate; the
// customer-consent (G21) matrix lives in takedown-staff-consent.test.ts.
interface AuthRowScope { modules: string[]; mode: string }

interface Fixture {
  takedownRow: TakedownRow | null;
  ownsBrand?: boolean;        // org_brands membership
  authModules?: string[] | null; // active authorization scope.modules, or null = no auth
}

interface CapturedRun { sql: string; binds: unknown[] }

function makeDb(fx: Fixture) {
  const runs: CapturedRun[] = [];

  function prepare(sql: string) {
    return {
      bind: (...binds: unknown[]) => ({
        run: async () => { runs.push({ sql, binds }); return { success: true, meta: { changes: 1 } }; },
        first: async <T>() => {
          // Primary load in the handler.
          if (sql.includes("FROM takedown_requests") && sql.includes("module_key") && sql.includes("WHERE id = ?")) {
            return fx.takedownRow as T | null;
          }
          // Post-update org lookup for emitOrgEvent.
          if (sql.includes("SELECT org_id FROM takedown_requests")) {
            return (fx.takedownRow ? { org_id: fx.takedownRow.org_id } : null) as T | null;
          }
          // Brand-ownership check.
          if (sql.includes("FROM org_brands")) {
            return (fx.ownsBrand ? ({ 1: 1 } as unknown) : null) as T | null;
          }
          // Active authorization lookup (inside getActiveAuthorization).
          if (sql.includes("FROM takedown_authorizations")) {
            if (fx.authModules == null) return null;
            const scope: AuthRowScope = { modules: fx.authModules, mode: "auto" };
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
          return null;
        },
        // org_modules: the org is entitled to every module (M1 is covered in
        // takedown-staff-consent.test.ts).
        all: async <T>() => {
          if (sql.includes("FROM org_modules")) {
            return {
              results: ["domain", "social", "app_store"].map((m) => ({
                module_key: m, status: "active", activated_at: "2026-01-01T00:00:00Z",
                suspended_at: null, trial_ends_at: null, config_json: null,
              })) as unknown as T[],
            };
          }
          return { results: [] as T[] };
        },
      }),
    };
  }
  return { prepare, runs };
}

function makeEnv(fx: Fixture): { env: Env; runs: CapturedRun[] } {
  const db = makeDb(fx);
  // AUDIT_DB is exercised by audit(); it swallows its own errors but give
  // it a no-op so we don't spam console. CACHE backs getActiveAuthorization.
  const env = {
    DB: db,
    AUDIT_DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true }) }) }) },
    CACHE: new MockKV(),
  } as unknown as Env;
  return { env, runs: db.runs };
}

function patch(status: string, extra: Record<string, unknown> = {}): Request {
  return new Request("https://averrow.com/api/admin/takedowns/td1", {
    method: "PATCH",
    headers: { Origin: "https://averrow.com", "Content-Type": "application/json" },
    body: JSON.stringify({ status, ...extra }),
  });
}

const submittedRuns = (runs: CapturedRun[]) =>
  runs.filter((r) => r.sql.includes("UPDATE takedown_requests") && r.sql.includes("submitted_at"));
const anyUpdate = (runs: CapturedRun[]) =>
  runs.filter((r) => r.sql.includes("UPDATE takedown_requests"));
const anyDispatch = (runs: CapturedRun[]) =>
  runs.filter((r) => r.sql.includes("takedown_submissions"));

// ─── Tests ───────────────────────────────────────────────────

describe("handleAdminUpdateTakedown — →submitted standing gate (TK1)", () => {
  it("1. orgless draft→submitted → 422, row unchanged, no submitted_at stamp", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "draft", org_id: null, brand_id: "b1", module_key: "domain" },
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(422);
    expect(anyUpdate(runs)).toHaveLength(0);
    expect(submittedRuns(runs)).toHaveLength(0);
  });

  it("2. org owns brand but NO active authorization → 403, row unchanged", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "draft", org_id: 42, brand_id: "b1", module_key: "domain" },
      ownsBrand: true,
      authModules: null,
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(403);
    expect(anyUpdate(runs)).toHaveLength(0);
  });

  it("3. org owns brand + authorization covers module → 200, stamped, no dispatch", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "draft", org_id: 42, brand_id: "b1", module_key: "domain" },
      ownsBrand: true,
      authModules: ["domain", "social"],
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(200);
    const stamped = submittedRuns(runs);
    expect(stamped).toHaveLength(1);
    // submitted_by bound to the acting user.
    expect(stamped[0].binds).toContain("u-analyst");
    // The gate must NOT dispatch — no outbound submission row is written.
    expect(anyDispatch(runs)).toHaveLength(0);
  });

  it("4. authorization active but module NOT in scope → 403, row unchanged", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "draft", org_id: 42, brand_id: "b1", module_key: "domain" },
      ownsBrand: true,
      authModules: ["social", "app_store"], // 'domain' excluded
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(403);
    expect(anyUpdate(runs)).toHaveLength(0);
  });

  it("4b. org does NOT own the brand → 403, row unchanged", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "draft", org_id: 42, brand_id: "b1", module_key: "domain" },
      ownsBrand: false,
      authModules: ["domain"],
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(403);
    expect(anyUpdate(runs)).toHaveLength(0);
  });

  it("4c. org owns brand + auth but takedown has NULL module_key → 422 (missing field to establish standing)", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "draft", org_id: 42, brand_id: "b1", module_key: null },
      ownsBrand: true,
      authModules: ["domain"],
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(422);
    expect(anyUpdate(runs)).toHaveLength(0);
  });

  it("5. requested→submitted for an authorized org → 200 (both entry paths gated)", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "requested", org_id: 42, brand_id: "b1", module_key: "domain" },
      ownsBrand: true,
      authModules: ["domain"],
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(200);
    expect(submittedRuns(runs)).toHaveLength(1);
  });

  it("5b. requested→submitted for an orgless row → 422 (second entry path also gated)", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "requested", org_id: null, brand_id: "b1", module_key: "domain" },
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(422);
    expect(anyUpdate(runs)).toHaveLength(0);
  });
});

describe("handleAdminUpdateTakedown — non-submitted paths unaffected (TK1)", () => {
  it("6a. notes-only update on an orgless row → 200 (standing gate not reached)", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "draft", org_id: null, brand_id: "b1", module_key: "domain" },
    });
    const res = await handleAdminUpdateTakedown(
      new Request("https://averrow.com/api/admin/takedowns/td1", {
        method: "PATCH",
        headers: { Origin: "https://averrow.com", "Content-Type": "application/json" },
        body: JSON.stringify({ notes: "operator note" }),
      }),
      env, "td1", ANALYST,
    );
    expect(res.status).toBe(200);
    expect(submittedRuns(runs)).toHaveLength(0);
    expect(anyUpdate(runs)).toHaveLength(1); // the notes UPDATE
  });

  it("6b. severity-only change on an orgless row → 200 (standing gate not reached)", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "draft", org_id: null, brand_id: "b1", module_key: "domain" },
    });
    const res = await handleAdminUpdateTakedown(
      new Request("https://averrow.com/api/admin/takedowns/td1", {
        method: "PATCH",
        headers: { Origin: "https://averrow.com", "Content-Type": "application/json" },
        body: JSON.stringify({ severity: "HIGH" }), // no status field
      }),
      env, "td1", ANALYST,
    );
    expect(res.status).toBe(200);
    expect(submittedRuns(runs)).toHaveLength(0);
    expect(anyUpdate(runs)).toHaveLength(1);
  });

  it("6c. post-submission transition submitted→taken_down for an authorized row → 200", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "submitted", org_id: 42, brand_id: "b1", module_key: "domain" },
      ownsBrand: true,
      authModules: ["domain"],
    });
    const res = await handleAdminUpdateTakedown(patch("taken_down"), env, "td1", ANALYST);
    expect(res.status).toBe(200);
    // taken_down does not re-stamp submitted_at.
    expect(submittedRuns(runs)).toHaveLength(0);
    expect(anyUpdate(runs)).toHaveLength(1);
  });

  it("7. illegal transition blocked by the table (pending_response→submitted) → 400, gate not reached", async () => {
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "pending_response", org_id: 42, brand_id: "b1", module_key: "domain" },
      ownsBrand: true,
      authModules: ["domain"],
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(400);
    expect(anyUpdate(runs)).toHaveLength(0);
  });

  it("7b. terminal-state edge taken_down→submitted (unrestricted by table) now hits the standing gate → 422 when orgless", async () => {
    // Terminal states have no ADMIN_ALLOWED_TRANSITIONS entry, so the table
    // does not block transitions out of them. The new standing gate is the
    // net that now catches a spurious re-flip to 'submitted'.
    const { env, runs } = makeEnv({
      takedownRow: { id: "td1", status: "taken_down", org_id: null, brand_id: "b1", module_key: "domain" },
    });
    const res = await handleAdminUpdateTakedown(patch("submitted"), env, "td1", ANALYST);
    expect(res.status).toBe(422);
    expect(anyUpdate(runs)).toHaveLength(0);
  });
});

describe("PATCH /api/admin/takedowns/:id — six-persona RBAC (route-layer gate)", () => {
  // The route gates on requirePermission("manage_takedowns"). This asserts
  // which personas even reach handleAdminUpdateTakedown; the standing gate
  // above governs the ones that do.
  const reaches: Array<[UserRole, boolean]> = [
    ["client", false],       // no manage_takedowns → 403 at the route
    ["auditor", false],      // read-only seat: lacks manage_takedowns (a mutation)
    ["sales", false],        // lacks the flag
    ["billing", false],      // lacks the flag
    ["support", false],      // lacks the flag
    ["analyst", true],       // has manage_takedowns → reaches handler + standing gate
    ["admin", true],
    ["super_admin", true],
  ];

  it.each(reaches)("%s → manage_takedowns granted = %s", (role, expected) => {
    expect(roleHasPermission(role, "manage_takedowns")).toBe(expected);
  });
});
