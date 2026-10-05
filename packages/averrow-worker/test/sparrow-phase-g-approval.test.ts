// G21 (owner decision 2026-10-05) — Sparrow Phase G uses the SAME notion of
// customer approval as the staff send paths (isCustomerApproved,
// lib/takedown-customer-approval.ts). A 'requested' row that staff set via
// the ops PATCH (no requested_at, or a staff requested_by) is NOT approved:
// it is judged on its characteristics like a draft. Rows the policy itself
// auto-files are unaffected. The dispatcher is mocked — no real send.

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

const createNotification = vi.fn(async () => undefined);
vi.mock("../src/lib/notifications", () => ({ createNotification }));

const emitOrgEvent = vi.fn(async () => undefined);
vi.mock("../src/lib/org-events", () => ({ emitOrgEvent }));

import { runPhaseGAutoSubmit } from "../src/agents/sparrow";
import { DEFAULT_SEMI_AUTO_RULES } from "../src/lib/takedown-policy";
import type { Env } from "../src/types";

type Mode = "off" | "semi_auto" | "auto";

interface Candidate {
  id: string; org_id: number; brand_id: string; module_key: string;
  target_type: string; target_value: string; target_url: string | null;
  evidence_summary: string; evidence_detail: string | null;
  provider_name: string; provider_abuse_contact: string | null; provider_method: string | null;
  severity: string; status: string;
  requested_at: string | null; requested_by: string | null;
}

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

const USERS: Record<string, string> = { "u-cust": "client", "u-staff": "analyst" };

function makeEnv(candidates: Candidate[], mode: Mode) {
  const flips: string[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => ({
          all: async <T>() => {
            if (sql.includes("FROM takedown_requests tr")) return { results: candidates as unknown as T[] };
            if (sql.includes("FROM org_modules")) {
              return {
                results: [{
                  module_key: "domain", status: "active", activated_at: "2026-01-01T00:00:00Z",
                  suspended_at: null, trial_ends_at: null, config_json: null,
                }] as unknown as T[],
              };
            }
            return { results: [] as T[] };
          },
          first: async <T>() => {
            if (sql.includes("FROM takedown_authorizations")) {
              const scope = {
                modules: ["domain"], max_takedowns_per_month: null,
                mode, semi_auto_rules: DEFAULT_SEMI_AUTO_RULES,
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
              return {
                id: 7, provider_name: "GoDaddy", provider_type: "registrar",
                abuse_email: "abuse@registrar.example", abuse_url: null,
                abuse_api_url: null, abuse_api_type: null, auto_submit_enabled: 1,
              } as unknown as T;
            }
            if (sql.includes("FROM users")) {
              const role = USERS[binds[0] as string];
              return (role ? { role } : null) as T | null;
            }
            return null;
          },
          run: async () => {
            if (sql.includes("UPDATE takedown_requests") && sql.includes("status = 'submitted'")) {
              flips.push(binds[0] as string);
            }
            return { success: true, meta: { changes: 1 } };
          },
        }),
      };
    },
  };
  const env = { DB, CACHE: new MockKV() } as unknown as Env;
  return { env, flips };
}

function cand(id: string, overrides: Partial<Candidate>): Candidate {
  return {
    id, org_id: 42, brand_id: "brand-1", module_key: "domain",
    target_type: "domain", target_value: `${id}.example`, target_url: null,
    evidence_summary: "phish", evidence_detail: null,
    provider_name: "GoDaddy", provider_abuse_contact: null, provider_method: "email",
    severity: "CRITICAL", status: "draft", requested_at: null, requested_by: null,
    ...overrides,
  };
}

const STAFF_SET = cand("staff-set", { status: "requested" });
const STAFF_APPROVER = cand("staff-approver", {
  status: "requested", requested_at: "2026-10-04T12:00:00Z", requested_by: "u-staff",
});
const CUSTOMER_APPROVED = cand("customer-approved", {
  status: "requested", requested_at: "2026-10-04T12:00:00Z", requested_by: "u-cust",
});
const POLICY_AUTO_DRAFT = cand("policy-auto", { status: "draft", severity: "LOW" });

const dispatchedIds = () =>
  dispatchSubmission.mock.calls.map((c) => (c as unknown as [unknown, { id: string }])[1].id);

beforeEach(() => {
  dispatchSubmission.mockClear();
  createNotification.mockClear();
  emitOrgEvent.mockClear();
});

describe("Sparrow Phase G — customer approval is provenance-checked (G21)", () => {
  it("semi_auto: staff-set 'requested' row is HELD (not auto-filed); customer is asked to approve", async () => {
    const { env, flips } = makeEnv([STAFF_SET], "semi_auto");
    const res = await runPhaseGAutoSubmit(env);
    expect(res).toEqual({ submitted: 0, skipped: 1 });
    expect(dispatchSubmission).not.toHaveBeenCalled();
    expect(flips).toEqual([]);
    expect(createNotification).toHaveBeenCalledWith(env, expect.objectContaining({ type: "takedown_awaiting_approval" }));
  });

  it("semi_auto: 'requested' with a STAFF requested_by is held too", async () => {
    const { env } = makeEnv([STAFF_APPROVER], "semi_auto");
    const res = await runPhaseGAutoSubmit(env);
    expect(res.submitted).toBe(0);
    expect(dispatchSubmission).not.toHaveBeenCalled();
  });

  it("semi_auto: customer-approved CRITICAL row is sent", async () => {
    const { env, flips } = makeEnv([CUSTOMER_APPROVED], "semi_auto");
    const res = await runPhaseGAutoSubmit(env);
    expect(res).toEqual({ submitted: 1, skipped: 0 });
    expect(dispatchedIds()).toEqual(["customer-approved"]);
    expect(flips).toEqual(["customer-approved"]);
  });

  it("semi_auto: policy-auto draft (LOW) is sent — unaffected by the approval change", async () => {
    const { env } = makeEnv([POLICY_AUTO_DRAFT], "semi_auto");
    const res = await runPhaseGAutoSubmit(env);
    expect(res.submitted).toBe(1);
    expect(dispatchedIds()).toEqual(["policy-auto"]);
  });

  it("semi_auto mixed batch: only the customer-approved and policy-auto rows go out", async () => {
    const { env } = makeEnv([STAFF_SET, CUSTOMER_APPROVED, POLICY_AUTO_DRAFT, STAFF_APPROVER], "semi_auto");
    const res = await runPhaseGAutoSubmit(env);
    expect(res).toEqual({ submitted: 2, skipped: 2 });
    expect(dispatchedIds().sort()).toEqual(["customer-approved", "policy-auto"]);
  });

  it("off: nothing auto-files — not even a customer-approved row (Sparrow's Manual semantics unchanged)", async () => {
    const { env } = makeEnv([STAFF_SET, CUSTOMER_APPROVED, POLICY_AUTO_DRAFT], "off");
    const res = await runPhaseGAutoSubmit(env);
    expect(res.submitted).toBe(0);
    expect(dispatchSubmission).not.toHaveBeenCalled();
  });

  it("auto: every row (incl. staff-set requested) is filed by policy", async () => {
    const { env } = makeEnv([STAFF_SET, CUSTOMER_APPROVED, POLICY_AUTO_DRAFT], "auto");
    const res = await runPhaseGAutoSubmit(env);
    expect(res.submitted).toBe(3);
  });
});
