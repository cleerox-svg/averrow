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
//                   hosting, no non-failed site_scans row in the last
//                   SITE_SCAN_INTERVAL_HOURS and no scan at all in the last
//                   SITE_SCAN_FAILED_RETRY_HOURS; never-scanned first, then
//                   oldest scan first. Derived from site_scans (no new column).
//   2. pre-check  — the SSRF / DNS guard on https://<canonical_domain>/. A
//                   refusal is a SITE failure: claimed + failed (below).
//   3. session    — open the browser session BEFORE claiming. An infra
//                   failure here (Browser Rendering down / over its session
//                   limit) claims nothing and ends the run degraded, so it
//                   never burns the brand's slot.
//   4. claim      — INSERT a `running` site_scans row guarded by the same
//                   due predicate, so two overlapping runs cannot scan one
//                   brand twice.
//   5. render     — https://<canonical_domain>/ under a hard timeout. A
//                   site-level failure (navigation error / timeout, refused
//                   redirect) marks the scan `failed`; a failed scan is retried
//                   after SITE_SCAN_FAILED_RETRY_HOURS (1 h), not the 6 h
//                   interval — failures are mostly transient and the customer
//                   tier is small, so an hourly retry costs little; a site that
//                   fails every time is retried hourly (≤ 24 renders a day).
//   6. decide     — baseline = no earlier `complete` scan (isBaselineScan);
//                   implausibly small scan → `skipped` (assessScanPlausibility):
//                   no inventory / contacted-host write and no diff findings,
//                   but its IOC matches ARE recorded (step 8).
//   7. diff       — diffSiteScan (scripts) + diffContactedHosts (requests).
//   8. IOC match  — script hosts + contacted hosts (matchHostsAgainstThreats)
//                   and script URLs (matchUrlsAgainstThreats) against ACTIVE
//                   threats → `ioc_match` (also on a baseline or skipped scan:
//                   a site that loads a known-bad host is a finding however
//                   the rest of the scan looks).
//   9. persist    — findings (INSERT … ON CONFLICT on the open-dedupe index DO
//                   NOTHING), inventory + contacted-host upserts and the scan
//                   completion, in atomic D1 batches retried past the overload
//                   window, findings FIRST and the completion LAST. Writes on
//                   env.DB; reads on a read session. Stored URLs keep param
//                   names but drop values (redactEvidenceUrl).
// Anything that throws after the claim marks the scan `failed` with the real
// error and is rethrown (agent_runs records it). A write that fails half way
// can leave part of the inventory behind, which is safe because:
//   - the baseline decision reads only an earlier COMPLETE scan, never the
//     inventory, so a baseline that died mid-write is simply re-run as a
//     baseline (its partial inventory is ignored by the baseline diff);
//   - findings are written before the inventory, so any inventory row a
//     failed non-baseline scan left behind already has its finding stored.
// Plus: a reaper for `running` rows a dead worker left behind, and a
// once-a-day retention sweep (UTC hour 0, hour-only gate, KV day stamp).
//
// No AI. No alerts / notifications yet (later PR) — findings are the output.

