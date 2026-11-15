import type { FeedModule, FeedContext, FeedResult } from "./types";
import { readCappedText } from "../lib/capped-body";
import {
  ACTOR_REFERENCE_SOURCE,
  parseMispThreatActorGalaxy,
  type ActorReferenceRecord,
} from "../lib/actor-reference";

/**
 * MISP Galaxy threat-actor cluster → `actor_reference` +
 * `actor_reference_aliases` (feed key `actor_reference`, migration 0334).
 *
 * Reference data, not IOCs (same pattern as spamhaus_asn_drop): writes no
 * threats and always reports itemsNew = 0, so it never wakes Sentinel. It
 * never writes threat_actors / threat_attributions / cluster actor ids —
 * see lib/actor-reference.ts for why and for the one reader.
 *
 * Change-guarded: one read of (id, content_hash, removed_at) for the live
 * table, then an actor (and its aliases) is rewritten only when its
 * content_hash differs or it was marked removed. An unchanged upstream file
 * costs that one read and zero writes.
 *
 * Failure: HTTP error, body over MAX_BODY_BYTES, non-JSON, the wrong
 * galaxy (uuid/type check), fewer than MIN_PLAUSIBLE_ACTORS valid entries,
 * or every write batch failing → the pull throws (feed breaker applies).
 *
 * Removal: actors missing from the pull get removed_at ONLY when the pull is
 * complete — no malformed entries, every write batch landed, and the pull
 * holds at least MIN_RETAIN_RATIO of the actors currently live. Otherwise
 * the sweep is skipped with a warning, so a truncated or shrunken file can
 * never mass-remove the table.
 *
 * Licence: CC0 1.0 (MISP Galaxy is dual CC0 / BSD-2-Clause). Snapshot:
 * docs/licences/misp_galaxy.md.
 */

export const ACTOR_REFERENCE_URL =
  "https://raw.githubusercontent.com/MISP/misp-galaxy/main/clusters/threat-actor.json";
/** Upstream file was 1.46 MB on 2026-11-15. */
export const ACTOR_REFERENCE_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Upstream held 1,118 actors on 2026-11-15; far fewer = a broken file. */
export const ACTOR_REFERENCE_MIN_PLAUSIBLE_ACTORS = 500;
/** Removal sweep needs the pull to carry ≥ this share of the live rows. */
export const ACTOR_REFERENCE_MIN_RETAIN_RATIO = 0.8;
const FETCH_TIMEOUT_MS = 30_000;
/** Statements per db.batch (one actor = upsert + delete + ≤ few alias inserts). */
const MAX_STATEMENTS_PER_BATCH = 80;
/** ids per removal UPDATE (D1 caps a statement at 100 binds). */
const REMOVAL_CHUNK = 90;

function sqliteUtcStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

const UPSERT_SQL = `INSERT INTO actor_reference
    (id, source, source_uuid, name, country_code, state_sponsor, description,
     content_hash, source_version, first_seen, updated_at, removed_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL)
  ON CONFLICT(id) DO UPDATE SET
    name           = excluded.name,
    country_code   = excluded.country_code,
    state_sponsor  = excluded.state_sponsor,
    description    = excluded.description,
    content_hash   = excluded.content_hash,
    source_version = excluded.source_version,
    updated_at     = excluded.updated_at,
    removed_at     = NULL`;

const DELETE_ALIASES_SQL = `DELETE FROM actor_reference_aliases WHERE reference_id = ?`;

/** 4 binds per alias row; ≤ 20 rows per statement keeps it at 80 binds. */
const ALIAS_ROWS_PER_INSERT = 20;
function aliasInsertSql(rows: number): string {
  return `INSERT INTO actor_reference_aliases (reference_id, alias_norm, alias_original, position)
    VALUES ${Array.from({ length: rows }, () => "(?, ?, ?, ?)").join(", ")}
    ON CONFLICT(reference_id, alias_norm) DO NOTHING`;
}

interface ExistingRow { id: string; content_hash: string; removed_at: string | null }

/** Statements that (re)write one actor and its aliases, in FK-safe order. */
export function actorWriteStatements(
  db: D1Database,
  r: ActorReferenceRecord,
  sourceVersion: string | null,
  stamp: string,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [
    db.prepare(UPSERT_SQL).bind(
      r.id, ACTOR_REFERENCE_SOURCE, r.sourceUuid, r.name, r.countryCode, r.stateSponsor,
      r.description, r.contentHash, sourceVersion, stamp,
    ),
    db.prepare(DELETE_ALIASES_SQL).bind(r.id),
  ];
  for (let i = 0; i < r.aliases.length; i += ALIAS_ROWS_PER_INSERT) {
    const chunk = r.aliases.slice(i, i + ALIAS_ROWS_PER_INSERT);
    const binds: unknown[] = [];
    chunk.forEach((a, j) => binds.push(r.id, a.norm, a.original, i + j));
    stmts.push(db.prepare(aliasInsertSql(chunk.length)).bind(...binds));
  }
  return stmts;
}

