/**
 * Coverage for the PR #1711 review fixes F1 / F2 / F3 / F7 / F8.
 *
 * Three independent lanes:
 *
 *  1. `lib/geo-exhaustion.ts` — the shared geo-terminality predicate,
 *     driven against a REAL SQLite instance (`node:sqlite`, built into
 *     Node 22, so no new devDependency). String-matching the SQL would
 *     not have caught the defect these constants exist to fix: the old
 *     `enrichment_attempts >= 8` predicate was perfectly well-formed SQL
 *     that simply matched nothing the geo pipeline can produce. The only
 *     way to prove a threshold is reachable is to write the rows the
 *     writers write and count what comes back.
 *
 *  2. `foldVelocityDistribution` (F7) — the >100%-coverage arithmetic.
 *
 *  3. `deriveWorkflowRunTotals` (F8) + `getWorkflowAgentStats`'s
 *     correlated `last_error` (F8), the latter also against real SQLite.
 *
 * The SQLite lanes self-skip if `node:sqlite` is unavailable (older Node),
 * so this file never turns into a portability tax.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  GEO_UNMAPPED_POPULATION_SQL,
  GEO_TERMINAL_SQL,
  GEO_AWAITING_MMDB_SQL,
  GEO_PHASE0_ELIGIBLE_SQL,
} from "../src/lib/geo-exhaustion";
import { foldVelocityDistribution, deriveWorkflowRunTotals } from "../src/handlers/diagnostics";
import { getWorkflowAgentStats } from "../src/lib/workflow-agent-stats";

// ═══════════════════════════════════════════════════════════════════════
// node:sqlite harness + a minimal D1Database shim
// ═══════════════════════════════════════════════════════════════════════

type SqliteCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
};

// Resolved SYNCHRONOUSLY at collection time — `describe.skipIf` is
// evaluated before any `beforeAll` hook, so an async import here would
// skip every SQLite lane on a runtime that actually supports it.
const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: SqliteCtor | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: SqliteCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const hasSqlite = (): boolean => DatabaseSync !== null;

/** Wrap a node:sqlite handle in just enough of the D1Database surface for
 *  the code under test: `prepare().bind().all()/.first()`. */
