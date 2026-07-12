import React, { Suspense } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ShellSwitch } from '@/components/layout/ShellV4';
import { useShellVersion } from '@/design-system/hooks/useShellVersion';
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
const Trademarks = React.lazy(() => import('@/features/trademarks/Trademarks').then(m => ({ default: m.Trademarks })));
const Agents = React.lazy(() => import('@/features/agents/Agents').then(m => ({ default: m.Agents })));
const AgentApprovals = React.lazy(() => import('@/features/agents/AgentApprovals').then(m => ({ default: m.AgentApprovals })));
const AgentReview = React.lazy(() => import('@/features/agents/AgentReview').then(m => ({ default: m.AgentReview })));
const Takedowns = React.lazy(() => import('@/features/takedowns/Takedowns').then(m => ({ default: m.Takedowns })));
const Integrations = React.lazy(() => import('@/features/integrations/Integrations').then(m => ({ default: m.Integrations })));
const SpamTrap = React.lazy(() => import('@/features/spam-trap/SpamTrap').then(m => ({ default: m.SpamTrap })));
const Alerts = React.lazy(() => import('@/features/alerts/Alerts').then(m => ({ default: m.Alerts })));
const Feeds = React.lazy(() => import('@/features/feeds/Feeds').then(m => ({ default: m.Feeds })));
const AdminDashboard = React.lazy(() => import('@/features/admin/AdminDashboard').then(m => ({ default: m.AdminDashboard })));
const AdminAbuseMailbox = React.lazy(() => import('@/features/admin/AdminAbuseMailbox').then(m => ({ default: m.AdminAbuseMailbox })));
const Organization = React.lazy(() => import('@/features/settings/Organization').then(m => ({ default: m.Organization })));
const SuperAdminOrgs = React.lazy(() => import('@/features/admin/SuperAdminOrgs').then(m => ({ default: m.SuperAdminOrgs })));
const PricingConfig = React.lazy(() => import('@/features/admin/PricingConfig').then(m => ({ default: m.PricingConfig })));
const AdminAudit = React.lazy(() => import('@/features/admin/AdminAudit').then(m => ({ default: m.AdminAudit })));
const AttributionBacklog = React.lazy(() => import('@/features/admin/AttributionBacklog').then(m => ({ default: m.AttributionBacklog })));
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
const Console = React.lazy(() => import('@/features/console/Console').then(m => ({ default: m.Console })));
const ExploreWorkspace = React.lazy(() => import('@/features/explore/ExploreWorkspace').then(m => ({ default: m.ExploreWorkspace })));
const CoverageWorkspace = React.lazy(() => import('@/features/coverage/CoverageWorkspace').then(m => ({ default: m.CoverageWorkspace })));
const OperationsWorkspace = React.lazy(() => import('@/features/operations/OperationsWorkspace').then(m => ({ default: m.OperationsWorkspace })));
const GovernanceWorkspace = React.lazy(() => import('@/features/governance/GovernanceWorkspace').then(m => ({ default: m.GovernanceWorkspace })));
const PlatformUsers = React.lazy(() => import('@/features/admin/PlatformUsers').then(m => ({ default: m.PlatformUsers })));
const Home = React.lazy(() => import('@/pages/Home').then(m => ({ default: m.Home })));
const OverviewV4 = React.lazy(() => import('@/features/home/OverviewV4').then(m => ({ default: m.OverviewV4 })));
const BrandAdminDashboard = React.lazy(() => import('@/features/admin/BrandAdminDashboard').then(m => ({ default: m.BrandAdminDashboard })));
const Threats = React.lazy(() => import('@/features/threats/Threats').then(m => ({ default: m.Threats })));
const Profile = React.lazy(() => import('@/features/settings/Profile').then(m => ({ default: m.Profile })));
const Notifications = React.lazy(() => import('@/features/settings/Notifications').then(m => ({ default: m.Notifications })));
const NotificationPreferences = React.lazy(() => import('@/features/settings/NotificationPreferences').then(m => ({ default: m.NotificationPreferences })));
const Observatory = React.lazy(() => import('@/features/observatory/Observatory').then(m => ({ default: m.Observatory })));
const ObservatoryV3 = React.lazy(() => import('@/features/observatory-v3/ObservatoryV3').then(m => ({ default: m.ObservatoryV3 })));
const SearchResults = React.lazy(() => import('@/features/search/SearchResults').then(m => ({ default: m.SearchResults })));

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

