// @averrow/shared account/notifications — the notification settings sections.
// Own barrel: the account barrel (account/index.ts) is owned by the Profile
// work; the orchestrator re-exports this file from there.

export { NotificationSettings, NOTIFICATION_TAB_LABELS } from './NotificationSettings';
export { SummaryStrip, summarizeNotifications } from './SummaryStrip';
export { ChannelsSection } from './ChannelsSection';
export { EventsSection } from './EventsSection';
export { DigestSection } from './DigestSection';
export { QuietHoursSection } from './QuietHoursSection';
export { useAutosave, SavedMark, useOnline, SAVE_ERROR_MESSAGE, type Autosave } from './useAutosave';
export {
  isStaffRole, buildEventGroups, hasQuietWindow, resolveQuietTimezone,
  FLOOR_OPTIONS, FLOOR_OPTIONS_WITH_OFF, CADENCE_OPTIONS, DIGEST_FLOOR_OPTIONS,
  DEFAULT_QUIET_START, DEFAULT_QUIET_END,
} from './helpers';
export {
  NOTIFICATION_TABS, isNotificationTab,
  type NotificationTabId, type NotificationSettingsProps, type NotificationPrefsV2,
  type BrandSubscription, type PushState, type PushPermissionState, type UpdatePrefsOptions,
  type SeverityFloor, type SeverityFloorWithOff, type DigestMode, type DigestSeverityFloor,
  type GroupCadence, type SubscriptionLevel,
} from './types';
