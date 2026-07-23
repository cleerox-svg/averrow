/**
 * Tests for the Feed-expansion Phase 1 ingest modules (migration 0248):
 *   ipsum, phishing_database, scam_blocklist (→ threats via insertThreat)
 *   epss (→ agent_outputs insight, like cisa_kev)
 *
 * These assert the per-module contract: shape filtering, the ipsum
 * score floor, the correct source_feed / threat_type / severity landing
 * on each inserted row, and the epss date-based dedup guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ipsum } from "../src/feeds/ipsum";
import { phishing_database } from "../src/feeds/phishing_database";
import { scam_blocklist } from "../src/feeds/scam_blocklist";
import { epss } from "../src/feeds/epss";
import type { Env } from "../src/types";

interface Captured {
  /** Bound-arg arrays for every INSERT ... INTO threats .run() call. */
  threatBinds: unknown[][];
  /** Bound-arg arrays for every INSERT ... INTO agent_outputs insight .run(). */
  insightBinds: unknown[][];
}

function makeEnv(opts?: { priorInsightSummary?: string | null }): {
  env: Env;
  captured: Captured;
} {
  const captured: Captured = { threatBinds: [], insightBinds: [] };
  const priorSummary = opts?.priorInsightSummary ?? null;

  const env = {
    CACHE: {
      // Never a duplicate; put is a no-op.
      get: async () => null,
      put: async () => undefined,
    },
    DB: {
      prepare(sql: string) {
        // A statement exposes bind / run / first directly — D1 allows
        // prepare(sql).first() with no bind (see cisa_kev / epss).
        const stmt = {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (/INSERT\s+OR\s+IGNORE\s+INTO\s+threats/i.test(sql)) {
                  captured.threatBinds.push(args);
                } else if (/INSERT\s+INTO\s+agent_outputs/i.test(sql) && /'insight'/.test(sql)) {
                  captured.insightBinds.push(args);
                }
                return { meta: { changes: 1 } };
              },
              async first() { return null; },
            };
          },
          async run() { return { meta: { changes: 1 } }; },
          async first() {
            // The epss dedup guard reads the last stored EPSS digest.
            if (/agent_outputs/i.test(sql) && /LIKE 'EPSS%'/.test(sql)) {
              return priorSummary ? { summary: priorSummary } : null;
            }
            return null;
          },
        };
        return stmt;
      },
    },
    ABUSECH_AUTH_KEY: "test-key",
  } as unknown as Env;

  return { env, captured };
}

function mockTextResponse(body: string) {
  const make = () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    clone: () => make(),
    async text() { return body; },
    async json() { return JSON.parse(body); },
  });
  globalThis.fetch = vi.fn(async () => make()) as unknown as typeof fetch;
}

// Bound-arg column offsets into the insertThreat INSERT (see feedRunner.ts).
const COL_SOURCE_FEED = 1;
const COL_THREAT_TYPE = 2;
const COL_IP = 7;
const COL_SEVERITY = 15;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ipsum", () => {
  it("ingests only IPs at or above the score floor (>=3), scoring severity by list count", async () => {
    // score 11 → critical, 5 → high, 2 → dropped (below floor), 3 → medium
    mockTextResponse(
      [
        "# IPsum header",
        "1.2.3.4\t11",
        "5.6.7.8\t5",
        "9.9.9.9\t2",
        "10.0.0.1\t3",
        "not-an-ip\t9",
      ].join("\n"),
    );
    const { env, captured } = makeEnv();

    const result = await ipsum.ingest({ env, feedName: "ipsum", feedUrl: "https://x/ipsum.txt" });

    // 11, 5, 3 pass the floor; 2 dropped; junk line rejected.
    expect(result.itemsNew).toBe(3);
    expect(captured.threatBinds).toHaveLength(3);
    for (const b of captured.threatBinds) {
      expect(b[COL_SOURCE_FEED]).toBe("ipsum");
      expect(b[COL_THREAT_TYPE]).toBe("malicious_ip");
    }
    expect(captured.threatBinds[0]![COL_IP]).toBe("1.2.3.4");
    expect(captured.threatBinds[0]![COL_SEVERITY]).toBe("critical"); // score 11
    expect(captured.threatBinds[1]![COL_SEVERITY]).toBe("high");     // score 5
    expect(captured.threatBinds[2]![COL_SEVERITY]).toBe("medium");   // score 3
  });

  it("caps work at MAX_ITEMS (1000) so a large list can't overrun the worker budget", async () => {
    const lines = ["# IPsum header"];
    for (let i = 0; i < 1500; i++) lines.push(`10.0.${Math.floor(i / 256)}.${i % 256}\t5`);
    mockTextResponse(lines.join("\n"));
    const { env, captured } = makeEnv();

    const result = await ipsum.ingest({ env, feedName: "ipsum", feedUrl: "https://x/ipsum.txt" });

    expect(result.itemsFetched).toBe(1000);
    expect(result.itemsNew).toBe(1000);
    expect(captured.threatBinds).toHaveLength(1000);
  });
});

