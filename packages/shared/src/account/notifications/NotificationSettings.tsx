// Notification settings (docs/ACCOUNT_DESIGN_SPEC.md §5.3): a summary strip,
// then four sub-tabs — Channels, Events, Summary, Quiet hours. Presentational:
// data + callbacks in, no router or API client. The host maps `tab` to a route
// (ops: /settings/notifications/:tab).

import type { ReactElement } from 'react';
import { InlineBanner, Tabs, type Tab } from '../../ui';
import { ChannelsSection } from './ChannelsSection';
import { EventsSection } from './EventsSection';
import { DigestSection } from './DigestSection';
import { QuietHoursSection } from './QuietHoursSection';
import { SummaryStrip } from './SummaryStrip';
import { isStaffRole } from './helpers';
import { useAutosave, useOnline } from './useAutosave';
import { isNotificationTab, type NotificationSettingsProps, type NotificationTabId } from './types';

export const NOTIFICATION_TAB_LABELS: ReadonlyArray<Tab> = [
  { id: 'channels', label: 'Channels' },
  { id: 'events', label: 'Events' },
  { id: 'digest', label: 'Summary' },
  { id: 'quiet-hours', label: 'Quiet hours' },
];

export function NotificationSettings(props: NotificationSettingsProps): ReactElement {
  const {
    tab, onTabChange, role, email, profileTimezone, prefs, events, subscriptions, push,
    onUpdatePrefs, onUpdateEvents, onSetBrandLevel, onRemoveBrand,
    onEnablePush, onDisablePush, onSendTestPush, devicesHref, renderLink, className,
  } = props;

  const autosave = useAutosave();
  const online = useOnline();
  const isStaff = isStaffRole(role);
  const isSuperAdmin = role === 'super_admin';
  const active: NotificationTabId = isNotificationTab(tab) ? tab : 'channels';
  const common = { autosave, online };

  return (
    <div className={className}>
      <div className="space-y-4">
        <SummaryStrip prefs={prefs} push={push} />
        {!online && (
          <InlineBanner tone="warn" title="You're offline">
            Changes will not save until you're back online.
          </InlineBanner>
        )}
        <Tabs
          tabs={[...NOTIFICATION_TAB_LABELS]}
          activeTab={active}
          onChange={(id) => { if (isNotificationTab(id)) onTabChange(id); }}
          variant="underline"
          size="md"
          activation="auto"
          linkedPanels
          aria-label="Notification settings"
        />
      </div>

      <div
        role="tabpanel"
        id={`tabpanel-${active}`}
        aria-labelledby={`tab-${active}`}
        tabIndex={-1}
        className="mt-6 outline-none"
      >
        {active === 'channels' && (
          <ChannelsSection
            {...common}
            prefs={prefs}
            push={push}
            email={email}
            role={role}
            isStaff={isStaff}
            isSuperAdmin={isSuperAdmin}
            devicesHref={devicesHref}
            renderLink={renderLink}
            onUpdatePrefs={onUpdatePrefs}
            onEnablePush={onEnablePush}
            onDisablePush={onDisablePush}
            onSendTestPush={onSendTestPush}
          />
        )}
        {active === 'events' && (
          <EventsSection
            {...common}
            events={events}
            subscriptions={subscriptions}
            isStaff={isStaff}
            onUpdateEvents={onUpdateEvents}
            onSetBrandLevel={onSetBrandLevel}
            onRemoveBrand={onRemoveBrand}
          />
        )}
        {active === 'digest' && (
          <DigestSection {...common} prefs={prefs} onUpdatePrefs={onUpdatePrefs} />
        )}
        {active === 'quiet-hours' && (
          <QuietHoursSection
            {...common}
            prefs={prefs}
            profileTimezone={profileTimezone}
            onUpdatePrefs={onUpdatePrefs}
          />
        )}
      </div>
    </div>
  );
}
