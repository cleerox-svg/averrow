// Notification settings (ops host) — docs/ACCOUNT_DESIGN_SPEC.md §5.3.
//
// Wires the shared NotificationSettings sections to the ops hooks:
//   - per-event toggles           v1  GET/PATCH /api/notifications/preferences
//   - floors, cadence, summary,
//     quiet hours, critical flag  v2  GET/PUT   /api/notifications/preferences/v2
//   - brand overrides              /api/notifications/subscriptions
//   - push on/off/test for THIS browser (lib/push.ts)
// Quiet hours are read from and written to v2 only (owner decision D4).
//
// The sub-tab is a route segment (/settings/notifications/:tab). Without a
// :tab param (e.g. a test or another host) it falls back to local state.

import { useCallback, useState, type ReactElement } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageState, useMediaQuery, type SettingsLinkRenderProps } from '@averrow/shared/ui';
import {
  NotificationSettings, isNotificationTab,
  type NotificationPrefsV2, type NotificationTabId, type PushState,
} from '@averrow/shared/account';
import { useAuth } from '@/lib/auth';
import { useSettingsDirtyGuard, useSettingsRunGuarded } from './SettingsLayout';
import { getPushStatus, sendTestPush, subscribePush, unsubscribePush } from '@/lib/push';
import {
  useDeleteSubscription, useNotificationEventPreferences, useNotificationPreferencesV2,
  useNotificationSubscriptions, useUpdateNotificationEventPreferences,
  useUpdateNotificationPreferencesV2, useUpdateSubscription,
} from '@/hooks/useNotifications';

/** Server defaults (handlers/notifications.ts PREF_V2_DEFAULTS). A partial row is topped up from these. */
const V2_DEFAULTS: NotificationPrefsV2 = {
  inapp_severity_floor: 'info',
  push_severity_floor: 'low',
  email_severity_floor: 'high',
  digest_mode: 'daily',
  digest_severity_floor: 'medium',
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_timezone: 'UTC',
  critical_bypasses_quiet: 1,
  show_tenant_notifications: 0,
  cadence_intel: 'realtime',
  cadence_platform: 'realtime',
};

const DEVICES_HREF = '/settings/devices';
const PENDING_PUSH: PushState = { supported: true, permission: 'default', subscribed: false, needsInstall: false };

const renderRouterLink = (p: SettingsLinkRenderProps): ReactElement => (
  <Link
    to={p.href}
    className={p.className}
    aria-current={p['aria-current']}
    aria-disabled={p['aria-disabled']}
    tabIndex={p.tabIndex}
    onClick={p.onClick}
  >
    {p.children}
  </Link>
);

export interface NotificationSettingsPageProps {
  /** Override the route-derived tab (the host may own routing). */
  tab?: NotificationTabId;
  onTabChange?: (tab: NotificationTabId) => void;
  /** Hide the page title when the surrounding shell already renders one. */
  hideTitle?: boolean;
}

