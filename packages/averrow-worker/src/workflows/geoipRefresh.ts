/**
 * GeoIP Refresh Workflow — Phase 3.5: zero-touch in-Worker import.
 *
 * Pipeline shape
 * ──────────────
 *   Step 1  probe                → verify license key + fetch the
 *                                  release sha256 fingerprint (1 metered
 *                                  MaxMind request)
 *   Step 2  skip-if-current      → bail early if the live data
 *                                  already matches this sha256
 *   Step 3  prepare-shadow-table → drop+create geo_ip_ranges_new
 *   Step 3.7 stage-to-r2         → ONE metered MaxMind GET, streamed
 *                                  straight into the GEOIP_STAGING R2
 *                                  bucket (auto path; manual path reuses
 *                                  the operator-uploaded key)
 *   Step 4  import               → R2 Range-read + DEFLATE-decompress
 *                                  Locations CSV (~22 MB in-memory map),
 *                                  then R2 Range-read + decompress Blocks
 *                                  CSV, joining each Block to its
 *                                  Location and INSERT-OR-IGNORE'ing
 *                                  100 rows per D1 round-trip
 *   Step 5  atomic-swap          → DROP+RENAME so cartographer's
 *                                  next lookup hits the new data
 *   Step 6  finalize             → mark refresh log success +
 *                                  stamp source_version (sha256)
 *   Step 7.5 cleanup             → delete the auto-staged R2 archive
 *
 * MaxMind quota hygiene — stage once, read from R2
 * ────────────────────────────────────────────────
 * MaxMind's `geoip_download` endpoint is metered (a daily download
 * quota per license key) and 302-redirects to its CDN, so EVERY
 * request to it — including HEAD and Range reads — counts against the
 * quota. The previous design pointed `HttpZipReader` directly at that
 * endpoint, paying ~7 metered requests per import attempt and re-paying
 * them on each of the import step's 3 retries; a single run could
 * exhaust the quota (the "Daily GeoIP Download Limit Reached" email).
 * We now do exactly ONE metered GET (step 3.7), stream it to R2, and
 * Range-read the archive from R2 (internal, free, non-expiring) for the
 * import. Import-step retries — and even FC re-dispatches of the same
 * release — cost zero MaxMind requests (step 3.7 head-checks R2 first).
 * A 429 from the probe or the staging GET stamps the shared
 * `geoip:maxmind:cooldown_until` KV key so the agent + FC stop
 * re-dispatching until the window resets.
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
 *   - stage-to-r2: HTTP body streamed straight into R2 — never buffered
 *   - EOCD + central directory R2 ranges: ~1MB peak
 *   - Locations map (within the import step): ~22MB
 *   - Blocks streaming (within the import step): ~few KB at a time
 *
 * Recovery semantics
 * ──────────────────
 * Each step has its own retry policy. A network blip retries the
 * whole `import` step from the beginning — that re-reads Locations
 * and Blocks from the staged R2 object (no MaxMind cost). INSERT OR
 * IGNORE against the shadow table's PRIMARY KEY makes the re-run
 * idempotent.
 *
 * The shadow table approach also means a partially-written failure
 * NEVER affects the live `geo_ip_ranges` until the atomic-swap step
 * runs at the very end. Cartographer's Phase 0.5 lookups continue
 * uninterrupted throughout.
 */

import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { R2ZipReader } from '../lib/r2-zip-reader';
import {
  runGeoipBlocksImport,
  runGeoipDiffImport,
  prepareShadowTable as prepareShadowTableHelper,
  atomicSwap as atomicSwapHelper,
} from '../lib/geoip-import';

