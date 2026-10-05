/**
 * NRD archive back-check — recover the NRD match of a domain that became
 * matchable AFTER its NRD listing was ingested.
 *
 * ── Why ─────────────────────────────────────────────────────────────
 *
 * feeds/nrd_hagezi.ts stores in `nrd_domains` only the new NRDs that equal a
 * `lookalike_domains` / `phantom_domains` domain AT INGEST (NRD_INSERT_SQL);
 * every new NRD goes to the NRD_ARCHIVE R2 bucket. A permutation the
 * lookalike seeder creates later (agents/lookalike-scanner.ts seeds BEFORE it
 * runs lib/lookalike-nrd-matcher.ts) — or a phantom enumerated later — would
 * therefore never see its NRD row. When the feed stored every NRD, such a
 * row was still in D1 and the hourly matcher claimed it.
 *
 * ── What ────────────────────────────────────────────────────────────
 *
 * The seeders hand this module the domains they JUST inserted (a small set,
 * ~hundreds). It lists the archive's `daily/<date>/` prefixes for the last
 * NRD_BACKCHECK_DAYS UTC dates (yesterday back; the feed's registered_date
 * is never today), OLDEST FIRST, stream-gunzips each object and tests every
 * line against that Set. Archive lines are the feed's stored form (trimmed +
 * lowercased), and the seeded domains are the raw stored strings, so the
 * test is the matchers' own `=`. A hit is stored with storeNrdReference
 * (INSERT OR IGNORE, same EXISTS filter) under the object's date prefix as
 * `registered_date`; `created_at` defaults to now, so it sits above the
 * lookalike matcher's keyset cursor and the phantom matcher's incremental
 * cursor and is picked up on their next run — for the scanner, the SAME run.
 * Oldest first + a found domain leaves the Set, so the earliest listing
 * wins and the scan stops once every domain is found.
 *
 * ── Bounds ──────────────────────────────────────────────────────────
 *
 *   * Skipped (no R2 traffic) when no domains were seeded, or NRD_ARCHIVE
 *     is unbound (logged).
 *   * At most NRD_BACKCHECK_MAX_DOMAINS distinct domains per call.
 *   * Soft wall-clock cap (checked per stream chunk): on expiry it stops,
 *     stores what it found, and reports `timed_out`. A domain whose listing
 *     was not reached is NOT retried later (no queue) — it is reported.
 *   * NRDs listed more than NRD_BACKCHECK_DAYS ago are not recovered.
 *   * Reads: one R2 list per date (+ pagination) and one GET per object
 *     (~1 per daily build, ~3 MB gzip / ~443K lines). D1: one filtered
 *     insert per date with hits — no D1 reads beyond the insert's probes.
 *
 * NEVER THROWS: the lookalike scanner and phantom enumerator must not fail
 * on archive problems. A per-object error is counted and the scan moves on;
 * anything else is caught into `error`.
 */

import type { Env } from "../types";
import { NRD_ARCHIVE_PREFIX, storeNrdReference } from "./nrd-store";
import { logger } from "./logger";

/** UTC dates (yesterday back) whose archive objects are scanned. */
export const NRD_BACKCHECK_DAYS = 8;

/** Soft wall-clock cap per call. */
export const NRD_BACKCHECK_SOFT_CAP_MS = 20_000;

/** Distinct domains checked per call (a seeder tick is ~hundreds). */
export const NRD_BACKCHECK_MAX_DOMAINS = 10_000;

export type NrdBackcheckSource = "lookalike" | "phantom";

export interface NrdBackcheckResult {
  source: NrdBackcheckSource;
  /** Distinct domains checked (after the cap). */
  domains: number;
  /** Input domains beyond NRD_BACKCHECK_MAX_DOMAINS, not checked. */
  domains_dropped: number;
  objects_scanned: number;
  lines_scanned: number;
  /** Domains found in the archive. */
  hits: number;
  /** nrd_domains rows inserted (0 for a hit already present). */
  stored: number;
  /** The soft cap stopped the scan before every object was read. */
  timed_out: boolean;
  object_errors: number;
  skipped: "no_domains" | "archive_unbound" | null;
  error: string | null;
  duration_ms: number;
}

