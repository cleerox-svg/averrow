/**
 * GeoIP Refresh Workflow — Phase 3.5: zero-touch in-Worker import.
 *
 * Pipeline shape
 * ──────────────
 *   Step 1  probe                → verify license key + fetch the
 *                                  release sha256 fingerprint
 *   Step 2  skip-if-current      → bail early if the live data
 *                                  already matches this sha256
 *   Step 3  prepare-shadow-table → drop+create geo_ip_ranges_new
 *   Step 4  import               → range-fetch + DEFLATE-decompress
 *                                  Locations CSV (~22 MB in-memory map),
 *                                  then range-fetch + decompress Blocks
 *                                  CSV, joining each Block to its
 *                                  Location and INSERT-OR-IGNORE'ing
 *                                  100 rows per D1 round-trip
 *   Step 5  atomic-swap          → DROP+RENAME so cartographer's
 *                                  next lookup hits the new data
 *   Step 6  finalize             → mark refresh log success +
 *                                  stamp source_version (sha256)
 *
 * No R2 dependency — `HttpZipReader` walks the MaxMind archive via
 * HTTP Range requests, so the Worker never holds more than ~1MB
 * of ZIP bytes in memory.
 *
 * Why Locations + Blocks are one step
 * ────────────────────────────────────
 * Workflows have a hard 1 MiB cap on each step's RETURN value
 * (serialized JSON). The Locations map is ~150K rows × ~150 bytes
 * ≈ 22 MB once Recordified — way over the cap. Returning the map
 * from "import-locations" so a separate "import-blocks" step could
 * use it threw `Step import-locations-1 output is too large` on
 * every attempt (production 2026-05-04). Keeping the map inside
 * one step's closure means it's never serialized, just held in
 * Worker memory (well under the 128 MB Worker ceiling).
 *
 * Memory profile
 * ──────────────
 *   - HEAD + EOCD + central directory ranges: ~1MB peak
 *   - Locations map (within the import step): ~22MB
 *   - Blocks streaming (within the import step): ~few KB at a time
 *
 * Recovery semantics
 * ──────────────────
 * Each step has its own retry policy. A network blip retries the
 * whole `import` step from the beginning — that re-fetches Locations
 * and Blocks. INSERT OR IGNORE against the shadow table's PRIMARY
 * KEY makes the re-run idempotent.
 *
 * The shadow table approach also means a partially-written failure
 * NEVER affects the live `geo_ip_ranges` until the atomic-swap step
 * runs at the very end. Cartographer's Phase 0.5 lookups continue
 * uninterrupted throughout.
 */

import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import {
  streamLocationsCsv,
  streamBlocksCsv,
  cidrToIntRange,
} from '../lib/geoip-csv';
import { HttpZipReader } from '../lib/zip-reader';

interface GeoipRefreshParams {
  /** Refresh log row id created by the geoip_refresh agent before
   *  workflow dispatch. Each step updates this row so the operator
   *  sees progress through `geo_ip_refresh_log` queries. */
  refreshLogId: string;
  /** Skip the "is this version already loaded?" guard. Useful when
   *  the operator wants a manual force-refresh after schema
   *  changes or partial loads. */
  forceReload?: boolean;
}

interface GeoipRefreshEnv {
  GEOIP_DB: D1Database;
  GEOIP_REFRESH: Workflow;
  MAXMIND_LICENSE_KEY: string;
  // Optional — AE binding is declared at the worker level so the
  // workflow gets it automatically. The `?` matches the main Env
  // interface where AE is also optional (test harnesses don't bind it).
  AE?: AnalyticsEngineDataset;
}

const LOCATIONS_FILENAME = 'GeoLite2-City-Locations-en.csv';
const BLOCKS_FILENAME = 'GeoLite2-City-Blocks-IPv4.csv';

/** D1 batch limit is 100 statements per call. Chunking the imports
 *  at 100 rows means each round-trip writes a full batch. Round-trip
 *  latency dominates beneath that, so smaller batches just increase
 *  total wall time. */
const D1_BATCH_LIMIT = 100;

