// Shared GeoIP import logic. Used by:
//   - workflows/geoipRefresh.ts (the weekly auto-poll that fetches
//     from MaxMind via HttpZipReader)
//   - the manual-import path that the admin endpoint dispatches
//     against an operator-uploaded archive in R2 (R2ZipReader)
//
// Both code paths share the same Locations + Blocks parse + D1
// shadow-table write logic. The only thing that varies is the
// byte source — encapsulated by `ZipReaderLike`.

import {
  streamLocationsCsv,
  streamBlocksCsv,
  cidrToIntRange,
} from "./geoip-csv";
import type { ZipEntry } from "./zip-internals";

/**
 * Structural type for "anything that can hand us decompressed CSV
 * streams". Both `HttpZipReader` and `R2ZipReader` satisfy this
 * shape — we don't import either concretely so this module stays
 * decoupled from the byte-fetch backend.
 */
export interface ZipReaderLike {
  findEntry(nameOrBasename: string): ZipEntry | null;
  listEntries(): ZipEntry[];
  streamEntry(entry: ZipEntry): Promise<ReadableStream<Uint8Array>>;
}

const LOCATIONS_FILENAME = "GeoLite2-City-Locations-en.csv";
const BLOCKS_FILENAME = "GeoLite2-City-Blocks-IPv4.csv";

/**
 * D1 batch size for the GeoIP import.
 *
 * D1 allows up to 1000 statements per batch() call. The historical
 * value here was 100 — conservative, but it produced ~37K batches per
 * refresh × ~3.7M rows, consuming proportionally more D1 query budget
 * than the row writes themselves. Audit 2026-05-24 (see plan file):
 * 5.16M queries for 2.95M row writes in a single 24h window, which is
 * #1 by query-count among write hotspots.
 *
 * Bumped to 500 — a 5x query-count reduction without giving up the
 * fine-grained checkpointing each batch flush represents (still 7K+
 * commit points per refresh for the resume-offset path in plan step 3).
 * Stays well under D1's 1000-statement cap and the worker subrequest
 * body-size budget (~80 bytes × 500 = 40 KB per batch).
 */
const D1_BATCH_LIMIT = 500;

export interface GeoipImportResult {
  rowsWritten: number;
  rowsParsed: number;
  locationsCount: number;
  /** Index of the last row that was actually processed (i.e. parsed
   *  and either inserted or skipped via resumeFromRow). Equal to
   *  rowsParsed on a clean run. Surfaced so the workflow can stamp
   *  it into geo_ip_refresh_log.last_committed_row as the final
   *  checkpoint. */
  lastRowIndex: number;
}

export interface GeoipImportOptions {
  /**
   * Resume mode (Step 3 of D1 write-hotspot remediation). When set,
   * the streaming loop reads and parses the first `resumeFromRow`
   * Blocks CSV rows BUT does not push them to the D1 batch — the
   * assumption is those rows were already INSERT-OR-IGNORE'd into
   * `geo_ip_ranges_new` by a previous failed attempt. After
   * resumeFromRow, normal batch+flush resumes.
   *
   * MaxMind Blocks CSV is order-stable (sorted by network address)
   * within a single release, so row N in attempt 2 is the same
   * key as row N in attempt 1. The caller is responsible for
   * verifying source version match BEFORE setting this — different
   * MaxMind releases would have different row orderings and
   * resumeFromRow would skip the wrong rows.
   *
   * 0 (default) = fresh-start mode: process every row.
   */
  resumeFromRow?: number;

  /**
   * Called after every successful batch flush with the count of
   * Blocks CSV rows processed so far. Caller persists this to
   * geo_ip_refresh_log.last_committed_row so a subsequent retry
   * can pass it back as resumeFromRow.
   *
   * The callback runs once per ~500 rows (D1_BATCH_LIMIT). It MUST
   * be a single D1 UPDATE — anything heavier compounds with the
   * batch flush cost. Errors are swallowed (logged via console.warn)
   * so a transient D1 hiccup on the progress write can't kill an
   * otherwise-healthy import.
   */
  onProgress?: (rowsProcessed: number) => Promise<void>;
}

