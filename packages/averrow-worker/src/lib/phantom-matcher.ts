/**
 * Phantom-domain MATCHERS — Wave 2, Task W2.3 (spec §6 hit semantics + §7
 * match constraint).
 *
 * A "phantom" is a domain an LLM is likely to *hallucinate* for a brand.
 * The `phantom_enumerator` agent (W2.2) writes these as inert PREDICTIONS
 * at status='predicted' — no threat, no alert. This module detects when a
 * predicted phantom actually appears in the real world (an independent
 * NRD registration / CT issuance / lookalike activation) and flips it to
 * status='registered', raising at most one monitoring-severity alert.
 *
 * THE GOVERNING INVARIANT (spec §0/§6): a phantom becomes actionable ONLY
 * on a later independent observation. This module NEVER inserts into
 * `threats` — it only flips the phantom row and (per hit) creates at most
 * one `low`-severity alert reusing an existing alert_type. There is
 * deliberately no import of anything that writes `threats`.
 *
 * POST-PASS, NOT INLINE (spec §7 — hard constraint): this runs as a
 * set-based SQL join AFTER ingestion, dispatched from an idempotent
 * admin/internal endpoint. It is NEVER called inside a feed pull's hot
 * loop (nrd_hagezi runNrdMatch / the CertStream handler / the lookalike
 * scanner) — inline work there risks the pull's wall-clock budget → the
 * reaper → applyReapPenalty → the feed circuit-breaker auto-pause
 * (CLAUDE.md §6). The join is driven from the small `phantom_domains`
 * side (idx_phantom_domain), so its cost is bounded by the predicted
 * phantom count, not the millions of rows in nrd_domains.
 *
 * At-most-once / idempotency (spec §6.4): the alert-creating transition is
 * a guarded `WHERE id=? AND status='predicted'` UPDATE that claims the row
 * BEFORE the alert is created. A second matcher pass (or a different source
 * hitting the same phantom) finds status='registered', the claim matches 0
 * rows, and no second createAlert runs. Claiming first also means a
 * lost-claim never leaves an orphan alert.
 *
 * Read budget (spec §7): each source keeps an incremental KV cursor keyed
 * on its natural time column (registered_date / not_before / created_at)
 * so a normal run scans only rows newer than the last run — same
 * discipline as the dns-queue reconciler. `full` ignores + does not
 * advance the cursor, for an operator's catch-up sweep (e.g. right after a
 * fresh enumeration, to match phantoms enumerated AFTER their source row
 * was ingested).
 */

import type { Env } from "../types";
import type { AlertTypeKey } from "@averrow/shared";
import { createAlert } from "./alerts";

export type PhantomMatchSource = "nrd" | "ct" | "lookalike";

export interface PhantomMatchOptions {
  /** Per-source cap on rows scanned in one run. Clamped 1..5000, default 500. */
  limit?: number;
  /** Restrict to one source, or 'all' (default). */
  source?: PhantomMatchSource | "all";
  /**
   * Ignore the KV cursor (scan from the beginning) and do NOT advance it.
   * The operator's catch-up sweep for phantoms enumerated after their
   * source row landed. Default false (incremental).
   */
  full?: boolean;
}

export interface PhantomMatchSourceResult {
  scanned: number;
  matched: number;
  alerted: number;
  cursor_before: string | null;
  cursor_after: string | null;
}

export interface PhantomMatchResult {
  full: boolean;
  limit: number;
  by_source: Record<PhantomMatchSource, PhantomMatchSourceResult>;
  total: { scanned: number; matched: number; alerted: number };
}

interface SourceConfig {
  /** Physical table joined against phantom_domains.domain. Compile-time literal. */
  table: "nrd_domains" | "ct_certificates" | "lookalike_domains";
  /** Natural time column used as the incremental cursor. Compile-time literal. */
  cursorCol: "registered_date" | "not_before" | "created_at";
  /** KV cursor key. */
  kvKey: string;
  /** Reused alert type (spec §6.1) — no new type introduced. */
  alertType: AlertTypeKey;
}