export interface NrdBackcheckOptions {
  /** Clock injection (tests). */
  now?: () => number;
  softCapMs?: number;
  days?: number;
}

/** `YYYY-MM-DD` of the UTC date `offset` days before `ms`. */
function utcDate(ms: number, offset: number): string {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor });
    for (const o of page.objects) keys.push(o.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return keys.sort();
}

/**
 * Stream one gzip'd, newline-separated archive object and move every line
 * found in `wanted` into `found`. Returns false when the deadline hit.
 */
async function scanObject(
  body: R2ObjectBody["body"],
  wanted: Set<string>,
  found: string[],
  deadline: () => boolean,
  counters: { lines: number },
): Promise<boolean> {
  const reader = body
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buf = "";
  const test = (line: string): void => {
    counters.lines++;
    const d = line.trim();
    if (wanted.has(d)) {
      wanted.delete(d);
      found.push(d);
    }
  };
  try {
    for (;;) {
      if (deadline()) return false;
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) test(line);
      if (wanted.size === 0) return true;
    }
    if (buf.length > 0) test(buf);
    return true;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** Check freshly seeded domains against the recent NRD archive. Never throws. */
export async function runNrdArchiveBackcheck(
  env: Env,
  domains: Iterable<string>,
  source: NrdBackcheckSource,
  opts: NrdBackcheckOptions = {},
): Promise<NrdBackcheckResult> {
  const now = opts.now ?? Date.now;
  const softCapMs = opts.softCapMs ?? NRD_BACKCHECK_SOFT_CAP_MS;
  const days = Math.max(1, Math.floor(opts.days ?? NRD_BACKCHECK_DAYS));
  const start = now();

  const wanted = new Set<string>();
  let dropped = 0;
  for (const d of domains) {
    if (wanted.has(d)) continue;
    if (wanted.size >= NRD_BACKCHECK_MAX_DOMAINS) { dropped++; continue; }
    wanted.add(d);
  }

  const result: NrdBackcheckResult = {
    source,
    domains: wanted.size,
    domains_dropped: dropped,
    objects_scanned: 0,
    lines_scanned: 0,
    hits: 0,
    stored: 0,
    timed_out: false,
    object_errors: 0,
    skipped: null,
    error: null,
    duration_ms: 0,
  };
  const done = (): NrdBackcheckResult => {
    result.duration_ms = now() - start;
    logger.info("nrd_archive_backcheck", { ...result });
    return result;
  };

  if (wanted.size === 0) {
    result.skipped = "no_domains";
    result.duration_ms = now() - start;
    return result;
  }
  const bucket = env.NRD_ARCHIVE;
  if (!bucket) {
    result.skipped = "archive_unbound";
    logger.warn("nrd_archive_backcheck_skipped", { reason: "NRD_ARCHIVE binding not configured", source, domains: wanted.size });
    return done();
  }
  if (dropped > 0) {
    logger.warn("nrd_archive_backcheck_truncated", { source, checked: wanted.size, dropped });
  }

  const deadline = (): boolean => now() - start >= softCapMs;
  const counters = { lines: 0 };

  try {
    // Oldest first: the earliest listing's date wins (INSERT OR IGNORE, and
    // a found domain leaves `wanted`).
    dates: for (let offset = days; offset >= 1; offset--) {
      const date = utcDate(start, offset);
      if (deadline()) { result.timed_out = true; break; }
      const keys = await listKeys(bucket, `${NRD_ARCHIVE_PREFIX}${date}/`);
      for (const key of keys) {
        if (deadline()) { result.timed_out = true; break dates; }
        const found: string[] = [];
        let completed = true;
        try {
          const obj = await bucket.get(key);
          if (!obj) continue; // deleted between list and get
          completed = await scanObject(obj.body, wanted, found, deadline, counters);
          result.objects_scanned++;
        } catch (err) {
          result.object_errors++;
          logger.warn("nrd_archive_backcheck_object_failed", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (found.length > 0) {
          result.hits += found.length;
          result.stored += await storeNrdReference(env.DB, found, date);
        }
        if (!completed) { result.timed_out = true; break dates; }
        if (wanted.size === 0) break dates;
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logger.warn("nrd_archive_backcheck_failed", { source, error: result.error });
  }
  result.lines_scanned = counters.lines;
  return done();
}
