// v4 Overview — the command-center landing shown at "/" for every staff user.
//
// Cinematic hero (greeting + glowing count-up triage KPIs) followed by the
// shared home sections (status, stat grid, threat pulse, briefing, intel,
// activity, movers, module hub, provider movers).

import { Link } from 'react-router-dom';
import CountUp from 'react-countup';
import { useAuth } from '@/lib/auth';
import { useOpenAlertCount } from '@/hooks/useOpenAlertCount';
import { useIncidents } from '@/features/admin-incidents/useIncidents';
import { InstallAppBanner } from '@/components/InstallAppBanner';
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

function KpiTile({ tone, label, value, sub, to, error }: { tone: 'amber' | 'red' | 'blue'; label: string; value: number | null; sub?: string; to?: string; error?: boolean }) {
  const inner = (
    <>
      <div className="kpi-glow" aria-hidden />
      <div className="kpi-lbl">{label}</div>
      <div className="kpi-num">{value == null ? '—' : <CountUp end={value} duration={1.1} separator="," />}</div>
      {error && value == null
        ? <div className="kpi-sub" role="status" style={{ color: 'var(--text-tertiary)' }}>Couldn't load</div>
        : sub && <div className="kpi-sub">{sub}</div>}
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

  const { data: openSignals = null, isError: signalsError } = useOpenAlertCount();
  const { data: incidents, isError: incidentsError } = useIncidents({ onlyOpen: true });
  const openIncidents = incidents?.length ?? null;
  const criticalIncidents = incidents ? incidents.filter(i => i.severity === 'critical').length : null;

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
        <KpiTile tone="amber" label="Open alerts"         value={openSignals}       sub="awaiting triage" to="/console?tab=alerts" error={signalsError} />
        <KpiTile tone="red"   label="Critical incidents" value={criticalIncidents} sub="need eyes now"    to="/console?tab=incidents" error={incidentsError} />
        <KpiTile tone="blue"  label="Open incidents"     value={openIncidents}     sub="platform & ops"   to="/console?tab=incidents" error={incidentsError} />
      </div>
    </div>
  );
}

export function OverviewV4() {
  return (
    <div style={SHELL_STYLE}>
      <V4Hero />
      <InstallAppBanner />
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