/** Pure: should the removal sweep run for this pull? */
export function actorRemovalSweepAllowed(args: {
  malformed: number;
  batchFailures: number;
  parsed: number;
  liveBefore: number;
}): boolean {
  if (args.malformed > 0 || args.batchFailures > 0) return false;
  if (args.parsed < ACTOR_REFERENCE_MIN_PLAUSIBLE_ACTORS) return false;
  return args.parsed >= Math.ceil(args.liveBefore * ACTOR_REFERENCE_MIN_RETAIN_RATIO);
}

export const actor_reference: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;

    const res = await fetch(ACTOR_REFERENCE_URL, {
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`actor_reference: HTTP ${res.status} fetching threat-actor.json`);
    const text = await readCappedText(res, ACTOR_REFERENCE_MAX_BODY_BYTES);
    if (text === null) throw new Error(`actor_reference: body larger than ${ACTOR_REFERENCE_MAX_BODY_BYTES} bytes`);

    const parsed = await parseMispThreatActorGalaxy(text);
    if (parsed.records.length < ACTOR_REFERENCE_MIN_PLAUSIBLE_ACTORS) {
      throw new Error(
        `actor_reference: implausibly small galaxy (${parsed.records.length} valid actors, ${parsed.malformed} malformed, min ${ACTOR_REFERENCE_MIN_PLAUSIBLE_ACTORS})`,
      );
    }

    const existingRows = await db.prepare(
      `SELECT id, content_hash, removed_at FROM actor_reference WHERE source = ?`,
    ).bind(ACTOR_REFERENCE_SOURCE).all<ExistingRow>();
    const existing = new Map<string, ExistingRow>();
    for (const r of existingRows.results ?? []) existing.set(r.id, r);
    const liveBefore = [...existing.values()].filter((r) => r.removed_at === null).length;

    const changed = parsed.records.filter((r) => {
      const e = existing.get(r.id);
      return !e || e.content_hash !== r.contentHash || e.removed_at !== null;
    });

    const stamp = sqliteUtcStamp(new Date());
    let written = 0;
    let batchFailures = 0;
    let firstError: string | null = null;
    // Pack whole actors into batches so one actor's statements share a
    // transaction (a failed batch leaves the old hash → retried next pull).
    let pending: D1PreparedStatement[] = [];
    let pendingActors = 0;
    const flush = async () => {
      if (pending.length === 0) return;
      try {
        await db.batch(pending);
        written += pendingActors;
      } catch (e) {
        batchFailures++;
        if (!firstError) firstError = String(e).slice(0, 200);
      }
      pending = [];
      pendingActors = 0;
    };
    for (const r of changed) {
      const stmts = actorWriteStatements(db, r, parsed.version, stamp);
      if (pending.length + stmts.length > MAX_STATEMENTS_PER_BATCH) await flush();
      pending.push(...stmts);
      pendingActors++;
    }
    await flush();
    if (changed.length > 0 && written === 0) {
      throw new Error(`actor_reference: every write batch failed: ${firstError ?? "unknown error"}`);
    }

    const warnings: string[] = [];
    if (parsed.malformed > 0) warnings.push(`${parsed.malformed} malformed entries skipped`);
    if (batchFailures > 0) warnings.push(`${batchFailures} write batch(es) failed: ${firstError}`);

    // Removal sweep: live rows absent from this pull.
    const pulledIds = new Set(parsed.records.map((r) => r.id));
    const toRemove = [...existing.values()]
      .filter((r) => r.removed_at === null && !pulledIds.has(r.id))
      .map((r) => r.id);
    let removed = 0;
    if (toRemove.length > 0) {
      if (actorRemovalSweepAllowed({ malformed: parsed.malformed, batchFailures, parsed: parsed.records.length, liveBefore })) {
        for (let i = 0; i < toRemove.length; i += REMOVAL_CHUNK) {
          const chunk = toRemove.slice(i, i + REMOVAL_CHUNK);
          const r = await db.prepare(
            `UPDATE actor_reference SET removed_at = ?, updated_at = ?
              WHERE removed_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`,
          ).bind(stamp, stamp, ...chunk).run();
          removed += Number(r.meta?.changes ?? 0);
        }
      } else {
        warnings.push(`removal sweep skipped (${toRemove.length} missing; parsed ${parsed.records.length}, live ${liveBefore})`);
      }
    }

    return {
      itemsFetched: parsed.records.length,
      // Context feed: never counts as new threat items (Sentinel stays asleep).
      itemsNew: 0,
      // Actors now stored as upstream has them (unchanged + rewritten).
      itemsDuplicate: parsed.records.length - (changed.length - written),
      itemsError: batchFailures,
      ...(warnings.length > 0 ? { warning: `actor_reference: ${warnings.join("; ")}` } : {}),
    };
  },
};
