import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Google token minter so the submitter tests don't need a real
// service account. hasServiceAccount + getGoogleAccessToken are controlled
// per-test via the mock implementation.
vi.mock("../src/lib/google-service-account", () => ({
  hasServiceAccount: vi.fn(),
  getGoogleAccessToken: vi.fn(),
}));

import {
  webRiskSubmitter, webRiskMonthlyCap, utcMonthStart, WEB_RISK_MONTHLY_CAP_DEFAULT,
} from "../src/lib/takedown-submitters/web-risk";
import { dispatchSubmission, isQuotaBlocked, quotaBlockedProviderNames } from "../src/lib/takedown-submitters";
import { hasServiceAccount, getGoogleAccessToken } from "../src/lib/google-service-account";
import type { ProviderRecord, TakedownRecord } from "../src/lib/takedown-submitters/types";
import type { Env } from "../src/types";

const mockHasSA = vi.mocked(hasServiceAccount);
const mockToken = vi.mocked(getGoogleAccessToken);

function env(mode = "live"): Env {
  return { TAKEDOWN_SEND_MODE: mode } as unknown as Env;
}

function takedown(overrides: Partial<TakedownRecord> = {}): TakedownRecord {
  return {
    id: "td-1", org_id: 1, brand_id: "b1", module_key: "domain",
    target_type: "domain", target_value: "evil.example",
    target_url: "https://evil.example/login",
    evidence_summary: "phish", evidence_detail: null,
    provider_name: "Google Safe Browsing", provider_abuse_contact: null,
    provider_method: "api", severity: "HIGH", ...overrides,
  };
}

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 9, provider_name: "Google Safe Browsing", provider_type: "reporting",
    abuse_email: null, abuse_url: null,
    abuse_api_url: "https://webrisk.googleapis.com", abuse_api_type: "web_risk",
    auto_submit_enabled: 1, ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  mockHasSA.mockReturnValue(true);
  mockToken.mockResolvedValue({ access_token: "ya29.test", project_id: "proj-123" });
});

describe("webRiskSubmitter.canHandle", () => {
  it("handles a web_risk provider in live mode with a credential + URL", () => {
    expect(webRiskSubmitter.canHandle(env("live"), takedown(), provider())).toBe(true);
  });

  it("declines in draft mode (falls through to email)", () => {
    expect(webRiskSubmitter.canHandle(env("draft"), takedown(), provider())).toBe(false);
  });

  it("declines when no service account is configured", () => {
    mockHasSA.mockReturnValue(false);
    expect(webRiskSubmitter.canHandle(env("live"), takedown(), provider())).toBe(false);
  });

  it("declines for a non-web_risk provider", () => {
    expect(webRiskSubmitter.canHandle(env("live"), takedown(), provider({ abuse_api_type: "form" }))).toBe(false);
  });

  it("declines when no submittable URL can be resolved", () => {
    const t = takedown({ target_type: "email", target_url: null, target_value: "abuse@evil.example" });
    expect(webRiskSubmitter.canHandle(env("live"), t, provider())).toBe(false);
  });

  it("builds an https URL from a bare domain", () => {
    const t = takedown({ target_url: null, target_value: "evil.example", target_type: "domain" });
    expect(webRiskSubmitter.canHandle(env("live"), t, provider())).toBe(true);
  });
});

describe("webRiskSubmitter.submit", () => {
  it("submits to the project-scoped endpoint and maps 200 → submitted with ticket id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "operations/op-abc" }), { status: 200 }),
    );
    const res = await webRiskSubmitter.submit(env("live"), takedown(), provider());

    expect(res.outcome).toBe("submitted");
    expect(res.submitter_kind).toBe("api_web_risk");
    expect(res.ticket_id).toBe("operations/op-abc");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://webrisk.googleapis.com/v1/projects/proj-123/uris:submit");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ya29.test");
    expect(String((init as RequestInit).body)).toContain("https://evil.example/login");
  });

  it("maps a 4xx to rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad uri" } }), { status: 400 }),
    );
    const res = await webRiskSubmitter.submit(env("live"), takedown(), provider());
    expect(res.outcome).toBe("rejected");
    expect(res.error_message).toBeTruthy();
  });

  it("maps a 5xx to failed (retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream", { status: 503 }));
    const res = await webRiskSubmitter.submit(env("live"), takedown(), provider());
    expect(res.outcome).toBe("failed");
  });

  it("maps a network error to failed", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    const res = await webRiskSubmitter.submit(env("live"), takedown(), provider());
    expect(res.outcome).toBe("failed");
  });

  it("fails cleanly when the token cannot be minted", async () => {
    mockToken.mockResolvedValue(null);
    const res = await webRiskSubmitter.submit(env("live"), takedown(), provider());
    expect(res.outcome).toBe("failed");
    expect(res.error_message).toContain("Google access token");
  });

  it("fails when the service account has no project_id", async () => {
    mockToken.mockResolvedValue({ access_token: "ya29.test", project_id: null });
    const res = await webRiskSubmitter.submit(env("live"), takedown(), provider());
    expect(res.outcome).toBe("failed");
    expect(res.error_message).toContain("project_id");
  });
});

// ─── Monthly free-allowance cap ────────────────────────────────────

