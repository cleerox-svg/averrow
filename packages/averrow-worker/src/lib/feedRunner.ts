/**
 * Feed Runner v2 — Central orchestrator for intelligence feed ingestion.
 *
 * Uses v2 tables: feed_configs, feed_status, feed_pull_history, threats
 *
 * Features:
 * - Schedule-based execution from feed_configs
 * - IOC deduplication via KV cache + DB INSERT OR IGNORE
 * - Per-feed execution logging to feed_pull_history
 * - Feed health status tracking in feed_status
 *
 * Telemetry cut-over (Track B1d): feed_configs / feed_status /
 * feed_pull_history are the FEEDS family, routed by `db_route:telemetry:feeds`
 * (lib/db-route.ts). A pull resolves the family ONCE at its start
 * (resolveFamily) and carries the route, so its pull_history INSERT, its
 * finalize, the breaker penalty / reset and an auto-pause all hit the same DB
 * even when the flag flips mid-pull. Feed loops read configs + statuses from
 * the routed store. system_config (the global failure threshold) and
 * agent_activity_log (agents family) are not feeds tables.
 */

import type { Env } from "../types";
import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "../feeds/types";
import { createNotification } from "./notifications";
import { calculateConfidence, calculateSeverity, reclassifyThreatType } from "./threatScoring";
import { isPrivateIP } from "./geoip";
import { withD1Retry, isD1OverloadError, D1_OVERLOAD_RETRY_BASE_MS, type D1RetryOptions } from "./d1-retry";
import { computeBackoffRetryAt, FEED_RETRY_LADDER } from "./backoff";
import { tagThreat, needsBrandTokens, loadBrandTokens, isIdpFamilyTag } from "./idp-tagging";
import { enqueueAutoCaptures } from "./page-capture";
import { withD1Meter } from "./d1-meter";
import { familyStore, resolveFamily, telemetryDbFor, telemetryStore, type TelemetryHandle, type TelemetryRoute } from "./db-route";
import { byDesc, historyParts, unionFirst } from "./telemetry-read";

// ─── Deduplication ───────────────────────────────────────────────

/** Check if an IOC was already seen (KV-based, 24h TTL) */
export async function isDuplicate(env: Env, iocType: string, iocValue: string): Promise<boolean> {
  try {
    const key = `dedup:${iocType}:${iocValue}`;
    return (await env.CACHE.get(key)) !== null;
  } catch {
    return false;
  }
}

/** Mark an IOC as seen */
export async function markSeen(env: Env, iocType: string, iocValue: string): Promise<void> {
  try {
    const key = `dedup:${iocType}:${iocValue}`;
    await env.CACHE.put(key, "1", { expirationTtl: 86400 }); // 24h
  } catch { /* non-fatal */ }
}

// ─── Threat Insertion (v2 schema) ────────────────────────────────

/**
 * Build the bound `INSERT OR IGNORE INTO threats` statement for one row,
 * applying the same reclassification / confidence / severity / private-IP
 * derivation the platform uses everywhere. Single source of truth for the
 * threats column list so the single-row (`insertThreat`) and bulk
 * (`bulkInsertThreats`) paths can never diverge.
 */
function buildThreatInsertStmt(
  db: D1Database,
  threat: ThreatRow,
  brandTokens?: string[],
): D1PreparedStatement {
  // Apply heuristic reclassification (first-pass before AI Analyst)
  const reclassified = reclassifyThreatType(
    threat.threat_type,
    threat.malicious_url ?? null,
    threat.malicious_domain ?? null,
  );
  const threatType = reclassified ?? threat.threat_type;

  // Apply confidence score calibration if not set by the feed
  const confidence = threat.confidence_score ??
    calculateConfidence(threat.source_feed, threatType, !!threat.target_brand_id);

  // Derive severity from confidence if not set by the feed
  const severity = threat.severity ?? calculateSeverity(confidence);

  // Materialize the private-IP classification at insert time so
  // cartographer's Phase 0 selector can index on `is_private_ip = 0`
  // instead of chained NOT LIKE predicates (see migration 0175).
  // Null IP → 0 (the cartographer selector also filters on
  // `ip_address IS NOT NULL`, so the column value is irrelevant
  // for those rows).
  const isPrivateIp = threat.ip_address ? (isPrivateIP(threat.ip_address) ? 1 : 0) : 0;

  // IdP-impersonation tagging (lib/idp-impersonation.ts). Stamps the
  // family technique + abused IdP; a non-family technique passes through
  // untouched (never overwritten).
  const idp = tagThreat(threat, brandTokens);

  return db.prepare(
    `INSERT OR IGNORE INTO threats
       (id, source_feed, threat_type, malicious_url, malicious_domain,
        target_brand_id, hosting_provider_id, ip_address, asn, country_code,
        registrar, status, confidence_score, campaign_id, ioc_value, severity,
        is_private_ip, technique, impersonated_idp, named_threat_id,
        ssl_cert_serial, ssl_cert_issuer, ssl_san_hash, malware_family,
        first_seen, last_seen, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             datetime('now'), datetime('now'), datetime('now'))`
  ).bind(
    threat.id,
    threat.source_feed,
    threatType,
    threat.malicious_url,
    threat.malicious_domain,
    threat.target_brand_id ?? null,
    threat.hosting_provider_id ?? null,
    threat.ip_address ?? null,
    threat.asn ?? null,
    threat.country_code ?? null,
    threat.registrar ?? null,
    threat.status ?? "active",
    confidence,
    threat.campaign_id ?? null,
    threat.ioc_value ?? null,
    severity,
    isPrivateIp,
    idp.technique,
    idp.impersonated_idp,
    threat.named_threat_id ?? null,
    threat.ssl_cert_serial ?? null,
    threat.ssl_cert_issuer ?? null,
    threat.ssl_san_hash ?? null,
    threat.malware_family ?? null,
  );
}

/**
 * Fill `malware_family` onto an existing row that does not have one yet —
 * used for an IOC re-reported after the row was first inserted without a
 * family (e.g. before migration 0295). Kept separate from the INSERT OR
 * IGNORE so the insert's meta.changes still means "new row" (an upsert
 * would report the fill as a change and count a duplicate as new), and so
 * IGNORE keeps its exact semantics for every feed. Only called for rows
 * that carry a family, so feeds that never set one pay nothing.
 */
function buildMalwareFamilyFillStmt(db: D1Database, threat: ThreatRow): D1PreparedStatement {
  return db.prepare(
    "UPDATE threats SET malware_family = ? WHERE id = ? AND malware_family IS NULL",
  ).bind(threat.malware_family ?? null, threat.id);
}

export async function insertThreat(db: D1Database, threat: ThreatRow): Promise<boolean> {
  // Returns true when the row was inserted, false when the PK
  // conflict path was taken (duplicate). Callers that need to
  // distinguish new-vs-dup (e.g. the TAXII multi-page drain) can
  // skip a separate pre-dedup SELECT — D1 reports it via
  // meta.changes on INSERT OR IGNORE.
  // Brand tokens only for a host carrying a weak IdP lure (rare) — one
  // isolate-cached PK lookup, never on the common path.
  let brandTokens: string[] | undefined;
  if (threat.target_brand_id && needsBrandTokens(threat)) {
    brandTokens = (await loadBrandTokens(db, [threat.target_brand_id])).get(threat.target_brand_id);
  }
  const result = await buildThreatInsertStmt(db, threat, brandTokens).run();
  const inserted = (result.meta?.changes ?? 0) > 0;

  // Phishing page capture (lib/page-capture.ts): a NEW IdP-family threat is
  // queued for a headless-browser capture. One cheap INSERT … WHERE NOT
  // EXISTS; never awaits the browser; never throws.
  if (inserted && isIdpFamilyTag(tagThreat(threat, brandTokens))) {
    await enqueueAutoCaptures(db, [{
      threatId: threat.id, maliciousUrl: threat.malicious_url, maliciousDomain: threat.malicious_domain,
    }]);
  }

  // Keep brands.threat_count moving WITH the link at the write site so the
  // cube_healer reconciler (lib/brand-count-reconciler.ts) stops having to
  // sweep ~429 brands every 6h. Only bump on a genuinely new row: an
  // INSERT OR IGNORE conflict no-op reports meta.changes=0, so a duplicate
  // can never over-count — this is exactly why "+1 after insert" was never
  // safe to add naively on a dedup insert. Best-effort: a bump failure must
  // never break ingestion or corrupt feed accounting (the reconciler remains
  // the safety net), so it's swallowed.
  if (inserted && threat.target_brand_id) {
    await bumpBrandThreatCount(db, threat.target_brand_id, 1);
  }
  return inserted;
}

/**
 * Increment brands.threat_count by `n` for a single brand, keyed off a
 * threats-write that actually landed. Prepared statement, same shape as
 * db/brands.ts `bumpBrandThreatCountStmt` (kept inline here because the
 * feed path holds a raw `D1Database`, not an `Env`). Never throws — the
 * cube_healer reconciler is the backstop, so a transient bump failure must
 * not surface as a feed error.
 */
async function bumpBrandThreatCount(db: D1Database, brandId: string, n: number): Promise<void> {
  try {
    await db.prepare(
      "UPDATE brands SET threat_count = threat_count + ?, last_threat_seen = datetime('now') WHERE id = ?"
    ).bind(n, brandId).run();
  } catch (err) {
    console.error(`[feedRunner] brand threat_count bump failed for ${brandId}:`, err instanceof Error ? err.message : String(err));
  }
}

/** Default chunk size for bulk threat inserts — one D1 transaction per chunk. */
export const THREAT_INSERT_CHUNK = 50;

/**
 * Statements per db.batch() for the malware_family duplicate fill. Each is a
 * PK-lookup UPDATE that writes only a NULL column, so it can use a much
 * larger batch than the inserts (well under D1's per-batch statement cap)
 * to cut round-trips.
 */
export const MALWARE_FAMILY_FILL_CHUNK = 200;

/**
 * Bulk-insert threats via chunked `db.batch(INSERT OR IGNORE)` — the
 * canonical platform pattern (CLAUDE.md §8). Replaces the per-row
 * isDuplicate(KV GET)→insertThreat(D1)→markSeen(KV PUT) loop, which does
 * 3 sequential round-trips per IOC and gets the worker reaped on
 * large/cold-cache pulls. Dedup is the deterministic `threatId` PK +
 * INSERT OR IGNORE (authoritative, no KV cold-start cliff); callers should
 * dedupe within the payload in memory before calling.
 *
 * For N rows this is ceil(N / chunkSize) round-trips instead of 3N.
 * Accounting mirrors insertThreat: meta.changes=1 → new, 0 → duplicate;
 * a chunk that throws counts its whole length as errors (rolled back).
 */
