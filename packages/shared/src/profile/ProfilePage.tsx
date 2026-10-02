// Unified ProfilePage — single source of truth for /v2/profile and
// /tenant/profile per SHARED_LOGIN_SPEC §2. Both products import
// this same component and pass product-specific deltas (api
// client, feature set, callbacks).
//
// Section order is canonical and enforced here; the `features`
// prop controls which sections render. Adding a new section
// requires:
//   1. New entry in ProfileFeature union (types.ts)
//   2. New SectionXxx component (sections.tsx)
//   3. New conditional render below in canonical position
//   4. Update SHARED_LOGIN_SPEC §2 with the new section's spec
//
// Layout: single-scrolling-page-with-cards (Linear/Notion pattern).
// Future enhancement: left-rail nav + section anchors. The section
// composition is layout-agnostic so swapping the wrapper later is
// a single-file change.

import {
  IdentitySection, AccountSection, PreferencesSection, PasskeysSection,
  NotificationsSection, BillingSection, SecuritySection, SignOutSection,
} from './sections';
import type { ProfilePageProps } from './types';

const DEFAULT_NOTIFICATIONS_HREF = '/notifications/preferences';
const DEFAULT_BILLING_HREF       = '/settings/billing';

export function ProfilePage(props: ProfilePageProps) {
  const {
    user, apiClient, features, passkeyAdapter,
    productName, productSubtitle,
    onUserUpdated, onToast, onNavigate, onLogout,
    notificationsHref = DEFAULT_NOTIFICATIONS_HREF,
    billingHref       = DEFAULT_BILLING_HREF,
    sessionsEndpoint,
    revokeEndpoint,
  } = props;

  const has = (f: typeof features[number]) => features.includes(f);

  return (
    <div style={{
      maxWidth: 720,
      margin:   '0 auto',
      padding:  '32px 24px 64px',
    }}>
      {/* Page heading — productName + subtitle. Mobile-friendly. */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{
          fontSize:   24,
          fontWeight: 800,
          letterSpacing: -0.4,
          color:      'var(--text-primary)',
          margin:     0,
        }}>
          {productName} Profile
        </h1>
        {productSubtitle && (
          <p style={{
            margin:        '4px 0 0',
            fontSize:      10,
            fontFamily:    'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            fontWeight:    700,
            color:         'var(--amber, #E5A832)',
          }}>
            {productSubtitle}
          </p>
        )}
      </div>

      {/* 1. Identity — always shown */}
      {has('identity') && <IdentitySection user={user} />}

      {/* 2. Account */}
      {has('account') && (
        <AccountSection
          user={user}
          apiClient={apiClient}
          onUserUpdated={onUserUpdated}
          onToast={onToast}
        />
      )}

      {/* 3. Preferences */}
      {has('preferences') && (
        <PreferencesSection
          user={user}
          apiClient={apiClient}
          onUserUpdated={onUserUpdated}
          onToast={onToast}
        />
      )}

      {/* 4. Passkeys */}
      {has('passkeys') && (
        <PasskeysSection
          passkeyAdapter={passkeyAdapter}
          onUserUpdated={onUserUpdated}
          onToast={onToast}
        />
      )}

      {/* 5. Notifications (link row) */}
      {has('notifications') && (
        <NotificationsSection
          onNavigate={onNavigate}
          href={notificationsHref}
        />
      )}

      {/* 6. Billing — tenant only */}
      {has('billing') && (
        <BillingSection
          onNavigate={onNavigate}
          href={billingHref}
          user={user}
        />
      )}

      {/* 7. Security */}
      {has('security') && (
        <SecuritySection
          apiClient={apiClient}
          onToast={onToast}
          sessionsEndpoint={sessionsEndpoint}
          revokeEndpoint={revokeEndpoint}
        />
      )}

      {/* 8. Sign out — always last */}
      <SignOutSection onLogout={onLogout} />
    </div>
  );
}
