// Averrow — Site Script Watch scanner pipeline (PR2): client-side supply-
// chain / Magecart monitoring of a customer brand's OWN website.
//
// Schema: migrations/0337_site_script_watch.sql (its header documents every
// column, finding kind and retention). Pure diff / matching logic:
// lib/site-script-watch.ts. Browser driver: lib/site-script-browser.ts
// (reuses the page-capture browser session, request interceptor and SSRF
// guard). agents/siteScriptWatch.ts is a thin SQL-free wrapper; all SQL is
// here.
//
// One run = at most ONE brand:
//   1. due brand  — brands.tier = 'customer' with a trusted canonical_domain
//                   (TRUSTED_BRAND_CANONICAL_SQL) that is not on shared
//                   hosting, and no site_scans row in the last
//                   SITE_SCAN_INTERVAL_HOURS; never-scanned first, then
//                   oldest scan first. Derived from site_scans (no new column).
//   2. claim      — INSERT a `running` site_scans row guarded by the same
//                   "no scan in the window" predicate, so two overlapping runs
//                   cannot scan one brand twice.
//   3. render     — https://<canonical_domain>/ under a hard timeout.
//   4. decide     — baseline = no earlier `complete` scan (isBaselineScan);
//                   implausibly small scan → `skipped`, nothing else written
//                   (assessScanPlausibility).
//   5. diff       — diffSiteScan (scripts) + diffContactedHosts (requests).
//   6. IOC match  — script hosts + contacted hosts (matchHostsAgainstThreats)
//                   and script URLs (matchUrlsAgainstThreats) against ACTIVE
//                   threats → `ioc_match` (also on a baseline scan: a site
//                   that already loads a known-bad host is a finding).
//   7. persist    — findings (INSERT … ON CONFLICT on the open-dedupe index DO
//                   NOTHING), inventory + contacted-host upserts and the scan
//                   completion, in atomic D1 batches retried past the overload
//                   window. Writes on env.DB; reads on a read session.
// Plus: a reaper for `running` rows a dead worker left behind, and a
// once-a-day retention sweep (UTC hour 0, hour-only gate, KV day stamp).
//
// No AI. No alerts / notifications yet (later PR) — findings are the output.

