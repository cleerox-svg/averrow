// DNS-queue priority lane — IdP-impersonation threats resolve first.
//
// Every downstream enrichment of a threat (Cartographer Phase 0 geo / ASN /
// provider, GreyNoise) is gated on threats.ip_address, which only the DNS
// drain (lib/dns-backfill.ts) writes. IdP-family threats
// (threats.technique IN IDP_FAMILY_TECHNIQUES, lib/idp-impersonation.ts) are
// the platform's highest-value identity signal, so they get a priority lane:
//
//   dns_queue.priority (DNS-queue migration 0002) — 0 normal, 1 IdP family.
//   The drain reads the priority rows first through the tiny partial index
//   idx_dns_queue_priority_drainable, then fills the batch from the normal
//   index (DNS_DRAIN_NORMAL_SQL, `priority = 0` residual).
//
// Writers (all go through dnsQueueUpsertStmt — one statement per domain,
// promote-only, never demote):
//   - lib/dns-queue-reconciler.ts: stamps priority from the candidate
//     threat's technique as it enqueues (covers every insert-time tagger:
//     feedRunner, phishdestroy, CertStream — zero extra reads).
//   - durableObjects/CertStreamMonitor.ts: enqueues IdP-family certs
//     directly at write time (no 5-min reconciler wait).
//   - POST /api/internal/dns-queue/prioritize-idp: bounded backfill for
//     existing IdP threats still lacking ip_address (and threats tagged
//     AFTER insert, e.g. by the brand-match pass).
//
// DNS_QUEUE_DB is an optional binding — every entry point is a no-op without
// it. Never throws: DNS enqueue is best-effort; the reconciler is the net.

import type { Env } from "../types";
import { IDP_FAMILY_TECHNIQUES } from "./idp-impersonation";

export const DNS_PRIORITY_NORMAL = 0;
export const DNS_PRIORITY_IDP = 1;

/** D1 batch chunk — per-row statements, same as the reconciler. */
const CHUNK_SIZE = 50;

/**
 * Promote-only upsert. A new domain is inserted with `priority`; an existing
 * row is raised to `priority` only when that is higher (a priority-0 call on
 * an existing row is a no-op → meta.changes 0, exactly INSERT OR IGNORE).
 * Attempts / cooldown are never touched. Binds: domain, source_feed, priority.
 */
export const DNS_QUEUE_UPSERT_SQL = `
  INSERT INTO dns_queue
    (malicious_domain, enrichment_attempts, attempted_resolve_at, source_feed, enqueued_at, priority)
  VALUES (?, 0, NULL, ?, datetime('now'), ?)
  ON CONFLICT(malicious_domain) DO UPDATE SET priority = excluded.priority
    WHERE excluded.priority > dns_queue.priority`;

/** Drain read 1 — drainable priority rows. Binds: limit. */
export const DNS_DRAIN_PRIORITY_SQL = `
        SELECT malicious_domain
        FROM dns_queue INDEXED BY idx_dns_queue_priority_drainable
        WHERE priority > 0
          AND enrichment_attempts < 8
          AND (attempted_resolve_at IS NULL
               OR attempted_resolve_at < datetime('now', '-6 hours'))
        LIMIT ?`;

/** Drain read 2 — the normal lane. `priority = 0` is a residual on the
 *  existing partial index so a priority row is never selected twice.
 *  Binds: limit. */
export const DNS_DRAIN_NORMAL_SQL = `
        SELECT malicious_domain
        FROM dns_queue INDEXED BY idx_dns_queue_drainable
        WHERE enrichment_attempts < 8
          AND priority = 0
          AND (attempted_resolve_at IS NULL
               OR attempted_resolve_at < datetime('now', '-6 hours'))
        LIMIT ?`;

export function dnsQueueUpsertStmt(
  db: D1Database,
  domain: string,
  sourceFeed: string | null,
  priority: number,
): D1PreparedStatement {
  return db.prepare(DNS_QUEUE_UPSERT_SQL).bind(domain, sourceFeed, priority);
}

export function isIdpFamilyTechnique(technique: string | null | undefined): boolean {
  return typeof technique === "string" && IDP_FAMILY_TECHNIQUES.includes(technique);
}

export function dnsPriorityForTechnique(technique: string | null | undefined): number {
  return isIdpFamilyTechnique(technique) ? DNS_PRIORITY_IDP : DNS_PRIORITY_NORMAL;
}

/** Mirrors the reconciler's candidate filter (CANDIDATE_FILTER_SQL). */
export function isDnsQueueableDomain(domain: string | null | undefined): domain is string {
  return typeof domain === "string" && domain !== "" && !domain.startsWith("*") && domain.includes(".");
}

export interface DnsEnqueueItem {
  malicious_domain: string | null;
  source_feed: string | null;
}

