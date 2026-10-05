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
 * on its INGESTION-time column (`created_at` on all three source tables)
 * so a normal run scans only rows newer than the last run — same
 * discipline as the dns-queue reconciler. It deliberately does NOT cursor
 * on a row's intrinsic date (nrd `registered_date` / ct `not_before`):
 * those are NOT monotonic with ingestion — crt.sh serves historical certs
 * and CAs backdate `not_before`, so a row ingested later but dated earlier
 * than the advanced cursor would be `WHERE col >= cursor`-excluded FOREVER.
 * `created_at` defaults to datetime('now') at insert time, so it is
 * monotonic with ingestion and never backdated. `full` ignores + does not
 * advance the cursor, for an operator's catch-up sweep (e.g. right after a
 * fresh enumeration, to match phantoms enumerated AFTER their source row
 * was ingested).
 */

import type { Env } from "../types";
import type { AlertTypeKey } from "@averrow/shared";
import { createAlert } from "./alerts";
// Producer 4 of `lookalike_domain_active` (see that module's
// enumeration). This module does NOT apply the HIGH severity floor, and
// the severity it does use is imported from the policy module rather
// than written as a bare literal here, so the exemption and its bound
// live where the floor lives. See PHANTOM_MATCH_ALERT_SEVERITY.
import { PHANTOM_MATCH_ALERT_SEVERITY } from "./lookalike-alert-policy";

export type PhantomMatchSource = "nrd" | "ct" | "lookalike";

/**
 * KV key holding the nrd source's incremental cursor, stored verbatim as a
 * `nrd_domains.created_at` value (SQLite `datetime('now')` format,
 * `YYYY-MM-DD HH:MM:SS` UTC).
 *
 * Contract: every nrd_domains row with `created_at < cursor` has been
 * scanned by an incremental run; rows at or after it have not necessarily
 * been (the next run re-scans `>= cursor`). An untruncated incremental run
 * advances it to `MAX(nrd_domains.created_at)` as read BEFORE its join, even
 * when nothing matched (see `advanceToSourceMax`) — so it means "scanned up
 * to", not "newest match seen". It only moves when the matcher RUNS
 * incrementally (`full=1` never reads or advances it); it is never set if
 * the matcher has never run.
 *
 * Exported so `lib/nrd-retention.ts` can hold its purge on it: rows at or
 * after this value are not deleted — but the hold is CLAMPED to no earlier
 * than now − 37 days (30-day retention + 7-day margin), and a missing cursor
 * holds at that floor. So if this manual matcher is not run incrementally
 * for over a month, unscanned rows ARE purged from D1; every one is still in
 * the NRD_ARCHIVE R2 bucket (feeds/nrd_hagezi.ts daily archive).
 */
export const PHANTOM_MATCHER_NRD_CURSOR_KEY = "phantom_matcher:nrd:cursor";

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
  /**
   * INGESTION-time column used as the incremental cursor. Compile-time
   * literal. `created_at` on every source table (monotonic with ingestion,
   * never backdated) — NOT the intrinsic registered_date / not_before, which
   * are non-monotonic on backfill and would exclude late-ingested rows
   * forever. See module header.
   */
  cursorCol: "created_at";
  /** KV cursor key. */
  kvKey: string;
  /** Reused alert type (spec §6.1) — no new type introduced. */
  alertType: AlertTypeKey;
  /**
   * When true, an UNTRUNCATED incremental run advances the cursor to the
   * source table's `MAX(created_at)` read before the join (not just to the
   * newest MATCHED row), so the cursor means "scanned up to". Requires an
   * index on `created_at` (the MAX is a seek). nrd only: nrd_domains has
   * idx_nrd_domains_created (migration 0279) and its cursor gates
   * lib/nrd-retention.ts. Not applied to lookalike, whose rows can become
   * matchable later (registered 0 → 1) without created_at changing.
   */
  advanceToSourceMax: boolean;
  /**
   * Extra per-source residual appended to the join's WHERE. Compile-time
   * literal, never interpolated input. Empty for genuine-observation sources
   * (nrd = a real NRD listing, ct = an issued cert); the lookalike source
   * uses it to gate on `registered = 1` (see below).
   */
  extraWhere: string;
}

