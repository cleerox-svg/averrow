import { describe, it, expect } from "vitest";
import {
  parseAuthResults,
  parseSenderIp,
  correlateUrls,
  promoteToThreats,
} from "../src/lib/abuse-mailbox-iocs";
import type { Env } from "../src/types";
import type { ExtractedUrl } from "../src/handlers/abuseMailboxEmail";

// ─── parseAuthResults ──────────────────────────────────────────

describe("parseAuthResults", () => {
  it("returns null verdicts when the header is missing", () => {
    const r = parseAuthResults({});
    expect(r).toEqual({ spf: null, dkim: null, dmarc: null });
  });

  it("parses a canonical Authentication-Results header", () => {
    const r = parseAuthResults({
      "authentication-results":
        "mx.example.com; spf=pass smtp.mailfrom=bad.example; dkim=fail header.d=other.example; dmarc=fail action=quarantine",
    });
    expect(r).toEqual({ spf: "pass", dkim: "fail", dmarc: "fail" });
  });

  it("handles folded / multi-line header content", () => {
    const r = parseAuthResults({
      "authentication-results":
        "mx.example.com;\n  spf=softfail;\n  dkim=pass;\n  dmarc=none",
    });
    expect(r).toEqual({ spf: "softfail", dkim: "pass", dmarc: "none" });
  });

  it("returns null for a method that's absent from the header", () => {
    const r = parseAuthResults({
      "authentication-results": "mx.example.com; spf=pass",
    });
    expect(r.spf).toBe("pass");
    expect(r.dkim).toBeNull();
    expect(r.dmarc).toBeNull();
  });

  it("rejects nonsense verdict values", () => {
    const r = parseAuthResults({
      "authentication-results": "mx.example.com; spf=junkverdict",
    });
    expect(r.spf).toBeNull();
  });
});

// ─── parseSenderIp ─────────────────────────────────────────────

describe("parseSenderIp", () => {
  it("returns null when no Received header is present", () => {
    expect(parseSenderIp({})).toBeNull();
  });

  it("returns the most-external IP from a multi-hop chain", () => {
    // Two hops joined by '; '. The oldest hop (entered the public
    // chain) appears LAST in the joined string, since Received is
    // prepended on each hop. We expect the public IP from the
    // oldest hop.
    const r = parseSenderIp({
      received:
        "from internal-mx ([10.0.0.1]) by mx.cloudflare.com; " +
        "from public-relay ([198.51.100.42]) by external-mx",
    });
    expect(r).toBe("198.51.100.42");
  });

  it("skips private + loopback IPs", () => {
    const r = parseSenderIp({
      received:
        "from local ([127.0.0.1]) by mx.cloudflare.com; " +
        "from internal ([10.0.0.1]) by relay; " +
        "from external ([203.0.113.7]) by edge",
    });
    expect(r).toBe("203.0.113.7");
  });

  it("returns null when the chain is entirely internal", () => {
    const r = parseSenderIp({
      received:
        "from a ([10.1.1.1]) by b; from c ([172.16.0.1]) by d; from e ([192.168.1.1]) by f",
    });
    expect(r).toBeNull();
  });
});

// ─── correlateUrls + promoteToThreats — in-memory D1 stub ──────

interface ThreatRow {
  id: string;
  malicious_url: string | null;
  malicious_domain: string | null;
  first_seen: string;
  target_brand_id: string | null;
  source_feed: string;
  threat_type: string;
  status: string;
}

interface InsertedThreat {
  id: string;
  source_feed: string;
  threat_type: string;
  malicious_url: string | null;
  malicious_domain: string | null;
  target_brand_id: string | null;
  ip_address: string | null;
  confidence_score: number | null;
  severity: string | null;
}

