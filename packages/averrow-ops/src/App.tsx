import React, { Suspense } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Shell } from '@/components/layout/Shell';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Login } from '@/pages/Login';
import { NotFound } from '@/pages/NotFound';

// All feature routes are lazy-loaded so a cold visit to any single page
// doesn't pull every other feature's bundle (recharts, framer-motion,
// route-specific components). Observatory's deck.gl/maplibre stay isolated
// to that route. Login and NotFound stay eager because they're tiny and
// needed immediately at startup.
const Brands = React.lazy(() => import('@/features/brands/Brands').then(m => ({ default: m.BrandsV3 })));
// Scan Leads now lives as a tab inside /leads. Old /admin/scan-leads
// links (sidebar history, sales notification emails, bookmarks) keep
// working through a redirect — see the route definition below.
const BrandDetail = React.lazy(() => import('@/features/brands/BrandDetail').then(m => ({ default: m.BrandDetailV3 })));
const Apps = React.lazy(() => import('@/features/apps/Apps').then(m => ({ default: m.Apps })));
const DarkWeb = React.lazy(() => import('@/features/dark-web/DarkWeb').then(m => ({ default: m.DarkWeb })));
const Agents = React.lazy(() => import('@/features/agents/Agents').then(m => ({ default: m.Agents })));
const AgentApprovals = React.lazy(() => import('@/features/agents/AgentApprovals').then(m => ({ default: m.AgentApprovals })));
const AgentReview = React.lazy(() => import('@/features/agents/AgentReview').then(m => ({ default: m.AgentReview })));
const Takedowns = React.lazy(() => import('@/features/takedowns/Takedowns').then(m => ({ default: m.Takedowns })));
const SpamTrap = React.lazy(() => import('@/features/spam-trap/SpamTrap').then(m => ({ default: m.SpamTrap })));
const Alerts = React.lazy(() => import('@/features/alerts/Alerts').then(m => ({ default: m.Alerts })));
const Feeds = React.lazy(() => import('@/features/feeds/Feeds').then(m => ({ default: m.Feeds })));
const AdminDashboard = React.lazy(() => import('@/features/admin/AdminDashboard').then(m => ({ default: m.AdminDashboard })));
const AdminAbuseMailbox = React.lazy(() => import('@/features/admin/AdminAbuseMailbox').then(m => ({ default: m.AdminAbuseMailbox })));
const Organization = React.lazy(() => import('@/features/settings/Organization').then(m => ({ default: m.Organization })));
const SuperAdminOrgs = React.lazy(() => import('@/features/admin/SuperAdminOrgs').then(m => ({ default: m.SuperAdminOrgs })));
const PricingConfig = React.lazy(() => import('@/features/admin/PricingConfig').then(m => ({ default: m.PricingConfig })));
const AdminAudit = React.lazy(() => import('@/features/admin/AdminAudit').then(m => ({ default: m.AdminAudit })));
const Metrics = React.lazy(() => import('@/features/admin/Metrics').then(m => ({ default: m.Metrics })));
const AdminIncidents = React.lazy(() => import('@/features/admin-incidents/Incidents').then(m => ({ default: m.AdminIncidents })));
const AdminIncidentDetail = React.lazy(() => import('@/features/admin-incidents/IncidentDetail').then(m => ({ default: m.AdminIncidentDetail })));
const PushAdmin = React.lazy(() => import('@/features/admin/PushAdmin').then(m => ({ default: m.PushAdmin })));
const NotificationCenter = React.lazy(() => import('@/features/admin/NotificationCenter').then(m => ({ default: m.NotificationCenter })));
const ArchitectDetail = React.lazy(() => import('@/features/agents/ArchitectDetail').then(m => ({ default: m.ArchitectDetail })));
const Providers = React.lazy(() => import('@/features/providers/Providers').then(m => ({ default: m.Providers })));
const Campaigns = React.lazy(() => import('@/features/campaigns/Campaigns').then(m => ({ default: m.Campaigns })));
const CampaignDetail = React.lazy(() => import('@/features/campaigns/CampaignDetail').then(m => ({ default: m.CampaignDetail })));
const GeopoliticalCampaignDashboard = React.lazy(() => import('@/features/campaigns/GeopoliticalCampaignDashboard').then(m => ({ default: m.GeopoliticalCampaignDashboard })));
const Trends = React.lazy(() => import('@/features/trends/Trends').then(m => ({ default: m.Trends })));
const ThreatActors = React.lazy(() => import('@/features/threat-actors/ThreatActors').then(m => ({ default: m.ThreatActors })));
const Leads = React.lazy(() => import('@/features/leads/Leads').then(m => ({ default: m.Leads })));
const Home = React.lazy(() => import('@/pages/Home').then(m => ({ default: m.Home })));
const BrandAdminDashboard = React.lazy(() => import('@/features/admin/BrandAdminDashboard').then(m => ({ default: m.BrandAdminDashboard })));
const Threats = React.lazy(() => import('@/features/threats/Threats').then(m => ({ default: m.Threats })));
const Profile = React.lazy(() => import('@/features/settings/Profile').then(m => ({ default: m.Profile })));
const Notifications = React.lazy(() => import('@/features/settings/Notifications').then(m => ({ default: m.Notifications })));
const NotificationPreferences = React.lazy(() => import('@/features/settings/NotificationPreferences').then(m => ({ default: m.NotificationPreferences })));
const Observatory = React.lazy(() => import('@/features/observatory/Observatory').then(m => ({ default: m.Observatory })));
const ObservatoryV3 = React.lazy(() => import('@/features/observatory-v3/ObservatoryV3').then(m => ({ default: m.ObservatoryV3 })));

