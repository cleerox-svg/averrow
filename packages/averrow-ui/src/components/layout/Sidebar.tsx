import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Globe, Shield, Server, Activity, TrendingUp, Crosshair,
  Gavel, Bell, Inbox, Target,
  Cpu, Rss, LayoutDashboard, Users, ClipboardList, Building2,
  Smartphone, EyeOff, BellRing,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { AverrowLogo } from '@/components/brand/AverrowLogo';
import { Badge } from '@/design-system/components';

interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  badge?: number;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

interface SidebarProps {
  onNavigate?: () => void;
}

const SIDEBAR_CONTAINER_STYLE: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(10,16,30,0.96) 0%, rgba(6,10,20,0.99) 100%)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  borderRight: '1px solid rgba(255,255,255,0.07)',
  boxShadow: [
    '4px 0 48px rgba(0,0,0,0.60)',
    'inset -1px 0 0 rgba(255,255,255,0.05)',
    'inset 0 1px 0 rgba(255,255,255,0.06)',
  ].join(', '),
};

const NAV_INACTIVE_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 14px',
  margin: '1px 8px',
  borderRadius: 10,
  color: 'rgba(255,255,255,0.55)',
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

  const BRAND_ADMIN_SECTIONS: NavSection[] = [
    {
      label: 'INTELLIGENCE',
      items: [
        { label: 'Dashboard',   path: '/',              icon: LayoutDashboard },
        { label: 'Brands',      path: '/brands',        icon: Shield },
        { label: 'Threats',     path: '/threats',        icon: Crosshair },
        { label: 'Apps',        path: '/apps',          icon: Smartphone },
        { label: 'Dark Web',    path: '/dark-web',      icon: EyeOff },
      ],
    },
    {
      label: 'RESPONSE',
      items: [
        { label: 'Takedowns',   path: '/admin/takedowns',  icon: Gavel },
        { label: 'Alerts',      path: '/alerts',           icon: Bell, badge: alertCount },
      ],
    },
    {
      label: 'SETTINGS',
      items: [
        { label: 'Organization', path: '/admin/users',  icon: Users },
      ],
    },
  ];

  const SUPER_ADMIN_SECTIONS: NavSection[] = [
    {
      label: 'INTELLIGENCE',
      items: [
        { label: 'Home',         path: '/',             icon: LayoutDashboard },
        { label: 'Observatory',  path: '/observatory',  icon: Globe },
        { label: 'Observatory v3', path: '/observatory-v3', icon: Globe },
        { label: 'Brands',       path: '/brands',       icon: Shield },
        { label: 'Apps',         path: '/apps',          icon: Smartphone },
        { label: 'Dark Web',     path: '/dark-web',      icon: EyeOff },
        { label: 'Providers',    path: '/providers',     icon: Server },
        { label: 'Operations',   path: '/campaigns',     icon: Activity },
        { label: 'Threat Actors', path: '/threat-actors', icon: Crosshair },
        { label: 'Intelligence', path: '/trends',        icon: TrendingUp },
      ],
    },
    {
      label: 'RESPONSE',
      items: [
        { label: 'Takedowns',    path: '/admin/takedowns',  icon: Gavel },
        { label: 'Alerts',       path: '/alerts',           icon: Bell, badge: alertCount },
        { label: 'Spam Trap',    path: '/admin/spam-trap',  icon: Inbox },
        { label: 'Leads',       path: '/leads',            icon: Target },
      ],
    },
    {
      label: 'PLATFORM',
      items: [
        { label: 'Agents',       path: '/agents',           icon: Cpu },
        { label: 'Feeds',        path: '/feeds',             icon: Rss },
        { label: 'Dashboard',    path: '/admin',             icon: LayoutDashboard },
        { label: 'Team', path: '/admin/users',       icon: Users },
        ...(isSuperAdmin ? [{ label: 'Organizations', path: '/admin/organizations', icon: Building2 }] : []),
        { label: 'Audit Log',    path: '/admin/audit',       icon: ClipboardList },
        ...(isSuperAdmin ? [{ label: 'Push Config', path: '/admin/push', icon: BellRing }] : []),
      ],
    },
  ];

  const NAV_SECTIONS = isBrandAdmin ? BRAND_ADMIN_SECTIONS : SUPER_ADMIN_SECTIONS;

  return (
    <aside className="w-56 h-full flex flex-col" style={SIDEBAR_CONTAINER_STYLE}>
      <div
        className="px-4 pt-4"
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          paddingBottom: 16,
          marginBottom: 8,
        }}
      >
        <AverrowLogo />
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
                  color: 'rgba(255,255,255,0.35)',
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
                  background: 'linear-gradient(90deg, rgba(255,255,255,0.08), transparent)',
                }}
              />
            </div>
            {section.items.map(item => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={onNavigate}
                  end
                  style={({ isActive }) => (isActive ? NAV_ACTIVE_STYLE : NAV_INACTIVE_STYLE)}
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        size={16}
                        style={{
                          flexShrink: 0,
                          color: isActive ? '#E5A832' : 'rgba(255,255,255,0.40)',
                          filter: isActive ? 'drop-shadow(0 0 4px rgba(229,168,50,0.60))' : undefined,
                        }}
                      />
                      <span>{item.label}</span>
                      {item.badge !== undefined && item.badge > 0 && (
                        <span className="ml-auto">
                          <Badge severity="critical" label={String(item.badge)} size="xs" />
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div
        style={{
          borderTop: '1px solid rgba(255,255,255,0.06)',
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
          style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontFamily: 'monospace' }}
        >
          {user?.email}
        </div>
        <button
          onClick={logout}
          className="mt-2 hover:text-accent transition-colors"
          style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.30)',
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
