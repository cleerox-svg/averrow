// /account/appearance — averrow-tenant wrapper around the shared
// AppearanceSettings (accent + background, account-synced). The page lives in
// @averrow/shared/account; this injects the tenant api client. Edit the shared
// component, not this file.
//
// Hidden until the P3-6 flip: while APPEARANCE_PICKER_ENABLED is false the
// section is not listed and this route redirects to Profile.

import { Navigate } from 'react-router-dom';
import { AppearanceSettings } from '@averrow/shared/account';
import { APPEARANCE_PICKER_ENABLED } from '@averrow/shared/theme';
import { accountApi } from '@/lib/accountApi';

const apiClient = { patch: accountApi.patch };

export function AppearanceSettingsPage() {
  if (!APPEARANCE_PICKER_ENABLED) return <Navigate to="/account/profile" replace />;
  return <AppearanceSettings apiClient={apiClient} />;
}
