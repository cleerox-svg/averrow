// Averrow — takedown outcome rollup (Observatory Phase B, B2).
//
// Rebuilds `takedown_outcome_daily` (migration 0299) over a rolling 90-day
// window from `takedown_requests`: per submission day × dimension
// (country | provider) × key, the submitted / taken_down / refused / expired
// / pending counts and the median submit→taken-down hours.
//
// Dispatch: the cube_healer agent, on its UTC hour-0 tick only (the 00:12
// cold heal) — an HOUR-only gate (CLAUDE.md §6 cron-audit rule). cube_healer
// owns the agent_runs / agent_events lifecycle; this module never throws past
// its caller's try/catch for anything but a D1 error.
//
// Classification (takedown_requests has both `status` and `resolution`):
//   taken_down  resolution = 'taken_down' OR status = 'taken_down'
//   refused     resolution = 'refused'   (the ops PATCH stamps it with status
//               'failed'; a dispatch failure — status 'failed' with NO
//               resolution — is NOT a provider refusal and is not counted)
//   expired     resolution = 'expired'   OR status = 'expired'
//   pending     status IN ('submitted', 'pending_response')
//   submitted   every row with submitted_at in the window. Withdrawn,
//               dispatch-failed and re-opened drafts count here only, so the
//               outcome columns need not sum to `submitted`.
// Day = UTC date of submitted_at (the submission cohort). Every outcome
// passes through 'submitted' (ADMIN_ALLOWED_TRANSITIONS, handlers/takedowns.ts)
// so submitted_at is set on every row that has an outcome.
//
// Keys: only threat-sourced takedowns (source_type = 'threat', source_id =
// threats.id) resolve a location — country = threats.country_code (ISO-2,
// else 'unknown'), provider = threats.hosting_provider_id (else 'unknown').
// Every other source_type (url_scan, lookalike, social_profile, app_store,
// abuse_report, alert, ...) lands in 'unknown' for both dims.
//
// Cost (bounded, index-backed — pinned by EXPLAIN in
// test/takedown-outcome-rollup.test.ts):
//   reads  = takedown rows submitted in 90d (idx_takedown_submitted_at range)
//            + ≤1 threats PK lookup each + the rollup's window rows (PK range)
//   writes = changed cells only (guarded upsert) + vanished cells + aged-out
//            days. Steady state: a handful of rows per day.
// The aggregation itself is per-row JS over that small set — never a
// GROUP BY over `threats`.

import type { Env } from '../types';
import type { D1PreparedStatement } from '@cloudflare/workers-types';

export const TAKEDOWN_ROLLUP_WINDOW_DAYS = 90;
/** Statements per db.batch() — keeps a batch well inside D1 limits. */
const WRITE_CHUNK = 50;

export type TakedownDim = 'country' | 'provider';
export const UNKNOWN_KEY = 'unknown';

export interface TakedownSourceRow {
  submitted_at: string;
  resolved_at: string | null;
  status: string | null;
  resolution: string | null;
  country_code: string | null;
  hosting_provider_id: string | null;
}

export interface TakedownOutcomeCell {
  day: string;
  dim: TakedownDim;
  key: string;
  submitted: number;
  taken_down: number;
  refused: number;
  expired: number;
  pending: number;
  median_hours: number | null;
}

/** First day ('YYYY-MM-DD', UTC) of the rolling window ending today. */
export function rollupWindowStartDay(now: Date, days: number = TAKEDOWN_ROLLUP_WINDOW_DAYS): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD HH:MM:SS' / ISO → epoch ms (UTC), or NaN. */
function parseTs(s: string | null): number {
  if (!s) return NaN;
  const t = s.includes('T') ? s : s.replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
}

function countryKey(raw: string | null): string {
  if (typeof raw !== 'string') return UNKNOWN_KEY;
  const c = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : UNKNOWN_KEY;
}

function providerKey(raw: string | null): string {
  if (typeof raw !== 'string') return UNKNOWN_KEY;
  const p = raw.trim();
  return p === '' ? UNKNOWN_KEY : p;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 100) / 100;
}

export type TakedownOutcome = 'taken_down' | 'refused' | 'expired' | 'pending' | null;

/** Classify one takedown row (see header). */
export function classifyTakedown(status: string | null, resolution: string | null): TakedownOutcome {
  if (resolution === 'taken_down' || status === 'taken_down') return 'taken_down';
  if (resolution === 'refused') return 'refused';
  if (resolution === 'expired' || status === 'expired') return 'expired';
  if (status === 'submitted' || status === 'pending_response') return 'pending';
  return null;
}

/**
 * Pure: fold takedown rows into rollup cells for both dims. Rows whose
 * submitted_at does not parse are skipped. Output is sorted by
 * (day, dim, key) for deterministic writes.
 */
