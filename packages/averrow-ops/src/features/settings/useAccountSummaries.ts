// Live one-line summaries for the /settings home list (spec §5.0). Reuses the
// existing endpoints (no new ones). The Security and Devices pages invalidate
// ACCOUNT_SUMMARY_KEYS after changes so the home list stays current. Anything still loading is left undefined and the shell
// falls back to the generic description.

import { useQuery } from '@tanstack/react-query';
import {
  devicesSummary, normalizeSessions, notificationsSummary, securitySummary,
  type AccountSectionId, type PushState,
} from '@averrow/shared/account';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { useNotificationPreferencesV2 } from '@/hooks/useNotifications';
import { getPushStatus, listPushDevices } from '@/lib/push';

/** Query keys the settings home reads; pages that change these invalidate them. */
export const ACCOUNT_SUMMARY_KEYS = {
  sessions: ['account-summary', 'sessions'],
  pushDevices: ['push-devices'],
} as const;

export function useAccountSummaries(): Partial<Record<AccountSectionId, string>> {
  const { user } = useAuth();
  const install = useInstallPrompt();

  const sessionsQ = useQuery({
    queryKey: ACCOUNT_SUMMARY_KEYS.sessions,
    queryFn: async () => {
      const res = await api.get<unknown>('/api/auth/sessions');
      return normalizeSessions(res.data).sessions.length;
    },
  });
  const prefsQ = useNotificationPreferencesV2();
  const pushQ = useQuery({ queryKey: ['push-status'], queryFn: getPushStatus });
  const devicesQ = useQuery({
    queryKey: ACCOUNT_SUMMARY_KEYS.pushDevices,
    queryFn: async () => (await listPushDevices()).length,
  });

  const passkeys = typeof user?.passkey_count === 'number' ? user.passkey_count : null;
  const push: PushState | null = pushQ.data ?? null;

  // A user with no stored v2 row gets the server defaults (handlers/notifications.ts).
  const prefs = prefsQ.isSuccess
    ? { push_severity_floor: prefsQ.data?.push_severity_floor ?? 'low', email_severity_floor: prefsQ.data?.email_severity_floor ?? 'high' }
    : null;

  const out: Partial<Record<AccountSectionId, string>> = {};
  const security = securitySummary({ passkeys, sessions: sessionsQ.data ?? null });
  const notifications = notificationsSummary(prefs, push);
  const devices = devicesSummary({ devices: devicesQ.data ?? null, installed: install.isStandalone });
  if (security) out.security = security;
  if (notifications) out.notifications = notifications;
  if (devices) out.devices = devices;
  return out;
}
