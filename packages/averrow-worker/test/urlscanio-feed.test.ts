/**
 * urlscan.io feed — the search query must stay inside what the free
 * plan allows. Searching any `verdicts.*` field returns HTTP 403 on the
 * free plan, which disabled this feed on 2026-07-23.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted: Array<Record<string, unknown>> = [];
vi.mock("../src/lib/feedRunner", () => ({
  isDuplicate: vi.fn(async () => false),
  markSeen: vi.fn(async () => {}),
  insertThreat: vi.fn(async (_db: unknown, row: Record<string, unknown>) => { inserted.push(row); }),
}));

import { urlscanio, URLSCAN_QUERY } from "../src/feeds/urlscanio";
import type { Env } from "../src/types";

const env = { DB: {}, URLSCAN_API_KEY: "k-123" } as unknown as Env;

function mockSearch(results: unknown[]) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ results }), { status: 200 })) as unknown as typeof fetch;
}

beforeEach(() => { inserted.length = 0; vi.clearAllMocks(); });

describe("urlscanio feed", () => {
  it("never searches plan-restricted verdict fields", () => {
    expect(URLSCAN_QUERY).not.toMatch(/verdicts\./);
    expect(URLSCAN_QUERY).toMatch(/task\.tags:/);
    expect(URLSCAN_QUERY).toMatch(/date:>now-2h/);
  });

  it("sends the query and API key, and types threats from tags when verdicts are absent", async () => {
    mockSearch([
      { _id: "a", task: { url: "https://evil.example/login", tags: ["malware"] }, page: { domain: "evil.example", ip: "1.2.3.4" } },
      { _id: "b", task: { url: "https://phish.example/", tags: ["phishing"] }, page: { domain: "phish.example" } },
    ]);
    const r = await urlscanio.ingest({ env, feedName: "urlscanio", feedUrl: "https://urlscan.io/api/v1/search/" });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(new URL(String(url)).searchParams.get("q")).toBe(URLSCAN_QUERY);
    expect((init as RequestInit).headers).toMatchObject({ "API-Key": "k-123" });

    expect(r.itemsNew).toBe(2);
    expect(inserted.find((t) => t.malicious_domain === "evil.example")!.threat_type).toBe("malware_distribution");
    expect(inserted.find((t) => t.malicious_domain === "phish.example")!.threat_type).toBe("phishing");
  });

  it("prefers verdict categories when the plan returns them", async () => {
    mockSearch([
      { _id: "c", task: { url: "https://x.example/", tags: ["phishing"] }, verdicts: { overall: { score: 95, categories: ["credentials"] } } },
    ]);
    await urlscanio.ingest({ env, feedName: "urlscanio", feedUrl: "" });
    expect(inserted[0]!.threat_type).toBe("credential_harvesting");
    expect(inserted[0]!.severity).toBe("critical");
  });
});
