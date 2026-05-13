/**
 * Workflow dispatch helper — supervision plumbing for Cloudflare Workflows.
 *
 * Wraps `Workflow.create()` with three safety nets that the original
 * cartographer/nexus workflow dispatches lacked when the platform-side
 * "stopped firing" event hit on 2026-04-19 (see commit 06881d0d):
 *
 *   1. KV cooldown on `WorkflowInternalError` — if Cloudflare's
 *      Workflows service returns this transient error, the next
 *      dispatch attempt is skipped for `cooldownTtlSec` instead of
 *      retrying on every cron tick (matching the GeoIP MaxMind 429
 *      cooldown pattern documented in CLAUDE.md §6).
 *
 *   2. Activity log writes for every dispatch outcome — so a silent
 *      dispatch failure (the Apr 19 root cause) leaves an audit trail
 *      in `agent_activity_log` instead of vanishing.
 *
 *   3. KV "last dispatch" timestamp — the FC supervisor reads this
 *      to detect when expected dispatches stop happening, with a
 *      threshold of `expectedIntervalSec × 3`.
 *
 * Importantly: this helper does NOT touch `agent_runs`. Workflow
 * runs already write their progress to `agent_activity_log` from
 * inside the workflow body; mirroring them into `agent_runs` would
 * confuse the reaper (which is designed for inline executeAgent runs).
 */

const KV_COOLDOWN_PREFIX = 'wf_cooldown:';
const KV_LAST_DISPATCH_PREFIX = 'wf_last_dispatch:';

/** Default cooldown when Cloudflare's Workflows service returns
 *  `WorkflowInternalError`. Mirrors the geoip MaxMind 429 cooldown
 *  shape — long enough to not burn next-tick retries, short enough
 *  that we recover within a couple of cron cycles. */
export const DEFAULT_WORKFLOW_COOLDOWN_SEC = 60 * 60; // 1 hour

export type WorkflowDispatchOutcome =
  | { kind: 'dispatched'; instance_id: string }
  | { kind: 'cooldown'; cooldown_remaining_sec: number }
  | { kind: 'failed'; error: string; cooldown_set: boolean };

export interface WorkflowDispatchEnv {
  CACHE: KVNamespace;
  DB: D1Database;
}

export interface DispatchOptions {
  /** The Workflow binding to dispatch (e.g. env.NEXUS_RUN). */
  workflow: Workflow;
  /** Stable name used as KV key and audit message — e.g. `nexus-run`. */
  workflowName: string;
  /** Owning agent — feeds into agent_activity_log.agent_id. */
  agentId: string;
  /** Params passed verbatim to `workflow.create({ params })`. */
  params?: Record<string, unknown>;
  /** Optional dispatch-id override — otherwise CF assigns one. */
  id?: string;
  /** Cooldown TTL on platform errors. Defaults to 1h. */
  cooldownTtlSec?: number;
}

/** Detects the specific CF error shape that warrants a cooldown.
 *  Other errors (e.g. validation, binding misconfig) should fail
 *  loudly without locking out future dispatch attempts. */
function isPlatformInternalError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /WorkflowInternalError|internal workflows error/i.test(msg);
}

async function writeActivity(
  db: D1Database,
  agentId: string,
  severity: 'info' | 'warning' | 'critical',
  eventType: string,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      agentId,
      eventType,
      message,
      JSON.stringify(metadata),
      severity,
    ).run();
  } catch {
    // Logging must never break the dispatch path. The KV stamp is
    // the durable signal; activity log is the audit trail.
  }
}

/**
 * Dispatch a Cloudflare Workflow with cooldown + audit-log plumbing.
 *
 * Returns a discriminated union so callers can branch on the outcome
 * without throwing — operationally, "skipped due to cooldown" is a
 * non-error and should leave the orchestrator tick clean.
 */