export function computeTakedownOutcomeCells(rows: readonly TakedownSourceRow[]): TakedownOutcomeCell[] {
  interface Acc extends Omit<TakedownOutcomeCell, 'median_hours'> { hours: number[] }
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const submittedMs = parseTs(r.submitted_at);
    if (!Number.isFinite(submittedMs)) continue;
    const day = new Date(submittedMs).toISOString().slice(0, 10);
    const outcome = classifyTakedown(r.status, r.resolution);
    let hours: number | null = null;
    if (outcome === 'taken_down') {
      const resolvedMs = parseTs(r.resolved_at);
      if (Number.isFinite(resolvedMs) && resolvedMs >= submittedMs) {
        hours = (resolvedMs - submittedMs) / 3_600_000;
      }
    }
    const keys: Array<[TakedownDim, string]> = [
      ['country', countryKey(r.country_code)],
      ['provider', providerKey(r.hosting_provider_id)],
    ];
    for (const [dim, key] of keys) {
      const id = `${day}|${dim}|${key}`;
      let a = acc.get(id);
      if (!a) {
        a = { day, dim, key, submitted: 0, taken_down: 0, refused: 0, expired: 0, pending: 0, hours: [] };
        acc.set(id, a);
      }
      a.submitted += 1;
      if (outcome) a[outcome] += 1;
      if (hours !== null) a.hours.push(hours);
    }
  }
  const out: TakedownOutcomeCell[] = [...acc.values()].map(({ hours, ...c }) => ({ ...c, median_hours: median(hours) }));
  out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.dim < b.dim ? -1 : a.dim > b.dim ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

// ─── SQL ─────────────────────────────────────────────────────────────────

// Window read. `tr.submitted_at >= ?` is served by idx_takedown_submitted_at
// (partial, NOT NULL — 0299); the threats join is a PK lookup and only for
// threat-sourced rows.
export const TAKEDOWN_ROLLUP_SOURCE_SQL = `
  SELECT tr.submitted_at, tr.resolved_at, tr.status, tr.resolution,
         t.country_code, t.hosting_provider_id
  FROM takedown_requests tr
  LEFT JOIN threats t
    ON tr.source_type = 'threat' AND t.id = tr.source_id
  WHERE tr.submitted_at IS NOT NULL
    AND tr.submitted_at >= ?
`;

const EXISTING_KEYS_SQL = `
  SELECT day, dim, key
  FROM takedown_outcome_daily
  WHERE day >= ?
`;

// Guarded upsert: unchanged cells cost 0 row writes (same IS NOT guard as
// the cubes, PR-BO).
const UPSERT_SQL = `
  INSERT INTO takedown_outcome_daily
    (day, dim, key, submitted, taken_down, refused, expired, pending, median_hours, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(day, dim, key) DO UPDATE SET
    submitted = excluded.submitted,
    taken_down = excluded.taken_down,
    refused = excluded.refused,
    expired = excluded.expired,
    pending = excluded.pending,
    median_hours = excluded.median_hours,
    updated_at = excluded.updated_at
  WHERE takedown_outcome_daily.submitted IS NOT excluded.submitted
     OR takedown_outcome_daily.taken_down IS NOT excluded.taken_down
     OR takedown_outcome_daily.refused IS NOT excluded.refused
     OR takedown_outcome_daily.expired IS NOT excluded.expired
     OR takedown_outcome_daily.pending IS NOT excluded.pending
     OR takedown_outcome_daily.median_hours IS NOT excluded.median_hours
`;

const DELETE_CELL_SQL = `DELETE FROM takedown_outcome_daily WHERE day = ? AND dim = ? AND key = ?`;
const DELETE_AGED_SQL = `DELETE FROM takedown_outcome_daily WHERE day < ?`;

export interface TakedownRollupResult {
  windowStart: string;
  sourceRows: number;
  cells: number;
  rowsWritten: number;
  staleDeleted: number;
}

/**
 * Rebuild the rolling window. Idempotent: re-running with unchanged source
 * writes nothing. Writes go through env.DB; the two reads also use env.DB
 * (primary) so the stale diff never runs against a lagging replica's view of
 * the rollup it is about to rewrite.
 */
export async function runTakedownOutcomeRollup(env: Env, now: Date = new Date()): Promise<TakedownRollupResult> {
  const windowStart = rollupWindowStartDay(now);
  const [source, existing] = await Promise.all([
    env.DB.prepare(TAKEDOWN_ROLLUP_SOURCE_SQL).bind(`${windowStart} 00:00:00`).all<TakedownSourceRow>(),
    env.DB.prepare(EXISTING_KEYS_SQL).bind(windowStart).all<{ day: string; dim: TakedownDim; key: string }>(),
  ]);
  const sourceRows = source.results ?? [];
  const cells = computeTakedownOutcomeCells(sourceRows);

  const live = new Set(cells.map((c) => `${c.day}|${c.dim}|${c.key}`));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(DELETE_AGED_SQL).bind(windowStart),
  ];
  let staleCells = 0;
  for (const e of existing.results ?? []) {
    if (!live.has(`${e.day}|${e.dim}|${e.key}`)) {
      statements.push(env.DB.prepare(DELETE_CELL_SQL).bind(e.day, e.dim, e.key));
      staleCells++;
    }
  }
  const upsert = env.DB.prepare(UPSERT_SQL);
  for (const c of cells) {
    statements.push(upsert.bind(c.day, c.dim, c.key, c.submitted, c.taken_down, c.refused, c.expired, c.pending, c.median_hours));
  }

  let rowsWritten = 0;
  for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
    const results = await env.DB.batch(statements.slice(i, i + WRITE_CHUNK));
    rowsWritten += results.reduce((sum, r) => sum + (r?.meta?.changes ?? 0), 0);
  }
  return { windowStart, sourceRows: sourceRows.length, cells: cells.length, rowsWritten, staleDeleted: staleCells };
}
