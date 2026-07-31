// Averrow — weaponization-velocity D1 read/write layer (rec 5, v1).
//
// The glue between the PURE decide-fn (`velocity-signatures.ts`,
// `decideWeaponizationVelocity`) and D1. Reads a bounded `LIMIT ? OFFSET ?`
// page of threats rows that carry a `domain_created_at` (the computable set),
// runs the decide-fn per row, and stamps `threats.weaponization_hours` +
// `threats.weaponization_flag` via a single-row PK `UPDATE`.
//
// Boundaries this file honours (spec §4.3 + CLAUDE.md §8):
//   * READS go through the caller-supplied read-replica handle
//     (`getReadSession`); WRITES go through `env.DB` directly.
//   * Prepared statements only — every value is bound, never interpolated.
//   * Per-row scalar arithmetic — NO GROUP BY / JOIN to derive the metric.
//     (Dry-run does a handful of bare COUNT(*)s for candidate totals, exactly
//     like the phishing writer's dry-run corpus stats; this is an
//     operator-driven backfill, not a hot path.)
//   * Single-row PK `UPDATE threats SET ... WHERE id = ?` — the row already
//     exists, so no `ON CONFLICT` is needed (contrast the 0257 capture writer,
//     which INSERTs new rows). Chunked `db.batch()` (WRITE_CHUNK = 50).
//   * IDEMPOTENT / re-run stable: the candidate inputs (domain_created_at,
//     first_seen) are immutable, so re-running any offset reproduces
//     byte-identical values. Because `threats.id` is a content hash (not a
//     monotonic key), a threat ingested mid-sweep can shift the ORDER BY id
//     window and cause a one-row skip/re-visit at a page boundary — harmless:
//     re-visits are idempotent no-ops and a skipped row is caught by the next
//     sweep from offset 0. Only computable rows are written; not-computable
//     rows are left NULL (spec: NULL = "velocity not measurable", distinct from
//     `normal`). A sweep terminates when `scanned < limit`.
//
// Metadata/evidence ONLY (spec §3, doctrine §3.1): the stamped columns MUST
// NEVER gate alert-triage / alert-ai-judge. This writer only persists the
// attribute; nothing here (or downstream) may turn it into a dismissal lever.
//
// Not an AgentModule: dispatched from an admin backfill endpoint, so — like
// `runPhishingSignalWriter` / `runAlertTriageBackfill` — it writes NO
// `agent_runs` / `agent_events` rows, and there is no cron.

import type { Env } from '../types';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  decideWeaponizationVelocity,
  type WeaponizationFlag,
} from './velocity-signatures';

/** Anything with a `.prepare()` — both `D1Database` and the read-replica
 *  handle from `getReadSession` satisfy this. */
type Queryable = Pick<D1Database, 'prepare'>;

/** Rows per D1 `batch()` so a single call stays inside CPU/statement limits.
 *  Bounded backfill, not a hot path. */
const WRITE_CHUNK = 50;

// ─── Bounds ──────────────────────────────────────────────────────────────

export const VELOCITY_BACKFILL_DEFAULT_LIMIT = 500;
export const VELOCITY_BACKFILL_MAX_LIMIT = 1000;

export function clampLimit(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return VELOCITY_BACKFILL_DEFAULT_LIMIT;
  return Math.max(1, Math.min(VELOCITY_BACKFILL_MAX_LIMIT, Math.floor(raw)));
}

