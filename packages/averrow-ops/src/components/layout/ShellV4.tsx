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

import { useEffect, useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import {
  LayoutDashboard, SquareTerminal, Mail, Inbox,
  Globe, Users, Cpu, Rss, ClipboardList, Bell, Target,
  Search, Sparkles, RotateCcw, Menu, X,
  Plug, Building2, DollarSign, ListChecks, Compass, Layers,
  LogOut, UserCircle, ShieldAlert, Bug, Network, Megaphone, Server,
  Smartphone, EyeOff, Scale, TrendingUp, UserCog, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { parseInitials } from '@/lib/avatar';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { Shell } from './Shell';
import { useShellVersion } from '@/design-system/hooks/useShellVersion';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { PasskeyEnrollmentGate } from '@/components/PasskeyEnrollmentGate';
import { FirstSignInPasskeyPrompt } from '@/components/FirstSignInPasskeyPrompt';
import './shell-v4.css';

interface NavItem { label: string; to: string; icon: LucideIcon; end?: boolean; }
interface NavGroup { label: string; items: NavItem[]; }

// Nav is built per-render so it can role-gate sensitive PLATFORM items
// (Customers → super_admin, Pricing → view_billing), matching the classic
// Sidebar. Anything not gated is visible to every staff role.
function buildV4Nav(opts: { isSuperAdmin: boolean; role: string | null | undefined }): NavGroup[] {
  const { isSuperAdmin, role } = opts;

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
    { label: 'Team',        to: '/admin/users',      icon: Users },
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
        { label: 'Console',       to: '/console',              icon: SquareTerminal },
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

export function ShellV4() {
  const { user, isSuperAdmin, logout } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const initials = parseInitials(user?.display_name ?? user?.name ?? null, user?.email ?? null);
  const closeDrawer = () => setDrawerOpen(false);
  const nav = buildV4Nav({ isSuperAdmin, role: user?.role });
  const commands = buildPaletteCommands(nav, { isSuperAdmin, role: user?.role });
  // H-3 (AUTH_AUDIT_2026-06): mirrors Shell.tsx's gate, which this shell
  // never got when it was added. A privileged user on an enrollment-scoped
  // session (signed in without a passkey) who has switched to the v4 shell
  // otherwise gets the full nav + Outlet with no blocking gate — every
  // protected fetch 403s with nothing on screen to explain why. Render
  // nothing in the Outlet while locked; PasskeyEnrollmentGate overlays the
  // screen instead.
  const enrollmentLocked = !!user?.passkey_required;

  // global ⌘K / Ctrl-K to toggle the palette (and "/" when not already typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openPalette = () => { setDrawerOpen(false); setPaletteOpen(true); };

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
          <button type="button" className="v4-cmdk" onClick={openPalette} aria-label="Open command palette">
            <Search size={14} strokeWidth={2} />
            <span className="v4-cmdk-label">Search threats, brands, actors…</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="v4-live"><span className="dot" />LIVE</div>
        </header>
        <div className="v4-outlet">
          {enrollmentLocked ? null : <Outlet />}
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
