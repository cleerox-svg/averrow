/**
 * Notification event registry — SINGLE SOURCE OF TRUTH.
 *
 * Every event the platform can fire must appear here. The dispatcher
 * (`packages/trust-radar/src/lib/notifications.ts`), the preference
 * handlers (`packages/trust-radar/src/handlers/notifications.ts`), and
 * the UI matrix
 * (`packages/averrow-ops/src/features/settings/NotificationPreferences.tsx`)
 * all derive their event list, dedup windows, default state, and labels
 * from this module.
 *
 * Adding a new event:
 *   1. Append a `NotificationEventDef` here.
 *   2. If `userToggleable: true`, add a matching column to
 *      `notification_preferences` (a follow-up migration).
 *   3. Add the event key to the `notifications.type` CHECK constraint
 *      (also a migration — SQLite requires table recreation to alter
 *      a CHECK).
 *   4. The UI matrix and the handler defaults pick it up automatically.
 *
 * Both the worker and the UI import from `@averrow/shared` so the
 * registry exists once and only once.
 */

export type NotificationEventKey =
  // ── User-toggleable ──
  | 'brand_threat'
  | 'campaign_escalation'
  | 'feed_health'
  | 'intelligence_digest'
  | 'agent_milestone'
  // ── System events ──
  | 'email_security_change'
  | 'circuit_breaker_tripped'
  // ── N6a — AI intel family (NOTIFICATIONS_AUDIT.md §11) ──
  | 'intel_predictive'
  | 'intel_cross_brand_pattern'
  | 'intel_sector_trend'
  | 'intel_recommended_action'
  | 'intel_threat_actor_surface'
  // ── N6b — platform-health family (super_admin; §13) ──
  | 'platform_d1_budget_warn'
  | 'platform_d1_budget_breach'
  | 'platform_kv_budget_warn'
  | 'platform_worker_cpu_burst'
  | 'platform_feed_at_risk'
  | 'platform_feed_auto_paused'
  | 'platform_feed_silent'
  | 'platform_agent_stalled'
  | 'platform_geoip_refresh_stalled'
  | 'platform_workflow_dispatch_silent'
  | 'platform_cron_orchestrator_missed'
  | 'platform_cron_navigator_missed'
  | 'platform_enrichment_stuck_pile'
  | 'platform_ai_spend_burst'
  | 'platform_resend_bounces'
  | 'platform_briefing_silent'
  // ── PR-AW — abuse mailbox family ──
  | 'abuse_mailbox_verdict'
  | 'abuse_mailbox_flood_detected'
  // ── N6c — digest envelope (§12.3) ──
  | 'notification_digest';

export type NotificationChannelKey = 'browser_notifications' | 'push_notifications';

export type NotificationSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface NotificationEventDef {
  /** DB column name in notification_preferences (when userToggleable) and value of notifications.type. */
  key: NotificationEventKey;
  /** Human-facing title in the preferences matrix. */
  label: string;
  /** Subtitle / explanation in the preferences matrix. */
  description: string;
  /**
   * Rate-limit window passed verbatim to SQLite `datetime('now', ?)`.
   * Format: `'-N <unit>'` where unit is `hour`, `hours`, `day`, `days`, etc.
   */
  dedupWindow: string;
  /** Default state when the user has no row in `notification_preferences`. */
  defaultEnabled: boolean;
  /**
   * When false, the event is system-fired and not exposed in the user-facing
   * preferences matrix. The dispatcher still rate-limits and writes the row.
   */
  userToggleable: boolean;
}

