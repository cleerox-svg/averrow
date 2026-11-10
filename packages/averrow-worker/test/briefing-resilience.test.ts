// Pins the 2026-11-10 daily-briefing reliability fix (handlers/briefing.ts).
//
// Incident (2026-11-09 13:13 UTC): the cron read 4.67M rows — three full
// passes over the 1.55M-row threats table (enrichment SUM + two
// `COUNT(*) WHERE source_feed = ?` walking idx_threats_ip_source_feed) — and
// the threat_briefings INSERT plus all three finalize attempts (250 ms / 1 s
// apart) then failed inside the same D1 10 s overload window. Meter evidence:
// 44 statements = 40 reads + 1 INSERT + 3 finalize, 7 rows written (the
// agent_runs INSERT only). No briefing, no email, run reaped 90 min later.
//
// Pinned here:
//   1. lib/run-sequential.ts helpers: withTimeout, retryWithBackoff, sleep.
//   2. Reads stay one-at-a-time (enrichment chunks included).
//   3. Enrichment is summed over rowid chunks; source-feed totals come from
//      threat_cube_status — no statement walks every threat for those.
//   4. A hung read times out and falls back; later sections still run; an
//      exhausted read budget skips the rest to fallbacks.
//   5. The INSERT is retried and idempotent; the email + row land even when
//      sections fall back; the run is always finalized (success / partial /
//      failed); an email that hangs times out.
//   6. Output fields of ComprehensiveBriefing are unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";
import { fakeKv } from "./sqlite-d1-harness";
import { retryWithBackoff, sleep, TimeoutError, withTimeout } from "../src/lib/run-sequential";

const emailMock = vi.hoisted(() => ({
  impl: async (): Promise<{ sent: boolean; id?: string; error?: string; recipient?: string }> => ({ sent: true, id: "e1" }),
}));
vi.mock("../src/lib/briefing-email", () => ({
  sendBriefingEmail: vi.fn(() => emailMock.impl()),
}));

import {
  BRIEFING_TIMING,
  degradingSectionErrors,
  fetchComprehensiveBriefing,
  generateAndEmailBriefing,
} from "../src/handlers/briefing";

const DEFAULT_TIMING = { ...BRIEFING_TIMING };

beforeEach(() => {
  BRIEFING_TIMING.writeBackoffMs = [0, 0, 0, 0];
  BRIEFING_TIMING.finalizeBackoffMs = [0, 0, 0];
  BRIEFING_TIMING.enrichmentChunkPauseMs = 0;
  emailMock.impl = async () => ({ sent: true, id: "e1" });
});
afterEach(() => {
  Object.assign(BRIEFING_TIMING, DEFAULT_TIMING);
});

const isMarketing = (s: string) => /marketing_events|contact_submissions/.test(s);

interface StmtCall { sql: string; args: unknown[] }

interface FakeOpts {
  /** Answer for a `.first()` read (null → fallback). */
  first?: (sql: string, args: unknown[]) => Record<string, unknown> | null;
  /** Throw for this read/write. */
  throwOn?: (sql: string, call: number) => boolean;
  /** Never settle this read. */
  hangOn?: (sql: string) => boolean;
  /** Advance a fake clock by this much per read (budget tests). */
  onRead?: (sql: string) => void;
}

