/**
 * Executive-impersonation batch orchestration — Stage 4.
 *
 * Iterates the active `org_executives` registry, runs the PURE detector
 * (`runExecutiveMonitorForExec` in ./executive-monitor.ts) per exec, and
 * turns each surfaced NON-official candidate into an
 * `executive_impersonation` alert via `createAlert`.
 *
 * This is the SIDE-EFFECT layer that sits ON TOP of the side-effect-free
 * scanner. It is deliberately kept:
 *   - OUT of ./executive-monitor.ts, to preserve that file's stated
 *     purity contract (no D1, no alerts, no AI); and
 *   - OUT of the agent file (agents/executiveMonitor.ts), so the architect
 *     manifest's per-file SQL extractor (collectors/repo-fs.ts only walks
 *     src/agents/*.ts) keeps the agent's declared reads/writes empty — the
 *     exact same delegation pattern ct_monitor / social_monitor use.
 *
 * 100% deterministic: NO AI. The detector is HEAD-probe + Levenshtein only.
 *
 * Bounds (the BATCH_LIMIT lesson from scanners/social-monitor.ts):
 *   - EXEC_BATCH_LIMIT caps execs processed per run. The scanner already
 *     caps ≤ MAX_CANDIDATES_PER_EXEC (12) HEAD probes per exec, so a run's
 *     worst-case network fan-out is EXEC_BATCH_LIMIT × 12 ≈ 120 calls —
 *     comfortably under the dedicated cron's per-invocation budget.
 *   - A KV rotation cursor (loadActiveExecutivesRotating) rotates through
 *     the registry across runs so every exec is eventually covered when
 *     the set exceeds EXEC_BATCH_LIMIT.
 *
 * Dedup: `createAlert` does NOT auto-dedup, so this layer guards each
 * candidate against a recent duplicate alert (same brand + executive_id +
 * platform + handle) inside the alert type's dedupWindow (-6 hours,
 * matching the social family) BEFORE calling createAlert — so a fake
 * profile re-observed across the day doesn't flood the executive's inbox.
 */

import { ALERT_TYPES } from '@averrow/shared';
import type { Env } from '../types';
import { createAlert } from '../lib/alerts';
import { runExecutiveMonitorForExec } from './executive-monitor';
import type {
  ExecutiveScanInput,
  ExecutiveImpersonationCandidate,
} from './executive-monitor';

// ─── Bounds ──────────────────────────────────────────────────────

/** Execs processed per cron tick. Mirrors social-monitor's BATCH_LIMIT
 *  (10). See the module header for the network-budget arithmetic. */
export const EXEC_BATCH_LIMIT = 10;

/** KV rotation cursor: the last org_executives.id processed. The next run
 *  resumes at `id > cursor`, wrapping to the start when the tail is
 *  reached, so the whole registry is covered across runs. */
export const EXEC_ROTATION_CURSOR_KEY = 'exec_monitor:rotation_cursor';

/** Dedup window, sourced from the shared alert-type registry so it stays
 *  in lock-step with the social family (both `-6 hours`). */
const EXEC_DEDUP_WINDOW =
  ALERT_TYPES.find((t) => t.key === 'executive_impersonation')?.dedupWindow ??
  '-6 hours';

// ─── Types ───────────────────────────────────────────────────────

/** The org_executives slice the batch needs: the scanner input columns
 *  PLUS brand_id (alerts are brand-scoped) and org_id (the OWNING org —
 *  alerts MUST route strictly inside it, never to another org that merely
 *  co-monitors the same brand). */
export interface ExecutiveBatchRow extends ExecutiveScanInput {
  brand_id: string;
  /** org_executives.org_id → organizations(id) (INTEGER). The exec's
   *  owning org; the ONLY org an alert about this exec may reach. */
  org_id: number;
}

export interface ExecutiveMonitorBatchStats {
  executives_processed: number;
  candidates_found: number;
  alerts_created: number;
  /** Candidates that ARE the exec's own official handle — never alerted. */
  skipped_official: number;
  /** Candidates suppressed by the dedup guard (recent identical alert). */
  skipped_dedup: number;
  /** Execs whose OWN org has no user to route the alert to. We never fall
   *  back to another org's user (that would leak the exec's name across the
   *  org boundary), so these candidates produce no alert. */
  skipped_no_org_user: number;
  /** Execs whose per-exec body threw (caught → counted, run continues). */
  errors: number;
}

interface DedupArgs {
  brandId: string;
  executiveId: string;
  platform: string;
  handle: string;
}

/** Injectable seams — every DB / KV / alert touch point is behind one of
 *  these so the batch is unit-testable with mocked deps and no fake D1.
 *  All default to the real implementations below. */
