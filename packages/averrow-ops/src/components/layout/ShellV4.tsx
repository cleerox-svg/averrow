// v4 "Cinematic command center" shell (redesign coexistence — W0).
//
// Renders the SAME route <Outlet/> as the current Shell, inside the new
// cinematic chrome (3-workspace IA sidebar + topbar). Flipped on/off by
// useShellVersion via <ShellSwitch/> — the current shell is untouched.
// Page internals get re-skinned into the new design system in later waves;
// W0 establishes the chrome + the coexistence gate end-to-end.

import { Outlet, NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Radar, Crosshair, Siren, Gavel, Mail, Inbox,
  Globe, Shield, Users, Activity, Server, Smartphone, EyeOff, Award,
  TrendingUp, Cpu, Rss, BarChart3, ClipboardList, Bell, Target,
  Search, Sparkles, RotateCcw,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { parseInitials } from '@/lib/avatar';
import { Shell } from './Shell';
import { useShellVersion } from '@/design-system/hooks/useShellVersion';
import './shell-v4.css';

interface NavItem { label: string; to: string; icon: typeof Radar; end?: boolean; }
interface NavGroup { label: string; items: NavItem[]; }

const V4_NAV: NavGroup[] = [
  {
    label: 'SOC CONSOLE',
    items: [
      { label: 'Overview',      to: '/',                     icon: LayoutDashboard, end: true },
      { label: 'Signals',       to: '/alerts',               icon: Radar },
      { label: 'Threats',       to: '/threats',              icon: Crosshair },
      { label: 'Incidents',     to: '/admin/incidents',      icon: Siren },
      { label: 'Takedowns',     to: '/admin/takedowns',      icon: Gavel },
      { label: 'Abuse Mailbox', to: '/admin/abuse-mailbox',  icon: Mail },
      { label: 'Spam Trap',     to: '/admin/spam-trap',      icon: Inbox },
    ],
  },
  {
    label: 'INTELLIGENCE',
    items: [
      { label: 'Observatory',   to: '/observatory-v3', icon: Globe },
      { label: 'Brands',        to: '/brands',         icon: Shield },
      { label: 'Threat Actors', to: '/threat-actors',  icon: Users },
      { label: 'Campaigns',     to: '/campaigns',      icon: Activity },
      { label: 'Providers',     to: '/providers',      icon: Server },
      { label: 'Apps',          to: '/apps',           icon: Smartphone },
      { label: 'Dark Web',      to: '/dark-web',       icon: EyeOff },
      { label: 'Trademarks',    to: '/trademarks',     icon: Award },
      { label: 'Trends',        to: '/trends',         icon: TrendingUp },
    ],
  },
  {
    label: 'PLATFORM',
    items: [
      { label: 'Dashboard',     to: '/admin',          icon: LayoutDashboard, end: true },
      { label: 'Agents',        to: '/agents',         icon: Cpu },
      { label: 'Feeds',         to: '/feeds',          icon: Rss },
      { label: 'Metrics',       to: '/admin/metrics',  icon: BarChart3 },
      { label: 'Team',          to: '/admin/users',    icon: Users },
      { label: 'Audit Log',     to: '/admin/audit',    icon: ClipboardList },
      { label: 'Notifications', to: '/admin/notifications', icon: Bell },
      { label: 'Sales Leads',   to: '/leads',          icon: Target },
    ],
  },
];

function navClass({ isActive }: { isActive: boolean }) {
  return 'v4-item' + (isActive ? ' active' : '');
}

export function ShellV4() {
  const { user } = useAuth();
  const initials = parseInitials(user?.display_name ?? user?.name ?? null, user?.email ?? null);

  return (
    <div className="shell-v4">
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
        </div>

        <nav className="v4-nav">
          {V4_NAV.map(group => (
            <div key={group.label}>
              <div className="v4-grp">{group.label}</div>
              {group.items.map(item => {
                const Icon = item.icon;
                return (
                  <NavLink key={item.to + item.label} to={item.to} end={item.end} className={navClass}>
                    <Icon strokeWidth={2} /> {item.label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="v4-foot">
          <div className="v4-avatar">{initials}</div>
          <div style={{ minWidth: 0, overflow: 'hidden' }}>
            <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-secondary)' }}>
              {user?.display_name ?? user?.name ?? user?.email ?? 'Signed in'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{user?.role}</div>
          </div>
          <span className="v4-verchip" style={{ marginLeft: 'auto' }}>v4.0.0</span>
        </div>
      </aside>

      <section className="v4-main">
        <header className="v4-top">
          <div className="v4-cmdk" title="Command palette arrives with the v4 component library">
            <Search size={14} strokeWidth={2} />
            Search threats, brands, actors…
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
