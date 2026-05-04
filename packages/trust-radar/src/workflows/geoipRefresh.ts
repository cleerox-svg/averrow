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
import { HttpZipReader } from '../lib/zip-reader';
import { R2ZipReader } from '../lib/r2-zip-reader';
import {
  runGeoipBlocksImport,
  prepareShadowTable as prepareShadowTableHelper,
  atomicSwap as atomicSwapHelper,
  type ZipReaderLike,
} from '../lib/geoip-import';

interface GeoipRefreshParams {
  /** Refresh log row id created by the geoip_refresh agent (or the
   *  manual-import admin endpoint) before workflow dispatch. Each
   *  step updates this row so the operator sees progress through
   *  `geo_ip_refresh_log` queries. */
  refreshLogId: string;
  /** Skip the "is this version already loaded?" guard. Useful when
   *  the operator wants a manual force-refresh after schema
   *  changes or partial loads. */
  forceReload?: boolean;
  /** When set, import from this R2 object key (in GEOIP_STAGING)
   *  instead of fetching from MaxMind. Enables operator-uploaded
   *  archives to bootstrap geo_ip_ranges without burning the daily
   *  MaxMind quota. Pair with `r2Sha256` so the next Sunday auto-
   *  poll's skip-if-current check matches against the right
   *  fingerprint. */
  r2Key?: string;
  /** SHA256 hex of the R2-staged archive. Stamped into
   *  `geo_ip_refresh_log.source_version` on success. Required when
   *  `r2Key` is set. */
  r2Sha256?: string;
}

interface GeoipRefreshEnv {
  GEOIP_DB: D1Database;
  GEOIP_REFRESH: Workflow;
  /** Optional when r2Key is set — the manual-import path doesn't
   *  hit MaxMind so it doesn't need the license key. The probe
   *  step throws if both are missing AND r2Key is unset. */
  MAXMIND_LICENSE_KEY?: string;
  /** R2 bucket holding operator-uploaded archives. Optional in
   *  the env — only required when r2Key is set on the workflow
   *  payload. */
  GEOIP_STAGING?: R2Bucket;
  AE?: AnalyticsEngineDataset;
}

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
    const r2Key = event.payload.r2Key;
    const r2Sha256 = event.payload.r2Sha256;
    const isManualR2Import = !!r2Key;

    if (isManualR2Import) {
      if (!r2Sha256 || !/^[0-9a-f]{40,}$/i.test(r2Sha256)) {
        throw new Error('r2Sha256 (full hex sha256 of the staged archive) is required when r2Key is set.');
      }
      if (!this.env.GEOIP_STAGING) {
        throw new Error('GEOIP_STAGING (R2) binding not configured — manual import path is unavailable.');
      }
    } else if (!this.env.MAXMIND_LICENSE_KEY) {
      throw new Error('MAXMIND_LICENSE_KEY not bound — workflow cannot start.');
    }

    const licenseKey = this.env.MAXMIND_LICENSE_KEY;
    const baseUrl = licenseKey
      ? `https://download.maxmind.com/app/geoip_download` +
        `?edition_id=GeoLite2-City-CSV&license_key=${encodeURIComponent(licenseKey)}`
      : '';

    // ── Step 1: probe ────────────────────────────────────────
    // Skipped for the manual-R2 path — the operator already supplied
    // the sha256 alongside the upload, so probing MaxMind would just
    // burn quota for no information. Build a synthetic `probe` with
    // the operator-supplied fingerprint instead.
    const probe = isManualR2Import
      ? { sha256First12: r2Sha256!.slice(0, 12), full: r2Sha256! }
      : await step.do(
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
    // Skipped for the manual-R2 path — the operator explicitly asked
    // for a manual import, presumably because the live data is empty
    // or stale. Running the no-op short-circuit here would silently
    // discard the upload.
    if (!isManualR2Import) {
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
    }

    await step.do('log-refresh-starting', async () => {
      const sourceLabel = isManualR2Import
        ? `R2 archive ${r2Key}`
        : `MaxMind release ${probe.sha256First12}`;
      await this.env.GEOIP_DB.prepare(`
        UPDATE geo_ip_refresh_log
        SET status = 'running',
            source_version = ?,
            error_message = ?
        WHERE id = ?
      `).bind(
        probe.sha256First12,
        `Loading from ${sourceLabel}...`,
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
        await prepareShadowTableHelper(this.env.GEOIP_DB);
      },
    );

    // ── Step 4: import (Locations + Blocks in one step) ─────
    // Both branches converge on the same `runGeoipBlocksImport`
    // helper — the only thing that varies is the byte source. The
    // Locations Map (~22 MB) lives entirely inside this step's
    // closure (held in Worker memory, never serialized as a step
    // return value). Returning the map across step boundaries
    // would blow the Workflows 1 MiB cap — verified in production
    // (2026-05-04: every prior attempt failed with "Step
    // import-locations-1 output is too large").
    //
    // Memory: 22 MB locations map + small streaming buffer ≈ 25 MB.
    // Worker ceiling is 128 MB, so plenty of headroom.
    //
    // Wall time: ~30 min worst-case (1× Locations parse, 1× Blocks
    // stream, ~3.5M D1 batched inserts). Step timeout is 1 hour.
    //
    // Retry semantics: a transient failure retries the whole step
    // from the start — re-fetching both CSVs and rebuilding the
    // Map. The shadow table's PRIMARY KEY constraint makes the
    // INSERT OR IGNORE re-run idempotent.
    const importResult = await step.do(
      'import',
      { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '1 hour' },
      async () => {
        let zip: ZipReaderLike;
        if (isManualR2Import) {
          const r2Reader = new R2ZipReader(this.env.GEOIP_STAGING!, r2Key!);
          await r2Reader.open();
          zip = r2Reader;
        } else {
          const archiveUrl = `${baseUrl}&suffix=zip`;
          const httpReader = new HttpZipReader(archiveUrl);
          await httpReader.open();
          zip = httpReader;
        }
        return await runGeoipBlocksImport(this.env.GEOIP_DB, zip);
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
      async () => atomicSwapHelper(this.env.GEOIP_DB),
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
