// G21 (owner decision 2026-10-05) — staff-submit consent gate.
//
// Averrow staff must not send a takedown the customer hasn't authorized.
// BOTH staff send paths are covered here:
//   - hand-submit   POST  /api/admin/takedowns/:id/submit  (handleAdminSubmitTakedown)
//   - mark-submitted PATCH /api/admin/takedowns/:id {status:'submitted'}
//                                                          (handleAdminUpdateTakedown)
//
// Matrix: automation mode (off / semi_auto / auto) × row state
//   - draft, policy would auto-file (LOW)
//   - draft, policy holds for approval (CRITICAL)
//   - requested, CUSTOMER-approved (requested_at + non-staff requested_by)
//   - requested, staff-set (ops PATCH draft→requested — no requested_at)
//   - requested, requested_at set but requested_by is a staff account
// plus the M1 entitlement gate, the audit row on refusal, and the
// status-pinned writes. The submitter dispatcher is mocked — no real send.

import { describe, it, expect, vi, beforeEach } from "vitest";

const dispatchSubmission = vi.fn(async () => ({
  result: {
    outcome: "queued" as const,
    submitter_kind: "email_draft",
    submitter_target: "abuse@registrar.example",
    request_summary: "draft",
  },
  submission_id: "sub-1",
}));
vi.mock("../src/lib/takedown-submitters", () => ({ dispatchSubmission }));

const resolveProvider = vi.fn(async () => ({
  hosting_provider: null, hosting_ip: null, hosting_country: null,
  registrar: null, abuse_contact: null,
}));
vi.mock("../src/lib/provider-resolver", () => ({ resolveProvider }));

import { handleAdminSubmitTakedown, handleAdminUpdateTakedown } from "../src/handlers/takedowns";
import { evaluateStaffSendConsent, DEFAULT_SEMI_AUTO_RULES, type SemiAutoRules } from "../src/lib/takedown-policy";
import { normalizeScope, type AuthorizationScope } from "../src/lib/takedown-authorizations";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

const ANALYST: AuthContext = {
  userId: "u-analyst", email: "soc@averrow.local", role: "analyst",
  orgId: null, orgRole: null, embeddedScope: undefined,
};

type Mode = "off" | "semi_auto" | "auto";

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

interface Row {
  id: string; status: string;
  org_id: number | null; brand_id: string; module_key: string | null;
  target_type: string; target_value: string; target_url: string | null;
  evidence_summary: string; evidence_detail: string | null;
  provider_name: string | null; provider_abuse_contact: string | null;
  provider_method: string | null; severity: string;
  requested_at: string | null; requested_by: string | null;
  staff_severity_set_at: string | null;
}

interface Fixture {
  row: Row;
  mode: Mode;
  semiRules?: SemiAutoRules;
  enabledModules?: string[];
  /** users.role per id; missing id → no user row. */
  users?: Record<string, string>;
  providerType?: string;
  /** Force the status-pinned UPDATE to match nothing (concurrent change). */
  pinnedUpdateMisses?: boolean;
}

interface Captured { sql: string; binds: unknown[] }

