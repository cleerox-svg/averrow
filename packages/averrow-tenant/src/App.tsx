import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/lib/auth';
import { Shell } from '@/layout/Shell';
import { Modules } from '@/features/modules/Modules';
import { ModulePlaceholder } from '@/features/modules/ModulePlaceholder';
import { Settings, TakedownAuthorizationPage } from '@/features/settings/Settings';
import { Alerts } from '@/features/alerts/Alerts';
import { Notifications } from '@/features/notifications/NotificationsInbox';
import { Domain } from '@/features/domain/Domain';
import { BrandDomainFindings } from '@/features/domain/BrandDomainFindings';
import { Social } from '@/features/social/Social';
import { BrandSocialFindings } from '@/features/social/BrandSocialFindings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter basename="/tenant">
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Modules />} />
              <Route path="alerts" element={<Alerts />} />
              <Route path="notifications" element={<Notifications />} />

              {/* Domain Monitoring — first per-module surface (Phase B sprint 1) */}
              <Route path="modules/domain"                    element={<Domain />} />
              <Route path="modules/domain/brands/:brandId"    element={<BrandDomainFindings />} />

              {/* Social Media Impersonation — Phase B sprint 3 */}
              <Route path="modules/social"                    element={<Social />} />
              <Route path="modules/social/brands/:brandId"    element={<BrandSocialFindings />} />
              <Route path="modules/app-store"     element={<ModulePlaceholder moduleKey="app_store" />} />
              <Route path="modules/dark-web"      element={<ModulePlaceholder moduleKey="dark_web" />} />
              <Route path="modules/abuse-mailbox" element={<ModulePlaceholder moduleKey="abuse_mailbox" />} />
              <Route path="modules/trademark"     element={<ModulePlaceholder moduleKey="trademark" />} />
              <Route path="modules/threat-actor"  element={<ModulePlaceholder moduleKey="threat_actor" />} />

              <Route path="settings" element={<Settings />} />
              <Route path="settings/takedown-authorization" element={<TakedownAuthorizationPage />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
