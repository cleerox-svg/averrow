// v4 "Cinematic command center" shell (redesign coexistence — W0).
//
// Renders the SAME route <Outlet/> as the current Shell, inside the new
// cinematic chrome (3-workspace IA sidebar + topbar). Flipped on/off by
// useShellVersion via <ShellSwitch/> — the current shell is untouched.
// Page internals get re-skinned into the new design system in later waves;
// W0 establishes the chrome + the coexistence gate end-to-end.
//
// Responsive: desktop = fixed rail; <=900px = off-canvas drawer + hamburger,
// single-column. Mostly CSS-driven (shell-v4.css); JS only tracks the drawer.

import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import {
  LayoutDashboard, SquareTerminal, Mail, Inbox,
  Globe, Users, Cpu, Rss, BarChart3, ClipboardList, Bell, Target,
  Search, Sparkles, RotateCcw, Menu, X,
  Plug, Building2, DollarSign, ListChecks, Compass, Layers,
  LogOut, UserCircle,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { parseInitials } from '@/lib/avatar';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { Shell } from './Shell';
import { useShellVersion } from '@/design-system/hooks/useShellVersion';
import './shell-v4.css';

interface NavItem { label: string; to: string; icon: LucideIcon; end?: boolean; }
interface NavGroup { label: string; items: NavItem[]; }

// Nav is built per-render so it can role-gate sensitive PLATFORM items
// (Customers → super_admin, Pricing → view_billing), matching the classic
// Sidebar. Anything not gated is visible to every staff role.
function buildV4Nav(opts: { isSuperAdmin: boolean; role: string | null | undefined }): NavGroup[] {
  const { isSuperAdmin, role } = opts;

  // PLATFORM — restores the four admin routes that were dropped from the
  // v4 nav (Integrations, Customers, Pricing, Attribution Backlog), with
  // the same gating the classic Sidebar applies.
  const platformItems: NavItem[] = [
    { label: 'Dashboard',     to: '/admin',          icon: LayoutDashboard, end: true },
    { label: 'Agents',        to: '/agents',         icon: Cpu },
    { label: 'Feeds',         to: '/feeds',          icon: Rss },
    { label: 'Metrics',       to: '/admin/metrics',  icon: BarChart3 },
    { label: 'Integrations',  to: '/admin/integrations', icon: Plug },
    { label: 'Team',          to: '/admin/users',    icon: Users },
    ...(isSuperAdmin
      ? [{ label: 'Customers', to: '/admin/customers', icon: Building2 } as NavItem]
      : []),
    ...(roleHasPermission(role, 'view_billing')
      ? [{ label: 'Pricing', to: '/admin/pricing', icon: DollarSign } as NavItem]
      : []),
    { label: 'Audit Log',     to: '/admin/audit',    icon: ClipboardList },
    { label: 'Attribution Backlog', to: '/admin/agents/attribution-backlog', icon: ListChecks },
    { label: 'Notifications', to: '/admin/notifications', icon: Bell },
    { label: 'Sales Leads',   to: '/leads',          icon: Target },
  ];

  return [
    {
      label: 'SOC CONSOLE',
      items: [
        // Console consolidates Signals / Threats / Incidents / Takedowns as
        // tabs — so those don't appear as separate menu items in v4 (their
        // routes stay live for deep links). Abuse Mailbox + Spam Trap are NOT
        // Console tabs, so they remain standalone here.
        { label: 'Console',       to: '/console',              icon: SquareTerminal },
        { label: 'Overview',      to: '/',                     icon: LayoutDashboard, end: true },
        { label: 'Abuse Mailbox', to: '/admin/abuse-mailbox',  icon: Mail },
        { label: 'Spam Trap',     to: '/admin/spam-trap',      icon: Inbox },
      ],
    },
    {
      label: 'INTELLIGENCE',
      items: [
        // Observatory stays standalone (the WebGL map). The nine entity +
        // detection-surface pages are consolidated into two tabbed
        // workspaces: Explorer (Brands / Threat Actors / Campaigns /
        // Providers) and Coverage (Apps / Dark Web / Trademarks / Trends).
        // Their standalone routes remain live for deep links / pivots.
        { label: 'Observatory', to: '/observatory-v3', icon: Globe },
        { label: 'Explorer',    to: '/explore',        icon: Compass },
        { label: 'Coverage',    to: '/coverage',       icon: Layers },
      ],
    },
    {
      label: 'PLATFORM',
      items: platformItems,
    },
  ];
}

function navClass({ isActive }: { isActive: boolean }) {
  return 'v4-item' + (isActive ? ' active' : '');
}

export function ShellV4() {
  const { user, isSuperAdmin, logout } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const initials = parseInitials(user?.display_name ?? user?.name ?? null, user?.email ?? null);
  const closeDrawer = () => setDrawerOpen(false);
  const nav = buildV4Nav({ isSuperAdmin, role: user?.role });

  return (
    <div className={'shell-v4' + (drawerOpen ? ' drawer-open' : '')}>
      <aside className="v4-side">
        <div className="v4-brand">
          <svg width="34" height="34" viewBox="0 0 32 32" fill="none" style={{ flex: '0 0 auto', boxShadow: '0 0 22px rgba(200,60,60,.45)', borderRadius: 9 }}>
            <defs>
              <linearGradient id="v4mark" x1="16" y1="5" x2="16" y2="26" gradientUnits="userSpaceOnUse">
                <stop stopColor="#6B1010" /><stop offset="1" stopColor="#C83C3C" />
              </linearGradient>
            </defs>
            <rect width="32" height="32" rx="6" fill="#0C1220" />
            <rect x=".5" y=".5" width="31" height="31" rx="5.5" fill="none" stroke="rgba(200,60,60,.25)" />
            <path d="M16 5L26 26H18L16 21L14 26H6Z" fill="url(#v4mark)" />
            <path d="M14.5 22H17.5L16 18Z" fill="#0C1220" />
          </svg>
          <div>
            <div className="name">AVERROW</div>
            <div className="sub">THREAT INTERCEPTOR</div>
          </div>
          <button type="button" className="v4-drawer-close" onClick={closeDrawer} aria-label="Close menu">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <nav className="v4-nav">
          {nav.map(group => (
            <div key={group.label}>
              <div className="v4-grp">{group.label}</div>
              {group.items.map(item => {
                const Icon = item.icon;
                return (
                  <NavLink key={item.to + item.label} to={item.to} end={item.end} className={navClass} onClick={closeDrawer}>
                    <Icon strokeWidth={2} /> {item.label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="v4-foot">
          <NavLink to="/profile" className="v4-foot-id" onClick={closeDrawer} title="Your profile">
            <div className="v4-avatar">{initials}</div>
            <div className="v4-foot-meta">
              <div className="v4-foot-name">
                {user?.display_name ?? user?.name ?? user?.email ?? 'Signed in'}
              </div>
              <div className="v4-foot-role">{user?.role}</div>
            </div>
          </NavLink>
          <NavLink to="/profile" className="v4-foot-btn" onClick={closeDrawer} aria-label="Profile" title="Profile">
            <UserCircle size={17} strokeWidth={2} />
          </NavLink>
          <button type="button" className="v4-foot-btn" onClick={() => logout()} aria-label="Sign out" title="Sign out">
            <LogOut size={17} strokeWidth={2} />
          </button>
        </div>
        <div className="v4-verline" title={`${VERSION_LABEL} · ${BUILD_SHA}`}>
          {VERSION_LABEL}<span style={{ opacity: 0.5 }}> · {BUILD_SHA}</span>
        </div>
      </aside>

      {/* mobile drawer backdrop (CSS shows it only when .drawer-open on small screens) */}
      <div className="v4-backdrop" onClick={closeDrawer} aria-hidden />

      <section className="v4-main">
        <header className="v4-top">
          <button type="button" className="v4-hamburger" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
            <Menu size={18} strokeWidth={2} />
          </button>
          <div className="v4-cmdk" title="Command palette arrives with the v4 component library">
            <Search size={14} strokeWidth={2} />
            <span className="v4-cmdk-label">Search threats, brands, actors…</span>
            <kbd>⌘K</kbd>
          </div>
          <div className="v4-live"><span className="dot" />LIVE</div>
        </header>
        <div className="v4-outlet">
          <Outlet />
        </div>
      </section>
    </div>
  );
}

function ShellVersionPill({ isV4, onToggle }: { isV4: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="v4-toggle" onClick={onToggle}
      title={isV4 ? 'Switch back to the classic shell' : 'Preview the v4 cinematic shell'}>
      {isV4 ? <RotateCcw strokeWidth={2.2} /> : <Sparkles strokeWidth={2.2} />}
      {isV4 ? 'Classic view' : 'Try v4'}
    </button>
  );
}

/**
 * Picks the shell based on the persisted shell-version preference and
 * renders the floating toggle pill in both modes. Both shells render the
 * same route <Outlet/>, so switching never changes the current route.
 */
export function ShellSwitch() {
  const { isV4, setVersion } = useShellVersion();
  return (
    <>
      {isV4 ? <ShellV4 /> : <Shell />}
      <ShellVersionPill isV4={isV4} onToggle={() => setVersion(isV4 ? 'current' : 'v4')} />
    </>
  );
}