function makeEnv(fx: Fixture) {
  const runs: Captured[] = [];
  const audits: Captured[] = [];
  let claimed = false;
  const users = fx.users ?? { "u-cust": "client", "u-staff": "analyst" };

  const DB = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => ({
          run: async () => {
            runs.push({ sql, binds });
            const isClaim = sql.includes("UPDATE takedown_requests") && sql.includes("status = 'submitted'");
            const isPinnedPatch = sql.includes("UPDATE takedown_requests") && sql.includes("AND status = ?");
            if (isClaim) {
              const changes = claimed || fx.pinnedUpdateMisses ? 0 : 1;
              claimed = true;
              return { success: true, meta: { changes } };
            }
            if (isPinnedPatch && fx.pinnedUpdateMisses) return { success: true, meta: { changes: 0 } };
            return { success: true, meta: { changes: 1 } };
          },
          first: async <T>() => {
            if (sql.includes("FROM takedown_requests") && sql.includes("WHERE id = ?")) return fx.row as T;
            if (sql.includes("FROM takedown_submissions") && sql.includes("outcome IN")) return null;
            if (sql.includes("SELECT COUNT(*)")) return ({ n: 0 } as unknown) as T;
            if (sql.includes("FROM org_brands")) return ({ 1: 1 } as unknown) as T;
            if (sql.includes("FROM users")) {
              // isCustomerApproved binds (org_id, requested_by).
              const role = users[binds[1] as string];
              return (role ? { role } : null) as T | null;
            }
            if (sql.includes("FROM takedown_authorizations")) {
              const scope = {
                modules: ["domain", "social"], max_takedowns_per_month: null,
                mode: fx.mode, semi_auto_rules: fx.semiRules ?? DEFAULT_SEMI_AUTO_RULES,
              };
              return {
                id: "auth-1", org_id: 42, agreement_version: "msa-2026-05", status: "active",
                signed_at: "2026-05-07T00:00:00Z", signed_by_user_id: "u-owner",
                signed_ip: null, signed_user_agent: null, scope_json: JSON.stringify(scope),
                revoked_at: null, revoked_by_user_id: null, revoked_reason: null,
                created_at: "2026-05-07T00:00:00Z", updated_at: "2026-05-07T00:00:00Z",
              } as unknown as T;
            }
            if (sql.includes("FROM takedown_providers")) {
              if (fx.providerType === undefined) {
                return {
                  id: 7, provider_name: "GoDaddy", provider_type: "registrar",
                  abuse_email: "abuse@registrar.example", abuse_url: null,
                  abuse_api_url: null, abuse_api_type: null, auto_submit_enabled: 0,
                } as unknown as T;
              }
              return {
                id: 7, provider_name: "GoDaddy", provider_type: fx.providerType,
                abuse_email: "abuse@registrar.example", abuse_url: null,
                abuse_api_url: null, abuse_api_type: null, auto_submit_enabled: 0,
              } as unknown as T;
            }
            return null;
          },
          all: async <T>() => {
            if (sql.includes("FROM org_modules")) {
              const mods = fx.enabledModules ?? ["domain", "social"];
              return {
                results: mods.map((m) => ({
                  module_key: m, status: "active", activated_at: "2026-01-01T00:00:00Z",
                  suspended_at: null, trial_ends_at: null, config_json: null,
                })) as unknown as T[],
              };
            }
            return { results: [] as T[] };
          },
        }),
      };
    },
  };

  const AUDIT_DB = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        run: async () => { audits.push({ sql, binds }); return { success: true }; },
      }),
    }),
  };

  const env = { DB, AUDIT_DB, CACHE: new MockKV() } as unknown as Env;
  return { env, runs, audits };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "td1", status: "draft", org_id: 42, brand_id: "brand-1",
    module_key: "domain", target_type: "domain", target_value: "evil.example",
    target_url: null, evidence_summary: "phish", evidence_detail: null,
    provider_name: "GoDaddy", provider_abuse_contact: null, provider_method: "email",
    severity: "LOW", requested_at: null, requested_by: null,
    staff_severity_set_at: null, ...overrides,
  };
}

// Row states.
const DRAFT_POLICY_AUTO = row({ status: "draft", severity: "LOW" });
const DRAFT_POLICY_HOLD = row({ status: "draft", severity: "CRITICAL" });
const CUSTOMER_APPROVED = row({
  status: "requested", severity: "CRITICAL",
  requested_at: "2026-10-04T12:00:00Z", requested_by: "u-cust",
});
const STAFF_REQUESTED = row({ status: "requested", severity: "CRITICAL" }); // ops draft→requested
const STAFF_APPROVER = row({
  status: "requested", severity: "CRITICAL",
  requested_at: "2026-10-04T12:00:00Z", requested_by: "u-staff",
});