import type { D1Database, D1DatabaseSession, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../types";
import { getReadSession } from "./db";
import { D1_OVERLOAD_RETRY_BASE_MS, withD1Retry } from "./d1-retry";
import { d1Ts, makeNavigationGuard, runWithHardTimeout, type NavigationGuard } from "./page-capture";
import type { FetchDeps } from "./page-fetch";
import { TRUSTED_BRAND_CANONICAL_SQL, isUnderSharedHosting } from "./safeDomains";
import {
  SITE_SCRIPT_EVIDENCE_URL_MAX,
  SITE_SCRIPT_MATCH_CHUNK,
  assessScanPlausibility,
  diffContactedHosts,
  diffSiteScan,
  findingDedupeKey,
  isBaselineScan,
  matchHostsAgainstThreats,
  matchUrlsAgainstThreats,
  normaliseScriptUrl,
  toAsciiHost,
  SCAN_SKIP_ACCEPT_AFTER,
  type ContactedRequest,
  type InventoryRow,
  type ScannedScript,
  type SiteScriptFinding,
  type SiteScriptFindingEvidence,
  type SiteScriptFindingKind,
  type ThreatMatch,
} from "./site-script-watch";

// ─── Tunables ────────────────────────────────────────────────────────

/** A brand is due when it has no site_scans row this recent. */
export const SITE_SCAN_INTERVAL_HOURS = 6;
/** Hard per-site wall-clock limit (navigation + settle + DOM + body hashing). */
export const SITE_SCAN_PAGE_TIMEOUT_MS = 30_000;
/** Time kept back after the page for reads + writes. */
export const SITE_SCAN_WRITE_MARGIN_MS = 20_000;
/** Smallest budget a run needs to start a scan. */
export const SITE_SCAN_MIN_BUDGET_MS = SITE_SCAN_PAGE_TIMEOUT_MS + SITE_SCAN_WRITE_MARGIN_MS;
/**
 * Wall-clock window of one `*\/10` cron invocation, measured from its
 * scheduledTime: page_capture runs first; Site Script Watch starts only when
 * at least SITE_SCAN_MIN_BUDGET_MS of this window is left, so a scan never
 * runs into the next tick (no two browser sessions from consecutive ticks).
 */
export const SITE_SCRIPT_TICK_WINDOW_MS = 7 * 60_000;
/** A `running` scan older than this was left by a dead worker. */
export const SITE_SCAN_STUCK_MINUTES = 30;
/** Brand candidates read per run (customer tier is small). */
const DUE_CANDIDATES = 50;
/** Stored inventory / contacted-host rows read per brand. */
export const SITE_SCAN_INVENTORY_READ_LIMIT = 5_000;
/** Statements per D1 batch (each ≤ 11 binds). */
export const SITE_SCAN_WRITE_BATCH = 50;
/** Longest evidence_json / error stored. */
const MAX_EVIDENCE_JSON = 8_192;
const MAX_ERROR = 500;

/** Retention (migration 0337 header). */
export const SITE_SCAN_RETENTION_DAYS = 90;
export const SITE_CONTACTED_RETENTION_DAYS = 90;
export const SITE_FINDING_RETENTION_DAYS = 180;
export const SITE_INVENTORY_UNSEEN_DAYS = 90;
const SWEEP_PAGE = 500;
const SWEEP_MAX_ROUNDS = 10;
export const SITE_SCRIPT_SWEEP_STAMP_PREFIX = "site_script_watch:sweep:";

/** Overload-aware retry for every write (D1's 10 s window, lib/d1-retry.ts). */
const WRITE_RETRY = { retries: 3, overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS, label: "site_script_watch" } as const;

// ─── Driver contract (lib/site-script-browser.ts is the puppeteer one) ──

export interface SiteScanRequest {
  targetUrl: string;
  timeoutMs: number;
  guard: NavigationGuard;
  /** Aborted on the hard timeout — the driver must close its page. */
  signal: AbortSignal;
}

export interface RawSiteScan {
  finalUrl: string | null;
  httpStatus: number | null;
  scripts: ScannedScript[];
  requests: ContactedRequest[];
  /** A main-frame navigation hop the guard refused. */
  blockedNavigation: string | null;
  blockedRetryable?: boolean;
  /** The per-page host cap was hit (later new hosts were aborted). */
  hostCapHit: boolean;
  /** Distinct request URLs not recorded (NET_MAX_REQUESTS). */
  requestsDropped: number;
  bodiesHashed: number;
  bodiesSkipped: number;
  /** Inline scripts whose text exceeded the in-page cap (not inventoried). */
  inlineCut: number;
}

export interface SiteScanSession {
  scan(req: SiteScanRequest): Promise<RawSiteScan>;
  close(): Promise<void>;
}

export interface SiteScanDriver {
  open(): Promise<SiteScanSession>;
}

// ─── Small helpers ───────────────────────────────────────────────────

function clip(s: string | null | undefined, n: number): string | null {
  if (s === null || s === undefined) return null;
  return s.length > n ? s.slice(0, n) : s;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

/**
 * Budget for the site scan in the `*\/10` cron invocation, given when it was
 * scheduled and now: what is left of SITE_SCRIPT_TICK_WINDOW_MS. The cron
 * branch dispatches only when this is ≥ SITE_SCAN_MIN_BUDGET_MS. Pure.
 */
export function siteScriptTickBudgetMs(scheduledTimeMs: number, nowMs: number): number {
  return SITE_SCRIPT_TICK_WINDOW_MS - Math.max(0, nowMs - scheduledTimeMs);
}

// ─── Due brand + claim ───────────────────────────────────────────────

export interface DueBrand {
  id: string;
  canonical_domain: string;
  last_scan_at: string | null;
}

/**
 * Customer-tier brands with a trusted canonical domain and no scan inside the
 * interval, never-scanned first, then oldest scan. idx_brands_tier narrows to
 * the customer tier; the correlated reads seek idx_site_scans_brand_scanned.
 */
export const DUE_BRANDS_SQL =
  `SELECT b.id AS id, b.canonical_domain AS canonical_domain,
          (SELECT MAX(s.scanned_at) FROM site_scans s WHERE s.brand_id = b.id) AS last_scan_at
     FROM brands b
    WHERE b.tier = 'customer'
      AND b.canonical_domain IS NOT NULL AND b.canonical_domain <> ''
      AND (${TRUSTED_BRAND_CANONICAL_SQL}) = 1
      AND NOT EXISTS (SELECT 1 FROM site_scans r WHERE r.brand_id = b.id AND r.scanned_at >= ?)
    ORDER BY last_scan_at IS NOT NULL, last_scan_at, b.id
    LIMIT ?`;

/** A scannable hostname: ASCII, ≥ 2 labels, not an IP literal, not shared hosting. */
export function scannableCanonicalHost(raw: string): string | null {
  const host = toAsciiHost(raw).replace(/^www\./, "");
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
  if (isUnderSharedHosting(host)) return null;
  return host;
}

export async function pickDueBrand(db: D1Database | D1DatabaseSession, now: Date): Promise<(DueBrand & { host: string }) | null> {
  const cutoff = d1Ts(addMs(now, -SITE_SCAN_INTERVAL_HOURS * 3_600_000));
  const res = await db.prepare(DUE_BRANDS_SQL).bind(cutoff, DUE_CANDIDATES).all<DueBrand>();
  for (const b of res.results ?? []) {
    const host = scannableCanonicalHost(b.canonical_domain);
    if (host) return { ...b, host };
  }
  return null;
}

/** Claim: insert the `running` row only if no scan landed inside the interval meanwhile. */
export async function claimScan(db: D1Database, scanId: string, brandId: string, url: string, now: Date): Promise<boolean> {
  const cutoff = d1Ts(addMs(now, -SITE_SCAN_INTERVAL_HOURS * 3_600_000));
  const res = await withD1Retry(
    () =>
      db
        .prepare(
          `INSERT INTO site_scans (id, brand_id, url, status, scanned_at)
           SELECT ?, ?, ?, 'running', ?
            WHERE NOT EXISTS (SELECT 1 FROM site_scans WHERE brand_id = ? AND scanned_at >= ?)`,
        )
        .bind(scanId, brandId, url, d1Ts(now), brandId, cutoff)
        .run(),
    WRITE_RETRY,
  );
  return (res.meta?.changes ?? 0) > 0;
}

/** `running` rows a dead worker left (bounded window on idx_site_scans_scanned). */
export async function reapStuckScans(db: D1Database, now: Date): Promise<number> {
  const res = await withD1Retry(
    () =>
      db
        .prepare(
          `UPDATE site_scans SET status = 'failed', error = 'worker terminated before the scan finished'
            WHERE scanned_at < ? AND scanned_at >= ? AND status = 'running'`,
        )
        .bind(d1Ts(addMs(now, -SITE_SCAN_STUCK_MINUTES * 60_000)), d1Ts(addMs(now, -2 * 86_400_000)))
        .run(),
    WRITE_RETRY,
  );
  return res.meta?.changes ?? 0;
}

/** Finalize a claimed scan (no-op if the reaper already failed it). */
function finishScanStmt(
  db: D1Database,
  scanId: string,
  status: "complete" | "skipped" | "failed",
  fields: { scripts?: number; hosts?: number; error?: string | null },
): D1PreparedStatement {
  return db
    .prepare(`UPDATE site_scans SET status = ?, scripts_count = ?, hosts_count = ?, error = ? WHERE id = ? AND status = 'running'`)
    .bind(status, fields.scripts ?? 0, fields.hosts ?? 0, clip(fields.error ?? null, MAX_ERROR), scanId);
}

// ─── History ─────────────────────────────────────────────────────────

export interface ScanHistory {
  /** scripts_count of the newest earlier `complete` scan; null = none (baseline). */
  previousCompleteScripts: number | null;
  /** `skipped` scans since that complete scan (capped). */
  consecutiveSkips: number;
}

export async function readScanHistory(db: D1Database | D1DatabaseSession, brandId: string, scanId: string): Promise<ScanHistory> {
  const [prev, recent] = await Promise.all([
    db
      .prepare(
        `SELECT scripts_count FROM site_scans
          WHERE brand_id = ? AND status = 'complete' AND id <> ?
          ORDER BY scanned_at DESC LIMIT 1`,
      )
      .bind(brandId, scanId)
      .first<{ scripts_count: number }>(),
    db
      .prepare(
        `SELECT status FROM site_scans
          WHERE brand_id = ? AND status IN ('complete', 'skipped') AND id <> ?
          ORDER BY scanned_at DESC LIMIT ?`,
      )
      .bind(brandId, scanId, SCAN_SKIP_ACCEPT_AFTER + 1)
      .all<{ status: string }>(),
  ]);
  let skips = 0;
  for (const r of recent.results ?? []) {
    if (r.status !== "skipped") break;
    skips++;
  }
  return { previousCompleteScripts: prev ? Number(prev.scripts_count) : null, consecutiveSkips: skips };
}

// ─── IOC findings ────────────────────────────────────────────────────

export type IocSource = "script_url" | "script_host" | "contacted_host";

export interface IocEvidence extends SiteScriptFindingEvidence {
  matched_value: string;
  match_kind: ThreatMatch["match_kind"];
  matched_on: IocSource;
  threat_id: string;
  source_feed: string | null;
}

const MATCH_RANK: Record<ThreatMatch["match_kind"], number> = { url: 0, exact: 1, ip: 2, parent: 3 };

interface IocCandidate {
  match: ThreatMatch;
  source: IocSource;
  url: string | null;
  path_norm: string | null;
  page_url: string | null;
  initiator_url?: string | null;
}

/**
 * One `ioc_match` per host (its dedupe key is host-level): the most specific
 * match wins (url > exact > ip > parent), then the lowest threat id.
 * Evidence names the matched URL / host, the threat and its source feed.
 */
export function buildIocFindings(candidates: IocCandidate[], sourceFeeds: ReadonlyMap<string, string | null>): SiteScriptFinding[] {
  const best = new Map<string, IocCandidate>();
  for (const c of candidates) {
    if (!c.match.host) continue;
    const cur = best.get(c.match.host);
    if (
      !cur ||
      MATCH_RANK[c.match.match_kind] < MATCH_RANK[cur.match.match_kind] ||
      (MATCH_RANK[c.match.match_kind] === MATCH_RANK[cur.match.match_kind] && c.match.threat_id < cur.match.threat_id)
    ) {
      best.set(c.match.host, c);
    }
  }
  const out: SiteScriptFinding[] = [];
  for (const c of [...best.values()].sort((a, b) => (a.match.host < b.match.host ? -1 : 1))) {
    const evidence: IocEvidence = {
      url: c.url ? clip(c.url, SITE_SCRIPT_EVIDENCE_URL_MAX) : null,
      matched_value: c.match.matched_value,
      match_kind: c.match.match_kind,
      matched_on: c.source,
      threat_id: c.match.threat_id,
      source_feed: sourceFeeds.get(c.match.threat_id) ?? null,
    };
    if (c.initiator_url) evidence.initiator_url = c.initiator_url;
    out.push({
      kind: "ioc_match",
      host: c.match.host,
      path_norm: c.path_norm,
      page_url: c.page_url,
      threat_id: c.match.threat_id,
      evidence,
    });
  }
  return out;
}

async function readSourceFeeds(db: D1Database | D1DatabaseSession, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += SITE_SCRIPT_MATCH_CHUNK) {
    const chunk = uniq.slice(i, i + SITE_SCRIPT_MATCH_CHUNK);
    const res = await db
      .prepare(`SELECT id, source_feed FROM threats WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ id: string; source_feed: string | null }>();
    for (const r of res.results ?? []) out.set(r.id, r.source_feed ?? null);
  }
  return out;
}

// ─── Statements ──────────────────────────────────────────────────────

export const INSERT_FINDING_SQL =
  `INSERT INTO site_script_findings
     (id, brand_id, scan_id, kind, host, path_norm, page_url, threat_id, dedupe_key, evidence_json, created_at, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
   ON CONFLICT (brand_id, dedupe_key) WHERE status = 'open' DO NOTHING`;

/**
 * Inventory upsert. On a hash change the old hash moves to prev_sha256 and
 * change_count goes up (RHS columns read the OLD row). An unhashed body (NULL)
 * keeps the stored hash. integrity is overwritten only when this scan
 * captured the tag (the 11th bind = 1).
 */
export const UPSERT_INVENTORY_SQL =
  `INSERT INTO site_script_inventory
     (brand_id, script_host, path_norm, is_first_party, is_inline, first_seen, last_seen, first_page_url, last_sha256, integrity)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (brand_id, script_host, path_norm) DO UPDATE SET
     last_seen = excluded.last_seen,
     is_first_party = excluded.is_first_party,
     prev_sha256 = CASE WHEN excluded.last_sha256 IS NOT NULL AND site_script_inventory.last_sha256 IS NOT NULL
                         AND excluded.last_sha256 <> site_script_inventory.last_sha256
                        THEN site_script_inventory.last_sha256 ELSE site_script_inventory.prev_sha256 END,
     change_count = site_script_inventory.change_count +
                    CASE WHEN excluded.last_sha256 IS NOT NULL AND site_script_inventory.last_sha256 IS NOT NULL
                          AND excluded.last_sha256 <> site_script_inventory.last_sha256 THEN 1 ELSE 0 END,
     last_sha256 = COALESCE(excluded.last_sha256, site_script_inventory.last_sha256),
     integrity = CASE WHEN ? = 1 THEN excluded.integrity ELSE site_script_inventory.integrity END`;

/** Contacted-host upsert: the FIRST observed initiator is kept. */
export const UPSERT_CONTACTED_SQL =
  `INSERT INTO site_contacted_hosts (brand_id, host, first_seen, last_seen, request_count, initiator_host, initiator_path)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (brand_id, host) DO UPDATE SET
     last_seen = excluded.last_seen,
     request_count = site_contacted_hosts.request_count + excluded.request_count,
     initiator_path = CASE WHEN site_contacted_hosts.initiator_host IS NULL
                           THEN excluded.initiator_path ELSE site_contacted_hosts.initiator_path END,
     initiator_host = COALESCE(site_contacted_hosts.initiator_host, excluded.initiator_host)`;

/** Run statements in atomic batches (retry-safe: a failed batch rolled back). */
async function runBatches(db: D1Database, stmts: D1PreparedStatement[], deadline: number): Promise<Array<{ meta?: { changes?: number } }>> {
  const out: Array<{ meta?: { changes?: number } }> = [];
  for (let i = 0; i < stmts.length; i += SITE_SCAN_WRITE_BATCH) {
    const chunk = stmts.slice(i, i + SITE_SCAN_WRITE_BATCH);
    const res = await withD1Retry(() => db.batch(chunk), { ...WRITE_RETRY, deadline });
    out.push(...(res as Array<{ meta?: { changes?: number } }>));
  }
  return out;
}

// ─── Retention sweep ─────────────────────────────────────────────────

export interface SiteScriptSweepResult {
  ran: boolean;
  scans: number;
  contacted: number;
  findings: number;
  inventory: number;
}

const emptySweep = (): SiteScriptSweepResult => ({ ran: false, scans: 0, contacted: 0, findings: 0, inventory: 0 });

async function sweepRounds(db: D1Database, sql: string, cutoff: string): Promise<number> {
  let total = 0;
  for (let round = 0; round < SWEEP_MAX_ROUNDS; round++) {
    const res = await withD1Retry(() => db.prepare(sql).bind(cutoff, SWEEP_PAGE).run(), WRITE_RETRY);
    const n = res.meta?.changes ?? 0;
    total += n;
    if (n < SWEEP_PAGE) break;
  }
  return total;
}

/**
 * Retention (migration 0337 header), bounded: ≤ SWEEP_MAX_ROUNDS ×
 * SWEEP_PAGE rows per table per run, a backlog continues the next day.
 *   site_scans            > 90 days, EXCEPT each brand's latest complete scan
 *                         (its loss would make the next scan a silent re-baseline)
 *   site_contacted_hosts  last_seen > 90 days
 *   site_script_findings  CLOSED and created > 180 days (open ones stay)
 *   site_script_inventory last_seen > 90 days (a returning script is new again)
 */
export async function sweepSiteScriptData(db: D1Database, now: Date): Promise<SiteScriptSweepResult> {
  const days = (n: number): string => d1Ts(addMs(now, -n * 86_400_000));
  const scans = await sweepRounds(
    db,
    `DELETE FROM site_scans WHERE id IN (
       SELECT s.id FROM site_scans s
        WHERE s.scanned_at < ?
          AND NOT (s.status = 'complete' AND s.scanned_at = (
                SELECT MAX(c.scanned_at) FROM site_scans c WHERE c.brand_id = s.brand_id AND c.status = 'complete'))
        LIMIT ?)`,
    days(SITE_SCAN_RETENTION_DAYS),
  );
  const contacted = await sweepRounds(
    db,
    `DELETE FROM site_contacted_hosts WHERE rowid IN (
       SELECT rowid FROM site_contacted_hosts WHERE last_seen < ? LIMIT ?)`,
    days(SITE_CONTACTED_RETENTION_DAYS),
  );
  const findings = await sweepRounds(
    db,
    `DELETE FROM site_script_findings WHERE rowid IN (
       SELECT rowid FROM site_script_findings WHERE created_at < ? AND status <> 'open' LIMIT ?)`,
    days(SITE_FINDING_RETENTION_DAYS),
  );
  const inventory = await sweepRounds(
    db,
    `DELETE FROM site_script_inventory WHERE rowid IN (
       SELECT rowid FROM site_script_inventory WHERE last_seen < ? LIMIT ?)`,
    days(SITE_INVENTORY_UNSEEN_DAYS),
  );
  return { ran: true, scans, contacted, findings, inventory };
}

/** Once per UTC day on the first run in hour 0 (hour-only gate — cron-audit
 *  safe, no minute check; a KV day stamp dedups the other hour-0 ticks). KV
 *  unavailable → run anyway (the sweep is idempotent). */
export async function maybeDailySiteScriptSweep(env: Pick<Env, "DB" | "CACHE">, scheduledTime: Date): Promise<SiteScriptSweepResult> {
  if (scheduledTime.getUTCHours() !== 0) return emptySweep();
  const stampKey = `${SITE_SCRIPT_SWEEP_STAMP_PREFIX}${scheduledTime.toISOString().slice(0, 10)}`;
  try {
    if (await env.CACHE.get(stampKey)) return emptySweep();
  } catch { /* fall through */ }
  const result = await sweepSiteScriptData(env.DB, scheduledTime);
  try {
    await env.CACHE.put(stampKey, "1", { expirationTtl: 2 * 86_400 });
  } catch { /* best-effort */ }
  return result;
}

// ─── The run ─────────────────────────────────────────────────────────

export interface SiteScriptRunStats {
  skipped: string | null;
  brand_id: string | null;
  scan_id: string | null;
  scan_status: "complete" | "skipped" | "failed" | null;
  baseline: boolean;
  scripts: number;
  script_hosts: number;
  contacted_hosts: number;
  findings_found: number;
  findings_inserted: number;
  by_kind: Partial<Record<SiteScriptFindingKind, number>>;
  ioc_matches: number;
  reaped: number;
  sweep: SiteScriptSweepResult;
  [key: string]: unknown;
}

export interface SiteScriptRunOptions {
  /** Wall time this run may use (cron: what page_capture left). */
  budgetMs?: number;
  /** Defaults to the puppeteer driver over env.BROWSER. */
  driver?: SiteScanDriver;
  /** Cron fire time (hour gate for the sweep). Defaults to now. */
  scheduledTime?: Date;
  /** Clock (tests). */
  now?: () => Date;
  /** DoH resolver for the SSRF guard (tests). */
  resolve?: FetchDeps["resolve"];
  /** Read handle (tests); defaults to a read-replica session. */
  readDb?: D1Database | D1DatabaseSession;
}

function newStats(): SiteScriptRunStats {
  return {
    skipped: null, brand_id: null, scan_id: null, scan_status: null, baseline: false,
    scripts: 0, script_hosts: 0, contacted_hosts: 0, findings_found: 0, findings_inserted: 0,
    by_kind: {}, ioc_matches: 0, reaped: 0, sweep: emptySweep(),
  };
}

export async function runSiteScriptWatch(env: Env, opts: SiteScriptRunOptions = {}): Promise<SiteScriptRunStats> {
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock();
  const startedMs = Date.now();
  const stats = newStats();

  // Clean no-op without Browser Rendering (staging / dev / tests).
  if (!env.BROWSER && !opts.driver) {
    stats.skipped = "bindings_absent:BROWSER";
    return stats;
  }

  const budgetMs = opts.budgetMs ?? SITE_SCAN_MIN_BUDGET_MS;
  if (budgetMs < SITE_SCAN_MIN_BUDGET_MS) {
    stats.skipped = "budget";
    return stats;
  }
  const deadline = startedMs + budgetMs;

  // Housekeeping never blocks the scan.
  try {
    stats.sweep = await maybeDailySiteScriptSweep(env, opts.scheduledTime ?? startedAt);
  } catch (err) {
    stats.sweep_error = msg(err);
  }
  try {
    stats.reaped = await reapStuckScans(env.DB, startedAt);
  } catch (err) {
    stats.reap_error = msg(err);
  }

  // A slow sweep must not push the scan past the budget.
  if (deadline - Date.now() < SITE_SCAN_PAGE_TIMEOUT_MS + SITE_SCAN_WRITE_MARGIN_MS / 2) {
    stats.skipped = "budget";
    return stats;
  }

  const readDb = opts.readDb ?? getReadSession(env, { bookmark: null });
  const brand = await pickDueBrand(readDb, startedAt);
  if (!brand) {
    stats.skipped = "no_due_brand";
    return stats;
  }
  stats.brand_id = brand.id;
  const targetUrl = `https://${brand.host}/`;
  const scanId = `ssc_${crypto.randomUUID()}`;
  if (!(await claimScan(env.DB, scanId, brand.id, targetUrl, startedAt))) {
    stats.skipped = "claimed_elsewhere";
    return stats;
  }
  stats.scan_id = scanId;

  // ── Render ──
  let driver = opts.driver;
  if (!driver) {
    const { puppeteerSiteScanDriver } = await import("./site-script-browser");
    driver = puppeteerSiteScanDriver(env.BROWSER!);
  }
  const fail = async (error: string): Promise<SiteScriptRunStats> => {
    stats.scan_status = "failed";
    stats.scan_error = clip(error, MAX_ERROR);
    await withD1Retry(() => finishScanStmt(env.DB, scanId, "failed", { error }).run(), WRITE_RETRY);
    return stats;
  };

  let session: SiteScanSession;
  try {
    session = await driver.open();
  } catch (err) {
    await fail(`browser session unavailable: ${msg(err)}`);
    throw new Error(`browser session unavailable: ${msg(err)}`);
  }
  let raw: RawSiteScan;
  try {
    const guard = makeNavigationGuard(opts.resolve);
    const pre = await guard(targetUrl);
    if (!pre.ok) return await fail(`refused target: ${pre.reason}`);
    raw = await runWithHardTimeout(
      (signal) => session.scan({ targetUrl, timeoutMs: SITE_SCAN_PAGE_TIMEOUT_MS, guard, signal }),
      SITE_SCAN_PAGE_TIMEOUT_MS,
      "site scan",
    );
  } catch (err) {
    return await fail(msg(err));
  } finally {
    try {
      await session.close();
    } catch { /* already gone */ }
  }
  if (raw.finalUrl === null) return await fail(`refused navigation: ${raw.blockedNavigation ?? "page did not load"}`);

  // ── Decide + diff ──
  const pageUrl = raw.finalUrl;
  const history = await readScanHistory(readDb, brand.id, scanId);
  const baseline = isBaselineScan(history.previousCompleteScripts === null ? 0 : 1);
  stats.baseline = baseline;
  const [invRes, hostRes] = await Promise.all([
    readDb
      .prepare(`SELECT script_host, path_norm, last_sha256, integrity FROM site_script_inventory WHERE brand_id = ? LIMIT ?`)
      .bind(brand.id, SITE_SCAN_INVENTORY_READ_LIMIT)
      .all<InventoryRow>(),
    readDb
      .prepare(`SELECT host FROM site_contacted_hosts WHERE brand_id = ? LIMIT ?`)
      .bind(brand.id, SITE_SCAN_INVENTORY_READ_LIMIT)
      .all<{ host: string }>(),
  ]);
  const inventory = invRes.results ?? [];
  const knownHosts = (hostRes.results ?? []).map((r) => r.host);

  const diff = diffSiteScan(raw.scripts, inventory, { canonicalDomain: brand.host, pageUrl, baseline });
  const scriptHosts = new Set(diff.observed.filter((o) => !o.is_inline && !o.is_first_party).map((o) => o.host));
  stats.scripts = diff.observed.length;
  stats.script_hosts = scriptHosts.size;

  const notes: string[] = [];
  if (raw.hostCapHit) notes.push("host cap reached: later new-host requests were blocked");
  if (raw.requestsDropped > 0) notes.push(`${raw.requestsDropped} request URLs over the cap not recorded`);
  if (raw.inlineCut > 0) notes.push(`${raw.inlineCut} inline scripts over the size cap not inventoried`);
  if (inventory.length >= SITE_SCAN_INVENTORY_READ_LIMIT) notes.push("inventory read truncated");

  const plausible = assessScanPlausibility(diff.observed.length, history.previousCompleteScripts, history.consecutiveSkips);
  if (plausible.status === "skipped") {
    stats.scan_status = "skipped";
    stats.skipped_reason = plausible.reason;
    await withD1Retry(
      () => finishScanStmt(env.DB, scanId, "skipped", { scripts: diff.observed.length, hosts: scriptHosts.size, error: plausible.reason }).run(),
      WRITE_RETRY,
    );
    return stats;
  }

  const contacted = diffContactedHosts(raw.requests, knownHosts, { canonicalDomain: brand.host, pageUrl, baseline });
  stats.contacted_hosts = contacted.observed.length;
  // A new script host is already `new_host`; `new_contacted_host` is for the
  // endpoints a page talks to without loading code from them (exfil, beacons).
  const contactedFindings = contacted.findings.filter((f) => !scriptHosts.has(f.host));

  // ── IOC match (read replica; values bound, ≤ 90 per statement) ──
  const candidates: IocCandidate[] = [];
  const externalScripts = diff.observed.filter((o) => !o.is_inline && o.url);
  const urlMatches = await matchUrlsAgainstThreats(readDb, externalScripts.map((o) => o.url!));
  for (const m of urlMatches) {
    const o = externalScripts.find((s) => s.url === m.matched_value || s.url?.split("?")[0] === m.matched_value.split("?")[0]);
    candidates.push({ match: m, source: "script_url", url: o?.url ?? m.matched_value, path_norm: o?.path_norm ?? normaliseScriptUrl(m.matched_value)?.path_norm ?? null, page_url: o?.page_url ?? pageUrl });
  }
  const contactedExternal = contacted.observed.filter((c) => !c.is_first_party);
  const hostMatches = await matchHostsAgainstThreats(readDb, [...new Set([...scriptHosts, ...contactedExternal.map((c) => c.host)])]);
  for (const m of hostMatches) {
    const script = externalScripts.find((s) => s.host === m.host && !s.is_first_party);
    if (script) {
      candidates.push({ match: m, source: "script_host", url: script.url, path_norm: null, page_url: script.page_url ?? pageUrl });
      continue;
    }
    const c = contactedExternal.find((x) => x.host === m.host);
    candidates.push({ match: m, source: "contacted_host", url: c?.first_url ?? null, path_norm: null, page_url: c?.page_url ?? pageUrl, initiator_url: c?.initiator_url ?? null });
  }
  const sourceFeeds = candidates.length ? await readSourceFeeds(readDb, candidates.map((c) => c.match.threat_id)) : new Map<string, string | null>();
  const iocFindings = buildIocFindings(candidates, sourceFeeds);
  stats.ioc_matches = iocFindings.length;

  const findings = [...diff.findings, ...contactedFindings, ...iocFindings];
  stats.findings_found = findings.length;

  // ── Persist (env.DB, atomic batches; the scan completes last) ──
  const ts = d1Ts(clock());
  const findingStmts = findings.map((f) =>
    env.DB.prepare(INSERT_FINDING_SQL).bind(
      `ssf_${crypto.randomUUID()}`,
      brand.id,
      scanId,
      f.kind,
      f.host,
      f.path_norm,
      clip(f.page_url, SITE_SCRIPT_EVIDENCE_URL_MAX),
      f.threat_id,
      findingDedupeKey(f),
      clip(JSON.stringify(f.evidence), MAX_EVIDENCE_JSON),
      ts,
    ),
  );
  const inventoryStmts = diff.observed.map((o) =>
    env.DB.prepare(UPSERT_INVENTORY_SQL).bind(
      brand.id,
      o.host,
      o.path_norm,
      o.is_first_party ? 1 : 0,
      o.is_inline ? 1 : 0,
      ts,
      ts,
      clip(o.page_url, SITE_SCRIPT_EVIDENCE_URL_MAX),
      o.sha256,
      o.integrity ?? null,
      o.integrity !== undefined ? 1 : 0,
    ),
  );
  const contactedStmts = contacted.observed.map((c) =>
    env.DB.prepare(UPSERT_CONTACTED_SQL).bind(brand.id, c.host, ts, ts, c.request_count, c.initiator_host, c.initiator_path),
  );
  const completeStmt = finishScanStmt(env.DB, scanId, "complete", {
    scripts: diff.observed.length,
    hosts: scriptHosts.size,
    error: notes.length ? notes.join("; ") : null,
  });
  const results = await runBatches(env.DB, [...findingStmts, ...inventoryStmts, ...contactedStmts, completeStmt], Math.max(deadline, Date.now() + 30_000));
  for (let i = 0; i < findingStmts.length; i++) {
    if ((results[i]?.meta?.changes ?? 0) > 0) {
      stats.findings_inserted++;
      const k = findings[i]!.kind;
      stats.by_kind[k] = (stats.by_kind[k] ?? 0) + 1;
    }
  }
  stats.scan_status = "complete";
  stats.bodies_hashed = raw.bodiesHashed;
  stats.bodies_skipped = raw.bodiesSkipped;
  stats.data_blocks = diff.data_blocks;
  stats.rejected = diff.rejected + contacted.rejected;
  return stats;
}

/** Telemetry-only completion event (target_agent NULL — no dispatch). */
export async function emitSiteScriptEvent(
  env: Pick<Env, "DB">,
  runId: string,
  stats: SiteScriptRunStats | null,
  error: string | null = null,
): Promise<void> {
  try {
    await withD1Retry(
      () =>
        env.DB.prepare(
          `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
           VALUES (?, 'site_scripts_scanned', 'site_script_watch', NULL, ?, 3, 'pending')`,
        )
          .bind(
            crypto.randomUUID(),
            JSON.stringify(
              stats
                ? {
                    run_id: runId,
                    skipped: stats.skipped,
                    brand_id: stats.brand_id,
                    scan_id: stats.scan_id,
                    scan_status: stats.scan_status,
                    baseline: stats.baseline,
                    scripts: stats.scripts,
                    script_hosts: stats.script_hosts,
                    contacted_hosts: stats.contacted_hosts,
                    findings_found: stats.findings_found,
                    findings_inserted: stats.findings_inserted,
                    by_kind: stats.by_kind,
                    ioc_matches: stats.ioc_matches,
                    reaped: stats.reaped,
                    swept: stats.sweep,
                    error,
                  }
                : { run_id: runId, error },
            ),
          )
          .run(),
      WRITE_RETRY,
    );
  } catch (err) {
    console.warn(`[site-script-watch] agent_events emit failed: ${msg(err)}`);
  }
}