const SOURCE_CONFIG: Record<PhantomMatchSource, SourceConfig> = {
  nrd: {
    table: "nrd_domains",
    // nrd_domains.created_at defaults to datetime('now') at INSERT OR IGNORE
    // time (feeds/nrd_hagezi.ts storeNrdReference) — the monotonic ingestion
    // stamp. registered_date is the domain's intrinsic registration date and
    // is non-monotonic on backfill, so it is NOT used as the cursor.
    cursorCol: "created_at",
    kvKey: PHANTOM_MATCHER_NRD_CURSOR_KEY,
    advanceToSourceMax: true,
    alertType: "lookalike_domain_active",
    extraWhere: "",
  },
  ct: {
    table: "ct_certificates",
    // created_at (idx_ct_created, migration 0032) is the monotonic ingestion
    // stamp — NOT not_before, which CAs backdate and crt.sh serves
    // historically (a later-ingested/earlier-dated cert would be excluded
    // forever under a not_before cursor).
    // KNOWN COVERAGE LIMIT: the join matches ct_certificates.domain (subject
    // CN) only — SAN entries in the san_domains JSON column are not joined,
    // so a phantom that appears only as a SAN on a cert won't match here.
    cursorCol: "created_at",
    kvKey: "phantom_matcher:ct:cursor",
    advanceToSourceMax: false,
    alertType: "ct_certificate_issued",
    extraWhere: "",
  },
  lookalike: {
    table: "lookalike_domains",
    cursorCol: "created_at",
    kvKey: "phantom_matcher:lookalike:cursor",
    advanceToSourceMax: false,
    alertType: "lookalike_domain_active",
    // SHIP-BLOCKER GATE: lookalike_domains is the scanner's FULL permutation
    // CANDIDATE set — every generated permutation is inserted with
    // `registered` DEFAULT 0 (migration 0031); only a later probe flips
    // registered=1 on a real registration. Without this gate a predicted
    // phantom would flip to 'registered' + alert on an UNREGISTERED
    // permutation candidate — a false positive that breaks the "fire only on
    // a real observation" invariant. `registered = 1` (partial index
    // idx_lookalike_registered) is the "actually registered/active" gate.
    extraWhere: " AND t.registered = 1 ",
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
  // NULL, not true) — a row with no created_at simply isn't cursorable.
  const cursorBefore = full ? null : await env.CACHE.get(cfg.kvKey);
  const cursorFloor = cursorBefore ?? "";

  // "Scanned up to" watermark (advanceToSourceMax sources only, incremental
  // runs only). Read BEFORE the join on the same session, so every row the
  // join can see with created_at < sourceMax was in its candidate set. A row
  // inserted after this read gets created_at >= sourceMax (datetime('now')
  // evaluated under D1's serialized writes), so the next run's `>= cursor`
  // still re-scans it. Index seek via idx_nrd_domains_created.
  let sourceMax: string | null = null;
  if (!full && cfg.advanceToSourceMax) {
    const m = await read
      .prepare(`SELECT MAX(${cfg.cursorCol}) AS m FROM ${cfg.table}`)
      .first<{ m: string | null }>();
    sourceMax = m?.m ?? null;
  }

  // Set-based join, driven from the small phantom_domains side. The CROSS
  // JOIN pins SQLite's join order so phantom_domains p is always the OUTER
  // (driver) table and each of the few predicted phantoms probes the source
  // table by its PK/indexed `domain` — SQLite honors CROSS JOIN order and
  // will not reorder to scan the millions-of-rows source table first. Cost
  // stays bounded by the predicted-phantom count (code-review #5). Table,
  // cursor column, and per-source residual are compile-time literals from
  // SOURCE_CONFIG — never interpolated user input; the cursor floor and
  // limit are bound parameters.
  const sql =
    `SELECT p.id AS phantom_id, p.brand_id AS brand_id, p.domain AS domain, ` +
    `       p.enumeration_run_id AS enumeration_run_id, p.kind AS kind, ` +
    `       p.confidence AS confidence, b.name AS brand_name, ` +
    `       t.${cfg.cursorCol} AS cursor_val ` +
    `  FROM phantom_domains p ` +
    `  CROSS JOIN ${cfg.table} t ON t.domain = p.domain ` +
    `  LEFT JOIN brands b ON b.id = p.brand_id ` +
    ` WHERE p.status = 'predicted' ` +
    `   AND t.${cfg.cursorCol} >= ? ` +
    cfg.extraWhere +
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
    //
    // TWO of the three SOURCE_CONFIG entries above reuse
    // `lookalike_domain_active`, which makes this call PRODUCER 4 of
    // that type and the ONLY one that does not apply the HIGH severity
    // floor. That is deliberate and bounded — the alert cannot fire
    // twice for a phantom (the guarded claim above runs first) and
    // `phantom_domains` is written only by a manual-trigger enumerator.
    // The severity constant carries the full argument; it is imported
    // rather than inlined so a change to the floor cannot silently miss
    // this call site the way the floor's own docstring did.
    const brandLabel = row.brand_name ?? row.brand_id;
    let alertId: string | null = null;
    try {
      alertId = await createAlert(env.DB, {
        brandId: row.brand_id,
        // brand_profiles retired (R6); scanners attribute brand-wide alerts
        // to 'system' — the alert stays tenant-scoped at read time via brand_id.
        userId: "system",
        alertType: cfg.alertType,
        severity: PHANTOM_MATCH_ALERT_SEVERITY,
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
      }, { env });
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

  // Advance the incremental cursor (spec §7). Default: the newest MATCHED
  // source row seen. For advanceToSourceMax sources, an untruncated join
  // (fewer rows than `limit`) has covered every row up to the pre-read
  // sourceMax, so the cursor advances to max(sourceMax, newest match) even
  // with zero matches. A truncated join keeps the matched-row rule (rows
  // beyond the LIMIT are still unscanned). `full` sweeps never persist a
  // cursor so a later incremental run is unaffected. `>=` re-includes the
  // boundary row next run, which is harmless — the claim guard makes the
  // re-scan a no-op.
  const truncated = rows.results.length >= limit;
  if (!full && !truncated && sourceMax && (maxCursor == null || sourceMax > maxCursor)) {
    maxCursor = sourceMax;
  }
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
