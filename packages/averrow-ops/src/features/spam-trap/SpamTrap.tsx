import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useSpamTrapAddresses, useSpamTrapStats } from '@/hooks/useSpamTrap';
import { StatCard } from '@/components/ui/StatCard';
import { HoneypotNetworkPanel } from './components/HoneypotNetworkPanel';
import { CaptureForensicsPanel } from './components/CaptureForensicsPanel';
import { CampaignPanel } from './components/CampaignPanel';
import { ThreatActorPanel } from './components/ThreatActorPanel';
import { PageLoader } from '@/components/ui/PageLoader';

export function SpamTrap() {
  const { isSuperAdmin, loading: authLoading } = useAuth();
  const { data: addresses } = useSpamTrapAddresses();
  const { data: stats } = useSpamTrapStats();

  if (authLoading) return <PageLoader />;
  if (!isSuperAdmin) return <Navigate to="/" replace />;

  const seedCount = addresses?.length ?? 0;
  const domainCount = addresses
    ? new Set(addresses.map((a) => a.domain)).size
    : 0;
  const captureCount = stats?.total_captures ?? 0;
  const catchRate =
    seedCount > 0 ? ((captureCount / seedCount) * 100).toFixed(1) + '%' : '—';

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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="SEEDS DEPLOYED" value={seedCount} accentColor="#E5A832" />
        <StatCard label="DOMAINS" value={domainCount} accentColor="#E5A832" />
        <StatCard label="CAPTURES" value={captureCount} accentColor="#fb923c" />
        <StatCard label="CATCH RATE" value={catchRate} accentColor="#4ADE80" />
      </div>

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
