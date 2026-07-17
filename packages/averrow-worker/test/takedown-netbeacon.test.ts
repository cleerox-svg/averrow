import { describe, it, expect, vi, afterEach } from "vitest";
import { netbeaconSubmitter, deriveNetBeaconCategory } from "../src/lib/takedown-submitters/netbeacon";
import type { ProviderRecord, TakedownRecord } from "../src/lib/takedown-submitters/types";
import type { Env } from "../src/types";

function env(overrides: Record<string, string> = {}): Env {
  return { TAKEDOWN_SEND_MODE: "live", NETBEACON_API_KEY: "nb_test_key", ...overrides } as unknown as Env;
}

function takedown(overrides: Partial<TakedownRecord> = {}): TakedownRecord {
  return {
    id: "td-1", org_id: 1, brand_id: "b1", module_key: "domain",
    target_type: "domain", target_value: "fake-acme.example",
    target_url: "https://fake-acme.example/login",
    evidence_summary: "Phishing site impersonating Acme.", evidence_detail: null,
    provider_name: "NetBeacon", provider_abuse_contact: null,
    provider_method: "api", severity: "HIGH", ...overrides,
  };
}

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 12, provider_name: "NetBeacon", provider_type: "reporting",
    abuse_email: null, abuse_url: "https://netbeacon.org/reporting/",
    abuse_api_url: "https://api.netbeacon.org", abuse_api_type: "netbeacon",
    auto_submit_enabled: 1, ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("deriveNetBeaconCategory", () => {
  it("defaults to phishing for brand impersonation", () => {
    expect(deriveNetBeaconCategory(takedown())).toBe("phishing");
  });
  it("detects malware from evidence", () => {
    expect(deriveNetBeaconCategory(takedown({ evidence_summary: "Hosts a ransomware dropper" }))).toBe("malware");
  });
  it("detects botnet C2", () => {
    expect(deriveNetBeaconCategory(takedown({ evidence_detail: "Acts as botnet C2 / command and control" }))).toBe("botnet");
  });
  it("detects spam", () => {
    expect(deriveNetBeaconCategory(takedown({ module_key: "domain", evidence_summary: "bulk spam campaign" }))).toBe("spam");
  });
});

describe("netbeaconSubmitter.canHandle", () => {
  it("handles a netbeacon provider in live mode with key + domain", () => {
    expect(netbeaconSubmitter.canHandle(env(), takedown(), provider())).toBe(true);
  });
  it("declines in draft mode", () => {
    expect(netbeaconSubmitter.canHandle(env({ TAKEDOWN_SEND_MODE: "draft" }), takedown(), provider())).toBe(false);
  });
  it("declines without an API key", () => {
    const e = { TAKEDOWN_SEND_MODE: "live" } as unknown as Env;
    expect(netbeaconSubmitter.canHandle(e, takedown(), provider())).toBe(false);
  });
  it("declines for a non-netbeacon provider", () => {
    expect(netbeaconSubmitter.canHandle(env(), takedown(), provider({ abuse_api_type: "web_risk" }))).toBe(false);
  });
  it("declines when no registrable domain resolves", () => {
    const t = takedown({ target_type: "social_profile", target_value: "@imposter", target_url: null });
    expect(netbeaconSubmitter.canHandle(env(), t, provider())).toBe(false);
  });
  it("resolves the domain from a URL target", () => {
    const t = takedown({ target_type: "url", target_value: "https://evil.example/x", target_url: "https://evil.example/x" });
    expect(netbeaconSubmitter.canHandle(env(), t, provider())).toBe(true);
  });
});

describe("netbeaconSubmitter.submit", () => {
  it("posts the report with bearer auth and maps 200/201 → submitted with report id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ report_id: "nb-789" }), { status: 201 }),
    );
    const res = await netbeaconSubmitter.submit(env(), takedown(), provider());

    expect(res.outcome).toBe("submitted");
    expect(res.submitter_kind).toBe("api_netbeacon");
    expect(res.ticket_id).toBe("nb-789");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.netbeacon.org/v1/reports");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer nb_test_key");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.domain).toBe("fake-acme.example");
    expect(body.category).toBe("phishing");
  });

  it("strips scheme/path to the bare host in the payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const t = takedown({ target_type: "url", target_value: "https://Evil.Example/login?x=1", target_url: "https://Evil.Example/login?x=1" });
    await netbeaconSubmitter.submit(env(), t, provider());
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.domain).toBe("evil.example");
  });

  it("honors NETBEACON_API_BASE override", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await netbeaconSubmitter.submit(env({ NETBEACON_API_BASE: "https://onboard.netbeacon.test/" }), takedown(), provider());
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://onboard.netbeacon.test/v1/reports");
  });

  it("maps 4xx → rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "bad domain" }), { status: 422 }));
    const res = await netbeaconSubmitter.submit(env(), takedown(), provider());
    expect(res.outcome).toBe("rejected");
  });

  it("maps 5xx → failed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 502 }));
    expect((await netbeaconSubmitter.submit(env(), takedown(), provider())).outcome).toBe("failed");
  });

  it("maps a network error → failed", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    expect((await netbeaconSubmitter.submit(env(), takedown(), provider())).outcome).toBe("failed");
  });
});