const submitReq = () => new Request("https://averrow.com/api/admin/takedowns/td1/submit", {
  method: "POST", headers: { Origin: "https://averrow.com" },
});
const patchReq = () => new Request("https://averrow.com/api/admin/takedowns/td1", {
  method: "PATCH",
  headers: { Origin: "https://averrow.com", "Content-Type": "application/json" },
  body: JSON.stringify({ status: "submitted" }),
});

type Path = "hand_submit" | "mark_submitted";
const PATHS: Path[] = ["hand_submit", "mark_submitted"];

function callPath(path: Path, env: Env): Promise<Response> {
  return path === "hand_submit"
    ? handleAdminSubmitTakedown(submitReq(), env, "td1", ANALYST)
    : handleAdminUpdateTakedown(patchReq(), env, "td1", ANALYST);
}

/** Did the path actually send / stamp 'submitted'? */
function sent(path: Path, runs: Captured[]): boolean {
  if (path === "hand_submit") return dispatchSubmission.mock.calls.length > 0;
  return runs.some((r) => r.sql.includes("UPDATE takedown_requests") && r.sql.includes("submitted_at"));
}

function auditActions(audits: Captured[]): string[] {
  return audits.map((a) => a.binds[2] as string);
}

beforeEach(() => {
  dispatchSubmission.mockClear();
  resolveProvider.mockClear();
});

// [mode, label, row, expected HTTP status]
const MATRIX: Array<[Mode, string, Row, 200 | 409]> = [
  ["off",       "draft (policy would auto-file)",    DRAFT_POLICY_AUTO, 409],
  ["off",       "draft (policy holds)",              DRAFT_POLICY_HOLD, 409],
  ["off",       "customer-approved",                 CUSTOMER_APPROVED, 200],
  ["off",       "staff-set requested",               STAFF_REQUESTED,   409],
  ["off",       "requested by a staff account",      STAFF_APPROVER,    409],
  ["semi_auto", "draft (policy would auto-file)",    DRAFT_POLICY_AUTO, 200],
  ["semi_auto", "draft (policy holds)",              DRAFT_POLICY_HOLD, 409],
  ["semi_auto", "customer-approved",                 CUSTOMER_APPROVED, 200],
  ["semi_auto", "staff-set requested",               STAFF_REQUESTED,   409],
  ["semi_auto", "requested by a staff account",      STAFF_APPROVER,    409],
  ["auto",      "draft (policy would auto-file)",    DRAFT_POLICY_AUTO, 200],
  ["auto",      "draft (policy holds in semi)",      DRAFT_POLICY_HOLD, 200],
  ["auto",      "customer-approved",                 CUSTOMER_APPROVED, 200],
  ["auto",      "staff-set requested",               STAFF_REQUESTED,   200],
  ["auto",      "requested by a staff account",      STAFF_APPROVER,    200],
];

