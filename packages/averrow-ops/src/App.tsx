import React, { Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ShellV4 } from '@/components/layout/ShellV4';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { RedirectToTab } from '@/components/routing/RedirectToTab';
import { Login } from '@/pages/Login';
import { NotFound } from '@/pages/NotFound';
import { preloadConsoleTab } from '@/features/console/tabLoaders';
import { preloadExploreTab } from '@/features/explore/tabLoaders';
import { tabUrl, LEGACY_TAB_PATHS } from '@/lib/workspaceRoutes';

// All feature routes are lazy-loaded so a cold visit to any single page
// doesn't pull every other feature's bundle (recharts,
// route-specific components). Observatory's deck.gl/maplibre stay isolated
// to that route. Login and NotFound stay eager because they're tiny and
// needed immediately at startup.
// Scan Leads now lives as a tab inside /leads. Old /admin/scan-leads
// links (sidebar history, sales notification emails, bookmarks) keep
// working through a redirect — see the route definition below.
// List pages that live as workspace tabs (Console / Explorer / Coverage /
// Operations / Governance) are NOT imported here: their old standalone paths
// are <RedirectToTab/> routes (lib/workspaceRoutes.ts is the mapping).
const loadBrandDetail = () => import('@/features/brands/BrandDetail').then(m => ({ default: m.BrandDetailV3 }));
const BrandDetail = React.lazy(loadBrandDetail);
const AgentApprovals = React.lazy(() => import('@/features/agents/AgentApprovals').then(m => ({ default: m.AgentApprovals })));
const AgentReview = React.lazy(() => import('@/features/agents/AgentReview').then(m => ({ default: m.AgentReview })));
const SpamTrap = React.lazy(() => import('@/features/spam-trap/SpamTrap').then(m => ({ default: m.SpamTrap })));
const AdminDashboard = React.lazy(() => import('@/features/admin/AdminDashboard').then(m => ({ default: m.AdminDashboard })));
const AdminAbuseMailbox = React.lazy(() => import('@/features/admin/AdminAbuseMailbox').then(m => ({ default: m.AdminAbuseMailbox })));
const UsersAccess = React.lazy(() => import('@/features/admin/UsersAccess').then(m => ({ default: m.UsersAccess })));
const SuperAdminOrgs = React.lazy(() => import('@/features/admin/SuperAdminOrgs').then(m => ({ default: m.SuperAdminOrgs })));
const Metrics = React.lazy(() => import('@/features/admin/Metrics').then(m => ({ default: m.Metrics })));
const AdminIncidentDetail = React.lazy(() => import('@/features/admin-incidents/IncidentDetail').then(m => ({ default: m.AdminIncidentDetail })));
const PushAdmin = React.lazy(() => import('@/features/admin/PushAdmin').then(m => ({ default: m.PushAdmin })));
const ArchitectDetail = React.lazy(() => import('@/features/agents/ArchitectDetail').then(m => ({ default: m.ArchitectDetail })));
const CampaignDetail = React.lazy(() => import('@/features/campaigns/CampaignDetail').then(m => ({ default: m.CampaignDetail })));
const GeopoliticalCampaignDashboard = React.lazy(() => import('@/features/campaigns/GeopoliticalCampaignDashboard').then(m => ({ default: m.GeopoliticalCampaignDashboard })));
const Leads = React.lazy(() => import('@/features/leads/Leads').then(m => ({ default: m.Leads })));
const loadConsole = () => import('@/features/console/Console').then(m => ({ default: m.Console }));
const Console = React.lazy(loadConsole);
const loadExploreWorkspace = () => import('@/features/explore/ExploreWorkspace').then(m => ({ default: m.ExploreWorkspace }));
const ExploreWorkspace = React.lazy(loadExploreWorkspace);
const loadCoverageWorkspace = () => import('@/features/coverage/CoverageWorkspace').then(m => ({ default: m.CoverageWorkspace }));
const CoverageWorkspace = React.lazy(loadCoverageWorkspace);
const loadOperationsWorkspace = () => import('@/features/operations/OperationsWorkspace').then(m => ({ default: m.OperationsWorkspace }));
const OperationsWorkspace = React.lazy(loadOperationsWorkspace);
const loadGovernanceWorkspace = () => import('@/features/governance/GovernanceWorkspace').then(m => ({ default: m.GovernanceWorkspace }));
const GovernanceWorkspace = React.lazy(loadGovernanceWorkspace);
const loadOverviewV4 = () => import('@/features/home/OverviewV4').then(m => ({ default: m.OverviewV4 }));
const OverviewV4 = React.lazy(loadOverviewV4);
const SettingsLayout = React.lazy(() => import('@/features/settings/SettingsLayout').then(m => ({ default: m.SettingsLayout })));
const SettingsIndex = React.lazy(() => import('@/features/settings/SettingsLayout').then(m => ({ default: m.SettingsIndex })));
const ProfileSettingsPage = React.lazy(() => import('@/features/settings/ProfileSettingsPage').then(m => ({ default: m.ProfileSettingsPage })));
const AppearanceSettingsPage = React.lazy(() => import('@/features/settings/AppearanceSettingsPage').then(m => ({ default: m.AppearanceSettingsPage })));
const DevicesSettingsPage = React.lazy(() => import('@/features/settings/DevicesSettingsPage').then(m => ({ default: m.DevicesSettingsPage })));
const Notifications = React.lazy(() => import('@/features/settings/Notifications').then(m => ({ default: m.Notifications })));
const SecurityPage = React.lazy(() => import('@/features/settings/SecurityPage').then(m => ({ default: m.SecurityPage })));
const NotificationSettingsPage = React.lazy(() => import('@/features/settings/NotificationSettingsPage').then(m => ({ default: m.NotificationSettingsPage })));
const loadObservatoryV3 = () => import('@/features/observatory-v3/ObservatoryV3').then(m => ({ default: m.ObservatoryV3 }));
const ObservatoryV3 = React.lazy(loadObservatoryV3);
const IdentityThreatsPage = React.lazy(() => import('@/features/identity-threats/IdentityThreatsPage').then(m => ({ default: m.IdentityThreatsPage })));
const KitGallery = React.lazy(() => import('@/features/kit/KitGallery').then(m => ({ default: m.KitGallery })));
const SearchResults = React.lazy(() => import('@/features/search/SearchResults').then(m => ({ default: m.SearchResults })));

