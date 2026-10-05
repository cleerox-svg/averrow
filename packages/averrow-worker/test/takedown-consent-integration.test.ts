// G21 follow-up (appsec H1/H2/M1/M2/L2 + code-review, 2026-10-05) —
// end-to-end consent integrity over a REAL schema (node:sqlite, derived from
// migrations/), exercising the actual handlers and Sparrow phases:
//
//   H1/H2  a customer withdrawal can't be undone by staff; withdrawal clears
//          the approval stamp; failed/expired re-open only to draft and clear
//          the stamp; the staff table is default-deny.
//   CR     staff can't move a row INTO 'requested'; a staff-parked requested
//          row (no customer stamp) can be returned to draft, a
//          customer-approved one can't.
//   M1     Sparrow Phase G claims before it sends: a withdrawal landing
//          between its read and its send → no send.
//   M2     severity validation + audit; a staff severity change never by
//          itself makes a held takedown Semi-Auto-eligible (staff path AND
//          Phase G).
//   L2     approval requires an ACTIVE customer member of the row's org with
//          an active account.
//   Phase H follow-ups never fire for a withdrawn row.

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
const submitFollowup = vi.fn(async () => ({
  outcome: "queued" as const,
  submitter_kind: "followup_email_draft",
  submitter_target: "abuse@registrar.example",
  request_summary: "followup",
}));
const recordSubmissionAttempt = vi.fn(async () => "sub-f");
vi.mock("../src/lib/takedown-submitters", () => ({
  dispatchSubmission,
  followupDraftSubmitter: { submitFollowup },
  recordSubmissionAttempt,
}));
vi.mock("../src/lib/provider-resolver", () => ({
  resolveProvider: vi.fn(async () => ({
    hosting_provider: null, hosting_ip: null, hosting_country: null, registrar: null, abuse_contact: null,
  })),
}));
vi.mock("../src/lib/notifications", () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock("../src/lib/org-events", () => ({ emitOrgEvent: vi.fn(async () => undefined) }));

import {
  handleAdminUpdateTakedown, handleAdminSubmitTakedown, handleUpdateTakedown,
} from "../src/handlers/takedowns";
import { runPhaseGAutoSubmit, runPhaseHAutoFollowup } from "../src/agents/sparrow";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

const ANALYST: AuthContext = {
  userId: "u_soc", email: "soc@averrow.local", role: "analyst",
  orgId: null, orgRole: null, embeddedScope: undefined,
};
const CUSTOMER: AuthContext = {
  userId: "t_cust", email: "cust@cust.example", role: "client",
  orgId: "42", orgRole: "admin", embeddedScope: undefined,
};

type Mode = "off" | "semi_auto" | "auto";

let raw: SqliteDb;
let env: Env;
let audits: Array<{ action: string; outcome: string; details: Record<string, unknown> }>;

function setup(mode: Mode, opts: { slaHours?: number } = {}): void {
  raw = openDerivedDb([
    "takedown_requests", "takedown_submissions", "takedown_authorizations", "takedown_providers",
    "org_brands", "org_modules", "org_members", "users",
  ]);
  const scope = {
    modules: ["domain"], max_takedowns_per_month: null, escalation: "manual_only",
    auto_followup_breached_sla_hours: opts.slaHours ?? null, mode,
    semi_auto_rules: { auto_severities: ["LOW", "MEDIUM"], auto_target_types: [], auto_provider_types: [] },
  };
  raw.exec(`
    INSERT INTO org_brands (org_id, brand_id) VALUES (42, 'b1');
    INSERT INTO org_modules (org_id, module_key, status) VALUES (42, 'domain', 'active');
    INSERT INTO takedown_providers (provider_name, provider_type, abuse_email, auto_submit_enabled)
      VALUES ('GoDaddy', 'registrar', 'abuse@registrar.example', 1);
  `);
  raw.prepare(
    `INSERT INTO takedown_authorizations (id, org_id, agreement_version, status, signed_at, signed_by_user_id, scope_json)
     VALUES ('auth1', 42, 'v1', 'active', datetime('now'), 't_cust', ?)`,
  ).run(JSON.stringify(scope));
  const user = raw.prepare("INSERT INTO users (id, email, name, role, status) VALUES (?, ?, ?, ?, ?)");
  user.run("t_cust", "cust@cust.example", "Cust Admin", "client", "active");
  user.run("t_gone", "gone@cust.example", "Removed Member", "client", "active");
  user.run("t_off", "off@cust.example", "Disabled Account", "client", "deactivated");
  user.run("t_other", "other@else.example", "Other Org", "client", "active");
  user.run("u_soc", "soc@averrow.local", "SOC Analyst", "analyst", "active");
  const member = raw.prepare("INSERT INTO org_members (org_id, user_id, role, status) VALUES (?, ?, ?, ?)");
  member.run(42, "t_cust", "admin", "active");
  member.run(42, "t_gone", "analyst", "removed");
  member.run(42, "t_off", "analyst", "active");
  member.run(43, "t_other", "admin", "active");

  audits = [];
  const AUDIT_DB = {
    prepare: () => ({
      bind: (...b: unknown[]) => ({
        run: async () => {
          audits.push({
            action: b[2] as string, outcome: b[8] as string,
            details: b[5] ? JSON.parse(b[5] as string) as Record<string, unknown> : {},
          });
          return { success: true };
        },
      }),
    }),
  };
  env = { DB: d1FromSqlite(raw), AUDIT_DB, CACHE: fakeKv() } as unknown as Env;
}

function insertTakedown(id: string, fields: {
  status: string; severity?: string; requested_at?: string | null; requested_by?: string | null;
  submitted_at?: string | null;
}): void {
  raw.prepare(
    `INSERT INTO takedown_requests (id, org_id, brand_id, target_type, target_value, evidence_summary,
       provider_name, module_key, status, severity, requested_at, requested_by, submitted_at)
     VALUES (?, 42, 'b1', 'domain', ?, 'phish', 'GoDaddy', 'domain', ?, ?, ?, ?, ?)`,
  ).run(
    id, `${id}.example`, fields.status, fields.severity ?? "CRITICAL",
    fields.requested_at ?? null, fields.requested_by ?? null, fields.submitted_at ?? null,
  );
}

function get(id: string): Record<string, unknown> {
  return raw.prepare(
    "SELECT status, severity, requested_at, requested_by, resolved_at, resolution, staff_severity_set_at, submitted_at FROM takedown_requests WHERE id = ?",
  ).all(id)[0] as Record<string, unknown>;
}

const staffPatch = (id: string, body: Record<string, unknown>) =>
  handleAdminUpdateTakedown(
    new Request(`https://averrow.com/api/admin/takedowns/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    env, id, ANALYST,
  );
const staffSubmit = (id: string) =>
  handleAdminSubmitTakedown(
    new Request(`https://averrow.com/api/admin/takedowns/${id}/submit`, { method: "POST" }), env, id, ANALYST,
  );
const customerPatch = (id: string, body: Record<string, unknown>) =>
  handleUpdateTakedown(
    new Request(`https://averrow.com/api/orgs/42/takedowns/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    env, "42", id, CUSTOMER,
  );

beforeEach(() => {
  dispatchSubmission.mockClear();
  submitFollowup.mockClear();
  recordSubmissionAttempt.mockClear();
});

describe.skipIf(!hasSqlite())("G21 consent integrity — real schema", () => {
  describe("H1 — a customer withdrawal can't be undone", () => {
    it("customer approval clears on withdraw; no staff exit from withdrawn; nothing can be sent", async () => {
      setup("off");
      insertTakedown("td1", { status: "draft" });

      expect((await customerPatch("td1", { status: "requested" })).status).toBe(200);
      expect(get("td1")).toMatchObject({ status: "requested", requested_by: "t_cust" });
      expect(get("td1").requested_at).not.toBeNull();

      expect((await customerPatch("td1", { status: "withdrawn" })).status).toBe(200);
      expect(get("td1")).toMatchObject({ status: "withdrawn", requested_at: null, requested_by: null });

      for (const target of ["requested", "draft", "failed", "submitted", "pending_response", "taken_down"]) {
        const res = await staffPatch("td1", { status: target });
        expect(res.status, `withdrawn → ${target}`).toBe(400);
      }
      expect((await staffSubmit("td1")).status).toBe(409);
      expect(get("td1").status).toBe("withdrawn");
      expect(dispatchSubmission).not.toHaveBeenCalled();
    });

    it("withdrawn → requested → submit is refused even with a stale customer stamp on the row", async () => {
      setup("off");
      // A legacy withdrawn row still carrying the old approval stamp (pre-fix
      // withdrawals did not clear it).
      insertTakedown("td1", { status: "withdrawn", requested_at: "2026-10-01 00:00:00", requested_by: "t_cust" });

      expect((await staffPatch("td1", { status: "requested" })).status).toBe(400);
      expect((await customerPatch("td1", { status: "requested" })).status).toBe(400);
      expect((await staffPatch("td1", { status: "submitted" })).status).toBe(400);
      expect((await staffSubmit("td1")).status).toBe(409);
      expect(get("td1").status).toBe("withdrawn");
      expect(dispatchSubmission).not.toHaveBeenCalled();
    });

    it("Sparrow Phase G never picks up a withdrawn row, stale stamp or not", async () => {
      setup("auto");
      insertTakedown("td1", { status: "withdrawn", severity: "LOW", requested_at: "2026-10-01 00:00:00", requested_by: "t_cust" });
      const res = await runPhaseGAutoSubmit(env);
      expect(res.submitted).toBe(0);
      expect(dispatchSubmission).not.toHaveBeenCalled();
    });

    it("Phase H follow-ups never fire for a withdrawn row (control: a breached submitted row does)", async () => {
      setup("auto", { slaHours: 24 });
      const longAgo = sqliteTimestampHoursAgo(100);
      insertTakedown("td_withdrawn", { status: "withdrawn", submitted_at: longAgo });
      insertTakedown("td_live", { status: "submitted", submitted_at: longAgo });

      const res = await runPhaseHAutoFollowup(env);
      expect(res.followups).toBe(1);
      const ids = submitFollowup.mock.calls.map((c) => (c as unknown as [unknown, { id: string }])[1].id);
      expect(ids).toEqual(["td_live"]);
    });
  });

  describe("H2 — failed/expired re-open only to draft, clearing approval", () => {
    it("failed → submitted refused; failed → draft clears the stamp, so Manual mode then refuses the send", async () => {
      setup("off");
      insertTakedown("td1", { status: "failed", requested_at: "2026-10-01 00:00:00", requested_by: "t_cust" });
      raw.prepare("UPDATE takedown_requests SET resolved_at = datetime('now'), resolution = 'refused' WHERE id = 'td1'").run();

      expect((await staffPatch("td1", { status: "submitted" })).status).toBe(400);
      expect((await staffPatch("td1", { status: "requested" })).status).toBe(400);

      expect((await staffPatch("td1", { status: "draft" })).status).toBe(200);
      expect(get("td1")).toMatchObject({ status: "draft", requested_at: null, resolved_at: null, resolution: null });

      expect((await staffPatch("td1", { status: "submitted" })).status).toBe(409);
      expect((await staffSubmit("td1")).status).toBe(409);
      expect(dispatchSubmission).not.toHaveBeenCalled();
    });

    it("expired → draft only; taken_down is terminal", async () => {
      setup("auto");
      insertTakedown("td_exp", { status: "expired" });
      insertTakedown("td_down", { status: "taken_down" });
      expect((await staffPatch("td_exp", { status: "submitted" })).status).toBe(400);
      expect((await staffPatch("td_exp", { status: "draft" })).status).toBe(200);
      expect((await staffPatch("td_down", { status: "submitted" })).status).toBe(400);
      expect((await staffPatch("td_down", { status: "draft" })).status).toBe(400);
    });
  });

  describe("code review — staff can't create the approval state", () => {
    it("staff draft → requested is refused (400)", async () => {
      setup("semi_auto");
      insertTakedown("td1", { status: "draft" });
      expect((await staffPatch("td1", { status: "requested" })).status).toBe(400);
      expect(get("td1").status).toBe("draft");
    });

    it("a staff-parked 'requested' row (no customer stamp) can be returned to draft", async () => {
      setup("semi_auto");
      insertTakedown("td1", { status: "requested" });
      expect((await staffPatch("td1", { status: "draft" })).status).toBe(200);
      expect(get("td1").status).toBe("draft");
    });

    it("a customer-approved row can't be returned to draft by staff (409) and still sends", async () => {
      setup("semi_auto");
      insertTakedown("td1", { status: "draft" });
      expect((await customerPatch("td1", { status: "requested" })).status).toBe(200);
      const res = await staffPatch("td1", { status: "draft" });
      expect(res.status).toBe(409);
      expect(get("td1").status).toBe("requested");
      expect((await staffSubmit("td1")).status).toBe(200);
      expect(get("td1").status).toBe("submitted");
    });
  });

  describe("M1 — Phase G claims before sending", () => {
    it("a withdrawal landing between Phase G's read and its send → no send, row stays withdrawn", async () => {
      setup("auto");
      insertTakedown("td1", { status: "draft", severity: "LOW" });
      // Wrap the DB: right after the candidate SELECT, the customer withdraws.
      const real = env.DB;
      env = {
        ...env,
        DB: {
          prepare: (sql: string) => {
            const stmt = real.prepare(sql);
            if (!sql.includes("FROM takedown_requests tr") || !sql.includes("status IN ('draft', 'requested')")) return stmt;
            return {
              bind: (...b: unknown[]) => {
                const bound = stmt.bind(...b);
                return {
                  all: async () => {
                    const out = await bound.all();
                    raw.prepare("UPDATE takedown_requests SET status = 'withdrawn' WHERE id = 'td1'").run();
                    return out;
                  },
                };
              },
            };
          },
          batch: real.batch.bind(real),
        } as unknown as D1Database,
      } as Env;

      const res = await runPhaseGAutoSubmit(env);
      expect(res.submitted).toBe(0);
      expect(dispatchSubmission).not.toHaveBeenCalled();
      expect(get("td1").status).toBe("withdrawn");
    });

    it("a provider failure releases the claim back to the original status", async () => {
      setup("auto");
      insertTakedown("td1", { status: "draft", severity: "LOW" });
      dispatchSubmission.mockImplementationOnce(async () => ({
        result: { outcome: "failed", submitter_kind: "email_draft", submitter_target: "x", request_summary: "x", error_message: "smtp down" },
        submission_id: "sub-x",
      }) as unknown as Awaited<ReturnType<typeof dispatchSubmission>>);
      const res = await runPhaseGAutoSubmit(env);
      expect(res.submitted).toBe(0);
      expect(get("td1")).toMatchObject({ status: "draft", submitted_at: null });
    });
  });

  describe("M2 — staff severity changes", () => {
    it("rejects an invalid severity (400) and audits old → new severity", async () => {
      setup("semi_auto");
      insertTakedown("td1", { status: "draft", severity: "CRITICAL" });
      expect((await staffPatch("td1", { severity: "URGENT" })).status).toBe(400);
      expect(get("td1").severity).toBe("CRITICAL");

      expect((await staffPatch("td1", { severity: "low" })).status).toBe(200);
      expect(get("td1").severity).toBe("LOW");
      expect(get("td1").staff_severity_set_at).not.toBeNull();
      const a = audits.find((x) => x.action === "admin_takedown_update")!;
      expect(a.details).toMatchObject({ previous_severity: "CRITICAL", new_severity: "LOW", severity_changed: true });
    });

    it("CRITICAL → LOW by staff does not unlock Semi-Auto filing — staff send path refuses", async () => {
      setup("semi_auto");
      insertTakedown("td1", { status: "draft", severity: "CRITICAL" });
      expect((await staffPatch("td1", { severity: "LOW" })).status).toBe(200);
      expect((await staffPatch("td1", { status: "submitted" })).status).toBe(409);
      expect((await staffSubmit("td1")).status).toBe(409);
      const refusal = audits.find((x) => x.action === "takedown_submit_refused_policy")!;
      expect(refusal.details).toMatchObject({ severity_set_by_staff: true, reason: "awaiting_customer_approval" });
      expect(dispatchSubmission).not.toHaveBeenCalled();
    });

    it("severity change + submit in ONE PATCH is judged as staff-set too", async () => {
      setup("semi_auto");
      insertTakedown("td1", { status: "draft", severity: "CRITICAL" });
      expect((await staffPatch("td1", { severity: "LOW", status: "submitted" })).status).toBe(409);
      expect(get("td1")).toMatchObject({ status: "draft", severity: "CRITICAL" });
    });

    it("Phase G holds a staff-lowered row in semi_auto, but still files it once the customer approves", async () => {
      setup("semi_auto");
      insertTakedown("td1", { status: "draft", severity: "CRITICAL" });
      expect((await staffPatch("td1", { severity: "LOW" })).status).toBe(200);
      expect((await runPhaseGAutoSubmit(env)).submitted).toBe(0);
      expect(dispatchSubmission).not.toHaveBeenCalled();

      expect((await customerPatch("td1", { status: "requested" })).status).toBe(200);
      expect((await runPhaseGAutoSubmit(env)).submitted).toBe(1);
      expect(get("td1").status).toBe("submitted");
    });

    it("an untouched LOW draft is still policy-filed in semi_auto (control)", async () => {
      setup("semi_auto");
      insertTakedown("td1", { status: "draft", severity: "LOW" });
      expect((await staffPatch("td1", { severity: "LOW" })).status).toBe(200); // no change → not staff-set
      expect(get("td1").staff_severity_set_at).toBeNull();
      expect((await staffSubmit("td1")).status).toBe(200);
    });
  });

  describe("L2 — approver must be an active member of the row's org", () => {
    const cases: Array<[string, string]> = [
      ["removed org member", "t_gone"],
      ["inactive user account", "t_off"],
      ["member of a different org", "t_other"],
      ["staff account", "u_soc"],
      ["unknown user", "t_nobody"],
    ];
    it.each(cases)("%s → not an approval (Manual mode refuses the send)", async (_label, approver) => {
      setup("off");
      insertTakedown("td1", { status: "requested", requested_at: "2026-10-04 12:00:00", requested_by: approver });
      expect((await staffSubmit("td1")).status).toBe(409);
      expect((await staffPatch("td1", { status: "submitted" })).status).toBe(409);
      expect(dispatchSubmission).not.toHaveBeenCalled();
    });

    it("an active customer member → approval (Manual mode sends)", async () => {
      setup("off");
      insertTakedown("td1", { status: "requested", requested_at: "2026-10-04 12:00:00", requested_by: "t_cust" });
      expect((await staffSubmit("td1")).status).toBe(200);
    });
  });
});
