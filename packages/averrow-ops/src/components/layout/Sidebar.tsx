import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Globe, Shield, Server, Activity, TrendingUp, Crosshair,
  Gavel, Bell, Inbox, Mail, Target, Siren, AlertTriangle,
  Cpu, Rss, LayoutDashboard, Users, ClipboardList, Building2,
  Smartphone, EyeOff, BellRing, DollarSign, Award,
  Sun, Moon, Laptop, PanelLeftClose, PanelLeftOpen, LogOut, Plug,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { api } from '@/lib/api';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { AverrowLogo } from '@/components/brand/AverrowLogo';
import { Badge } from '@/design-system/components';
import { useTheme } from '@/design-system/hooks';

interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  badge?: number;
  // Highlight this entry when location matches any of these prefixes
  // (e.g. Team should stay active on any /admin/users sub-path).
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

export type SidebarMode = 'expanded' | 'rail';

interface SidebarProps {
  onNavigate?: () => void;
  // Rail mode collapses to icons only — used by the mobile-vertical
  // drawer. Defaults to 'expanded' for the desktop sidebar.
  mode?: SidebarMode;
  // When provided, the sidebar renders an inline toggle (rail ↔ expanded)
  // in its header. Used by the drawer to flip its own width.
  onToggleMode?: () => void;
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
  // --amber-text: byte-identical to --amber (#E5A832) in dark; resolves to
  // an AA-checked darker amber in light mode (raw --amber is ~2.1:1 on the
  // light sidebar — an AA text-contrast fail at 13px).
  color: 'var(--amber-text)',
  // --nav-active-fill-1/2, --nav-active-border, --nav-active-rim,
  // --nav-active-glow: theme-aware (tokens.css), dark defaults
  // byte-identical to the literals this replaced; boosted under
  // [data-theme="light"] so the active item doesn't read as a beige
  // smudge on the light sidebar (#E5E9F0).
  background: 'linear-gradient(135deg, var(--nav-active-fill-1), var(--nav-active-fill-2))',
  border: '1px solid var(--nav-active-border)',
  borderLeft: '2px solid #E5A832',
  boxShadow: [
    'inset 0 1px 0 var(--nav-active-rim)',
    '0 0 12px var(--nav-active-glow)',
  ].join(', '),
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'none',
};

