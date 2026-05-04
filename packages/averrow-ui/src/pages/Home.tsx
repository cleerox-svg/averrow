import { useNavigate } from 'react-router-dom';
import { useMobile } from '@/components/mobile';
import { MobileCommandCenter } from '@/components/mobile/MobileCommandCenter';
import { useObservatoryStats } from '@/hooks/useObservatory';
import { useAlertStats } from '@/hooks/useAlerts';
import { useAgents } from '@/hooks/useAgents';
import { AGENT_LIST } from '@/lib/agent-metadata';
import { useBrandStats, useBrands } from '@/hooks/useBrands';
import { useFeedStats } from '@/hooks/useFeeds';
import { useOperationsStats } from '@/hooks/useOperations';
import { useNotifications } from '@/hooks/useNotifications';
import { useIntelligenceBriefings } from '@/hooks/useTrends';
import { useGeopoliticalCampaigns } from '@/hooks/useGeopoliticalCampaign';
import { useDailyBriefing } from '@/hooks/useDailyBriefing';
import { useIncidents } from '@/features/admin-incidents/useIncidents';
import { useAuth } from '@/lib/auth';
import { Card, StatCard, Avatar, Badge, SeverityDot } from '@/components/ui';
import { InstallAppBanner } from '@/components/InstallAppBanner';
import { PlatformStatusFlyout } from '@/components/PlatformStatusFlyout';
import { RefreshCw } from 'lucide-react';

