/**
 * Observer scheduled-run success marker (KV).
 *
 * Observer has two kinds of run, and agent_runs cannot tell them apart (it
 * has no trigger column):
 *   - the scheduled daily briefing (`41 0 * * *` cron, or Flight Control's
 *     stall-recovery catch-up), and
 *   - pivot_detected event runs (rule-based pivot_report, up to 3/day).
 *
 * Flight Control's stall check reads only the newest agent_runs row per
 * agent, so a successful pivot run would hide a failed or missing 00:41
 * briefing: the newest row is a fresh success, the agent is never stalled,
 * no catch-up runs and the day's briefing is silently lost.
 *
 * The scheduled path therefore stamps this marker when it finishes its
 * briefing, and FC measures Observer's stall age from it instead of from the
 * newest run (getAgentHealth → AgentHealth.stall_reference_at). Event runs
 * never write it. One KV write per scheduled run, one KV read per FC tick —
 * no D1 traffic and no migration.
 *
 * Absent marker (first deploy, or no scheduled success for longer than the
 * TTL): FC falls back to the newest agent_runs row, i.e. the behaviour
 * before this marker existed.
 */

export const OBSERVER_SCHEDULED_SUCCESS_KV_KEY = "observer:last_scheduled_success_at";

/** Long enough that a multi-day outage still leaves the last good stamp
 *  readable (so FC keeps flagging the stall), short enough to self-clean. */
export const OBSERVER_SCHEDULED_SUCCESS_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Best-effort stamp — never throws. A lost stamp only makes FC see the
 *  briefing as older than it is (worst case: one extra catch-up run). */
export async function stampObserverScheduledSuccess(
  cache: KVNamespace,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    await cache.put(OBSERVER_SCHEDULED_SUCCESS_KV_KEY, new Date(nowMs).toISOString(), {
      expirationTtl: OBSERVER_SCHEDULED_SUCCESS_TTL_SECONDS,
    });
  } catch {
    /* best-effort */
  }
}

/** ISO timestamp of the last scheduled success, or null when absent,
 *  unparseable or unreadable (KV error → fall back, never throw). */
export async function readObserverScheduledSuccess(cache: KVNamespace): Promise<string | null> {
  try {
    const raw = await cache.get(OBSERVER_SCHEDULED_SUCCESS_KV_KEY);
    if (!raw) return null;
    return Number.isFinite(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}
