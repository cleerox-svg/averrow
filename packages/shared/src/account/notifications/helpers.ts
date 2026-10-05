// Pure helpers + copy tables for the notification settings (no React).

import { USER_TOGGLEABLE_EVENTS, type NotificationEventDef } from '../../notification-events';
import { USER_ROLES } from '../../roles';
import { detectTimeZone } from '../../ui';
import type {
  DigestMode, DigestSeverityFloor, GroupCadence, NotificationPrefsV2,
  SeverityFloor, SeverityFloorWithOff, SubscriptionLevel,
} from './types';

// ─── Roles ──────────────────────────────────────────────────────────

/** Every global role except `client` is Averrow staff (mirrors the worker's isPlatformStaff). */
export function isStaffRole(role: string | null | undefined): boolean {
  return !!role && role !== 'client' && (USER_ROLES as readonly string[]).includes(role);
}

// ─── Copy tables (docs/ACCOUNT_DESIGN_SPEC.md §8) ───────────────────

export const FLOOR_OPTIONS: ReadonlyArray<{ value: SeverityFloor; label: string }> = [
  { value: 'info', label: 'Everything' },
  { value: 'low', label: 'Low and above' },
  { value: 'medium', label: 'Medium and above' },
  { value: 'high', label: 'High and above' },
  { value: 'critical', label: 'Critical only' },
];

export const FLOOR_OPTIONS_WITH_OFF: ReadonlyArray<{ value: SeverityFloorWithOff; label: string }> = [
  ...FLOOR_OPTIONS,
  { value: 'off', label: 'Off' },
];

export const DIGEST_FLOOR_OPTIONS: ReadonlyArray<{ value: DigestSeverityFloor; label: string }> = [
  { value: 'info', label: 'Everything' },
  { value: 'low', label: 'Low and above' },
  { value: 'medium', label: 'Medium and above' },
  { value: 'high', label: 'High and above' },
];

export const CADENCE_OPTIONS: ReadonlyArray<{ value: GroupCadence; label: string }> = [
  { value: 'realtime', label: 'Instantly' },
  { value: 'daily_digest', label: 'Daily summary' },
  { value: 'weekly_digest', label: 'Weekly summary' },
];

export const DIGEST_SEGMENTS: ReadonlyArray<{ value: Exclude<DigestMode, 'realtime'>; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

export const SUBSCRIPTION_LEVELS: ReadonlyArray<{ value: SubscriptionLevel; label: string; description: string }> = [
  { value: 'watching', label: 'Follow closely', description: 'Every alert for this brand.' },
  { value: 'default', label: 'Normal', description: 'Follows your level above.' },
  { value: 'ignored', label: 'Muted', description: 'No alerts for this brand.' },
];

export function floorLabel(value: SeverityFloorWithOff | undefined): string {
  return FLOOR_OPTIONS_WITH_OFF.find((o) => o.value === value)?.label ?? 'Everything';
}

// ─── Events ─────────────────────────────────────────────────────────

/** Plain-language rewrites of the registry's internal titles/descriptions. */
const EVENT_COPY: Record<string, { title: string; description: string }> = {
  brand_threat: { title: 'New threats against your brands', description: 'When a new threat targets a brand you watch.' },
  campaign_escalation: { title: 'Campaign escalations', description: 'When a campaign becomes more severe.' },
  email_security_change: { title: 'Email security changes', description: "When a brand's email protection grade changes." },
  takedown_awaiting_approval: { title: 'Takedowns waiting for you', description: 'When a takedown needs your approval before it is sent.' },
  intelligence_digest: { title: 'Intelligence summaries', description: "Daily and weekly roundups of what we're seeing." },
  feed_health: { title: 'Data feed problems', description: 'When a data feed slows down or fails.' },
  platform_feed_at_risk: { title: 'Feeds close to pausing', description: 'When a feed is close to being paused automatically.' },
  platform_agent_stalled: { title: 'Stalled agents', description: 'When an agent has been running for more than 15 minutes.' },
  agent_milestone: { title: 'Agent milestones', description: 'When an agent finishes a notable run.' },
};

export interface EventGroupDef {
  id: string;
  title: string;
  staffOnly: boolean;
  keys: readonly string[];
}

const EVENT_GROUPS: readonly EventGroupDef[] = [
  { id: 'threats', title: 'Threats and brands', staffOnly: false,
    keys: ['brand_threat', 'campaign_escalation', 'email_security_change', 'takedown_awaiting_approval'] },
  { id: 'intel', title: 'Intelligence', staffOnly: false, keys: ['intelligence_digest'] },
  { id: 'platform', title: 'Platform health', staffOnly: true,
    keys: ['feed_health', 'platform_feed_at_risk', 'platform_agent_stalled', 'agent_milestone'] },
];

export interface EventRowDef {
  key: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
}

export interface EventGroup {
  id: string;
  title: string;
  events: EventRowDef[];
}

function rowFor(def: NotificationEventDef): EventRowDef {
  const copy = EVENT_COPY[def.key];
  return {
    key: def.key,
    title: copy?.title ?? def.label,
    description: copy?.description ?? def.description,
    defaultEnabled: def.defaultEnabled,
  };
}

/**
 * The toggle groups to render. Events missing from the table above (a newly
 * registered toggleable event) land in "More alerts" so they never vanish.
 * Staff-only groups are dropped for non-staff users.
 */
export function buildEventGroups(isStaff: boolean): EventGroup[] {
  const byKey = new Map(USER_TOGGLEABLE_EVENTS.map((e) => [e.key as string, e]));
  const placed = new Set<string>();
  const out: EventGroup[] = [];
  for (const g of EVENT_GROUPS) {
    const events = g.keys.flatMap((k) => {
      const def = byKey.get(k);
      if (def) placed.add(k);
      return def ? [rowFor(def)] : [];
    });
    if (g.staffOnly && !isStaff) continue;
    if (events.length > 0) out.push({ id: g.id, title: g.title, events });
  }
  const rest = USER_TOGGLEABLE_EVENTS.filter((e) => !placed.has(e.key)).map(rowFor);
  if (rest.length > 0) out.push({ id: 'more', title: 'More alerts', events: rest });
  return out;
}

export function isEventOn(events: Record<string, boolean>, row: EventRowDef): boolean {
  return events[row.key] ?? row.defaultEnabled;
}

// ─── Quiet hours ────────────────────────────────────────────────────

export const DEFAULT_QUIET_START = '22:00';
export const DEFAULT_QUIET_END = '07:00';

export function hasQuietWindow(prefs: Pick<NotificationPrefsV2, 'quiet_hours_start' | 'quiet_hours_end'>): boolean {
  return !!prefs.quiet_hours_start && !!prefs.quiet_hours_end;
}

/**
 * The zone the quiet-hours picker shows. A saved window keeps its own zone.
 * Without one, v2 only holds the auto-seeded 'UTC' placeholder, so default to
 * the user's profile time zone (the Profile page writes it), else the zone the
 * browser reports, else whatever v2 has.
 */
export function resolveQuietTimezone(
  prefs: Pick<NotificationPrefsV2, 'quiet_hours_start' | 'quiet_hours_end' | 'quiet_hours_timezone'>,
  profileTimezone: string | null | undefined,
  detected: string | null = detectTimeZone(),
): string {
  if (hasQuietWindow(prefs) && prefs.quiet_hours_timezone) return prefs.quiet_hours_timezone;
  return profileTimezone || detected || prefs.quiet_hours_timezone || 'UTC';
}