export interface ExecutiveMonitorBatchDeps {
  /** Load the batch of active execs to process this run (rotation-aware). */
  loadExecutives?: (env: Env, limit: number) => Promise<ExecutiveBatchRow[]>;
  /** Run the pure detector for one exec. */
  scan?: (exec: ExecutiveScanInput) => Promise<ExecutiveImpersonationCandidate[]>;
  /** Resolve the user_id the alert routes to, STRICTLY within the exec's
   *  own org_id (null → no in-org user, so no alert). Keyed by org_id (NOT
   *  brand_id) so a co-monitoring org can never receive the alert. */
  resolveAlertUser?: (env: Env, orgId: number) => Promise<string | null>;
  /** True when a recent duplicate alert already exists. */
  isDuplicateAlert?: (env: Env, args: DedupArgs) => Promise<boolean>;
  /** createAlert seam (mocked in tests). */
  createAlertFn?: typeof createAlert;
}

// ─── Batch ───────────────────────────────────────────────────────

export async function runExecutiveMonitorBatch(
  env: Env,
  deps: ExecutiveMonitorBatchDeps = {},
): Promise<ExecutiveMonitorBatchStats> {
  const loadExecutives = deps.loadExecutives ?? loadActiveExecutivesRotating;
  const scan = deps.scan ?? ((exec) => runExecutiveMonitorForExec(exec));
  const resolveAlertUser = deps.resolveAlertUser ?? resolveAlertUserForOrg;
  const isDuplicateAlert = deps.isDuplicateAlert ?? isDuplicateExecutiveAlert;
  const createAlertFn = deps.createAlertFn ?? createAlert;

  const stats: ExecutiveMonitorBatchStats = {
    executives_processed: 0,
    candidates_found: 0,
    alerts_created: 0,
    skipped_official: 0,
    skipped_dedup: 0,
    skipped_no_org_user: 0,
    errors: 0,
  };

  const execs = await loadExecutives(env, EXEC_BATCH_LIMIT);

  for (const exec of execs) {
    stats.executives_processed++;

    // ONE try/catch around the ENTIRE per-exec body — the scan AND every
    // D1 touch after it (resolveAlertUser / isDuplicateAlert / createAlert).
    // A transient D1 error or one bad row must not abort the whole run:
    // the cursor was already advanced past this batch, so an escaping throw
    // would skip every later exec until a full rotation wraps. Mirrors the
    // sibling idiom in scanners/social-monitor.ts, which wraps the whole
    // per-brand body. `stats` accumulated so far is preserved, so the
    // agent_runs record still lands.
    try {
      const candidates = await scan({
        id: exec.id,
        full_name: exec.full_name,
        official_handles: exec.official_handles,
        watch_platforms: exec.watch_platforms,
      });

      if (candidates.length === 0) continue;

      // Resolve the routing user ONCE per exec — STRICTLY inside the exec's
      // OWN org (keyed by org_id, never brand_id). A brand is many-to-many
      // with orgs, so a brand-scoped lookup could return a co-monitoring
      // org's user and leak the exec's name across the org boundary.
      const userId = await resolveAlertUser(env, exec.org_id);

      for (const candidate of candidates) {
        stats.candidates_found++;

        // Never alert on the exec's own registered account.
        if (candidate.isOfficialHandle) {
          stats.skipped_official++;
          continue;
        }

        // No user in the exec's OWN org → drop. Never fall back to another
        // org's user (that is the cross-org PII leak this guards).
        if (!userId) {
          stats.skipped_no_org_user++;
          continue;
        }

        const duplicate = await isDuplicateAlert(env, {
          brandId: exec.brand_id,
          executiveId: exec.id,
          platform: candidate.platform,
          handle: candidate.handle,
        });
        if (duplicate) {
          stats.skipped_dedup++;
          continue;
        }

        const alertId = await createAlertFn(env.DB, {
          brandId: exec.brand_id,
          userId,
          // Org-private: stamp the owning org so the brand-scoped tenant
          // read/write paths restrict this PII-bearing alert to org_id
          // (a co-monitoring org must never see it). Migration 0247.
          orgId: exec.org_id,
          alertType: 'executive_impersonation',
          // createAlert lowercases; the scanner emits UPPERCASE severity.
          severity: candidate.severity,
          title: `Possible executive impersonation on ${candidate.platform}: @${candidate.handle}`,
          summary:
            `A ${candidate.platform} account "@${candidate.handle}" may be impersonating ` +
            `${exec.full_name}. Impersonation score: ${(candidate.score * 100).toFixed(0)}%.`,
          details: {
            executive_id: exec.id,
            score: candidate.score,
            handle: candidate.handle,
            platform: candidate.platform,
            profile_url: candidate.profileUrl,
            is_official_handle: candidate.isOfficialHandle,
            // Extra context for the future tenant UI (Stage 5) — the triage
            // rule (decideExecutiveImpersonationTriage) reads only
            // platform/handle/score, so these are additive.
            severity: candidate.severity,
            signals: candidate.signals,
          },
          sourceType: 'executive_monitor',
          sourceId: exec.id,
        });
        if (alertId) stats.alerts_created++;
      }
    } catch {
      // Per-exec failure must not sink the whole batch.
      stats.errors++;
      continue;
    }
  }

  return stats;
}

