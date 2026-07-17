import { describe, it, expect, vi } from "vitest";
import { scanUrl } from "../src/lib/url-scanner";
import type { UrlScanInput } from "../src/lib/url-scanner";

// ─── Mock D1 helper ─────────────────────────────────────────────

interface MockQueryResult {
  result: unknown;
  matchFn?: (sql: string, bindings: unknown[]) => boolean;
}

function createMockEnv(queryResults: MockQueryResult[] = []) {
  const queryLog: Array<{ sql: string; bindings: unknown[] }> = [];
  let queryIndex = 0;

  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          const trimmedSql = sql.replace(/\s+/g, " ").trim();
          queryLog.push({ sql: trimmedSql, bindings: args });

          // Find matching result by matchFn or use sequential index
          let result: unknown = null;
          const matched = queryResults.find(
            (qr) => qr.matchFn && qr.matchFn(trimmedSql, args),
          );
          if (matched) {
            result = matched.result;
          } else if (queryIndex < queryResults.length) {
            result = queryResults[queryIndex]?.result ?? null;
          }
          queryIndex++;

          return {
            first: async <T>() => result as T | null,
            all: async <T>() => ({
              results: (result as T[]) || [],
            }),
            run: async () => ({ success: true }),
          };
        },
      }),
    },
    CACHE: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    queryLog,
  } as unknown as ReturnType<typeof createMockEnv> & { queryLog: typeof queryLog };
}

function makeInput(url: string, overrides?: Partial<UrlScanInput>): UrlScanInput {
  return {
    url,
    source_type: "manual",
    ...overrides,
  };
}