export function clampOffset(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

// ─── Candidate row + page select ─────────────────────────────────────────

interface CandidateRow {
  id: string;
  domain_created_at: string | null;
  first_seen: string;
}

// The computable set: rows that carry a registration date. `weaponization_flag
// IS NULL` is deliberately NOT in the WHERE — the set stays stable across a
// sweep (immutable `domain_created_at`), so offset pagination never skips a
// row, and re-stamping an already-stamped row with its byte-identical value is
// a harmless idempotent no-op. Per-row arithmetic in TS, no SQL aggregate.
const CANDIDATE_SELECT = `
  SELECT id, domain_created_at, first_seen
  FROM threats
  WHERE domain_created_at IS NOT NULL
  ORDER BY id
  LIMIT ? OFFSET ?
`;

/** Flag distribution over a processed page. `not_computable` = decide-fn
 *  returned a NULL flag (missing/garbage/sentinel/negative). */
export interface FlagDistribution {
  very_fast: number;
  fast: number;
  normal: number;
  not_computable: number;
}

function emptyDistribution(): FlagDistribution {
  return { very_fast: 0, fast: 0, normal: 0, not_computable: 0 };
}

function tallyFlag(dist: FlagDistribution, flag: WeaponizationFlag | null): void {
  if (flag === null) dist.not_computable += 1;
  else dist[flag] += 1;
}

// ─── Dry-run (writes nothing — spec §4.3 reality-check) ──────────────────

export interface VelocityDryRunResult {
  dry_run: true;
  limit: number;
  offset: number;
  /** Full COUNT(*) over threats (context). */
  total_threats: number;
  /** Computable candidate rows (domain_created_at IS NOT NULL). */
  candidates_total: number;
  /** Rows already carrying a non-NULL weaponization_flag. */
  already_stamped: number;
  /** Rows loaded for this page (<= limit). */
  scanned: number;
  /** Rows in this page whose decide-fn yields a non-NULL flag (would be UPDATE'd). */
  would_write: number;
  /** Would-be flag distribution over the loaded page. */
  by_flag: FlagDistribution;
}

export async function computeVelocityDryRun(
  read: Queryable,
  limit: number,
  offset: number,
): Promise<VelocityDryRunResult> {
  const [totalRow, candidatesRow, stampedRow, page] = await Promise.all([
    read.prepare('SELECT COUNT(*) AS n FROM threats').first<{ n: number }>(),
    read
      .prepare('SELECT COUNT(*) AS n FROM threats WHERE domain_created_at IS NOT NULL')
      .first<{ n: number }>(),
    read
      .prepare('SELECT COUNT(*) AS n FROM threats WHERE weaponization_flag IS NOT NULL')
      .first<{ n: number }>(),
    read.prepare(CANDIDATE_SELECT).bind(limit, offset).all<CandidateRow>(),
  ]);

  const byFlag = emptyDistribution();
  let wouldWrite = 0;
  for (const row of page.results) {
    const { weaponization_flag } = decideWeaponizationVelocity(
      row.domain_created_at,
      row.first_seen,
    );
    tallyFlag(byFlag, weaponization_flag);
    if (weaponization_flag !== null) wouldWrite += 1;
  }

  return {
    dry_run: true,
    limit,
    offset,
    total_threats: totalRow?.n ?? 0,
    candidates_total: candidatesRow?.n ?? 0,
    already_stamped: stampedRow?.n ?? 0,
    scanned: page.results.length,
    would_write: wouldWrite,
    by_flag: byFlag,
  };
}

// ─── Real run (decide + stamp) ───────────────────────────────────────────

export interface VelocityBackfillResult {
  dry_run: false;
  limit: number;
  offset: number;
  /** Rows loaded for this page (<= limit). Sweep ends when scanned < limit. */
  scanned: number;
  /** Rows actually UPDATE'd (computable — non-NULL flag). */
  written: number;
  /** Flag distribution over the page (incl. not_computable, which is NOT written). */
  by_flag: FlagDistribution;
}

const UPDATE_SQL = `
  UPDATE threats
  SET weaponization_hours = ?, weaponization_flag = ?
  WHERE id = ?
`;

/**
 * The bounded backfill writer (spec §4.3). Reads a page off the read replica,
 * runs the pure decide-fn per row, and stamps the computable rows via
 * `env.DB` (writes never go through a read session).
 *
 * Idempotent: single-row PK `UPDATE` with byte-identical values on re-run
 * (immutable inputs). Only computable rows are written — not-computable rows
 * keep their NULL columns (spec: NULL ≠ `normal`). Callable repeatedly with
 * advancing `offset` until `scanned < limit`.
 */
export async function runVelocityBackfill(
  env: Env,
  read: Queryable,
  limit: number,
  offset: number,
): Promise<VelocityBackfillResult> {
  const page = await read.prepare(CANDIDATE_SELECT).bind(limit, offset).all<CandidateRow>();

  const byFlag = emptyDistribution();
  const stmt = env.DB.prepare(UPDATE_SQL);
  const statements: D1PreparedStatement[] = [];
  for (const row of page.results) {
    const { weaponization_hours, weaponization_flag } = decideWeaponizationVelocity(
      row.domain_created_at,
      row.first_seen,
    );
    tallyFlag(byFlag, weaponization_flag);
    // Only stamp computable rows — leaving not-computable rows NULL keeps the
    // "not measurable" state distinct from `normal` and avoids pointless
    // NULL→NULL writes without disturbing the stable candidate set.
    if (weaponization_flag !== null) {
      statements.push(stmt.bind(weaponization_hours, weaponization_flag, row.id));
    }
  }

  for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
    await env.DB.batch(statements.slice(i, i + WRITE_CHUNK));
  }

  return {
    dry_run: false,
    limit,
    offset,
    scanned: page.results.length,
    written: statements.length,
    by_flag: byFlag,
  };
}
