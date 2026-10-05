// Notification settings — data contracts. The section components are
// presentational: they take the current data plus async callbacks and never
// import an API client or router, so ops mounts them today and the customer
// app can mount them later with its own adapter.
//
// Every callback returns a Promise that REJECTS on failure. The component
// shows the error (row message + toast); keeping the visible value in step
// with the server (optimistic update + rollback) is the adapter's job — see
// averrow-ops hooks/useNotifications.ts.

import type { SettingsRenderLink } from '../../ui';

export type SeverityFloor = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type SeverityFloorWithOff = SeverityFloor | 'off';
export type DigestMode = 'realtime' | 'hourly' | 'daily' | 'weekly' | 'off';
export type DigestSeverityFloor = 'high' | 'medium' | 'low' | 'info';
export type GroupCadence = 'realtime' | 'daily_digest' | 'weekly_digest';
export type SubscriptionLevel = 'watching' | 'default' | 'ignored';

/** Mirrors GET/PUT /api/notifications/preferences/v2. */
export interface NotificationPrefsV2 {
  inapp_severity_floor: SeverityFloor;
  push_severity_floor: SeverityFloorWithOff;
  email_severity_floor: SeverityFloorWithOff;
  digest_mode: DigestMode;
  digest_severity_floor: DigestSeverityFloor;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string;
  critical_bypasses_quiet: number;
  show_tenant_notifications: number;
  cadence_intel: GroupCadence;
  cadence_platform: GroupCadence;
}

export interface BrandSubscription {
  brand_id: string;
  brand_name: string | null;
  level: SubscriptionLevel;
}

export type PushPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/** What this browser can do right now. `busy` covers enable/disable in flight. */
export interface PushState {
  supported: boolean;
  permission: PushPermissionState;
  subscribed: boolean;
  /** iOS: the app must be added to the Home Screen before push can be turned on. */
  needsInstall: boolean;
  busy?: boolean;
}

export const NOTIFICATION_TABS = ['channels', 'events', 'digest', 'quiet-hours'] as const;
export type NotificationTabId = (typeof NOTIFICATION_TABS)[number];

export function isNotificationTab(value: string | null | undefined): value is NotificationTabId {
  return !!value && (NOTIFICATION_TABS as readonly string[]).includes(value);
}

/** Options for a pref write. `optimistic: false` = explicit-save form (no cache flip). */
export interface UpdatePrefsOptions { optimistic?: boolean }

export interface NotificationSettingsProps {
  /** Active sub-tab (a route segment in ops: /settings/notifications/:tab). */
  tab: NotificationTabId;
  onTabChange: (tab: NotificationTabId) => void;

  /** Global role of the signed-in user (`users.role`). Drives staff-only content. */
  role: string | null | undefined;
  /** Where email alerts go (read-only). */
  email: string | null;
  /** The user's profile time zone (IANA) — default for quiet hours. */
  profileTimezone: string | null;

  prefs: NotificationPrefsV2;
  /** Per-event toggles keyed by event key (the v1 endpoint — no v2 columns exist). */
  events: Record<string, boolean>;
  subscriptions: BrandSubscription[];
  push: PushState;

  onUpdatePrefs: (patch: Partial<NotificationPrefsV2>, options?: UpdatePrefsOptions) => Promise<void>;
  onUpdateEvents: (patch: Record<string, boolean>) => Promise<void>;
  onSetBrandLevel: (brandId: string, level: SubscriptionLevel) => Promise<void>;
  onRemoveBrand: (brandId: string) => Promise<void>;
  onEnablePush: () => Promise<void>;
  onDisablePush: () => Promise<void>;
  onSendTestPush: () => Promise<{ attempted: number; delivered: number }>;

  /** Reports unsaved quiet-hours edits so the host can guard navigation. */
  onDirtyChange?: (dirty: boolean) => void;

  /** Where push devices are managed (Devices & App). Renders a link row when set. */
  devicesHref?: string;
  renderLink?: SettingsRenderLink;
  className?: string;
}