export function Sidebar({ onNavigate, mode = 'expanded', onToggleMode }: SidebarProps) {
  const { user, logout, isSuperAdmin, isBrandAdmin } = useAuth();
  const [alertCount, setAlertCount] = useState(0);
  const location = useLocation();
  const isRail = mode === 'rail';

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
        { label: 'Observatory',  path: '/observatory', icon: Globe, matchPrefixes: ['/observatory'] },
        { label: 'Brands',       path: '/brands',       icon: Shield },
        { label: 'Threats',      path: '/threats',       icon: Crosshair },
        { label: 'Apps',         path: '/apps',          icon: Smartphone },
        { label: 'Dark Web',     path: '/dark-web',      icon: EyeOff },
        { label: 'Trademarks',   path: '/trademarks',    icon: Award },
        { label: 'Providers',    path: '/providers',     icon: Server },
        { label: 'Campaigns',    path: '/campaigns',     icon: Activity },
        { label: 'Threat Actors', path: '/threat-actors', icon: Crosshair },
        { label: 'Trends',       path: '/trends',        icon: TrendingUp },
      ],
    },
    {
      label: 'RESPONSE',
      items: [
        { label: 'Incidents',    path: '/admin/incidents',  icon: Siren },
        { label: 'Takedowns',    path: '/admin/takedowns',  icon: Gavel },
        { label: 'Integrations', path: '/admin/integrations', icon: Plug },
        { label: 'Alerts',       path: '/alerts',           icon: AlertTriangle, badge: alertCount },
        { label: 'Spam Trap',    path: '/admin/spam-trap',  icon: Inbox },
        { label: 'Abuse Mailbox', path: '/admin/abuse-mailbox', icon: Mail },
        { label: 'Leads',       path: '/leads',            icon: Target },
      ],
    },
    {
      label: 'PLATFORM',
      items: [
        { label: 'Agents',       path: '/agents',           icon: Cpu },
        { label: 'Feeds',        path: '/feeds',             icon: Rss },
        { label: 'Dashboard',    path: '/admin',             icon: LayoutDashboard, exact: true },
        { label: 'Team', path: '/admin/users?tab=members', icon: Users, matchPrefixes: ['/admin/users'] },
        ...(isSuperAdmin ? [{ label: 'Customers', path: '/admin/customers', icon: Building2, matchPrefixes: ['/admin/customers', '/admin/organizations'] }] : []),
        ...(roleHasPermission(user?.role, 'view_billing') ? [{ label: 'Pricing', path: '/admin/pricing', icon: DollarSign }] : []),
        { label: 'Audit Log',    path: '/admin/audit',       icon: ClipboardList },
        { label: 'Attribution Backlog', path: '/admin/agents/attribution-backlog', icon: Target },
        // NX-push-uxr: Push Config removed from the primary nav — it's a
        // one-time VAPID bootstrap, not day-to-day ops. The route stays
        // at /admin/push and a card in AdminDashboard surfaces it when
        // push isn't fully configured.
      ],
    },
  ];

  const NAV_SECTIONS = OPS_SECTIONS;

  return (
    <aside
      className="h-full flex flex-col"
      style={{
        ...SIDEBAR_CONTAINER_STYLE,
        width: isRail ? 64 : 224,
        transition: 'width 0.18s ease',
      }}
    >
      <div
        style={{
          borderBottom: '1px solid var(--border-base)',
          paddingBottom: 16,
          marginBottom: 8,
          padding: isRail ? '16px 8px 16px' : '16px 16px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: isRail ? 'center' : 'space-between',
          gap: 8,
        }}
      >
        {!isRail && <AverrowLogo />}
        {onToggleMode ? (
          <button
            type="button"
            onClick={onToggleMode}
            aria-label={isRail ? 'Expand sidebar' : 'Collapse to icons'}
            title={isRail ? 'Expand sidebar' : 'Collapse to icons'}
            style={{
              padding: 6,
              borderRadius: 6,
              background: 'transparent',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isRail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        ) : (
          !isRail && <ThemeCycleButton />
        )}
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_SECTIONS.map((section, idx) => (
          <div key={section.label}>
            {isRail ? (
              // Rail mode: replace the label with a thin divider so
              // section grouping is still visible without the text.
              idx > 0 && (
                <div
                  style={{
                    height: 1,
                    margin: '10px 12px',
                    background: 'var(--border-base)',
                  }}
                />
              )
            ) : (
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
            )}
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
              const railItemStyle: React.CSSProperties = isRail ? {
                justifyContent: 'center',
                padding: '10px 0',
                margin: '2px 8px',
                gap: 0,
                position: 'relative',
              } : {};
              return (
                <NavLink
                  key={item.label}
                  to={item.path}
                  onClick={onNavigate}
                  end={exactMatch}
                  title={isRail ? item.label : undefined}
                  aria-label={isRail ? item.label : undefined}
                  style={({ isActive }) => ({
                    ...((isActive || prefixActive) ? NAV_ACTIVE_STYLE : NAV_INACTIVE_STYLE),
                    ...railItemStyle,
                  })}
                >
                  {({ isActive }) => {
                    const active = isActive || !!prefixActive;
                    return (
                      <>
                        <Icon
                          size={isRail ? 18 : 16}
                          style={{
                            flexShrink: 0,
                            color: active ? 'var(--amber-text)' : 'var(--text-tertiary)',
                            filter: active ? 'drop-shadow(0 0 4px rgba(229,168,50,0.60))' : undefined,
                          }}
                        />
                        {!isRail && <span>{item.label}</span>}
                        {!isRail && item.badge !== undefined && item.badge > 0 && (
                          <span className="ml-auto">
                            <Badge severity="critical" label={String(item.badge)} size="xs" />
                          </span>
                        )}
                        {isRail && item.badge !== undefined && item.badge > 0 && (
                          <span
                            style={{
                              position: 'absolute',
                              top: 4,
                              right: 6,
                              minWidth: 14,
                              height: 14,
                              padding: '0 4px',
                              borderRadius: 99,
                              background: 'var(--sev-critical)',
                              color: '#fff',
                              fontSize: 9,
                              fontWeight: 800,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              lineHeight: 1,
                            }}
                          >
                            {item.badge > 99 ? '99+' : item.badge}
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
          padding: isRail ? '10px 0' : '12px 16px',
          marginTop: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: isRail ? 'center' : 'stretch',
          gap: isRail ? 8 : 0,
        }}
      >
        {!isRail && isBrandAdmin && user?.organization && (
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--amber)', opacity: 0.7 }}>
            {user.organization.name}
          </div>
        )}
        {!isRail && (
          <div
            className="truncate"
            style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'monospace' }}
          >
            {user?.email}
          </div>
        )}
        {!isRail && (
          <div
            title={`${VERSION_LABEL} · ${BUILD_SHA}`}
            style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', letterSpacing: '0.08em', marginTop: 4 }}
          >
            {VERSION_LABEL} · {BUILD_SHA}
          </div>
        )}
        {isRail ? (
          <>
            <ThemeCycleButton />
            <button
              onClick={logout}
              aria-label="Logout"
              title="Logout"
              style={{
                padding: 6,
                borderRadius: 6,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <LogOut size={14} />
            </button>
          </>
        ) : (
          <button
            onClick={logout}
            className="mt-2 hover:text-accent transition-colors"
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontFamily: 'monospace',
              letterSpacing: '0.12em',
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              padding: 0,
            }}
          >
            LOGOUT
          </button>
        )}
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
