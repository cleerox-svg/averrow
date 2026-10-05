// /settings/security — averrow-ops mount of the shared Security page
// (docs/ACCOUNT_DESIGN_SPEC.md §5.2). The page itself lives in
// @averrow/shared/account; this wrapper only injects the ops API client, the
// passkey adapter and the post-sign-out behaviour.

import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  SecuritySettings, createStrictPasskeyAdapter, type SecurityApiClient,
} from '@averrow/shared/account';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { isPasskeySupported, registerPasskey } from '@/lib/passkeys';
import { ACCOUNT_SUMMARY_KEYS } from './useAccountSummaries';

/** Ops API client; writes refresh the session count on the settings home. */
function makeSecurityApi(onWrite: () => void): SecurityApiClient {
  return {
    get:    (path) => api.get(path),
    post: async <T,>(path: string, body?: unknown) => {
      const r = await api.post<T>(path, body);
      onWrite();
      return r;
    },
    delete: async <T,>(path: string) => {
      const r = await api.delete<T>(path);
      onWrite();
      return r;
    },
  };
}

// Staff admins must hold a passkey (worker enrollScopeFor): removing the last
// one sends them back through enrollment on the next sign-in.
const PASSKEY_REQUIRED_ROLES = new Set(['admin', 'super_admin']);

export function SecurityPage() {
  const { user, refreshUser, logout } = useAuth();
  const queryClient = useQueryClient();
  const securityApi = useMemo(
    () => makeSecurityApi(() => { void queryClient.invalidateQueries({ queryKey: ACCOUNT_SUMMARY_KEYS.sessions }); }),
    [queryClient],
  );

  const passkeys = useMemo(() => createStrictPasskeyAdapter({
    api: securityApi,
    isSupported: isPasskeySupported,
    register: registerPasskey,
  }), [securityApi]);

  if (!user) return null;

  return (
    // Toasts come from the ToastProvider in SettingsLayout.
    <SecuritySettings
        api={securityApi}
        passkeys={passkeys}
        requiresPasskey={PASSKEY_REQUIRED_ROLES.has(user.role)}
        onPasskeysChanged={() => { void refreshUser(); }}
        // The server already revoked every session; logout() clears local
        // state (its own POST is best-effort) and navigates to sign-in.
        onSignedOut={() => { void logout(); }}
    />
  );
}

export default SecurityPage;