/** Fake D1: COUNT reads return `count` (or throw), inserts are recorded. */
function capDb(count: number | Error) {
  const reads: Array<{ sql: string; binds: unknown[] }> = [];
  const writes: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              reads.push({ sql, binds });
              if (count instanceof Error) throw count;
              return { n: count };
            },
            async run() { writes.push(binds); return { success: true }; },
          };
        },
        async all() {
          reads.push({ sql, binds: [] });
          return { results: [{ provider_name: "Google Safe Browsing" }] };
        },
      };
    },
  };
  return { db, reads, writes };
}

function capEnv(count: number | Error, extra: Record<string, unknown> = {}) {
  const fake = capDb(count);
  return { env: { TAKEDOWN_SEND_MODE: "live", DB: fake.db, ...extra } as unknown as Env, ...fake };
}

describe("Web Risk monthly cap", () => {
  it("defaults to 100/month and accepts a non-negative integer override", () => {
    expect(WEB_RISK_MONTHLY_CAP_DEFAULT).toBe(100);
    expect(webRiskMonthlyCap({} as Env)).toBe(100);
    expect(webRiskMonthlyCap({ WEB_RISK_MONTHLY_CAP: "40" } as unknown as Env)).toBe(40);
    expect(webRiskMonthlyCap({ WEB_RISK_MONTHLY_CAP: "0" } as unknown as Env)).toBe(0);
    expect(webRiskMonthlyCap({ WEB_RISK_MONTHLY_CAP: "-5" } as unknown as Env)).toBe(100);
    expect(webRiskMonthlyCap({ WEB_RISK_MONTHLY_CAP: "lots" } as unknown as Env)).toBe(100);
  });

  it("counts every Web Risk call since the start of the UTC month", async () => {
    expect(utcMonthStart(new Date("2026-11-24T06:00:00Z"))).toBe("2026-11-01 00:00:00");
    const { env, reads } = capEnv(3);
    expect(await webRiskSubmitter.hasCapacity!(env)).toBe(true);
    expect(reads[0]!.sql).toMatch(/FROM takedown_submissions/);
    expect(reads[0]!.sql).not.toMatch(/outcome/); // every call counts, accepted or not
    expect(reads[0]!.binds[1]).toBe("api_web_risk");
    expect(String(reads[0]!.binds[0])).toMatch(/^\d{4}-\d{2}-01 00:00:00$/);
  });

  it("has no capacity at the cap, or when the count can't be read (fail closed)", async () => {
    expect(await webRiskSubmitter.hasCapacity!(capEnv(99).env)).toBe(true);
    expect(await webRiskSubmitter.hasCapacity!(capEnv(100).env)).toBe(false);
    expect(await webRiskSubmitter.hasCapacity!(capEnv(0, { WEB_RISK_MONTHLY_CAP: "0" }).env)).toBe(false);
    expect(await webRiskSubmitter.hasCapacity!(capEnv(new Error("D1 overloaded")).env)).toBe(false);
  });

  it("dispatch uses Web Risk under the cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "projects/proj-123/operations/op-1" }), { status: 200 }),
    );
    const { env, writes } = capEnv(10);
    const { result } = await dispatchSubmission(env, takedown(), provider({ abuse_email: "abuse@google.com" }));
    expect(result.submitter_kind).toBe("api_web_risk");
    expect(writes).toHaveLength(1);
  });

  it("dispatch at the cap falls through to abuse email and never calls Google", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { env } = capEnv(100);
    const { result } = await dispatchSubmission(env, takedown(), provider({ abuse_email: "abuse@google.com" }));
    expect(result.submitter_kind).toBe("email"); // emailSendSubmitter.kind
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("webrisk.googleapis.com"))).toBe(false);
  });

  it("dispatch at the cap with no other channel fails and says why", async () => {
    const { env } = capEnv(100);
    const { result } = await dispatchSubmission(env, takedown(), provider());
    expect(result.submitter_kind).toBe("none");
    expect(result.error_message).toMatch(/at monthly cap: api_web_risk/);
  });
});

describe("quota-blocked takedowns wait instead of failing", () => {
  it("isQuotaBlocked: true at the cap when Web Risk is the only channel (prod: no abuse email)", async () => {
    expect(await isQuotaBlocked(capEnv(100).env, takedown(), provider())).toBe(true);
    expect(await isQuotaBlocked(capEnv(99).env, takedown(), provider())).toBe(false);
    // With an abuse email the takedown can still go out by email → not blocked.
    expect(await isQuotaBlocked(capEnv(100).env, takedown(), provider({ abuse_email: "abuse@x.example" }))).toBe(false);
  });

  it("quotaBlockedProviderNames: the web_risk providers with no abuse email, only at the cap and in live mode", async () => {
    const at = capEnv(100);
    expect(await quotaBlockedProviderNames(at.env)).toEqual(["Google Safe Browsing"]);
    expect(at.reads.some((r) => /abuse_api_type = 'web_risk'/.test(r.sql) && /abuse_email IS NULL/.test(r.sql))).toBe(true);
    expect(await quotaBlockedProviderNames(capEnv(3).env)).toEqual([]);
    expect(await quotaBlockedProviderNames(capEnv(100, { TAKEDOWN_SEND_MODE: "draft" }).env)).toEqual([]);
  });
});