/** Days between forced full rebuilds (quarterly GC of dropped ranges). */
const FULL_REBUILD_MAX_AGE_DAYS = 85;

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
  /** R2 bucket holding both operator-uploaded archives AND the
   *  auto-poll path's staged MaxMind download. Required for the
   *  MaxMind path now that we stage-once-then-read-from-R2 (see
   *  the stage-to-r2 step) instead of Range-reading MaxMind's
   *  metered endpoint ~7×/import. */
  GEOIP_STAGING?: R2Bucket;
  AE?: AnalyticsEngineDataset;
  /** KV used to stamp the MaxMind 429 cooldown from inside the
   *  workflow. Previously only the geoip_refresh agent's pre-flight
   *  probe stamped this key — so when the WORKFLOW (probe / archive
   *  download) hit a 429 mid-run, nothing recorded the cooldown and
   *  FC's staleness self-heal re-dispatched ~6h later, re-downloading
   *  and re-tripping the daily quota (the "Daily GeoIP Download Limit
   *  Reached" email loop). Stamping here breaks that loop. Same key
   *  the agent reads: `geoip:maxmind:cooldown_until`. */
  CACHE?: KVNamespace;
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

  /**
   * Stamp the shared 24h MaxMind 429 cooldown so the geoip_refresh
   * agent + Flight Control's staleness self-heal refuse to re-dispatch
   * (and re-download) until the quota window resets. Mirrors the
   * agent's Layer-D logic (geoip-refresh.ts) using the same KV key.
   * Best-effort — a KV miss must never mask the underlying 429.
   */
  private async stampMaxMindCooldown(reason: string): Promise<void> {
    if (!this.env.CACHE) return;
    try {
      const until = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      await this.env.CACHE.put('geoip:maxmind:cooldown_until', until, {
        expirationTtl: 24 * 60 * 60,
      });
      console.warn(`[geoip-workflow] MaxMind 429 cooldown stamped until ${until} (${reason})`);
    } catch { /* best-effort */ }
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
            const res = await fetch(`${baseUrl}&suffix=zip.sha256`, { signal: AbortSignal.timeout(20_000) });
            if (res.status === 429) {
              // Daily quota exhausted. Stamp the cooldown and fail the
              // whole workflow immediately — retrying the probe would
              // just burn more quota against a wall that won't move
              // until the 24h window resets.
              await this.stampMaxMindCooldown('probe saw HTTP 429');
              throw new NonRetryableError('MaxMind probe 429 — daily download quota exhausted. Cooldown stamped.');
            }
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

    // ── decide-mode: in-place diff vs full rebuild ───────────
    // Diff writes only changed rows (~1-5% of the table) instead of
    // rebuilding all ~3.76M. A FULL rebuild is forced when: the operator
    // asked for one (forceReload), it's a manual R2 import, the live
    // table is empty (bootstrap), or no successful full rebuild has run
    // in FULL_REBUILD_MAX_AGE_DAYS (quarterly GC of ranges MaxMind
    // dropped + a clean repopulation of row_hash). Otherwise diff.
    // Historical log rows have mode=NULL, so the first post-deploy run
    // finds no tracked full rebuild and runs full — which populates
    // row_hash on every row so subsequent diffs have hashes to compare.
    const mode = await step.do('decide-mode', async (): Promise<'full' | 'diff'> => {
      if (forceReload || isManualR2Import) return 'full';
      const live = await this.env.GEOIP_DB
        .prepare(`SELECT COUNT(*) AS n FROM geo_ip_ranges`)
        .first<{ n: number }>();
      if ((live?.n ?? 0) === 0) return 'full';
      const lastFull = await this.env.GEOIP_DB.prepare(`
        SELECT completed_at FROM geo_ip_refresh_log
         WHERE status = 'success' AND mode = 'full'
         ORDER BY completed_at DESC LIMIT 1
      `).first<{ completed_at: string | null }>();
      if (!lastFull?.completed_at) return 'full';
      const ageDays = (Date.now() - Date.parse(lastFull.completed_at)) / 86_400_000;
      return ageDays >= FULL_REBUILD_MAX_AGE_DAYS ? 'full' : 'diff';
    });

    // ── Step 3: prepare-shadow-table (FULL path only) ────────
    // Atomic-swap pattern: write to geo_ip_ranges_new, then rename
    // at the end. Concurrent cartographer Phase 0.5 lookups never
    // observe a half-loaded dataset.
    //
    // Resume support (Step 3 of D1 write-hotspot remediation, audit
    // notes 2026-05-24): if the log row carries a non-zero
    // last_committed_row AND shadow_version matches the version we're
    // about to load, KEEP the existing shadow and resume from the
    // checkpoint. Otherwise drop + create fresh.
    //
    // Mismatch handling: a different shadow_version means the orphan
    // came from an earlier MaxMind release; mixing rows from two
    // releases would corrupt the lookup. The DROP path handles it.
    let resumeState: { resumeFromRow: number; versionMatches: boolean } = {
      resumeFromRow: 0,
      versionMatches: false,
    };
    if (mode === 'full') {
      resumeState = await step.do('check-resume', async () => {
        const row = await this.env.GEOIP_DB.prepare(`
          SELECT last_committed_row, shadow_version
            FROM geo_ip_refresh_log
           WHERE id = ?
        `).bind(refreshLogId).first<{
          last_committed_row: number | null;
          shadow_version: string | null;
        }>();
        const checkpoint = row?.last_committed_row ?? 0;
        const matches = row?.shadow_version === probe.sha256First12;
        return {
          resumeFromRow: matches && checkpoint > 0 ? checkpoint : 0,
          versionMatches: matches,
        };
      });

      await step.do(
        'prepare-shadow-table',
        { retries: { limit: 2, delay: '5 seconds', backoff: 'constant' }, timeout: '60 seconds' },
        async () => {
          const { keptExisting } = await prepareShadowTableHelper(
            this.env.GEOIP_DB,
            { keepExisting: resumeState.resumeFromRow > 0 },
          );
          if (keptExisting) {
            console.log(
              `[geoip-workflow] resuming from row ${resumeState.resumeFromRow} ` +
              `(shadow_version match)`,
            );
          } else {
            // Fresh start: stamp the new shadow_version + reset the
            // checkpoint. Done here (not in log-refresh-starting) so the
            // reset is paired atomically with the shadow recreation.
            await this.env.GEOIP_DB.prepare(`
              UPDATE geo_ip_refresh_log
                 SET shadow_version = ?,
                     last_committed_row = 0
               WHERE id = ?
            `).bind(probe.sha256First12, refreshLogId).run();
          }
        },
      );
    }

    // ── Step 3.7: stage-to-r2 (MaxMind path only) ────────────
    // Download the archive to R2 in a SINGLE metered request, then
    // let the import step Range-read from R2 (free, no expiry).
    //
    // Why: the previous design pointed HttpZipReader straight at
    // MaxMind's `geoip_download` endpoint, which 302-redirects to
    // the CDN — so EVERY HEAD/Range request (HEAD + EOCD tail + central
    // directory + 2× local-header + 2× entry body ≈ 7 per import) hit
    // the *metered* endpoint, and each of the import step's 3 retries
    // re-paid that ≈7. A single fully-retrying import could exhaust the
    // daily quota on its own (the "Daily GeoIP Download Limit Reached"
    // email). Staging once collapses that to exactly ONE metered GET
    // per refresh; import-step retries then read from R2 at zero
    // MaxMind cost.
    //
    // Reuse: keyed by the release sha256, and we head-check before
    // downloading. If a prior failed attempt (or an FC re-dispatch of
    // the same release) already staged this archive, we reuse it and
    // skip the download entirely — so even cross-workflow retries cost
    // zero MaxMind requests.
    //
    // The manual-R2 path keeps using the operator-supplied r2Key as-is.
    const stagingKey = isManualR2Import
      ? r2Key!
      : await step.do(
          'stage-to-r2',
          { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
          async (): Promise<string> => {
            if (!this.env.GEOIP_STAGING) {
              throw new NonRetryableError(
                'GEOIP_STAGING (R2) binding not configured — cannot stage MaxMind archive.',
              );
            }
            const key = `auto/GeoLite2-City-CSV_${probe.sha256First12}.zip`;

            // Reuse an already-staged copy of this exact release.
            const existing = await this.env.GEOIP_STAGING.head(key).catch(() => null);
            if (existing && existing.size > 1024) {
              console.log(`[geoip-workflow] reusing staged archive ${key} (${existing.size} bytes) — no MaxMind download`);
              return key;
            }

            const archiveUrl = `${baseUrl}&suffix=zip`;
            const res = await fetch(archiveUrl, { signal: AbortSignal.timeout(240_000) });
            if (res.status === 429) {
              await this.stampMaxMindCooldown('stage-to-r2 saw HTTP 429');
              throw new NonRetryableError(
                'MaxMind archive download 429 — daily download quota exhausted. Cooldown stamped.',
              );
            }
            if (!res.ok || !res.body) {
              throw new Error(`MaxMind archive download ${archiveUrl} → ${res.status}`);
            }
            // Stream the body straight into R2 — never buffer the
            // ~80MB archive in Worker memory.
            await this.env.GEOIP_STAGING.put(key, res.body);
            return key;
          },
        );

    // ── Step 4/5: import + commit ────────────────────────────
    // Two strategies (decided above). Both read the archive from the
    // staged R2 object — R2 Range reads are internal/free and never
    // expire, so step retries cost zero MaxMind requests. The Locations
    // Map (~22 MB) lives entirely inside the step closure (held in
    // Worker memory, never serialized across a step boundary — returning
    // it would blow the Workflows 1 MiB cap; verified in production
    // 2026-05-04 "Step import-locations-1 output is too large").
    let liveRowCount = 0;
    let rowsWritten = 0;
    let rowsParsed = 0;
    let summaryMessage = '';

    if (mode === 'diff') {
      // In-place diff: write only changed rows + delete dropped ranges
      // (~1-5% of the table vs a full ~3.76M rebuild). Idempotent — a
      // retry re-diffs and writes nothing already applied — and each D1
      // batch is transactional, so cartographer's range lookups never
      // observe a torn table. No shadow/swap needed.
      const diffResult = await step.do(
        'diff-apply',
        { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '2 hours' },
        async () => {
          const zip = new R2ZipReader(this.env.GEOIP_STAGING!, stagingKey);
          await zip.open();
          return await runGeoipDiffImport(this.env.GEOIP_DB, zip, {
            onProgress: async (rowsProcessed) => {
              await this.env.GEOIP_DB.prepare(`
                UPDATE geo_ip_refresh_log SET last_committed_row = ? WHERE id = ?
              `).bind(rowsProcessed, refreshLogId).run();
            },
          });
        },
      );

      const liveCount = await step.do('count-live', async () => {
        const r = await this.env.GEOIP_DB
          .prepare(`SELECT COUNT(*) AS n FROM geo_ip_ranges`)
          .first<{ n: number }>();
        return r?.n ?? 0;
      });

      const changed = diffResult.rowsInserted + diffResult.rowsUpdated;
      summaryMessage =
        `Diff vs MaxMind ${probe.sha256First12}: +${diffResult.rowsInserted} ` +
        `~${diffResult.rowsUpdated} -${diffResult.rowsDeleted} ` +
        `(${diffResult.rowsUnchanged} unchanged of ${diffResult.rowsParsed} parsed); ` +
        `${liveCount} rows live.`;

      await step.do('finalize-diff', async () => {
        await this.env.GEOIP_DB.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'success',
              completed_at = datetime('now'),
              rows_written = ?,
              rows_deleted = ?,
              mode = 'diff',
              source_version = ?,
              error_message = ?
          WHERE id = ?
        `).bind(changed, diffResult.rowsDeleted, probe.full, summaryMessage, refreshLogId).run();
      });

      liveRowCount = liveCount;
      rowsWritten = changed;
      rowsParsed = diffResult.rowsParsed;
    } else {
      // ── Full rebuild: shadow-table import + atomic swap ──
      // Used on bootstrap, operator force, manual R2 import, and the
      // ~quarterly GC. Timeout 2h: the clean 2026-05-16 run took ~50 min;
      // the per-batch checkpoint + INSERT OR IGNORE make a long run
      // resumable (the loader stream-skips already-committed rows on
      // retry — only NEW work hits D1).
      const importResult = await step.do(
        'import',
        { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '2 hours' },
        async () => {
          const zip = new R2ZipReader(this.env.GEOIP_STAGING!, stagingKey);
          await zip.open();
          return await runGeoipBlocksImport(this.env.GEOIP_DB, zip, {
            resumeFromRow: resumeState.resumeFromRow,
            onProgress: async (rowsProcessed) => {
              await this.env.GEOIP_DB.prepare(`
                UPDATE geo_ip_refresh_log
                   SET last_committed_row = ?
                 WHERE id = ?
              `).bind(rowsProcessed, refreshLogId).run();
            },
          });
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

      // ── atomic-swap ──
      // Single D1 batch transaction. Either every operation lands or
      // none do — no broken-table window for cartographer lookups.
      const swapped = await step.do(
        'atomic-swap',
        { retries: { limit: 2, delay: '10 seconds', backoff: 'constant' }, timeout: '60 seconds' },
        async () => atomicSwapHelper(this.env.GEOIP_DB),
      );

      summaryMessage =
        `MaxMind release ${probe.sha256First12} live: ${swapped.newRowCount} rows. ` +
        `Imported ${importResult.rowsWritten} of ${importResult.rowsParsed} parsed.`;

      // ── finalize ──
      await step.do('finalize', async () => {
        await this.env.GEOIP_DB.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'success',
              completed_at = datetime('now'),
              rows_written = ?,
              rows_deleted = 0,
              mode = 'full',
              source_version = ?,
              error_message = ?
          WHERE id = ?
        `).bind(importResult.rowsWritten, probe.full, summaryMessage, refreshLogId).run();
      });

      liveRowCount = swapped.newRowCount;
      rowsWritten = importResult.rowsWritten;
      rowsParsed = importResult.rowsParsed;
    }

    // ── Step 7.5: cleanup auto-staged archive ────────────────
    // The auto-poll path staged ~80MB to R2 in step 3.7; once the
    // swap has landed we don't need it (a same-release re-run would
    // short-circuit at skip-if-current). The manual-upload path's
    // r2Key is operator-owned — leave it untouched. Best-effort; an
    // orphaned object just wastes a little R2, never correctness.
    if (!isManualR2Import && this.env.GEOIP_STAGING) {
      await step.do('cleanup-staged-archive', async () => {
        try {
          await this.env.GEOIP_STAGING!.delete(stagingKey);
        } catch { /* best-effort — orphan cleanup is not load-bearing */ }
      });
    }

    // §14.2 — AE writeDataPoint per agent run / workflow run.
    // Lets the Agents page sparkline + cost dashboards reflect
    // refresh activity beyond the geo_ip_refresh_log table.
    try {
      this.env.AE?.writeDataPoint({
        blobs: ['geoip_refresh', 'success', `maxmind-geolite2-city:${mode}`],
        doubles: [rowsWritten, liveRowCount],
        indexes: ['geoip_refresh'],
      });
    } catch { /* AE write is best-effort */ }

    return {
      message: summaryMessage,
      sha256: probe.full,
      mode,
      rowsWritten,
      rowsParsed,
      liveRowCount,
    };
  }
}
