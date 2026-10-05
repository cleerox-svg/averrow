// /account/notifications/:tab — averrow-tenant host for the shared NotificationSettings.
//
// Preferences, per-event toggles and brand overrides are wired to the same
// caller-scoped endpoints as ops (lib/accountNotifications.ts). Customers see
// brand overrides (the shared page hides only the staff-only groups, by role).
//
// Push is not available in this app: the tenant ships a manifest but no service
// worker (CLAUDE.md §5, S12). The page is handed a permanently-unsupported push
// state, so the shared Channels tab disables the push switch/test and shows its
// own "Push isn't available here" banner; email and the in-app bell still work.
// There is no Devices & App page, so no devicesHref is passed.

import { useState, type ReactElement } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { PageState, useMediaQuery, type SettingsLinkRenderProps } from '@averrow/shared/ui';
import {
  NotificationSettings, isNotificationTab,
  type NotificationPrefsV2, type NotificationTabId, type PushState,
} from '@averrow/shared/account';
import { useAuth } from '@/lib/auth';
import {
  V2_DEFAULTS, useDeleteSubscription, useNotificationEventPreferences, useNotificationPreferencesV2,
  useNotificationSubscriptions, useUpdateNotificationEventPreferences,
  useUpdateNotificationPreferencesV2, useUpdateSubscription,
} from '@/lib/accountNotifications';
import { ACCOUNT_BASE_PATH, useAccountDirtyGuard, useAccountRunGuarded } from './AccountLayout';

const NO_PUSH: PushState = { supported: false, permission: 'unsupported', subscribed: false, needsInstall: false };

const PUSH_UNAVAILABLE = async (): Promise<never> => {
  throw new Error("Push isn't available in this app yet.");
};

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

/** Toasts come from the ToastProvider in AccountLayout. */
export function NotificationSettingsPage(): ReactElement {
  const isDesktop = useMediaQuery('(min-width: 1024px)', true);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { tab: routeTab } = useParams<{ tab?: string }>();
  const [localTab, setLocalTab] = useState<NotificationTabId>('channels');
  const reportDirty = useAccountDirtyGuard();
  const runGuarded = useAccountRunGuarded();

  const routed = routeTab !== undefined;
  const tab: NotificationTabId = routed && isNotificationTab(routeTab) ? routeTab : localTab;
  // Switching sub-tabs unmounts the quiet-hours form, so ask first when it has unsaved edits.
  const onTabChange = (next: NotificationTabId) => runGuarded(() => {
    if (routed) navigate(`${ACCOUNT_BASE_PATH}/notifications/${next}`);
    else setLocalTab(next);
  });

  const eventsQ = useNotificationEventPreferences();
  const v2Q = useNotificationPreferencesV2();
  const subsQ = useNotificationSubscriptions();
  const updateV2 = useUpdateNotificationPreferencesV2();
  const updateEvents = useUpdateNotificationEventPreferences();
  const updateSub = useUpdateSubscription();
  const deleteSub = useDeleteSubscription();

  // An unknown sub-tab segment is a bad URL, not a silent alias for Channels.
  if (routed && !isNotificationTab(routeTab)) {
    return <Navigate to={`${ACCOUNT_BASE_PATH}/notifications/channels`} replace />;
  }

  // Don't render the controls until preferences have loaded: on a failed fetch
  // every switch would render "off" and silently do nothing.
  const failed = (eventsQ.isError && !eventsQ.data) || (v2Q.isError && !v2Q.data);
  const pending = !failed && ((eventsQ.isLoading && !eventsQ.data) || (v2Q.isLoading && !v2Q.data));

  // On mobile the settings shell already shows the section title.
  const title = isDesktop ? (
    <header className="mb-5">
      <h2 className="m-0 text-[22px] font-extrabold tracking-[-0.3px] text-[var(--text-primary)]">Notifications</h2>
      <p className="m-0 mt-1 text-[14px] text-[var(--text-secondary)]">Choose what reaches you, where, and when.</p>
    </header>
  ) : null;

  if (failed || pending) {
    return (
      <div className="pb-12">
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

  return (
    <div className="pb-12">
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
        push={NO_PUSH}
        onUpdatePrefs={(patch, options) => updateV2.mutateAsync({ patch, options })}
        onUpdateEvents={(patch) => updateEvents.mutateAsync(patch)}
        onSetBrandLevel={(brandId, level) => updateSub.mutateAsync({ brandId, level })}
        onRemoveBrand={(brandId) => deleteSub.mutateAsync(brandId)}
        onEnablePush={PUSH_UNAVAILABLE}
        onDisablePush={PUSH_UNAVAILABLE}
        onSendTestPush={PUSH_UNAVAILABLE}
        onDirtyChange={reportDirty}
        renderLink={renderRouterLink}
      />
    </div>
  );
}
