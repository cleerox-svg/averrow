import { describe, it, expect, vi, afterEach } from "vitest";
import { godaddySubmitter, deriveGoDaddyType } from "../src/lib/takedown-submitters/godaddy";
import type { ProviderRecord, TakedownRecord } from "../src/lib/takedown-submitters/types";
import type { Env } from "../src/types";

function env(overrides: Record<string, string> = {}): Env {
  return {
    TAKEDOWN_SEND_MODE: "live",
    GODADDY_API_KEY: "gd_key",
    GODADDY_API_SECRET: "gd_secret",
    ...overrides,
  } as unknown as Env;
}

function takedown(overrides: Partial<TakedownRecord> = {}): TakedownRecord {
  return {
    id: "td-1", org_id: 1, brand_id: "b1", module_key: "domain",
    target_type: "domain", target_value: "fake-acme.example",
    target_url: "https://fake-acme.example/login",
    evidence_summary: "Phishing site impersonating Acme.", evidence_detail: null,
    provider_name: "GoDaddy", provider_abuse_contact: "abuse@godaddy.com",
    provider_method: "api", severity: "HIGH", ...overrides,
  };
}

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 1, provider_name: "GoDaddy", provider_type: "registrar",
    abuse_email: "abuse@godaddy.com", abuse_url: "https://supportcenter.godaddy.com/AbuseReport",
    abuse_api_url: "https://api.godaddy.com", abuse_api_type: "godaddy",
    auto_submit_enabled: 1, ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("deriveGoDaddyType", () => {
  it("defaults to PHISHING", () => {
    expect(deriveGoDaddyType(takedown())).toBe("PHISHING");
  });
  it("maps malware → MALWARE", () => {
    expect(deriveGoDaddyType(takedown({ evidence_summary: "ransomware payload dropper" }))).toBe("MALWARE");
  });
  it("maps botnet → NETWORK_ABUSE", () => {
    expect(deriveGoDaddyType(takedown({ evidence_detail: "botnet C2 node" }))).toBe("NETWORK_ABUSE");
  });
  it("maps spam → SPAM", () => {
    expect(deriveGoDaddyType(takedown({ evidence_summary: "bulk spam relay" }))).toBe("SPAM");
  });
});

describe("godaddySubmitter.canHandle", () => {
  it("handles a godaddy provider in live mode with both creds + a source", () => {
    expect(godaddySubmitter.canHandle(env(), takedown(), provider())).toBe(true);
  });
  it("declines in draft mode", () => {
    expect(godaddySubmitter.canHandle(env({ TAKEDOWN_SEND_MODE: "draft" }), takedown(), provider())).toBe(false);
  });
  it("declines when only the key is set (secret missing)", () => {
    const e = { TAKEDOWN_SEND_MODE: "live", GODADDY_API_KEY: "gd_key" } as unknown as Env;
    expect(godaddySubmitter.canHandle(e, takedown(), provider())).toBe(false);
  });
  it("declines for a non-godaddy provider", () => {
    expect(godaddySubmitter.canHandle(env(), takedown(), provider({ abuse_api_type: "netbeacon" }))).toBe(false);
  });
  it("declines when no source resolves (email target)", () => {
    const t = takedown({ target_type: "email", target_value: "x@y.example", target_url: null });
    expect(godaddySubmitter.canHandle(env(), t, provider())).toBe(false);
  });
  it("handles a bare IP source", () => {
    const t = takedown({ target_type: "ip", target_value: "203.0.113.7", target_url: null });
    expect(godaddySubmitter.canHandle(env(), t, provider())).toBe(true);
  });
});

describe("godaddySubmitter.submit", () => {
  it("posts an abuse ticket with sso-key auth and maps 201 → submitted with ticketId", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ticketId: "DCU-1234" }), { status: 201 }),
    );
    const res = await godaddySubmitter.submit(env(), takedown(), provider());

    expect(res.outcome).toBe("submitted");
    expect(res.submitter_kind).toBe("api_godaddy");
    expect(res.ticket_id).toBe("DCU-1234");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.godaddy.com/v1/abuse/tickets");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("sso-key gd_key:gd_secret");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.type).toBe("PHISHING");
    expect(body.source).toBe("https://fake-acme.example/login");
  });

  it("honors GODADDY_API_BASE override (OTE sandbox)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 201 }));
    await godaddySubmitter.submit(env({ GODADDY_API_BASE: "https://api.ote-godaddy.com" }), takedown(), provider());
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.ote-godaddy.com/v1/abuse/tickets");
  });

  it("maps 4xx → rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: "INVALID_BODY" }), { status: 422 }));
    expect((await godaddySubmitter.submit(env(), takedown(), provider())).outcome).toBe("rejected");
  });

  it("maps 5xx → failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 500 }));
    expect((await godaddySubmitter.submit(env(), takedown(), provider())).outcome).toBe("failed");
  });

  it("maps a network error → failed", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    expect((await godaddySubmitter.submit(env(), takedown(), provider())).outcome).toBe("failed");
  });
});