import type { D1Database, D1DatabaseSession, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../types";
import { getReadSession } from "./db";
import { D1_OVERLOAD_RETRY_BASE_MS, withD1Retry, type D1RetryOptions } from "./d1-retry";
import { d1Ts, makeNavigationGuard, runWithHardTimeout, type NavigationGuard } from "./page-capture";
import type { FetchDeps } from "./page-fetch";
import { TRUSTED_BRAND_CANONICAL_SQL, isUnderSharedHosting } from "./safeDomains";
import {
  SITE_SCRIPT_EVIDENCE_URL_MAX,
  assessScanPlausibility,
  diffContactedHosts,
  diffSiteScan,
  findingDedupeKey,
  isBaselineScan,
  matchHostsAgainstThreats,
  matchUrlsAgainstThreats,
  normaliseScriptUrl,
  redactEvidenceUrl,
  toAsciiHost,
  SCAN_SKIP_ACCEPT_AFTER,
  type ContactedRequest,
  type InventoryRow,
  type ObservedContactedHost,
  type ObservedScript,
  type ScannedScript,
  type SiteScriptFinding,
  type SiteScriptFindingEvidence,
  type SiteScriptFindingKind,
  type ThreatMatch,
} from "./site-script-watch";

// ─── Tunables ────────────────────────────────────────────────────────

/** A brand is due when it has no non-failed site_scans row this recent. */
export const SITE_SCAN_INTERVAL_HOURS = 6;
/** …and no scan at all this recent: a failed scan is retried after 1 h. */
export const SITE_SCAN_FAILED_RETRY_HOURS = 1;
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
const WRITE_RETRY: D1RetryOptions = { retries: 3, overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS, label: "site_script_watch" };
/** Manual (in-request) runs keep the short default backoff, like executeAgent's 'manual' finalize. */
const WRITE_RETRY_SHORT: D1RetryOptions = { retries: 3, label: "site_script_watch" };

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
  /** Distinct contacted hosts not recorded (SITE_SCAN_MAX_CONTACTED_HOSTS). */
  contactedHostsDropped: number;
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

/**
 * Absolute end (epoch ms) of the site scan's share of a `*\/10` invocation:
 * scheduledTime + SITE_SCRIPT_TICK_WINDOW_MS. The cron branch passes it as
 * the run's deadline (not a relative budget, which would start counting
 * only when the agent starts and drift past the window by executeAgent's
 * own bookkeeping). Pure.
 */
export function siteScriptTickDeadlineMs(scheduledTimeMs: number): number {
  return scheduledTimeMs + SITE_SCRIPT_TICK_WINDOW_MS;
}

// ─── Due brand + claim ───────────────────────────────────────────────

export interface DueBrand {
  id: string;
  canonical_domain: string;
  last_scan_at: string | null;
}

/**
 * Customer-tier brands with a trusted canonical domain, no non-failed scan
 * inside the interval and no scan at all inside the failed-retry window,
 * never-scanned first, then oldest scan. idx_brands_tier narrows to
 * the customer tier; the correlated reads seek idx_site_scans_brand_scanned.
 */
export const DUE_BRANDS_SQL =
  `SELECT b.id AS id, b.canonical_domain AS canonical_domain,
          (SELECT MAX(s.scanned_at) FROM site_scans s WHERE s.brand_id = b.id) AS last_scan_at
     FROM brands b
    WHERE b.tier = 'customer'
      AND b.canonical_domain IS NOT NULL AND b.canonical_domain <> ''
      AND (${TRUSTED_BRAND_CANONICAL_SQL}) = 1
      AND NOT EXISTS (SELECT 1 FROM site_scans r WHERE r.brand_id = b.id AND r.scanned_at >= ? AND r.status <> 'failed')
      AND NOT EXISTS (SELECT 1 FROM site_scans f WHERE f.brand_id = b.id AND f.scanned_at >= ?)
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

function dueCutoffs(now: Date): [string, string] {
  return [
    d1Ts(addMs(now, -SITE_SCAN_INTERVAL_HOURS * 3_600_000)),
    d1Ts(addMs(now, -SITE_SCAN_FAILED_RETRY_HOURS * 3_600_000)),
  ];
}

export async function pickDueBrand(db: D1Database | D1DatabaseSession, now: Date): Promise<(DueBrand & { host: string }) | null> {
  const [cutoff, failedCutoff] = dueCutoffs(now);
  const res = await db.prepare(DUE_BRANDS_SQL).bind(cutoff, failedCutoff, DUE_CANDIDATES).all<DueBrand>();
  for (const b of res.results ?? []) {
    const host = scannableCanonicalHost(b.canonical_domain);
    if (host) return { ...b, host };
  }
  return null;
}

/** Claim: insert the `running` row only if the brand is still due (same predicate as DUE_BRANDS_SQL). */
export async function claimScan(
  db: D1Database,
  scanId: string,
  brandId: string,
  url: string,
  now: Date,
  retry: D1RetryOptions = WRITE_RETRY,
): Promise<boolean> {
  const [cutoff, failedCutoff] = dueCutoffs(now);
  const res = await withD1Retry(
    () =>
      db
        .prepare(
          `INSERT INTO site_scans (id, brand_id, url, status, scanned_at)
           SELECT ?, ?, ?, 'running', ?
            WHERE NOT EXISTS (SELECT 1 FROM site_scans WHERE brand_id = ? AND scanned_at >= ? AND status <> 'failed')
              AND NOT EXISTS (SELECT 1 FROM site_scans WHERE brand_id = ? AND scanned_at >= ?)`,
        )
        .bind(scanId, brandId, url, d1Ts(now), brandId, cutoff, brandId, failedCutoff)
        .run(),
    retry,
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

export interface IocCandidate {
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
export function buildIocFindings(candidates: IocCandidate[]): SiteScriptFinding[] {
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
      source_feed: c.match.source_feed ?? null,
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
async function runBatches(
  db: D1Database,
  stmts: D1PreparedStatement[],
  deadline: number,
  retry: D1RetryOptions = WRITE_RETRY,
): Promise<Array<{ meta?: { changes?: number } }>> {
  const out: Array<{ meta?: { changes?: number } }> = [];
  for (let i = 0; i < stmts.length; i += SITE_SCAN_WRITE_BATCH) {
    const chunk = stmts.slice(i, i + SITE_SCAN_WRITE_BATCH);
    const res = await withD1Retry(() => db.batch(chunk), { ...retry, deadline });
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
  /** Open findings older than SITE_FINDING_RETENTION_DAYS moved to `expired`. */
  expired: number;
}

const emptySweep = (): SiteScriptSweepResult => ({ ran: false, scans: 0, contacted: 0, findings: 0, inventory: 0, expired: 0 });

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
 *   site_script_findings  CLOSED and created > 180 days. Then OPEN findings
 *                         created > 180 days are set `expired` (age cap: an
 *                         untriaged finding cannot live forever), so the next
 *                         day's delete removes them. Moving a row OUT of
 *                         'open' can never collide with the open-dedupe unique
 *                         index (it covers status = 'open' only), and frees
 *                         the key: a still-live condition opens a fresh row.
 *   site_script_inventory last_seen > 90 days (a returning script is new again)
 *
 * The inventory can age out while the brand's latest complete scan is kept
 * (a brand whose scans were all failed / skipped for 90 days): the next
 * complete scan is then NOT a baseline and diffs against a pruned inventory,
 * so returning scripts / hosts are reported as new. That errs toward
 * over-reporting, never toward silently trusting a compromised page.
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
  // After the delete, so an expired row stays visible for a day.
  // idx_site_script_findings_open (partial on status = 'open') serves the scan.
  const expired = await sweepRounds(
    db,
    `UPDATE site_script_findings SET status = 'expired' WHERE rowid IN (
       SELECT rowid FROM site_script_findings WHERE status = 'open' AND created_at < ? LIMIT ?)`,
    days(SITE_FINDING_RETENTION_DAYS),
  );
  return { ran: true, scans, contacted, findings, inventory, expired };
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
  /**
   * Absolute wall-clock end of this run (epoch ms). Cron: the tick's
   * siteScriptTickDeadlineMs(scheduledTime). Default: now +
   * SITE_SCAN_MIN_BUDGET_MS (manual runs).
   */
  deadlineMs?: number;
  /** Manual / in-request run: short D1 write retry instead of the overload backoff. */
  manual?: boolean;
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

/** `skipped` value of a run whose browser session could not be opened (infra, nothing claimed). */
export const SITE_SCAN_BROWSER_UNAVAILABLE = "browser_unavailable";

export async function runSiteScriptWatch(env: Env, opts: SiteScriptRunOptions = {}): Promise<SiteScriptRunStats> {
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock();
  const stats = newStats();
  const retry = opts.manual ? WRITE_RETRY_SHORT : WRITE_RETRY;

  // Clean no-op without Browser Rendering (staging / dev / tests).
  if (!env.BROWSER && !opts.driver) {
    stats.skipped = "bindings_absent:BROWSER";
    return stats;
  }

  // One clock read: with no deadline passed (manual runs) a second Date.now()
  // a millisecond later made `deadline - now` fall just under the minimum and
  // skipped the run as "budget" at random.
  const nowMs = Date.now();
  const deadline = opts.deadlineMs ?? nowMs + SITE_SCAN_MIN_BUDGET_MS;
  if (deadline - nowMs < SITE_SCAN_MIN_BUDGET_MS) {
    stats.skipped = "budget";
    return stats;
  }

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

  // A slow sweep must not push the scan past the deadline.
  if (deadline - Date.now() < SITE_SCAN_PAGE_TIMEOUT_MS + SITE_SCAN_WRITE_MARGIN_MS / 2) {
    stats.skipped = "budget";
    return stats;
  }

  // ── 1. Due brand ──
  const readDb = opts.readDb ?? getReadSession(env, { bookmark: null });
  const brand = await pickDueBrand(readDb, startedAt);
  if (!brand) {
    stats.skipped = "no_due_brand";
    return stats;
  }
  stats.brand_id = brand.id;
  const targetUrl = `https://${brand.host}/`;
  const scanId = `ssc_${crypto.randomUUID()}`;

  const fail = async (error: string): Promise<SiteScriptRunStats> => {
    stats.scan_status = "failed";
    stats.scan_error = clip(error, MAX_ERROR);
    await withD1Retry(() => finishScanStmt(env.DB, scanId, "failed", { error }).run(), retry);
    return stats;
  };
  const claim = async (): Promise<boolean> => {
    if (!(await claimScan(env.DB, scanId, brand.id, targetUrl, startedAt, retry))) {
      stats.skipped = "claimed_elsewhere";
      return false;
    }
    stats.scan_id = scanId;
    return true;
  };

  // ── 2. DNS / SSRF pre-check (a refusal is the SITE's: claim + fail) ──
  const guard = makeNavigationGuard(opts.resolve);
  const pre = await guard(targetUrl);
  if (!pre.ok) {
    if (!(await claim())) return stats;
    return guarded(stats, fail, () => fail(`refused target: ${pre.reason}`));
  }

  // ── 3. Browser session BEFORE the claim (infra failure burns no slot) ──
  let session: SiteScanSession;
  try {
    let driver = opts.driver;
    if (!driver) {
      const { puppeteerSiteScanDriver } = await import("./site-script-browser");
      driver = puppeteerSiteScanDriver(env.BROWSER!);
    }
    session = await driver.open();
  } catch (err) {
    stats.skipped = SITE_SCAN_BROWSER_UNAVAILABLE;
    stats.browser_error = clip(`browser session unavailable: ${msg(err)}`, MAX_ERROR);
    return stats;
  }
  let open = true;
  const closeSession = async (): Promise<void> => {
    if (!open) return;
    open = false;
    try {
      await session.close();
    } catch { /* already gone */ }
  };

  try {
    // ── 4. Claim ──
    if (!(await claim())) return stats;
    // ── 5-9. Everything after the claim: any throw marks the scan failed. ──
    return await guarded(stats, fail, () =>
      scanAndPersist(env, { stats, brand, scanId, targetUrl, guard, session, closeSession, readDb, deadline, retry, clock, fail }),
    );
  } finally {
    await closeSession();
  }
}

