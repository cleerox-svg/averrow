import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  M, SEV, DeepCard, StatTile, SevChip, GradeBadge,
} from './MobileUIKit';
import { DimensionalAvatar } from '@/components/ui/DimensionalAvatar';

import { useAuth } from '@/lib/auth';
import { parseInitials, SELF_AVATAR_COLOR } from '@/lib/avatar';
import { useBrands, useBrandStats } from '@/hooks/useBrands';
import { useObservatoryStats } from '@/hooks/useObservatory';
import { useAlertStats } from '@/hooks/useAlerts';
import { useAgents } from '@/hooks/useAgents';
import { useFeedStats } from '@/hooks/useFeeds';
import { useOperationsStats } from '@/hooks/useOperations';
import { useNotifications } from '@/hooks/useNotifications';
import { NotificationBell } from '@/components/NotificationBell';
import { PlatformStatusBadge } from '@/components/PlatformStatusBadge';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const BRAND_COLORS = [
  { color: M.RED,     dimColor: M.RED_DIM },
  { color: '#fb923c', dimColor: '#7c2d12' },
  { color: '#fbbf24', dimColor: '#78350f' },
];

export function MobileCommandCenter() {
  const navigate = useNavigate();
  const { user } = useAuth();

  // Greet by first word of display_name; falls back to "there" if
  // we don't have a name yet (e.g. first paint before /me settles).
  const firstName = (user?.display_name ?? user?.name ?? '').trim().split(/\s+/)[0] || 'there';
  const initials = parseInitials(user?.display_name ?? user?.name, user?.email);

  const { data: brandStats }  = useBrandStats();
  const { data: obsStats }    = useObservatoryStats();
  const { data: alertStats }  = useAlertStats();
  const { data: agentData }   = useAgents();
  const { data: feedStats }   = useFeedStats();
  const { data: opsStats }    = useOperationsStats();
  const { data: brandsData }  = useBrands({ view: 'top', limit: 10 });
  const { data: notifData }   = useNotifications(true);

  const [intelFilter, setIntelFilter] = useState<string>('all');

  const notifications = Array.isArray(notifData?.notifications)
    ? notifData!.notifications
    : [];

  const filteredIntel = (intelFilter === 'all'
    ? notifications
    : notifications.filter((n: any) => n.severity === intelFilter)
  ).slice(0, 5);

  const agents       = Array.isArray(agentData) ? agentData : [];
  const criticalCount = alertStats?.critical ?? 0;

  const topBrands = [...(brandsData ?? [])]
    .sort((a, b) => (b.threat_count ?? 0) - (a.threat_count ?? 0))
    .slice(0, 3);

  const lastScan = agents
    .filter((a) => a.last_run_at)
    .sort((a, b) => new Date(b.last_run_at!).getTime() - new Date(a.last_run_at!).getTime())[0]?.last_run_at;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-page)', fontFamily: 'system-ui,-apple-system,sans-serif', color: 'var(--text-primary)', overflowX: 'hidden' }}>
      <style>{`
        @keyframes mcc-ping { 75%,100%{transform:scale(2.2);opacity:0} }
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        ::-webkit-scrollbar{display:none}
        button{outline:none;border:none;background:none}
      `}</style>

      <div style={{ position:'fixed', top:-120, left:-80, width:420, height:420, borderRadius:'50%', background:'rgba(10,37,64,0.40)', filter:'blur(120px)', pointerEvents:'none', zIndex:0 }} />
      <div style={{ position:'fixed', bottom:-140, right:-80, width:380, height:380, borderRadius:'50%', background:'rgba(229,168,50,0.06)', filter:'blur(140px)', pointerEvents:'none', zIndex:0 }} />
      <div style={{ position:'fixed', inset:0, opacity:0.02, backgroundImage:'linear-gradient(rgba(255,255,255,0.15) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.15) 1px,transparent 1px)', backgroundSize:'60px 60px', pointerEvents:'none', zIndex:0 }} />

      <div style={{ position:'relative', zIndex:1 }}>

        {/* HEADER */}
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', padding:'22px 20px 0' }}>
          <div>
            <div style={{ fontSize:9, fontFamily:'monospace', letterSpacing:'0.22em', color:M.AMBER, marginBottom:5, textShadow:`0 0 12px ${M.AMBER}60` }}>
              AVERROW · COMMAND CENTER
            </div>
            <div style={{ fontSize:22, fontWeight:900, lineHeight:1.1, letterSpacing:-0.8 }}>
              {greeting},{' '}
              <span style={{ color:M.AMBER, textShadow:`0 0 20px ${M.AMBER}50` }}>{firstName}</span>
            </div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:5 }}>
              {new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })}
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10, paddingTop:4 }}>
            <div style={{ display:'flex', alignItems:'center', gap:5 }}>
              <div style={{ position:'relative', width:8, height:8 }}>
                <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:'#4ade80', opacity:0.65, animation:'mcc-ping 1.6s ease-in-out infinite' }} />
                <div style={{ position:'relative', width:8, height:8, borderRadius:'50%', background:'#22c55e', boxShadow:'0 0 8px rgba(34,197,94,0.8)' }} />
              </div>
              <span style={{ fontSize:8, fontFamily:'monospace', color:'var(--text-muted)', letterSpacing:'0.18em' }}>LIVE</span>
            </div>
            <NotificationBell />
            {/* Profile pill — taps to /v2/profile. Uses the
                standardized initials-only-amber rule (lib/avatar.ts);
                replaces the previous static "CL" red gradient div
                that wasn't wired to anything. */}
            <button
              type="button"
              onClick={() => navigate('/profile')}
              aria-label={`Open profile — ${user?.display_name ?? user?.name ?? user?.email ?? 'user'}`}
              style={{
                width: 36, height: 36, borderRadius: 11,
                background: SELF_AVATAR_COLOR,
                color: 'var(--text-on-amber, #0A0F1E)',
                border: '1px solid rgba(255,255,255,0.20)',
                boxShadow: '0 4px 14px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -1px 0 rgba(0,0,0,0.30)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 900,
                cursor: 'pointer', padding: 0,
              }}
            >
              {initials}
            </button>
          </div>
        </div>

        {/* CRITICAL BANNER */}
        {criticalCount > 0 && (
          <div style={{ padding:'14px 20px 0' }}>
            <DeepCard variant="critical" onClick={() => navigate('/alerts')} style={{ padding:'11px 16px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ position:'relative', width:8, height:8, flexShrink:0 }}>
                  <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:'#f87171', opacity:0.7, animation:'mcc-ping 1.8s ease-in-out infinite' }} />
                  <div style={{ width:8, height:8, borderRadius:'50%', background:'#f87171', boxShadow:'0 0 8px rgba(248,113,113,0.9)' }} />
                </div>
                <span style={{ fontSize:12, fontWeight:700, color:'#fca5a5', flex:1 }}>
                  {criticalCount} critical alert{criticalCount !== 1 ? 's' : ''} require{criticalCount === 1 ? 's' : ''} attention
                </span>
                <span style={{ fontSize:12, color:M.AMBER, fontWeight:800, textShadow:`0 0 10px ${M.AMBER}80`, flexShrink:0 }}>View →</span>
              </div>
            </DeepCard>
          </div>
        )}

        {/* STATUS BAR — live from /api/v1/public/platform-status */}
        <div style={{ padding:'10px 20px 0' }}>
          <DeepCard variant="base" style={{ padding:'11px 16px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <PlatformStatusBadge variant="prominent" />
            <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'monospace' }}>
              {lastScan ? `Scan: ${timeAgo(lastScan)}` : 'Scanning...'}
            </span>
          </DeepCard>
        </div>

        {/* STAT GRID */}
        <div style={{ padding:'14px 20px 0', display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          <StatTile label="Brands"  value={brandStats?.total_tracked ?? 0}  sub={`${brandStats?.new_this_week ?? 0} new this week`} accent={M.AMBER} onClick={() => navigate('/brands')} />
          <StatTile label="Threats · 7d" value={obsStats?.threats_mapped ?? 0}    sub={`${obsStats?.countries ?? 0} countries`}           accent={M.RED}   onClick={() => navigate('/threats')} />
          <StatTile label="Alerts"  value={alertStats?.total ?? 0}           sub={`${criticalCount} critical · ${alertStats?.new_count ?? 0} new`}                       accent={M.RED}   critical={criticalCount} onClick={() => navigate('/alerts')} />
          {/* Agents — headline shows registered count (the platform's
              configured fleet size), sub shows runtime status. The
              previous version put runtime-running count as the headline
              with "of N online" sub, which read as "13 are offline" when
              really 13 are just idle between scheduled runs. */}
          <StatTile
            label="Agents"
            value={agents.length || 0}
            sub={(() => {
              const running = agents.filter((a) => a.status === 'healthy' || a.status === 'running' || a.status === 'active').length;
              const errored = agents.filter((a) => a.status === 'error' || a.status === 'failed' || a.status === 'paused').length;
              if (errored > 0) return `${running} running · ${errored} paused`;
              return `${running} running`;
            })()}
            accent={M.BLUE}
            onClick={() => navigate('/agents')}
          />
          <StatTile label="Feeds"   value={feedStats?.active ?? 0}           sub={`of ${((feedStats?.active ?? 0) + (feedStats?.disabled ?? 0)) || 34} active`}             accent={M.GREEN} onClick={() => navigate('/feeds')} />
          {/* Campaigns — headline is the registered count (matches the
              tile label), sub shows the live active-ops slice. The
              previous version flipped these, so the headline read as a
              count of active operations under a "Campaigns" label. */}
          <StatTile
            label="Campaigns"
            value={opsStats?.campaigns_tracked ?? 0}
            sub={`${opsStats?.active_operations ?? 0} active ops`}
            accent={M.BLUE}
            onClick={() => navigate('/campaigns')}
          />
        </div>

        {/* BRANDS AT RISK */}
        {topBrands.length > 0 && (
          <div style={{ padding:'18px 20px 0' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:11 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ width:2, height:14, borderRadius:99, background:`linear-gradient(180deg,${M.AMBER},transparent)` }} />
                <span style={{ fontSize:9, fontFamily:'monospace', letterSpacing:'0.20em', color:'var(--text-tertiary)', textTransform:'uppercase' }}>Brands at Risk</span>
              </div>
              <span onClick={() => navigate('/brands')} style={{ fontSize:11, color:M.AMBER, cursor:'pointer', fontWeight:700, textShadow:`0 0 10px ${M.AMBER}60` }}>View all →</span>
            </div>
            <DeepCard variant="base" style={{ padding:0, overflow:'hidden' }}>
              {topBrands.map((brand, i) => {
                const c = BRAND_COLORS[i] ?? BRAND_COLORS[0];
                const tc = brand.threat_count ?? 0;
                const sevKey = tc > 30 ? 'critical' : tc > 15 ? 'high' : 'medium';
                return (
                  <div key={brand.id} onClick={() => navigate(`/brands/${brand.id}`)} style={{ padding:'14px 16px', borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none', display:'flex', alignItems:'center', gap:12, cursor:'pointer', borderLeft:`2px solid ${c.color}60`, background: i === 0 ? `linear-gradient(90deg,${c.color}08,transparent 50%)` : 'transparent' }}>
                    <DimensionalAvatar
                      name={brand.name}
                      color={c.color}
                      dimColor={c.dimColor}
                      faviconUrl={brand.canonical_domain
                        ? `https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=32`
                        : undefined}
                      severity={sevKey}
                    />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:700, color:'var(--text-primary)' }}>{brand.name}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2, fontFamily:'monospace' }}>{brand.canonical_domain}</div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:5, flexShrink:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ fontSize:16, fontWeight:900, fontFamily:'monospace', color:c.color, textShadow:`0 0 12px ${c.color}70` }}>{tc}</span>
                        <SevChip severity={sevKey} />
                      </div>
                      <GradeBadge grade={brand.email_security_grade} />
                    </div>
                  </div>
                );
              })}
            </DeepCard>
          </div>
        )}

        {/* ── LATEST INTELLIGENCE ── */}
        <div style={{ padding:'18px 20px 0' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <div style={{ width:2, height:14, borderRadius:99, background:`linear-gradient(180deg,${M.BLUE},transparent)` }} />
              <span style={{ fontSize:9, fontFamily:'monospace', letterSpacing:'0.20em', color:'var(--text-tertiary)', textTransform:'uppercase' }}>Latest Intelligence</span>
            </div>
            <span style={{ fontSize:9, color:'var(--text-muted)', fontFamily:'monospace' }}>Powered by Observer</span>
          </div>

          {/* Filter pills */}
          <div style={{ display:'flex', gap:6, marginBottom:12, overflowX:'auto' }}>
            {['all','critical','high','medium','low'].map(f => {
              const active = intelFilter === f;
              const s = SEV[f];
              return (
                <button key={f} onClick={() => setIntelFilter(f)} style={{
                  flexShrink:0, padding:'5px 13px', borderRadius:99,
                  fontSize:9, fontFamily:'monospace', cursor:'pointer',
                  textTransform:'uppercase', letterSpacing:'0.12em',
                  border:`1px solid ${active ? (s?.border ?? 'rgba(229,168,50,0.35)') : 'rgba(255,255,255,0.08)'}`,
                  backgroundColor: active ? (s?.bg ?? 'rgba(229,168,50,0.12)') : 'rgba(255,255,255,0.03)',
                  color: active ? (s?.text ?? M.AMBER) : 'var(--text-tertiary)',
                  boxShadow: active ? `inset 0 1px 0 ${s?.dot ?? M.AMBER}30` : 'none',
                }}>
                  {f}
                </button>
              );
            })}
          </div>

          <DeepCard variant="base" style={{ padding:0, overflow:'hidden' }}>
            {filteredIntel.length === 0 ? (
              <div style={{ padding:'20px 16px', textAlign:'center', color:'var(--text-muted)', fontSize:12 }}>
                No {intelFilter !== 'all' ? intelFilter + ' ' : ''}alerts
              </div>
            ) : filteredIntel.map((item: any, i: number) => {
              const s = SEV[item.severity] ?? SEV.low;
              return (
                <div key={item.id} onClick={() => navigate('/alerts')} style={{
                  padding:'13px 16px',
                  borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  display:'flex', alignItems:'flex-start', gap:10, cursor:'pointer',
                  borderLeft:`2px solid ${s.dot}70`,
                  background:`linear-gradient(90deg,${s.dot}08,transparent 40%)`,
                }}>
                  <div style={{ width:8, height:8, borderRadius:'50%', marginTop:4, flexShrink:0, background:s.dot, boxShadow:`0 0 8px ${s.dot}80` }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)', lineHeight:1.4 }}>
                      {item.title}
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:5 }}>
                      <span style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'monospace' }}>
                        {timeAgo(item.created_at)}
                      </span>
                      {item.brand_name && (
                        <>
                          <span style={{ width:2, height:2, borderRadius:'50%', background:'rgba(255,255,255,0.18)' }} />
                          <span style={{ fontSize:10, color:'var(--text-tertiary)' }}>{item.brand_name}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <span style={{ fontSize:18, color:'var(--text-muted)', flexShrink:0, paddingTop:1 }}>›</span>
                </div>
              );
            })}
          </DeepCard>
        </div>

        {/* ── QUICK ACTIONS ── */}
        <div style={{ padding:'18px 20px 0' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
            <div style={{ width:2, height:14, borderRadius:99, background:`linear-gradient(180deg,${M.GREEN},transparent)` }} />
            <span style={{ fontSize:9, fontFamily:'monospace', letterSpacing:'0.20em', color:'var(--text-tertiary)', textTransform:'uppercase' }}>Quick Actions</span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {[
              { label:'Observatory',   desc:'Global threat map', emoji:'🌐', accent:M.BLUE,  path:'/observatory' },
              { label:'Brands Hub',    desc:'Portfolio health',  emoji:'🛡', accent:M.AMBER, path:'/brands' },
              { label:'Threat Actors', desc:'18 adversaries',    emoji:'🎯', accent:M.RED,   path:'/threat-actors' },
              { label:'Geo Campaign',  desc:'IRGC active',       emoji:'⚡', accent:M.RED,   path:'/campaigns' },
            ].map(a => (
              <DeepCard key={a.label} variant="stat" accentColor={a.accent} onClick={() => navigate(a.path)} style={{ padding:'16px 14px', cursor:'pointer' }}>
                <div style={{ fontSize:24, marginBottom:10, filter:`drop-shadow(0 0 8px ${a.accent}60)` }}>{a.emoji}</div>
                <div style={{ fontSize:12, fontWeight:800, color:'var(--text-primary)' }}>{a.label}</div>
                <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:3 }}>{a.desc}</div>
              </DeepCard>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
