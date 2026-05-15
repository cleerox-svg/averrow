import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useSpamTrapAddresses, useSpamTrapStats, useSpamTrapDaily } from '@/hooks/useSpamTrap';
import { StatCard } from '@/components/ui/StatCard';
import { TrendSparkline } from '@/components/ui/TrendSparkline';
import { HoneypotNetworkPanel } from './components/HoneypotNetworkPanel';
import { CaptureForensicsPanel } from './components/CaptureForensicsPanel';
import { CampaignPanel } from './components/CampaignPanel';
import { ThreatActorPanel } from './components/ThreatActorPanel';
import { PageLoader } from '@/components/ui/PageLoader';
import { relativeTime } from '@/lib/time';

export function SpamTrap() {
  const { isSuperAdmin, loading: authLoading } = useAuth();
  const { data: addresses } = useSpamTrapAddresses();
  const { data: stats } = useSpamTrapStats();
  const { data: daily } = useSpamTrapDaily();

  if (authLoading) return <PageLoader />;
  if (!isSuperAdmin) return <Navigate to="/" replace />;

  const seedCount = addresses?.length ?? 0;
  const domainCount = addresses
    ? new Set(addresses.map((a) => a.domain)).size
    : 0;
  const captureCount = stats?.total_captures ?? 0;
  const catchRate =
    seedCount > 0 ? ((captureCount / seedCount) * 100).toFixed(1) + '%' : '—';

  // Wave-1 PR-AB: trend signals on the header.
  //   - 30-day catch series for the sparkline (oldest → newest)
  //   - 7-day catch rate (catches in last 7 days ÷ seeds, multiplied 4.3 for monthly equivalent)
  //   - last-catch timestamp from the most recent seed catch
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

      {/* Stats strip — Wave-1 PR-AB adds 7-day rate, last catch tile, and a
          30-day catches-per-day sparkline that spans the full row width.
          Existing tiles (seeds, domains, captures, catch rate) preserved
          so any saved screenshots still align. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="SEEDS DEPLOYED"   value={seedCount}     accentColor="#E5A832" />
        <StatCard label="DOMAINS"          value={domainCount}   accentColor="#E5A832" />
        <StatCard label="CAPTURES"         value={captureCount}  accentColor="#fb923c" />
        <StatCard label="CATCH RATE · ALL" value={catchRate}     accentColor="#4ADE80" />
        <StatCard label="CATCH RATE · 7D"  value={last7Rate}     accentColor="#4ADE80" />
        <StatCard label="LAST CATCH"       value={lastCatch}     accentColor="var(--text-secondary)" />
      </div>

      {/* 30-day catches-per-day sparkline — gives the trend signal the
          stats snapshot can't. Hidden gracefully when daily data is empty
          (fresh deploy / cache miss). */}
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

      {/* 2x2 panel grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <HoneypotNetworkPanel />
        <CaptureForensicsPanel />
        <CampaignPanel />
        <ThreatActorPanel />
      </div>
    </div>
  );
}
