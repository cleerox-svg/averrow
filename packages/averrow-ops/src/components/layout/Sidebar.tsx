import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Globe, Shield, Server, Activity, TrendingUp, Crosshair,
  Gavel, Bell, Inbox, Target, Siren,
  Cpu, Rss, LayoutDashboard, Users, ClipboardList, Building2,
  Smartphone, EyeOff, BellRing, BarChart3, DollarSign,
  Sun, Moon, Laptop,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { AverrowLogo } from '@/components/brand/AverrowLogo';
import { Badge } from '@/design-system/components';
import { useObservatoryVersion, useTheme, useVersionToggle } from '@/design-system/hooks';

interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  badge?: number;
  // Highlight this entry when location matches any of these prefixes
  // (used so the single Observatory entry stays active across both
  // /observatory and /observatory-v3 regardless of which version
  // the user has selected).
  matchPrefixes?: string[];
  // Force exact path match. Use for entries whose path is a prefix
  // of sibling entries (e.g. Dashboard at `/admin` would otherwise
  // also match `/admin/users`, `/admin/customers`, etc.).
  exact?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

interface SidebarProps {
  onNavigate?: () => void;
}

const SIDEBAR_CONTAINER_STYLE: React.CSSProperties = {
  // Use --bg-sidebar so the gradient flips with the theme. The
  // start/end stops are the same var twice — keeps the original
  // gradient API but lets light mode read the light surface.
  background: 'linear-gradient(180deg, var(--bg-sidebar) 0%, var(--bg-sidebar) 100%)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  borderRight: '1px solid var(--border-base)',
  boxShadow: [
    '4px 0 48px rgba(0,0,0,0.30)',
    'inset -1px 0 0 var(--border-base)',
    'inset 0 1px 0 var(--border-base)',
  ].join(', '),
};

const NAV_INACTIVE_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 14px',
  margin: '1px 8px',
  borderRadius: 10,
  color: 'var(--text-secondary)',
  background: 'transparent',
  border: '1px solid transparent',
  transition: 'all 0.15s ease',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  textDecoration: 'none',
};

const NAV_ACTIVE_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 12px',
  margin: '1px 8px',
  borderRadius: 10,
  color: '#E5A832',
  background: 'linear-gradient(135deg, rgba(229,168,50,0.12), rgba(229,168,50,0.06))',
  border: '1px solid rgba(229,168,50,0.22)',
  borderLeft: '2px solid #E5A832',
  boxShadow: [
    'inset 0 1px 0 rgba(229,168,50,0.20)',
    '0 0 12px rgba(229,168,50,0.08)',
  ].join(', '),
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'none',
};

