/**
 * Alert type registry — SINGLE SOURCE OF TRUTH for `alerts.alert_type`.
 *
 * Distinct from `notification-events.ts`:
 *   - Notifications  = inbox messages (info, digests, milestones).
 *   - Alerts         = security incidents that require triage. Have a
 *                      status workflow (new → acknowledged → investigating
 *                      → resolved | false_positive) and per-row
 *                      delivery tracking (email_sent, webhook_sent).
 *
 * Adding a new alert type:
 *   1. Append an `AlertTypeDef` here.
 *   2. Update the agent / scanner that writes the alert to import the
 *      key from this registry rather than passing a string literal.
 *   3. Recreate the `alerts` table CHECK constraint to include the new
 *      key (SQLite requires table recreation — see migration 0121 for
 *      the temp-table-swap pattern).
 *   4. The UI surfaces (alerts page filter pills, bell triage row) pick
 *      up the new type automatically via this registry's labels.
 *
 * `legacy: true` entries exist only to keep historical rows valid
 * against the CHECK constraint after migration 0121. They are excluded
 * from filter pills and "create new" affordances. Don't add new
 * legacy entries — fix the offending writer or migrate the rows.
 */

import type { NotificationSeverity } from './notification-events';

/** Alert severity — 4 levels (no `info`). Incidents either need
 *  attention or they don't; "info" alerts go through notifications. */
export type AlertSeverity = Exclude<NotificationSeverity, 'info'>;

export type AlertTypeKey =
  | 'social_impersonation'
  | 'phishing_detected'
  | 'email_grade_change'
  | 'lookalike_domain_active'
  | 'ct_certificate_issued'
  | 'threat_feed_match'
  | 'dark_web_mention'
  | 'app_store_impersonation'
  | 'geopolitical_threat'
  | 'bimi_removed'
  | 'dmarc_downgraded'
  | 'vmc_expiring'
  | 'typosquat_bimi'
  | 'takedown_resurrected'
  | 'campaign_impacts_brand'
  | 'threat_actor_targeting_brand'
  | 'unknown';

export interface AlertTypeDef {
  /** DB column value of `alerts.alert_type`. */
  key: AlertTypeKey;
  /** Human-facing title in filter pills + alert rows. */
  label: string;
  /** Subtitle / explanation in alert detail panels + tooltips. */
  description: string;
  /** Default severity when the source agent doesn't compute one. */
  defaultSeverity: AlertSeverity;
  /** Rate-limit window passed verbatim to SQLite `datetime('now', ?)`.
   *  Same dedup mechanic as notification-events.ts. */
  dedupWindow: string;
  /** Which agents/scanners write this alert type. Documentation only —
   *  not enforced anywhere. Helps "who fires this?" investigations. */
  writers: readonly string[];
  /** Legacy entry — kept for CHECK validity, excluded from UI surfaces. */
  legacy?: boolean;
}