/** D1 stand-in recording every statement, peak read concurrency and writes. */
function fakeDb(opts: FakeOpts = {}) {
  const calls: StmtCall[] = [];
  const briefingRows: Array<{ id: number; report_data: string; emailed: number }> = [];
  const runUpdates: StmtCall[] = [];
  const events: StmtCall[] = [];
  const counts = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;

  const exec = async <T>(sql: string, args: unknown[], out: () => T): Promise<T> => {
    calls.push({ sql, args });
    const n = (counts.get(sql) ?? 0) + 1;
    counts.set(sql, n);
    const counted = !isMarketing(sql);
    if (counted) { inFlight++; peak = Math.max(peak, inFlight); }
    try {
      await new Promise((r) => setTimeout(r, 0));
      opts.onRead?.(sql);
      if (opts.hangOn?.(sql)) await new Promise(() => {});
      if (opts.throwOn?.(sql, n)) throw new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window");
      return out();
    } finally {
      if (counted) inFlight--;
    }
  };

  const db = {
    prepare(sql: string) {
      const lower = sql.toLowerCase();
      const make = (args: unknown[]) => ({
        bind: (...a: unknown[]) => make(a),
        first: <T>() => exec(sql, args, () => {
          if (lower.includes("select id from threat_briefings")) {
            const row = briefingRows.find((r) => r.report_data.includes(String(args[0])));
            return (row ? { id: row.id } : null) as T;
          }
          return (opts.first?.(sql, args) ?? null) as T;
        }),
        all: () => exec(sql, args, () => ({ results: [] })),
        run: () => exec(sql, args, () => {
          if (lower.includes("insert into threat_briefings")) {
            const [, reportData, , genId] = args as [string, string, string, string];
            if (briefingRows.some((r) => r.report_data.includes(genId))) return { meta: { changes: 0, last_row_id: 999 } };
            const id = 100 + briefingRows.length;
            briefingRows.push({ id, report_data: reportData, emailed: 0 });
            return { meta: { changes: 1, last_row_id: id } };
          }
          if (lower.includes("update threat_briefings set emailed")) {
            const row = briefingRows.find((r) => r.id === args[0]);
            if (row) row.emailed = 1;
          }
          if (lower.includes("update threat_briefings set report_data")) {
            const row = briefingRows.find((r) => r.id === args[1]);
            if (row) row.report_data = String(args[0]);
          }
          if (lower.includes("update agent_runs")) runUpdates.push({ sql, args });
          if (lower.includes("insert into agent_events")) events.push({ sql, args });
          return { meta: { changes: 1, last_row_id: 0 } };
        }),
      });
      return make([]);
    },
  } as unknown as Env["DB"];

  return { db, calls, briefingRows, runUpdates, events, peak: () => peak };
}

const envFor = (db: Env["DB"]) => ({ DB: db, CACHE: fakeKv() } as unknown as Env);

// ─── 1. helpers ────────────────────────────────────────────────

describe("run-sequential timing helpers", () => {
  it("withTimeout rejects with TimeoutError when the work outlives the ceiling", async () => {
    await expect(withTimeout(() => new Promise(() => {}), 10, "slow read")).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(async () => 7, 1_000, "fast read")).resolves.toBe(7);
    await expect(withTimeout(async () => 8, 0, "no ceiling")).resolves.toBe(8);
  });

  it("retryWithBackoff makes backoff.length + 1 attempts, then rethrows the last error", async () => {
    let n = 0;
    await expect(retryWithBackoff(async () => { n++; throw new Error(`fail ${n}`); }, [0, 0, 0])).rejects.toThrow("fail 4");
    expect(n).toBe(4);

    let m = 0;
    await expect(retryWithBackoff(async () => { m++; if (m < 3) throw new Error("x"); return "ok"; }, [0, 0, 0])).resolves.toBe("ok");
    expect(m).toBe(3);
  });

  it("the production write/finalize backoff schedules outlast one D1 10 s overload window", () => {
    const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(DEFAULT_TIMING.writeBackoffMs)).toBeGreaterThan(10_000);
    expect(sum(DEFAULT_TIMING.finalizeBackoffMs)).toBeGreaterThan(10_000);
  });

  it("sleep(0) resolves immediately", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

// ─── 2/3. read shape ───────────────────────────────────────────

describe("fetchComprehensiveBriefing read shape", () => {
  it("reads one statement at a time, enrichment chunks included, and sums the chunks", async () => {
    BRIEFING_TIMING.enrichmentChunkRows = 200_000;
    const f = fakeDb({
      first: (sql, args) => {
        if (/MAX\(rowid\) AS hi FROM threats/.test(sql)) return { hi: 450_000 };
        if (/rowid > \? AND rowid <= \?/.test(sql)) {
          return { surbl_checked: 1, vt_checked: 2, vt_hits: Number(args[0]) === 0 ? 5 : 0, sec_checked: null };
        }
        return null;
      },
    });
    const b = await fetchComprehensiveBriefing(envFor(f.db));

    expect(f.peak()).toBe(1);
    const chunks = f.calls.filter((c) => /rowid > \? AND rowid <= \?/.test(c.sql));
    expect(chunks.map((c) => c.args)).toEqual([[0, 200_000], [200_000, 400_000], [400_000, 600_000]]);
    expect(b.enrichment.surbl_checked).toBe(3);
    expect(b.enrichment.vt_checked).toBe(6);
    expect(b.enrichment.vt_hits).toBe(5);
    expect(b.enrichment.sec_checked).toBe(0);
  });

  it("never walks every threat for source-feed totals or the enrichment SUM", async () => {
    const f = fakeDb({
      first: (sql) => (/threat_cube_status/.test(sql) ? { typosquat_total: 78_311, certstream: 4 } : null),
    });
    const b = await fetchComprehensiveBriefing(envFor(f.db));
    const all = f.calls.map((c) => c.sql).join("\n");

    expect(all).not.toMatch(/FROM threats WHERE source_feed = '(typosquat_scanner|certstream)'\)/);
    // Every threats read is a first_seen window, a rowid range, MAX(rowid) or
    // the shared total counter's miss path.
    const threatsReads = f.calls.map((c) => c.sql).filter((s) => /FROM threats\b/.test(s));
    for (const s of threatsReads) {
      expect(
        /first_seen >=|rowid > \? AND rowid <= \?|MAX\(rowid\)|^SELECT COUNT\(\*\) AS n FROM threats$/.test(s.trim()),
        s,
      ).toBe(true);
    }
    expect(b.newCapabilities.typosquat_total).toBe(78_311);
    expect(b.newCapabilities.certstream).toBe(4);
  });
});