export function Sidebar({ onNavigate }: SidebarProps) {
  const { user, logout, isSuperAdmin, isBrandAdmin } = useAuth();
  const [alertCount, setAlertCount] = useState(0);
  const { path: observatoryPath } = useObservatoryVersion();
  const { path: agentsPath } = useVersionToggle('agents');
  const location = useLocation();

  useEffect(() => {
    const fetchAlerts = () => {
      api.get<unknown>('/api/alerts?status=open&limit=1')
        .then(d => setAlertCount(d.total ?? 0))
        .catch(() => {});
    };
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Phase D D2b: averrow-ops is now staff-only. The brand-admin
  // sidebar that used to live here was just a thin customer
  // experience inside the staff app — that surface lives at
  // /tenant/ now (averrow-tenant package). Server-side RBAC
  // tightening lands in D2c so brand_admin users never reach
  // these routes; until then the trim is sidebar-only.
  const OPS_SECTIONS: NavSection[] = [
    {
      label: 'INTELLIGENCE',
      items: [
        { label: 'Home',         path: '/',             icon: LayoutDashboard },
        { label: 'Observatory',  path: observatoryPath, icon: Globe, matchPrefixes: ['/observatory', '/observatory-v3'] },
        { label: 'Brands',       path: '/brands',       icon: Shield },
        { label: 'Threats',      path: '/threats',       icon: Crosshair },
        { label: 'Apps',         path: '/apps',          icon: Smartphone },
        { label: 'Dark Web',     path: '/dark-web',      icon: EyeOff },
        { label: 'Providers',    path: '/providers',     icon: Server },
        { label: 'Campaigns',    path: '/campaigns',     icon: Activity },
        { label: 'Threat Actors', path: '/threat-actors', icon: Crosshair },
        { label: 'Intelligence', path: '/trends',        icon: TrendingUp },
      ],
    },
    {
      label: 'RESPONSE',
      items: [
        { label: 'Incidents',    path: '/admin/incidents',  icon: Siren },
        { label: 'Takedowns',    path: '/admin/takedowns',  icon: Gavel },
        { label: 'Alerts',       path: '/alerts',           icon: Bell, badge: alertCount },
        { label: 'Spam Trap',    path: '/admin/spam-trap',  icon: Inbox },
        { label: 'Leads',       path: '/leads',            icon: Target },
      ],
    },
    {
      label: 'PLATFORM',
      items: [
        { label: 'Agents',       path: agentsPath,           icon: Cpu, matchPrefixes: ['/agents', '/agents-v3'] },
        { label: 'Feeds',        path: '/feeds',             icon: Rss },
        { label: 'Metrics',      path: '/admin/metrics',     icon: BarChart3 },
        { label: 'Dashboard',    path: '/admin',             icon: LayoutDashboard, exact: true },
        { label: 'Team', path: '/admin/users?tab=members', icon: Users, matchPrefixes: ['/admin/users'] },
        ...(isSuperAdmin ? [{ label: 'Customers', path: '/admin/customers', icon: Building2, matchPrefixes: ['/admin/customers', '/admin/organizations'] }] : []),
        ...(isSuperAdmin ? [{ label: 'Pricing', path: '/admin/pricing', icon: DollarSign }] : []),
        { label: 'Audit Log',    path: '/admin/audit',       icon: ClipboardList },
        ...(isSuperAdmin ? [{ label: 'Push Config', path: '/admin/push', icon: BellRing }] : []),
      ],
    },
  ];

  const NAV_SECTIONS = OPS_SECTIONS;

  return (
    <aside className="w-56 h-full flex flex-col" style={SIDEBAR_CONTAINER_STYLE}>
      <div
        className="px-4 pt-4"
        style={{
          borderBottom: '1px solid var(--border-base)',
          paddingBottom: 16,
          marginBottom: 8,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <AverrowLogo />
        <ThemeCycleButton />
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 6px' }}>
              <span
                style={{
                  fontSize: 9,
                  fontFamily: 'monospace',
                  letterSpacing: '0.22em',
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  fontWeight: 700,
                }}
              >
                {section.label}
              </span>
              <div
                style={{
                  flex: 1,
                  height: 1,
                  background: 'linear-gradient(90deg, var(--border-base), transparent)',
                }}
              />
            </div>
            {section.items.map(item => {
              const Icon = item.icon;
              const prefixActive = item.matchPrefixes?.some(p =>
                location.pathname === p || location.pathname.startsWith(p + '/'),
              );
              // `end` is needed for: (a) the root path, and (b) any entry
              // whose path is a prefix of sibling entries (Dashboard at
              // `/admin` shouldn't light up when you're on `/admin/users`).
              // Every other entry should stay active on its child URLs
              // (e.g. `/admin/incidents/:id`, `/brands/:id`) — H2 audit fix.
              const exactMatch = item.path === '/' || item.exact === true;
              return (
                <NavLink
                  key={item.label}
                  to={item.path}
                  onClick={onNavigate}
                  end={exactMatch}
                  style={({ isActive }) => ((isActive || prefixActive) ? NAV_ACTIVE_STYLE : NAV_INACTIVE_STYLE)}
                >
                  {({ isActive }) => {
                    const active = isActive || !!prefixActive;
                    return (
                      <>
                        <Icon
                          size={16}
                          style={{
                            flexShrink: 0,
                            color: active ? '#E5A832' : 'var(--text-tertiary)',
                            filter: active ? 'drop-shadow(0 0 4px rgba(229,168,50,0.60))' : undefined,
                          }}
                        />
                        <span>{item.label}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                          <span className="ml-auto">
                            <Badge severity="critical" label={String(item.badge)} size="xs" />
                          </span>
                        )}
                      </>
                    );
                  }}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div
        style={{
          borderTop: '1px solid var(--border-base)',
          padding: '12px 16px',
          marginTop: 'auto',
        }}
      >
        {isBrandAdmin && user?.organization && (
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--amber)', opacity: 0.7 }}>
            {user.organization.name}
          </div>
        )}
        <div
          className="truncate"
          style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'monospace' }}
        >
          {user?.email}
        </div>
        <button
          onClick={logout}
          className="mt-2 hover:text-accent transition-colors"
          style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontFamily: 'monospace',
            letterSpacing: '0.12em',
          }}
        >
          LOGOUT
        </button>
      </div>
    </aside>
  );
}

// Sidebar header theme cycler. Single click cycles
// auto → dark → light → auto. Mirror of the tenant sidebar's
// toggle so both products carry the same canonical surface
// (per SHARED_LOGIN_SPEC). Profile Preferences is the explicit
// picker; this button is the quick-access affordance.
function ThemeCycleButton() {
  const { theme, cycle } = useTheme();
  const Icon = theme === 'auto' ? Laptop : theme === 'light' ? Sun : Moon;
  const label =
    theme === 'auto'  ? 'Theme: auto (follows OS) — click for dark' :
    theme === 'dark'  ? 'Theme: dark — click for light' :
                        'Theme: light — click for auto';
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      style={{
        padding: 6,
        borderRadius: 6,
        background: 'transparent',
        border: 'none',
        color: 'var(--text-tertiary)',
        cursor: 'pointer',
        transition: 'color 120ms ease',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)'; }}
    >
      <Icon size={14} />
    </button>
  );
}
