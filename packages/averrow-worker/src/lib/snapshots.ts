/**
 * Daily Snapshot Aggregation — compute daily threat metrics per brand &
 * provider into `daily_snapshots` for trend analysis.
 *
 * Scheduled path: the dedicated `28 0,12 * * *` cron
 * (`runDailySnapshotsCron` in `handlers/dailySnapshots.ts`), with
 * `resume: true` — each entity type continues from the highest entity_id
 * already written for the date, so the 00:28 run does the work and the
 * 12:28 run is a near-free repair pass (one boundary read per complete
 * type) that finishes any type a killed or deadline-stopped run left
 * half-written. Manual path: `POST /api/snapshots/generate`
 * (`handlers/threats.ts`) forces regeneration of both types.
 *
 * Bounded work (2026-11-07): each type is written in keyset chunks of
 * `SNAPSHOT_CHUNK_SIZE` entities (`entity_id > lo AND entity_id <= hi`,
 * seeking idx_threats_brand_status / idx_threats_provider_created), never
 * as one whole-table INSERT … SELECT. The single statement (~1.75M rows
 * read, ~11-14K rows / ~44-55K index entries written per type) was where
 * the cron invocation died from 2026-11-04 on: the rows committed, but no
 * line after the statement ever ran, so agent_runs stayed 'running'
 * forever. Each chunk commits on its own, so progress survives a killed
 * invocation and the next pass resumes after the last committed entity.
 *
 * Consumer: Flight Control's provider-escalation watcher compares
 * `hosting_providers.active_threat_count` to YESTERDAY's provider snapshot,
 * so a missing provider row for a day silences that watcher the next day.
 *
 * NOT done here (removed 2026-10-14): the hosting_providers
 * active/total_threat_count recount. `lib/provider-counts.ts`
 * (`syncHostingProviderCounts`) is that column pair's maintained writer —
 * enrichment Stage 5 every 4h (incl. hour 0) + the admin backfill — with the
 * identical COUNT definitions. Re-running it here was four correlated
 * COUNTs over threats per provider once a day for ~0 changed rows.
 */

import { withD1Retry, type D1RetryOptions } from "./d1-retry";

export type SnapshotEntityType = "brand" | "provider";

/** Entities per INSERT … SELECT chunk. */
export const SNAPSHOT_CHUNK_SIZE = 1000;

/** Hard ceiling on chunks per type per call — a runaway-loop backstop. */
const MAX_CHUNKS_PER_TYPE = 1000;

export interface SnapshotTypeResult {
  /**
   * 'generated' = at least one chunk was written (or a forced run over an
   * empty source); 'skipped' = resumed and nothing was left to write.
   */
  action: "generated" | "skipped";
  rows: number;
  /** False when the deadline stopped the type before its last chunk. */
  complete: boolean;
  chunks: number;
}

