/**
 * Tests for the DNS-queue parity diagnostics (S0.2 metric-correctness fix).
 *
 * Background: `dns_queue_parity.drainable_in_threats` used to read the
 * COOLDOWN-FILTERED dns_queue count (`domain_geo_drainable`). Since most
 * dns_queue rows sit mid-6h-retry-cooldown, comparing that against the
 * dns_queue row total always produced a huge phantom `delta` — the
 * mislabeled "R3 9,091-row drift" was this artifact, not a real backlog.
 *
 * The fix repoints `drainable_in_threats` at the TRUE threats-side
 * candidate count (`countDnsCandidatesInThreats`) — the same predicate
 * FC's `platform_dns_queue_drift` alert gates on, and the set the
 * reconciler enqueues / the reaper reaps against. That count is
 * cooldown-INDEPENDENT, so `delta` now tracks the reaper's observed
 * queue-vs-reality parity (~0 in the healthy steady state).
 *
 * What we verify:
 *   1. countDnsCandidatesInThreats returns COUNT(DISTINCT malicious_domain)
 *      over the candidate predicate, independent of cooldown/attempts state.
 *   2. The query targets threats with the exact candidate predicate and
 *      carries NO cooldown filter (enrichment_attempts / attempted_resolve_at)
 *      and never touches dns_queue — the regression guard.
 *   3. buildDnsQueueParity: delta ≈ 0 when the queue mirrors threats; grows
 *      only when a real gap (e.g. a ghost row) is injected; null when unbound.
 */

import { describe, it, expect } from "vitest";
import {
  countDnsCandidatesInThreats,
  buildDnsQueueParity,
} from "../src/handlers/diagnostics";

interface ThreatRow {
  malicious_domain: string | null;
  ip_address: string | null;
  status: string;
  dns_exhausted_at: string | null;
  // Cooldown / attempts state — MUST NOT affect the candidate count.
  attempted_resolve_at?: string | null;
  enrichment_attempts?: number;
}

// JS mirror of the SQL candidate predicate (independent re-derivation, so
// the assertion isn't circular with the stub).
function isCandidate(t: ThreatRow): boolean {
  return (
    t.ip_address === null &&
    t.status === "active" &&
    t.dns_exhausted_at === null &&
    t.malicious_domain !== null &&
    t.malicious_domain !== "" &&
    !t.malicious_domain.startsWith("*") &&
    t.malicious_domain.includes(".")
  );
}

function expectedCandidates(rows: ThreatRow[]): number {
  const domains = new Set<string>();
  for (const r of rows) if (isCandidate(r)) domains.add(r.malicious_domain as string);
  return domains.size;
}

// Fixture DB stub: evaluates the candidate predicate over seeded threat
// rows and returns COUNT(DISTINCT malicious_domain), like D1 would. Also
// captures the issued SQL so we can assert its shape.
function makeDb(rows: ThreatRow[]): { db: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      return {
        first: async () => ({ n: expectedCandidates(rows) }),
      };
    },
  } as unknown as D1Database;
  return { db, sqls };
}

