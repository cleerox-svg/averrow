import { describe, it, expect } from "vitest";
import {
  handleGetAbuseMailboxModuleSummary,
  handleListAbuseInboxMessages,
} from "../src/handlers/tenantAbuseMailboxModule";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";
import type { OrgModule } from "../src/lib/entitlements";

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

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

interface DbResults {
  enabledModules: OrgModule[];
  brandSummaries?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
  brandRow?: { id: string } | null;
  alias?: { alias: string; forwarding_instructions: string | null } | null;
  unbound?: { unbound_total: number; unbound_pending: number } | null;
  // PR-AU: totals are computed by a direct aggregate over
  // abuse_inbox_messages, no longer summed from per-brand rollups.
  totals?: {
    messages_total:         number;
    messages_phishing:      number;
    messages_malware:       number;
    messages_spam:          number;
    messages_benign:        number;
    messages_pending:       number;
    messages_high_critical: number;
  } | null;
}

function makeDb(results: DbResults) {
  function allFor<T>(sql: string): { results: T[] } {
    if (sql.includes("FROM org_modules")) {
      return { results: results.enabledModules as unknown as T[] };
    }
    if (sql.includes("JOIN org_brands ob ON ob.brand_id = b.id") &&
        sql.includes("ob.is_primary DESC")) {
      return { results: (results.brandSummaries ?? []) as unknown as T[] };
    }
    if (sql.includes("FROM abuse_inbox_messages")) {
      return { results: (results.messages ?? []) as unknown as T[] };
    }
    return { results: [] };
  }

  function prepare(sql: string) {
    return {
      bind: () => ({
        all: async <T>() => allFor<T>(sql),
        first: async <T>() => {
          if (sql.includes("FROM org_abuse_aliases")) {
            return (results.alias ?? null) as T | null;
          }
          if (sql.includes("FROM abuse_inbox_messages") && sql.includes("brand_id IS NULL")) {
            return (results.unbound ?? { unbound_total: 0, unbound_pending: 0 }) as T;
          }
          // PR-AU: direct totals aggregate over abuse_inbox_messages.
          // Matches the COUNT(*) + CASE-WHEN aggregate added to
          // tenantAbuseMailboxModule.ts.
          if (sql.includes("FROM abuse_inbox_messages")
              && sql.includes("COUNT(*) AS messages_total")) {
            return (results.totals ?? {
              messages_total: 0, messages_phishing: 0, messages_malware: 0,
              messages_spam: 0, messages_benign: 0, messages_pending: 0,
              messages_high_critical: 0,
            }) as T;
          }
          if (sql.includes("FROM brands b") && sql.includes("JOIN org_brands ob")) {
            return (results.brandRow ?? null) as T | null;
          }
          return null;
        },
      }),
    };
  }
  return { prepare };
}

function makeEnv(kv: MockKV, db: ReturnType<typeof makeDb>): Env {
  return { CACHE: kv, DB: db } as unknown as Env;
}

function makeRequest(query: string = ""): Request {
  return new Request(`https://averrow.com/api/orgs/42/modules/abuse-mailbox${query}`, {
    headers: { Origin: "https://averrow.com" },
  });
}

const ENTITLED: OrgModule[] = [{
  module_key: "abuse_mailbox",
  status: "active",
  activated_at: "2026-05-07T00:00:00Z",
  suspended_at: null,
  trial_ends_at: null,
  config_json: null,
}];

