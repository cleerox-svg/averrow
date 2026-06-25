// v4 Overview — the command-center landing (shown at "/" only in the v4 shell;
// the classic Home is untouched). Bold cinematic hero (greeting + glowing
// count-up KPIs) + a quick-launch grid into the workspaces. Reuses the
// Console's v4 kit (console.css) + live data.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import CountUp from 'react-countup';
import {
  LayoutDashboard, Globe, Shield, Users, Activity, Cpu,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { useIncidents } from '@/features/admin-incidents/useIncidents';
import '@/features/console/console.css';

const QUICK = [
  { to: '/console',        icon: LayoutDashboard, title: 'SOC Console',   desc: 'Signals, threats, incidents & takedowns' },
  { to: '/observatory-v3', icon: Globe,           title: 'Observatory',   desc: 'Live global threat map' },
  { to: '/brands',         icon: Shield,          title: 'Brands',        desc: 'Brand exposure & posture' },
  { to: '/threat-actors',  icon: Users,           title: 'Threat Actors', desc: 'Actor MO, kits & pivots' },
  { to: '/campaigns',      icon: Activity,        title: 'Campaigns',     desc: 'Coordinated operations' },
  { to: '/agents',         icon: Cpu,             title: 'Agents',        desc: 'AI agent mesh & health' },
];

function KpiTile({ tone, label, value, sub }: { tone: 'amber' | 'red' | 'blue'; label: string; value: number | null; sub?: string }) {
  return (
    <div className={`kpi-v4 ${tone}`}>
      <div className="kpi-glow" aria-hidden />
      <div className="kpi-lbl">{label}</div>
      <div className="kpi-num">{value == null ? '—' : <CountUp end={value} duration={1.1} separator="," />}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function OverviewV4() {
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
    <div className="console-v4">
      <div className="console-head">
        <div>
          <div className="console-crumb">COMMAND CENTER</div>
          <h1 className="console-title">{greeting}, {name}</h1>
        </div>
        <span className="console-live"><span className="dot" />LIVE</span>
      </div>

      <div className="kpi-grid">
        <KpiTile tone="amber" label="Open signals"       value={openSignals}       sub="awaiting triage" />
        <KpiTile tone="red"   label="Critical incidents" value={criticalIncidents} sub="need eyes now" />
        <KpiTile tone="blue"  label="Open incidents"     value={openIncidents}     sub="platform & ops" />
      </div>

      <div className="ql-grid">
        {QUICK.map(q => {
          const Icon = q.icon;
          return (
            <Link key={q.to} to={q.to} className="ql-card">
              <Icon size={22} strokeWidth={2} className="ql-icon" />
              <div className="ql-title">{q.title}</div>
              <div className="ql-desc">{q.desc}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
