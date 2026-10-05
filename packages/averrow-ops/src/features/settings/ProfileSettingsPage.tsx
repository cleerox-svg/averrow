// /settings/profile — averrow-ops wrapper around the shared ProfileSettings.
// The page itself lives in @averrow/shared/account; this injects the ops api
// client, session user and theme hook. Edit the shared component, not this file.

import { ProfileSettings, type ProfileSettingsUser } from '@averrow/shared/account';
import { useTheme } from '@/design-system/hooks/useTheme';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSettingsDirtyGuard } from './SettingsLayout';

const apiClient = {
  patch: <T,>(path: string, body: unknown) => api.patch<T>(path, body),
};

export function ProfileSettingsPage() {
  const { user, loading, refreshUser, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const reportDirty = useSettingsDirtyGuard();

  const profileUser: ProfileSettingsUser | null = user
    ? {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        display_name: user.display_name ?? null,
        timezone: user.timezone ?? null,
        passkey_count: user.passkey_count ?? 0,
        created_at: user.created_at ?? null,
        organization: user.organization ? { name: user.organization.name, role: user.organization.role } : null,
      }
    : null;

  return (
    <ProfileSettings
      user={profileUser}
      loading={loading}
      apiClient={apiClient}
      theme={theme}
      onThemeChange={setTheme}
      onUserUpdated={refreshUser}
      onSignOut={() => { void logout(); }}
      onDirtyChange={reportDirty}
    />
  );
}