const SOURCE_CONFIG: Record<PhantomMatchSource, SourceConfig> = {
  nrd: {
    table: "nrd_domains",
    cursorCol: "registered_date",
    kvKey: "phantom_matcher:nrd:cursor",
    alertType: "lookalike_domain_active",
  },
  ct: {
    table: "ct_certificates",
    cursorCol: "not_before",
    kvKey: "phantom_matcher:ct:cursor",
    alertType: "ct_certificate_issued",
  },
  lookalike: {
    table: "lookalike_domains",
    cursorCol: "created_at",
    kvKey: "phantom_matcher:lookalike:cursor",
    alertType: "lookalike_domain_active",
  },
};

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

export function clampMatchLimit(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

/** A candidate hit row returned by the set-based join. */
interface HitRow {
  phantom_id: string;
  brand_id: string;
  domain: string;
  enumeration_run_id: string | null;
  kind: string | null;
  confidence: number | null;
  brand_name: string | null;
  cursor_val: string | null;
}

/**
 * Read-only, minimal surface of a D1 session/database this module needs for
 * its JOIN reads. Both `env.DB` and a read replica session satisfy it.
 */
interface ReadableDb {
  prepare(query: string): D1PreparedStatement;
}

/**
 * Run the matcher for a single source. Reads via the supplied read session
 * (`read`), writes exclusively via `env.DB`. Pure post-pass — no inline
 * feed-pull work.
 */
async function matchSource(
  env: Env,
  read: ReadableDb,
  source: PhantomMatchSource,
  limit: number,
  full: boolean,
): Promise<PhantomMatchSourceResult> {
  const cfg = SOURCE_CONFIG[source];

  // Cursor floor. Empty string sorts below every real date string and, via
  // `>= ''`, still excludes rows whose cursor column is NULL (NULL >= '' is
  // NULL, not true) — a cert with no not_before simply isn't cursorable.
  const cursorBefore = full ? null : await env.CACHE.get(cfg.kvKey);
  const cursorFloor = cursorBefore ?? "";

  // Set-based join, driven from the small phantom_domains side
  // (idx_phantom_domain). Table + cursor column are compile-time literals
  // from SOURCE_CONFIG — never interpolated user input; the cursor floor
  // and limit are bound parameters.
  const sql =
    `SELECT p.id AS phantom_id, p.brand_id AS brand_id, p.domain AS domain, ` +
    `       p.enumeration_run_id AS enumeration_run_id, p.kind AS kind, ` +
    `       p.confidence AS confidence, b.name AS brand_name, ` +
    `       t.${cfg.cursorCol} AS cursor_val ` +
    `  FROM phantom_domains p ` +
    `  JOIN ${cfg.table} t ON t.domain = p.domain ` +
    `  LEFT JOIN brands b ON b.id = p.brand_id ` +
    ` WHERE p.status = 'predicted' ` +
    `   AND t.${cfg.cursorCol} >= ? ` +
    ` ORDER BY t.${cfg.cursorCol} ASC ` +
    ` LIMIT ?`;

  const rows = await read
    .prepare(sql)
    .bind(cursorFloor, limit)
    .all<HitRow>();

  const result: PhantomMatchSourceResult = {
    scanned: rows.results.length,
    matched: 0,
    alerted: 0,
    cursor_before: cursorBefore,
    cursor_after: cursorBefore,
  };

  let maxCursor = cursorBefore;

  for (const row of rows.results) {
    if (row.cursor_val && (maxCursor == null || row.cursor_val > maxCursor)) {
      maxCursor = row.cursor_val;
    }

    // ── Guarded claim (spec §6.4): flip predicted → registered atomically.
    // The status guard makes this succeed AT MOST ONCE per phantom, so the
    // alert below fires at most once. Writes go through env.DB directly.
    const claim = await env.DB.prepare(
      `UPDATE phantom_domains
          SET status = 'registered',
              matched_source = ?,
              matched_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ? AND status = 'predicted'`,
    )
      .bind(source, row.phantom_id)
      .run();

    if (!claim.meta?.changes || claim.meta.changes === 0) {
      // Already claimed (duplicate join row, e.g. multiple certs for one
      // domain, or a prior pass). No alert — idempotent no-op.
      continue;
    }
    result.matched++;

    // ── At-most-one monitoring alert (spec §6.1/§6.2/§6.3). Severity is
    // explicitly 'low' regardless of the reused type's default — a phantom
    // hit is "our prediction came true", a monitoring signal, not a
    // confirmed active phish. orgId intentionally UNSET (brand-wide).
    // NEVER inserts a threats row.
    const brandLabel = row.brand_name ?? row.brand_id;
    let alertId: string | null = null;
    try {
      alertId = await createAlert(env.DB, {
        brandId: row.brand_id,
        // brand_profiles retired (R6); scanners attribute brand-wide alerts
        // to 'system' — the alert stays tenant-scoped at read time via brand_id.
        userId: "system",
        alertType: cfg.alertType,
        severity: "low",
        title: "Predicted phantom domain registered",
        summary:
          `Phantom domain ${row.domain} predicted for ${brandLabel} was ` +
          `${source}-observed`,
        details: {
          phantom_id: row.phantom_id,
          domain: row.domain,
          matched_source: source,
          enumeration_run_id: row.enumeration_run_id,
          kind: row.kind,
          confidence: row.confidence,
          brand_id: row.brand_id,
          brand_name: row.brand_name,
        },
        sourceType: "phantom",
        sourceId: row.phantom_id,
      });
    } catch {
      // Alert creation is non-fatal: the prediction was still validated and
      // the phantom is already flipped to 'registered'. Leave alert_id NULL.
      alertId = null;
    }

    // createAlert returns null on the NX2 tier gate (brand demoted to
    // 'tracked' between enumeration and match) — tolerated: the flip stands
    // with alert_id NULL (spec §6.3). Only stamp a non-null id.
    if (alertId) {
      result.alerted++;
      await env.DB.prepare(
        `UPDATE phantom_domains
            SET alert_id = ?, updated_at = datetime('now')
          WHERE id = ?`,
      )
        .bind(alertId, row.phantom_id)
        .run();
    }
  }

  // Advance the incremental cursor to the newest source row seen (spec §7).
  // `full` sweeps never persist a cursor so a later incremental run is
  // unaffected. `>=` re-includes the boundary row next run, which is
  // harmless — the claim guard makes the re-scan a no-op.
  if (!full && maxCursor && maxCursor !== cursorBefore) {
    await env.CACHE.put(cfg.kvKey, maxCursor);
    result.cursor_after = maxCursor;
  }

  return result;
}

/**
 * Run the phantom matcher across the requested source(s). Idempotent and
 * safe to re-run (the §6.4 status guard makes re-runs no-ops). Returns a
 * per-source {scanned, matched, alerted} breakdown — same idempotent
 * post-pass shape as /api/admin/alerts/backfill-triage.
 */
export async function runPhantomMatch(
  env: Env,
  read: ReadableDb,
  options: PhantomMatchOptions = {},
): Promise<PhantomMatchResult> {
  const limit = clampMatchLimit(options.limit);
  const full = options.full === true;
  const sources: PhantomMatchSource[] =
    !options.source || options.source === "all"
      ? ["nrd", "ct", "lookalike"]
      : [options.source];

  const empty = (): PhantomMatchSourceResult => ({
    scanned: 0,
    matched: 0,
    alerted: 0,
    cursor_before: null,
    cursor_after: null,
  });
  const bySource: Record<PhantomMatchSource, PhantomMatchSourceResult> = {
    nrd: empty(),
    ct: empty(),
    lookalike: empty(),
  };

  for (const src of sources) {
    bySource[src] = await matchSource(env, read, src, limit, full);
  }

  const total = sources.reduce(
    (acc, src) => ({
      scanned: acc.scanned + bySource[src].scanned,
      matched: acc.matched + bySource[src].matched,
      alerted: acc.alerted + bySource[src].alerted,
    }),
    { scanned: 0, matched: 0, alerted: 0 },
  );

  return { full, limit, by_source: bySource, total };
}