describe("countDnsCandidatesInThreats", () => {
  it("counts distinct candidate domains, independent of cooldown/attempts", async () => {
    const rows: ThreatRow[] = [
      // Candidates in varied cooldown/attempts states — all count.
      { malicious_domain: "a.com", ip_address: null, status: "active", dns_exhausted_at: null, attempted_resolve_at: null, enrichment_attempts: 0 },
      { malicious_domain: "b.com", ip_address: null, status: "active", dns_exhausted_at: null, attempted_resolve_at: "2026-07-18T00:00:00Z", enrichment_attempts: 3 }, // mid-cooldown
      { malicious_domain: "c.com", ip_address: null, status: "active", dns_exhausted_at: null, attempted_resolve_at: "2026-07-18T00:00:00Z", enrichment_attempts: 7 }, // near cap, still candidate
      { malicious_domain: "a.com", ip_address: null, status: "active", dns_exhausted_at: null, enrichment_attempts: 1 }, // dup domain → distinct
      // Non-candidates.
      { malicious_domain: "resolved.com", ip_address: "1.2.3.4", status: "active", dns_exhausted_at: null }, // has IP
      { malicious_domain: "inactive.com", ip_address: null, status: "inactive", dns_exhausted_at: null }, // ghost
      { malicious_domain: "exhausted.com", ip_address: null, status: "active", dns_exhausted_at: "2026-07-01T00:00:00Z" },
      { malicious_domain: "*.wild.com", ip_address: null, status: "active", dns_exhausted_at: null }, // wildcard
      { malicious_domain: "nodot", ip_address: null, status: "active", dns_exhausted_at: null }, // no dot
      { malicious_domain: "", ip_address: null, status: "active", dns_exhausted_at: null }, // empty
      { malicious_domain: null, ip_address: null, status: "active", dns_exhausted_at: null }, // null
    ];
    const { db, sqls } = makeDb(rows);

    const n = await countDnsCandidatesInThreats(db);
    expect(n).toBe(expectedCandidates(rows));
    expect(n).toBe(3); // a.com, b.com, c.com

    // Regression guard — no cooldown filter, threats-only, distinct count.
    const sql = sqls[0]!;
    expect(sql).toMatch(/FROM\s+threats/i);
    expect(sql).toMatch(/COUNT\(DISTINCT\s+malicious_domain\)/i);
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(sql).toMatch(/ip_address\s+IS\s+NULL/i);
    expect(sql).toMatch(/dns_exhausted_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/malicious_domain\s+NOT\s+LIKE\s+'\*%'/i);
    expect(sql).toMatch(/malicious_domain\s+LIKE\s+'%\.%'/i);
    // The old, wrong query filtered on cooldown/attempts and hit dns_queue.
    expect(sql).not.toMatch(/enrichment_attempts/i);
    expect(sql).not.toMatch(/attempted_resolve_at/i);
    expect(sql).not.toMatch(/dns_queue/i);
  });

  it("returns 0 when no threats match the predicate", async () => {
    const { db } = makeDb([
      { malicious_domain: "resolved.com", ip_address: "1.2.3.4", status: "active", dns_exhausted_at: null },
    ]);
    expect(await countDnsCandidatesInThreats(db)).toBe(0);
  });
});

describe("buildDnsQueueParity", () => {
  it("delta is ≈ 0 when the queue mirrors the threats-side candidate set", () => {
    // Queue holds one row per candidate domain → true parity.
    const candidatesInThreats = 5000;
    const queueSize = 5000;
    const parity = buildDnsQueueParity({ bound: true, queueSize, candidatesInThreats });
    expect(parity.drainable_in_threats).toBe(candidatesInThreats);
    expect(parity.queue_size).toBe(queueSize);
    expect(parity.delta).toBe(0);
  });

  it("delta stays near-zero with a small mid-flight skew, not a phantom gap", () => {
    // The cooldown-filtered metric would have shown a ~9,091 phantom delta
    // here (most rows mid-cooldown). The corrected metric is cooldown-blind,
    // so a healthy queue shows only tick-level skew.
    const parity = buildDnsQueueParity({ bound: true, queueSize: 9145, candidatesInThreats: 9145 });
    expect(parity.delta).toBe(0);
    expect(Math.abs(parity.delta as number)).toBeLessThan(500); // under FC's DRIFT_THRESHOLD
  });

  it("delta grows only when a real gap (ghost rows) is injected", () => {
    // 3 ghost queue rows: threats flipped inactive after enqueue, so they
    // drop out of the candidate count but linger in dns_queue until the
    // reaper sweeps them.
    const candidatesInThreats = 5000;
    const queueSize = 5003;
    const parity = buildDnsQueueParity({ bound: true, queueSize, candidatesInThreats });
    expect(parity.delta).toBe(3);
  });

  it("delta is negative when reconciler enqueue lags behind threats", () => {
    const parity = buildDnsQueueParity({ bound: true, queueSize: 4800, candidatesInThreats: 5000 });
    expect(parity.delta).toBe(-200);
  });

  it("reports the daily count's age (it is compared against a live queue)", () => {
    const nowMs = Date.UTC(2026, 10, 7, 15, 0, 0);
    const t = Date.UTC(2026, 10, 7, 3, 2, 0);
    const parity = buildDnsQueueParity({
      bound: true, queueSize: 5000, candidatesInThreats: 5000, candidatesComputedAtMs: t, nowMs,
    });
    expect(parity.drainable_computed_at).toBe("2026-11-07T03:02:00.000Z");
    expect(parity.drainable_age_hours).toBe(12);
  });

  it("age fields are null when the write time is unknown", () => {
    const parity = buildDnsQueueParity({ bound: true, queueSize: 1, candidatesInThreats: 1 });
    expect(parity.drainable_computed_at).toBeNull();
    expect(parity.drainable_age_hours).toBeNull();
  });

  it("delta is null when DNS_QUEUE_DB is unbound", () => {
    const parity = buildDnsQueueParity({ bound: false, queueSize: 0, candidatesInThreats: 5000 });
    expect(parity.delta).toBeNull();
    expect(parity.bound).toBe(false);
  });
});