// Provider / Threat-Actor detail is inline-only (card expansion), but the
// entity still needs to be a deep-link target so pivots (Campaign→Provider,
// Brand→Actor, notifications) land on the right card instead of a bare list.
// Forward the id as ?focus= so the list auto-expands + scrolls to it.
function RedirectToProviderFocus() {
  const { providerId } = useParams<{ providerId: string }>();
  return <Navigate to={providerId ? `/providers?focus=${providerId}` : '/providers'} replace />;
}
function RedirectToActorFocus() {
  const { actorId } = useParams<{ actorId: string }>();
  return <Navigate to={actorId ? `/threat-actors?focus=${actorId}` : '/threat-actors'} replace />;
}

function RoleAwareHome() {
  const { isBrandAdmin } = useAuth();
  const { isV4 } = useShellVersion();
  if (isBrandAdmin) {
    return <BrandAdminDashboard />;
  }
  // In the v4 shell, "/" is the cinematic command-center Overview; classic
  // keeps the existing Home.
  return isV4 ? <OverviewV4 /> : <Home />;
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
          <ShellSwitch />
        </ProtectedRoute>
      }>
        <Route index element={lazyRoute(<RoleAwareHome />)} />
        {/* v4 SOC Console workspace (hosts Signals/Threats/Incidents/Takedowns
            as ?tab= panes). Reachable in both shells; the v4 sidebar links it. */}
        <Route path="console" element={lazyRoute(<Console />)} />
        {/* v4 consolidated Intelligence workspaces — Explorer (Brands /
            Threat Actors / Campaigns / Providers) and Coverage (Apps /
            Dark Web / Trademarks / Trends) as ?tab= panes. The standalone
            routes below stay live for deep links / pivots. */}
        <Route path="explore" element={lazyRoute(<ExploreWorkspace />)} />
        <Route path="coverage" element={lazyRoute(<CoverageWorkspace />)} />
        {/* Persistent, shareable cross-entity search results (?q=) — the
            ⌘K command palette's "Search everything for…" escalation row
            lands here. See features/search/searchRouting.ts for the
            shared per-type routing table. */}
        <Route path="search" element={lazyRoute(<SearchResults />)} />
        <Route path="admin/operations" element={lazyRoute(<OperationsWorkspace />)} />
        <Route path="admin/governance" element={lazyRoute(<GovernanceWorkspace />)} />
        <Route path="admin/platform-users" element={lazyRoute(<PlatformUsers />)} />
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
        <Route path="trademarks" element={lazyRoute(<Trademarks />)} />
        <Route path="threats" element={lazyRoute(<Threats />)} />
        <Route path="providers" element={lazyRoute(<Providers />)} />
        {/* `providers/:providerId` is inline-only — forward to ?focus so the
            card auto-expands instead of dropping the pivot to a bare list. */}
        <Route path="providers/:providerId" element={<RedirectToProviderFocus />} />
        <Route path="campaigns" element={lazyRoute(<Campaigns />)} />
        <Route path="campaigns/geo/:slug" element={lazyRoute(<GeopoliticalCampaignDashboard />)} />
        <Route path="campaigns/:campaignId" element={lazyRoute(<CampaignDetail />)} />
        <Route path="threat-actors" element={lazyRoute(<ThreatActors />)} />
        {/* `threat-actors/:actorId` is inline-only — forward to ?focus so the
            card auto-expands instead of dropping the pivot to a bare list. */}
        <Route path="threat-actors/:actorId" element={<RedirectToActorFocus />} />
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
        {/* Tier 3: /admin/metrics was merged into /admin as additional tabs.
            Metrics.tsx is now a redirect shim mapping legacy ?tab= ids onto
            the new /admin?tab= ids so old bookmarks/links keep resolving. */}
        <Route path="admin/metrics" element={lazyRoute(<Metrics />)} />
        <Route path="admin/scan-leads" element={<Navigate to="/leads?view=scan" replace />} />
        <Route path="admin/takedowns" element={lazyRoute(<Takedowns />)} />
        <Route path="admin/integrations" element={lazyRoute(<Integrations />)} />
        <Route path="admin/spam-trap" element={lazyRoute(<SpamTrap />)} />
        <Route path="admin/abuse-mailbox" element={lazyRoute(<AdminAbuseMailbox />)} />
        <Route path="admin/users" element={lazyRoute(<Organization />)} />
        {/* Customers page (renamed from Organizations in v3 D Stripe sprint 1).
            Keep /admin/organizations as an alias so saved bookmarks resolve. */}
        <Route path="admin/customers" element={lazyRoute(<SuperAdminOrgs />)} />
        <Route path="admin/organizations" element={lazyRoute(<SuperAdminOrgs />)} />
        <Route path="admin/pricing" element={lazyRoute(<PricingConfig />)} />
        <Route path="admin/audit" element={lazyRoute(<AdminAudit />)} />
        <Route path="admin/agents/attribution-backlog" element={lazyRoute(<AttributionBacklog />)} />
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