describe.each(PATHS)("G21 consent matrix — %s", (path) => {
  it.each(MATRIX)("mode=%s, %s → %i", async (mode, _label, r, expected) => {
    const { env, runs, audits } = makeEnv({ row: r, mode });
    const res = await callPath(path, env);
    expect(res.status).toBe(expected);
    if (expected === 200) {
      expect(sent(path, runs)).toBe(true);
      expect(auditActions(audits)).not.toContain("takedown_submit_refused_policy");
    } else {
      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/Waiting for the customer's approval under their automation policy/);
      expect(sent(path, runs)).toBe(false);
      expect(runs.some((x) => x.sql.includes("UPDATE takedown_requests"))).toBe(false);
      expect(auditActions(audits)).toContain("takedown_submit_refused_policy");
    }
  });

  it("refusal audit row carries path, mode, reason and outcome 'denied'", async () => {
    const { env, audits } = makeEnv({ row: DRAFT_POLICY_HOLD, mode: "semi_auto" });
    const res = await callPath(path, env);
    expect(res.status).toBe(409);
    const refusal = audits.find((a) => a.binds[2] === "takedown_submit_refused_policy");
    expect(refusal).toBeDefined();
    expect(refusal!.binds[1]).toBe("u-analyst");        // user_id
    expect(refusal!.binds[3]).toBe("takedown_request"); // resource_type
    expect(refusal!.binds[4]).toBe("td1");              // resource_id
    expect(refusal!.binds[8]).toBe("denied");           // outcome
    const details = JSON.parse(refusal!.binds[5] as string) as Record<string, unknown>;
    expect(details).toMatchObject({
      path, org_id: 42, module_key: "domain", status: "draft",
      mode: "semi_auto", reason: "awaiting_customer_approval", policy_decision: "approval",
    });
  });

  it("Manual mode refusal names the posture and audits reason manual_mode_requires_approval", async () => {
    const { env, audits } = makeEnv({ row: DRAFT_POLICY_AUTO, mode: "off" });
    const res = await callPath(path, env);
    const body = await res.json() as { error: string };
    expect(res.status).toBe(409);
    expect(body.error).toContain("(Manual)");
    const refusal = audits.find((a) => a.binds[2] === "takedown_submit_refused_policy")!;
    expect(JSON.parse(refusal.binds[5] as string)).toMatchObject({ reason: "manual_mode_requires_approval" });
  });

  it("customer approver whose user row no longer exists is not an approval (fail closed)", async () => {
    const { env, runs } = makeEnv({ row: CUSTOMER_APPROVED, mode: "off", users: {} });
    const res = await callPath(path, env);
    expect(res.status).toBe(409);
    expect(sent(path, runs)).toBe(false);
  });

  it("M1 — module not entitled → 403, nothing sent, entitlement refusal audited", async () => {
    const { env, runs, audits } = makeEnv({
      row: CUSTOMER_APPROVED, mode: "auto", enabledModules: ["social"],
    });
    const res = await callPath(path, env);
    expect(res.status).toBe(403);
    expect(sent(path, runs)).toBe(false);
    expect(runs.some((x) => x.sql.includes("UPDATE takedown_requests"))).toBe(false);
    expect(auditActions(audits)).toContain("takedown_submit_refused_entitlement");
    expect(auditActions(audits)).not.toContain("takedown_submit_refused_policy");
  });

  it("semi-auto provider axis: provider_type outside the signed rules → 409", async () => {
    const { env, runs } = makeEnv({
      row: DRAFT_POLICY_AUTO, mode: "semi_auto",
      semiRules: { auto_severities: ["LOW"], auto_target_types: [], auto_provider_types: ["hosting"] },
      providerType: "registrar",
    });
    const res = await callPath(path, env);
    expect(res.status).toBe(409);
    expect(sent(path, runs)).toBe(false);
  });

  it("semi-auto provider axis: matching provider_type → 200", async () => {
    const { env, runs } = makeEnv({
      row: DRAFT_POLICY_AUTO, mode: "semi_auto",
      semiRules: { auto_severities: ["LOW"], auto_target_types: [], auto_provider_types: ["hosting"] },
      providerType: "hosting",
    });
    const res = await callPath(path, env);
    expect(res.status).toBe(200);
    expect(sent(path, runs)).toBe(true);
  });

  it("status-pinned write: a concurrent status change → 409, nothing sent", async () => {
    const { env, runs } = makeEnv({ row: CUSTOMER_APPROVED, mode: "off", pinnedUpdateMisses: true });
    const res = await callPath(path, env);
    expect(res.status).toBe(409);
    expect(dispatchSubmission).not.toHaveBeenCalled();
    // The pinned UPDATE ran with the judged status as its last bind.
    const pinned = runs.find((x) => x.sql.includes("UPDATE takedown_requests") && x.sql.includes("AND status = ?"));
    expect(pinned).toBeDefined();
    expect(pinned!.binds[pinned!.binds.length - 1]).toBe("requested");
  });
});

