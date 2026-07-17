/**
 * Notification Narrator Agent — Q5b backlog (v1: static-template).
 *
 * Per-user daily digest builder. For each active user with
 * `notification_preferences_v2.digest_mode='daily'`, this agent:
 *
 *   1. Queries the user's notifications from the last 24h that are
 *      at or above their `digest_severity_floor`.
 *   2. If ≥1 row exists, inserts a single `notification_digest`
 *      envelope row in the user's inbox with severity-bucket counts
 *      and `metadata.notification_ids[]` listing the underlying rows.
 *
 * Schedule: hour===13 from the orchestrator (alongside the legacy
 * briefing email cron). The digest envelope is additive in the bell.
 *
 * AI narrative deferred to a follow-up
 * --------------------------------------
 * The original B4 implementation called Haiku per-user inside a
 * sequential loop. With even 6-7 users that exceeded the Workers 30s
 * CPU ceiling — the agent stalled, never wrote `completed_at`, and
 * Flight Control flagged it as `platform_agent_stalled`. v1 ships
 * static-template only. AI narrative comes back via a Workflow
 * conversion (durable, no CPU ceiling) in a follow-up.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { createNotification } from "../lib/notifications";

// Defense-in-depth cap. With per-user work bounded to ~50ms (one D1
// query + one INSERT via createNotification), 50 users in a single
// tick is well under the CPU ceiling.
const MAX_USERS_PER_TICK = 50;

interface UserDigestPref {
  user_id: string;
  digest_severity_floor: 'high' | 'medium' | 'low' | 'info';
  email_severity_floor: string;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 5, high: 4, medium: 3, low: 2, info: 1,
};

function severityAtLeast(have: string, floor: string): boolean {
  return (SEVERITY_RANK[have] ?? 0) >= (SEVERITY_RANK[floor] ?? 0);
}

export const notificationNarratorAgent: AgentModule = {
  name: "notification_narrator",
  displayName: "Notification Narrator",
  description: "Per-user daily digest builder (Q5b — static template v1)",
  color: "#A8C878",
  trigger: "scheduled",
  requiresApproval: false,
  // Static-template digest is bounded ~50ms/user × 50 users = 2.5s.
  // Stall threshold leaves headroom for D1 latency spikes.
  stallThresholdMinutes: 1500,
  parallelMax: 1,
  // No AI calls in v1 (static-template digest). costGuard='enforced'
  // is harmless — there's no AI work for the guard to gate. AI
  // narrative returns via Workflow conversion in a follow-up.
  costGuard: "enforced",
  budget: { monthlyTokenCap: 0 },
  reads: [
    { kind: "d1_table", name: "notification_preferences_v2" },
    { kind: "d1_table", name: "notifications" },
    { kind: "d1_table", name: "users" },
  ],
  // Note: writes to `notifications` go through the createNotification
  // helper which the static drift extractor doesn't see. Convention
  // matches observer/cartographer — declare only direct SQL.
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 36,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const outputs: AgentOutputEntry[] = [];

    // Find every user with daily digest mode opted in. Cap the
    // per-tick fan-out so we never approach the Workers CPU ceiling.
    const users = await env.DB.prepare(
      `SELECT u.id AS user_id, p.digest_severity_floor, p.email_severity_floor
         FROM users u
         JOIN notification_preferences_v2 p ON p.user_id = u.id
        WHERE u.status = 'active'
          AND p.digest_mode = 'daily'
        ORDER BY u.id LIMIT ?`
    ).bind(MAX_USERS_PER_TICK).all<UserDigestPref>();

    let digestsCreated = 0;
    let usersSkipped = 0;

    for (const user of users.results) {
      // Pull eligible notifications from the last 24h, at or above
      // the user's digest floor, excluding the digest envelope itself.
      const rows = await env.DB.prepare(
        `SELECT id, type, severity, title, message
           FROM notifications
          WHERE user_id = ?
            AND created_at >= datetime('now', '-24 hours')
            AND type != 'notification_digest'
            AND state != 'done'
          ORDER BY created_at DESC LIMIT 100`
      ).bind(user.user_id).all<{
        id: string; type: string; severity: string; title: string; message: string;
      }>();

      const eligible = rows.results.filter((r) =>
        severityAtLeast(r.severity, user.digest_severity_floor)
      );
      if (eligible.length === 0) {
        usersSkipped++;
        continue;
      }

      // Severity bucket counts for the static title.
      const counts: { critical: number; high: number; medium: number; low: number; info: number } =
        { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const r of eligible) {
        if (r.severity === 'critical' || r.severity === 'high' || r.severity === 'medium' ||
            r.severity === 'low' || r.severity === 'info') {
          counts[r.severity]++;
        }
      }
      const topSeverity =
        counts.critical > 0 ? 'critical'
        : counts.high > 0 ? 'high'
        : counts.medium > 0 ? 'medium'
        : counts.low > 0 ? 'low' : 'info';

      // Static title + count-bucket message. AI narrative deferred
      // to a Workflow follow-up.
      const total = eligible.length;
      const title = `Daily digest: ${total} event${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} review`;
      const message = `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info — last 24h.`;

      // Emit the digest envelope. group_key dedups against re-runs
      // within the same day. metadata carries the underlying ids.
      try {
        await createNotification(env, {
          userId: user.user_id,
          type: 'notification_digest',
          severity: topSeverity as 'critical' | 'high' | 'medium' | 'low' | 'info',
          title,
          message,
          reasonText: `Your digest mode is set to daily.`,
          recommendedAction: total > 5
            ? `Review the inbox; bulk-action the lower-severity rows.`
            : `Open the inbox to triage.`,
          link: '/notifications',
          audience: 'tenant',
          groupKey: `notification_digest:${user.user_id}:${new Date().toISOString().slice(0, 10)}`,
          metadata: {
            digest_window: '24h',
            notification_ids: eligible.map((r) => r.id),
            counts,
          },
        });
        digestsCreated++;
      } catch (err) {
        console.error('[notification_narrator] envelope insert error:', err);
      }
    }

    outputs.push({
      type: 'diagnostic',
      summary: `Daily digests: ${digestsCreated} created, ${usersSkipped} users skipped (no eligible notifications).`,
      severity: 'info',
      details: { digests_created: digestsCreated, users_skipped: usersSkipped },
    });

    return {
      itemsProcessed: users.results.length,
      itemsCreated: digestsCreated,
      itemsUpdated: 0,
      output: {
        digests_created: digestsCreated,
        users_skipped: usersSkipped,
      },
      agentOutputs: outputs,
    };
  },
};