describe("phishing_database", () => {
  it("ingests bare domains as high-severity phishing and rejects junk lines", async () => {
    mockTextResponse(
      [
        "# comment",
        "evil-phish.com",
        "sub.bad-domain.co.uk",
        "*.wildcard.com",     // rejected (wildcard)
        "https://x.com",      // rejected (protocol)
        "no-tld",             // rejected (no dot)
        "",                   // rejected (blank)
      ].join("\n"),
    );
    const { env, captured } = makeEnv();

    const result = await phishing_database.ingest({
      env, feedName: "phishing_database", feedUrl: "https://x/new-today.txt",
    });

    expect(result.itemsNew).toBe(2);
    expect(captured.threatBinds).toHaveLength(2);
    expect(captured.threatBinds[0]![COL_SOURCE_FEED]).toBe("phishing_database");
    expect(captured.threatBinds[0]![COL_THREAT_TYPE]).toBe("phishing");
    expect(captured.threatBinds[0]![COL_SEVERITY]).toBe("high");
  });
});

describe("scam_blocklist", () => {
  it("ingests bare domains as medium-severity phishing", async () => {
    mockTextResponse(["# header", "fake-store.shop", "drainer.xyz", "bad space.com"].join("\n"));
    const { env, captured } = makeEnv();

    const result = await scam_blocklist.ingest({
      env, feedName: "scam_blocklist", feedUrl: "https://x/scams.txt",
    });

    expect(result.itemsNew).toBe(2);
    expect(captured.threatBinds[0]![COL_SOURCE_FEED]).toBe("scam_blocklist");
    expect(captured.threatBinds[0]![COL_THREAT_TYPE]).toBe("phishing");
    expect(captured.threatBinds[0]![COL_SEVERITY]).toBe("medium");
  });
});

describe("epss", () => {
  const payload = JSON.stringify({
    status: "OK",
    data: [
      { cve: "CVE-2026-0001", epss: "0.97456", percentile: "0.99999", date: "2026-07-22" },
      { cve: "CVE-2026-0002", epss: "0.90123", percentile: "0.99900", date: "2026-07-22" },
    ],
  });

  it("writes a single agent_outputs insight for a fresh scoring date", async () => {
    mockTextResponse(payload);
    const { env, captured } = makeEnv({ priorInsightSummary: null });

    const result = await epss.ingest({ env, feedName: "epss", feedUrl: "https://x/epss" });

    expect(result.itemsNew).toBe(1);
    expect(captured.insightBinds).toHaveLength(1);
    // summary is the 2nd bind arg; must carry the scoring date for the dedup guard.
    expect(String(captured.insightBinds[0]![1])).toContain("2026-07-22");
    expect(String(captured.insightBinds[0]![1])).toContain("CVE-2026-0001");
    // No threats rows — epss is an insight-only feed.
    expect(captured.threatBinds).toHaveLength(0);
  });

  it("skips (dedups) when the latest stored digest already covers today's date", async () => {
    mockTextResponse(payload);
    const { env, captured } = makeEnv({ priorInsightSummary: "EPSS Update (2026-07-22): ..." });

    const result = await epss.ingest({ env, feedName: "epss", feedUrl: "https://x/epss" });

    expect(result.itemsNew).toBe(0);
    expect(result.itemsDuplicate).toBe(2);
    expect(captured.insightBinds).toHaveLength(0);
  });
});