/**
 * Enqueue (or promote) domains into the IdP priority lane. One upsert per
 * distinct queueable domain, chunked into D1 batches. Returns rows written
 * (inserted + promoted). No-op (0) without the binding; never throws.
 */
export async function enqueueIdpDns(
  queueDb: D1Database | undefined,
  items: readonly DnsEnqueueItem[],
): Promise<number> {
  if (!queueDb || items.length === 0) return 0;
  const byDomain = new Map<string, string | null>();
  for (const it of items) {
    if (isDnsQueueableDomain(it.malicious_domain) && !byDomain.has(it.malicious_domain)) {
      byDomain.set(it.malicious_domain, it.source_feed);
    }
  }
  const rows = [...byDomain];
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const stmts = rows.slice(i, i + CHUNK_SIZE)
      .map(([domain, feed]) => dnsQueueUpsertStmt(queueDb, domain, feed, DNS_PRIORITY_IDP));
    try {
      const results = await queueDb.batch(stmts);
      for (const r of results) written += r.meta?.changes ?? 0;
    } catch (err) {
      console.error("[dns-queue-priority] enqueue batch failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return written;
}

// ── Internal backfill route ─────────────────────────────────────────

export const PRIORITIZE_IDP_DEFAULT_DAYS = 14;
export const PRIORITIZE_IDP_MAX_DAYS = 30;
export const PRIORITIZE_IDP_DEFAULT_LIMIT = 500;
export const PRIORITIZE_IDP_MAX_LIMIT = 1000;

const FAMILY_PH = IDP_FAMILY_TECHNIQUES.map(() => "?").join(", ");

/**
 * IdP-family threats in the window that still need DNS. Range seek on
 * idx_threats_technique_created (migration 0288) — reads only IdP-family
 * rows of the window. Binds: ...IDP_FAMILY_TECHNIQUES, since, limit.
 */
export const PRIORITIZE_IDP_SELECT_SQL = `
      SELECT malicious_domain, source_feed
      FROM threats INDEXED BY idx_threats_technique_created
      WHERE technique IN (${FAMILY_PH})
        AND created_at >= ?
        AND status = 'active'
        AND ip_address IS NULL
        AND dns_exhausted_at IS NULL
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
      ORDER BY created_at DESC
      LIMIT ?`;

export type PrioritizeIdpParams =
  | { ok: true; days: number; limit: number }
  | { ok: false; error: string };

function clampInt(raw: string | null, dflt: number, min: number, max: number): number | null {
  if (raw === null || raw === "") return dflt;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function parsePrioritizeIdpParams(params: URLSearchParams): PrioritizeIdpParams {
  const days = clampInt(params.get("days"), PRIORITIZE_IDP_DEFAULT_DAYS, 1, PRIORITIZE_IDP_MAX_DAYS);
  const limit = clampInt(params.get("limit"), PRIORITIZE_IDP_DEFAULT_LIMIT, 1, PRIORITIZE_IDP_MAX_LIMIT);
  if (days === null || limit === null) {
    return {
      ok: false,
      error: `days must be 1..${PRIORITIZE_IDP_MAX_DAYS} and limit 1..${PRIORITIZE_IDP_MAX_LIMIT}`,
    };
  }
  return { ok: true, days, limit };
}

export interface PrioritizeIdpResult {
  skipped: boolean;
  reason?: string;
  days: number;
  /** IdP-family threats read (pre-dedupe). */
  scanned: number;
  /** Distinct queueable domains. */
  domains: number;
  /** dns_queue rows inserted or promoted to the priority lane. */
  enqueued: number;
}

function d1Ts(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** One bounded pass: ≤limit threats rows read, ≤limit queue upserts. */
export async function prioritizeIdpDns(
  env: Env,
  days: number,
  limit: number,
  now: Date = new Date(),
): Promise<PrioritizeIdpResult> {
  const base: PrioritizeIdpResult = { skipped: false, days, scanned: 0, domains: 0, enqueued: 0 };
  if (!env.DNS_QUEUE_DB) return { ...base, skipped: true, reason: "binding_unset" };
  const since = d1Ts(new Date(now.getTime() - days * 86_400_000));
  const res = await env.DB.prepare(PRIORITIZE_IDP_SELECT_SQL)
    .bind(...IDP_FAMILY_TECHNIQUES, since, limit)
    .all<{ malicious_domain: string | null; source_feed: string | null }>();
  const rows = res.results ?? [];
  const domains = new Set(rows.map((r) => r.malicious_domain).filter(isDnsQueueableDomain)).size;
  const enqueued = await enqueueIdpDns(env.DNS_QUEUE_DB, rows);
  return { ...base, scanned: rows.length, domains, enqueued };
}
