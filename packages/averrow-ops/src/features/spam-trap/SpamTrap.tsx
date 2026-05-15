// Spam Trap top-level page.
//
// Wave-4 PR-AE: restructured from a 2x2 panel grid to a tab-based
// layout so the new Trends / Correlations / Strategy datasets each
// get a first-class slot rather than being buried under the
// existing 2x2 of operational panels. Bundles Wave-1 item 1.2
// (page-level tabs), Wave-3 item 3.3 (Strategy view), and the
// Wave-4 Capture Rate + Correlation surfaces.
//
// Tab layout:
//   Operations   — original 2x2 panel grid (Network / Captures /
//                  Campaigns / Threat Actors). Default tab so the
//                  existing operator workflow is unchanged.
//   Trends       — weekly captures × channel + cohort time-to-first-
//                  catch + per-channel productive rate.
//   Correlations — public abuse-mailbox captures with overlap counts
//                  against the seeded-honeypot universe (the "covert
//                  spam trap" payoff from Wave 2 PR-AC's cross-link).
//   Strategy     — seed_strategist agent state: last run, recent
//                  auto-prune count, recent diagnostic outputs.
//
// The header stats strip + 30-day sparkline (PR-AB) stays at the
// top of every tab — it's the at-a-glance summary regardless of
// which deeper tab the operator is in.

import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import {
  useSpamTrapAddresses,
  useSpamTrapStats,
  useSpamTrapDaily,
  useSpamTrapInsights,
} from '@/hooks/useSpamTrap';
import { StatCard } from '@/components/ui/StatCard';
import { TrendSparkline } from '@/components/ui/TrendSparkline';
import { HoneypotNetworkPanel } from './components/HoneypotNetworkPanel';
import { CaptureForensicsPanel } from './components/CaptureForensicsPanel';
import { CampaignPanel } from './components/CampaignPanel';
import { ThreatActorPanel } from './components/ThreatActorPanel';
import { TrendsTab, CorrelationsTab, StrategyTab } from './components/InsightsTabs';
import { PageLoader } from '@/components/ui/PageLoader';
import { relativeTime } from '@/lib/time';

type TabKey = 'operations' | 'trends' | 'correlations' | 'strategy';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'operations',   label: 'OPERATIONS'   },
  { key: 'trends',       label: 'TRENDS'       },
  { key: 'correlations', label: 'CORRELATIONS' },
  { key: 'strategy',     label: 'STRATEGY'     },
];

export function SpamTrap() {
  const { isSuperAdmin, loading: authLoading } = useAuth();
  const { data: addresses } = useSpamTrapAddresses();
  const { data: stats } = useSpamTrapStats();
  const { data: daily } = useSpamTrapDaily();
  const { data: insights } = useSpamTrapInsights();
  const [activeTab, setActiveTab] = useState<TabKey>('operations');

  if (authLoading) return <PageLoader />;
  if (!isSuperAdmin) return <Navigate to="/" replace />;

  const seedCount = addresses?.length ?? 0;
  const domainCount = addresses
    ? new Set(addresses.map((a) => a.domain)).size
    : 0;
  const captureCount = stats?.total_captures ?? 0;
  const catchRate =
    seedCount > 0 ? ((captureCount / seedCount) * 100).toFixed(1) + '%' : '—';

  const last30daily = (daily ?? []).slice(-30);
  const sparklineValues = last30daily.map((d) => d.total ?? 0);
  const last7sum = last30daily.slice(-7).reduce((s, d) => s + (d.total ?? 0), 0);
  const last7Rate = seedCount > 0 ? ((last7sum / seedCount) * 100).toFixed(1) + '%' : '—';
  const lastCatchAt = (addresses ?? [])
    .map((a) => a.last_catch_at)
    .filter((x): x is string => Boolean(x))
    .sort()
    .pop() ?? null;
  const lastCatch = lastCatchAt ? relativeTime(lastCatchAt) : 'never';

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Spam Trap</h1>
          <p className="text-white/50 text-sm font-mono mt-1">
            THREAT ACTOR INTELLIGENCE · HONEYPOT NETWORK
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="dot-pulse dot-pulse-green" />
          <span className="text-xs font-mono text-white/50">HONEYPOT ACTIVE</span>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="SEEDS DEPLOYED"   value={seedCount}     accentColor="#E5A832" />
        <StatCard label="DOMAINS"          value={domainCount}   accentColor="#E5A832" />
        <StatCard label="CAPTURES"         value={captureCount}  accentColor="#fb923c" />
        <StatCard label="CATCH RATE · ALL" value={catchRate}     accentColor="#4ADE80" />
        <StatCard label="CATCH RATE · 7D"  value={last7Rate}     accentColor="#4ADE80" />
        <StatCard label="LAST CATCH"       value={lastCatch}     accentColor="var(--text-secondary)" />
      </div>

      {/* 30-day sparkline */}
      {sparklineValues.length > 0 && (
        <div
          className="rounded-xl px-4 py-3 flex items-center gap-4"
          style={{
            background: 'rgba(15,23,42,0.50)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid var(--border-base)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
          }}
        >
          <div className="shrink-0">
            <div className="text-[9px] font-mono uppercase tracking-widest text-white/40">
              Catches · 30 days
            </div>
            <div className="text-xl font-bold tabular-nums text-white mt-1">
              {sparklineValues.reduce((s, v) => s + v, 0)}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <TrendSparkline
              data={sparklineValues}
              color="#fb923c"
              height={36}
              fill
            />
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-white/[0.06]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-3 py-2 text-[10px] font-mono uppercase tracking-wider transition-colors border-b-2 ${
              activeTab === t.key
                ? 'text-white border-[var(--amber)]'
                : 'text-white/45 hover:text-white/75 border-transparent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab body */}
      {activeTab === 'operations' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <HoneypotNetworkPanel />
          <CaptureForensicsPanel />
          <CampaignPanel />
          <ThreatActorPanel />
        </div>
      )}
      {activeTab === 'trends'       && <TrendsTab       insights={insights ?? null} />}
      {activeTab === 'correlations' && <CorrelationsTab insights={insights ?? null} />}
      {activeTab === 'strategy'     && <StrategyTab     insights={insights ?? null} />}
    </div>
  );
}