/**
 * Run `work` after a successful claim: a throw marks the scan `failed` with
 * the real error (a no-op if it already finished — finishScanStmt only moves
 * a `running` row) and is rethrown for agent_runs.error_message.
 */
async function guarded(
  stats: SiteScriptRunStats,
  fail: (error: string) => Promise<SiteScriptRunStats>,
  work: () => Promise<SiteScriptRunStats>,
): Promise<SiteScriptRunStats> {
  try {
    return await work();
  } catch (err) {
    try {
      await fail(msg(err));
    } catch (failErr) {
      stats.fail_write_error = msg(failErr);
    }
    throw err;
  }
}

interface ScanContext {
  stats: SiteScriptRunStats;
  brand: DueBrand & { host: string };
  scanId: string;
  targetUrl: string;
  guard: NavigationGuard;
  session: SiteScanSession;
  closeSession: () => Promise<void>;
  readDb: D1Database | D1DatabaseSession;
  deadline: number;
  retry: D1RetryOptions;
  clock: () => Date;
  fail: (error: string) => Promise<SiteScriptRunStats>;
}

async function scanAndPersist(env: Env, c: ScanContext): Promise<SiteScriptRunStats> {
  const { stats, brand, scanId, readDb, retry, fail } = c;

  // ── Render (site-level failures → failed scan, not a thrown run) ──
  let raw: RawSiteScan;
  try {
    raw = await runWithHardTimeout(
      (signal) => c.session.scan({ targetUrl: c.targetUrl, timeoutMs: SITE_SCAN_PAGE_TIMEOUT_MS, guard: c.guard, signal }),
      SITE_SCAN_PAGE_TIMEOUT_MS,
      "site scan",
    );
  } catch (err) {
    return await fail(msg(err));
  } finally {
    await c.closeSession();
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
  const contacted = diffContactedHosts(raw.requests, knownHosts, { canonicalDomain: brand.host, pageUrl, baseline });
  stats.contacted_hosts = contacted.observed.length;

  const notes: string[] = [];
  if (raw.hostCapHit) notes.push("host cap reached: later new-host requests were blocked");
  if (raw.contactedHostsDropped > 0) notes.push(`${raw.contactedHostsDropped} contacted hosts over the cap not recorded`);
  if (raw.inlineCut > 0) notes.push(`${raw.inlineCut} inline scripts over the size cap not inventoried`);
  if (inventory.length >= SITE_SCAN_INVENTORY_READ_LIMIT) notes.push("inventory read truncated");

  // ── IOC match (read replica; values bound, ≤ 90 per statement). Runs on
  // every scan that rendered — a skipped (implausibly small) scan included. ──
  const iocFindings = await matchIocs(readDb, diff.observed, contacted.observed, scriptHosts, pageUrl);
  stats.ioc_matches = iocFindings.length;

  const plausible = assessScanPlausibility(diff.observed.length, history.previousCompleteScripts, history.consecutiveSkips);
  const skipped = plausible.status === "skipped";
  // A new script host is already `new_host`; `new_contacted_host` is for the
  // endpoints a page talks to without loading code from them (exfil, beacons).
  const contactedFindings = contacted.findings.filter((f) => !scriptHosts.has(f.host));
  // Skipped: only the IOC matches — no diff findings, no inventory writes.
  const findings = skipped ? iocFindings : [...diff.findings, ...contactedFindings, ...iocFindings];
  stats.findings_found = findings.length;

  // ── Persist (env.DB, atomic batches; findings first, the scan finishes last) ──
  const ts = d1Ts(c.clock());
  const findingStmts = findings.map((f) =>
    env.DB.prepare(INSERT_FINDING_SQL).bind(
      `ssf_${crypto.randomUUID()}`,
      brand.id,
      scanId,
      f.kind,
      f.host,
      f.path_norm,
      redactEvidenceUrl(f.page_url),
      f.threat_id,
      findingDedupeKey(f),
      clip(JSON.stringify(redactEvidence(f.evidence)), MAX_EVIDENCE_JSON),
      ts,
    ),
  );
  const inventoryStmts = skipped
    ? []
    : diff.observed.map((o) =>
        env.DB.prepare(UPSERT_INVENTORY_SQL).bind(
          brand.id,
          o.host,
          o.path_norm,
          o.is_first_party ? 1 : 0,
          o.is_inline ? 1 : 0,
          ts,
          ts,
          redactEvidenceUrl(o.page_url),
          o.sha256,
          o.integrity ?? null,
          o.integrity !== undefined ? 1 : 0,
        ),
      );
  const contactedStmts = skipped
    ? []
    : contacted.observed.map((h) =>
        env.DB.prepare(UPSERT_CONTACTED_SQL).bind(brand.id, h.host, ts, ts, h.request_count, h.initiator_host, h.initiator_path),
      );
  const finishStmt = skipped
    ? finishScanStmt(env.DB, scanId, "skipped", { scripts: diff.observed.length, hosts: scriptHosts.size, error: plausible.reason })
    : finishScanStmt(env.DB, scanId, "complete", {
        scripts: diff.observed.length,
        hosts: scriptHosts.size,
        error: notes.length ? notes.join("; ") : null,
      });
  const results = await runBatches(
    env.DB,
    [...findingStmts, ...inventoryStmts, ...contactedStmts, finishStmt],
    Math.max(c.deadline, Date.now() + 30_000),
    retry,
  );
  for (let i = 0; i < findingStmts.length; i++) {
    if ((results[i]?.meta?.changes ?? 0) > 0) {
      stats.findings_inserted++;
      const k = findings[i]!.kind;
      stats.by_kind[k] = (stats.by_kind[k] ?? 0) + 1;
    }
  }
  stats.scan_status = skipped ? "skipped" : "complete";
  if (skipped) stats.skipped_reason = plausible.reason;
  stats.bodies_hashed = raw.bodiesHashed;
  stats.bodies_skipped = raw.bodiesSkipped;
  stats.data_blocks = diff.data_blocks;
  stats.rejected = diff.rejected + contacted.rejected;
  return stats;
}

/** Evidence with every stored URL redacted (redactEvidenceUrl). */
export function redactEvidence(e: SiteScriptFindingEvidence): SiteScriptFindingEvidence {
  const out: SiteScriptFindingEvidence = { ...e, url: redactEvidenceUrl(e.url) };
  if (e.initiator_url !== undefined) out.initiator_url = redactEvidenceUrl(e.initiator_url);
  return out;
}

async function matchIocs(
  readDb: D1Database | D1DatabaseSession,
  observed: readonly ObservedScript[],
  contactedObserved: readonly ObservedContactedHost[],
  scriptHosts: ReadonlySet<string>,
  pageUrl: string,
): Promise<SiteScriptFinding[]> {
  const candidates: IocCandidate[] = [];
  const externalScripts = observed.filter((o) => !o.is_inline && o.url);
  const urlMatches = await matchUrlsAgainstThreats(readDb, externalScripts.map((o) => o.url!));
  for (const m of urlMatches) {
    const o = externalScripts.find((s) => s.url === m.matched_value || s.url?.split("?")[0] === m.matched_value.split("?")[0]);
    candidates.push({
      match: m,
      source: "script_url",
      url: o?.url ?? m.matched_value,
      path_norm: o?.path_norm ?? normaliseScriptUrl(m.matched_value)?.path_norm ?? null,
      page_url: o?.page_url ?? pageUrl,
    });
  }
  const contactedExternal = contactedObserved.filter((h) => !h.is_first_party);
  const hostMatches = await matchHostsAgainstThreats(readDb, [...new Set([...scriptHosts, ...contactedExternal.map((h) => h.host)])]);
  for (const m of hostMatches) {
    const script = externalScripts.find((s) => s.host === m.host && !s.is_first_party);
    if (script) {
      candidates.push({ match: m, source: "script_host", url: script.url, path_norm: null, page_url: script.page_url ?? pageUrl });
      continue;
    }
    const h = contactedExternal.find((x) => x.host === m.host);
    candidates.push({
      match: m,
      source: "contacted_host",
      url: h?.first_url ?? null,
      path_norm: null,
      page_url: h?.page_url ?? pageUrl,
      initiator_url: h?.initiator_url ?? null,
    });
  }
  return buildIocFindings(candidates);
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
