// /v2/profile — averrow-ops profile route.
//
// Per SHARED_LOGIN_SPEC §2 the Profile UI is canonical and shared
// across averrow-ops and averrow-tenant via @averrow/shared/profile.
// Both apps render the same ProfilePage; product-specific deltas
// (api client, feature flags, callbacks) flow in through props.
//
// To change the page structure, edit the shared component, NOT
// this wrapper.

import { useNavigate } from 'react-router-dom';
import { ProfilePage } from '@averrow/shared/profile';
import type { ProfileApiClient, PasskeyAdapter } from '@averrow/shared/profile';
import { useAuth } from '@/lib/auth';
import { InstallAppCard } from '@/components/InstallAppCard';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import {
  isPasskeySupported, registerPasskey, listPasskeys, removePasskey,
} from '@/lib/passkeys';

const apiClient: ProfileApiClient = {
  get:    (path) => api.get(path),
  patch:  (path, body) => api.patch(path, body),
  post:   (path, body) => api.post(path, body),
  delete: (path) => api.delete(path),
};

const passkeyAdapter: PasskeyAdapter = {
  isSupported: isPasskeySupported,
  list:        listPasskeys,
  register:    registerPasskey,
  remove:      removePasskey,
};

export function Profile() {
  const navigate = useNavigate();
  const { user, refreshUser, logout } = useAuth();
  const { showToast } = useToast();

  if (!user) return null;

  return (
    <>
    <ProfilePage
      user={{
        id:               user.id,
        email:            user.email,
        name:             user.name,
        role:             user.role,
        display_name:     user.display_name ?? null,
        timezone:         user.timezone ?? null,
        theme_preference: user.theme_preference ?? null,
        passkey_count:    user.passkey_count ?? 0,
        organization:     user.organization
          ? {
              id:    user.organization.id,
              name:  user.organization.name,
              slug:  user.organization.slug,
              plan:  user.organization.plan,
              role:  user.organization.role,
            }
          : null,
      }}
      apiClient={apiClient}
      passkeyAdapter={passkeyAdapter}
      // Staff / admin Profile features. No 'billing' (handled per-org
      // by the customer admin elsewhere); 'security' uses the
      // admin sessions endpoint which super_admins can hit.
      features={['identity', 'account', 'preferences', 'passkeys', 'notifications', 'security']}
      productName="Averrow"
      productSubtitle="Threat Interceptor"
      onUserUpdated={() => { void refreshUser(); }}
      onToast={(msg, kind) => showToast(msg, kind)}
      onNavigate={(path) => navigate(path)}
      onLogout={() => { void logout(); }}
      sessionsEndpoint="/api/admin/sessions"
      revokeEndpoint={`/api/admin/users/${user.id}/force-logout`}
    />
    <InstallAppCard />
    </>
  );
}