describe("scanUrl", () => {
  it("marks URL as malicious when it matches a known active threat", async () => {
    const env = createMockEnv([
      // Check 1: threats table — known threat found
      {
        result: {
          id: "threat-1",
          threat_type: "phishing",
          severity: "high",
          hosting_provider_id: null,
        },
        matchFn: (sql) => sql.includes("FROM threats"),
      },
      // Check 2: threat_signals — no match
      { result: null, matchFn: (sql) => sql.includes("FROM threat_signals") },
      // Check 3: safe domains — not safe
      {
        result: null,
        matchFn: (sql) => sql.includes("FROM brand_safe_domains"),
      },
      // Check 4: recent threats
      { result: { c: 2 }, matchFn: (sql) => sql.includes("COUNT(*)") },
      // Check 5: lookalike — no match
      {
        result: null,
        matchFn: (sql) => sql.includes("FROM lookalike_domains"),
      },
      // Provider lookup
      {
        result: null,
        matchFn: (sql) => sql.includes("FROM hosting_providers"),
      },
    ]);

    const result = await scanUrl(env as any, makeInput("https://evil-phish.com/login"));

    expect(result.is_malicious).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.known_threat_id).toBe("threat-1");
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("Known active threat")]),
    );
  });

  it("clears confidence when domain is in safe domains list", async () => {
    const env = createMockEnv([
      // Check 1: threats — found
      {
        result: {
          id: "threat-1",
          threat_type: "phishing",
          severity: "high",
          hosting_provider_id: null,
        },
        matchFn: (sql) => sql.includes("FROM threats") && !sql.includes("COUNT"),
      },
      // Check 2: signals — found
      {
        result: { id: "sig-1", signal_type: "phishing_url", severity: "high" },
        matchFn: (sql) => sql.includes("FROM threat_signals"),
      },
      // Check 3: safe domains — IS safe
      {
        result: { 1: 1 },
        matchFn: (sql) => sql.includes("FROM brand_safe_domains"),
      },
      // Checks 4 & 5 skipped due to safeDomain being truthy
      // Provider lookup
      {
        result: null,
        matchFn: (sql) => sql.includes("FROM hosting_providers"),
      },
    ]);

    const result = await scanUrl(env as any, makeInput("https://safe-bank.com"));

    expect(result.is_malicious).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reasons).toEqual(["Domain is in safe domains list"]);
  });

  it("returns not malicious with low confidence when no matches found", async () => {
    const env = createMockEnv([
      { result: null }, // threats
      { result: null }, // signals
      { result: null }, // safe domains
      { result: { c: 0 } }, // recent threats
      { result: null }, // lookalikes
      { result: null }, // provider
    ]);

    const result = await scanUrl(env as any, makeInput("https://harmless-site.com"));

    expect(result.is_malicious).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.domain).toBe("harmless-site.com");
  });

  it("increases confidence for lookalike domains", async () => {
    const env = createMockEnv([
      { result: null }, // threats
      { result: null }, // signals
      { result: null }, // safe domains
      { result: { c: 0 } }, // recent threats
      {
        result: { brand_id: "brand-1", threat_level: "high" },
        matchFn: (sql) => sql.includes("FROM lookalike_domains"),
      }, // lookalike match
      { result: null }, // provider
    ]);

    const result = await scanUrl(env as any, makeInput("https://g00gle.com"));

    expect(result.confidence).toBe(0.4);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Registered lookalike domain"),
      ]),
    );
  });

  it("accumulates confidence from multiple signals but caps at 1.0", async () => {
    const env = createMockEnv([
      // Check 1: known threat → +0.8
      {
        result: {
          id: "t1",
          threat_type: "phishing",
          severity: "critical",
          hosting_provider_id: null,
        },
      },
      // Check 2: phishing signal → +0.3
      { result: { id: "s1", signal_type: "phishing_url", severity: "high" } },
      // Check 3: not safe
      { result: null },
      // Check 4: recent threats → +0.2
      { result: { c: 5 } },
      // Check 5: lookalike → +0.4
      { result: { brand_id: "b1", threat_level: "critical" } },
      // Provider
      { result: null },
    ]);

    const result = await scanUrl(env as any, makeInput("https://evil-phish.com"));

    // 0.8 + 0.3 + 0.2 + 0.4 = 1.7 → capped at 1.0
    expect(result.confidence).toBe(1.0);
    expect(result.is_malicious).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("adds phishing signal confidence", async () => {
    const env = createMockEnv([
      { result: null }, // threats
      {
        result: { id: "s1", signal_type: "phishing_url", severity: "high" },
      }, // signals → +0.3
      { result: null }, // safe domains
      { result: { c: 0 } }, // recent threats
      { result: null }, // lookalikes
      { result: null }, // provider
    ]);

    const result = await scanUrl(env as any, makeInput("https://phish-signal.com"));

    expect(result.confidence).toBe(0.3);
    expect(result.is_malicious).toBe(false); // 0.3 < 0.5 threshold
  });

  it("adds recent threat confidence", async () => {
    const env = createMockEnv([
      { result: null }, // threats
      { result: null }, // signals
      { result: null }, // safe domains
      { result: { c: 3 } }, // recent threats → +0.2
      { result: null }, // lookalikes
      { result: null }, // provider
    ]);

    const result = await scanUrl(env as any, makeInput("https://recent-threat.com"));

    expect(result.confidence).toBe(0.2);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("threats in last 7 days")]),
    );
  });

  it("extracts domain from the input URL", async () => {
    const env = createMockEnv([
      { result: null },
      { result: null },
      { result: null },
      { result: { c: 0 } },
      { result: null },
      { result: null },
    ]);

    const result = await scanUrl(
      env as any,
      makeInput("https://www.example.com/phishing/page?id=123"),
    );

    expect(result.domain).toBe("example.com");
    expect(result.url).toBe("https://www.example.com/phishing/page?id=123");
  });

  it("handles empty URL gracefully", async () => {
    const env = createMockEnv([
      { result: null },
      { result: null },
      { result: null },
      { result: { c: 0 } },
      { result: null },
      { result: null },
    ]);

    const result = await scanUrl(env as any, makeInput(""));

    expect(result.domain).toBe("");
    expect(result.is_malicious).toBe(false);
  });

  it("includes hosting provider name when available", async () => {
    const env = createMockEnv([
      { result: null }, // threats
      { result: null }, // signals
      { result: null }, // safe domains
      { result: { c: 0 } }, // recent threats
      { result: null }, // lookalikes
      {
        result: { name: "Cloudflare" },
        matchFn: (sql) => sql.includes("FROM hosting_providers"),
      }, // provider
    ]);

    const result = await scanUrl(env as any, makeInput("https://hosted.example.com"));

    expect(result.hosting_provider).toBe("Cloudflare");
  });

  it("returns null registrar (future WHOIS lookup)", async () => {
    const env = createMockEnv([
      { result: null },
      { result: null },
      { result: null },
      { result: { c: 0 } },
      { result: null },
      { result: null },
    ]);

    const result = await scanUrl(env as any, makeInput("https://example.com"));

    expect(result.registrar).toBeNull();
  });

  it("is_malicious threshold is confidence >= 0.5", async () => {
    // Exactly 0.5 → malicious
    const env = createMockEnv([
      { result: null }, // threats
      {
        result: { id: "s1", signal_type: "phishing_url", severity: "high" },
      }, // signals → +0.3
      { result: null }, // safe
      { result: { c: 1 } }, // recent → +0.2
      { result: null }, // lookalikes
      { result: null }, // provider
    ]);

    const result = await scanUrl(env as any, makeInput("https://borderline.com"));

    expect(result.confidence).toBe(0.5);
    expect(result.is_malicious).toBe(true);
  });
});
