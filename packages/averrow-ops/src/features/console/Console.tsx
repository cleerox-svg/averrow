// SOC Console — the v4 analyst daily-driver workspace.
//
// A BOLD cinematic header (big glowing count-up KPI hero + deep-linkable tab
// bar) over the existing queue pages mounted as tab bodies. Built on
// @averrow/shared/ui + live data — no page-logic rewrites. The hero is the
// "this is clearly v4" surface (matches the approved prototype).

import { Suspense, lazy, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import CountUp from 'react-countup';
import { Radar, Crosshair, Siren, Gavel } from 'lucide-react';
import { Button } from '@averrow/shared/ui';
import { api } from '@/lib/api';
import { useIncidents } from '@/features/admin-incidents/useIncidents';
import { ConsoleIncidents } from './views/ConsoleIncidents';
import './console.css';

type ConsoleTab = 'signals' | 'threats' | 'incidents' | 'takedowns';

const TABS: { id: ConsoleTab; label: string; icon: typeof Radar; def: string }[] = [
  {
    id: 'signals', label: 'Signals', icon: Radar,
    def: 'Auto-triaged alerts that need a human look — suspected impersonations (social & app-store), phishing domains, and brand lookalikes surfaced from detections.',
  },
  {
    id: 'threats', label: 'Threats', icon: Crosshair,
    def: 'The full inventory of threats we’re tracking — malicious domains, URLs, and indicators mapped to your brands.',
  },
  {
    id: 'incidents', label: 'Incidents', icon: Siren,
    def: 'Platform & operational incidents — feed outages, provider surges, and infrastructure-health events the platform auto-opens.',
  },
  {
    id: 'takedowns', label: 'Takedowns', icon: Gavel,
    def: 'Takedown requests and where each one sits in its lifecycle — draft, submitted, resolved, or dismissed.',
  },
];
const TAB_VALUES: readonly string[] = TABS.map(t => t.id);
function isTab(v: string | null): v is ConsoleTab {
  return v != null && TAB_VALUES.includes(v);
}

const Alerts = lazy(() => import('@/features/alerts/Alerts').then(m => ({ default: m.Alerts })));
const Threats = lazy(() => import('@/features/threats/Threats').then(m => ({ default: m.Threats })));
const Takedowns = lazy(() => import('@/features/takedowns/Takedowns').then(m => ({ default: m.Takedowns })));

export function Console() {
  const [params, setParams] = useSearchParams();
  const initial: ConsoleTab = isTab(params.get('tab')) ? (params.get('tab') as ConsoleTab) : 'signals';
  const [tab, setTab] = useState<ConsoleTab>(initial);
  const [openSignals, setOpenSignals] = useState<number | null>(null);

  const { data: incidents } = useIncidents({ onlyOpen: true });
  const openIncidents = incidents?.length ?? null;
  const criticalIncidents = incidents ? incidents.filter(i => i.severity === 'critical').length : null;

  useEffect(() => {
    api.get<unknown>('/api/alerts?status=open&limit=1')
      .then(d => setOpenSignals(d.total ?? 0))
      .catch(() => {});
  }, []);

  function selectTab(next: ConsoleTab) {
    setTab(next);
    const p = new URLSearchParams(params);
    if (next === 'signals') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  }

  const active = TABS.find(t => t.id === tab);

  return (
    <div className="console-v4">
      <div className="console-head">
        <div>
          <div className="console-crumb">SOC CONSOLE</div>
          <h1 className="console-title">Console</h1>
        </div>
        <span className="console-live"><span className="dot" />LIVE</span>
      </div>

      {/* KPI hero — glowing count-up numbers; each tile jumps to its queue. */}
      <div className="kpi-grid">
        <KpiTile tone="amber" label="Open signals"       value={openSignals}       sub="awaiting triage" onClick={() => selectTab('signals')} />
        <KpiTile tone="red"   label="Critical incidents" value={criticalIncidents} sub="need eyes now"    onClick={() => selectTab('incidents')} />
        <KpiTile tone="blue"  label="Open incidents"     value={openIncidents}     sub="platform & ops"   onClick={() => selectTab('incidents')} />
      </div>

      {/* deep-linkable tab bar */}
      <div className="console-tabs">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <Button
              key={t.id}
              variant={tab === t.id ? 'primary' : 'secondary'}
              size="md"
              onClick={() => selectTab(t.id)}
            >
              <Icon size={15} strokeWidth={2} /> {t.label}
            </Button>
          );
        })}
      </div>

      {active?.def && <p className="console-def">{active.def}</p>}

      <Suspense fallback={<TabLoading />}>
        {tab === 'signals'   && <Alerts />}
        {tab === 'threats'   && <Threats />}
        {tab === 'incidents' && <ConsoleIncidents />}
        {tab === 'takedowns' && <Takedowns />}
      </Suspense>
    </div>
  );
}

function TabLoading() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
      Loading…
    </div>
  );
}

function KpiTile({ tone, label, value, sub, onClick }: { tone: 'amber' | 'red' | 'blue'; label: string; value: number | null; sub?: string; onClick?: () => void }) {
  const inner = (
    <>
      <div className="kpi-glow" aria-hidden />
      <div className="kpi-lbl">{label}</div>
      <div className="kpi-num">
        {value == null ? '—' : <CountUp end={value} duration={1.1} separator="," />}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {onClick && <span className="kpi-go" aria-hidden>View →</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={`kpi-v4 ${tone} kpi-clickable`} onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className={`kpi-v4 ${tone}`}>{inner}</div>;
}