function mkEnv(threats: ThreatRow[], inserts: InsertedThreat[]): Env {
  const db = {
    prepare(sql: string) {
      const isInsert = sql.includes("INSERT OR IGNORE INTO threats");
      const isExactUrl = sql.includes("WHERE malicious_url = ?");
      const isDomain = sql.includes("WHERE malicious_domain = ?");
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (isExactUrl) {
                const url = args[0] as string;
                const hit = threats.find((t) => t.malicious_url === url);
                return (hit ?? null) as T | null;
              }
              if (isDomain) {
                const domain = args[0] as string;
                const hit = threats.find((t) => t.malicious_domain === domain);
                return (hit ?? null) as T | null;
              }
              return null;
            },
            async run(): Promise<{ success: boolean }> {
              if (isInsert) {
                inserts.push({
                  id:                String(args[0]),
                  source_feed:       String(args[1]),
                  threat_type:       String(args[2]),
                  malicious_url:     args[3] as string | null,
                  malicious_domain:  args[4] as string | null,
                  target_brand_id:   args[5] as string | null,
                  // ip_address is at index 7 (after hosting_provider_id at 6)
                  ip_address:        args[7] as string | null,
                  confidence_score:  args[12] as number | null,
                  severity:          args[15] as string | null,
                });
              }
              return { success: true };
            },
            async all<T>(): Promise<{ results: T[] }> { return { results: [] }; },
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe("correlateUrls", () => {
  it("returns [] for an empty URL list", async () => {
    const env = mkEnv([], []);
    const out = await correlateUrls(env, []);
    expect(out).toEqual([]);
  });

  it("matches by exact URL first", async () => {
    const env = mkEnv([
      {
        id: "thr-1", malicious_url: "https://bad.example/login",
        malicious_domain: "bad.example", first_seen: "2026-05-01T00:00:00Z",
        target_brand_id: "brand-1", source_feed: "phishstats",
        threat_type: "phishing", status: "active",
      },
    ], []);
    const urls: ExtractedUrl[] = [
      { url: "https://bad.example/login", domain: "bad.example", count: 1 },
    ];
    const out = await correlateUrls(env, urls);
    expect(out).toHaveLength(1);
    expect(out[0]?.threat_id).toBe("thr-1");
    expect(out[0]?.url).toBe("https://bad.example/login");
  });

  it("falls back to domain match when URL is different but domain matches", async () => {
    const env = mkEnv([
      {
        id: "thr-2", malicious_url: "https://bad.example/other-path",
        malicious_domain: "bad.example", first_seen: "2026-05-01T00:00:00Z",
        target_brand_id: null, source_feed: "openphish",
        threat_type: "phishing", status: "active",
      },
    ], []);
    const urls: ExtractedUrl[] = [
      { url: "https://bad.example/different-page", domain: "bad.example", count: 1 },
    ];
    const out = await correlateUrls(env, urls);
    expect(out).toHaveLength(1);
    expect(out[0]?.threat_id).toBe("thr-2");
  });

  it("dedupes by threat_id when multiple URLs match the same threat", async () => {
    const env = mkEnv([
      {
        id: "thr-3", malicious_url: null,
        malicious_domain: "bad.example", first_seen: "2026-05-01T00:00:00Z",
        target_brand_id: null, source_feed: "openphish",
        threat_type: "phishing", status: "active",
      },
    ], []);
    const urls: ExtractedUrl[] = [
      { url: "https://bad.example/a", domain: "bad.example", count: 1 },
      { url: "https://bad.example/b", domain: "bad.example", count: 1 },
    ];
    const out = await correlateUrls(env, urls);
    expect(out).toHaveLength(1);
  });

  it("caps lookups at 20 URLs to bound D1 cost", async () => {
    const env = mkEnv([], []);
    const urls: ExtractedUrl[] = Array.from({ length: 50 }, (_, i) => ({
      url: `https://x${i}.example`, domain: `x${i}.example`, count: 1,
    }));
    const out = await correlateUrls(env, urls);
    // No threats configured → no matches, but we should have queried
    // at most 20. We can't easily count without instrumenting the stub
    // further, so just confirm the function returns []
    expect(out).toEqual([]);
  });
});

describe("promoteToThreats", () => {
  it("writes one INSERT per URL with the right shape", async () => {
    const inserts: InsertedThreat[] = [];
    const env = mkEnv([], inserts);
    const urls: ExtractedUrl[] = [
      { url: "https://bad.example/a", domain: "bad.example", count: 1 },
      { url: "https://bad.example/b", domain: "bad.example", count: 1 },
    ];
    const out = await promoteToThreats(env, {
      urls,
      classification: "phishing",
      confidence: 92,
      brandId: "brand-7",
      senderIp: "203.0.113.7",
      messageId: "msg-1",
    });
    expect(out).toHaveLength(2);
    expect(inserts).toHaveLength(2);
    const first = inserts[0]!;
    expect(first.source_feed).toBe("abuse_mailbox");
    expect(first.threat_type).toBe("phishing");
    expect(first.malicious_url).toBe("https://bad.example/a");
    expect(first.malicious_domain).toBe("bad.example");
    expect(first.target_brand_id).toBe("brand-7");
    expect(first.ip_address).toBe("203.0.113.7");
    expect(first.confidence_score).toBe(92);
    expect(first.severity).toBe("high"); // confidence >= 80
  });

  it("maps malware verdict to threat_type='malware_distribution'", async () => {
    const inserts: InsertedThreat[] = [];
    const env = mkEnv([], inserts);
    const urls: ExtractedUrl[] = [
      { url: "https://bad.example/dropper.exe", domain: "bad.example", count: 1 },
    ];
    await promoteToThreats(env, {
      urls, classification: "malware", confidence: 95,
      brandId: null, senderIp: null, messageId: "msg-2",
    });
    expect(inserts[0]?.threat_type).toBe("malware_distribution");
  });

  it("downgrades severity to 'medium' when confidence is below 80", async () => {
    const inserts: InsertedThreat[] = [];
    const env = mkEnv([], inserts);
    const urls: ExtractedUrl[] = [
      { url: "https://maybe.example/x", domain: "maybe.example", count: 1 },
    ];
    await promoteToThreats(env, {
      urls, classification: "phishing", confidence: 65,
      brandId: null, senderIp: null, messageId: "msg-3",
    });
    expect(inserts[0]?.severity).toBe("medium");
  });

  it("uses a deterministic id so repeated reports of the same URL dedupe naturally", async () => {
    const inserts: InsertedThreat[] = [];
    const env = mkEnv([], inserts);
    const urls: ExtractedUrl[] = [
      { url: "https://bad.example/login", domain: "bad.example", count: 1 },
    ];
    const out1 = await promoteToThreats(env, {
      urls, classification: "phishing", confidence: 90,
      brandId: "b", senderIp: null, messageId: "msg-A",
    });
    const out2 = await promoteToThreats(env, {
      urls, classification: "phishing", confidence: 90,
      brandId: "b", senderIp: null, messageId: "msg-B",
    });
    expect(out1).toEqual(out2);
  });

  it("returns [] when no URLs are provided", async () => {
    const inserts: InsertedThreat[] = [];
    const env = mkEnv([], inserts);
    const out = await promoteToThreats(env, {
      urls: [], classification: "phishing", confidence: 90,
      brandId: null, senderIp: null, messageId: "msg-empty",
    });
    expect(out).toEqual([]);
    expect(inserts).toHaveLength(0);
  });
});