function d1(raw: InstanceType<SqliteCtor>): D1Database {
  const make = (sql: string, bound: unknown[]): D1PreparedStatement => ({
    bind: (...args: unknown[]) => make(sql, args),
    all: async () => ({ results: raw.prepare(sql).all(...bound), success: true, meta: {} }),
    first: async (col?: string) => {
      const rows = raw.prepare(sql).all(...bound) as Array<Record<string, unknown>>;
      if (rows.length === 0) return null;
      return col ? rows[0][col] : rows[0];
    },
    run: async () => ({ results: [], success: true, meta: raw.prepare(sql).run(...bound) }),
    raw: async () => [],
  } as unknown as D1PreparedStatement);
  return { prepare: (sql: string) => make(sql, []) } as unknown as D1Database;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Geo terminality — F1 / F2 / F3
// ═══════════════════════════════════════════════════════════════════════

/** Column set the predicates touch, plus what the writers actually stamp. */
const THREATS_DDL = `
  CREATE TABLE threats (
    id TEXT PRIMARY KEY,
    status TEXT,
    source_feed TEXT,
    threat_type TEXT,
    ip_address TEXT,
    is_private_ip INTEGER DEFAULT 0,
    enriched_at TEXT,
    lat REAL,
    enrichment_attempts INTEGER DEFAULT 0,
    geo_mmdb_checked_at TEXT,
    dns_exhausted_at TEXT
  );
`;

interface Row {
  id: string;
  status?: string;
  ip_address?: string | null;
  is_private_ip?: number;
  enriched_at?: string | null;
  enrichment_attempts?: number;
  geo_mmdb_checked_at?: string | null;
  dns_exhausted_at?: string | null;
}

function seed(raw: InstanceType<SqliteCtor>, rows: Row[]): void {
  for (const r of rows) {
    raw.prepare(
      `INSERT INTO threats (id, status, source_feed, threat_type, ip_address, is_private_ip,
                            enriched_at, enrichment_attempts, geo_mmdb_checked_at, dns_exhausted_at)
       VALUES (?, ?, 'feed_a', 'phishing', ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.status ?? "active",
      r.ip_address === undefined ? "8.8.8.8" : r.ip_address,
      r.is_private_ip ?? 0,
      r.enriched_at ?? null,
      r.enrichment_attempts ?? 0,
      r.geo_mmdb_checked_at ?? null,
      r.dns_exhausted_at ?? null,
    );
  }
}

function bandCounts(raw: InstanceType<SqliteCtor>): {
  active: number; awaiting: number; exhausted: number; population: number;
} {
  const row = raw.prepare(`
    SELECT
      SUM(CASE WHEN ${GEO_PHASE0_ELIGIBLE_SQL} THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN ${GEO_AWAITING_MMDB_SQL}  THEN 1 ELSE 0 END) AS awaiting,
      SUM(CASE WHEN ${GEO_TERMINAL_SQL}       THEN 1 ELSE 0 END) AS exhausted,
      COUNT(*) AS population
    FROM threats WHERE ${GEO_UNMAPPED_POPULATION_SQL}
  `).all()[0] as Record<string, number | null>;
  return {
    active: row.active ?? 0,
    awaiting: row.awaiting ?? 0,
    exhausted: row.exhausted ?? 0,
    population: row.population ?? 0,
  };
}

describe.skipIf(!hasSqlite())("geo-exhaustion predicates (real SQLite)", () => {
  let raw: InstanceType<SqliteCtor>;

  beforeAll(() => {
    raw = new DatabaseSync!(":memory:");
    raw.exec(THREATS_DDL);
    seed(raw, [
      // ── in-population, one per band ──────────────────────────────
      // Fresh ingest — Phase 0 has budget.
      { id: "active_fresh", enrichment_attempts: 0 },
      // Phase 0 partway through its five tries.
      { id: "active_mid", enrichment_attempts: 3 },
      // Phase 0 capped, MMDB already consulted while it still had budget.
      { id: "active_mmdb_done", enrichment_attempts: 2, geo_mmdb_checked_at: "2026-09-10 00:00:00" },
      // Phase 0 capped at its ceiling, MMDB has not looked yet.
      { id: "awaiting_1", enrichment_attempts: 5 },
      { id: "awaiting_2", enrichment_attempts: 5 },
      // Both phases gave up — the ONLY terminal shape the geo pipeline
      // can produce post-0ee677e (attempts pinned at exactly 5).
      { id: "terminal_1", enrichment_attempts: 5, geo_mmdb_checked_at: "2026-09-11 00:00:00" },
      { id: "terminal_2", enrichment_attempts: 5, geo_mmdb_checked_at: "2026-09-11 01:00:00" },
      { id: "terminal_3", enrichment_attempts: 5, geo_mmdb_checked_at: "2026-09-11 02:00:00" },

      // ── out of population ────────────────────────────────────────
      // F2: dns-backfill.ts:399's dead-domain sentinel. attempts=8, NO ip.
      { id: "dns_dead_null_ip", ip_address: null, enrichment_attempts: 8, dns_exhausted_at: "2026-09-11 00:00:00" },
      { id: "dns_dead_empty_ip", ip_address: "", enrichment_attempts: 8, dns_exhausted_at: "2026-09-11 00:00:00" },
      // Already geo-located.
      { id: "enriched", enrichment_attempts: 5, geo_mmdb_checked_at: "2026-09-11 00:00:00", enriched_at: "2026-09-11 00:00:00" },
      // Not an active threat.
      { id: "inactive", status: "resolved", enrichment_attempts: 5, geo_mmdb_checked_at: "2026-09-11 00:00:00" },
      // Private IP — never a geo candidate.
      { id: "private", is_private_ip: 1, enrichment_attempts: 5, geo_mmdb_checked_at: "2026-09-11 00:00:00" },
    ]);
  });

  it("F1: the terminal band is REACHABLE by rows the geo pipeline can actually produce", () => {
    // The whole point. Phase 0 caps enrichment_attempts at 5 and Phase 0.5
    // no longer writes the column at all, so this must be > 0 for rows
    // pinned at exactly 5 with the MMDB marker stamped.
    expect(bandCounts(raw).exhausted).toBe(3);
  });

  it("F1 regression: the OLD `>= 8` predicate reports zero over the same corpus", () => {
    // Frozen-forever bug reproduced. Every geo-terminal row sits at 5;
    // the only rows at 8 are the DNS-dead sentinels, which the population
    // filter excludes. So the pre-fix panel would have read "No threats
    // in the exhausted pile — cartographer is keeping up" while three
    // rows were terminally un-geolocatable.
    const row = raw.prepare(`
      SELECT COUNT(*) AS n FROM threats
       WHERE ${GEO_UNMAPPED_POPULATION_SQL} AND enrichment_attempts >= 8
    `).all()[0] as { n: number };
    expect(row.n).toBe(0);
  });

  it("F1: rows Phase 0 gave up on but MMDB has not seen are awaiting, not terminal", () => {
    const b = bandCounts(raw);
    expect(b.awaiting).toBe(2);
    // and they are not double-counted as exhausted
    expect(b.awaiting + b.exhausted).toBe(5);
  });

  it("F1: the awaiting band is populatable (the band it replaced was not)", () => {
    // The old `retrying_mmdb` band was `>= 5 AND < 8` — unreachable once
    // Phase 0.5 stopped incrementing, since every row is pinned at 5.
    // Prove the replacement actually holds rows.
    expect(bandCounts(raw).awaiting).toBeGreaterThan(0);
  });

  it("F1: a row still inside Phase 0's budget is active even after an MMDB miss", () => {
    const row = raw.prepare(`
      SELECT COUNT(*) AS n FROM threats
       WHERE ${GEO_UNMAPPED_POPULATION_SQL} AND ${GEO_PHASE0_ELIGIBLE_SQL}
         AND geo_mmdb_checked_at IS NOT NULL
    `).all()[0] as { n: number };
    expect(row.n).toBe(1); // active_mmdb_done
  });

  it("F2: the DNS-dead `enrichment_attempts = 8` sentinel is excluded from every band", () => {
    // A resolver outage graduating 10K domains as dead must not move the
    // geo-exhaustion panel. Both sentinel shapes (NULL ip and '' ip).
    const b = bandCounts(raw);
    expect(b.population).toBe(8);
    const ids = (raw.prepare(
      `SELECT id FROM threats WHERE ${GEO_UNMAPPED_POPULATION_SQL}`,
    ).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain("dns_dead_null_ip");
    expect(ids).not.toContain("dns_dead_empty_ip");
  });

  it("excludes enriched, inactive and private-IP rows from the population", () => {
    const ids = (raw.prepare(
      `SELECT id FROM threats WHERE ${GEO_UNMAPPED_POPULATION_SQL}`,
    ).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain("enriched");
    expect(ids).not.toContain("inactive");
    expect(ids).not.toContain("private");
  });

  it("F3: the three bands partition the population exactly — no gap, no overlap", () => {
    const b = bandCounts(raw);
    expect(b.active + b.awaiting + b.exhausted).toBe(b.population);
  });

  it("F3: a per-feed breakdown over the same predicate sums to the headline", () => {
    // The headline/breakdown mismatch was the visible symptom of the
    // three-way population disagreement.
    const headline = (raw.prepare(`
      SELECT COUNT(*) AS n FROM threats
       WHERE ${GEO_UNMAPPED_POPULATION_SQL} AND ${GEO_TERMINAL_SQL}
    `).all()[0] as { n: number }).n;
    const byFeed = raw.prepare(`
      SELECT source_feed, threat_type, COUNT(*) AS n FROM threats
       WHERE ${GEO_UNMAPPED_POPULATION_SQL} AND ${GEO_TERMINAL_SQL}
       GROUP BY source_feed, threat_type
    `).all() as Array<{ n: number }>;
    expect(byFeed.reduce((s, r) => s + r.n, 0)).toBe(headline);
  });
});

// ── Static guard: all three surfaces must use the shared constants ────

describe("geo-exhaustion is the single source of truth", () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  const surfaces = [
    ["handlers/admin/metrics.ts", "../src/handlers/admin/metrics.ts"],
    ["handlers/cartographer-health.ts", "../src/handlers/cartographer-health.ts"],
    ["handlers/diagnostics.ts", "../src/handlers/diagnostics.ts"],
  ] as const;

  for (const [label, rel] of surfaces) {
    it(`${label} imports the shared predicate rather than re-typing it`, () => {
      expect(read(rel)).toMatch(/from ["'][./]*(\.\.\/)*lib\/geo-exhaustion["']/);
    });

    it(`${label} carries no hand-rolled \`enrichment_attempts >= 8\` threshold`, () => {
      // The unreachable threshold. If this fires, a surface has drifted
      // back off the shared predicate — see lib/geo-exhaustion.ts.
      expect(read(rel)).not.toMatch(/enrichment_attempts\s*>=\s*8/);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. F7 — velocity coverage arithmetic
// ═══════════════════════════════════════════════════════════════════════

describe("foldVelocityDistribution coverage (F7)", () => {
  it("never reports >100% when flagged rows have no registration date", () => {
    // The defect: `stamped` counted the has_reg=0 flagged rows, which are
    // absent from `candidates_total`. 60 stamped over a 50-row denominator.
    const out = foldVelocityDistribution([
      { flag: "fast", has_reg: 1, n: 30 },
      { flag: null, has_reg: 1, n: 20 },
      { flag: "very_fast", has_reg: 0, n: 30 }, // orphans
      { flag: null, has_reg: 0, n: 10 },
    ]);
    expect(out.coverage.candidates_total).toBe(50);
    expect(out.coverage.stamped).toBe(30);
    expect(out.coverage.stamped_pct_of_candidates).toBe(60);
    expect(out.coverage.stamped_pct_of_candidates).toBeLessThanOrEqual(100);
  });

  it("does not clamp a real backlog to zero", () => {
    // Pre-fix this returned unstamped_candidates = max(0, 50 - 60) = 0 —
    // "sweep complete" over a 20-row backlog.
    const out = foldVelocityDistribution([
      { flag: "fast", has_reg: 1, n: 30 },
      { flag: null, has_reg: 1, n: 20 },
      { flag: "very_fast", has_reg: 0, n: 30 },
    ]);
    expect(out.coverage.unstamped_candidates).toBe(20);
  });

  it("keeps flagged non-candidates visible as stamped_orphans", () => {
    const out = foldVelocityDistribution([
      { flag: "fast", has_reg: 1, n: 30 },
      { flag: "very_fast", has_reg: 0, n: 7 },
      { flag: null, has_reg: 0, n: 3 },
    ]);
    expect(out.coverage.stamped_orphans).toBe(7);
  });

  it("reports zero orphans on a clean corpus, and the invariants hold", () => {
    const out = foldVelocityDistribution([
      { flag: "very_fast", has_reg: 1, n: 5 },
      { flag: "normal", has_reg: 1, n: 15 },
      { flag: null, has_reg: 1, n: 10 },
      { flag: null, has_reg: 0, n: 70 },
    ]);
    expect(out.coverage.stamped_orphans).toBe(0);
    expect(out.total).toBe(100);
    expect(out.coverage.no_registration_date).toBe(70);
    expect(out.coverage.stamped + out.coverage.unstamped_candidates)
      .toBe(out.coverage.candidates_total);
    expect(out.coverage.stamped_pct_of_candidates).toBe(66.7);
  });

  it("folds NULL flags into not_computable and orders the bands", () => {
    const out = foldVelocityDistribution([
      { flag: null, has_reg: 0, n: 4 },
      { flag: "normal", has_reg: 1, n: 1 },
      { flag: null, has_reg: 1, n: 2 },
      { flag: "very_fast", has_reg: 1, n: 3 },
    ]);
    expect(out.by_flag).toEqual([
      { flag: "very_fast", n: 3 },
      { flag: "normal", n: 1 },
      { flag: "not_computable", n: 6 },
    ]);
  });

  it("handles an empty corpus without dividing by zero", () => {
    const out = foldVelocityDistribution([]);
    expect(out.total).toBe(0);
    expect(out.coverage.candidate_pct).toBe(0);
    expect(out.coverage.stamped_pct_of_candidates).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. F8 — workflow run counters + correlated last_error
// ═══════════════════════════════════════════════════════════════════════

describe("deriveWorkflowRunTotals (F8)", () => {
  const base = { dispatched: 0, completed: 0, dispatch_failed: 0, cooldown_skipped: 0, run_failed: 0 };

  it("does not subtract dispatch_failed from running", () => {
    // dispatch_failed is emitted INSTEAD of workflow_dispatched, so it was
    // never inside `dispatched`. Pre-fix: 6 - 0 - 2 - 0 = 4, hiding two
    // genuinely in-flight runs.
    const t = deriveWorkflowRunTotals({ ...base, dispatched: 6, dispatch_failed: 2 });
    expect(t.running).toBe(6);
  });

  it("does subtract run_failed from running", () => {
    // Those runs DID emit workflow_dispatched, then the body threw.
    const t = deriveWorkflowRunTotals({ ...base, dispatched: 6, run_failed: 6 });
    expect(t.running).toBe(0);
    expect(t.failed).toBe(6);
  });

  it("counts both failure classes as failed", () => {
    const t = deriveWorkflowRunTotals({ ...base, dispatched: 5, dispatch_failed: 2, run_failed: 3 });
    expect(t.failed).toBe(5);
  });

  it("sums the three disjoint dispatch outcomes into total_runs", () => {
    const t = deriveWorkflowRunTotals({
      ...base, dispatched: 4, dispatch_failed: 2, cooldown_skipped: 1, run_failed: 3,
    });
    // run_failed is inside dispatched and must NOT inflate total_runs.
    expect(t.total_runs).toBe(7);
  });

  it("never returns a negative running count", () => {
    const t = deriveWorkflowRunTotals({ ...base, dispatched: 1, completed: 3, run_failed: 2 });
    expect(t.running).toBe(0);
  });

  it("the healthy steady state reconciles", () => {
    const t = deriveWorkflowRunTotals({ ...base, dispatched: 6, completed: 5 });
    expect(t).toEqual({ total_runs: 6, failed: 0, running: 1 });
  });
});

describe.skipIf(!hasSqlite())("getWorkflowAgentStats last_error (F8, real SQLite)", () => {
  const DDL = `
    CREATE TABLE agent_activity_log (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT,
      event_type TEXT NOT NULL,
      message TEXT,
      metadata_json TEXT,
      severity TEXT DEFAULT 'info',
      created_at TEXT
    );
  `;

  it("returns the message belonging to last_failure_at, not the lexicographic max", async () => {
    const raw = new DatabaseSync!(":memory:");
    raw.exec(DDL);
    const ins = (id: string, type: string, msg: string | null, at: string) =>
      raw.prepare(
        `INSERT INTO agent_activity_log (id, agent_id, event_type, message, created_at)
         VALUES (?, 'nexus', ?, ?, ?)`,
      ).run(id, type, msg, at);

    const now = new Date();
    const ago = (h: number) =>
      new Date(now.getTime() - h * 3_600_000).toISOString().replace("T", " ").slice(0, 19);

    // The older event's message sorts LAST alphabetically, so MAX(message)
    // picks it — while last_failure_at points at the newer one. That is the
    // exact mismatch F8 describes: a platform dispatch error shown beside a
    // timestamp that belongs to a body failure.
    ins("e1", "workflow_dispatched", null, ago(6));
    ins("e2", "workflow_dispatch_failed", "zzz WorkflowInternalError: binding missing", ago(5));
    ins("e3", "workflow_dispatched", null, ago(2));
    ins("e4", "workflow_failed", "aaa cluster tail OOM", ago(1));

    const stats = await getWorkflowAgentStats(d1(raw), 24);
    const nexus = stats.get("nexus")!;

    expect(nexus.last_error).toBe("aaa cluster tail OOM");
    expect(nexus.last_failure_at).toBe(ago(1));
    // Guard against the regression directly.
    expect(nexus.last_error).not.toContain("WorkflowInternalError");
    // and the counters still roll up
    expect(nexus.dispatched).toBe(2);
    expect(nexus.dispatch_failed).toBe(1);
    expect(nexus.run_failed).toBe(1);
  });

  it("returns a null last_error when the window holds no failures", async () => {
    const raw = new DatabaseSync!(":memory:");
    raw.exec(DDL);
    const at = new Date(Date.now() - 3_600_000).toISOString().replace("T", " ").slice(0, 19);
    raw.prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, created_at)
       VALUES ('e1', 'nexus', 'batch_complete', 'ok', ?)`,
    ).run(at);

    const stats = await getWorkflowAgentStats(d1(raw), 24);
    expect(stats.get("nexus")!.last_error).toBeNull();
    expect(stats.get("nexus")!.last_failure_at).toBeNull();
  });

  it("ignores failures older than the window", async () => {
    const raw = new DatabaseSync!(":memory:");
    raw.exec(DDL);
    const old = new Date(Date.now() - 72 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
    const recent = new Date(Date.now() - 3_600_000).toISOString().replace("T", " ").slice(0, 19);
    raw.prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, created_at)
       VALUES ('old', 'nexus', 'workflow_failed', 'ancient failure', ?)`,
    ).run(old);
    raw.prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, created_at)
       VALUES ('new', 'nexus', 'workflow_dispatched', NULL, ?)`,
    ).run(recent);

    // The correlated subquery carries its own window bind; if that bind
    // were dropped it would leak the out-of-window message back in.
    const stats = await getWorkflowAgentStats(d1(raw), 24);
    expect(stats.get("nexus")!.last_error).toBeNull();
  });
});