// ── Latest Intel Feed ──────────────────────────────────────────────────
function LatestIntelFeed() {
  const { data } = useNotifications(true);
  const navigate = useNavigate();
  const items = data?.notifications?.slice(0, 5) ?? [];

  if (items.length === 0) {
    return (
      <div className="text-center py-6 text-white/30 font-mono text-xs">
        No recent intelligence events
      </div>
    );
  }

  const severityDot: Record<string, string> = {
    critical: 'bg-[#f87171]',
    high: 'bg-[#fb923c]',
    medium: 'bg-[#fbbf24]',
    low: 'bg-[#78A0C8]',
    info: 'bg-white/30',
  };

  return (
    <div className="space-y-1">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => item.link ? navigate(item.link) : navigate('/alerts')}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
            hover:bg-white/[0.03] transition-colors text-left group"
        >
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${severityDot[item.severity] ?? severityDot.info}`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white/80 truncate group-hover:text-white transition-colors">
              {item.title}
            </p>
            {item.message && (
              <p className="text-[10px] text-white/40 truncate mt-0.5">{item.message}</p>
            )}
          </div>
          <span className="text-[10px] text-white/30 font-mono flex-shrink-0">
            {formatTimeAgo(item.created_at)}
          </span>
        </button>
      ))}
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Home entry (mobile dispatch) ───────────────────────────────────────
export function Home() {
  const isMobile = useMobile();
  if (isMobile) return <MobileCommandCenter />;
  return <HomeDashboard />;
}

// ── Desktop: Executive Command Center ──────────────────────────────────
function HomeDashboard() {
  const navigate = useNavigate();

  // ── Data ──
  const { isSuperAdmin }       = useAuth();
  const { data: obsStats }     = useObservatoryStats();
  const { data: alertStats }   = useAlertStats();
  const { data: agents }       = useAgents();
  const { data: brandStats }   = useBrandStats();
  const { data: feedStats }    = useFeedStats();
  const { data: opsStats }     = useOperationsStats();
  const { data: topBrands }    = useBrands({ limit: 5 });
  const { data: geoCampaigns } = useGeopoliticalCampaigns('active');
  const { data: intelItems }   = useIntelligenceBriefings(5);
  const { refetch: refetchBriefing, isFetching: briefingLoading }
                               = useDailyBriefing();
  // Incidents are super_admin-gated — pass `enabled: isSuperAdmin`
  // so non-super-admins don't even fire the request.
  const { data: allIncidents } = useIncidents({ enabled: isSuperAdmin });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const safeAgents = Array.isArray(agents) ? agents : [];
  const agentsOnline = safeAgents.filter(
    a => a.status === 'healthy' || a.status === 'running' || a.status === 'active',
  ).length;

  const topBrandsList  = Array.isArray(topBrands)    ? topBrands    : [];
  const geoList        = Array.isArray(geoCampaigns) ? geoCampaigns : [];
  const intelList      = Array.isArray(intelItems)   ? intelItems   : [];

  const criticalCount = alertStats?.critical ?? 0;

  // Incidents shown on Home: anything still open + anything resolved
  // in the last 7 days. The section renders only for super_admins
  // and only when there's at least one row to show.
  const incidentList = Array.isArray(allIncidents) ? allIncidents : [];
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentIncidents = incidentList
    .filter((inc) => {
      if (inc.status !== 'resolved') return true;
      const resolvedAt = inc.resolved_at ? new Date(inc.resolved_at).getTime() : null;
      return resolvedAt !== null && resolvedAt >= sevenDaysAgo;
    })
    // Open first (alpha-sorted by status puts 'resolved' last
    // because it's lex-greater than the other states), then most-
    // recent within each bucket.
    .sort((a, b) => {
      const aOpen = a.status !== 'resolved' ? 0 : 1;
      const bOpen = b.status !== 'resolved' ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return b.created_at.localeCompare(a.created_at);
    })
    .slice(0, 6);

  return (
    <div style={{ padding: 0, maxWidth: '100%' }}>

      {/* PWA install affordance — captures beforeinstallprompt on
          Android Chrome / Edge, shows iOS Add-to-Home-Screen steps
          on Safari, hides itself when isStandalone() or after
          per-device dismiss. */}
      <div style={{ padding: '16px 32px 0' }}>
        <InstallAppBanner />
      </div>

      {/* ── Page header ─────────────────────────────────────────── */}
      <div style={{
        padding: '24px 32px 20px',
        borderBottom: '1px solid var(--border-base)',
      }}>
        <h1 style={{
          fontSize: 26, fontWeight: 900, color: 'var(--text-primary)',
          letterSpacing: -0.5, margin: 0,
        }}>
          {greeting}
        </h1>
        <div style={{
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)', marginTop: 4,
          letterSpacing: '0.08em',
        }}>
          {today}
        </div>
      </div>

      {/* Critical alerts banner — mirrors mobile. Only renders when
          criticalCount > 0; clicks navigate to /alerts. */}
      {criticalCount > 0 && (
        <div style={{ padding: '14px 32px 0' }}>
          <Card
            variant="critical"
            onClick={() => navigate('/alerts')}
            style={{
              padding: '12px 18px',
              display: 'flex', alignItems: 'center', gap: 12,
              cursor: 'pointer',
            }}
          >
            <SeverityDot severity="critical" size={9} pulse />
            <span style={{
              fontSize: 13, fontWeight: 700, color: '#fca5a5', flex: 1,
            }}>
              {criticalCount} critical alert{criticalCount === 1 ? '' : 's'} require{criticalCount === 1 ? 's' : ''} attention
            </span>
            <span style={{
              fontSize: 12, color: 'var(--amber)', fontWeight: 800,
              textShadow: '0 0 10px var(--amber-glow, rgba(229,168,50,0.5))',
              flexShrink: 0,
            }}>
              View →
            </span>
          </Card>
        </div>
      )}

      {/* Status bar — prominent live status, mirrors mobile.
          Click to expand a condensed availability breakdown for
          Feeds / Agents / Processing. Incidents intentionally
          excluded — operator wanted the flyout scoped to
          availability only. Full /status page linked from inside. */}
      <div style={{ padding: '12px 32px 0' }}>
        <PlatformStatusFlyout />
      </div>

      {/* ── Stat bar ──────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        // Six tiles to match mobile parity. auto-fit keeps the row
        // graceful at narrower widths (e.g. tablet portrait).
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 12, padding: '20px 32px',
        borderBottom: '1px solid var(--border-base)',
      }}>
        <StatCard
          label="Brands Monitored"
          value={brandStats?.total_tracked ?? 0}
          sublabel={`${brandStats?.new_this_week ?? 0} new this week`}
          accentColor="#E5A832"
        />
        <StatCard
          label="Threats Mapped · 7d"
          value={obsStats?.threats_mapped ?? 0}
          sublabel={`${obsStats?.countries ?? 0} countries`}
          accentColor="#C83C3C"
        />
        <StatCard
          label="Active Alerts"
          value={alertStats?.total ?? 0}
          sublabel={`${alertStats?.critical ?? 0} critical · ${alertStats?.new_count ?? 0} new`}
          accentColor="#fb923c"
        />
        <StatCard
          label="Agents Running"
          value={`${agentsOnline}/${safeAgents.length || AGENT_LIST.length}`}
          sublabel={`${safeAgents.filter(a => a.jobs_24h > 0).length} active · 24h`}
          accentColor="#0A8AB5"
        />
        <StatCard
          label="Feeds"
          value={feedStats?.active ?? 0}
          sublabel={`of ${(feedStats?.active ?? 0) + (feedStats?.disabled ?? 0)} active`}
          accentColor="#3CB878"
        />
        <StatCard
          label="Campaigns"
          value={opsStats?.campaigns_tracked ?? 0}
          sublabel={`${opsStats?.active_operations ?? 0} active ops`}
          accentColor="#0A8AB5"
        />
      </div>

      {/* ── Two-column body ─────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 380px',
        gap: 20,
        padding: '20px 32px 32px',
        alignItems: 'start',
      }}>

        {/* ── LEFT: Observer Briefing ─────────────────────────── */}
        <div>
          <Card variant="base" style={{ padding: '24px 28px', marginBottom: 16 }}>
            {/* Briefing header */}
            <div style={{
              display: 'flex', alignItems: 'flex-start',
              justifyContent: 'space-between', marginBottom: 20,
            }}>
              <div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
                }}>
                  <Badge status="active" label="Observer" size="xs" />
                  <span style={{
                    fontSize: 9, fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)', letterSpacing: '0.14em',
                  }}>
                    PLATFORM OPERATIONS BRIEFING
                  </span>
                </div>
                <h2 style={{
                  fontSize: 16, fontWeight: 900, color: 'var(--text-primary)',
                  margin: 0, letterSpacing: -0.2,
                }}>
                  Intelligence Summary
                </h2>
                {intelList[0] && (
                  <div style={{
                    fontSize: 10, fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)', marginTop: 4,
                  }}>
                    Latest {new Date(intelList[0].created_at).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </div>
                )}
              </div>
              <button
                onClick={() => refetchBriefing()}
                disabled={briefingLoading}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 8,
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid var(--border-base)',
                  color: 'var(--text-tertiary)',
                  fontSize: 10, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.10em', cursor: 'pointer',
                  textTransform: 'uppercase',
                  opacity: briefingLoading ? 0.5 : 1,
                }}
              >
                <RefreshCw size={11} style={{
                  animation: briefingLoading ? 'spin 0.6s linear infinite' : 'none',
                }} />
                Refresh
              </button>
            </div>

            {/* Observer intelligence briefing items */}
            {intelList.length === 0 ? (
              <div style={{
                textAlign: 'center', padding: '32px 0',
                color: 'var(--text-muted)', fontSize: 13,
                fontStyle: 'italic',
              }}>
                No briefing generated yet. Observer runs daily at 9am ET.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {intelList.slice(0, 4).map((item) => {
                  const sev = item.severity as 'critical' | 'high' | 'medium' | 'low' | 'info';
                  const borderColor =
                    sev === 'critical' ? 'var(--sev-critical)' :
                    sev === 'high'     ? 'var(--sev-high)' :
                    'var(--amber-border)';
                  const cleaned = item.summary
                    .replace(/\*\*/g, '')
                    .replace(/^##\s/gm, '')
                    .replace(/^#\s/gm, '');
                  return (
                    <div key={item.id} style={{
                      paddingLeft: 14,
                      borderLeft: `2px solid ${borderColor}`,
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center',
                        gap: 8, marginBottom: 5,
                      }}>
                        {sev === 'critical' || sev === 'high' ? (
                          <Badge severity={sev} size="xs" />
                        ) : (
                          <Badge status="active" size="xs" label="Info" />
                        )}
                        <span style={{
                          fontSize: 9, fontFamily: 'var(--font-mono)',
                          color: 'var(--text-muted)', letterSpacing: '0.12em',
                        }}>
                          {new Date(item.created_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <p style={{
                        fontSize: 13, lineHeight: 1.65,
                        color: 'var(--text-secondary)', margin: 0,
                      }}>
                        {cleaned.slice(0, 280)}
                        {cleaned.length > 280 && (
                          <button
                            onClick={() => navigate('/trends')}
                            style={{
                              background: 'none', border: 'none',
                              color: 'var(--amber)', cursor: 'pointer',
                              fontSize: 12, fontWeight: 700,
                              padding: '0 4px',
                            }}
                          >
                            ... read more →
                          </button>
                        )}
                      </p>
                    </div>
                  );
                })}

                <button
                  onClick={() => navigate('/trends')}
                  style={{
                    alignSelf: 'flex-start',
                    fontSize: 10, fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.10em', color: 'var(--amber)',
                    background: 'none', border: 'none',
                    cursor: 'pointer', padding: '4px 0',
                    textTransform: 'uppercase',
                  }}
                >
                  View all intelligence →
                </button>
              </div>
            )}
          </Card>

          {/* 24h Threat Ticker */}
          <Card variant="base" style={{ padding: '16px 20px' }}>
            <div style={{
              display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', marginBottom: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SeverityDot severity="critical" size={7} pulse />
                <span style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.20em', color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                }}>
                  Latest Intelligence
                </span>
              </div>
              <span style={{
                fontSize: 9, fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
              }}>
                Powered by Observer
              </span>
            </div>
            <LatestIntelFeed />
          </Card>
        </div>

        {/* ── RIGHT: Platform Status ──────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Incidents — open + last-7d resolved. Super_admin only;
              auto-hides when there's nothing to show. */}
          {isSuperAdmin && recentIncidents.length > 0 && (
            <Card variant="base" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px 10px',
                borderBottom: '1px solid var(--border-base)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 2, height: 14, borderRadius: 99,
                    background: 'linear-gradient(180deg, var(--amber), transparent)',
                  }} />
                  <span style={{
                    fontSize: 9, fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.20em', color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                  }}>
                    Incidents
                  </span>
                </div>
                <button
                  onClick={() => navigate('/admin/incidents')}
                  style={{
                    fontSize: 11, color: 'var(--amber)', cursor: 'pointer',
                    fontWeight: 700, background: 'none', border: 'none',
                    textShadow: '0 0 10px var(--amber-glow)',
                  }}
                >
                  View all →
                </button>
              </div>

              {recentIncidents.map((inc, i) => {
                const isOpen = inc.status !== 'resolved';
                const sev = inc.severity as 'critical' | 'high' | 'medium' | 'low' | 'info';
                const statusBg =
                  isOpen ? 'rgba(248,113,113,0.10)' : 'rgba(34,197,94,0.10)';
                const statusColor =
                  inc.status === 'resolved'    ? '#22c55e' :
                  inc.status === 'monitoring'  ? '#fbbf24' :
                  inc.status === 'identified'  ? '#fb923c' :
                  '#f87171';
                return (
                  <div
                    key={inc.id}
                    onClick={() => navigate(`/admin/incidents/${inc.id}`)}
                    style={{
                      padding: '12px 16px',
                      borderTop: i > 0 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                      display: 'flex', alignItems: 'center', gap: 10,
                      cursor: 'pointer',
                      transition: 'var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(229,168,50,0.04)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Badge severity={sev} size="xs" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 700,
                        color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {inc.title}
                      </div>
                      <div style={{
                        fontSize: 10, color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)',
                      }}>
                        {formatTimeAgo(isOpen ? inc.created_at : (inc.resolved_at ?? inc.created_at))}
                        {isOpen ? '' : ' · resolved'}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 9, fontFamily: 'var(--font-mono)',
                      fontWeight: 700, letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      padding: '3px 8px', borderRadius: 100,
                      background: statusBg, color: statusColor,
                      flexShrink: 0,
                    }}>
                      {inc.status}
                    </span>
                  </div>
                );
              })}
            </Card>
          )}

          {/* Brands at Risk */}
          <Card variant="base" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{
              display: 'flex', alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 16px 10px',
              borderBottom: '1px solid var(--border-base)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 2, height: 14, borderRadius: 99,
                  background: 'linear-gradient(180deg, var(--amber), transparent)',
                }} />
                <span style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.20em', color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                }}>
                  Brands at Risk
                </span>
              </div>
              <button
                onClick={() => navigate('/brands')}
                style={{
                  fontSize: 11, color: 'var(--amber)', cursor: 'pointer',
                  fontWeight: 700, background: 'none', border: 'none',
                  textShadow: '0 0 10px var(--amber-glow)',
                }}
              >
                View all →
              </button>
            </div>

            {topBrandsList.slice(0, 5).map((brand, i) => {
              const tc = brand.threat_count ?? 0;
              const sev: 'critical' | 'high' | 'medium' =
                tc > 1000 ? 'critical' : tc > 200 ? 'high' : 'medium';
              return (
                <div
                  key={brand.id}
                  onClick={() => navigate(`/brands/${brand.id}`)}
                  style={{
                    padding: '12px 16px',
                    borderTop: i > 0 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                    display: 'flex', alignItems: 'center', gap: 10,
                    cursor: 'pointer',
                    transition: 'var(--transition-fast)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(229,168,50,0.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <Avatar
                    name={brand.name}
                    size={34}
                    radius={10}
                    color={tc > 1000 ? '#C83C3C' : '#B8821F'}
                    faviconUrl={brand.canonical_domain
                      ? `https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=32`
                      : undefined}
                    severity={sev}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 700,
                      color: 'var(--text-primary)',
                    }}>
                      {brand.name}
                    </div>
                    <div style={{
                      fontSize: 10, color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                    }}>
                      {brand.canonical_domain}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 14, fontWeight: 900,
                    fontFamily: 'var(--font-mono)',
                    color: tc > 1000 ? 'var(--sev-critical)' : 'var(--amber)',
                    textShadow: '0 0 10px currentColor',
                    flexShrink: 0,
                  }}>
                    {tc.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </Card>

          {/* Geopolitical Watch */}
          {geoList.length > 0 && (
            <Card variant="critical" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{
                padding: '14px 16px 10px',
                borderBottom: '1px solid var(--red-border)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <SeverityDot severity="critical" size={7} pulse />
                <span style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.20em', color: 'var(--sev-critical)',
                  textTransform: 'uppercase',
                }}>
                  Geopolitical Watch
                </span>
              </div>

              {geoList.slice(0, 3).map((campaign, i) => (
                <div
                  key={campaign.id}
                  onClick={() => navigate(`/campaigns/geo/${campaign.id}`)}
                  style={{
                    padding: '12px 16px',
                    borderTop: i > 0 ? '1px solid rgba(200,60,60,0.12)' : 'none',
                    cursor: 'pointer',
                    transition: 'var(--transition-fast)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(200,60,60,0.06)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', marginBottom: 4, gap: 8,
                  }}>
                    <div style={{
                      fontSize: 12, fontWeight: 700,
                      color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', minWidth: 0, flex: 1,
                    }}>
                      {campaign.name}
                    </div>
                    <Badge status="active" label="Active" size="xs" />
                  </div>
                  {campaign.conflict && (
                    <div style={{
                      fontSize: 10, color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                    }}>
                      {campaign.conflict}
                    </div>
                  )}
                </div>
              ))}

              <div
                onClick={() => navigate('/campaigns')}
                style={{
                  padding: '10px 16px',
                  borderTop: '1px solid rgba(200,60,60,0.12)',
                  fontSize: 10, fontFamily: 'var(--font-mono)',
                  color: 'var(--sev-high)', cursor: 'pointer',
                  letterSpacing: '0.10em', textTransform: 'uppercase',
                  textAlign: 'center',
                }}
              >
                View all operations →
              </div>
            </Card>
          )}

          {/* Quick nav shortcuts */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          }}>
            {[
              { icon: '🌐', label: 'Observatory',   path: '/observatory',      sub: 'Global threat map' },
              { icon: '🎯', label: 'Threat Actors', path: '/threat-actors',    sub: 'Adversary profiles' },
              { icon: '⚖️', label: 'Takedowns',     path: '/admin/takedowns',  sub: 'Active requests' },
              { icon: '📡', label: 'Feeds',         path: '/feeds',            sub: 'Ingestion health' },
            ].map(item => (
              <Card
                key={item.path}
                variant="base"
                onClick={() => navigate(item.path)}
                style={{ padding: '12px 14px', cursor: 'pointer' }}
              >
                <div style={{ fontSize: 20, marginBottom: 6 }}>{item.icon}</div>
                <div style={{
                  fontSize: 12, fontWeight: 700,
                  color: 'var(--text-primary)',
                }}>
                  {item.label}
                </div>
                <div style={{
                  fontSize: 10, color: 'var(--text-muted)', marginTop: 2,
                }}>
                  {item.sub}
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