export const ALERT_TYPES: readonly AlertTypeDef[] = [
  {
    key: 'social_impersonation',
    label: 'Social Impersonation',
    description: 'Impersonator account detected on a social platform',
    defaultSeverity: 'high',
    dedupWindow: '-6 hours',
    writers: ['cartographer', 'social_monitor'],
  },
  {
    key: 'phishing_detected',
    label: 'Phishing Detected',
    description: 'Phishing site or campaign targeting a monitored brand',
    defaultSeverity: 'critical',
    dedupWindow: '-1 hour',
    writers: ['analyst', 'sentinel'],
  },
  {
    key: 'email_grade_change',
    label: 'Email Grade Change',
    description: 'DMARC / SPF / DKIM grade dropped for a monitored brand',
    defaultSeverity: 'medium',
    dedupWindow: '-24 hours',
    writers: ['email_security_scanner'],
  },
  {
    key: 'lookalike_domain_active',
    label: 'Lookalike Domain',
    description: 'Typosquat or lookalike domain becoming active',
    defaultSeverity: 'high',
    dedupWindow: '-6 hours',
    writers: ['typosquat_scanner', 'cartographer'],
  },
  {
    key: 'ct_certificate_issued',
    label: 'Suspicious Certificate',
    description: 'Certificate issued for a monitored / lookalike domain',
    defaultSeverity: 'medium',
    dedupWindow: '-1 hour',
    writers: ['ct_monitor'],
  },
  {
    key: 'threat_feed_match',
    label: 'Threat Feed Match',
    description: 'A monitored brand appeared in a threat-intelligence feed',
    defaultSeverity: 'high',
    dedupWindow: '-1 hour',
    writers: ['analyst', 'sentinel'],
  },
  {
    key: 'dark_web_mention',
    label: 'Dark Web Mention',
    description: 'Brand mention found in a dark-web archive or paste site',
    defaultSeverity: 'medium',
    dedupWindow: '-6 hours',
    writers: ['dark_web_monitor'],
  },
  {
    key: 'app_store_impersonation',
    label: 'App Store Impersonation',
    description: 'iOS / Android app impersonating a monitored brand',
    defaultSeverity: 'high',
    dedupWindow: '-24 hours',
    writers: ['app_store_monitor'],
  },
  {
    key: 'geopolitical_threat',
    label: 'Geopolitical Threat',
    description: 'Nation-state attribution detected against monitored infrastructure',
    defaultSeverity: 'critical',
    dedupWindow: '-1 hour',
    writers: ['cartographer'],
  },
  {
    key: 'bimi_removed',
    label: 'BIMI Removed',
    description: 'Brand Indicators for Message Identification (BIMI) record removed',
    defaultSeverity: 'medium',
    dedupWindow: '-24 hours',
    writers: ['email_security_scanner'],
  },
  {
    key: 'dmarc_downgraded',
    label: 'DMARC Downgraded',
    description: 'DMARC policy downgraded (e.g. reject → quarantine → none)',
    defaultSeverity: 'high',
    dedupWindow: '-24 hours',
    writers: ['email_security_scanner'],
  },
  {
    key: 'vmc_expiring',
    label: 'VMC Expiring',
    description: 'Verified Mark Certificate approaching expiration',
    defaultSeverity: 'medium',
    dedupWindow: '-24 hours',
    writers: ['email_security_scanner'],
  },
  {
    key: 'typosquat_bimi',
    label: 'Typosquat with BIMI',
    description: 'Lookalike domain has BIMI configured — abuse vector for branded email',
    defaultSeverity: 'high',
    dedupWindow: '-6 hours',
    writers: ['lookalike_scanner'],
  },
  {
    key: 'takedown_resurrected',
    label: 'Takedown Resurrected',
    description: 'A previously taken-down threat is back online',
    defaultSeverity: 'critical',
    dedupWindow: '-1 hour',
    writers: ['sparrow', 'cartographer'],
  },
  {
    key: 'campaign_impacts_brand',
    label: 'Campaign Impacts Brand',
    description: 'A threat campaign passed the significance threshold and your brand is in its target set',
    defaultSeverity: 'high',
    // Match the campaign_escalation notification dedup so a single
    // campaign that grows over a day doesn't flood the brand inbox.
    dedupWindow: '-24 hours',
    writers: ['strategist'],
  },
  {
    key: 'threat_actor_targeting_brand',
    label: 'Threat Actor Targeting Brand',
    description: 'A known threat actor target list now includes your brand',
    defaultSeverity: 'high',
    // Actor target lists are slow-moving; a longer window prevents
    // re-firing on every observer/nexus refresh of the same actor.
    dedupWindow: '-7 days',
    writers: ['observer', 'nexus'],
  },

  // ─── Legacy ──────────────────────────────────────────────────
  // Pre-flight-controller alert rows. Kept valid against the CHECK
  // constraint introduced in migration 0121 so historical data isn't
  // dropped. Excluded from UI filter pills via `legacy: true`.
  {
    key: 'unknown',
    label: 'Unknown (legacy)',
    description: 'Pre-registry alert — alert_type was not categorized',
    defaultSeverity: 'low',
    dedupWindow: '-1 hour',
    writers: [],
    legacy: true,
  },
] as const;

/** Convenience: by-key lookup. Throws on unknown keys to surface typos. */
export function getAlertType(key: AlertTypeKey): AlertTypeDef {
  const def = ALERT_TYPES.find((t) => t.key === key);
  if (!def) {
    throw new Error(`Unknown alert type: ${key}. Add it to alert-types.ts.`);
  }
  return def;
}

/** All non-legacy alert types — what the UI renders in filter pills,
 *  what new alerts can use. */
export const USER_VISIBLE_ALERT_TYPES: readonly AlertTypeDef[] =
  ALERT_TYPES.filter((t) => !t.legacy);

/** Just the keys, useful for SQL `IN (...)` constructions. */
export const ALERT_TYPE_KEYS: readonly AlertTypeKey[] = ALERT_TYPES.map((t) => t.key);

/** SQL CHECK constraint clause — keep in sync with migration 0121.
 *  Exported so future migrations can stay aligned with the registry. */
export const ALERT_TYPE_CHECK_SQL = `alert_type IN (${
  ALERT_TYPE_KEYS.map((k) => `'${k}'`).join(', ')
})`;

/** SQL CHECK clause for severity — 4 levels, lowercase. */
export const ALERT_SEVERITY_CHECK_SQL =
  `severity IN ('critical', 'high', 'medium', 'low')`;