export class GeoipRefreshWorkflow extends WorkflowEntrypoint<GeoipRefreshEnv, GeoipRefreshParams> {
  async run(event: WorkflowEvent<GeoipRefreshParams>, step: WorkflowStep) {
    const refreshLogId = event.payload.refreshLogId;
    try {
      return await this.runImpl(event, step);
    } catch (err) {
      // ─── Layer A: workflow failure handler ────────────────────
      // Per AGENT_STANDARD §15.1 "crashed" failure class — when a
      // step exhausts its retries the exception propagates here.
      // Without this catch, geo_ip_refresh_log stays in 'running'
      // forever (we'd otherwise only update the row in the
      // `finalize` step that never runs on failure). Logger writes
      // the structured failure for post-mortem; AE writeDataPoint
      // makes the failure-rate visible in Analytics Engine; we
      // re-throw so the Cloudflare Workflow runtime still marks
      // the instance failed (operator can see the same in the
      // Workflows dashboard).
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        await this.env.GEOIP_DB.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'failed',
              completed_at = datetime('now'),
              error_message = ?
          WHERE id = ? AND status = 'running'
        `).bind(`Workflow failed: ${errMsg.slice(0, 1000)}`, refreshLogId).run();
      } catch { /* logging is best-effort */ }
      try {
        this.env.AE?.writeDataPoint({
          blobs: ['geoip_refresh', 'workflow_failed', errMsg.slice(0, 100)],
          doubles: [0, 0],
          indexes: ['geoip_refresh'],
        });
      } catch { /* AE write is best-effort */ }
      throw err;
    }
  }

  private async runImpl(event: WorkflowEvent<GeoipRefreshParams>, step: WorkflowStep) {
    const refreshLogId = event.payload.refreshLogId;
    const forceReload = event.payload.forceReload ?? false;
    const licenseKey = this.env.MAXMIND_LICENSE_KEY;
    if (!licenseKey) {
      throw new Error('MAXMIND_LICENSE_KEY not bound — workflow cannot start.');
    }

    const baseUrl = `https://download.maxmind.com/app/geoip_download` +
      `?edition_id=GeoLite2-City-CSV&license_key=${encodeURIComponent(licenseKey)}`;

    // ── Step 1: probe ────────────────────────────────────────
    // Fetch the .sha256 fingerprint. Tiny request (~70 bytes)
    // that authenticates the key AND identifies the release.
    // Failure here prevents any wasted bandwidth on the full
    // archive download.
    const probe = await step.do(
      'probe',
      { retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
      async (): Promise<{ sha256First12: string; full: string }> => {
        const res = await fetch(`${baseUrl}&suffix=zip.sha256`);
        if (!res.ok) {
          throw new Error(`MaxMind probe ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        }
        const body = await res.text();
        const sha = body.trim().split(/\s+/)[0] ?? '';
        return { sha256First12: sha.slice(0, 12), full: sha };
      },
    );

    // ── Step 2: skip-if-current ──────────────────────────────
    // If the live geo_ip_ranges already came from this exact
    // sha256 (recorded as `source_version` on the most-recent
    // success row), there's nothing to do. Mark the refresh log
    // 'success' immediately and exit. This is what makes weekly
    // auto-polling cheap — most polls find no new release.
    const lastSuccess = await step.do(
      'check-last-version',
      async () => {
        const r = await this.env.GEOIP_DB.prepare(`
          SELECT source_version FROM geo_ip_refresh_log
          WHERE status = 'success'
          ORDER BY completed_at DESC
          LIMIT 1
        `).first<{ source_version: string | null }>();
        return r?.source_version ?? null;
      },
    );

    if (!forceReload && lastSuccess && probe.full.startsWith(lastSuccess)) {
      await step.do('mark-no-op', async () => {
        await this.env.GEOIP_DB.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'success',
              completed_at = datetime('now'),
              rows_written = 0,
              source_version = ?,
              error_message = ?
          WHERE id = ?
        `).bind(
          probe.sha256First12,
          `No-op: live data already matches MaxMind release ${probe.sha256First12}`,
          refreshLogId,
        ).run();
      });
      return {
        message: `No new release — already at ${probe.sha256First12}`,
        skipped: true,
        sha256: probe.sha256First12,
      };
    }

    await step.do('log-refresh-starting', async () => {
      await this.env.GEOIP_DB.prepare(`
        UPDATE geo_ip_refresh_log
        SET status = 'running',
            source_version = ?,
            error_message = ?
        WHERE id = ?
      `).bind(
        probe.sha256First12,
        `New release ${probe.sha256First12}; loading from MaxMind...`,
        refreshLogId,
      ).run();
    });

    // ── Step 3: prepare-shadow-table ─────────────────────────
    // Atomic-swap pattern: write to geo_ip_ranges_new, then rename
    // at the end. Concurrent cartographer Phase 0.5 lookups never
    // observe a half-loaded dataset.
    await step.do(
      'prepare-shadow-table',
      { retries: { limit: 2, delay: '5 seconds', backoff: 'constant' }, timeout: '60 seconds' },
      async () => {
        await this.env.GEOIP_DB.batch([
          this.env.GEOIP_DB.prepare(`DROP TABLE IF EXISTS geo_ip_ranges_new`),
          this.env.GEOIP_DB.prepare(`
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
          this.env.GEOIP_DB.prepare(
            `CREATE INDEX idx_geo_ip_end_new ON geo_ip_ranges_new(end_ip_int)`,
          ),
        ]);
      },
    );

    // ── Step 4: import (Locations + Blocks in one step) ─────
    // The Locations CSV has ~150K rows that we need keyed by
    // geonameId so each Block row can be joined by FK. As a
    // serialized Record this is ~22 MB — well past Workflows'
    // 1 MiB step-output cap. Pre-2026-05-04 we returned this map
    // from "import-locations" so a separate "import-blocks" step
    // could read it; every attempt failed with `Step output is too
    // large`. Keeping the map inside one step's closure (never
    // serialized) is the only architecture that fits.
    //
    // Memory: 22 MB locations map + small streaming buffer ≈ 25 MB.
    // Worker ceiling is 128 MB, so plenty of headroom.
    //
    // Wall time: ~30 min worst-case (1× Locations parse, 1× Blocks
    // stream, ~3.5M D1 batched inserts). Step timeout is 1 hour.
    //
    // Retry semantics: a transient failure retries the whole step
    // from the start — re-fetching both CSVs and rebuilding the
    // map. The shadow table's PRIMARY KEY constraint makes
    // INSERT OR IGNORE idempotent across retries.
    const importResult = await step.do(
      'import',
      { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '1 hour' },
      async (): Promise<{ rowsWritten: number; rowsParsed: number; locationsCount: number }> => {
        const archiveUrl = `${baseUrl}&suffix=zip`;
        const zip = new HttpZipReader(archiveUrl);
        await zip.open();

        // Phase 1: parse Locations into an in-step Map.
        const locEntry = zip.findEntry(LOCATIONS_FILENAME);
        if (!locEntry) {
          throw new Error(
            `Locations CSV missing in MaxMind archive — listed entries: ` +
            zip.listEntries().map((e) => e.name).slice(0, 5).join(', '),
          );
        }
        const locStream = await zip.streamEntry(locEntry);
        const locations = await streamLocationsCsv(locStream);

        // Phase 2: stream Blocks, joining each row by geonameId.
        const blocksEntry = zip.findEntry(BLOCKS_FILENAME);
        if (!blocksEntry) {
          throw new Error(`Blocks CSV missing in MaxMind archive`);
        }
        const blocksStream = await zip.streamEntry(blocksEntry);

        let pendingBatch: D1PreparedStatement[] = [];
        let rowsWritten = 0;

        const flushBatch = async () => {
          if (pendingBatch.length === 0) return;
          const results = await this.env.GEOIP_DB.batch(pendingBatch);
          for (const r of results) {
            rowsWritten += r.meta?.changes ?? 0;
          }
          pendingBatch = [];
        };

        const { rowsParsed } = await streamBlocksCsv(blocksStream, async (row) => {
          const range = cidrToIntRange(row.network);
          if (!range) return;
          const loc = row.geonameId
            ? locations.get(row.geonameId)
            : (row.registeredCountryGeonameId ? locations.get(row.registeredCountryGeonameId) : undefined);
          pendingBatch.push(
            this.env.GEOIP_DB.prepare(`
              INSERT OR IGNORE INTO geo_ip_ranges_new
                (start_ip_int, end_ip_int, country_code, country_name,
                 region, city, postal_code, lat, lng, asn, asn_org, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'maxmind-geolite2-city')
            `).bind(
              range.start, range.end,
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

        // Return only counters — small JSON, well under 1 MiB.
        return { rowsWritten, rowsParsed, locationsCount: locations.size };
      },
    );

    await step.do('log-import-done', async () => {
      await this.env.GEOIP_DB.prepare(`
        UPDATE geo_ip_refresh_log
        SET rows_written = ?,
            error_message = ?
        WHERE id = ?
      `).bind(
        importResult.rowsWritten,
        `Imported ${importResult.rowsWritten} of ${importResult.rowsParsed} parsed rows ` +
          `(${importResult.locationsCount} locations); preparing atomic swap.`,
        refreshLogId,
      ).run();
    });

    // ── Step 6: atomic-swap ──────────────────────────────────
    // Single D1 batch transaction. Either every operation lands or
    // none do — no broken-table window for cartographer lookups.
    const swapped = await step.do(
      'atomic-swap',
      { retries: { limit: 2, delay: '10 seconds', backoff: 'constant' }, timeout: '60 seconds' },
      async () => {
        const rowCountResult = await this.env.GEOIP_DB.prepare(
          `SELECT COUNT(*) AS n FROM geo_ip_ranges_new`,
        ).first<{ n: number }>();
        const newRowCount = rowCountResult?.n ?? 0;
        if (newRowCount === 0) {
          throw new Error('Atomic swap aborted: shadow table is empty.');
        }
        await this.env.GEOIP_DB.batch([
          this.env.GEOIP_DB.prepare(`DROP INDEX IF EXISTS idx_geo_ip_end`),
          this.env.GEOIP_DB.prepare(`DROP TABLE IF EXISTS geo_ip_ranges`),
          this.env.GEOIP_DB.prepare(
            `ALTER TABLE geo_ip_ranges_new RENAME TO geo_ip_ranges`,
          ),
          this.env.GEOIP_DB.prepare(`DROP INDEX IF EXISTS idx_geo_ip_end_new`),
          this.env.GEOIP_DB.prepare(
            `CREATE INDEX idx_geo_ip_end ON geo_ip_ranges(end_ip_int)`,
          ),
        ]);
        return { newRowCount };
      },
    );

    // ── Step 7: finalize ─────────────────────────────────────
    await step.do('finalize', async () => {
      await this.env.GEOIP_DB.prepare(`
        UPDATE geo_ip_refresh_log
        SET status = 'success',
            completed_at = datetime('now'),
            rows_written = ?,
            source_version = ?,
            error_message = ?
        WHERE id = ?
      `).bind(
        importResult.rowsWritten,
        probe.full,
        `MaxMind release ${probe.sha256First12} live: ${swapped.newRowCount} rows. Imported ${importResult.rowsWritten} of ${importResult.rowsParsed} parsed.`,
        refreshLogId,
      ).run();
    });

    // §14.2 — AE writeDataPoint per agent run / workflow run.
    // Lets the Agents page sparkline + cost dashboards reflect
    // refresh activity beyond the geo_ip_refresh_log table.
    try {
      this.env.AE?.writeDataPoint({
        blobs: ['geoip_refresh', 'success', 'maxmind-geolite2-city'],
        doubles: [importResult.rowsWritten, swapped.newRowCount],
        indexes: ['geoip_refresh'],
      });
    } catch { /* AE write is best-effort */ }

    return {
      message: `MaxMind release ${probe.sha256First12} imported: ${swapped.newRowCount} rows live.`,
      sha256: probe.full,
      rowsWritten: importResult.rowsWritten,
      rowsParsed: importResult.rowsParsed,
      liveRowCount: swapped.newRowCount,
    };
  }
}
