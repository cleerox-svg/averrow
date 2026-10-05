// Account-area route table (docs/ACCOUNT_DESIGN_SPEC.md §2), spread into the
// tenant router's <Shell> layout route. Kept in its own module so tests can mount
// it without the whole app.
//
// Mounted at /account, NOT /settings (that is the organisation area). There is no
// /account/devices: Devices & App needs a service worker, and the tenant has none
// yet (CLAUDE.md §5, S12). Unknown /account/* paths land on Profile.

import { Navigate, Route } from 'react-router-dom';
import { AccountIndex, AccountLayout } from './AccountLayout';
import { NotificationSettingsPage } from './NotificationSettingsPage';
import { ProfileSettingsPage } from './ProfileSettingsPage';
import { SecurityPage } from './SecurityPage';

export const accountRoutes = (
  <>
    <Route path="account" element={<AccountLayout />}>
      <Route index element={<AccountIndex />} />
      <Route path="profile" element={<ProfileSettingsPage />} />
      <Route path="security" element={<SecurityPage />} />
      <Route path="notifications" element={<Navigate to="/account/notifications/channels" replace />} />
      <Route path="notifications/:tab" element={<NotificationSettingsPage />} />
      <Route path="*" element={<Navigate to="/account/profile" replace />} />
    </Route>
    {/* Legacy profile route. */}
    <Route path="profile" element={<Navigate to="/account/profile" replace />} />
  </>
);