/** Toasts come from the ToastProvider in SettingsLayout. */
export function NotificationSettingsPage({ tab: tabProp, onTabChange: onTabChangeProp, hideTitle: hideTitleProp }: NotificationSettingsPageProps): ReactElement {
  // On mobile the settings shell already shows the section title.
  const isDesktop = useMediaQuery('(min-width: 1024px)', true);
  const hideTitle = hideTitleProp ?? !isDesktop;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { tab: routeTab } = useParams<{ tab?: string }>();
  const [localTab, setLocalTab] = useState<NotificationTabId>('channels');
  const reportDirty = useSettingsDirtyGuard();
  const runGuarded = useSettingsRunGuarded();

  const routed = routeTab !== undefined;
  const tab: NotificationTabId = tabProp ?? (routed && isNotificationTab(routeTab) ? routeTab : localTab);
  // Switching sub-tabs unmounts the quiet-hours form, so ask first when it has unsaved edits.
  const onTabChange = (next: NotificationTabId) => runGuarded(() => {
    if (onTabChangeProp) onTabChangeProp(next);
    else if (routed) navigate(`/settings/notifications/${next}`);
    else setLocalTab(next);
  });

  const eventsQ = useNotificationEventPreferences();
  const v2Q = useNotificationPreferencesV2();
  const subsQ = useNotificationSubscriptions();
  const updateV2 = useUpdateNotificationPreferencesV2();
  const updateEvents = useUpdateNotificationEventPreferences();
  const updateSub = useUpdateSubscription();
  const deleteSub = useDeleteSubscription();

  const pushQ = useQuery({ queryKey: ['push-status'], queryFn: getPushStatus });
  const [pushBusy, setPushBusy] = useState(false);

  const refreshPush = useCallback(async () => {
    await pushQ.refetch();
    void queryClient.invalidateQueries({ queryKey: ['push-devices'] });
  }, [pushQ, queryClient]);

  const enablePush = useCallback(async () => {
    setPushBusy(true);
    try {
      await subscribePush();
    } finally {
      setPushBusy(false);
      await refreshPush();
    }
  }, [refreshPush]);

  const disablePush = useCallback(async () => {
    setPushBusy(true);
    try {
      await unsubscribePush();
    } finally {
      setPushBusy(false);
      await refreshPush();
    }
  }, [refreshPush]);

  // Don't render the controls until preferences have loaded: on a failed fetch
  // every switch used to render "off" and silently do nothing.
  // An unknown sub-tab segment is a bad URL, not a silent alias for Channels.
  if (tabProp === undefined && routed && !isNotificationTab(routeTab)) {
    return <Navigate to="/settings/notifications/channels" replace />;
  }

  const failed = (eventsQ.isError && !eventsQ.data) || (v2Q.isError && !v2Q.data);
  const pending = !failed && ((eventsQ.isLoading && !eventsQ.data) || (v2Q.isLoading && !v2Q.data));

  const title = hideTitle ? null : (
    <header className="mb-5">
      <h2 className="m-0 text-[22px] font-extrabold tracking-[-0.3px] text-[var(--text-primary)]">Notifications</h2>
      <p className="m-0 mt-1 text-[14px] text-[var(--text-secondary)]">Choose what reaches you, where, and when.</p>
    </header>
  );

  if (failed || pending) {
    return (
      <div className="animate-fade-in pb-12">
        {title}
        {failed ? (
          <PageState
            kind="error"
            layout="card"
            title="Couldn't load your notification preferences"
            description="Your settings are unchanged. Try again in a moment."
            onRetry={() => {
              if (eventsQ.isError) void eventsQ.refetch();
              if (v2Q.isError) void v2Q.refetch();
            }}
          />
        ) : (
          <PageState kind="loading" layout="card" title="Loading preferences…" />
        )}
      </div>
    );
  }

  const prefs: NotificationPrefsV2 = { ...V2_DEFAULTS, ...(v2Q.data ?? {}) };
  const push: PushState = { ...(pushQ.data ?? PENDING_PUSH), busy: pushBusy };

  return (
    <div className="animate-fade-in pb-12">
      {title}
      <NotificationSettings
        tab={tab}
        onTabChange={onTabChange}
        role={user?.role}
        email={user?.email ?? null}
        profileTimezone={user?.timezone ?? null}
        prefs={prefs}
        events={eventsQ.data ?? {}}
        subscriptions={(subsQ.data ?? []).map((s) => ({ brand_id: s.brand_id, brand_name: s.brand_name, level: s.level }))}
        push={push}
        onUpdatePrefs={(patch, options) => updateV2.mutateAsync({ patch, options })}
        onUpdateEvents={(patch) => updateEvents.mutateAsync(patch)}
        onSetBrandLevel={(brandId, level) => updateSub.mutateAsync({ brandId, level })}
        onRemoveBrand={(brandId) => deleteSub.mutateAsync(brandId)}
        onEnablePush={enablePush}
        onDisablePush={disablePush}
        onSendTestPush={sendTestPush}
        onDirtyChange={reportDirty}
        devicesHref={DEVICES_HREF}
        renderLink={renderRouterLink}
      />
    </div>
  );
}