export interface GenerateSnapshotsOptions {
  /**
   * When true, continue after the highest entity_id already written for
   * the date (a PK-prefix MAX probe, one row read). A complete type costs
   * one boundary read and no INSERT; a half-written type is finished.
   * Default false (force — the manual endpoint's semantics).
   */
  resume?: boolean;
  /** Entities per chunk; defaults to SNAPSHOT_CHUNK_SIZE. */
  chunkSize?: number;
  /**
   * Epoch ms. No new chunk starts at or after it; the type returns
   * `complete: false` and the next resume pass carries on.
   */
  deadline?: number;
  /** Called after every committed chunk with the type's running row total. */
  onChunk?: (rowsSoFar: number) => Promise<void> | void;
  /** Clock, injectable for tests. */
  now?: () => number;
  /**
   * Retry each chunk's bound read and INSERT OR REPLACE (both idempotent) on
   * transient D1 errors. The cron path passes an overload-aware policy so a
   * chunk rejected by D1's 10-second overload window waits it out instead of
   * failing the whole type (2026-11-08..10: every run lost its type to that).
   * Unset = no retry (the manual endpoint's semantics).
   */
  retry?: D1RetryOptions;
  /** Pause (ms) between chunks, to spread the reads over D1's 10 s window. */
  interChunkPauseMs?: number;
  /** Sleep, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const BRAND_SNAPSHOT_CHUNK_SQL = `
    INSERT OR REPLACE INTO daily_snapshots (date, entity_type, entity_id, new_threats, active_threats, remediated_threats, dominant_threat_type, dominant_hosting_provider)
    SELECT
      ? AS date,
      'brand' AS entity_type,
      target_brand_id AS entity_id,
      COUNT(CASE WHEN created_at >= ? AND created_at < date(?, '+1 day') THEN 1 END) AS new_threats,
      COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_threats,
      COUNT(CASE WHEN status = 'remediated' THEN 1 END) AS remediated_threats,
      (SELECT threat_type FROM threats t2
       WHERE t2.target_brand_id = threats.target_brand_id AND t2.status = 'active'
       GROUP BY threat_type ORDER BY COUNT(*) DESC LIMIT 1) AS dominant_threat_type,
      (SELECT hp.name FROM threats t3
       JOIN hosting_providers hp ON t3.hosting_provider_id = hp.id
       WHERE t3.target_brand_id = threats.target_brand_id AND t3.status = 'active'
       GROUP BY hp.name ORDER BY COUNT(*) DESC LIMIT 1) AS dominant_hosting_provider
    FROM threats
    WHERE target_brand_id > ? AND target_brand_id <= ?
    GROUP BY target_brand_id
  `;

const PROVIDER_SNAPSHOT_CHUNK_SQL = `
    INSERT OR REPLACE INTO daily_snapshots (date, entity_type, entity_id, new_threats, active_threats, remediated_threats, dominant_threat_type)
    SELECT
      ? AS date,
      'provider' AS entity_type,
      hosting_provider_id AS entity_id,
      COUNT(CASE WHEN created_at >= ? AND created_at < date(?, '+1 day') THEN 1 END) AS new_threats,
      COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_threats,
      COUNT(CASE WHEN status = 'remediated' THEN 1 END) AS remediated_threats,
      (SELECT threat_type FROM threats t2
       WHERE t2.hosting_provider_id = threats.hosting_provider_id AND t2.status = 'active'
       GROUP BY threat_type ORDER BY COUNT(*) DESC LIMIT 1) AS dominant_threat_type
    FROM threats
    WHERE hosting_provider_id > ? AND hosting_provider_id <= ?
    GROUP BY hosting_provider_id
  `;

/**
 * Upper bound (inclusive) of the next chunk: the `limit`-th distinct entity
 * id after `after`, or the last one when fewer remain; NULL when none do.
 * A covering-index range read over the chunk's own threats.
 */
const BRAND_CHUNK_BOUND_SQL = `
    SELECT MAX(id) AS hi FROM (
      SELECT target_brand_id AS id FROM threats
      WHERE target_brand_id > ?
      GROUP BY target_brand_id ORDER BY target_brand_id LIMIT ?
    )`;

const PROVIDER_CHUNK_BOUND_SQL = `
    SELECT MAX(id) AS hi FROM (
      SELECT hosting_provider_id AS id FROM threats
      WHERE hosting_provider_id > ?
      GROUP BY hosting_provider_id ORDER BY hosting_provider_id LIMIT ?
    )`;

const SNAPSHOT_CHUNK_SQL: Record<SnapshotEntityType, string> = {
  brand: BRAND_SNAPSHOT_CHUNK_SQL,
  provider: PROVIDER_SNAPSHOT_CHUNK_SQL,
};

const CHUNK_BOUND_SQL: Record<SnapshotEntityType, string> = {
  brand: BRAND_CHUNK_BOUND_SQL,
  provider: PROVIDER_CHUNK_BOUND_SQL,
};

/**
 * True when `daily_snapshots` already holds at least one row of
 * `entityType` for `date`. A PK-prefix probe on (date, entity_type, …) —
 * reads one row, never scans the day's ~23K rows.
 */
export async function hasSnapshotsFor(
  db: D1Database,
  date: string,
  entityType: SnapshotEntityType,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM daily_snapshots WHERE date = ? AND entity_type = ? LIMIT 1")
    .bind(date, entityType)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Highest entity_id written for (date, entityType), or null. SQLite's
 * min/max optimisation answers this from the PK (date, entity_type,
 * entity_id) — one row read in prod.
 */
export async function lastSnapshotEntityId(
  db: D1Database,
  date: string,
  entityType: SnapshotEntityType,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(entity_id) AS last_id FROM daily_snapshots WHERE date = ? AND entity_type = ?")
    .bind(date, entityType)
    .first<{ last_id: string | null }>();
  return row?.last_id ?? null;
}

/**
 * Generate (or, with `resume`, finish) one entity type's snapshots for
 * `date`, chunk by chunk in entity_id order. Each chunk is one atomic
 * INSERT … SELECT; a throw propagates after the chunks before it have
 * committed (`onChunk` has seen their running total), and the next resume
 * pass continues after the last committed entity.
 */
export async function generateSnapshotType(
  db: D1Database,
  date: string,
  entityType: SnapshotEntityType,
  opts: GenerateSnapshotsOptions = {},
): Promise<SnapshotTypeResult> {
  const chunkSize = Math.max(1, Math.floor(opts.chunkSize ?? SNAPSHOT_CHUNK_SIZE));
  const now = opts.now ?? Date.now;

  let cursor = "";
  let resumed = false;
  if (opts.resume) {
    const last = await lastSnapshotEntityId(db, date, entityType);
    if (last !== null) {
      cursor = last;
      resumed = true;
    }
  }

  const retry = opts.retry;
  const attempt = <T>(fn: () => Promise<T>): Promise<T> => (retry ? withD1Retry(fn, retry) : fn());
  const sleep = opts.sleep ?? defaultSleep;

  let rows = 0;
  let chunks = 0;
  while (chunks < MAX_CHUNKS_PER_TYPE) {
    if (opts.deadline !== undefined && now() >= opts.deadline) {
      return { action: chunks > 0 || !resumed ? "generated" : "skipped", rows, complete: false, chunks };
    }
    const from = cursor;
    const bound = await attempt(() =>
      db
        .prepare(CHUNK_BOUND_SQL[entityType])
        .bind(from, chunkSize)
        .first<{ hi: string | null }>(),
    );
    const hi = bound?.hi ?? null;
    // hi > cursor by construction, so every iteration makes progress.
    if (hi === null || hi <= cursor) break;

    // Only between two chunk statements — never before the first or after the last.
    if (chunks > 0 && opts.interChunkPauseMs !== undefined && opts.interChunkPauseMs > 0) {
      await sleep(opts.interChunkPauseMs);
    }
    const res = await attempt(() =>
      db
        .prepare(SNAPSHOT_CHUNK_SQL[entityType])
        .bind(date, date, date, from, hi)
        .run(),
    );
    rows += res.meta.changes ?? 0;
    chunks += 1;
    cursor = hi;
    if (opts.onChunk) await opts.onChunk(rows);
  }

  const complete = chunks < MAX_CHUNKS_PER_TYPE;
  return { action: resumed && chunks === 0 ? "skipped" : "generated", rows, complete, chunks };
}

/**
 * Generate daily snapshots for a given date (defaults to today, UTC).
 * Uses INSERT OR REPLACE so a forced re-run never duplicates rows.
 * Brand first, then provider — a brand failure throws before provider
 * runs (manual endpoint semantics; the cron path isolates the two types).
 */
export async function generateDailySnapshots(
  db: D1Database,
  date?: string,
  opts: GenerateSnapshotsOptions = {},
): Promise<{ brandSnapshots: number; providerSnapshots: number }> {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const brand = await generateSnapshotType(db, targetDate, "brand", opts);
  const provider = await generateSnapshotType(db, targetDate, "provider", opts);
  return {
    brandSnapshots: brand.rows,
    providerSnapshots: provider.rows,
  };
}