describe("handleGetAbuseMailboxModuleSummary", () => {
  it("403s a member trying to read a different org", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetAbuseMailboxModuleSummary(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("400s a non-numeric orgId", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleGetAbuseMailboxModuleSummary(makeRequest(), env, "x", SUPER_ADMIN);
    expect(res.status).toBe(400);
  });

  it("403s when the org doesn't have abuse_mailbox entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleGetAbuseMailboxModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(403);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe("MODULE_NOT_ENTITLED");
  });

  it("super_admin bypasses entitlement and returns alias + unbound counts", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      brandSummaries: [],
      alias: { alias: "verify-acme@averrow.com", forwarding_instructions: null },
      unbound: { unbound_total: 2, unbound_pending: 1 },
    }));
    const res = await handleGetAbuseMailboxModuleSummary(makeRequest(), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { alias: { alias: string } | null; unbound: { total: number; pending: number } };
    };
    expect(body.data.alias?.alias).toBe("verify-acme@averrow.com");
    expect(body.data.unbound.total).toBe(2);
    expect(body.data.unbound.pending).toBe(1);
  });

  it("returns org-wide totals from the direct aggregate (includes unbound)", async () => {
    // PR-AU: totals come from a direct COUNT/CASE-WHEN over all
    // abuse_inbox_messages for the org, NOT from summing per-brand
    // rollups. This catches the regression where unbound (brand_id
    // IS NULL) rows were silently dropped from the KPI strip.
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandSummaries: [
        {
          brand_id: "b1", brand_name: "Acme", canonical_domain: "acme.com",
          messages_total: 12, messages_phishing: 4, messages_malware: 1,
          messages_spam: 2, messages_benign: 2, messages_pending: 3,
          messages_high_critical: 5,
        },
        {
          brand_id: "b2", brand_name: "Beta", canonical_domain: "beta.io",
          messages_total: 6, messages_phishing: 1, messages_malware: 0,
          messages_spam: 1, messages_benign: 2, messages_pending: 2,
          messages_high_critical: 1,
        },
      ],
      // 18 brand-bound + 16 unbound = 34 total. The pre-PR-AU code
      // would have reported 18 here, dropping the unbound 16.
      totals: {
        messages_total: 34, messages_phishing: 5, messages_malware: 1,
        messages_spam: 3, messages_benign: 4, messages_pending: 19,
        messages_high_critical: 6,
      },
      unbound: { unbound_total: 16, unbound_pending: 16 },
    }));
    const res = await handleGetAbuseMailboxModuleSummary(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        brands: unknown[];
        totals: Record<string, number>;
        unbound: { total: number; pending: number };
      };
    };
    expect(body.data.brands).toHaveLength(2);
    // Totals reflect the org-wide aggregate, not the brand-rollup sum.
    expect(body.data.totals.messages_total).toBe(34);
    expect(body.data.totals.messages_phishing).toBe(5);
    expect(body.data.totals.messages_pending).toBe(19);
    expect(body.data.totals.messages_high_critical).toBe(6);
    // Unbound shape unchanged.
    expect(body.data.unbound.total).toBe(16);
    expect(body.data.unbound.pending).toBe(16);
  });
});

describe("handleListAbuseInboxMessages", () => {
  it("403s a member from another org", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: ENTITLED }));
    const res = await handleListAbuseInboxMessages(makeRequest(), env, "42", OTHER_ORG_MEMBER);
    expect(res.status).toBe(403);
  });

  it("403s when the org doesn't have abuse_mailbox entitled", async () => {
    const env = makeEnv(new MockKV(), makeDb({ enabledModules: [] }));
    const res = await handleListAbuseInboxMessages(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(403);
  });

  it("404s when the brandId filter is for a brand not in the caller's org", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: null,
    }));
    const res = await handleListAbuseInboxMessages(makeRequest("?brandId=b1"), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(404);
  });

  it("returns messages for an entitled, owned brand filter", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      brandRow: { id: "b1" },
      messages: [
        {
          id: "m1", org_id: 42, brand_id: "b1", received_at: "2026-05-07T00:00:00Z",
          forwarded_by_email: "user@acme.com", inbound_alias: "verify-acme@averrow.com",
          original_from: "phisher@bad.example", original_subject: "URGENT",
          original_body_snippet: "click here", attachment_count: 0, url_count: 1,
          classification: "phishing", classified_by: "ai",
          classification_confidence: 0.95, classification_reason: null,
          ai_assessment: null, ai_action: "escalate",
          severity: "HIGH", status: "new",
          ack_sent_at: "2026-05-07T00:01:00Z", determination_sent_at: null,
        },
      ],
    }));
    const res = await handleListAbuseInboxMessages(makeRequest("?brandId=b1"), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { messages: unknown[]; brand_id: string | null } };
    expect(body.data.messages).toHaveLength(1);
    expect(body.data.brand_id).toBe("b1");
  });

  it("returns org-wide messages with no brandId filter", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: ENTITLED,
      messages: [
        { id: "m1", org_id: 42, brand_id: null, received_at: "2026-05-07T00:00:00Z",
          forwarded_by_email: null, inbound_alias: null,
          original_from: null, original_subject: "x",
          original_body_snippet: null, attachment_count: 0, url_count: 0,
          classification: "pending", classified_by: null,
          classification_confidence: null, classification_reason: null,
          ai_assessment: null, ai_action: null,
          severity: "LOW", status: "new",
          ack_sent_at: null, determination_sent_at: null },
      ],
    }));
    const res = await handleListAbuseInboxMessages(makeRequest(), env, "42", ORG_42_MEMBER);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { messages: unknown[]; brand_id: string | null } };
    expect(body.data.messages).toHaveLength(1);
    expect(body.data.brand_id).toBeNull();
  });

  it("super_admin bypasses entitlement + ownership for cross-tenant browsing", async () => {
    const env = makeEnv(new MockKV(), makeDb({
      enabledModules: [],
      messages: [],
    }));
    const res = await handleListAbuseInboxMessages(makeRequest("?brandId=b1"), env, "42", SUPER_ADMIN);
    expect(res.status).toBe(200);
  });
});
