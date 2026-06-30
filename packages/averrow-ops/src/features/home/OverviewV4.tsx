// v4 Overview — the command-center landing (shown at "/" only in the v4 shell;
// the classic Home is untouched).
//
// IMPORTANT: this reuses EVERY rich section from HomeUnified — only the header
// is swapped for the bold cinematic hero (greeting + glowing count-up triage
// KPIs). Nothing from the classic dashboard is dropped (milestone, status,
// stat grid, threat pulse, briefing, intel, activity, movers, module hub,
// provider movers all stay). Sections are the same shared components, so the
// classic Home is unaffected.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import CountUp from 'react-countup';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { useIncidents } from '@/features/admin-incidents/useIncidents';
import { MilestoneBanner } from '@/features/home/sections/MilestoneBanner';
import { StatusRow } from '@/features/home/sections/StatusRow';
import { StatGrid } from '@/features/home/sections/StatGrid';
import { ThreatPulse } from '@/features/home/sections/ThreatPulse';
import { DailyBriefing } from '@/features/home/sections/DailyBriefing';
import { LatestIntel } from '@/features/home/sections/LatestIntel';
import { IntelHotlist } from '@/features/home/sections/IntelHotlist';
import { LiveActivity } from '@/features/home/sections/LiveActivity';
import { BrandMovers } from '@/features/home/sections/BrandMovers';
import { ModuleHub } from '@/features/home/sections/ModuleHub';
import { ProviderMovers } from '@/features/home/sections/ProviderMovers';
import '@/features/console/console.css';

const SHELL_STYLE: React.CSSProperties = {
  containerType: 'inline-size' as React.CSSProperties['containerType'],
  containerName: 'home',
  width: '100%',
  minHeight: '100vh',
  paddingBottom: 24,
};

function KpiTile({ tone, label, value, sub, to }: { tone: 'amber' | 'red' | 'blue'; label: string; value: number | null; sub?: string; to?: string }) {
  const inner = (
    <>
      <div className="kpi-glow" aria-hidden />
      <div className="kpi-lbl">{label}</div>
      <div className="kpi-num">{value == null ? '—' : <CountUp end={value} duration={1.1} separator="," />}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {to && <span className="kpi-go" aria-hidden>View →</span>}
    </>
  );
  if (to) {
    return <Link to={to} className={`kpi-v4 ${tone} kpi-clickable`}>{inner}</Link>;
  }
  return <div className={`kpi-v4 ${tone}`}>{inner}</div>;
}

function V4Hero() {
  const { user } = useAuth();
  const name = (user?.display_name ?? user?.name ?? '').split(' ')[0] || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const [openSignals, setOpenSignals] = useState<number | null>(null);
  const { data: incidents } = useIncidents({ onlyOpen: true });
  const openIncidents = incidents?.length ?? null;
  const criticalIncidents = incidents ? incidents.filter(i => i.severity === 'critical').length : null;

  useEffect(() => {
    api.get<unknown>('/api/alerts?status=open&limit=1')
      .then(d => setOpenSignals(d.total ?? 0))
      .catch(() => {});
  }, []);

  return (
    <div className="console-v4" style={{ paddingBottom: 6 }}>
      <div className="console-head">
        <div>
          <div className="console-crumb">COMMAND CENTER</div>
          <h1 className="console-title">{greeting}, {name}</h1>
        </div>
        <span className="console-live"><span className="dot" />LIVE</span>
      </div>
      <div className="kpi-grid">
        <KpiTile tone="amber" label="Open signals"       value={openSignals}       sub="awaiting triage" to="/alerts" />
        <KpiTile tone="red"   label="Critical incidents" value={criticalIncidents} sub="need eyes now"    to="/admin/incidents" />
        <KpiTile tone="blue"  label="Open incidents"     value={openIncidents}     sub="platform & ops"   to="/admin/incidents" />
      </div>
    </div>
  );
}

export function OverviewV4() {
  return (
    <div style={SHELL_STYLE}>
      <V4Hero />
      <MilestoneBanner />
      <StatusRow />
      <StatGrid />
      <ThreatPulse />
      <DailyBriefing />
      <LatestIntel />
      <IntelHotlist />
      <LiveActivity />
      <BrandMovers />
      <ModuleHub />
      <ProviderMovers />
    </div>
  );
}
