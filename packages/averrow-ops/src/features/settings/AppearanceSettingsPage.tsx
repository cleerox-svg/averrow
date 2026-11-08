// /settings/appearance — averrow-ops wrapper around the shared
// AppearanceSettings (accent + background, account-synced). The page lives in
// @averrow/shared/account; this injects the ops api client. Edit the shared
// component, not this file.
//
// Live since the P3-6 flip. With FACELIFT reverted APPEARANCE_PICKER_ENABLED is
// false: the section is not listed and this route redirects to Profile.

import { Navigate } from 'react-router-dom';
import { AppearanceSettings } from '@averrow/shared/account';
import { APPEARANCE_PICKER_ENABLED } from '@averrow/shared/theme';
import { api } from '@/lib/api';

const apiClient = {
  patch: <T,>(path: string, body: unknown) => api.patch<T>(path, body),
};

export function AppearanceSettingsPage() {
  if (!APPEARANCE_PICKER_ENABLED) return <Navigate to="/settings/profile" replace />;
  return <AppearanceSettings apiClient={apiClient} />;
}