export async function dispatchWorkflow(
  env: WorkflowDispatchEnv,
  opts: DispatchOptions,
): Promise<WorkflowDispatchOutcome> {
  const cooldownKey = `${KV_COOLDOWN_PREFIX}${opts.workflowName}`;
  const lastDispatchKey = `${KV_LAST_DISPATCH_PREFIX}${opts.workflowName}`;
  const cooldownTtl = opts.cooldownTtlSec ?? DEFAULT_WORKFLOW_COOLDOWN_SEC;

  // ── Cooldown check ────────────────────────────────────────────
  const cooldownRaw = await env.CACHE.get(cooldownKey);
  if (cooldownRaw) {
    let remaining = cooldownTtl;
    try {
      const parsed = JSON.parse(cooldownRaw) as { until_epoch_ms?: number };
      if (typeof parsed.until_epoch_ms === 'number') {
        remaining = Math.max(0, Math.ceil((parsed.until_epoch_ms - Date.now()) / 1000));
      }
    } catch { /* malformed value — treat as full cooldown */ }
    await writeActivity(env.DB, opts.agentId, 'warning', 'workflow_cooldown_skip',
      `Skipped ${opts.workflowName} dispatch — cooldown active (${remaining}s remaining)`,
      { workflow: opts.workflowName, cooldown_remaining_sec: remaining },
    );
    return { kind: 'cooldown', cooldown_remaining_sec: remaining };
  }

  // ── Dispatch ──────────────────────────────────────────────────
  try {
    const createArgs: { id?: string; params: Record<string, unknown> } = {
      params: opts.params ?? {},
    };
    if (opts.id) createArgs.id = opts.id;
    const instance = await opts.workflow.create(createArgs);

    // Stamp last-dispatch KV. The supervisor reads this to detect
    // silent stalls — it doesn't care about the value past parsing.
    await env.CACHE.put(
      lastDispatchKey,
      JSON.stringify({ instance_id: instance.id, dispatched_at: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 7 }, // 7 days
    );

    await writeActivity(env.DB, opts.agentId, 'info', 'workflow_dispatched',
      `${opts.workflowName} dispatched (instance ${instance.id})`,
      { workflow: opts.workflowName, instance_id: instance.id },
    );
    return { kind: 'dispatched', instance_id: instance.id };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const setCooldown = isPlatformInternalError(err);

    if (setCooldown) {
      const untilMs = Date.now() + cooldownTtl * 1000;
      await env.CACHE.put(
        cooldownKey,
        JSON.stringify({ until_epoch_ms: untilMs, last_error: errMsg.slice(0, 200) }),
        { expirationTtl: cooldownTtl },
      );
    }

    await writeActivity(env.DB, opts.agentId,
      setCooldown ? 'warning' : 'critical',
      'workflow_dispatch_failed',
      `${opts.workflowName} .create() failed: ${errMsg.slice(0, 180)}`,
      {
        workflow: opts.workflowName,
        error: errMsg,
        cooldown_set: setCooldown,
        cooldown_ttl_sec: setCooldown ? cooldownTtl : 0,
      },
    );
    return { kind: 'failed', error: errMsg, cooldown_set: setCooldown };
  }
}

/** Read the last-dispatch timestamp from KV. Returns null if the
 *  workflow has never dispatched (or the KV key TTL has expired,
 *  which means it's been >7 days since last dispatch). */
export async function getLastDispatchAt(
  cache: KVNamespace,
  workflowName: string,
): Promise<Date | null> {
  const raw = await cache.get(`${KV_LAST_DISPATCH_PREFIX}${workflowName}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { dispatched_at?: string };
    if (typeof parsed.dispatched_at === 'string') return new Date(parsed.dispatched_at);
  } catch { /* fall through */ }
  return null;
}

/** Read the cooldown end time. Returns null if no cooldown is set. */
export async function getCooldownUntil(
  cache: KVNamespace,
  workflowName: string,
): Promise<Date | null> {
  const raw = await cache.get(`${KV_COOLDOWN_PREFIX}${workflowName}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { until_epoch_ms?: number };
    if (typeof parsed.until_epoch_ms === 'number') return new Date(parsed.until_epoch_ms);
  } catch { /* fall through */ }
  return null;
}
