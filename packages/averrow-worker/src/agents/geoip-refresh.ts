/**
 * GeoIP Refresh — populates the dedicated GEOIP_DB with MaxMind
 * GeoLite2 City ranges (or db-ip Lite as a fallback).
 *
 * Cadence: monthly is enough — geographic ranges shift on the order
 * of weeks. Wired into the orchestrator hourly tick on the 1st of
 * the month at 04:07 UTC (gated inside flightControlAgent / index.ts
 * — no dedicated cron; Cloudflare's cron parser doesn't accept
 * day-of-month-and-hour combinations cleanly).
 *
 * Why an agent (not a feed):
 *   - Feeds populate `threats` with new threat records. This agent
 *     populates a reference table (`geo_ip_ranges`) used to enrich
 *     existing threats. Different write target, different cadence.
 *   - Refresh is a multi-phase durable operation (download, parse,
 *     batch write) — agent_runs lifecycle gives operators a clean
 *     status row and per-run records_processed.
 *
 * Refresh strategy:
 *   1. Download GeoLite2-City CSV from MaxMind permalink (requires
 *      MAXMIND_LICENSE_KEY).
 *   2. Stage to R2 (`GEOIP_STAGING`) so the parse phase doesn't
 *      have to keep the entire ~80MB body in Worker memory.
 *   3. Stream the CSV, parse in 5K-row chunks, bulk insert to
 *      GEOIP_DB.
 *   4. Stamp success/failure to `geo_ip_refresh_log`.
 *
 * Phase 1 of this work ships the SCAFFOLD (config check, log row
 * lifecycle, admin trigger, observability). Phase 2 will land the
 * actual download + chunked import as a Workflow — it's a multi-hour
 * operation that will exceed a single agent run's budget on the City
 * dataset.
 *
 * Until Phase 2: the agent reports a non-fatal "not_yet_implemented"
 * insight when invoked. The operator can pre-populate GEOIP_DB
 * via `wrangler d1 execute geoip-db --file=path/to/geoip.sql` for
 * the initial load — the lookup path works as soon as data lands.
 */

import type { Env } from '../types';
import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from '../lib/agentRunner';
import { logger } from '../lib/logger';
import { evaluateGeoipStall, type GeoipStallWatch } from '../lib/geoip-stall';

interface RefreshConfigStatus {
  geoipDbBound: boolean;
  licenseKeyPresent: boolean;
  stagingBound: boolean;
}

function checkConfig(env: Env): RefreshConfigStatus {
  return {
    geoipDbBound: !!env.GEOIP_DB,
    licenseKeyPresent: !!env.MAXMIND_LICENSE_KEY,
    stagingBound: !!env.GEOIP_STAGING,
  };
}

interface MaxMindProbeResult {
  ok: boolean;
  status: number;
  durationMs: number;
  error: string | null;
  /** If the key is valid, MaxMind returns a tiny .sha256 file with
   *  the dataset's release-date version. We surface that on success
   *  so the operator can see WHICH version the key is authorising. */
  source_sha256_first_chars: string | null;
}

/**
 * MaxMind license-key liveness probe.
 *
 * Hits the .sha256 sibling of the City CSV download — a tiny
 * (~70 byte) file that returns the same auth contour as the full
 * dataset. Lets us answer "is the key active and authorised for
 * GeoLite2-City?" without burning bandwidth on the 80MB zip.
 *
 *   200  → key valid, dataset accessible, ready for full refresh
 *   401  → key rejected (rotated, revoked, or typed wrong)
 *   403  → key valid but not entitled to GeoLite2-City
 *   5xx  → MaxMind upstream issue — retry later
 *   other → unexpected, log the body for investigation
 *
 * Every probe attempt is one subrequest; safe to call from any
 * tick.
 */
async function probeMaxMindLicense(licenseKey: string): Promise<MaxMindProbeResult> {
  const start = Date.now();
  const url =
    `https://download.maxmind.com/app/geoip_download` +
    `?edition_id=GeoLite2-City-CSV` +
    `&license_key=${encodeURIComponent(licenseKey)}` +
    `&suffix=zip.sha256`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Averrow/geoip-refresh' },
      // The sha256 file is tiny but the redirect chain to MaxMind's
      // CDN can be slow. 10s is comfortable headroom.
      signal: AbortSignal.timeout(10_000),
    });
    const durationMs = Date.now() - start;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        durationMs,
        error: `HTTP ${res.status}: ${body.slice(0, 200) || res.statusText}`,
        source_sha256_first_chars: null,
      };
    }
    // The body is a hex sha256 + filename, e.g.:
    //   "abc123...  GeoLite2-City-CSV_20260501.zip"
    // First 12 chars of the sha256 is plenty for an op log.
    const body = await res.text();
    const firstChars = body.trim().split(/\s+/)[0]?.slice(0, 12) ?? null;
    return { ok: true, status: 200, durationMs, error: null, source_sha256_first_chars: firstChars };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      source_sha256_first_chars: null,
    };
  }
}