// ─── Real dependency implementations ─────────────────────────────

/**
 * Rotation-aware loader. Reads the KV cursor (last processed id), fetches
 * up to `limit` active execs with `id > cursor`, wraps to the start when
 * the tail is short, then advances the cursor to the last id returned so
 * the next run continues past it. When the registry is ≤ limit, every run
 * fetches the full set and the cursor naturally resets (id > lastId is
 * empty → wrap fetches all again).
 */
export async function loadActiveExecutivesRotating(
  env: Env,
  limit: number,
): Promise<ExecutiveBatchRow[]> {
  const cursor = (await env.CACHE.get(EXEC_ROTATION_CURSOR_KEY)) ?? '';

  const primary = await env.DB.prepare(
    `SELECT id, brand_id, org_id, full_name, official_handles, watch_platforms
       FROM org_executives
      WHERE status = 'active' AND id > ?
      ORDER BY id
      LIMIT ?`,
  )
    .bind(cursor, limit)
    .all<ExecutiveBatchRow>();

  const rows: ExecutiveBatchRow[] = [...primary.results];
  const seen = new Set<string>(rows.map((r) => r.id));

  // Wrap-around: top up from the start of the registry when the tail was
  // shorter than the batch limit.
  if (rows.length < limit) {
    const fill = await env.DB.prepare(
      // MUST select org_id too — a wrapped exec with org_id undefined would
      // resolve to no in-org user and be silently dropped (FIX 4).
      `SELECT id, brand_id, org_id, full_name, official_handles, watch_platforms
         FROM org_executives
        WHERE status = 'active'
        ORDER BY id
        LIMIT ?`,
    )
      .bind(limit - rows.length)
      .all<ExecutiveBatchRow>();
    for (const r of fill.results) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
      if (rows.length >= limit) break;
    }
  }

  // Advance the cursor to the last id we handled (empty set → reset so the
  // next run starts from the top).
  const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.id : '';
  try {
    await env.CACHE.put(EXEC_ROTATION_CURSOR_KEY, nextCursor);
  } catch {
    // Cursor is a best-effort optimisation; a KV blip just means the next
    // run re-processes from the same point — harmless (dedup guards alerts).
  }

  return rows;
}

/**
 * Route the alert STRICTLY inside the executive's OWN org.
 *
 * Exec-impersonation alerts embed the executive's full name (PII) in their
 * title/summary, so they must never reach an org that isn't the exec's.
 * Brand-scoped routing (monitored_brands, as the social scanner uses) is
 * WRONG here: a brand is many-to-many with orgs (org_brands
 * UNIQUE(org_id, brand_id)), and for org-enrolled brands monitored_brands
 * is stamped tenant_id='__internal__'/super_admin (migration 0203) — it has
 * no clean org correspondence at all. org_members is the authoritative
 * org↔user map, so we resolve the highest-privilege ACTIVE member of the
 * exec's org_id. The `org_id = ?` predicate guarantees the routed user
 * belongs to the exec's own org; an org with no active member yields null
 * → the caller drops the candidate rather than leaking cross-org.
 *
 * Note: org_members.user_id is declared INTEGER but stores TEXT user ids in
 * practice (SQLite type affinity — same as every other org_members read in
 * the codebase), so the returned id matches users.id / alerts.user_id.
 * Reads the primary DB directly; no replica lag on the routing decision.
 */
export async function resolveAlertUserForOrg(
  env: Env,
  orgId: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT user_id
       FROM org_members
      WHERE org_id = ? AND status = 'active'
      ORDER BY CASE role
                 WHEN 'owner'   THEN 0
                 WHEN 'admin'   THEN 1
                 WHEN 'analyst' THEN 2
                 ELSE 3
               END, user_id
      LIMIT 1`,
  )
    .bind(orgId)
    .first<{ user_id: string | null }>();
  return row?.user_id ?? null;
}

/**
 * Dedup guard. True when an `executive_impersonation` alert for the SAME
 * (brand, executive_id, platform, handle) already exists inside the
 * dedupWindow. Uses json_extract on the stored details so the match is
 * exact and prepared-statement-safe. Reads the PRIMARY DB so replica lag
 * can't let a duplicate slip through.
 */
async function isDuplicateExecutiveAlert(
  env: Env,
  args: DedupArgs,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS hit
       FROM alerts
      WHERE alert_type = 'executive_impersonation'
        AND brand_id = ?
        AND json_extract(details, '$.executive_id') = ?
        AND json_extract(details, '$.platform') = ?
        AND json_extract(details, '$.handle') = ?
        AND created_at > datetime('now', ?)
      LIMIT 1`,
  )
    .bind(args.brandId, args.executiveId, args.platform, args.handle, EXEC_DEDUP_WINDOW)
    .first<{ hit: number }>();
  return row !== null;
}
