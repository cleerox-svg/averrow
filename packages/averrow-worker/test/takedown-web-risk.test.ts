import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Google token minter so the submitter tests don't need a real
// service account. hasServiceAccount + getGoogleAccessToken are controlled
// per-test via the mock implementation.
vi.mock("../src/lib/google-service-account", () => ({
  hasServiceAccount: vi.fn(),
  getGoogleAccessToken: vi.fn(),
}));

import { webRiskSubmitter } from "../src/lib/takedown-submitters/web-risk";
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