export const NOTIFICATION_EVENTS: readonly NotificationEventDef[] = [
  {
    key: 'brand_threat',
    label: 'Brand Threats',
    description: 'New threats targeting your monitored brands',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: true,
  },
  {
    key: 'campaign_escalation',
    label: 'Campaign Escalations',
    description: 'When campaigns escalate in severity',
    dedupWindow: '-6 hours',
    defaultEnabled: true,
    userToggleable: true,
  },
  {
    key: 'feed_health',
    label: 'Feed Health Alerts',
    description: 'Feed degradation and health warnings',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: true,
  },
  {
    key: 'intelligence_digest',
    label: 'Intelligence Digests',
    description: 'Daily and weekly intelligence summaries',
    dedupWindow: '-24 hours',
    defaultEnabled: true,
    userToggleable: true,
  },
  {
    key: 'agent_milestone',
    label: 'Agent Milestones',
    description: 'Agent completion and milestone events',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: true,
  },

  // ─── System events (not user-toggleable) ────────────────────────────
  // These fire from the dispatcher but don't have rows in the
  // `notification_preferences` table.
  //
  // FIXME(pr-3): both events also fail the schema CHECK constraint in
  // migrations/0018_notifications.sql, which only allows the five
  // user-toggleable events above. INSERTs for these types throw and are
  // caught by callers' try/catch — meaning these system notifications are
  // silently dropped in production today. PR 3 (notification matrix
  // migration) will recreate the `notifications` table with the full
  // event list and resolve this gap.
  {
    key: 'email_security_change',
    label: 'Email Security Change',
    description: 'DMARC / SPF / DKIM grade change for a monitored brand (also fires on observed DMARC failure spikes)',
    dedupWindow: '-6 hours',
    defaultEnabled: true,
    userToggleable: true,
  },
  {
    key: 'circuit_breaker_tripped',
    label: 'Agent Auto-Paused',
    description: 'An agent was auto-paused after consecutive failures',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: false,
  },

  // ─── N6a — AI intel family (system, per-tenant + super_admin) ──────
  // All five types are dedup'd by group_key in createNotification, so
  // dedupWindow here is only the FALLBACK for legacy metadata-LIKE
  // dedup (which intel_* types never use — they always set group_key).
  // Listed for registry completeness; the actual gating happens in
  // intel-templates.ts.
  {
    key: 'intel_predictive',
    label: 'Predictive Targeting',
    description: 'Likely-targeted prediction from cluster analysis',
    dedupWindow: '-12 hours',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'intel_cross_brand_pattern',
    label: 'Cross-Brand Pattern',
    description: 'Coordinated campaign affecting multiple tenants',
    dedupWindow: '-24 hours',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'intel_sector_trend',
    label: 'Sector Trend',
    description: 'Weekly sector-level threat trend digest',
    dedupWindow: '-7 days',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'intel_recommended_action',
    label: 'Recommended Action',
    description: 'Specific operational recommendation for a brand',
    dedupWindow: '-3 days',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'intel_threat_actor_surface',
    label: 'Threat Actor Activity',
    description: 'Tracked threat actor expanded infrastructure',
    dedupWindow: '-12 hours',
    defaultEnabled: true,
    userToggleable: false,
  },

  // ─── N6b — platform-health family (super_admin only) ───────────────
  {
    key: 'platform_d1_budget_warn',
    label: 'D1 Budget Warning',
    description: 'D1 daily reads crossed warning threshold',
    dedupWindow: '-1 day',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_d1_budget_breach',
    label: 'D1 Budget Breach',
    description: 'D1 daily reads exceeded plan',
    dedupWindow: '-1 day',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_kv_budget_warn',
    label: 'KV Budget Warning',
    description: 'KV reads/writes crossed warning threshold',
    dedupWindow: '-1 day',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_worker_cpu_burst',
    label: 'Worker CPU Burst',
    description: 'Agent run exceeded CPU ms ceiling',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_feed_at_risk',
    label: 'Feed at Risk',
    description: 'Feed approaching auto-pause threshold',
    dedupWindow: '-6 hours',
    defaultEnabled: true,
    userToggleable: true,
  },
  {
    key: 'platform_feed_auto_paused',
    label: 'Feed Auto-Paused',
    description: 'Feed disabled after consecutive failures',
    dedupWindow: '-12 hours',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_feed_silent',
    label: 'Feed Silent',
    description: 'Feed enabled but has not pulled in 3× its schedule interval — likely a silent dispatch failure',
    dedupWindow: '-6 hours',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_agent_stalled',
    label: 'Agent Stalled',
    description: 'Agent run stuck in running state >15 min',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: true,
  },
  {
    key: 'platform_geoip_refresh_stalled',
    label: 'GeoIP Refresh Stalled',
    description: 'GeoIP MaxMind refresh workflow stuck >60 min — Flight Control auto-recovered',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_workflow_dispatch_silent',
    label: 'Workflow Dispatch Silent',
    description: 'No .create() call recorded for a Cloudflare Workflow in 3× its expected dispatch interval — see lib/workflow-dispatch.ts',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_cron_orchestrator_missed',
    label: 'Orchestrator Cron Missed',
    description: 'No orchestrator run in last 90 min',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_cron_navigator_missed',
    label: 'Navigator Cron Missed',
    description: 'No navigator run in last 15 min',
    dedupWindow: '-30 minutes',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_enrichment_stuck_pile',
    label: 'Enrichment Stuck Pile',
    description: 'Threats enriched but missing geo data',
    dedupWindow: '-6 hours',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_ai_spend_burst',
    label: 'AI Spend Burst',
    description: 'AI spend in last 24h crossed threshold',
    dedupWindow: '-1 day',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_resend_bounces',
    label: 'Email Bounces',
    description: 'Resend failed/delivered ratio >10% in 7d',
    dedupWindow: '-1 day',
    defaultEnabled: true,
    userToggleable: false,
  },
  {
    key: 'platform_briefing_silent',
    label: 'Daily Briefing Silent',
    description: 'Cron briefing has not delivered in 36+ hours',
    dedupWindow: '-12 hours',
    defaultEnabled: true,
    userToggleable: false,
  },

  // ─── PR-AW — abuse mailbox family ────────────────────────────────
  // High/critical verdicts on captures sent to the org's abuse alias
  // (or to Averrow's public aliases for the self-org case). System-
  // event, not user-toggleable — these are operational signals, not
  // engagement noise. Dedup is per-message via group_key; the window
  // here is the fallback.
  {
    key: 'abuse_mailbox_verdict',
    label: 'Abuse Mailbox Verdict',
    description: 'High/critical phishing or malware verdict on a captured submission',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: false,
  },
  // Fires once per (sender|domain) per hour when the rate-limit fires
  // in handlers/abuseMailboxEmail.ts. Super_admin audience — back-end
  // signal that someone is flooding the public aliases. Dedup via
  // group_key on the throttle dimension keeps the notification quiet
  // during the actual flood event.
  {
    key: 'abuse_mailbox_flood_detected',
    label: 'Abuse Mailbox Flood Detected',
    description: 'Per-sender or per-domain rate-limit triggered on the public abuse aliases',
    dedupWindow: '-1 hour',
    defaultEnabled: true,
    userToggleable: false,
  },

  // ─── N6c — digest envelope ─────────────────────────────────────────
  {
    key: 'notification_digest',
    label: 'Digest',
    description: 'Periodic summary of recent notifications',
    dedupWindow: '-12 hours',
    defaultEnabled: true,
    userToggleable: false,
  },
] as const;

/** Convenience: derived map of event_key → dedup window. Replaces the
 *  hand-maintained RATE_LIMITS object in `src/lib/notifications.ts`. */
export const NOTIFICATION_EVENT_DEDUP: Record<NotificationEventKey, string> = Object.fromEntries(
  NOTIFICATION_EVENTS.map((e) => [e.key, e.dedupWindow])
) as Record<NotificationEventKey, string>;

/** Convenience: events the UI matrix renders + the preference handlers
 *  read/write columns for. Filters out system events. */
export const USER_TOGGLEABLE_EVENTS: readonly NotificationEventDef[] =
  NOTIFICATION_EVENTS.filter((e) => e.userToggleable);

// ─── Channels (push delivery preferences) ─────────────────────────────

export interface NotificationChannelDef {
  key: NotificationChannelKey;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export const NOTIFICATION_CHANNELS: readonly NotificationChannelDef[] = [
  {
    key: 'browser_notifications',
    label: 'Browser Notifications',
    description: 'Show desktop notifications when the page is open',
    defaultEnabled: false,
  },
  {
    key: 'push_notifications',
    label: 'Push Notifications',
    description: 'Mobile push notifications (PWA must be installed)',
    defaultEnabled: false,
  },
] as const;