// ─── 4. timeouts and budget ────────────────────────────────────

describe("per-read timeout and read budget", () => {
  it("a hung read times out to its fallback, is recorded, and later sections still run", async () => {
    BRIEFING_TIMING.readTimeoutMs = 25;
    const f = fakeDb({
      hangOn: (sql) => /FROM feed_pull_history/.test(sql),
      first: (sql) => (/COUNT\(DISTINCT page\)/.test(sql) ? { distinct_pages: 5 } : null),
    });
    const errors: Record<string, string> = {};
    const b = await fetchComprehensiveBriefing(envFor(f.db), errors);

    expect(b.feedProduction).toEqual([]);
    expect(errors.feed_production_error).toMatch(/timed out after 25ms/);
    expect(b.honeypot.pageBreakdownTotal).toBe(5);
  });

  it("once the read budget is spent, the remaining reads are skipped to their fallbacks", async () => {
    BRIEFING_TIMING.readBudgetMs = 50;
    const realNow = Date.now;
    let clock = realNow();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const f = fakeDb({
        onRead: (sql) => { if (/as last_12h/.test(sql)) clock += 1_000; },
        first: (sql) => (/as last_12h/.test(sql) ? { last_12h: 9, brands_monitored: 1, brands_classified: 2 } : null),
      });
      const errors: Record<string, string> = {};
      const b = await fetchComprehensiveBriefing(envFor(f.db), errors);

      expect(b.platformOverview.last12h).toBe(9);
      expect(errors.day_over_day_error).toMatch(/read budget exhausted/);
      expect(errors.geopolitical_campaigns_error).toMatch(/read budget exhausted/);
      // Skipped reads issue no statement.
      expect(f.calls.some((c) => /as today_count/.test(c.sql))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── 5. persistence + finalize ─────────────────────────────────

describe("generateAndEmailBriefing persistence and run finalize", () => {
  it("retries an overloaded INSERT and still stores + emails exactly one briefing", async () => {
    const f = fakeDb({ throwOn: (sql, n) => /INSERT INTO threat_briefings/.test(sql) && n <= 2 });
    const r = await generateAndEmailBriefing(envFor(f.db), "cron:daily");

    expect(r.emailSent).toBe(true);
    expect(f.briefingRows).toHaveLength(1);
    expect(r.briefingId).toBe(f.briefingRows[0].id);
    expect(f.briefingRows[0].emailed).toBe(1);
    expect(f.runUpdates).toHaveLength(1);
    expect(f.runUpdates[0].args[0]).toBe("success");
  });

  it("a retried INSERT whose first attempt landed does not create a second row", async () => {
    // First INSERT lands, then its response is lost (throws after the write).
    let attempts = 0;
    const f = fakeDb();
    const inner = f.db.prepare.bind(f.db);
    (f.db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      const stmt = inner(sql) as unknown as { bind: (...a: unknown[]) => { run: () => Promise<unknown> } };
      if (!/INSERT INTO threat_briefings/.test(sql)) return stmt;
      return {
        bind: (...a: unknown[]) => ({
          run: async () => {
            const res = await stmt.bind(...a).run();
            attempts++;
            if (attempts === 1) throw new Error("D1_ERROR: Network connection lost.");
            return res;
          },
        }),
      };
    };
    const r = await generateAndEmailBriefing(envFor(f.db), "cron:daily");

    expect(attempts).toBe(2);
    expect(f.briefingRows).toHaveLength(1);
    expect(r.briefingId).toBe(f.briefingRows[0].id);
    expect(JSON.parse(f.briefingRows[0].report_data).generation_id).toMatch(/[0-9a-f-]{36}/);
  });

  it("stores and emails even when sections fall back, and finishes the run 'partial' naming them", async () => {
    const f = fakeDb({ throwOn: (sql) => /FROM feed_pull_history|FROM honeypot_visits/.test(sql) });
    const r = await generateAndEmailBriefing(envFor(f.db), "cron:daily");

    expect(r.emailSent).toBe(true);
    expect(f.briefingRows).toHaveLength(1);
    expect(f.runUpdates).toHaveLength(1);
    const [status, , , , errorMessage] = f.runUpdates[0].args as [string, number, number, unknown, string];
    expect(status).toBe("partial");
    expect(errorMessage).toMatch(/feed_production/);
    expect(errorMessage).toMatch(/honeypot_totals/);
    // Telemetry carries the fallback sections.
    expect(f.events).toHaveLength(1);
    expect(JSON.parse(String(f.events[0].args[2])).fallback_sections).toContain("feed_production");
  });

  it("a missing table (schema drift) does not degrade the run", () => {
    expect(degradingSectionErrors({ geopolitical_campaigns_error: "no such table: geopolitical_campaign_links: SQLITE_ERROR" })).toEqual([]);
    expect(degradingSectionErrors({ overview_error: "D1 DB is overloaded" })).toEqual(["overview"]);
  });

  it("finalizes the run 'failed' when the INSERT never lands, and rethrows", async () => {
    const f = fakeDb({ throwOn: (sql) => /INSERT INTO threat_briefings/.test(sql) });
    await expect(generateAndEmailBriefing(envFor(f.db), "cron:daily")).rejects.toThrow(/overloaded/);

    const inserts = f.calls.filter((c) => /INSERT INTO threat_briefings/.test(c.sql));
    expect(inserts).toHaveLength(BRIEFING_TIMING.writeBackoffMs.length + 1);
    expect(f.runUpdates).toHaveLength(1);
    expect(f.runUpdates[0].sql).toMatch(/status = 'failed'/);
    expect(f.runUpdates[0].args[0]).toMatch(/overloaded/);
    expect(f.events).toHaveLength(0);
  });

  it("finalize retries ride out an overload window instead of giving up after ~1 s", async () => {
    const f = fakeDb({ throwOn: (sql, n) => /UPDATE agent_runs/.test(sql) && n <= 3 });
    const r = await generateAndEmailBriefing(envFor(f.db), "cron:daily");

    expect(r.emailSent).toBe(true);
    // Attempts 1-3 failed (the old schedule's whole budget); attempt 4 landed.
    expect(f.runUpdates).toHaveLength(1);
    expect(f.runUpdates[0].args[0]).toBe("success");
  });

  it("an email send that hangs times out; the row is stored unemailed with the error and the run completes", async () => {
    BRIEFING_TIMING.emailTimeoutMs = 20;
    emailMock.impl = () => new Promise(() => {});
    const f = fakeDb();
    const r = await generateAndEmailBriefing(envFor(f.db), "cron:daily");

    expect(r.emailSent).toBe(false);
    expect(r.error).toMatch(/timed out/);
    expect(f.briefingRows).toHaveLength(1);
    expect(f.briefingRows[0].emailed).toBe(0);
    expect(JSON.parse(f.briefingRows[0].report_data).email_error).toMatch(/timed out/);
    expect(f.runUpdates[0].args[0]).toBe("success");
  });
});

// ─── 6. output contract ────────────────────────────────────────

describe("ComprehensiveBriefing output fields", () => {
  it("keeps the same top-level and nested keys", async () => {
    const b = await fetchComprehensiveBriefing(envFor(fakeDb().db));
    expect(Object.keys(b).sort()).toEqual([
      "agentActivity", "brandCoverage", "enrichment", "feedHealth", "feedProduction",
      "flightController", "generatedAt", "geopoliticalCampaigns", "honeypot",
      "marketingVisibility", "newCapabilities", "newThreats", "platformOverview",
      "spamTrap", "statusBadge", "topTargetedBrands",
    ]);
    expect(Object.keys(b.enrichment).sort()).toEqual([
      "abuse_checked", "abuse_hits", "dbl_checked", "dbl_hits", "gn_checked", "gsb_checked",
      "gsb_hits", "sec_checked", "surbl_checked", "surbl_hits", "vt_checked", "vt_hits",
    ]);
    expect(Object.keys(b.newCapabilities).sort()).toEqual([
      "appstore_new", "appstore_total", "certstream", "darkweb_new", "darkweb_total",
      "social_new", "social_total", "typosquat_new", "typosquat_total",
    ]);
    expect(Object.keys(b.platformOverview).sort()).toEqual([
      "avgPerHour", "brandsClassified", "brandsMonitored", "last12h", "last24h",
      "todayCount", "totalThreats", "yesterdayCount",
    ]);
  });
});
