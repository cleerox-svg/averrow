// Averrow — MobileNav with More menu
// Fixed bottom navigation for mobile.
// "More" opens a full-screen panel with all platform modules.

import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useUnreadCount } from '@/hooks/useNotifications';
import { useAuth } from '@/lib/auth';
import { useObservatoryVersion, useVersionToggle } from '@/design-system/hooks';
import { LogOut } from 'lucide-react';

const AMBER   = '#E5A832';
const RED     = '#C83C3C';
const RED_DIM = '#8B1A1A';

interface NavItem {
  id:     string;
  icon:   string;
  label:  string;
  path:   string;
  exact?: boolean;
}

function buildNavItems(observatoryPath: string): NavItem[] {
  return [
    { id: 'home',   icon: '🏠', label: 'Home',   path: '/',                  exact: true },
    { id: 'obs',    icon: '🌐', label: 'Map',    path: observatoryPath },
    { id: 'brands', icon: '🛡', label: 'Brands', path: '/brands' },
    { id: 'alerts', icon: '🔔', label: 'Alerts', path: '/alerts' },
  ];
}

function buildMoreSections(observatoryPath: string, agentsPath: string, feedsPath: string) {
  return [
  {
    label: 'Intelligence',
    items: [
      { icon: '🌐', label: 'Observatory',    path: observatoryPath },
      { icon: '🛡', label: 'Brands',        path: '/brands' },
      { icon: '📱', label: 'Apps',          path: '/apps' },
      { icon: '🕶', label: 'Dark Web',      path: '/dark-web' },
      { icon: '⚡', label: 'Threats',       path: '/threats' },
      { icon: '🏭', label: 'Providers',     path: '/providers' },
      { icon: '🗺', label: 'Operations',    path: '/campaigns' },
      { icon: '🎯', label: 'Threat Actors', path: '/threat-actors' },
      { icon: '📈', label: 'Intelligence',  path: '/trends' },
    ],
  },
  {
    label: 'Response',
    items: [
      { icon: '⚖️', label: 'Takedowns', path: '/admin/takedowns' },
      { icon: '🔔', label: 'Alerts',    path: '/alerts' },
      { icon: '📬', label: 'Spam Trap', path: '/admin/spam-trap' },
      { icon: '🎯', label: 'Leads',     path: '/leads' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { icon: '🤖', label: 'Agents',    path: agentsPath },
      { icon: '📡', label: 'Feeds',     path: feedsPath },
      { icon: '📈', label: 'Metrics',   path: '/admin/metrics' },
      { icon: '📊', label: 'Dashboard', path: '/admin' },
      { icon: '👥', label: 'Team',      path: '/admin/users' },
      { icon: '📋', label: 'Audit Log', path: '/admin/audit' },
    ],
  },
  {
    label: 'Account',
    items: [
      { icon: '👤', label: 'Profile & Settings', path: '/profile' },
      { icon: '🔔', label: 'Notifications', path: '/notifications' },
    ],
  },
  ];
}

export function MobileNav() {
  const navigate      = useNavigate();
  const location      = useLocation();
  const { isSuperAdmin, logout } = useAuth();
  const { data: unreadData } = useUnreadCount();
  const { path: observatoryPath } = useObservatoryVersion();
  const { path: agentsPath } = useVersionToggle('agents');
  const { path: feedsPath }  = useVersionToggle('feeds');
  const [showMore, setShowMore]   = useState(false);

  const NAV_ITEMS = buildNavItems(observatoryPath);

  const unreadCount = typeof unreadData === 'number'
    ? unreadData
    : (unreadData as any)?.count ?? 0;

  function isActive(item: NavItem): boolean {
    if (item.exact) return location.pathname === item.path;
    // Observatory entry should highlight on either /observatory or /observatory-v3
    if (item.id === 'obs') {
      return location.pathname.startsWith('/observatory');
    }
    return location.pathname.startsWith(item.path);
  }

  const moreIsActive = showMore || (
    !NAV_ITEMS.some(i => isActive(i))
  );

  function handleNavigate(path: string) {
    setShowMore(false);
    navigate(path);
  }

  // Add Organizations for super admins only
  const sections = buildMoreSections(observatoryPath, agentsPath, feedsPath).map(s =>
    s.label === 'Platform' && isSuperAdmin
      ? {
          ...s,
          items: [
            ...s.items,
            { icon: '🏢', label: 'Organizations', path: '/admin/organizations' },
          ],
        }
      : s
  );

  return (
    <>
      {/* ── More Panel — full screen overlay ── */}
      {showMore && (
        <div
          style={{
            position:             'fixed',
            inset:                0,
            zIndex:               'var(--z-modal)' as any,
            background:           'var(--bg-page)',
            backdropFilter:       'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            overflowY:            'auto',
            paddingBottom:        100,
          }}
        >
          {/* Header */}
          <div style={{
            padding:       '20px 20px 16px',
            borderBottom:  '1px solid var(--border-base)',
            display:       'flex',
            alignItems:    'center',
            justifyContent: 'space-between',
          }}>
            <div>
              <div style={{
                fontSize: 9, fontFamily: 'var(--font-mono)',
                letterSpacing: '0.22em', color: 'var(--amber)',
                marginBottom: 4,
              }}>
                AVERROW
              </div>
              <div style={{
                fontSize: 18, fontWeight: 900,
                color: 'var(--text-primary)',
              }}>
                All Modules
              </div>
            </div>
            <button
              onClick={() => setShowMore(false)}
              style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'var(--border-base)',
                border:     '1px solid var(--border-base)',
                color:      'var(--text-secondary)',
                fontSize:   18, cursor: 'pointer',
                display:    'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              ✕
            </button>
          </div>

          {/* Navigation sections */}
          {sections.map(section => (
            <div key={section.label} style={{ padding: '16px 16px 8px' }}>
              {/* Section label */}
              <div style={{
                display: 'flex', alignItems: 'center',
                gap: 8, marginBottom: 10,
              }}>
                <span style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.22em', color: 'var(--text-tertiary)',
                  textTransform: 'uppercase', fontWeight: 700,
                }}>
                  {section.label}
                </span>
                <div style={{
                  flex: 1, height: 1,
                  background: 'linear-gradient(90deg, var(--border-base), transparent)',
                }} />
              </div>

              {/* 2-column grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 8,
              }}>
                {section.items.map(item => (
                  <button
                    key={item.path}
                    onClick={() => handleNavigate(item.path)}
                    style={{
                      padding:      '14px',
                      borderRadius: 12,
                      background:   'linear-gradient(160deg, var(--bg-card), var(--bg-card-deep))',
                      border:       '1px solid var(--border-base)',
                      boxShadow: [
                        'inset 0 1px 0 var(--border-strong)',
                        'inset 0 -1px 0 var(--border-base)',
                      ].join(', '),
                      display:    'flex',
                      alignItems: 'center',
                      gap:        10,
                      cursor:     'pointer',
                      textAlign:  'left',
                      transition: 'var(--transition-fast)',
                    }}
                  >
                    <span style={{ fontSize: 20 }}>{item.icon}</span>
                    <span style={{
                      fontSize:   13,
                      fontWeight: 600,
                      color:      'var(--text-primary)',
                    }}>
                      {item.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* Logout */}
          <div style={{ padding: '8px 16px 16px' }}>
            <button
              onClick={() => { setShowMore(false); void logout(); }}
              style={{
                width:        '100%',
                padding:      '13px',
                borderRadius: 12,
                background:   'linear-gradient(135deg, rgba(200,60,60,0.12), rgba(139,26,26,0.08))',
                border:       '1px solid var(--red-border)',
                color:        'var(--sev-critical)',
                fontSize:     12,
                fontWeight:   700,
                fontFamily:   'var(--font-mono)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor:       'pointer',
                display:      'flex',
                alignItems:   'center',
                justifyContent: 'center',
                gap:          8,
              }}
            >
              <LogOut size={14} />
              Logout
            </button>
          </div>
        </div>
      )}

      {/* ── Bottom Nav Bar ── */}
      <div style={{
        position:             'fixed',
        bottom:               0,
        left:                 0,
        right:                0,
        zIndex:               'var(--z-sidebar)' as any,
        background:           'var(--bg-sidebar)',
        backdropFilter:       'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderTop:            '1px solid var(--border-base)',
        boxShadow:            'var(--card-shadow), inset 0 1px 0 var(--border-base)',
        display:              'flex',
        justifyContent:       'space-around',
        alignItems:           'center',
        padding:              '10px 0 env(safe-area-inset-bottom, 16px)',
      }}>
        {/* Main 4 nav items */}
        {NAV_ITEMS.map(item => {
          const active    = isActive(item) && !showMore;
          const showBadge = item.id === 'alerts' && unreadCount > 0;

          return (
            <button
              key={item.id}
              onClick={() => { setShowMore(false); navigate(item.path); }}
              style={{
                display:       'flex',
                flexDirection: 'column',
                alignItems:    'center',
                gap:           3,
                cursor:        'pointer',
                position:      'relative',
                padding:       '4px 14px',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {showBadge && (
                <div style={{
                  position:     'absolute',
                  top:          0,
                  right:        6,
                  minWidth:     16,
                  height:       16,
                  borderRadius: '50%',
                  background:   `linear-gradient(135deg, ${RED}, ${RED_DIM})`,
                  border:       '2px solid var(--bg-sidebar)',
                  fontSize:     8,
                  fontWeight:   900,
                  color:        '#fff',
                  display:      'flex',
                  alignItems:   'center',
                  justifyContent: 'center',
                  fontFamily:   'monospace',
                  boxShadow:    `0 2px 8px ${RED}60`,
                  padding:      '0 2px',
                }}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </div>
              )}
              <span style={{
                fontSize:   22,
                filter:     active ? `drop-shadow(0 0 6px ${AMBER}80)` : 'none',
                transition: 'filter 0.15s ease',
              }}>
                {item.icon}
              </span>
              <span style={{
                fontSize:      9,
                fontFamily:    'monospace',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color:         active ? AMBER : 'var(--text-muted)',
                textShadow:    active ? `0 0 10px ${AMBER}60` : 'none',
                transition:    'color 0.15s ease',
              }}>
                {item.label}
              </span>
              {active && (
                <div style={{
                  position:     'absolute',
                  bottom:       0,
                  left:         '50%',
                  transform:    'translateX(-50%)',
                  width:        24,
                  height:       2,
                  borderRadius: 99,
                  background:   `linear-gradient(90deg, transparent, ${AMBER}, transparent)`,
                  boxShadow:    `0 0 8px ${AMBER}`,
                }} />
              )}
            </button>
          );
        })}

        {/* More button */}
        <button
          onClick={() => setShowMore(!showMore)}
          style={{
            display:       'flex',
            flexDirection: 'column',
            alignItems:    'center',
            gap:           3,
            cursor:        'pointer',
            position:      'relative',
            padding:       '4px 14px',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <span style={{
            fontSize:   22,
            filter:     moreIsActive ? `drop-shadow(0 0 6px ${AMBER}80)` : 'none',
            transition: 'filter 0.15s ease',
          }}>
            ☰
          </span>
          <span style={{
            fontSize:      9,
            fontFamily:    'monospace',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color:         moreIsActive ? AMBER : 'var(--text-muted)',
            textShadow:    moreIsActive ? `0 0 10px ${AMBER}60` : 'none',
            transition:    'color 0.15s ease',
          }}>
            More
          </span>
          {moreIsActive && (
            <div style={{
              position:     'absolute',
              bottom:       0,
              left:         '50%',
              transform:    'translateX(-50%)',
              width:        24,
              height:       2,
              borderRadius: 99,
              background:   `linear-gradient(90deg, transparent, ${AMBER}, transparent)`,
              boxShadow:    `0 0 8px ${AMBER}`,
            }} />
          )}
        </button>
      </div>
    </>
  );
}
