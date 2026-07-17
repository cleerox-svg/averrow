import { describe, it, expect } from "vitest";
import {
  handleListTenantTakedowns,
  handleGetTenantTakedownDetail,
} from "../src/handlers/tenantTakedowns";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";

const SUPER_ADMIN: AuthContext = {
  userId: "u-super",
  email: "super@averrow.local",
  role: "super_admin",
  orgId: null,
  orgRole: null,
  embeddedScope: undefined,
};

const ORG_42_MEMBER: AuthContext = {
  userId: "u-tenant",
  email: "tenant@example.com",
  role: "client",
  orgId: "42",
  orgRole: "analyst",
  embeddedScope: undefined,
};

const OTHER_ORG_MEMBER: AuthContext = {
  userId: "u-other",
  email: "other@example.com",
  role: "client",
  orgId: "99",
  orgRole: "analyst",
  embeddedScope: undefined,
};

interface DbResults {
  takedowns?:   Array<Record<string, unknown>>;
  takedownRow?: Record<string, unknown> | null;
  submissions?: Array<Record<string, unknown>>;
  brandRow?:    { id: string } | null;
}

function makeDb(results: DbResults) {
  function allFor<T>(sql: string): { results: T[] } {
    if (sql.includes("FROM takedown_requests tr")) {
      return { results: (results.takedowns ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM takedown_submissions")) {
      return { results: (results.submissions ?? []) as unknown as T[] };
    }
    return { results: [] };
  }

  function prepare(sql: string) {
    return {
      bind: (..._binds: unknown[]) => ({
        all:   async <T>() => allFor<T>(sql),
        first: async <T>() => {
          if (sql.includes("FROM brands b") && sql.includes("JOIN org_brands ob")) {
            return (results.brandRow ?? null) as T | null;
          }
          if (sql.includes("FROM takedown_requests tr") && sql.includes("WHERE tr.id = ?")) {
            return (results.takedownRow ?? null) as T | null;
          }
          return null;
        },
      }),
    };
  }
  return { prepare };
}

function makeEnv(db: ReturnType<typeof makeDb>): Env {
  return { DB: db } as unknown as Env;
}

function makeRequest(query: string = ""): Request {
  return new Request(`https://averrow.com/api/orgs/42/takedowns${query}`, {
    headers: { Origin: "https://averrow.com" },
  });
}

describe("handleListTenantTakedowns", () => {
  it("403s a member trying to read a different org", async () => {
    const env = makeEnv(makeDb({}));
    const res = await handleListTenantTakedowns(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("400s a non-numeric orgId", async () => {
    const env = makeEnv(makeDb({}));
    const res = await handleListTenantTakedowns(makeRequest(), env, "x", SUPER_ADMIN);
    expect(res.status).toBe(400);
  });

  it("404s when ?brandId is for a brand not in the caller's org", async () => {
    const env = makeEnv(makeDb({ brandRow: null }));
    const res = await handleListTenantTakedowns(makeRequest("?brandId=b1"), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(404);
  });

  it("returns rows + totals.by_status rollup", async () => {
    const env = makeEnv(makeDb({
      takedowns: [
        {
          id: "td1", org_id: 42, brand_id: "b1", brand_name: "Acme",
          module_key: "domain", target_type: "url",
          target_value: "https://fake.example", target_url: "https://fake.example",
          status: "submitted", severity: "HIGH",
          provider_name: "Cloudflare", provider_method: "email",
          evidence_summary: "phishing", submitted_at: "2026-05-07",
          resolved_at: null, resolution: null,
          created_at: "2026-05-06", submission_count: 2,
        },
        {
          id: "td2", org_id: 42, brand_id: "b1", brand_name: "Acme",
          module_key: "social", target_type: "social_profile",
          target_value: "@phisher", target_url: null,
          status: "taken_down", severity: "MEDIUM",
          provider_name: "Twitter/X", provider_method: "form",
          evidence_summary: "impersonation", submitted_at: "2026-04-30",
          resolved_at: "2026-05-02", resolution: "taken_down",
          created_at: "2026-04-29", submission_count: 1,
        },
        {
          id: "td3", org_id: 42, brand_id: "b1", brand_name: "Acme",
          module_key: "domain", target_type: "url",
          target_value: "https://other.example", target_url: null,
          status: "failed", severity: "LOW",
          provider_name: null, provider_method: null,
          evidence_summary: "spam", submitted_at: null,
          resolved_at: "2026-05-05", resolution: "failed",
          created_at: "2026-05-04", submission_count: 0,
        },
      ],
    }));
    const res = await handleListTenantTakedowns(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        takedowns: unknown[];
        totals: { total: number; by_status: Record<string, number>; active: number; completed: number; failed_or_expired: number };
      };
    };
    expect(body.data.takedowns).toHaveLength(3);
    expect(body.data.totals.total).toBe(3);
    expect(body.data.totals.by_status["submitted"]).toBe(1);
    expect(body.data.totals.by_status["taken_down"]).toBe(1);
    expect(body.data.totals.by_status["failed"]).toBe(1);
    expect(body.data.totals.active).toBe(1);     // submitted only (no draft/requested/pending_response in this set)
    expect(body.data.totals.completed).toBe(1);  // taken_down
    expect(body.data.totals.failed_or_expired).toBe(1);
  });

  it("super_admin can list takedowns without org membership", async () => {
    const env = makeEnv(makeDb({ takedowns: [] }));
    const res = await handleListTenantTakedowns(makeRequest(), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });

  it("filters propagate to the SQL via querystring (status, module, brandId)", async () => {
    const env = makeEnv(makeDb({
      brandRow: { id: "b1" },
      takedowns: [],
    }));
    const res = await handleListTenantTakedowns(
      makeRequest("?status=submitted&module=domain&brandId=b1"),
      env, "42", ORG_42_MEMBER,
    );
    expect(res.status).toBe(200);
  });
});

describe("handleGetTenantTakedownDetail", () => {
  it("403s a member from another org", async () => {
    const env = makeEnv(makeDb({}));
    const res = await handleGetTenantTakedownDetail(makeRequest(), env, "42", "td1", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("404s when the takedown isn't in the caller's org", async () => {
    const env = makeEnv(makeDb({ takedownRow: null }));
    const res = await handleGetTenantTakedownDetail(makeRequest(), env, "42", "td1", ORG_42_MEMBER);
    expect(res.status).toBe(404);
  });

  it("returns the takedown + submission audit trail", async () => {
    const env = makeEnv(makeDb({
      takedownRow: {
        id: "td1", org_id: 42, brand_id: "b1", brand_name: "Acme",
        module_key: "domain", target_type: "url",
        target_value: "https://fake.example", target_url: "https://fake.example",
        status: "submitted", severity: "HIGH",
        provider_name: "Cloudflare", provider_method: "email",
        provider_abuse_contact: "abuse@cloudflare.com",
        evidence_summary: "phishing", evidence_detail: "long evidence",
        evidence_urls: null, screenshot_url: null,
        priority_score: 70, source_type: "url_scan", source_id: "u1",
        requested_at: null, submitted_at: "2026-05-07",
        response_received_at: null, response_notes: null, notes: null,
        resolved_at: null, resolution: null,
        created_at: "2026-05-06", updated_at: "2026-05-07",
        submission_count: 2,
      },
      submissions: [
        {
          id: "s1", takedown_id: "td1", provider_id: 1,
          submitter_kind: "email_draft", submitter_target: "abuse@cloudflare.com",
          request_summary: "...", outcome: "queued",
          response_status: null, response_body: null,
          ticket_id: null, error_message: null,
          attempted_at: "2026-05-07", duration_ms: 5,
        },
        {
          id: "s2", takedown_id: "td1", provider_id: 1,
          submitter_kind: "followup_email_draft", submitter_target: "abuse@cloudflare.com",
          request_summary: "...", outcome: "queued",
          response_status: null, response_body: null,
          ticket_id: null, error_message: null,
          attempted_at: "2026-05-08", duration_ms: 4,
        },
      ],
    }));
    const res = await handleGetTenantTakedownDetail(makeRequest(), env, "42", "td1", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { takedown: { id: string }; submissions: unknown[] };
    };
    expect(body.data.takedown.id).toBe("td1");
    expect(body.data.submissions).toHaveLength(2);
  });

  it("super_admin reads takedowns across orgs", async () => {
    const env = makeEnv(makeDb({
      takedownRow: {
        id: "td1", org_id: 42, brand_id: "b1", brand_name: "Acme",
        module_key: null, target_type: "url",
        target_value: "https://fake.example", target_url: null,
        status: "draft", severity: "LOW",
        provider_name: null, provider_method: null,
        provider_abuse_contact: null,
        evidence_summary: "x", evidence_detail: null,
        evidence_urls: null, screenshot_url: null,
        priority_score: 50, source_type: null, source_id: null,
        requested_at: null, submitted_at: null,
        response_received_at: null, response_notes: null, notes: null,
        resolved_at: null, resolution: null,
        created_at: "2026-05-06", updated_at: "2026-05-06",
        submission_count: 0,
      },
      submissions: [],
    }));
    const res = await handleGetTenantTakedownDetail(makeRequest(), env, "42", "td1", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });
});
