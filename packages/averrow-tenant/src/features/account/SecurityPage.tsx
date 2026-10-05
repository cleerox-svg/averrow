// /account/security — averrow-tenant mount of the shared SecuritySettings.
//
// Sessions use the caller-scoped /api/auth/sessions endpoints (requireAuth, own
// rows only — they work for client users, unlike the old staff-only admin list),
// so the default endpoints (per-session sign-out + "sign out other devices") stay on.

import { useMemo } from 'react';
import { SecuritySettings, createStrictPasskeyAdapter, type SecurityApiClient } from '@averrow/shared/account';
import { useAuth } from '@/lib/auth';
import { accountApi } from '@/lib/accountApi';
import { isPasskeySupported, registerPasskey } from '@/lib/passkeys';

const securityApi: SecurityApiClient = {
  get:    (path) => accountApi.get(path),
  post:   (path, body) => accountApi.post(path, body),
  delete: (path) => accountApi.delete(path),
};

export function SecurityPage() {
  const { user, refreshUser, logout } = useAuth();

  const passkeys = useMemo(() => createStrictPasskeyAdapter({
    api: securityApi,
    isSupported: isPasskeySupported,
    register: registerPasskey,
  }), []);

  if (!user) return null;

  return (
    // Toasts come from the ToastProvider in AccountLayout. Customers are never
    // forced to hold a passkey (that rule is staff-admin only), so requiresPasskey is off.
    <SecuritySettings
      api={securityApi}
      passkeys={passkeys}
      requiresPasskey={false}
      onPasskeysChanged={() => { void refreshUser(); }}
      // The server already revoked every session; logout() clears local state.
      onSignedOut={() => { void logout(); }}
    />
  );
}

export default SecurityPage;
