import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/lib/auth';
import { Shell } from '@/layout/Shell';
import { Modules } from '@/features/modules/Modules';
import { ModulePlaceholder } from '@/features/modules/ModulePlaceholder';
import { Settings, TakedownAuthorizationPage } from '@/features/settings/Settings';
import { AutomationPolicy } from '@/features/settings/AutomationPolicy';
import { MonitoringRules } from '@/features/settings/MonitoringRules';
import { AuditLog } from '@/features/settings/AuditLog';
import { Members } from '@/features/settings/Members';
import { Profile } from '@/features/profile/Profile';
import { Billing } from '@/features/billing/Billing';
import { Alerts } from '@/features/alerts/Alerts';
import { IntelligenceCard } from '@/features/alerts/IntelligenceCard';
import { Threats } from '@/features/threats/Threats';
import { Notifications } from '@/features/notifications/NotificationsInbox';
import { Domain } from '@/features/domain/Domain';
import { BrandDomainFindings } from '@/features/domain/BrandDomainFindings';
import { Social } from '@/features/social/Social';
import { BrandSocialFindings } from '@/features/social/BrandSocialFindings';
import { AppStore } from '@/features/app-store/AppStore';
import { BrandAppStoreFindings } from '@/features/app-store/BrandAppStoreFindings';
import { DarkWeb } from '@/features/dark-web/DarkWeb';
import { BrandDarkWebFindings } from '@/features/dark-web/BrandDarkWebFindings';
import { AbuseMailbox } from '@/features/abuse-mailbox/AbuseMailbox';
import { Trademark } from '@/features/trademark/Trademark';
import { BrandTrademarkFindings } from '@/features/trademark/BrandTrademarkFindings';
import { ThreatActor } from '@/features/threat-actor/ThreatActor';
import { ThreatActorDetail } from '@/features/threat-actor/ThreatActorDetail';
import { Takedowns } from '@/features/takedowns/Takedowns';
import { TakedownDetail } from '@/features/takedowns/TakedownDetail';
import { Console } from '@/features/console/Console';
import { Investigations } from '@/features/investigations/Investigations';
import { InvestigationDetail } from '@/features/investigations/InvestigationDetail';

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
              <Route path="console" element={<Console />} />
              <Route path="threats" element={<Threats />} />
              <Route path="alerts" element={<Alerts />} />
              <Route path="alerts/:alertId" element={<IntelligenceCard />} />
              <Route path="investigations" element={<Investigations />} />
              <Route path="investigations/:investigationId" element={<InvestigationDetail />} />
              <Route path="notifications" element={<Notifications />} />

              {/* Takedowns — Phase C sprint 4 */}
              <Route path="takedowns"                element={<Takedowns />} />
              <Route path="takedowns/:takedownId"    element={<TakedownDetail />} />

              {/* Domain Monitoring — first per-module surface (Phase B sprint 1) */}
              <Route path="modules/domain"                    element={<Domain />} />
              <Route path="modules/domain/brands/:brandId"    element={<BrandDomainFindings />} />

              {/* Social Media Impersonation — Phase B sprint 3 */}
              <Route path="modules/social"                    element={<Social />} />
              <Route path="modules/social/brands/:brandId"    element={<BrandSocialFindings />} />
              {/* App Store Impersonation — Phase B sprint 4 */}
              <Route path="modules/app-store"                    element={<AppStore />} />
              <Route path="modules/app-store/brands/:brandId"    element={<BrandAppStoreFindings />} />
              {/* Dark Web Monitoring — Phase B sprint 5 */}
              <Route path="modules/dark-web"                     element={<DarkWeb />} />
              <Route path="modules/dark-web/brands/:brandId"     element={<BrandDarkWebFindings />} />
              {/* Abuse Mailbox — Phase B sprint 6 */}
              <Route path="modules/abuse-mailbox"                element={<AbuseMailbox />} />
              {/* Trademark Infringement — Phase B sprint 7 */}
              <Route path="modules/trademark"                    element={<Trademark />} />
              <Route path="modules/trademark/brands/:brandId"    element={<BrandTrademarkFindings />} />
              {/* Threat-Actor Intelligence — Phase B sprint 8 */}
              <Route path="modules/threat-actor"                 element={<ThreatActor />} />
              <Route path="modules/threat-actor/actors/:actorId" element={<ThreatActorDetail />} />

              <Route path="profile" element={<Profile />} />
              <Route path="automation-policy" element={<AutomationPolicy />} />
              <Route path="settings/monitoring" element={<MonitoringRules />} />
              <Route path="audit-log" element={<AuditLog />} />
              <Route path="settings" element={<Settings />} />
              <Route path="settings/takedown-authorization" element={<TakedownAuthorizationPage />} />
              <Route path="settings/billing" element={<Billing />} />
              <Route path="settings/members" element={<Members />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