function RouteLoader() {
  return (
    <div className="flex items-center justify-center h-full min-h-[40vh]" style={{ background: 'var(--bg-page)' }}>
      <div className="font-mono text-sm" style={{ color: 'var(--text-secondary)' }}>Loading…</div>
    </div>
  );
}

function ObservatoryLoader() {
  return (
    <div className="flex items-center justify-center h-full" style={{ background: 'var(--bg-page)' }}>
      <div className="font-mono text-sm" style={{ color: 'var(--text-secondary)' }}>Loading Observatory...</div>
    </div>
  );
}

/**
 * Wrap a lazy-loaded route element in Suspense + ErrorBoundary.
 * Keeps the route table readable and ensures every lazy module
 * has a graceful fallback while its chunk loads.
 */
function lazyRoute(node: React.ReactNode, fallback: React.ReactNode = <RouteLoader />) {
  return (
    <ErrorBoundary>
      <Suspense fallback={fallback}>{node}</Suspense>
    </ErrorBoundary>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return <div className="flex items-center justify-center h-screen" style={{ background: 'var(--bg-page)' }}>
    <div className="font-mono text-sm" style={{ color: 'var(--text-secondary)' }}>Loading...</div>
  </div>;

  if (!isAuthenticated) {
    // Redirect to public homepage — don't trap users in an in-app login screen.
    // The public site has the proper "Sign In" flow via /login → /api/auth/login.
    window.location.href = '/';
    return null;
  }
  return <>{children}</>;
}

/**
 * Role-aware home route.
 * Brand admins land on their scoped dashboard.
 * Super admins land on Observatory (desktop) or Mobile Command Center (mobile).
 */
// Redirect /brands-v3/:brandId → /brands/:brandId after v2 decommission.
// Bookmark / external-link safety net; can be deleted once we're sure
// no live URLs reference the v3 path.
function RedirectToBrand() {
  const { brandId } = useParams<{ brandId: string }>();
  return <Navigate to={`/brands/${brandId ?? ''}`} replace />;
}

function RoleAwareHome() {
  const { isBrandAdmin } = useAuth();
  if (isBrandAdmin) {
    return <BrandAdminDashboard />;
  }
  return <Home />;
}

export default function App() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={
        isAuthenticated ? <Navigate to="/" replace /> : <Login />
      } />
      <Route path="/" element={
        <ProtectedRoute>
          <Shell />
        </ProtectedRoute>
      }>
        <Route index element={lazyRoute(<RoleAwareHome />)} />
        <Route path="observatory" element={lazyRoute(<Observatory />, <ObservatoryLoader />)} />
        <Route path="observatory-v3" element={lazyRoute(<ObservatoryV3 />, <ObservatoryLoader />)} />
        <Route path="brands" element={lazyRoute(<Brands />)} />
        <Route path="brands/:brandId" element={lazyRoute(<BrandDetail />)} />
        {/* Old /brands-v3 paths redirect to canonical /brands now that
            v2 brands is decommissioned (v3 IS the brands surface). */}
        <Route path="brands-v3" element={<Navigate to="/brands" replace />} />
        <Route path="brands-v3/:brandId" element={<RedirectToBrand />} />
        <Route path="apps" element={lazyRoute(<Apps />)} />
        <Route path="dark-web" element={lazyRoute(<DarkWeb />)} />
        <Route path="threats" element={lazyRoute(<Threats />)} />
        <Route path="providers" element={lazyRoute(<Providers />)} />
        {/* `providers/:providerId` retired — provider detail is inline-only via card expansion. */}
        <Route path="providers/:providerId" element={<Navigate to="/providers" replace />} />
        <Route path="campaigns" element={lazyRoute(<Campaigns />)} />
        <Route path="campaigns/geo/:slug" element={lazyRoute(<GeopoliticalCampaignDashboard />)} />
        <Route path="campaigns/:campaignId" element={lazyRoute(<CampaignDetail />)} />
        <Route path="threat-actors" element={lazyRoute(<ThreatActors />)} />
        {/* `threat-actors/:actorId` retired — detail is inline-only via card expansion. */}
        <Route path="threat-actors/:actorId" element={<Navigate to="/threat-actors" replace />} />
        <Route path="trends" element={lazyRoute(<Trends />)} />
        {/* Alias — sidebar entry says "Intelligence"; keep /intelligence
            navigable for bookmarks. Audit H8. */}
        <Route path="intelligence" element={lazyRoute(<Trends />)} />
        <Route path="agents" element={lazyRoute(<Agents />)} />
        <Route path="agents/approvals" element={lazyRoute(<AgentApprovals />)} />
        <Route path="agents/:id/review" element={lazyRoute(<AgentReview />)} />
        <Route path="agents/architect" element={lazyRoute(<ArchitectDetail />)} />
        <Route path="alerts" element={lazyRoute(<Alerts />)} />
        <Route path="leads" element={lazyRoute(<Leads />)} />
        <Route path="feeds" element={lazyRoute(<Feeds />)} />
        <Route path="admin" element={lazyRoute(<AdminDashboard />)} />
        <Route path="admin/metrics" element={lazyRoute(<Metrics />)} />
        <Route path="admin/scan-leads" element={<Navigate to="/leads?view=scan" replace />} />
        <Route path="admin/takedowns" element={lazyRoute(<Takedowns />)} />
        <Route path="admin/spam-trap" element={lazyRoute(<SpamTrap />)} />
        <Route path="admin/abuse-mailbox" element={lazyRoute(<AdminAbuseMailbox />)} />
        <Route path="admin/users" element={lazyRoute(<Organization />)} />
        {/* Customers page (renamed from Organizations in v3 D Stripe sprint 1).
            Keep /admin/organizations as an alias so saved bookmarks resolve. */}
        <Route path="admin/customers" element={lazyRoute(<SuperAdminOrgs />)} />
        <Route path="admin/organizations" element={lazyRoute(<SuperAdminOrgs />)} />
        <Route path="admin/pricing" element={lazyRoute(<PricingConfig />)} />
        <Route path="admin/audit" element={lazyRoute(<AdminAudit />)} />
        <Route path="admin/incidents" element={lazyRoute(<AdminIncidents />)} />
        <Route path="admin/incidents/:id" element={lazyRoute(<AdminIncidentDetail />)} />
        <Route path="admin/push" element={lazyRoute(<PushAdmin />)} />
        <Route path="admin/notifications" element={lazyRoute(<NotificationCenter />)} />
        <Route path="profile" element={lazyRoute(<Profile />)} />
        <Route path="notifications" element={lazyRoute(<Notifications />)} />
        <Route path="notifications/preferences" element={lazyRoute(<NotificationPreferences />)} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
