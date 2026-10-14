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
// Two entry points:
//   * `runVelocityBackfill` — the operator-driven admin backfill (offset
//     pagination over the whole computable set). Not an AgentModule, so it
//     writes NO `agent_runs` / `agent_events` rows.
//   * `runVelocityStampPage` — the scheduled incremental page (Observatory
//     Phase B, B3). Called by the cube_healer agent every run (its
//     `agent_runs` / `agent_events` cover it); ≤500 rows per call over the
//     partial index idx_threats_velocity_unstamped (migration 0300) with a KV
//     keyset cursor. No new cron.

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

// ─── Scheduled incremental stamping (cube_healer, B3) ────────────────────

/** Rows per scheduled stamping page (cube_healer runs 4×/day → ≤2,000/day). */
export const VELOCITY_STAMP_PAGE_LIMIT = 500;
/** KV keyset cursor: the last `threats.id` the stamping page visited. */
export const VELOCITY_STAMP_CURSOR_KEY = 'velocity_stamp:cursor';
/** Cursor TTL — long enough to survive a skipped day, short enough that a
 *  stuck cursor self-resets. */
const VELOCITY_STAMP_CURSOR_TTL_S = 7 * 24 * 60 * 60;

// Unstamped computable rows, keyset-paged by id. Every predicate is the
// partial index's own WHERE, so SQLite serves it from
// idx_threats_velocity_unstamped (an id range seek, no sort). Rows stamped by
// a previous page have left the index; rows whose velocity is not computable
// stay in it and are walked past once per cursor cycle.
const UNSTAMPED_PAGE_SELECT = `
  SELECT id, domain_created_at, first_seen
  FROM threats
  WHERE domain_created_at IS NOT NULL
    AND weaponization_flag IS NULL
    AND id > ?
  ORDER BY id
  LIMIT ?
`;

export interface VelocityStampPageResult {
  /** Cursor the page started from ('' = start of the index). */
  cursor_from: string;
  /** Cursor stored for the next run ('' = cycle complete, restart). */
  cursor_to: string;
  scanned: number;
  written: number;
  by_flag: FlagDistribution;
}

/**
 * One bounded incremental stamping page. Reads ≤`limit` unstamped rows after
 * the KV cursor, stamps the computable ones via `env.DB`, and advances the
 * cursor (reset to '' when the page comes back short — the next run starts a
 * fresh cycle and picks up rows whose domain_created_at landed behind the
 * cursor).
 *
 * Reads go to the PRIMARY (`env.DB`), not a replica: the page selects on
 * `weaponization_flag IS NULL`, and a lagging replica could hand back rows
 * this run's previous page already stamped (harmless — idempotent — but it
 * wastes the bounded page). Same choice as the cube heals in this agent.
 *
 * Throws only on a D1 error; the caller records it as a diagnostic.
 */
export async function runVelocityStampPage(
  env: Env,
  limit: number = VELOCITY_STAMP_PAGE_LIMIT,
): Promise<VelocityStampPageResult> {
  const bounded = clampLimit(limit);
  let cursorFrom = '';
  try {
    cursorFrom = (await env.CACHE.get(VELOCITY_STAMP_CURSOR_KEY)) ?? '';
  } catch {
    cursorFrom = '';
  }
  const page = await env.DB.prepare(UNSTAMPED_PAGE_SELECT)
    .bind(cursorFrom, bounded)
    .all<CandidateRow>();
  const rows = page.results ?? [];

  const byFlag = emptyDistribution();
  const stmt = env.DB.prepare(UPDATE_SQL);
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const { weaponization_hours, weaponization_flag } = decideWeaponizationVelocity(
      row.domain_created_at,
      row.first_seen,
    );
    tallyFlag(byFlag, weaponization_flag);
    if (weaponization_flag !== null) {
      statements.push(stmt.bind(weaponization_hours, weaponization_flag, row.id));
    }
  }
  for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
    await env.DB.batch(statements.slice(i, i + WRITE_CHUNK));
  }

  // Advance only after the writes landed, so a failed batch re-reads the page.
  const cursorTo = rows.length < bounded ? '' : rows[rows.length - 1]!.id;
  try {
    await env.CACHE.put(VELOCITY_STAMP_CURSOR_KEY, cursorTo, {
      expirationTtl: VELOCITY_STAMP_CURSOR_TTL_S,
    });
  } catch {
    // Best-effort: a lost cursor restarts the cycle from '' — idempotent.
  }

  return {
    cursor_from: cursorFrom,
    cursor_to: cursorTo,
    scanned: rows.length,
    written: statements.length,
    by_flag: byFlag,
  };
}
