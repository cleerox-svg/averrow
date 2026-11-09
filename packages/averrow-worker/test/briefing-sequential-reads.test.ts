// Pins the 2026-11 D1 overload fixes in fetchComprehensiveBriefing
// (handlers/briefing.ts, daily 13:13 UTC cron + on-demand generate):
//
//   1. Its ~30 section reads run ONE AT A TIME (lib/run-sequential.ts), not in
//      one Promise.all burst that could trip `D1 DB is overloaded` for every
//      other request in the same 10 s window.
//   2. The platform-wide threat total comes from the shared
//      `count.threats.total` counter, not a full COUNT(*) over threats.
//   3. The 24h first_seen window is counted once; avgPerHour and todayCount
//      are derived from it.
//   4. A failing section still degrades to its fallback without stopping the
//      reads after it.

import { describe, it, expect } from "vitest";
import { fetchComprehensiveBriefing } from "../src/handlers/briefing";
import { cachedCount, THREATS_TOTAL_TTL_S } from "../src/lib/cached-count";
import { fakeKv } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const isMarketing = (s: string) => /marketing_events|contact_submissions/.test(s);

interface Probe {
  db: Env["DB"];
  sql: string[];
  maxInFlight: () => number;
}

/** A D1 stand-in that yields on every read and records peak concurrency. */
function probeDb(answer: (sql: string) => Record<string, unknown> | null, throwOn?: (sql: string) => boolean): Probe {
  const sql: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const run = async <T>(q: string, out: () => T): Promise<T> => {
    const counted = !isMarketing(q);
    if (counted) {
      inFlight++;
      peak = Math.max(peak, inFlight);
    }
    try {
      await new Promise((r) => setTimeout(r, 0));
      if (throwOn?.(q)) throw new Error("D1 DB is overloaded");
      return out();
    } finally {
      if (counted) inFlight--;
    }
  };
  const db = {
    prepare(q: string) {
      sql.push(q);
      const stmt = {
        bind: () => stmt,
        first: () => run(q, () => answer(q)),
        all: () => run(q, () => ({ results: [] })),
      };
      return stmt;
    },
  } as unknown as Env["DB"];
  return { db, sql, maxInFlight: () => peak };
}

describe("fetchComprehensiveBriefing D1 read shape", () => {
  it("runs its section reads one at a time", async () => {
    const p = probeDb(() => null);
    await fetchComprehensiveBriefing({ DB: p.db, CACHE: fakeKv() } as unknown as Env);
    // Marketing visibility (shared with an admin route, small indexed
    // windowed reads) runs after every briefing section, and the probe only
    // counts concurrency for the briefing's own reads.
    expect(p.sql.filter((s) => !isMarketing(s)).length).toBeGreaterThanOrEqual(30);
    expect(p.maxInFlight()).toBe(1);
  });

  it("reads the threat total from count.threats.total, never a full COUNT(*) over threats", async () => {
    const env = { CACHE: fakeKv() } as unknown as Env;
    await cachedCount(env, "count.threats.total", THREATS_TOTAL_TTL_S, async () => 1_234_567);
    const p = probeDb((q) =>
      /last_12h/.test(q) ? { last_12h: 20, brands_monitored: 3, brands_classified: 4 }
        : /yesterday_count/.test(q) ? { today_count: 49, yesterday_count: 30 } : null);
    const b = await fetchComprehensiveBriefing({ ...env, DB: p.db } as unknown as Env);

    expect(b.platformOverview.totalThreats).toBe(1_234_567);
    expect(p.sql.some((s) => /\(SELECT COUNT\(\*\) FROM threats\)/.test(s))).toBe(false);
    expect(p.sql.some((s) => /^SELECT COUNT\(\*\) AS n FROM threats$/.test(s.trim()))).toBe(false);

    // 24h window counted once; derived fields match the old SQL values.
    const windows24 = p.sql.join("\n").match(/FROM threats WHERE first_seen >= datetime\('now', '-24 hours'\)\) as/g) ?? [];
    expect(windows24).toHaveLength(1);
    expect(p.sql.join("\n")).not.toMatch(/as (last_24h|avg_per_hour)\b/);
    // Today and yesterday are one read.
    const dod = p.sql.filter((s) => /as today_count/.test(s));
    expect(dod).toHaveLength(1);
    expect(dod[0]).toMatch(/as yesterday_count/);
    expect(b.platformOverview.last24h).toBe(49);
    expect(b.platformOverview.todayCount).toBe(49);
    expect(b.platformOverview.avgPerHour).toBe(2); // ROUND(49 / 24) = ROUND(2.04)
    expect(b.platformOverview.yesterdayCount).toBe(30);
    expect(b.platformOverview.last12h).toBe(20);
  });

  it("computes the total on a counter miss and falls back to 0 if that read fails", async () => {
    const hit = probeDb((q) => (/^SELECT COUNT\(\*\) AS n FROM threats$/.test(q.trim()) ? { n: 77 } : null));
    const b1 = await fetchComprehensiveBriefing({ DB: hit.db, CACHE: fakeKv() } as unknown as Env);
    expect(b1.platformOverview.totalThreats).toBe(77);

    const fail = probeDb(() => null, (q) => /^SELECT COUNT\(\*\) AS n FROM threats$/.test(q.trim()));
    const b2 = await fetchComprehensiveBriefing({ DB: fail.db, CACHE: fakeKv() } as unknown as Env);
    expect(b2.platformOverview.totalThreats).toBe(0);
  });

  it("a failed day-over-day read zeroes today AND yesterday — never a fake 100% drop", async () => {
    const p = probeDb(
      (q) => (/last_12h/.test(q) ? { last_12h: 20, brands_monitored: 3, brands_classified: 4 } : null),
      (q) => /as today_count/.test(q),
    );
    const b = await fetchComprehensiveBriefing({ DB: p.db, CACHE: fakeKv() } as unknown as Env);
    expect(b.platformOverview.todayCount).toBe(0);
    expect(b.platformOverview.yesterdayCount).toBe(0);
    expect(b.platformOverview.last24h).toBe(0);
    expect(b.platformOverview.avgPerHour).toBe(0);
    // The overview read still landed.
    expect(b.platformOverview.last12h).toBe(20);
  });

  it("a failing section degrades to its fallback and later sections still run", async () => {
    const p = probeDb(
      (q) => (/COUNT\(DISTINCT page\)/.test(q) ? { distinct_pages: 5 } : null),
      (q) => /FROM feed_pull_history/.test(q),
    );
    const b = await fetchComprehensiveBriefing({ DB: p.db, CACHE: fakeKv() } as unknown as Env);
    expect(b.feedProduction).toEqual([]);
    expect(b.honeypot.pageBreakdownTotal).toBe(5);
  });
});