// Start the current route's chunk(s) at module-eval time, in parallel with the
// auth round-trips (refresh -> me), instead of after auth settles. Each factory
// is shared with its React.lazy, so the module is fetched once. Tab panes of
// Console / Explorer come from their light tabLoaders registries.
export function preloadRouteForPath(pathname: string, search: string): void {
  const path = pathname.replace(/^\/v2(?=\/|$)/, '').replace(/\/+$/, '') || '/';
  const tab = new URLSearchParams(search).get('tab');
  const go = (f: () => Promise<unknown>) => { void f().catch(() => undefined); };
  if (path === '/') go(loadOverviewV4);
  else if (path === '/observatory') go(loadObservatoryV3);
  else if (path === '/console') { go(loadConsole); preloadConsoleTab(tab); }
  else if (path === '/explore') { go(loadExploreWorkspace); preloadExploreTab(tab); }
  else if (path === '/coverage') go(loadCoverageWorkspace);
  else if (path === '/admin/operations') go(loadOperationsWorkspace);
  else if (path === '/admin/governance') go(loadGovernanceWorkspace);
  else if (/^\/brands\/[^/]+$/.test(path)) go(loadBrandDetail);
}

if (typeof window !== 'undefined') {
  preloadRouteForPath(window.location.pathname, window.location.search);
}

function RouteLoader() {
  return (
    <div className="flex items-center justify-center h-full min-h-[40vh]" style={{ background: 'var(--bg-page)' }}>
      <div className="font-mono text-sm" style={{ color: 'var(--text-secondary)' }}>Loading…</div>
    </div>
  );
}