/**
 * Run the Locations + Blocks import against the shadow table
 * `geo_ip_ranges_new`. The caller is responsible for:
 *   - Calling `prepareShadowTable(db)` first (DROP+CREATE
 *     `geo_ip_ranges_new`, unless resuming)
 *   - Calling `atomicSwap(db)` after to flip into production
 *
 * Single-step design (no separate Locations / Blocks return value)
 * because Cloudflare Workflows enforce a 1 MiB cap per step output.
 * The Locations Map (~22 MB serialized) MUST stay inside this
 * function's closure — never returned across a Workflow step
 * boundary.
 */
export async function runGeoipBlocksImport(
  db: D1Database,
  zip: ZipReaderLike,
  options: GeoipImportOptions = {},
): Promise<GeoipImportResult> {
  const resumeFromRow = options.resumeFromRow ?? 0;
  const onProgress = options.onProgress;

  const locEntry = zip.findEntry(LOCATIONS_FILENAME);
  if (!locEntry) {
    throw new Error(
      `Locations CSV missing in archive — listed entries: ` +
        zip.listEntries().map((e) => e.name).slice(0, 5).join(", "),
    );
  }
  const locStream = await zip.streamEntry(locEntry);
  const locations = await streamLocationsCsv(locStream);

  const blocksEntry = zip.findEntry(BLOCKS_FILENAME);
  if (!blocksEntry) {
    throw new Error(`Blocks CSV missing in archive`);
  }
  const blocksStream = await zip.streamEntry(blocksEntry);

  let pendingBatch: D1PreparedStatement[] = [];
  let rowsInsertedThisAttempt = 0;
  let rowsProcessed = 0;          // counts every parsed Blocks row, skipped or written
  let skippedForResume = 0;       // diagnostic counter

  const flushBatch = async () => {
    if (pendingBatch.length === 0) return;
    const results = await db.batch(pendingBatch);
    for (const r of results) {
      rowsInsertedThisAttempt += r.meta?.changes ?? 0;
    }
    pendingBatch = [];
    if (onProgress) {
      try {
        await onProgress(rowsProcessed);
      } catch (err) {
        // Progress write failure is non-fatal — the import keeps going
        // and the next flush will re-attempt the UPDATE. Worst case
        // a retry has a stale offset and re-processes ~500 rows.
        console.warn(
          `[geoip-import] onProgress failed at row ${rowsProcessed}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const { rowsParsed } = await streamBlocksCsv(blocksStream, async (row) => {
    rowsProcessed++;
    // Resume mode: skip rows already committed by a previous attempt.
    // The CSV still has to be parsed (the gzip stream isn't seekable
    // and Blocks is monolithic), but we avoid the D1 work — which is
    // the expensive part. INSERT OR IGNORE remains the safety net
    // against any off-by-one in resumeFromRow.
    if (rowsProcessed <= resumeFromRow) {
      skippedForResume++;
      return;
    }
    const range = cidrToIntRange(row.network);
    if (!range) return;
    const loc = row.geonameId
      ? locations.get(row.geonameId)
      : row.registeredCountryGeonameId
        ? locations.get(row.registeredCountryGeonameId)
        : undefined;
    pendingBatch.push(
      db.prepare(`
        INSERT OR IGNORE INTO geo_ip_ranges_new
          (start_ip_int, end_ip_int, country_code, country_name,
           region, city, postal_code, lat, lng, asn, asn_org, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'maxmind-geolite2-city')
      `).bind(
        range.start,
        range.end,
        loc?.countryCode ?? null,
        loc?.countryName ?? null,
        loc?.region ?? null,
        loc?.city ?? null,
        row.postalCode,
        row.lat,
        row.lng,
      ),
    );
    if (pendingBatch.length >= D1_BATCH_LIMIT) {
      await flushBatch();
    }
  });
  await flushBatch();
  if (skippedForResume > 0) {
    console.log(
      `[geoip-import] resumed at row ${resumeFromRow}; skipped ${skippedForResume} ` +
      `previously-committed rows, processed ${rowsProcessed - skippedForResume} new rows`,
    );
  }

  // Final shadow-table row count is the truthful "what's in the DB now"
  // value — survives CF Workflow step retries. The per-attempt change
  // counter (`rowsInsertedThisAttempt`) only counts rows this specific
  // attempt actually wrote; a retry after a partial-success pass would
  // hit INSERT OR IGNORE on already-inserted rows, returning changes=0
  // and reporting a tiny rowsWritten despite the shadow table being
  // fully populated. Production 2026-05-05 logged "Imported 744617 of
  // 3701317 parsed" while the shadow table actually held all 3.7M rows.
  const finalCountRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM geo_ip_ranges_new`)
    .first<{ n: number }>();
  const rowsWritten = finalCountRow?.n ?? rowsInsertedThisAttempt;

  return { rowsWritten, rowsParsed, locationsCount: locations.size, lastRowIndex: rowsProcessed };
}

export interface PrepareShadowOptions {
  /**
   * Resume mode: if the shadow table already exists and the caller has
   * verified its source_version matches the version about to load
   * (see geo_ip_refresh_log.shadow_version), pass true to leave it
   * intact. The import call will then skip rows already committed.
   *
   * Default false: drop + create (fresh start), preserving the
   * pre-Step-3 behavior for any caller that doesn't opt in.
   */
  keepExisting?: boolean;
}

/**
 * DROP + CREATE the shadow table the import writes into. When
 * `keepExisting: true`, no-ops if the shadow table already exists
 * (resume path). The caller is responsible for verifying version
 * match before requesting keepExisting.
 */
export async function prepareShadowTable(
  db: D1Database,
  options: PrepareShadowOptions = {},
): Promise<{ keptExisting: boolean }> {
  if (options.keepExisting) {
    const exists = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='geo_ip_ranges_new'`,
      )
      .first<{ name: string }>();
    if (exists) {
      return { keptExisting: true };
    }
    // keepExisting was requested but the shadow doesn't exist (e.g. a
    // prior cleanup dropped it). Fall through to fresh create.
  }
  await db.batch([
    db.prepare(`DROP TABLE IF EXISTS geo_ip_ranges_new`),
    db.prepare(`
      CREATE TABLE geo_ip_ranges_new (
        start_ip_int INTEGER PRIMARY KEY NOT NULL,
        end_ip_int   INTEGER NOT NULL,
        country_code TEXT,
        country_name TEXT,
        region       TEXT,
        city         TEXT,
        postal_code  TEXT,
        lat          REAL,
        lng          REAL,
        asn          TEXT,
        asn_org      TEXT,
        source       TEXT NOT NULL,
        loaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `),
    db.prepare(
      `CREATE INDEX idx_geo_ip_end_new ON geo_ip_ranges_new(end_ip_int)`,
    ),
  ]);
  return { keptExisting: false };
}

/**
 * Single transactional swap from `geo_ip_ranges_new` to
 * `geo_ip_ranges`. Throws if the shadow table is empty (defends
 * against accidentally swapping in a no-op).
 */
export async function atomicSwap(
  db: D1Database,
): Promise<{ newRowCount: number }> {
  const rowCountResult = await db
    .prepare(`SELECT COUNT(*) AS n FROM geo_ip_ranges_new`)
    .first<{ n: number }>();
  const newRowCount = rowCountResult?.n ?? 0;
  if (newRowCount === 0) {
    throw new Error("Atomic swap aborted: shadow table is empty.");
  }
  await db.batch([
    db.prepare(`DROP INDEX IF EXISTS idx_geo_ip_end`),
    db.prepare(`DROP TABLE IF EXISTS geo_ip_ranges`),
    db.prepare(
      `ALTER TABLE geo_ip_ranges_new RENAME TO geo_ip_ranges`,
    ),
    db.prepare(`DROP INDEX IF EXISTS idx_geo_ip_end_new`),
    db.prepare(
      `CREATE INDEX idx_geo_ip_end ON geo_ip_ranges(end_ip_int)`,
    ),
  ]);
  return { newRowCount };
}