export const geoipRefreshAgent: AgentModule = {
  name: 'geoip_refresh',
  displayName: 'GeoIP Refresh',
  description:
    'Loads MaxMind GeoLite2 City ranges into the dedicated GEOIP_DB. ' +
    'Provides a third-tier geo source for cartographer when ip-api ' +
    'and ipinfo can\'t return lat/lng for malicious IPs.',
  color: '#10b981',
  trigger: 'scheduled',
  requiresApproval: false,
  // FC's recovery sweeper re-dispatches any agent whose lastRunAge
  // exceeds stallThresholdMinutes (per AGENT_STANDARD §3 / flightControl
  // line 159: "Choose ≈ intended interval × 1.2"). The orchestrator
  // gates this agent on Sunday hour=2 (weekly, see cron/orchestrator.ts
  // line 207), so the intended interval is 7 days. 12100 = 7d × 1.2 +
  // small buffer — same value used by auto-seeder, which has the
  // identical Sunday-only weekly cadence.
  //
  // History (2026-05-04): this was set to 240 (4h) under the mistaken
  // belief that stallThresholdMinutes was a per-RUN runtime ceiling.
  // FC's interpretation is "time since last run that triggers spurious
  // recovery" — at 240 min, FC re-fired this agent every 5 hours
  // (visible in agent_runs as 5 dispatches/day). Each dispatch hits
  // MaxMind's `.sha256` probe + Workflow download, exhausting the
  // free-tier daily quota. MaxMind sent a "Daily GeoIP Database
  // Download Limit Reached" email; root cause was this misconfig.
  stallThresholdMinutes: 12100,
  parallelMax: 1,
  // No AI surface — pure data plumbing.
  costGuard: 'exempt',
  budget: { monthlyTokenCap: 0 },
  // Phase-1 scaffold + Phase-2 connectivity probe write to
  // geo_ip_refresh_log and read from MaxMind's permalink. The
  // Phase-3 chunked CSV import (geo_ip_ranges writes) lands when
  // the streaming-zip pipeline is ready; declarations grow with
  // it. Drift CI re-validates per PR.
  reads: [
    { kind: 'external', name: 'MaxMind GeoLite2 Permalink', url: 'https://download.maxmind.com' },
    // Self-heal SELECT (Phase A.5: stuck-row cleanup + dispatch guard).
    { kind: 'd1_table', name: 'geo_ip_refresh_log' },
    // Layer D: 429 cooldown stamp on KV (key
    // `geoip:maxmind:cooldown_until`). KV-backed so a probe
    // failure on one tick prevents wasted dispatches on the next.
    { kind: 'kv', namespace: 'CACHE' },
  ],
  writes: [
    // Lives in GEOIP_DB, not the main DB. The drift extractor sees
    // the SQL identifier and lists it under d1_table — accurate
    // shape, just attached to a separate binding.
    { kind: 'd1_table', name: 'geo_ip_refresh_log' },
  ],
  outputs: [],
  status: 'active',
  category: 'ops',
  // Pipeline position 37 — first free slot after the existing
  // 0-36 chain. Conceptually clusters with cube_healer (13),
  // enricher (21), and curator (10) as Platform Operations
  // data-plumbing — but the registry is dense in those ranges
  // so the next free integer keeps the audit gate happy without
  // shuffling the existing pipeline drawing.
  pipelinePosition: 37,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const env = ctx.env;
    const start = Date.now();
    const config = checkConfig(env);
    const agentOutputs: AgentOutputEntry[] = [];

    // ── Phase A: config check ──
    // Diagnose before doing any work — the operator sees a clear
    // message telling them which binding/secret is missing instead
    // of a generic "0 records processed" run.
    if (!config.geoipDbBound) {
      agentOutputs.push({
        type: 'diagnostic',
        summary:
          'GEOIP_DB binding is not set. Provision the dedicated D1: ' +
          '`wrangler d1 create geoip-db`, copy the returned database_id ' +
          'into wrangler.toml (search for GEOIP_DB), then re-deploy.',
        severity: 'medium',
        details: { config, runbook: 'wrangler.toml comment block' },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { phase: 'config_check', status: 'unconfigured', config },
        agentOutputs,
      };
    }

    if (!config.licenseKeyPresent) {
      agentOutputs.push({
        type: 'diagnostic',
        summary:
          'MAXMIND_LICENSE_KEY secret is not set. Get a free GeoLite2 ' +
          'license from https://www.maxmind.com/en/geolite2/signup, then ' +
          '`wrangler secret put MAXMIND_LICENSE_KEY`.',
        severity: 'medium',
        details: { config },
      });
      // Not a hard failure — operator may be importing manually via
      // `wrangler d1 execute`. The lookup path still works once the
      // table has data, regardless of how it got there.
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { phase: 'config_check', status: 'awaiting_license', config },
        agentOutputs,
      };
    }

    // ── Phase A.5: §15.3 idempotency — clean up stuck rows + dispatch guard ──
    // Layer B of the self-healing scheme. A previous workflow that
    // crashed (worker timeout, malformed deflate stream, MaxMind
    // hung) leaves a 'running' row that nothing else will close
    // unless the workflow's failure handler (Layer A) caught it.
    // Layer C (Flight Control) is the long-tail safety net but
    // runs hourly; here we cover the on-demand-trigger case so the
    // operator gets immediate feedback when they click Force.
    //
    // This Layer-B guard used to recover ANY 'running' row older than a
    // fixed 60 min, purely on age. That killed legitimately-long imports
    // the same way FC's old Layer-C age-kill did (prod 2026-07-24: a diff
    // rebuild progressing under a D1 read-throttle was force-failed at
    // ~60 min and re-dispatched from scratch). We now share FC's
    // progress-aware `evaluateGeoipStall` decision + the same per-run KV
    // high-water watermark: a run whose checkpoint is still advancing is
    // treated as in-flight (never recovered, and it suppresses a
    // duplicate dispatch); only a run whose checkpoint has stalled past
    // the grace window — or blown the hard ceiling — is recovered.
    const forceReload = ctx.input?.forceReload === true;

    // ── Layer D: MaxMind 429 cooldown ──
    // MaxMind GeoLite2 has a daily download quota per license key.
    // Each refresh attempt makes ~6-11 HTTP requests (HEAD + Range
    // reads); a few retries can blow through the quota and lock us
    // out for 24 hours. When the probe step sees HTTP 429, we
    // stamp a cooldown key in KV. Subsequent dispatches refuse
    // until the key expires, preventing wasted attempts that would
    // just fail and confuse operators.
    //
    // forceReload bypasses the cooldown — operator override for
    // the rare case where MaxMind 429'd us in error and we want
    // to retry anyway.
    const COOLDOWN_KV_KEY = 'geoip:maxmind:cooldown_until';
    if (!forceReload) {
      try {
        const cooldownUntil = await env.CACHE.get(COOLDOWN_KV_KEY);
        if (cooldownUntil) {
          const remainingMs = Date.parse(cooldownUntil) - Date.now();
          if (remainingMs > 0) {
            const remainingMin = Math.ceil(remainingMs / 60_000);
            agentOutputs.push({
              type: 'insight',
              summary:
                `MaxMind 429 cooldown active — ${remainingMin} min remaining ` +
                `(until ${cooldownUntil}). Pass forceReload=true to override.`,
              severity: 'medium',
              details: { phase: 'maxmind_cooldown_active', cooldown_until: cooldownUntil, remaining_min: remainingMin },
            });
            logger.warn('geoip_refresh_cooldown_active', {
              agent_id: 'geoip_refresh',
              cooldown_until: cooldownUntil,
              remaining_min: remainingMin,
            });
            return {
              itemsProcessed: 0,
              itemsCreated: 0,
              itemsUpdated: 0,
              output: { phase: 'maxmind_cooldown_active', cooldown_until: cooldownUntil, remaining_min: remainingMin },
              agentOutputs,
            };
          }
        }
      } catch { /* KV read failure shouldn't block dispatch — fall through */ }
    }

    const runningRows = await env.GEOIP_DB!.prepare(`
      SELECT id, started_at, last_committed_row,
             CAST((julianday('now') - julianday(started_at)) * 24 * 60 AS INTEGER) AS age_min
      FROM geo_ip_refresh_log
      WHERE status = 'running'
    `).all<{ id: string; started_at: string; last_committed_row: number | null; age_min: number }>();

    // Partition running rows into genuinely-stuck (recover) vs in-flight
    // (leave alone) using the shared progress-aware decision. Advancing
    // runs are in-flight no matter how old; the watermark carries across
    // FC + agent ticks via the same KV key.
    const stuck: Array<{ id: string; reason: string }> = [];
    const inFlight: Array<{ id: string; age_min: number }> = [];
    for (const row of runningRows.results) {
      const watchKey = `geoip:stuck_watch:${row.id}`;
      let prev: GeoipStallWatch | null = null;
      try {
        prev = env.CACHE ? await env.CACHE.get<GeoipStallWatch>(watchKey, 'json') : null;
      } catch { prev = null; }
      const decision = evaluateGeoipStall({
        lastCommittedRow: row.last_committed_row ?? 0,
        ageMin: row.age_min,
        prev,
        nowMs: Date.now(),
      });
      if (decision.kill) {
        stuck.push({ id: row.id, reason: decision.reason ?? 'stalled' });
      } else {
        inFlight.push({ id: row.id, age_min: row.age_min });
        try {
          if (env.CACHE) {
            await env.CACHE.put(watchKey, JSON.stringify(decision.nextWatch), { expirationTtl: 6 * 3600 });
          }
        } catch { /* best-effort */ }
      }
    }

    let recoveredCount = 0;
    for (const row of stuck) {
      try {
        await env.GEOIP_DB!.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'failed',
              completed_at = datetime('now'),
              error_message = ?
          WHERE id = ? AND status = 'running'
        `).bind(
          `Auto-recovered (agent self-heal): ${row.reason}`,
          row.id,
        ).run();
        try { if (env.CACHE) await env.CACHE.delete(`geoip:stuck_watch:${row.id}`); } catch { /* best-effort */ }
        recoveredCount++;
      } catch { /* best-effort */ }
    }
    if (recoveredCount > 0) {
      agentOutputs.push({
        type: 'insight',
        summary: `Self-heal recovered ${recoveredCount} stalled workflow(s) from prior run(s).`,
        severity: 'info',
        details: { stuck_recovered: stuck.map((s) => s.id) },
      });
      logger.warn('geoip_refresh_self_heal', {
        agent_id: 'geoip_refresh',
        recovered: recoveredCount,
        stuck_ids: stuck.map((s) => s.id),
      });
    }

    // §15.3 dispatch guard — if a still-progressing workflow is in
    // flight and the operator didn't pass forceReload, refuse to
    // dispatch. Prevents the duplicate-workflow race (operator clicking
    // Force twice) AND stops the agent from re-dispatching on top of a
    // healthy long-running import.
    if (inFlight.length > 0 && !forceReload) {
      agentOutputs.push({
        type: 'insight',
        summary: `Skipped: ${inFlight.length} workflow(s) still progressing. Pass forceReload=true to override.`,
        severity: 'info',
        details: { running_workflows: inFlight },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: recoveredCount,
        itemsUpdated: 0,
        output: { phase: 'skipped_already_running', running: inFlight, recovered: recoveredCount },
        agentOutputs,
      };
    }

    // ── Phase B: open a refresh log row ──
    // Every refresh attempt gets a row regardless of outcome — the
    // dashboard reads the latest entry to render "last refreshed N
    // hours ago" and surfaces the previous failure if the latest run
    // bombed.
    const refreshId = `geoip_refresh_${Date.now()}`;
    try {
      await env.GEOIP_DB!.prepare(`
        INSERT INTO geo_ip_refresh_log
          (id, source, status, started_at)
        VALUES (?, 'maxmind-geolite2-city', 'running', datetime('now'))
      `).bind(refreshId).run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agentOutputs.push({
        type: 'diagnostic',
        summary: `GeoIP refresh log open failed: ${msg}. ` +
                 'Likely the geoip-db migrations haven\'t been applied — ' +
                 'run `wrangler d1 migrations apply geoip-db --remote`.',
        severity: 'high',
        details: { error: msg },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { phase: 'log_open', status: 'migration_missing', error: msg },
        agentOutputs,
      };
    }

    // ── Phase C: MaxMind connectivity probe ──
    // Verifies the license key is valid and entitled to
    // GeoLite2-City BEFORE the (later, expensive) download phase.
    // A 401 here means the operator typed the key wrong or it was
    // rotated; surfacing it as a 'high' diagnostic gives them a
    // clear actionable error instead of a mysterious failure
    // partway through a 5M-row import.
    const probe = await probeMaxMindLicense(env.MAXMIND_LICENSE_KEY!);

    if (!probe.ok) {
      const phase = probe.status === 401
        ? 'license_invalid'
        : probe.status === 403
          ? 'license_unentitled'
          : probe.status === 429
            ? 'maxmind_quota_exhausted'
            : 'maxmind_unreachable';
      const probeSummary =
        probe.status === 401
          ? `MaxMind rejected the license key (HTTP 401). Verify the secret value via the account portal — keys can be rotated/revoked. Probe took ${probe.durationMs}ms.`
          : probe.status === 403
            ? `MaxMind license key valid but not entitled to GeoLite2-City (HTTP 403). Ensure the account has the GeoLite2 product enabled.`
            : probe.status === 429
              ? `MaxMind daily quota exhausted (HTTP 429). Cooldown stamped — automatic dispatches will skip until ${new Date(Date.now() + 24 * 60 * 60_000).toISOString()}. Use forceReload to override.`
              : `MaxMind probe failed: ${probe.error ?? 'unknown'} (status=${probe.status}, ${probe.durationMs}ms). Retrying on the next tick is safe.`;

      // Layer D: stamp the 24h cooldown when MaxMind 429s us so
      // subsequent dispatches don't burn additional quota / make
      // the 429 stickier. Only fires for actual 429s — other
      // failures (401/403/network) don't need the cooldown.
      if (probe.status === 429) {
        try {
          const cooldownUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
          await env.CACHE.put(COOLDOWN_KV_KEY, cooldownUntil, { expirationTtl: 24 * 60 * 60 });
          logger.warn('geoip_refresh_cooldown_stamped', {
            agent_id: 'geoip_refresh',
            cooldown_until: cooldownUntil,
            reason: 'maxmind_quota_exhausted',
          });
        } catch { /* KV write failure is non-fatal */ }
      }

      try {
        await env.GEOIP_DB!.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'failed',
              completed_at = datetime('now'),
              duration_ms = ?,
              error_message = ?
          WHERE id = ?
        `).bind(Date.now() - start, probeSummary, refreshId).run();
      } catch {
        // Non-fatal — the started_at was already recorded.
      }

      agentOutputs.push({
        type: 'diagnostic',
        summary: probeSummary,
        severity: 'high',
        details: { phase, probe, config },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { phase, probe, config, durationMs: Date.now() - start },
        agentOutputs,
      };
    }

    // ── Phase D: dispatch GeoipRefresh Workflow ──
    // The full ~3.5M-row CSV import has its own durability
    // requirements (multi-day execution window, per-step retry,
    // can't fit in any single Worker invocation). The Workflow
    // owns that lifecycle. Here we just kick it off, then let
    // the agent return — the refresh log row stays 'running'
    // until the Workflow's final step marks it 'success'.
    //
    // If the Workflow binding or R2 staging isn't provisioned,
    // the agent returns success on the probe alone (license key
    // is valid). The operator sees a clear next-step message.
    const durationMs = Date.now() - start;
    const probeMessage =
      `Probe ok (sha256 ${probe.source_sha256_first_chars ?? '?'}, ` +
      `${probe.durationMs}ms). License key is valid and entitled.`;

    // The Workflow stages MaxMind's archive to R2 once, then reads it
    // from R2 — so both GEOIP_REFRESH (the Workflow binding) AND
    // GEOIP_STAGING (the R2 bucket) must be bound. (Phase 3.5 briefly
    // dropped the R2 requirement and read MaxMind directly via HTTP
    // Range, but that paid the metered endpoint ~7×/import and tripped
    // MaxMind's daily quota — see workflows/geoipRefresh.ts.)
    if (!env.GEOIP_REFRESH) {
      try {
        await env.GEOIP_DB!.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'success',
              completed_at = datetime('now'),
              rows_written = 0,
              duration_ms = ?,
              error_message = ?,
              source_version = ?
          WHERE id = ?
        `).bind(
          durationMs,
          `${probeMessage} Workflow binding GEOIP_REFRESH not yet bound — uncomment the [[workflows]] block in wrangler.toml and redeploy.`,
          probe.source_sha256_first_chars,
          refreshId,
        ).run();
      } catch { /* non-fatal */ }
      agentOutputs.push({
        type: 'insight',
        summary:
          `${probeMessage} To run a full import, bind GEOIP_REFRESH ` +
          `(Workflow) in wrangler.toml — see the commented block.`,
        severity: 'info',
        details: { phase: 'probe_ok_awaiting_workflow_binding', probe, config, durationMs },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { phase: 'probe_ok_awaiting_workflow_binding', probe, config, durationMs },
        agentOutputs,
      };
    }

    // The auto-poll path stages MaxMind's archive to R2 (GEOIP_STAGING)
    // before importing. Without the bucket the workflow would fail at
    // its stage-to-r2 step; catch it here so the operator gets a clear
    // pre-dispatch diagnostic instead of a mid-workflow failure.
    if (!config.stagingBound) {
      try {
        await env.GEOIP_DB!.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'failed',
              completed_at = datetime('now'),
              duration_ms = ?,
              error_message = ?,
              source_version = ?
          WHERE id = ?
        `).bind(
          durationMs,
          `${probeMessage} GEOIP_STAGING (R2) not bound — the refresh stages the MaxMind archive to R2 before import. Add the [[r2_buckets]] GEOIP_STAGING block in wrangler.toml and redeploy.`,
          probe.source_sha256_first_chars,
          refreshId,
        ).run();
      } catch { /* non-fatal */ }
      agentOutputs.push({
        type: 'diagnostic',
        summary:
          `${probeMessage} GEOIP_STAGING (R2) binding missing — bind it in ` +
          `wrangler.toml so the workflow can stage the archive before import.`,
        severity: 'high',
        details: { phase: 'awaiting_staging_binding', probe, config, durationMs },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { phase: 'awaiting_staging_binding', probe, config, durationMs },
        agentOutputs,
      };
    }

    // Dispatch the Workflow. .create() returns a handle whose
    // `.id` we surface so the operator can grep wrangler tail
    // for that specific run. `forceReload` was resolved in the
    // dispatch-guard step above (Phase A.5).
    let workflowInstanceId: string | null = null;
    try {
      const instance = await env.GEOIP_REFRESH.create({
        params: { refreshLogId: refreshId, forceReload },
      });
      workflowInstanceId = instance.id;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        await env.GEOIP_DB!.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'failed',
              completed_at = datetime('now'),
              duration_ms = ?,
              error_message = ?
          WHERE id = ?
        `).bind(
          Date.now() - start,
          `Workflow dispatch failed: ${errMsg}`,
          refreshId,
        ).run();
      } catch { /* non-fatal */ }
      agentOutputs.push({
        type: 'diagnostic',
        summary: `GeoipRefresh workflow dispatch failed: ${errMsg}`,
        severity: 'high',
        details: { phase: 'workflow_dispatch_failed', error: errMsg },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { phase: 'workflow_dispatch_failed', error: errMsg },
        agentOutputs,
      };
    }

    agentOutputs.push({
      type: 'insight',
      summary:
        `${probeMessage} Workflow dispatched ` +
        `(instance=${workflowInstanceId}). Refresh log row will ` +
        `be marked 'success' by the workflow's final step.`,
      severity: 'info',
      details: { phase: 'workflow_dispatched', probe, workflowInstanceId, refreshLogId: refreshId, durationMs },
    });
    logger.info('geoip_refresh_dispatched', {
      agent_id: 'geoip_refresh',
      workflow_instance_id: workflowInstanceId,
      refresh_log_id: refreshId,
      sha256_first12: probe.source_sha256_first_chars,
      force_reload: forceReload,
      duration_ms: durationMs,
    });
    // §14.2 — AE row for the dispatch event itself (workflow run
    // success/failure lands separately from the workflow handler).
    try {
      env.AE?.writeDataPoint({
        blobs: ['geoip_refresh', 'dispatched', probe.source_sha256_first_chars ?? 'unknown'],
        doubles: [durationMs, forceReload ? 1 : 0],
        indexes: ['geoip_refresh'],
      });
    } catch { /* AE write is best-effort */ }

    return {
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      output: { phase: 'workflow_dispatched', probe, workflowInstanceId, refreshLogId: refreshId, durationMs },
      agentOutputs,
    };
  },
};