export async function bulkInsertThreats(
  db: D1Database,
  rows: ThreatRow[],
  chunkSize: number = THREAT_INSERT_CHUNK,
): Promise<{ itemsNew: number; itemsDuplicate: number; itemsError: number }> {
  if (rows.length === 0) return { itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };

  // One chunked brand lookup for the (rare) rows whose host carries a weak
  // IdP lure — see insertThreat.
  const tokenBrandIds = rows
    .filter((r) => r.target_brand_id && needsBrandTokens(r))
    .map((r) => r.target_brand_id as string);
  const brandTokens = tokenBrandIds.length > 0 ? await loadBrandTokens(db, tokenBrandIds) : null;
  const rowTokens = rows.map((r) => (r.target_brand_id ? brandTokens?.get(r.target_brand_id) : undefined));
  const stmts = rows.map((r, i) => buildThreatInsertStmt(db, r, rowTokens[i]));
  // NEW IdP-family rows → page-capture queue (after the inserts, below).
  const captureCandidates: ThreatRow[] = [];
  let itemsNew = 0;
  let itemsError = 0;
  // Accumulate per-brand counts for rows that were ACTUALLY inserted this
  // batch (meta.changes>0), keyed back to rows[] by position within the
  // chunk. A conflict no-op contributes 0, so a re-pulled duplicate never
  // over-counts. Flushed as one targeted UPDATE per distinct brand after
  // all chunks — bounded by the number of distinct brands in the payload,
  // never a full-table scan. See insertThreat for the same rationale.
  const brandBumps = new Map<string, number>();
  // Duplicates (insert ignored) that carry a malware family — the existing
  // row may predate it; filled after the inserts, only where still NULL.
  const familyFills: ThreatRow[] = [];
  for (let i = 0; i < stmts.length; i += chunkSize) {
    const chunk = stmts.slice(i, i + chunkSize);
    try {
      const results = await db.batch(chunk);
      for (let k = 0; k < results.length; k++) {
        const changed = results[k]?.meta?.changes ?? 0;
        itemsNew += changed;
        if (changed === 0 && rows[i + k]?.malware_family) {
          familyFills.push(rows[i + k]!);
        }
        if (changed > 0) {
          const brandId = rows[i + k]?.target_brand_id;
          if (brandId) brandBumps.set(brandId, (brandBumps.get(brandId) ?? 0) + changed);
          const row = rows[i + k];
          if (row && isIdpFamilyTag(tagThreat(row, rowTokens[i + k]))) captureCandidates.push(row);
        }
      }
    } catch (err) {
      itemsError += chunk.length;
      console.error(`[bulkInsertThreats] chunk ${i}-${i + chunk.length} failed:`, err);
    }
  }

  // Best-effort brand-counter flush — same write-site discipline as
  // insertThreat, batched. Never throws: the cube_healer reconciler stays
  // the safety net, so a bump failure must not turn a successful ingest
  // into a feed error.
  if (brandBumps.size > 0) {
    try {
      await db.batch(
        [...brandBumps].map(([brandId, n]) =>
          db.prepare(
            "UPDATE brands SET threat_count = threat_count + ?, last_threat_seen = datetime('now') WHERE id = ?"
          ).bind(n, brandId)
        )
      );
    } catch (err) {
      console.error(`[bulkInsertThreats] brand threat_count flush failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  // malware_family back-fill for re-reported IOCs — best-effort, never
  // throws, and does not touch the new/duplicate/error accounting. Each
  // UPDATE is a PK lookup that writes only when the column is still NULL.
  for (let i = 0; i < familyFills.length; i += MALWARE_FAMILY_FILL_CHUNK) {
    try {
      await db.batch(
        familyFills.slice(i, i + MALWARE_FAMILY_FILL_CHUNK).map((r) => buildMalwareFamilyFillStmt(db, r)),
      );
    } catch (err) {
      console.error(`[bulkInsertThreats] malware_family fill failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Page-capture enqueue for the new IdP-family rows — best-effort, never
  // throws, never awaits the browser (lib/page-capture.ts).
  if (captureCandidates.length > 0) {
    await enqueueAutoCaptures(db, captureCandidates.map((r) => ({
      threatId: r.id, maliciousUrl: r.malicious_url, maliciousDomain: r.malicious_domain,
    })));
  }

  const itemsDuplicate = rows.length - itemsNew - itemsError;
  return { itemsNew, itemsDuplicate, itemsError };
}

// ─── Feed Config Row ─────────────────────────────────────────────

export interface FeedConfigRow {
  feed_name: string;
  display_name: string;
  source_url: string | null;
  schedule_cron: string;
  rate_limit: number;
  batch_size: number;
  retry_count: number;
  enabled: number;
  /** NULL → use the global default from system_config */
  consecutive_failure_threshold?: number | null;
}

export interface FeedStatusRow {
  feed_name: string;
  last_successful_pull: string | null;
  health_status: string;
  next_retry_at: string | null;
}

/**
 * Per-feed circuit breaker — exponential backoff with jitter applied
 * after each consecutive failure, computed from `consecutive_failures`.
 *
 * Schedule (base, before jitter):
 *   Fail #1  →   5 min
 *   Fail #2  →  15 min
 *   Fail #3  →  45 min
 *   Fail #4+ → 120 min (cap — same as the hourly cadence boundary;
 *                       past this the auto-pause threshold owns recovery)
 *
 * Jitter: ±25% so multiple feeds failing simultaneously don't
 * thunder-herd back at the exact same minute. The 2026 best-practice
 * consensus (Fastio, Adaline, Google Vertex AI retry docs) all stress
 * the jitter.
 *
 * The ladder and the jitter now live in `lib/backoff.ts`, which the
 * lookalike DNS checker shares (with its OWN ladder — see
 * LOOKALIKE_CHECK_LADDER for why a 120-min cap is wrong for a 24 h
 * cadence). This function is a thin adapter that keeps the feed path's
 * signature and its `FEED_RETRY_LADDER` steps exactly as they were;
 * `test/feed-circuit-breaker.test.ts` passes against it unmodified.
 */
export function computeFeedRetryAt(consecutiveFailures: number, now: Date = new Date()): string {
  const retryAt = computeBackoffRetryAt(FEED_RETRY_LADDER, consecutiveFailures, now);
  // FEED_RETRY_LADDER sets `terminalAfterAttempts: null`, so the ladder
  // can never say "park" and this is unreachable. Thrown rather than
  // `!`-asserted so the impossible case is loud instead of implicit.
  if (retryAt === null) {
    throw new Error('computeFeedRetryAt: the feed ladder must never park a feed');
  }
  return retryAt;
}

// ─── Dedicated-cron enrichment feeds ─────────────────────────────
//
// These enrichment feeds were starving (and being starved by) the rest
// of the inline-sequential enrichment chain in the hourly orchestrator:
// their self-imposed inter-call sleeps (greynoise 8×30s, seclookup
// 100×1s) accumulated past the worker's wall-clock budget, the worker
// was killed, and the in-flight pull was reaped — silently, forever
// (seclookup sat 11h+ overdue). They now run on their own cron triggers
// with a fresh per-invocation budget (same escape-hatch pattern as
// enricher/cartographer/strategist). runAllEnrichmentFeeds SKIPS them so
// they don't also run inline and re-create the starvation.
export const DEDICATED_ENRICHMENT_FEEDS = new Set<string>(["greynoise", "seclookup", "pulsedive"]);

/**
 * Dispatch a single enrichment feed by name from its dedicated cron.
 * Loads the feed_configs row, honors the enabled flag and the per-feed
 * circuit-breaker (next_retry_at backoff), then runs it. The cron itself
 * IS the schedule, so the schedule-interval check is intentionally NOT
 * applied here — only the breaker gate is. Never throws.
 */
export async function dispatchEnrichmentFeed(
  env: Env,
  name: string,
  mod: FeedModule,
): Promise<void> {
  try {
    const loaded = await loadDispatchableFeed(env, name, "dispatchEnrichmentFeed");
    if (!loaded) return;
    await runFeed(env, loaded.config, mod, { feeds: loaded.feeds });
  } catch (err) {
    console.error(`[dispatchEnrichmentFeed] ${name} failed:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Ingest feeds (feedModules) that run on their OWN cron instead of inside
 * runAllFeeds' pool in the hourly `7 * * * *` tick. runAllFeeds skips them;
 * handleScheduled (cron/orchestrator.ts) dispatches each by exact
 * event.cron match via dispatchDedicatedIngestFeed.
 *
 *   nrd_hagezi — the 29-past every-2h cron (`29 *\/2 * * *`) (owner decision 2026-11-10). Its once-a-day
 *   diff streams a ~51 MB list against a ~17 MB R2 snapshot and runs ~23
 *   large D1 batches; on 2026-11-09 five consecutive diff pulls were reaped
 *   while sharing the hourly invocation's CPU/memory/connection budget with
 *   the rest of the feed pool. Own invocation = fresh budget. The cron
 *   matches its feed_configs interval (every 2h).
 */
export const DEDICATED_INGEST_FEEDS = new Set<string>(["nrd_hagezi"]);

/**
 * Dispatch one DEDICATED_INGEST_FEEDS feed from its own cron. Same gates as
 * dispatchEnrichmentFeed — feed_configs row present + enabled, and the
 * per-feed circuit breaker (next_retry_at) — and, as there, NOT the
 * schedule-interval check: the cron is the schedule (and is set to the
 * feed's interval). Runs through the same per-pull timeout runAllFeeds uses
 * (feedRunTimeoutMs, incl. FEED_RUN_TIMEOUT_OVERRIDES_MS), unclipped, so
 * feed_pull_history / breaker / reaper semantics are unchanged and a hung
 * pull is finalized and penalized at its timeout instead of waiting for the
 * invocation to die and Navigator's reaper. Never throws.
 */
export async function dispatchDedicatedIngestFeed(
  env: Env,
  name: string,
  mod: FeedModule,
): Promise<void> {
  try {
    const loaded = await loadDispatchableFeed(env, name, "dispatchDedicatedIngestFeed");
    if (!loaded) return;
    await runFeedWithTimeout(env, loaded.config, mod, feedRunTimeoutMs(name), null, loaded.feeds);
  } catch (err) {
    console.error(`[dispatchDedicatedIngestFeed] ${name} failed:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The shared gate for cron-dispatched feeds: the feed_configs row when the
 * feed exists, is enabled, and is not in circuit-breaker backoff; else null.
 * Resolves the feeds family once: the gate reads and the pull it gates use
 * the same DB.
 */
async function loadDispatchableFeed(env: Env, name: string, tag: string): Promise<{ config: FeedConfigRow; feeds: TelemetryHandle } | null> {
  const feeds = await resolveFamily(env, "feeds");
  const config = await feeds.db.prepare(
    `SELECT feed_name, display_name, source_url, schedule_cron, rate_limit,
            batch_size, retry_count, enabled, consecutive_failure_threshold
       FROM feed_configs WHERE feed_name = ?`,
  ).bind(name).first<FeedConfigRow>();
  if (!config) {
    console.warn(`[${tag}] ${name}: no feed_configs row — skipping`);
    return null;
  }
  if (config.enabled === 0) {
    console.log(`[${tag}] ${name}: disabled — skipping`);
    return null;
  }

  // Respect the circuit breaker: if a prior failure stamped a future
  // next_retry_at, stay backed off until the window opens.
  const status = await feeds.db.prepare(
    "SELECT next_retry_at FROM feed_status WHERE feed_name = ?",
  ).bind(name).first<{ next_retry_at: string | null }>();
  if (status?.next_retry_at) {
    const r = status.next_retry_at;
    const retryMs = new Date(r.includes("Z") || r.includes("+") ? r : r + "Z").getTime();
    if (Date.now() < retryMs) {
      console.log(`[${tag}] ${name}: in backoff until ${r} — skipping`);
      return null;
    }
  }
  return { config, feeds };
}

// ─── Bounded concurrency ─────────────────────────────────────────

/**
 * Max feeds run concurrently in runAllFeeds. Bounds the number of feeds
 * issuing bulk db.batch() writes at the single D1 instance at once so a
 * busy tick can't overload it (the "object reset" / "connection lost"
 * errors). 4 keeps throughput high while staying well clear of contention.
 */
const FEED_CONCURRENCY = 4;

// ─── Per-feed wall-clock timeout ─────────────────────────────────
//
// runAllFeeds awaits every pull, so before these existed one pull that
// never settled (2026-11-09: nrd_hagezi + cloudflare_scanner on every tick
// they ran, urlhaus + surbl at 21:07) held a pool slot — and with it the
// whole ingest, Sentinel, and the rest of the hourly tick — until the
// invocation died and Navigator reaped the row 15+ min later.
//
// Sized from prod feed_pull_history, successful pulls, 14 days to
// 2026-11-09: every runAllFeeds feed but six has p95 ≤ 94s and max ≤ 95s
// (urlhaus max 82s, nrd_hagezi max 66s, dshield / malwarebazaar 95s), so
// 120s is ~25% above the worst normal pull. The six slower feeds get an
// override above their 14-day max.

/** Default wall-clock cap for one feed pull inside runAllFeeds. */
export const FEED_RUN_TIMEOUT_MS = 120_000;

/**
 * Feeds whose normal successful pulls exceed FEED_RUN_TIMEOUT_MS
 * (14-day p95 / max in the comments).
 */
export const FEED_RUN_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = {
  // p95 503s / max 540s; the module's own loop budget is 9 min
  // (INGEST_BUDGET_MS, feeds/taxii.ts), so 10 min leaves it time to
  // commit its last page. Its 12-min internal Promise.race stays as-is.
  taxii_otx: 600_000,
  sslbl: 480_000,             // p95 / max 443s (p50 162s)
  typosquat_scanner: 270_000, // p95 172s / max 235s
  c2_intel_feeds: 240_000,    // p95 / max 187s
  ct_logs: 180_000,           // p95 31s / max 162s
  otx_alienvault: 180_000,    // p95 52s / max 160s
  // Applied by dispatchDedicatedIngestFeed (own `29 */2 * * *` cron, not
  // the runAllFeeds pool). 14-day max 66s, but the module now bounds new-domain processing to
  // NRD_PROCESS_BUDGET_MS (45s) and must then finish the snapshot scan + R2
  // puts (NRD_TAIL_ALLOWANCE_MS, 120s). A deferring run is progress and must
  // not be timed out and penalized. ≥ budget + tail is pinned by
  // test/nrd-hagezi-budget.test.ts (no import here: feeds/nrd_hagezi
  // imports this module). Its own cron invocation does nothing else and has a
  // 15-min wall limit, so the cap is generous (420s) — a slow-D1 day whose
  // tail runs past budget + tail must still reach the snapshot put; real
  // hangs are caught by the readers' idle timeouts.
  nrd_hagezi: 420_000,

  // Enrichment feeds (runAllEnrichmentFeeds, sequential). Same 14-day
  // data; spamhaus_dbl (max 68s), abuseipdb (max 25s) and circl_pdns
  // (~0s) stay on the default.
  surbl: 300_000,                // p95 218s / max 262s
  virustotal: 270_000,           // p95 153s / max 161s; module's own PULL_BUDGET_MS is 4 min
  google_safe_browsing: 150_000, // p95 90s / max 120s
};

/**
 * Hard wall-clock budget for the whole runAllFeeds pool, measured from
 * the moment dispatch starts. A feed's timeout is clipped to what is
 * left of it, and a feed is not started with less than
 * FEED_POOL_MIN_START_MS left (it stays due and runs next tick). The
 * hourly orchestrator invocation has a 15-min wall budget and reaches
 * dispatch ~1-2.5 min in (prod 2026-11-09 first pull starts :08-:09 for
 * the :07 tick), so the pool always returns by ~12.5 min, and the rest
 * of the tick (Sentinel, enrichment) always gets a chance to run instead
 * of none. 10 min is the largest override (taxii_otx), so the longest
 * feed still gets its full budget when it starts first — which
 * longest-first dispatch ordering below ensures (and
 * FEED_TIMEOUT_CLIP_TOLERANCE_MS keeps the milliseconds between computing
 * the pool deadline and starting that first feed from counting as a clip).
 */
export const FEED_POOL_BUDGET_MS = 10 * 60_000;

/** A feed is not started with less than this left of its loop's budget. */
export const FEED_POOL_MIN_START_MS = 30_000;

/**
 * A feed whose own timeout exceeds the time left in its loop by at most
 * this much still counts as getting its full allowance (not clipped): its
 * timeout is the time left, and a timeout is penalized like any other.
 * Without it, taxii_otx (600s override = FEED_POOL_BUDGET_MS) would be
 * "clipped" by the few ms the real clock advances between the pool
 * deadline being computed and its pull starting, and never be penalized.
 */
export const FEED_TIMEOUT_CLIP_TOLERANCE_MS = 5_000;

/**
 * Own wall-clock budget of the sequential runAllEnrichmentFeeds loop,
 * from its start. Typical sum of the loop's feeds is ~3 min (14-day
 * averages: surbl 60s, virustotal 66s, gsb 37s, spamhaus_dbl 19s,
 * abuseipdb 6s); 6 min absorbs a slow tick, and a feed that no longer
 * fits stays due for the next tick instead of overrunning it.
 */
export const ENRICHMENT_LOOP_BUDGET_MS = 6 * 60_000;

/**
 * Hard cap for the enrichment loop measured from the hourly tick's
 * `event.scheduledTime` (enrichmentDeadlineForTick). The `:07`
 * invocation has a 15-min wall budget; the 10-min feed pool runs first
 * and, starting ~1-2.5 min in, can end as late as ~12.5 min. Capping
 * enrichment at 12 min from the tick means a slow ingest squeezes
 * enrichment (deferred to the next tick) rather than the rest of the
 * tick: social feeds, the enrichment pipeline and agent dispatch always
 * get a chance to run in the last ~3 min. On a normal tick (pool done in a
 * few minutes) ENRICHMENT_LOOP_BUDGET_MS is the binding limit.
 *
 * runAllSocialFeeds (sequential, right after enrichment) is capped at the
 * same tick deadline, so after a slow ingest or enrichment the social
 * feeds are deferred too and the tail of the tick (enrichment pipeline,
 * brand match, Sentinel and agent dispatch) keeps those ~3 min.
 */
export const ENRICHMENT_TICK_DEADLINE_MS = 12 * 60_000;

/**
 * Own wall-clock budget of the sequential runAllSocialFeeds loop, from its
 * start. 14-day max pulls: github 69s, mastodon 44s, telegram 9s (~2 min
 * if all three are due on one tick), so 3 min absorbs a slow tick; every
 * pull is also on the 120s default cap. The orchestrator additionally
 * caps the loop at the tick deadline (enrichmentDeadlineForTick).
 */
export const SOCIAL_LOOP_BUDGET_MS = 3 * 60_000;

/** The cron invocation wall-clock limit the tick deadline is sized against. */
const CRON_INVOCATION_WALL_MS = 15 * 60_000;

/**
 * Absolute deadline (epoch ms) for runAllEnrichmentFeeds inside the
 * hourly tick: scheduledTime + ENRICHMENT_TICK_DEADLINE_MS. A
 * scheduledTime that cannot belong to a live invocation (in the future,
 * or older than the 15-min wall limit — replays, tests) anchors to now.
 */
export function enrichmentDeadlineForTick(scheduledTimeMs: number, nowMs: number = Date.now()): number {
  const age = nowMs - scheduledTimeMs;
  const anchor = age >= 0 && age <= CRON_INVOCATION_WALL_MS ? scheduledTimeMs : nowMs;
  return anchor + ENRICHMENT_TICK_DEADLINE_MS;
}

/** Effective per-feed timeout before pool-budget clipping. */
export function feedRunTimeoutMs(feedName: string): number {
  return FEED_RUN_TIMEOUT_OVERRIDES_MS[feedName] ?? FEED_RUN_TIMEOUT_MS;
}

/**
 * Set when a feed's timeout was clipped to a loop deadline (the feed pool
 * or the enrichment loop) rather than being its own full timeout.
 */
interface DeadlineClip {
  /** Which loop's deadline, for the error text ("feed-pool", "enrichment"). */
  label: string;
  /** That loop's whole budget, for the error text. */
  budgetMs: number;
}

/**
 * The timeout to start `feedName` with when its loop must be done by
 * `deadline` (epoch ms): the feed's own timeout, clipped to the time
 * left. null = less than FEED_POOL_MIN_START_MS left, don't start it.
 */
export function plannedFeedTimeout(
  feedName: string,
  deadline: number,
  now: number = Date.now(),
): { timeoutMs: number; clipped: boolean } | null {
  const remaining = deadline - now;
  if (remaining < FEED_POOL_MIN_START_MS) return null;
  const own = feedRunTimeoutMs(feedName);
  if (own <= remaining) return { timeoutMs: own, clipped: false };
  // Within the tolerance of its own timeout: a full allowance, not a clip.
  return { timeoutMs: remaining, clipped: own - remaining > FEED_TIMEOUT_CLIP_TOLERANCE_MS };
}

/** Every timeout error (clipped or not) ends with this; matched by previousPullTimedOutAsHang. */
const TIMEOUT_ERROR_SUFFIX = "— pull abandoned";

/**
 * The smallest timeout allowance that counts as evidence of a hang:
 * min(the feed's own timeout, FEED_RUN_TIMEOUT_MS). 120s is above every
 * default-cap feed's 14-day max pull (≤ 95s) and is the cap a feed on the
 * default always gets, so a pull that did not settle in that long is
 * hanging rather than merely slow — except for the override feeds, whose
 * normal pulls can run past 120s, but for those a clipped timeout only
 * penalizes on a repeat (see runFeedWithTimeout). A shorter clipped
 * allowance (e.g. surbl squeezed to 60s by the tick deadline after a slow
 * ingest) is just a squeeze and never counts, however often it repeats.
 */
export function hangEvidenceMinMs(feedName: string): number {
  return Math.min(feedRunTimeoutMs(feedName), FEED_RUN_TIMEOUT_MS);
}

/** Allowance (ms) of a timeout error ("timed out after Ns …"), or null. */
function timeoutAllowanceMs(errorMessage: string | null): number | null {
  if (!errorMessage || !errorMessage.endsWith(TIMEOUT_ERROR_SUFFIX)) return null;
  const m = /^timed out after (\d+)s\b/.exec(errorMessage);
  return m ? Number(m[1]) * 1000 : null;
}

/**
 * True when the feed's most recent pull before `pullId` was itself
 * abandoned at a timeout whose allowance was hang evidence
 * (≥ hangEvidenceMinMs) — clipped or not. The allowance is read back from
 * the "timed out after Ns" error text the timeout path writes (whole
 * seconds, so it needs no new column). One indexed row read
 * (idx_feed_pulls_feed) per DB; only called after a qualifying clipped
 * timeout. A union read (lib/telemetry-read.ts): right after a feeds flip
 * the previous pull is on the other DB.
 */
async function previousPullTimedOutAsHang(env: Env, feedName: string, pullId: string): Promise<boolean> {
  const parts = await historyParts(env, "feed_pull_history");
  // One part (feeds never on telemetry): exactly the pre-cut-over statement.
  // Union: id + started_at are added for the dedupe and the merge order.
  const prev = await unionFirst<{ id?: string; started_at?: string; status: string; error_message: string | null }>(parts, () => ({
    sql: parts.length === 1
      ? `SELECT status, error_message FROM feed_pull_history
      WHERE feed_name = ? AND id <> ?
      ORDER BY started_at DESC LIMIT 1`
      : `SELECT status, error_message, id, started_at FROM feed_pull_history
      WHERE feed_name = ? AND id <> ?/*split*/
      ORDER BY started_at DESC LIMIT 1`,
    binds: [feedName, pullId],
  }), { key: (r) => String(r.id), sort: byDesc("started_at") });
  if (prev?.status !== "failed") return false;
  const allowance = timeoutAllowanceMs(prev.error_message);
  return allowance !== null && allowance >= hangEvidenceMinMs(feedName);
}

/** Marker so the feed loops can count timeouts separately from failures. */
export class FeedTimeoutError extends Error {
  constructor(
    message: string,
    readonly feedName: string,
    readonly timeoutMs: number,
    /** true when a loop deadline, not the feed's own timeout, cut it. */
    readonly deadlineClipped: boolean,
  ) {
    super(message);
    this.name = "FeedTimeoutError";
  }
}

/**
 * Run one feed with a wall-clock cap. On timeout the slot is released
 * (this promise rejects with FeedTimeoutError) and the pull is abandoned:
 *
 *   - its feed_pull_history row is finalized `failed` with the timeout
 *     error, by an upsert guarded on the row still being `partial`, so it
 *     never overwrites a row runFeed (or the reaper) already finalized,
 *     and — if runFeed's own INSERT has not landed yet — claims the id so
 *     that late INSERT fails and the pull never starts;
 *   - the breaker gets the same penalty a thrown failure gets
 *     (penalizeFeedFailure), only when this upsert is what finalized the
 *     row, and when either the feed got its full allowance (its own
 *     timeout fired, `clippedBy` null) or the cut was clipped by a loop
 *     deadline with an allowance that is hang evidence (≥
 *     hangEvidenceMinMs: 120s, or the feed's own timeout if smaller) AND
 *     the feed's previous pull also timed out with such an allowance. A
 *     single clipped cut is our scheduling, not the feed's fault: no
 *     penalty. A short squeeze (surbl clipped to 60s after a slow ingest)
 *     never penalizes, however often it repeats — that feed is slow-ticked,
 *     not hung. A clipped pull's allowance is by construction short of the
 *     feed's own timeout, so it can never show that the pull hung for its
 *     full allowance; two meaningful timeouts in a row are the evidence
 *     used instead, so an override feed (own timeout > 125s) that is
 *     clipped on every tick and hangs every time still backs off and
 *     reaches auto-pause instead of death-looping silently. A default-cap
 *     feed's clipped allowance is always below the 120s floor (it is only
 *     clipped when > FEED_TIMEOUT_CLIP_TOLERANCE_MS short of its own 120s),
 *     so only its unclipped timeouts penalize.
 *
 * The abandoned runFeed keeps running in the background (feed modules
 * take no AbortSignal). Its late outcome is harmless: runFeed's success
 * and failure finalizes are guarded and skip feed_status when the row is
 * already failed, and the late rejection is consumed here, so it is
 * never an unhandled rejection.
 */
async function runFeedWithTimeout(
  env: Env,
  config: FeedConfigRow,
  mod: FeedModule,
  timeoutMs: number,
  clippedBy: DeadlineClip | null,
  feedsIn?: TelemetryHandle,
): Promise<FeedResult> {
  const pullId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const start = Date.now();
  // Resolved once for this pull: runFeed's INSERT and this timeout finalize
  // (+ its penalty) must land on the same DB whatever the flag does meanwhile.
  const feeds = feedsIn ?? await resolveFamily(env, "feeds");
  const feedsDb = feeds.db;

  const pull = runFeed(env, config, mod, { pullId, feeds });
  // Consume a late settlement of an abandoned pull. Promise.race below
  // also subscribes, but only this handler survives the race settling.
  let abandoned = false;
  pull.then(
    () => {
      if (abandoned) console.warn(`[runAllFeeds] ${config.feed_name}: abandoned pull ${pullId} completed late`);
    },
    (err: unknown) => {
      if (abandoned) {
        console.warn(`[runAllFeeds] ${config.feed_name}: abandoned pull ${pullId} rejected late — ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const winner = await Promise.race([pull, timedOut]);
    if (winner !== "timeout") return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  abandoned = true;
  const seconds = Math.round(timeoutMs / 1000);
  const errorMsg = clippedBy
    ? `timed out after ${seconds}s at the ${clippedBy.label} deadline (${Math.round(clippedBy.budgetMs / 1000)}s budget) ${TIMEOUT_ERROR_SUFFIX}`
    : `timed out after ${seconds}s ${TIMEOUT_ERROR_SUFFIX}`;
  console.error(`[runAllFeeds] ${config.feed_name}: ${errorMsg}`);

  try {
    // Retried past D1's overload window, capped at
    // FEED_FINALIZE_RETRY_BUDGET_MS (the penalty below gets its own
    // FEED_PENALTY_RETRY_FLOOR_MS), so this slot is held at most ~45 s past
    // its timeout (see the constant for the loop-budget arithmetic).
    // Re-send safety: an earlier attempt that applied but reported an error
    // left the row 'failed' with this exact error + duration, which the
    // second WHERE arm matches, so the penalty still runs once.
    const finalizeRetry = feedFinalizeRetry(
      `${config.feed_name} pull-timeout finalize`,
      Date.now() + FEED_FINALIZE_RETRY_BUDGET_MS,
    );
    const durationMs = Date.now() - start;
    const finalize = await withD1Retry(
      () =>
        feedsDb.prepare(
          `INSERT INTO feed_pull_history
             (id, feed_name, started_at, completed_at, duration_ms, status, error_message)
           VALUES (?, ?, ?, datetime('now'), ?, 'failed', ?)
           ON CONFLICT(id) DO UPDATE SET
             status = 'failed',
             error_message = excluded.error_message,
             duration_ms = excluded.duration_ms,
             completed_at = excluded.completed_at
           WHERE (feed_pull_history.status = 'partial'
                  AND feed_pull_history.completed_at IS NULL)
              OR (feed_pull_history.status = 'failed'
                  AND feed_pull_history.error_message = excluded.error_message
                  AND feed_pull_history.duration_ms = excluded.duration_ms)`,
        ).bind(pullId, config.feed_name, startedAt, durationMs, errorMsg).run(),
      finalizeRetry,
    );

    if (finalizeApplied(finalize)) {
      if (!clippedBy) {
        await penalizeFeedFailure(env, feedsDb, config, errorMsg, finalizeRetry);
      } else if (
        timeoutMs >= hangEvidenceMinMs(config.feed_name)
        && await previousPullTimedOutAsHang(env, config.feed_name, pullId)
      ) {
        await penalizeFeedFailure(env, feedsDb, config, `${errorMsg}; previous pull also timed out`, finalizeRetry);
      }
    }
  } catch (e) {
    // Best-effort: if this write still fails once the retry budget is spent
    // the row stays partial and the Navigator reaper finalizes + penalizes
    // it within ~15 min.
    console.error(`[runAllFeeds] ${config.feed_name}: timeout finalize failed:`, e);
  }

  throw new FeedTimeoutError(
    `Feed ${config.feed_name} ${errorMsg}`,
    config.feed_name,
    timeoutMs,
    clippedBy !== null,
  );
}

/**
 * Run `worker` over `items` with at most `limit` in flight at a time,
 * returning results in input order with the same shape as
 * Promise.allSettled (so callers branch on .status / .value / .reason).
 * A rejected worker never aborts the others.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        results[idx] = { status: "fulfilled", value: await worker(items[idx]!) };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  };
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => runner()));
  return results;
}

// ─── Auto-pause threshold ────────────────────────────────────────

/** Default number of consecutive failures before a feed is auto-paused. */
const DEFAULT_FAILURE_THRESHOLD = 5;

/**
 * Cache for the global default threshold within a single worker
 * invocation so concurrent feed runs inside runAllFeeds don't all
 * re-query system_config. Reset by runAllFeeds at the start of
 * each coordinator pass.
 */
let cachedGlobalThreshold: number | null = null;

export function resetGlobalThresholdCache(): void {
  cachedGlobalThreshold = null;
}

async function getGlobalFailureThreshold(db: D1Database): Promise<number> {
  if (cachedGlobalThreshold != null) return cachedGlobalThreshold;
  try {
    const row = await db.prepare(
      "SELECT value FROM system_config WHERE key = 'feed_consecutive_failure_threshold'"
    ).first<{ value: string }>();
    const parsed = row?.value != null ? parseInt(row.value, 10) : NaN;
    cachedGlobalThreshold = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FAILURE_THRESHOLD;
  } catch {
    cachedGlobalThreshold = DEFAULT_FAILURE_THRESHOLD;
  }
  return cachedGlobalThreshold;
}

/** Public for tests — given a config + global default, resolve the effective threshold. */
export function resolveFailureThreshold(
  config: Pick<FeedConfigRow, "consecutive_failure_threshold">,
  globalDefault: number,
): number {
  const override = config.consecutive_failure_threshold;
  if (override != null && override > 0) return override;
  return globalDefault;
}

// ─── Feed Execution ──────────────────────────────────────────────

/**
 * True when a finalize UPDATE changed the row. A D1 result always carries
 * `meta.changes`; when it is absent (hand-rolled test doubles) we assume
 * the write applied, which is the pre-guard behaviour.
 */
function finalizeApplied(res: { meta?: { changes?: number } } | null | undefined): boolean {
  return (res?.meta?.changes ?? 1) > 0;
}

export interface RunFeedOptions {
  /**
   * Pre-assigned feed_pull_history id. runAllFeeds passes one so its
   * per-feed timeout can finalize the row of a pull it abandons.
   */
  pullId?: string;
  /**
   * Back the finalize writes off past D1's 10 s overload window
   * (feedFinalizeRetry). Default true — every scheduled caller. The manual
   * HTTP trigger (handleTriggerFeed) passes false: it is awaited inside a
   * request, so it keeps the short default backoff (same split as
   * executeAgent's `api`/`manual` vs `scheduled` triggers, CLAUDE.md §6).
   */
  overloadBackoff?: boolean;
  /**
   * The feeds-family route this pull was resolved under (Track B1d). Callers
   * that write the pull row themselves (runFeedWithTimeout's timeout
   * finalize) or gated it on that DB (the dedicated-cron dispatchers) pass
   * theirs; otherwise runFeed resolves it once at start. Only the ROUTE is
   * used: the DB is taken from runFeed's own (D1-metered) env.
   */
  feeds?: { route: TelemetryRoute };
}

/**
 * Wall-clock cap (ms) on the D1 retries of ONE pull's finalize sequence
 * (the pull-history UPDATE / timeout upsert plus the breaker penalty).
 *
 * D1 rejects every statement for the rest of a rolling 10 s window once its
 * budget is spent ("D1 DB is overloaded"). Before 2026-11-22 the success
 * finalize retried at 50/100/200 ms — inside that window — and the failure
 * finalize and the timeout upsert did not retry at all, so under overload
 * the row stayed `partial` and Navigator's reaper later wrote it off as
 * "worker terminated" (295 such rows since 2026-11-09: the wrong
 * diagnosis, and the breaker penalty came ~15 min late).
 *
 * With D1_OVERLOAD_RETRY_BASE_MS one statement waits up to 3 + 6 + 12 s
 * (+ ≤ 2.25 s jitter); this cap bounds the pull-history write. The breaker
 * penalty after it gets its own floor (FEED_PENALTY_RETRY_FLOOR_MS), so the
 * whole finalize sequence holds a slot at most ~45 s (30 + 15, plus the
 * last attempts' own execution time) past its timeout. Budget check: the
 * feed pool returns ≤ FEED_POOL_BUDGET_MS + ~45 s after it starts, and the
 * enrichment and social loops size themselves from the time actually left
 * (their own start, capped by enrichmentDeadlineForTick), so a late pool
 * only shrinks them; worst case the last enrichment/social slot ends ≤ ~45 s
 * past scheduledTime + ENRICHMENT_TICK_DEADLINE_MS (12 min) ≈ 12m45s, inside
 * the 15-min invocation wall. Every retry loop is finite and
 * deadline-checked, so every loop still always returns.
 */
export const FEED_FINALIZE_RETRY_BUDGET_MS = 30_000;

/**
 * Minimum retry window (ms) of the breaker writes that follow a finalize:
 * the failure penalty (penalizeFeedFailure) and the success-side breaker
 * reset. Covers 3 s + 6 s overload backoffs — past one 10 s window — even
 * when the finalize before it used up FEED_FINALIZE_RETRY_BUDGET_MS.
 */
export const FEED_PENALTY_RETRY_FLOOR_MS = 15_000;

/**
 * withD1Retry options for a pull's finalize writes. Only idempotent
 * statements go through it (guarded UPDATEs keyed on the pull id, the
 * guarded upsert, INSERT OR IGNORE, and an absolute-value feed_status SET).
 */
export function feedFinalizeRetry(
  label: string,
  deadline: number,
  overloadBackoff = true,
): D1RetryOptions {
  return overloadBackoff
    ? { label, deadline, overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS }
    : { label, deadline };
}

/**
 * One feed pull, D1-metered as `feed:<feed_name>` (lib/d1-meter.ts). The
 * meter layers are exclusive, so the pull's reads/writes leave the
 * enclosing `cron:` / `agent:` row and land in their own; an abandoned
 * (timed-out) pull is recorded when it finally settles. Metering is a
 * no-op without the AE binding.
 */
export function runFeed(
  env: Env,
  config: FeedConfigRow,
  feedModule: FeedModule,
  opts: RunFeedOptions = {},
): Promise<FeedResult> {
  return withD1Meter(env, `feed:${config.feed_name}`, (meteredEnv) =>
    runFeedUnmetered(meteredEnv, config, feedModule, opts));
}

async function runFeedUnmetered(
  env: Env,
  config: FeedConfigRow,
  feedModule: FeedModule,
  opts: RunFeedOptions,
): Promise<FeedResult> {
  const pullId = opts.pullId ?? crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const overloadBackoff = opts.overloadBackoff ?? true;
  // The feeds family, resolved ONCE for this pull (or handed in by the
  // caller that resolved it). Every write below — and the feed module's own
  // feed-table writes via ctx.feedsDb — goes to this DB.
  const route = opts.feeds?.route ?? (await resolveFamily(env, "feeds")).route;
  const feedsDb = telemetryDbFor(env, route);

  // Create pull history entry
  await feedsDb.prepare(
    `INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES (?, ?, ?, 'partial')`
  ).bind(pullId, config.feed_name, startedAt).run();

  const ctx: FeedContext = {
    env,
    feedName: config.feed_name,
    feedUrl: config.source_url ?? "",
    feedsDb,
  };

  const start = Date.now();

  let result: FeedResult;
  try {
    result = await feedModule.ingest(ctx);
  } catch (err) {
    // Only an ingest failure takes the failure path. A D1 error AFTER a
    // successful ingest (the finalize writes below) must never be recorded
    // as a failed pull or penalize the breaker.
    return failPull(env, feedsDb, config, pullId, err, Date.now() - start, overloadBackoff);
  }

  const durationMs = Date.now() - start;
  // Log success in pull history. Retry on transient D1 errors: the pull
  // already succeeded, so a blip here must not leave the row 'partial'
  // (which the orphan reaper would later flip to failed + now also
  // penalize the breaker). Idempotent UPDATE keyed on pullId. Overload
  // errors back off past D1's 10 s window (feedFinalizeRetry).
  let pullUpdate: D1Result;
  try {
    pullUpdate = await withD1Retry(
      () =>
        feedsDb.prepare(
          `UPDATE feed_pull_history SET
             status = 'success', records_ingested = ?, records_rejected = ?,
             error_message = ?, duration_ms = ?, completed_at = datetime('now')
           WHERE id = ? AND status <> 'failed'`,
        ).bind(
          result.itemsNew,
          result.itemsDuplicate + result.itemsError,
          // Partial-pull note (FeedResult.warning); NULL for a clean pull —
          // the row was inserted with error_message NULL, so other feeds
          // are unchanged. Every error_message reader filters status='failed'.
          result.warning ? result.warning.slice(0, 1000) : null,
          durationMs,
          pullId,
        ).run(),
      feedFinalizeRetry(
        `${config.feed_name} pull-success finalize`,
        Date.now() + FEED_FINALIZE_RETRY_BUDGET_MS,
        overloadBackoff,
      ),
    );
  } catch (err) {
    // The ingest succeeded; only its bookkeeping failed. Not a failed pull
    // (no penalty): the row stays 'partial' and the Navigator reaper
    // finalizes it. Rejects so callers do not count it as a clean run.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runFeed] ${config.feed_name}: pull ${pullId} ingested but its success finalize failed — ${msg}`);
    throw new Error(`Feed ${config.feed_name}: success finalize failed: ${msg}`);
  }

  // `status <> 'failed'` (not `= 'partial'`, so a withD1Retry re-send of
  // an already-applied UPDATE still matches): a row already finalized as
  // failed — abandoned by runAllFeeds' per-feed timeout, or reaped by
  // Navigator — keeps that outcome. Its breaker penalty has already been
  // applied, so a late success must not reset feed_status either.
  if (!finalizeApplied(pullUpdate)) {
    console.warn(`[runFeed] ${config.feed_name}: pull ${pullId} completed after it was finalized as failed (timed out or reaped) — keeping the failed row`);
    return result;
  }

  // Close the breaker. Retried on OVERLOAD only (shouldRetry:
  // isD1OverloadError): an overload rejection never ran the statement, so
  // re-sending the non-idempotent `records_ingested_today + ?` is safe; an
  // ambiguous error (ran, then reported a failure) is not retried. If these
  // still fail, the pull stays a success — log, don't throw: a post-finalize
  // error must not masquerade as a failed pull.
  const resetRetry: D1RetryOptions = {
    ...feedFinalizeRetry(`${config.feed_name} breaker reset`, Date.now() + FEED_PENALTY_RETRY_FLOOR_MS, overloadBackoff),
    shouldRetry: (e: unknown) => isD1OverloadError(e instanceof Error ? e.message : String(e)),
  };
  try {
    // Ensure feed_status row exists (INSERT OR IGNORE), then update
    await withD1Retry(
      () =>
        feedsDb.prepare(
          "INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES (?, 'healthy')"
        ).bind(config.feed_name).run(),
      resetRetry,
    );

    // Update feed_status: only set healthy if records were ingested, clear error.
    // consecutive_failures resets unconditionally on HTTP/parse success — feeds
    // like cisa_kev legitimately return zero most pulls, so we do NOT gate the
    // reset on itemsFetched > 0.
    //
    // next_retry_at also cleared on success: the circuit breaker closes
    // immediately when the upstream is healthy again. This is the
    // half-open → closed transition. (Open → half-open is implicit —
    // when the retry window passes, the feed pulls again.)
    await withD1Retry(
      () =>
        feedsDb.prepare(
          `UPDATE feed_status SET
             last_successful_pull = datetime('now'),
             records_ingested_today = records_ingested_today + ?,
             health_status = CASE WHEN ? > 0 THEN 'healthy' ELSE health_status END,
             last_error = NULL,
             consecutive_failures = 0,
             next_retry_at = NULL
           WHERE feed_name = ?`
        ).bind(result.itemsNew, result.itemsFetched, config.feed_name).run(),
      resetRetry,
    );
  } catch (err) {
    console.error(`[runFeed] ${config.feed_name}: pull ${pullId} succeeded but the breaker reset failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * runFeed's failure path for an ingest that threw: finalize the row
 * `failed`, penalize the breaker, and ALWAYS reject with the feed error
 * (`Feed <name> failed: <ingest error>`), never a raw D1 error — callers
 * (handleTriggerFeed, the feed loops) read that message.
 */
async function failPull(
  env: Env,
  feedsDb: D1Database,
  config: FeedConfigRow,
  pullId: string,
  err: unknown,
  durationMs: number,
  overloadBackoff: boolean,
): Promise<never> {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error(`[runFeed] ${config.feed_name}: FAILED after ${durationMs}ms — ${errorMsg}`);
  if (err instanceof Error && err.stack) console.error(`[runFeed] ${config.feed_name}: stack:`, err.stack);

  // Log failure in pull history. Guarded on 'partial': if runAllFeeds'
  // per-feed timeout (or the Navigator reaper) already finalized this
  // row, a late rejection must not overwrite its error or penalize the
  // breaker a second time.
  //
  // Retried past D1's overload window (feedFinalizeRetry): before this the
  // failure finalize had no retry at all, so a pull that failed during an
  // overload stayed 'partial' and was reaped as "worker terminated".
  // The second arm makes a re-send safe: if an earlier attempt applied but
  // reported an error (e.g. "Network connection lost"), the row is already
  // 'failed' with THIS error + duration, the re-send matches it again
  // (changes = 1) and the penalty below still runs exactly once. A row
  // finalized by the timeout path or the reaper carries a different
  // error_message, so it never matches.
  const failRetry = feedFinalizeRetry(
    `${config.feed_name} pull-failure finalize`,
    Date.now() + FEED_FINALIZE_RETRY_BUDGET_MS,
    overloadBackoff,
  );
  try {
    const failUpdate = await withD1Retry(
      () =>
        feedsDb.prepare(
          `UPDATE feed_pull_history SET
             status = 'failed', error_message = ?1, duration_ms = ?2, completed_at = datetime('now')
           WHERE id = ?3
             AND (status = 'partial'
                  OR (status = 'failed' AND error_message = ?1 AND duration_ms = ?2))`
        ).bind(errorMsg, durationMs, pullId).run(),
      failRetry,
    );

    if (finalizeApplied(failUpdate)) {
      await penalizeFeedFailure(env, feedsDb, config, errorMsg, failRetry);
    } else {
      console.warn(`[runFeed] ${config.feed_name}: pull ${pullId} failed after it was already finalized (timed out or reaped) — not penalizing again`);
    }
  } catch (e) {
    // Finalize still failing once its budget is spent: the row stays
    // 'partial' and the Navigator reaper finalizes + penalizes it. A
    // penalty failure after an applied finalize leaves the breaker one step
    // behind (logged). Either way the caller still gets the feed error.
    console.error(`[runFeed] ${config.feed_name}: failure bookkeeping for pull ${pullId} failed — ${e instanceof Error ? e.message : String(e)}`);
  }

  // Re-throw so callers (handleTriggerFeed) can distinguish success from failure.
  // runAllFeeds uses Promise.allSettled, so this won't break the coordinator.
  const feedError = new Error(`Feed ${config.feed_name} failed: ${errorMsg}`);
  (feedError as Error & { feedResult: FeedResult }).feedResult = { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
  throw feedError;
}

/**
 * The circuit-breaker penalty for a failed pull: increment
 * consecutive_failures, stamp an exponential-backoff next_retry_at
 * (computeFeedRetryAt), mark degraded, notify on the healthy → degraded
 * transition, and auto-pause at the threshold. Shared by runFeed's catch
 * and runAllFeeds' per-feed timeout so a hung pull backs off exactly like
 * a thrown one. Moved verbatim out of runFeed's catch. `feedsDb` is the
 * pull's carried feeds store (the DB its row was finalized on).
 */
async function penalizeFeedFailure(
  env: Env,
  feedsDb: D1Database,
  config: FeedConfigRow,
  errorMsg: string,
  retryIn: D1RetryOptions = {},
): Promise<void> {
  // The penalty gets its OWN deadline floor: if the finalize before it
  // spent most of the shared FEED_FINALIZE_RETRY_BUDGET_MS, inheriting that
  // deadline would let the penalty fail and leave a `failed` row the reaper
  // never touches with the breaker un-advanced.
  const retry: D1RetryOptions = retryIn.deadline === undefined
    ? retryIn
    : { ...retryIn, deadline: Math.max(retryIn.deadline, Date.now() + FEED_PENALTY_RETRY_FLOOR_MS) };
  // `retry` (feedFinalizeRetry from the caller) carries the overload
  // backoff + the finalize deadline. Every statement wrapped below is safe
  // to re-run: a read, an INSERT OR IGNORE, and an UPDATE that SETs
  // absolute values (the counter is incremented locally from the read, not
  // with `+ 1` in SQL). The notification and auto-pause stay unwrapped.
  //
  // Check previous status for transition notification + grab the current
  // counter so we can increment locally and avoid an extra round trip.
  let prevStatus = await withD1Retry(
    () =>
      feedsDb.prepare(
        `SELECT health_status, consecutive_failures FROM feed_status WHERE feed_name = ?`
      ).bind(config.feed_name).first<{ health_status: string; consecutive_failures: number | null }>(),
    retry,
  );

  // A feed that has never succeeded has no feed_status row (runFeed only
  // creates it on success), and the UPDATE below would match nothing: no
  // backoff, no counter, no auto-pause. Ensure the row, as applyReapPenalty
  // does. Only when the read found none, so the common path costs no write.
  // The row is born 'healthy', so this first failure IS a healthy →
  // degraded transition and notifies like any other.
  if (!prevStatus) {
    await withD1Retry(
      () =>
        feedsDb.prepare(
          "INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES (?, 'healthy')",
        ).bind(config.feed_name).run(),
      retry,
    );
    prevStatus = { health_status: 'healthy', consecutive_failures: 0 };
  }

  const newFailureCount = (prevStatus?.consecutive_failures ?? 0) + 1;

  // Update feed_status to degraded with error message + incremented counter.
  // Stamp next_retry_at so the next runAllFeeds tick skips this feed
  // until the backoff window expires. Exponential schedule with jitter
  // applied in computeFeedRetryAt() above.
  const nextRetryAt = computeFeedRetryAt(newFailureCount);
  await withD1Retry(
    () =>
      feedsDb.prepare(
        `UPDATE feed_status SET
           last_failure = datetime('now'),
           health_status = 'degraded',
           last_error = ?,
           consecutive_failures = ?,
           next_retry_at = ?
         WHERE feed_name = ?`
      ).bind(errorMsg.slice(0, 500), newFailureCount, nextRetryAt, config.feed_name).run(),
    retry,
  );

  // Notify only on status CHANGE (healthy → degraded)
  if (prevStatus?.health_status === 'healthy') {
    try {
      await createNotification(env, {
        // N1: explicit super_admin audience — only the platform operator
        // can act on feed health. Tenants don't run feeds.
        audience: 'super_admin',
        type: 'feed_health',
        severity: 'high',
        title: `Feed degraded: ${config.display_name}`,
        message: `${config.display_name} returned errors. Check Operations → Feeds.`,
        link: '/admin/operations?tab=feeds',
        metadata: { feed_name: config.feed_name },
      });
    } catch (e) {
      console.error(`[runFeed] notification error:`, e);
    }
  }

  // ── Auto-pause check ──────────────────────────────────────
  // Resolve the effective threshold (per-feed override or global default)
  // and flip enabled=0 + set paused_reason if we've crossed it. The
  // dispatch query in runAllFeeds just stops selecting this feed on the
  // next tick — no other plumbing needed.
  try {
    const globalThreshold = await getGlobalFailureThreshold(env.DB);
    const threshold = resolveFailureThreshold(config, globalThreshold);
    if (newFailureCount >= threshold) {
      await autoPauseFeed(env, feedsDb, config, newFailureCount, threshold, errorMsg);
    }
  } catch (e) {
    console.error(`[runFeed] auto-pause check failed for ${config.feed_name}:`, e);
  }
}

// ─── Auto-recovery helper ────────────────────────────────────────

/**
 * Auto-recover feeds that were paused by `autoPauseFeed` but whose
 * upstream may have since recovered. Fixes the gap where a feed
 * with a transient-5xx fix gets stuck in 'enabled = 0' because the
 * dispatch loop never runs it after pausing — so the failure
 * counter never resets.
 *
 * Selection criteria (all must hold):
 *   - feed_configs.enabled = 0
 *   - feed_configs.paused_reason = 'auto:consecutive_failures'
 *     (ONLY the auto path; manual / operator pauses are untouched)
 *   - feed_status.last_failure IS NULL OR < now - 4 hours
 *
 * Action per matched feed:
 *   - feed_configs: enabled = 1, paused_reason = NULL
 *   - feed_status:  consecutive_failures = 0,
 *                   health_status = 'healthy',
 *                   last_error = NULL
 *
 * No notification fires — operators don't need a "thing recovered"
 * popup; they get one already if the recovered feed promptly
 * re-pauses (autoPauseFeed's existing notification path). The log
 * line below gives forensic trail without notification noise.
 *
 * Returns the count of recovered feeds for the caller's diagnostics.
 */
async function autoRecoverStalePausedFeeds(feedsDb: D1Database): Promise<number> {
  const stale = await feedsDb.prepare(`
    SELECT fc.feed_name FROM feed_configs fc
    LEFT JOIN feed_status fs ON fs.feed_name = fc.feed_name
    WHERE fc.enabled = 0
      AND fc.paused_reason = 'auto:consecutive_failures'
      AND (fs.last_failure IS NULL
           OR fs.last_failure < datetime('now', '-4 hours'))
  `).all<{ feed_name: string }>();

  if (stale.results.length === 0) return 0;

  for (const row of stale.results) {
    try {
      await feedsDb.batch([
        feedsDb.prepare(
          `UPDATE feed_configs
             SET enabled = 1,
                 paused_reason = NULL,
                 updated_at = datetime('now')
           WHERE feed_name = ?
             AND paused_reason = 'auto:consecutive_failures'`
        ).bind(row.feed_name),
        feedsDb.prepare(
          `UPDATE feed_status
             SET consecutive_failures = 0,
                 health_status = 'healthy',
                 last_error = NULL
           WHERE feed_name = ?`
        ).bind(row.feed_name),
      ]);
      console.log(`[runAllFeeds] auto-recovered ${row.feed_name} (auto-paused, last failure > 4h ago)`);
    } catch (err) {
      console.error(`[runAllFeeds] auto-recovery failed for ${row.feed_name}:`, err);
    }
  }

  return stale.results.length;
}

// ─── Auto-pause helper ───────────────────────────────────────────

/**
 * Flip a feed to enabled=0 with paused_reason='auto:consecutive_failures',
 * fire a critical notification (exactly once per transition — guarded by
 * checking that the feed was still enabled BEFORE this update), and
 * write to agent_activity_log the same way flight_control does for other
 * state transitions.
 *
 * Guarded by a check-then-update sequence: if the feed is already
 * auto-paused (e.g. a concurrent run already flipped it), we skip the
 * notification so the "exactly one critical notification per transition"
 * invariant holds.
 */
async function autoPauseFeed(
  env: Env,
  feedsDb: D1Database,
  config: FeedConfigRow,
  failureCount: number,
  threshold: number,
  lastError: string,
): Promise<void> {
  // Read the current enabled state so we only fire the notification on
  // the enabled → paused transition. This also short-circuits if two
  // concurrent failing runs both hit the threshold in the same tick.
  const current = await feedsDb.prepare(
    "SELECT enabled, paused_reason FROM feed_configs WHERE feed_name = ?"
  ).bind(config.feed_name).first<{ enabled: number; paused_reason: string | null }>();

  if (!current || current.enabled === 0) {
    // Already paused (manually or by a concurrent auto-pause) — nothing to do.
    return;
  }

  // Auth failures (HTTP 401/403) are not transient — they need operator
  // action (rotate the API key). The 4-hour auto-recovery sweep below
  // matches only `paused_reason = 'auto:consecutive_failures'`, so
  // routing auth errors to a distinct reason `auto:auth_failure`
  // keeps them paused until manually resumed. Symptom this fixes:
  // OTX cycling through pause → recover → fail → pause every 4h
  // because last_failure aged out of the freshness window.
  const isAuthError = /\b(401|403)\b/.test(lastError);
  // Permanent upstream death (URL gone, repo archived) is not transient
  // either — same rationale as auth errors. The 4h auto-recovery sweep
  // only revives `auto:consecutive_failures`, so routing a dead upstream
  // to its own reason keeps it paused until an operator fixes the source.
  // Symptom this fixes: c2_tracker / phishtank cycling pause → recover →
  // fail every 4h on a 404 / archived upstream, spamming feed_health
  // notifications.
  //
  // "served no data on N consecutive days" is the same class stated by a
  // feed that already probed more than one upstream window itself (the
  // former WhoisDS nrd source walked yesterday AND the day before). A feed that reports every window
  // as 200-but-zero-bytes is not having a bad minute — its source is gone,
  // so it gets the sticky reason rather than the 4-hourly revive loop.
  // Transient shapes stay transient: an HTTP 5xx surfaces as "HTTP 503",
  // which matches none of these patterns.
  const isPermanentError =
    /\b(404|410)\b/.test(lastError) ||
    /upstream archived|no longer publishes|\bGone\b/i.test(lastError) ||
    /served no data on \d+ consecutive days/i.test(lastError);
  const pausedReason = isAuthError
    ? 'auto:auth_failure'
    : isPermanentError
      ? 'auto:upstream_dead'
      : 'auto:consecutive_failures';

  await feedsDb.prepare(
    `UPDATE feed_configs
       SET enabled = 0,
           paused_reason = ?,
           updated_at = datetime('now')
       WHERE feed_name = ? AND enabled = 1`
  ).bind(pausedReason, config.feed_name).run();

  const truncatedError = lastError.slice(0, 500);

  try {
    await createNotification(env, {
      // N1: explicit super_admin audience for the same reason as the
      // degraded notification above — feed auto-pause is operator territory.
      audience: 'super_admin',
      type: 'feed_health',
      severity: 'critical',
      title: isAuthError
        ? `Feed auto-paused (auth failure): ${config.display_name}`
        : `Feed auto-paused: ${config.display_name}`,
      message: isAuthError
        ? `${config.display_name} was paused after ${failureCount} consecutive HTTP 401/403 responses. The API key needs rotation; the feed will stay paused until manually resumed. Last error: ${truncatedError}`
        : `${config.display_name} was paused after ${failureCount} consecutive failures (threshold ${threshold}). Last error: ${truncatedError}`,
      link: '/admin/operations?tab=feeds',
      metadata: {
        feed_name: config.feed_name,
        auto_paused: true,
        paused_reason: pausedReason,
        consecutive_failures: failureCount,
        threshold,
        last_error: truncatedError,
      },
    });
  } catch (e) {
    console.error(`[runFeed] auto-pause notification failed for ${config.feed_name}:`, e);
  }

  // Log to agent_activity_log — same shape as flight_control's state
  // transitions. This is an operational event, not an agent insight,
  // so it intentionally does NOT go to agent_outputs.
  try {
    await (await telemetryStore(env)).prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
       VALUES (?, 'feed_runner', 'feed_auto_paused', ?, ?, 'critical')`
    ).bind(
      crypto.randomUUID(),
      `Feed ${config.feed_name} auto-paused after ${failureCount} consecutive failures (threshold ${threshold})`,
      JSON.stringify({
        feed_name: config.feed_name,
        display_name: config.display_name,
        consecutive_failures: failureCount,
        threshold,
        last_error: truncatedError,
      }),
    ).run();
  } catch (e) {
    console.error(`[runFeed] activity log failed for ${config.feed_name}:`, e);
  }
}

// ─── Reap penalty (breaker advance for worker-killed pulls) ──────
//
// When the worker is terminated mid-pull (CPU/wall ceiling), runFeed's
// try/catch never runs, so feed_status.consecutive_failures never
// advances and next_retry_at is never stamped — the feed silently
// death-loops: it shows "due" every tick, dies every time, and never
// trips the circuit breaker or auto-pause. The feed-pull-history reaper
// fixes the orphan row, but without this the breaker stayed blind to
// worker-killed pulls (the root cause of seclookup/greynoise sitting
// silent for 11h+ while still "enabled").
//
// This applies the SAME breaker penalty runFeed's catch applies on a
// caught failure: increment the counter, stamp an exponential-backoff
// next_retry_at, mark degraded, and auto-pause if the threshold is
// crossed. Called by the reaper for each distinct feed it reaps, with the DB
// the reaped row lives on (`feedsDb`; the routed feeds store when omitted):
// the breaker penalty lands where that pull's own finalize would have.
// Idempotent-safe and never throws — the reaper must not be broken by it.
export async function applyReapPenalty(
  env: Env,
  feedName: string,
  reapError: string,
  feedsDbIn?: D1Database,
): Promise<void> {
  try {
    const feedsDb = feedsDbIn ?? await familyStore(env, "feeds");
    // Pull the config so we can resolve the per-feed threshold + display
    // name for auto-pause. If the feed has no config row (or is already
    // disabled), there's nothing to penalize.
    const config = await feedsDb.prepare(
      `SELECT feed_name, display_name, source_url, schedule_cron, rate_limit,
              batch_size, retry_count, enabled, consecutive_failure_threshold
         FROM feed_configs WHERE feed_name = ?`,
    ).bind(feedName).first<FeedConfigRow>();
    if (!config || config.enabled === 0) return;

    // Ensure a feed_status row exists, then read the current counter.
    await feedsDb.prepare(
      "INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES (?, 'healthy')",
    ).bind(feedName).run();
    const prev = await feedsDb.prepare(
      "SELECT health_status, consecutive_failures FROM feed_status WHERE feed_name = ?",
    ).bind(feedName).first<{ health_status: string; consecutive_failures: number | null }>();

    const newFailureCount = (prev?.consecutive_failures ?? 0) + 1;
    const nextRetryAt = computeFeedRetryAt(newFailureCount);
    await feedsDb.prepare(
      `UPDATE feed_status SET
         last_failure = datetime('now'),
         health_status = 'degraded',
         last_error = ?,
         consecutive_failures = ?,
         next_retry_at = ?
       WHERE feed_name = ?`,
    ).bind(reapError.slice(0, 500), newFailureCount, nextRetryAt, feedName).run();

    // Auto-pause once the feed crosses its threshold — same path runFeed
    // uses, so a reaped death-loop now surfaces as a critical operator
    // notification instead of silent overdue-ness.
    const globalThreshold = await getGlobalFailureThreshold(env.DB);
    const threshold = resolveFailureThreshold(config, globalThreshold);
    if (newFailureCount >= threshold) {
      await autoPauseFeed(env, feedsDb, config, newFailureCount, threshold, reapError);
    }
  } catch (e) {
    console.error(`[applyReapPenalty] failed for ${feedName}:`, e);
  }
}

// ─── Coordinator ─────────────────────────────────────────────────

/** Run all enabled feeds */
export async function runAllFeeds(
  env: Env,
  feedModules: Record<string, FeedModule>,
): Promise<{
  feedsRun: number;
  feedsSkipped: number;
  feedsFailed: number;
  /** Subset of feedsFailed: abandoned at their wall-clock timeout. */
  feedsTimedOut: number;
  /** Due feeds not started because the pool budget ran out (also in feedsSkipped). */
  feedsDeferred: number;
  totalNew: number;
}> {
  // Reset the global-threshold cache so a fresh coordinator pass
  // picks up any system_config edit made since the last run.
  resetGlobalThresholdCache();

  // ── Auto-recover stale auto-paused feeds ─────────────────────
  // When a feed's upstream throws 5xx repeatedly (e.g. crt.sh hit
  // five HTTP 502s on 2026-04-27 and tripped ct_logs into
  // auto-pause), the transient-error handler in the feed module
  // prevents future failures from incrementing the counter. But
  // the feed is already paused, so the dispatch loop never runs
  // it, and the counter never resets. Manual unpause is the only
  // path out.
  //
  // This loop closes that gap: any feed auto-paused for
  // 'consecutive_failures' whose last failure is older than 4
  // hours gets re-enabled with a clean counter. If the upstream
  // has recovered, the feed ingests normally on the next
  // dispatch and stays clean. If it's still down, autoPauseFeed
  // re-pauses it on the very next failure — no harm done.
  //
  // Manual pauses (paused_reason starts with anything other than
  // 'auto:') are NEVER touched by this recovery loop.
  //
  // Configs + statuses come from the routed feeds store (resolved once for
  // the dispatch decision); each pull then resolves its own route at start.
  const feedsDb = await familyStore(env, "feeds");
  await autoRecoverStalePausedFeeds(feedsDb);

  // Fetch enabled feed configs
  const configs = await feedsDb.prepare(
    "SELECT * FROM feed_configs WHERE enabled = 1"
  ).all<FeedConfigRow>();

  // Fetch feed status for last-run checks
  const statuses = await feedsDb.prepare(
    "SELECT * FROM feed_status"
  ).all<FeedStatusRow>();
  const statusMap = new Map(statuses.results.map(s => [s.feed_name, s]));

  let feedsRun = 0;
  let feedsSkipped = 0;
  let feedsFailed = 0;
  let totalNew = 0;

  const now = new Date();

  // Determine which feeds to run based on their cron schedule
  const toRun: Array<{ config: FeedConfigRow; mod: FeedModule }> = [];

  for (const config of configs.results) {
    // Own cron (DEDICATED_INGEST_FEEDS) — never run inline in this pool.
    if (DEDICATED_INGEST_FEEDS.has(config.feed_name)) {
      feedsSkipped++;
      continue;
    }
    const mod = feedModules[config.feed_name];
    if (!mod) {
      feedsSkipped++;
      continue;
    }

    const status = statusMap.get(config.feed_name);
    const shouldRun = shouldRunNow(config, status, now);
    if (!shouldRun) {
      // (A per-skip agent_outputs diagnostic for cloudflare_scanner was
      // removed 2026-11-22: one D1 write per not-due tick, read by nothing.)
      feedsSkipped++;
      continue;
    }

    toRun.push({ config, mod });
  }

  // Run eligible feeds with BOUNDED concurrency. Unbounded
  // Promise.allSettled fan-out had every due feed firing its bulk
  // db.batch() INSERTs at the single trust-radar-v2 D1 instance
  // simultaneously; on busy ticks (many feeds due at once) that overloaded
  // the one D1 object and surfaced as "Internal error in D1 DB storage
  // caused object to be reset" / "Network connection lost" on otx_alienvault,
  // ct_logs, tweetfeed, urlhaus. Cloudflare's documented remedy is to spread
  // the write load. A small pool keeps a few feeds in flight without the
  // thundering-herd write contention.
  //
  // Every pull is wall-clock capped (runFeedWithTimeout) and the pool as a
  // whole by FEED_POOL_BUDGET_MS, so a hung pull frees its slot and
  // runAllFeeds always returns, giving the rest of the tick a chance to run. Longest-budget feeds start first (stable
  // sort) so a long feed is never clipped by the pool deadline merely
  // because it was dispatched late.
  toRun.sort((a, b) => feedRunTimeoutMs(b.config.feed_name) - feedRunTimeoutMs(a.config.feed_name));
  const poolDeadline = Date.now() + FEED_POOL_BUDGET_MS;
  const DEFERRED = Symbol("deferred");
  const results = await runWithConcurrency(
    toRun,
    FEED_CONCURRENCY,
    ({ config, mod }): Promise<FeedResult | typeof DEFERRED> => {
      const plan = plannedFeedTimeout(config.feed_name, poolDeadline);
      if (!plan) return Promise.resolve(DEFERRED);
      return runFeedWithTimeout(
        env, config, mod, plan.timeoutMs,
        plan.clipped ? { label: "feed-pool", budgetMs: FEED_POOL_BUDGET_MS } : null,
      );
    },
  );

  let feedsTimedOut = 0;
  let feedsDeferred = 0;
  for (const [i, r] of results.entries()) {
    const name = toRun[i]!.config.feed_name;
    if (r.status === "fulfilled" && r.value === DEFERRED) {
      feedsDeferred++;
      feedsSkipped++;
      console.warn(`[feedRunner] ${name}: DEFERRED — feed-pool budget exhausted, stays due for the next tick`);
      continue;
    }
    feedsRun++;
    if (r.status === "fulfilled") {
      if (r.value !== DEFERRED) totalNew += r.value.itemsNew;
    } else {
      feedsFailed++;
      if (r.reason instanceof FeedTimeoutError) feedsTimedOut++;
      console.error(`[feedRunner] ${name}: REJECTED — ${r.reason}`);
    }
  }

  return { feedsRun, feedsSkipped, feedsFailed, feedsTimedOut, feedsDeferred, totalNew };
}

// ─── Schedule Check ──────────────────────────────────────────────

/** Fraction of the schedule interval a feed may be "early" and still be due. */
const DUE_TOLERANCE_FRACTION = 0.2;
/** Floor: sub-hourly crons (e.g. every 5 min) keep the original 60 s trigger-jitter allowance. */
const DUE_TOLERANCE_MIN_MS = 60_000;
/**
 * Cap. Must stay well under the 60-min dispatcher cadence minus the worst
 * in-tick start jitter, or a feed could run one tick early (e.g. a 2h feed
 * at 1h elapsed). 20 min leaves >30 min of margin.
 */
const DUE_TOLERANCE_MAX_MS = 20 * 60_000;

/**
 * How far short of the full interval a feed may be and still count as due.
 *
 * `feed_status.last_successful_pull` is stamped at pull COMPLETION, but the
 * due check runs at the START of the next tick. Every dispatcher here fires
 * hourly (orchestrator `:07`), and a feed's completion lands minutes after
 * the tick (slow upstream, FEED_CONCURRENCY pool queuing, or its position in
 * the sequential social/enrichment chains, which start anywhere from :12 to
 * :21). With a fixed 60 s tolerance the next due tick sees `interval − a few
 * minutes` elapsed, skips, and the feed runs one tick late — an hourly feed
 * every 2h, a 6h feed every 7h (prod 2026-10-22: nvd_cve, taxii_otx, ipsum,
 * circl_pdns, …). A proportional tolerance absorbs that run-duration /
 * dispatch-position jitter without extra D1 reads or a migration.
 *
 *   5-min → 60 s · 30-min → 6 min · hourly → 12 min · ≥ 2h → 20 min
 */
export function dueToleranceMs(intervalMs: number): number {
  return Math.min(
    DUE_TOLERANCE_MAX_MS,
    Math.max(DUE_TOLERANCE_MIN_MS, intervalMs * DUE_TOLERANCE_FRACTION),
  );
}

/**
 * Simple interval-based check derived from cron expression.
 * Parses the minute field of the cron to determine interval.
 * Exported for tests.
 */
export function shouldRunNow(config: FeedConfigRow, status: FeedStatusRow | undefined, now: Date): boolean {
  if (!status) return true; // No status row = never run before

  // Circuit breaker: if a previous failure stamped a next_retry_at in
  // the future, skip this tick. The retry window auto-opens once now
  // crosses next_retry_at — at that point the feed pulls again
  // (half-open → either closed-on-success or longer-backoff-on-failure).
  if (status.next_retry_at) {
    const retryAt = status.next_retry_at;
    const retryMs = new Date(retryAt.includes('Z') || retryAt.includes('+') ? retryAt : retryAt + 'Z').getTime();
    if (now.getTime() < retryMs) return false;
  }

  if (!status.last_successful_pull) return true; // Never succeeded

  // Parse interval from cron: "*/5 * * * *" → 5 min, "0 * * * *" → 60 min, "0 */12 * * *" → 720 min
  const intervalMs = parseCronIntervalMs(config.schedule_cron);
  // Append 'Z' if missing — SQLite datetime('now') omits timezone, JS would parse as local
  const lastPull = status.last_successful_pull;
  const lastRun = new Date(lastPull.includes('Z') || lastPull.includes('+') ? lastPull : lastPull + 'Z').getTime();

  // Proportional tolerance: last_successful_pull is a completion time, the
  // check runs at the next tick's start — see dueToleranceMs.
  return now.getTime() - lastRun >= intervalMs - dueToleranceMs(intervalMs);
}

export function parseCronIntervalMs(cron: string): number {
  const parts = cron.split(/\s+/);
  if (parts.length < 5) return 5 * 60 * 1000; // default 5 min

  const minute = parts[0] ?? "*";
  const hour = parts[1] ?? "*";
  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";

  // "*/N * * * *" — every N minutes
  if (minute.startsWith("*/")) {
    return parseInt(minute.slice(2), 10) * 60 * 1000;
  }

  // "0 */N * * *" — every N hours
  if (minute === "0" && hour.startsWith("*/")) {
    return parseInt(hour.slice(2), 10) * 60 * 60 * 1000;
  }

  // "0 * * * *" — hourly
  if (minute === "0" && hour === "*") {
    return 60 * 60 * 1000;
  }

  // "M H * * D" — specific day-of-week → weekly. MUST be checked before
  // the daily branch below: a weekly cron like "0 0 * * 0" (Sundays) has
  // numeric minute+hour and would otherwise fall through to the 24h daily
  // interval, silently running 7× too often. This bug ran the
  // disposable_email reference load (intended weekly) every single day,
  // truncating + re-inserting ~5,600 rows daily — a 7× write overrun.
  if (
    /^\d+$/.test(minute) && /^\d+$/.test(hour) &&
    dayOfMonth === "*" && /^\d+$/.test(dayOfWeek)
  ) {
    return 7 * 24 * 60 * 60 * 1000;
  }

  // "0 0 * * *" — daily (specific hour, no wildcard)
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return 24 * 60 * 60 * 1000;
  }

  // Default: 5 minutes
  return 5 * 60 * 1000;
}

// ─── Run Enrichment Feeds (after ingest) ────────────────────────

/**
 * Run enrichment feeds — these enrich existing threats rather than ingesting new ones.
 * Called AFTER runAllFeeds so enrichment operates on freshly ingested data.
 *
 * Single-path approach: iterate the module map, check feed_configs for enabled
 * status (fallback: run all), check schedule, run each in its own try/catch.
 */
export async function runAllEnrichmentFeeds(
  env: Env,
  enrichmentModules: Record<string, FeedModule>,
  opts: {
    /**
     * Absolute epoch-ms deadline the loop must finish by (the orchestrator
     * passes enrichmentDeadlineForTick). The loop's effective deadline is
     * the earlier of this and start + ENRICHMENT_LOOP_BUDGET_MS.
     */
    deadline?: number;
  } = {},
): Promise<{
  feedsRun: number;
  feedsSkipped: number;
  feedsFailed: number;
  /** Subset of feedsFailed: abandoned at their wall-clock timeout. */
  feedsTimedOut: number;
  /** Due feeds not started because the loop budget ran out (also in feedsSkipped). */
  feedsDeferred: number;
  totalEnriched: number;
}> {
  let feedsRun = 0;
  let feedsSkipped = 0;
  let feedsFailed = 0;
  let feedsTimedOut = 0;
  let feedsDeferred = 0;
  let totalEnriched = 0;

  // Every pull is wall-clock capped (runFeedWithTimeout) and the loop as a
  // whole by `deadline`, so one hung pull (surbl, 2026-11-09 21:08) can no
  // longer hold the rest of the hourly tick behind it.
  const loopStart = Date.now();
  const deadline = Math.min(loopStart + ENRICHMENT_LOOP_BUDGET_MS, opts.deadline ?? Infinity);

  try {
    // Build a map of DB configs keyed by feed_name (empty if query fails)
    const configMap = new Map<string, FeedConfigRow>();
    const feedsDb = await familyStore(env, "feeds");
    try {
      const configs = await feedsDb.prepare(
        "SELECT * FROM feed_configs WHERE feed_type = 'enrichment'"
      ).all<FeedConfigRow>();
      for (const c of configs.results) configMap.set(c.feed_name, c);
      console.log(`[enrichment] feed_configs: ${configs.results.length} enrichment rows (${configs.results.map(c => `${c.feed_name}:${c.enabled ? 'on' : 'off'}`).join(', ')})`);
    } catch {
      // feed_type column may not exist — run all modules
      console.warn('[enrichment] feed_configs query failed — will run all registered modules');
    }

    // Load feed_status for schedule checks
    let statusMap = new Map<string, FeedStatusRow>();
    try {
      const statuses = await feedsDb.prepare("SELECT * FROM feed_status").all<FeedStatusRow>();
      statusMap = new Map(statuses.results.map(s => [s.feed_name, s]));
    } catch {
      console.warn('[enrichment] feed_status query failed — will run all modules unconditionally');
    }

    const now = new Date();
    const moduleNames = Object.keys(enrichmentModules);
    console.log(`[enrichment] Registered modules: ${moduleNames.join(', ')}`);

    // Iterate every registered enrichment module
    for (const [name, mod] of Object.entries(enrichmentModules)) {
      // Skip feeds that have their own dedicated cron — running them here
      // too would double-dispatch and re-create the inline-chain starvation
      // they were moved out of.
      if (DEDICATED_ENRICHMENT_FEEDS.has(name)) {
        feedsSkipped++;
        continue;
      }

      // Check enabled status: if we have config data and feed is disabled, skip
      const dbConfig = configMap.get(name);
      if (dbConfig && !dbConfig.enabled) {
        console.log(`[enrichment] ${name}: disabled in feed_configs — skipping`);
        feedsSkipped++;
        continue;
      }

      // Build config: use DB config if available, otherwise synthetic
      const config: FeedConfigRow = dbConfig ?? {
        feed_name: name,
        display_name: name,
        source_url: null,
        schedule_cron: '*/30 * * * *',
        rate_limit: 0,
        batch_size: 0,
        retry_count: 0,
        enabled: 1,
      };

      // Check schedule timing
      const status = statusMap.get(name);
      if (status && !shouldRunNow(config, status, now)) {
        console.log(`[enrichment] ${name}: not due yet (last_pull=${status.last_successful_pull ?? 'never'}) — skipping`);
        feedsSkipped++;
        continue;
      }

      const plan = plannedFeedTimeout(name, deadline);
      if (!plan) {
        console.warn(`[enrichment] ${name}: DEFERRED — enrichment loop budget exhausted, stays due for the next tick`);
        feedsDeferred++;
        feedsSkipped++;
        continue;
      }

      // Run the feed — isolated try/catch so one failure cannot kill others
      feedsRun++;
      try {
        console.log(`[enrichment] Running: ${name} (timeout ${Math.round(plan.timeoutMs / 1000)}s)`);
        const result = await runFeedWithTimeout(
          env, config, mod, plan.timeoutMs,
          plan.clipped ? { label: "enrichment", budgetMs: deadline - loopStart } : null,
        );
        totalEnriched += result.itemsNew;
        console.log(`[enrichment] ${name}: fetched=${result.itemsFetched} enriched=${result.itemsNew} errors=${result.itemsError}`);
      } catch (err) {
        feedsFailed++;
        if (err instanceof FeedTimeoutError) feedsTimedOut++;
        console.error(`[enrichment] ${name} FAILED:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (outerErr) {
    // Outer catch ensures the function NEVER throws
    console.error('[enrichment] FATAL outer error:', outerErr instanceof Error ? outerErr.message : String(outerErr));
  }

  console.log(`[enrichment] Done: ${feedsRun} ran, ${feedsFailed} failed (${feedsTimedOut} timed out), ${feedsSkipped} skipped (${feedsDeferred} deferred), ${totalEnriched} enriched`);
  return { feedsRun, feedsSkipped, feedsFailed, feedsTimedOut, feedsDeferred, totalEnriched };
}

// ─── Run Social Feeds (after enrichment) ────────────────────────

/**
 * Run social feeds — these monitor social platforms for brand mentions.
 * They insert into social_mentions table (not threats directly).
 * Watchdog agent handles classification and escalation.
 *
 * Single-path approach: iterate the module map, check feed_configs for enabled
 * status (fallback: run all), check schedule, run each in its own try/catch.
 */
export async function runAllSocialFeeds(
  env: Env,
  socialModules: Record<string, FeedModule>,
  opts: {
    /**
     * Absolute epoch-ms deadline the loop must finish by (the orchestrator
     * passes enrichmentDeadlineForTick). The loop's effective deadline is
     * the earlier of this and start + SOCIAL_LOOP_BUDGET_MS.
     */
    deadline?: number;
  } = {},
): Promise<{
  feedsRun: number;
  feedsSkipped: number;
  feedsFailed: number;
  /** Subset of feedsFailed: abandoned at their wall-clock timeout. */
  feedsTimedOut: number;
  /** Due feeds not started because the loop budget ran out (also in feedsSkipped). */
  feedsDeferred: number;
  totalNew: number;
}> {
  let feedsRun = 0;
  let feedsSkipped = 0;
  let feedsFailed = 0;
  let feedsTimedOut = 0;
  let feedsDeferred = 0;
  let totalNew = 0;

  // Same caps as the enrichment loop: every pull on runFeedWithTimeout
  // (all social feeds are on the 120s default) and the loop as a whole on
  // `deadline`, so a hung social pull cannot eat the tail of the tick.
  const loopStart = Date.now();
  const deadline = Math.min(loopStart + SOCIAL_LOOP_BUDGET_MS, opts.deadline ?? Infinity);

  try {
    // Build a map of DB configs keyed by feed_name (empty if query fails)
    const configMap = new Map<string, FeedConfigRow>();
    const feedsDb = await familyStore(env, "feeds");
    try {
      const configs = await feedsDb.prepare(
        "SELECT * FROM feed_configs WHERE feed_type = 'social'"
      ).all<FeedConfigRow>();
      for (const c of configs.results) configMap.set(c.feed_name, c);
      console.log(`[social] feed_configs: ${configs.results.length} social rows (${configs.results.map(c => `${c.feed_name}:${c.enabled ? 'on' : 'off'}`).join(', ')})`);
    } catch {
      // feed_type column may not exist — run all modules
      console.warn('[social] feed_configs query failed — will run all registered modules');
    }

    // Load feed_status for schedule checks
    let statusMap = new Map<string, FeedStatusRow>();
    try {
      const statuses = await feedsDb.prepare("SELECT * FROM feed_status").all<FeedStatusRow>();
      statusMap = new Map(statuses.results.map(s => [s.feed_name, s]));
    } catch {
      console.warn('[social] feed_status query failed — will run all modules unconditionally');
    }

    const now = new Date();
    const moduleNames = Object.keys(socialModules);
    console.log(`[social] Registered modules: ${moduleNames.join(', ')}`);

    // Iterate every registered social module
    for (const [name, mod] of Object.entries(socialModules)) {
      // Check enabled status: if we have config data and feed is disabled, skip
      const dbConfig = configMap.get(name);
      if (dbConfig && !dbConfig.enabled) {
        console.log(`[social] ${name}: disabled in feed_configs — skipping`);
        feedsSkipped++;
        continue;
      }

      // Build config: use DB config if available, otherwise synthetic
      const config: FeedConfigRow = dbConfig ?? {
        feed_name: name,
        display_name: name,
        source_url: null,
        schedule_cron: '0 */2 * * *',
        rate_limit: 0,
        batch_size: 0,
        retry_count: 0,
        enabled: 1,
      };

      // Check schedule timing
      const status = statusMap.get(name);
      if (status && !shouldRunNow(config, status, now)) {
        console.log(`[social] ${name}: not due yet (last_pull=${status.last_successful_pull ?? 'never'}) — skipping`);
        feedsSkipped++;
        continue;
      }

      const plan = plannedFeedTimeout(name, deadline);
      if (!plan) {
        console.warn(`[social] ${name}: DEFERRED — social loop budget exhausted, stays due for the next tick`);
        feedsDeferred++;
        feedsSkipped++;
        continue;
      }

      // Run the feed — isolated try/catch so one failure cannot kill others
      feedsRun++;
      try {
        console.log(`[social] Running: ${name} (timeout ${Math.round(plan.timeoutMs / 1000)}s)`);
        const result = await runFeedWithTimeout(
          env, config, mod, plan.timeoutMs,
          plan.clipped ? { label: "social", budgetMs: deadline - loopStart } : null,
        );
        totalNew += result.itemsNew;
        console.log(`[social] ${name}: fetched=${result.itemsFetched} new=${result.itemsNew} errors=${result.itemsError}`);
      } catch (err) {
        feedsFailed++;
        if (err instanceof FeedTimeoutError) feedsTimedOut++;
        console.error(`[social] ${name} FAILED:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (outerErr) {
    // Outer catch ensures the function NEVER throws
    console.error('[social] FATAL outer error:', outerErr instanceof Error ? outerErr.message : String(outerErr));
  }

  console.log(`[social] Done: ${feedsRun} ran, ${feedsFailed} failed (${feedsTimedOut} timed out), ${feedsSkipped} skipped (${feedsDeferred} deferred), ${totalNew} new`);
  return { feedsRun, feedsSkipped, feedsFailed, feedsTimedOut, feedsDeferred, totalNew };
}

// ─── Reset daily counters (called at start of day) ───────────────

export async function resetDailyCounters(db: D1Database): Promise<void> {
  await db.prepare("UPDATE feed_status SET records_ingested_today = 0").run();
}