function ObservatoryLoader() {
  return (
    <div className="flex items-center justify-center flex-1 min-h-0" style={{ background: 'var(--bg-page)' }}>
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
  return <Navigate to={tabUrl('providers', providerId ? { focus: providerId } : undefined)} replace />;
}
function RedirectToActorFocus() {
  const { actorId } = useParams<{ actorId: string }>();
  return <Navigate to={tabUrl('actors', actorId ? { focus: actorId } : undefined)} replace />;
}

// abuse_mailbox_verdict notifications for brand-bound captures carry the
// tenant-app link `/modules/abuse-mailbox#msg-<id>`; opted-in super_admins
// see them here too. Forward to the ops page, keeping the #msg- anchor.
export function RedirectToAdminAbuseMailbox() {
  const { hash } = useLocation();
  return <Navigate to={{ pathname: '/admin/abuse-mailbox', hash }} replace />;
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
          <ShellV4 />
        </ProtectedRoute>
      }>
        <Route index element={lazyRoute(<OverviewV4 />)} />
        {/* v4 SOC Console workspace (hosts Alerts/Threats/Incidents/Takedowns
            as ?tab= panes). The v4 sidebar links it. */}
        <Route path="console" element={lazyRoute(<Console />)} />
        {/* v4 consolidated Intelligence workspaces — Explorer (Brands /
            Threat Actors / Campaigns / Providers) and Coverage (Apps /
            Dark Web / Trademarks / Trends) as ?tab= panes. The old standalone
            list paths redirect to them (see the <RedirectToTab/> routes
            below); detail routes stay standalone. */}
        <Route path="explore" element={lazyRoute(<ExploreWorkspace />)} />
        <Route path="coverage" element={lazyRoute(<CoverageWorkspace />)} />
        <Route path="identity-threats" element={lazyRoute(<IdentityThreatsPage />)} />
        {/* Persistent, shareable cross-entity search results (?q=) — the
            ⌘K command palette's "Search everything for…" escalation row
            lands here. See features/search/searchRouting.ts for the
            shared per-type routing table. */}
        <Route path="search" element={lazyRoute(<SearchResults />)} />
        {/* Staff design-kit gallery (P3-4). URL-only: no nav row, no palette entry. */}
        <Route path="kit" element={lazyRoute(<KitGallery />)} />
        <Route path="admin/operations" element={lazyRoute(<OperationsWorkspace />)} />
        <Route path="admin/governance" element={lazyRoute(<GovernanceWorkspace />)} />
        <Route path="observatory" element={lazyRoute(<ObservatoryV3 />, <ObservatoryLoader />)} />
        {/* v2 retired (#35 Phase D) — v3 is now the sole Observatory at the
            canonical path. Redirect for bookmarks/links still pointing at
            the old v3 preview path. */}
        <Route path="observatory-v3" element={<Navigate to="/observatory" replace />} />
        <Route path="brands/:brandId" element={lazyRoute(<BrandDetail />)} />
        {/* Old /brands-v3 paths redirect to canonical /brands now that
            v2 brands is decommissioned (v3 IS the brands surface). */}
        <Route path="brands-v3/:brandId" element={<RedirectToBrand />} />
        {/* `providers/:providerId` is inline-only — forward to ?focus so the
            card auto-expands instead of dropping the pivot to a bare list. */}
        <Route path="providers/:providerId" element={<RedirectToProviderFocus />} />
        <Route path="campaigns/geo/:slug" element={lazyRoute(<GeopoliticalCampaignDashboard />)} />
        <Route path="campaigns/:campaignId" element={lazyRoute(<CampaignDetail />)} />
        {/* `threat-actors/:actorId` is inline-only — forward to ?focus so the
            card auto-expands instead of dropping the pivot to a bare list. */}
        <Route path="threat-actors/:actorId" element={<RedirectToActorFocus />} />
        <Route path="agents/approvals" element={lazyRoute(<AgentApprovals />)} />
        <Route path="agents/:id/review" element={lazyRoute(<AgentReview />)} />
        <Route path="agents/architect" element={lazyRoute(<ArchitectDetail />)} />
        <Route path="leads" element={lazyRoute(<Leads />)} />
        <Route path="admin" element={lazyRoute(<AdminDashboard />)} />
        {/* Tier 3: /admin/metrics was merged into /admin as additional tabs.
            Metrics.tsx is now a redirect shim mapping legacy ?tab= ids onto
            the new /admin?tab= ids so old bookmarks/links keep resolving. */}
        <Route path="admin/metrics" element={lazyRoute(<Metrics />)} />
        <Route path="admin/scan-leads" element={<Navigate to="/leads?view=scan" replace />} />
        <Route path="admin/spam-trap" element={lazyRoute(<SpamTrap />)} />
        <Route path="admin/abuse-mailbox" element={lazyRoute(<AdminAbuseMailbox />)} />
        <Route path="modules/abuse-mailbox" element={<RedirectToAdminAbuseMailbox />} />
        <Route path="admin/users" element={lazyRoute(<UsersAccess />)} />
        {/* Customers page (renamed from Organizations in v3 D Stripe sprint 1).
            Keep /admin/organizations as an alias so saved bookmarks resolve. */}
        <Route path="admin/customers" element={lazyRoute(<SuperAdminOrgs />)} />
        <Route path="admin/organizations" element={<Navigate to="/admin/customers" replace />} />
        <Route path="admin/incidents/:id" element={lazyRoute(<AdminIncidentDetail />)} />
        <Route path="admin/push" element={lazyRoute(<PushAdmin />)} />
        {/* Account area (docs/ACCOUNT_DESIGN_SPEC.md §2). /settings is the mobile
            section list; on desktop it redirects to /settings/profile. */}
        <Route path="settings" element={lazyRoute(<SettingsLayout />)}>
          <Route index element={lazyRoute(<SettingsIndex />)} />
          <Route path="profile" element={lazyRoute(<ProfileSettingsPage />)} />
          {/* Redirects to /settings/profile when APPEARANCE_PICKER_ENABLED is off (FACELIFT reverted). */}
          <Route path="appearance" element={lazyRoute(<AppearanceSettingsPage />)} />
          <Route path="devices" element={lazyRoute(<DevicesSettingsPage />)} />
          <Route path="security" element={lazyRoute(<SecurityPage />)} />
          <Route path="notifications" element={<Navigate to="/settings/notifications/channels" replace />} />
          <Route path="notifications/:tab" element={lazyRoute(<NotificationSettingsPage />)} />
          {/* Unknown settings paths land on the default section. */}
          <Route path="*" element={<Navigate to="/settings/profile" replace />} />
        </Route>
        {/* Legacy account paths */}
        <Route path="profile" element={<Navigate to="/settings/profile" replace />} />
        <Route path="notifications" element={lazyRoute(<Notifications />)} />
        <Route path="notifications/preferences" element={<Navigate to="/settings/notifications/channels" replace />} />
        {/* Retired standalone list paths → workspace tabs. Generated from
            LEGACY_TAB_PATHS (lib/workspaceRoutes.ts), the single source. */}
        {Object.entries(LEGACY_TAB_PATHS).map(([path, tabKey]) => (
          <Route key={path} path={path.slice(1)} element={<RedirectToTab tabKey={tabKey} />} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
