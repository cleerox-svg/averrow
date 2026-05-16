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

/** D1 batch limit is 100 statements per call. */
const D1_BATCH_LIMIT = 100;

export interface GeoipImportResult {
  rowsWritten: number;
  rowsParsed: number;
  locationsCount: number;
}

/**
 * Run the Locations + Blocks import against the shadow table
 * `geo_ip_ranges_new`. The caller is responsible for:
 *   - Calling `prepareShadowTable(db)` first (DROP+CREATE
 *     `geo_ip_ranges_new`)
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
): Promise<GeoipImportResult> {
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

  const flushBatch = async () => {
    if (pendingBatch.length === 0) return;
    const results = await db.batch(pendingBatch);
    for (const r of results) {
      rowsInsertedThisAttempt += r.meta?.changes ?? 0;
    }
    pendingBatch = [];
  };

  const { rowsParsed } = await streamBlocksCsv(blocksStream, async (row) => {
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

  return { rowsWritten, rowsParsed, locationsCount: locations.size };
}

/** DROP + CREATE the shadow table the import writes into. */
export async function prepareShadowTable(db: D1Database): Promise<void> {
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