describe("G21 — mark-submitted path specifics", () => {
  it("withdrawn → submitted is refused even under Auto — withdrawn is terminal for staff (400, nothing written)", async () => {
    const { env, runs } = makeEnv({ row: row({ status: "withdrawn" }), mode: "auto" });
    const res = await handleAdminUpdateTakedown(patchReq(), env, "td1", ANALYST);
    expect(res.status).toBe(400);
    expect(runs.some((x) => x.sql.includes("UPDATE takedown_requests"))).toBe(false);
  });

  it("no provider directory row → provider_type null → provider-restricted semi-auto rule holds (409)", async () => {
    const { env } = makeEnv({
      row: row({ provider_name: null }), mode: "semi_auto",
      semiRules: { auto_severities: ["LOW"], auto_target_types: [], auto_provider_types: ["registrar"] },
    });
    const res = await handleAdminUpdateTakedown(patchReq(), env, "td1", ANALYST);
    expect(res.status).toBe(409);
  });

  it("non-submitted transitions (draft → withdrawn) skip the consent gate", async () => {
    const { env, audits } = makeEnv({ row: DRAFT_POLICY_HOLD, mode: "off", enabledModules: [] });
    const res = await handleAdminUpdateTakedown(
      new Request("https://averrow.com/api/admin/takedowns/td1", {
        method: "PATCH",
        headers: { Origin: "https://averrow.com", "Content-Type": "application/json" },
        body: JSON.stringify({ status: "withdrawn" }),
      }),
      env, "td1", ANALYST,
    );
    expect(res.status).toBe(200);
    expect(auditActions(audits)).not.toContain("takedown_submit_refused_policy");
    expect(auditActions(audits)).not.toContain("takedown_submit_refused_entitlement");
  });
});

describe("evaluateStaffSendConsent — pure decision", () => {
  const scope = (mode: Mode, rules: SemiAutoRules = DEFAULT_SEMI_AUTO_RULES): AuthorizationScope =>
    normalizeScope({ modules: ["domain"], mode, semi_auto_rules: rules });
  const base = {
    status: "draft", customer_approved: false, severity: "LOW", severity_set_by_staff: false,
    target_type: "domain", provider_type: "registrar",
  };

  it("customer approval wins in every mode, including off", () => {
    for (const m of ["off", "semi_auto", "auto"] as Mode[]) {
      expect(evaluateStaffSendConsent(scope(m), { ...base, status: "requested", customer_approved: true, severity: "CRITICAL" }))
        .toEqual({ allowed: true, basis: "customer_approved" });
    }
  });

  it("withdrawn is refused even when flagged approved", () => {
    expect(evaluateStaffSendConsent(scope("auto"), { ...base, status: "withdrawn", customer_approved: true }))
      .toEqual({ allowed: false, reason: "withdrawn_by_customer", decision: null });
  });

  it("an unapproved 'requested' row is judged like a draft (human_approved: false)", () => {
    expect(evaluateStaffSendConsent(scope("semi_auto"), { ...base, status: "requested", severity: "HIGH" }))
      .toEqual({ allowed: false, reason: "awaiting_customer_approval", decision: "approval" });
    expect(evaluateStaffSendConsent(scope("semi_auto"), { ...base, status: "requested", severity: "LOW" }))
      .toEqual({ allowed: true, basis: "policy_auto" });
  });

  it("off without approval → manual_mode_requires_approval", () => {
    expect(evaluateStaffSendConsent(scope("off"), base))
      .toEqual({ allowed: false, reason: "manual_mode_requires_approval", decision: "off" });
  });

  it("a staff-set severity is treated as unknown: never semi-auto-eligible, auto unaffected", () => {
    expect(evaluateStaffSendConsent(scope("semi_auto"), { ...base, severity_set_by_staff: true }))
      .toEqual({ allowed: false, reason: "awaiting_customer_approval", decision: "approval" });
    expect(evaluateStaffSendConsent(scope("auto"), { ...base, severity_set_by_staff: true }))
      .toEqual({ allowed: true, basis: "policy_auto" });
  });

  it("auto allows unapproved rows via policy", () => {
    expect(evaluateStaffSendConsent(scope("auto"), { ...base, severity: "CRITICAL" }))
      .toEqual({ allowed: true, basis: "policy_auto" });
  });
});
