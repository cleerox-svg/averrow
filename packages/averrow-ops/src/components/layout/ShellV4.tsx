// v4 "Cinematic command center" shell — the only ops shell.
//
// Renders the route <Outlet/> inside the cinematic chrome (3-workspace IA
// sidebar + topbar). Mounted directly by App.tsx for every staff user.
//
// Responsive: desktop = fixed rail; <=900px = off-canvas drawer + hamburger,
// single-column. Mostly CSS-driven (shell-v4.css); JS only tracks the drawer.

import { useEffect, useRef, useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, SquareTerminal, Mail, Inbox,
  Globe, Users, Cpu, Rss, ClipboardList, Bell, Target,
  Search, Menu, X,
  Plug, Building2, DollarSign, ListChecks, Compass, Layers,
  ShieldAlert, Bug, Network, Megaphone, Server,
  Smartphone, EyeOff, Scale, TrendingUp, UserCog, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { NotificationBell } from '@/components/NotificationBell';
import { UserAvatar } from '@/components/UserAvatar';
import { PlatformAlertBanner } from '@/components/PlatformAlertBanner';
import { useOpenAlertCount } from '@/hooks/useOpenAlertCount';
import { ThemeCycleButton } from './ThemeCycleButton';
import { PasskeyEnrollmentGate } from '@/components/PasskeyEnrollmentGate';
import { FirstSignInPasskeyPrompt } from '@/components/FirstSignInPasskeyPrompt';
import './shell-v4.css';

interface NavItem { label: string; to: string; icon: LucideIcon; end?: boolean; count?: number; }
interface NavGroup { label: string; items: NavItem[]; }

// Nav is built per-render so it can role-gate sensitive PLATFORM items
// (Customers → super_admin, Pricing → view_billing). Anything not gated is
// visible to every staff role.
function buildV4Nav(opts: { isSuperAdmin: boolean; role: string | null | undefined; openAlerts?: number }): NavGroup[] {
  const { isSuperAdmin, openAlerts } = opts;

  // PLATFORM — consolidated rows (admin-console redesign). The four flat
  // ops pages (Agents / Feeds / Takedown Integrations / Attribution
  // Backlog) live inside the Operations workspace; the compliance trio
  // (Audit / Pricing / Platform Notifications) inside Governance. Team and
  // Customers keep their own rows because each already has its own
  // internal tab bar (nesting them would create tab-inside-tab). Metrics
  // was removed as a standalone nav row (Tier 3): /admin/metrics merged
  // into /admin as tabs, so a separate "Metrics" entry pointed at the same
  // page as "Dashboard" — a dead/confusing nav item (NavLink's
  // pathname-only active-matching also meant the highlight always landed
  // on Dashboard, never Metrics). The route stays live as a redirect shim
  // for old bookmarks; it's just off the primary nav now. All standalone
  // routes stay live for deep links and the ⌘K palette.
  const platformItems: NavItem[] = [
    { label: 'Dashboard',   to: '/admin',            icon: LayoutDashboard, end: true },
    { label: 'Operations',  to: '/admin/operations', icon: Wrench },
    // Governance is visible to all staff — its Audit Log tab is all-staff;
    // the Pricing / Platform Notifications tabs gate themselves inside the
    // workspace (view_billing / super_admin).
    { label: 'Governance',  to: '/admin/governance', icon: ClipboardList },
    { label: 'Team',        to: '/admin/users?tab=members', icon: Users },
    ...(isSuperAdmin
      ? [{ label: 'Customers', to: '/admin/customers', icon: Building2 } as NavItem]
      : []),
    { label: 'Sales Leads', to: '/leads',            icon: Target },
  ];

  return [
    {
      label: 'SOC CONSOLE',
      items: [
        // Console consolidates Signals / Threats / Incidents / Takedowns as
        // tabs — so those don't appear as separate menu items in v4 (their
        // routes stay live for deep links). Abuse Mailbox + Spam Trap are NOT
        // Console tabs, so they remain standalone here — but both pages
        // hard-bounce non-super-admins, so their rows are gated to match.
        { label: 'Console',       to: '/console',              icon: SquareTerminal, count: openAlerts },
        { label: 'Overview',      to: '/',                     icon: LayoutDashboard, end: true },
        ...(isSuperAdmin
          ? [
              { label: 'Abuse Mailbox', to: '/admin/abuse-mailbox', icon: Mail } as NavItem,
              { label: 'Spam Trap',     to: '/admin/spam-trap',     icon: Inbox } as NavItem,
            ]
          : []),
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
        { label: 'Observatory', to: '/observatory',    icon: Globe },
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

// Palette commands = every nav destination (already role-gated by buildV4Nav)
// PLUS the consolidated targets that live inside Console/Explorer/Coverage as
// tabs and the entity pages that don't get their own sidebar row, so ⌘K can
// still jump straight to any page. Keywords cover synonyms an analyst might
// type (e.g. "alerts" for Signals, "typosquat" for Trademarks).
function buildPaletteCommands(
  nav: NavGroup[],
  opts: { isSuperAdmin: boolean; role: string | null | undefined },
): PaletteCommand[] {
  const { isSuperAdmin, role } = opts;
  const fromNav: PaletteCommand[] = nav.flatMap(group =>
    group.items.map(item => ({
      label: item.label,
      to: item.to,
      group: group.label,
      icon: item.icon,
    })),
  );

  const extras: PaletteCommand[] = [
    // Platform-ops pages consolidated under the Operations / Governance
    // workspaces (standalone routes stay live; gating mirrors the pages)
    { label: 'Agents',                to: '/agents',            group: 'PLATFORM', icon: Cpu, keywords: 'fleet runs mesh' },
    { label: 'Feeds',                 to: '/feeds',             group: 'PLATFORM', icon: Rss, keywords: 'ingestion sources pulls' },
    { label: 'Takedown Integrations', to: '/admin/integrations', group: 'PLATFORM', icon: Plug, keywords: 'submitters providers registrars' },
    { label: 'Attribution Backlog',   to: '/admin/agents/attribution-backlog', group: 'PLATFORM', icon: ListChecks, keywords: 'clusters unattributed' },
    { label: 'Audit Log',             to: '/admin/audit',       group: 'PLATFORM', icon: ClipboardList, keywords: 'compliance history actions' },
    ...(isSuperAdmin || role === 'admin'
      ? [{ label: 'Platform Users', to: '/admin/platform-users', group: 'PLATFORM', icon: Users, keywords: 'staff accounts roles sessions invites' } as PaletteCommand]
      : []),
    ...(roleHasPermission(role, 'view_billing')
      ? [{ label: 'Pricing', to: '/admin/pricing', group: 'PLATFORM', icon: DollarSign, keywords: 'plans billing modules' } as PaletteCommand]
      : []),
    ...(isSuperAdmin
      ? [{ label: 'Platform Notifications', to: '/admin/notifications', group: 'PLATFORM', icon: Bell, keywords: 'mutes system alerts volume' } as PaletteCommand]
      : []),
    // Console tabs (deep-linked routes that don't have their own nav row)
    { label: 'Alerts',    to: '/alerts',           group: 'SOC CONSOLE', icon: ShieldAlert, keywords: 'alerts queue triage signals' },
    { label: 'Threats',   to: '/threats',          group: 'SOC CONSOLE', icon: Bug, keywords: 'iocs indicators' },
    { label: 'Incidents', to: '/admin/incidents',  group: 'SOC CONSOLE', icon: ShieldAlert, keywords: 'cases' },
    { label: 'Takedowns', to: '/admin/takedowns',  group: 'SOC CONSOLE', icon: Target, keywords: 'sparrow disruption removal' },
    // Intelligence entity pages (consolidated under Explorer / Coverage tabs)
    { label: 'Brands',        to: '/brands',        group: 'INTELLIGENCE', icon: Building2 },
    { label: 'Threat Actors', to: '/threat-actors', group: 'INTELLIGENCE', icon: Network, keywords: 'apt groups attribution' },
    { label: 'Campaigns',     to: '/campaigns',     group: 'INTELLIGENCE', icon: Megaphone },
    { label: 'Providers',     to: '/providers',     group: 'INTELLIGENCE', icon: Server, keywords: 'hosting asn' },
    { label: 'Apps',          to: '/apps',          group: 'INTELLIGENCE', icon: Smartphone, keywords: 'app store mobile impersonation' },
    { label: 'Dark Web',      to: '/dark-web',      group: 'INTELLIGENCE', icon: EyeOff, keywords: 'breach leak' },
    { label: 'Trademarks',    to: '/trademarks',    group: 'INTELLIGENCE', icon: Scale, keywords: 'typosquat lookalike' },
    { label: 'Trends',        to: '/trends',        group: 'INTELLIGENCE', icon: TrendingUp, keywords: 'intelligence analytics' },
    // Account / personal
    { label: 'Profile',       to: '/profile',       group: 'ACCOUNT', icon: UserCog, keywords: 'account sign out settings' },
    { label: 'Notifications', to: '/notifications', group: 'ACCOUNT', icon: Bell, keywords: 'inbox' },
  ];

  // de-dupe by route — nav rows win, extras only fill the gaps
  const seen = new Set(fromNav.map(c => c.to));
  return [...fromNav, ...extras.filter(c => !seen.has(c.to))];
}

/**
 * Routes that bring their own gutters (`.console-v4` = 22px 24px 44px) or
 * need the whole outlet. Every other route gets the baseline page gutter
 * (16px 24px; 12px 16px at <=900px) — classic-shell parity.
 */
const FULL_BLEED_ROUTES: ReadonlySet<string> = new Set([
  '/',
  '/console',
  '/explore',
  '/coverage',
  '/admin/operations',
  '/admin/governance',
  // Shared ProfilePage already centers itself in a 720px column with 24px
  // gutters (and must stay structurally identical to FarmTrack's).
  '/profile',
]);

/** Observatory fills the outlet (no gutter, no scroll) and sizes via flex. */
const FILL_ROUTE_PREFIX = '/observatory';

export type OutletLayout = 'padded' | 'bleed' | 'fill';

export function outletLayoutFor(pathname: string): OutletLayout {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === FILL_ROUTE_PREFIX || path.startsWith(FILL_ROUTE_PREFIX + '/')) return 'fill';
  return FULL_BLEED_ROUTES.has(path) ? 'bleed' : 'padded';
}

export function ShellV4() {
  const { user, isSuperAdmin } = useAuth();
  const location = useLocation();
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const wasDrawerOpen = useRef(false);
  const skipFocusRestore = useRef(false);
  const openAlerts = useOpenAlertCount();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);
  const nav = buildV4Nav({
    isSuperAdmin,
    role: user?.role,
    openAlerts: openAlerts.isSuccess ? openAlerts.data : undefined,
  });
  const commands = buildPaletteCommands(nav, { isSuperAdmin, role: user?.role });
  // H-3 (AUTH_AUDIT_2026-06): a privileged user on an enrollment-scoped
  // session (signed in without a passkey) would otherwise get the full nav
  // + Outlet with no blocking gate — every protected fetch 403s with
  // nothing on screen to explain why. Render nothing in the Outlet while
  // locked; PasskeyEnrollmentGate overlays the screen instead.
  const enrollmentLocked = !!user?.passkey_required;

  // global ⌘K / Ctrl-K to toggle the palette (and "/" when not already typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        skipFocusRestore.current = true; // palette takes focus, not the hamburger
        setDrawerOpen(false);
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drawer: close on route change, on Escape, and when the viewport widens
  // past the drawer breakpoint (the desktop rail is never hidden/inert).
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 901px)');
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setDrawerOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [drawerOpen]);

  // Focus management lives here once, so EVERY close path (Escape, X,
  // backdrop, nav click, route change) restores focus to the hamburger and
  // every open moves focus into the drawer.
  useEffect(() => {
    if (drawerOpen) {
      closeBtnRef.current?.focus();
    } else if (wasDrawerOpen.current) {
      if (skipFocusRestore.current) skipFocusRestore.current = false;
      else hamburgerRef.current?.focus();
    }
    wasDrawerOpen.current = drawerOpen;
  }, [drawerOpen]);

  // Simple focus trap while the drawer is open.
  const onDrawerKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!drawerOpen || e.key !== 'Tab') return;
    const focusables = Array.from(
      sideRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [],
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !sideRef.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !sideRef.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const openPalette = () => { skipFocusRestore.current = true; setDrawerOpen(false); setPaletteOpen(true); };

  return (
    <div className={'shell-v4' + (drawerOpen ? ' drawer-open' : '')}>
      <aside
        id="v4-drawer"
        ref={sideRef}
        className="v4-side"
        onKeyDown={onDrawerKeyDown}
        {...(drawerOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Main navigation' } : {})}
      >
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
          <button type="button" ref={closeBtnRef} className="v4-drawer-close" onClick={closeDrawer} aria-label="Close menu">
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
                    {item.count != null && item.count > 0 && (
                      <>
                        <span className="count" aria-hidden="true">
                          {item.count > 99 ? '99+' : item.count}
                        </span>
                        <span className="sr-only">{item.count} alerts awaiting triage</span>
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="v4-foot">
          <ThemeCycleButton />
        </div>
        <div className="v4-verline" title={`${VERSION_LABEL} · ${BUILD_SHA}`}>
          {VERSION_LABEL}<span style={{ opacity: 0.5 }}> · {BUILD_SHA}</span>
        </div>
      </aside>

      {/* mobile drawer backdrop (CSS shows it only when .drawer-open on small screens) */}
      <div className="v4-backdrop" onClick={closeDrawer} aria-hidden />

      <section className="v4-main">
        <header className="v4-top">
          <button type="button" ref={hamburgerRef} className="v4-hamburger" onClick={() => setDrawerOpen(true)} aria-label="Open menu" aria-expanded={drawerOpen} aria-controls="v4-drawer">
            <Menu size={18} strokeWidth={2} />
          </button>
          <button type="button" className="v4-cmdk" onClick={openPalette} aria-label="Open command palette">
            <Search size={14} strokeWidth={2} />
            <span className="v4-cmdk-label">Search threats, brands, actors…</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="v4-live"><span className="dot" />LIVE</div>
          <NotificationBell />
          <UserAvatar />
        </header>
        <div className="v4-outlet">
          {/* Self-gates on its own paths + unread state. The wrapper hides
              itself via :empty when the banner renders nothing, so no stray
              mobile padding appears on other routes. */}
          <div className="v4-banner-wrap"><PlatformAlertBanner /></div>
          <div className={`v4-page v4-page--${outletLayoutFor(location.pathname)}`}>
            {enrollmentLocked ? null : <Outlet />}
          </div>
        </div>
      </section>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />

      {/* Auto-prompts biometric setup on first login when the user has zero
          passkeys + WebAuthn is supported. Self-gates internally (localStorage
          flag + passkey_count check) — safe to mount unconditionally. */}
      <FirstSignInPasskeyPrompt />
      {/* H-3: blocking gate for privileged users who signed in without a
          passkey. Self-gates on user.passkey_required. */}
      <PasskeyEnrollmentGate />
    </div>
  );
}
