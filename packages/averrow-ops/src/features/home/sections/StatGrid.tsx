// Phase 2 of the unified Home rebuild — Stat grid.
//
// Six accent-tinted stat tiles drilling into the platform's primary
// surfaces. Order matches the user's spec:
//   Threats · Alerts · Campaigns · Brands · Agents · Feeds
//
// Each tile uses the canonical StatTile primitive (count-up animation,
// accent halo, optional critical pill) and links to its destination.
//
// Container query layout:
//   < 480px              → 2 cols
//   480 px – 800 px      → 3 cols
//   ≥ 800 px             → 6 cols (single row)

import { useNavigate } from 'react-router-dom';
import { StatTile } from '@/components/ui/StatTile';
import { M } from '@/design-system/tokens';
import { useObservatoryStats } from '@/hooks/useObservatory';
import { useAlertStats } from '@/hooks/useAlerts';
import { useOperationsStats } from '@/hooks/useOperations';
import { useBrandStats, useBrands } from '@/hooks/useBrands';
import { useAgents } from '@/hooks/useAgents';
import { useFeedStats } from '@/hooks/useFeeds';
import { countAgentsOnline } from '@/lib/agent-status';

export function StatGrid() {
  const navigate = useNavigate();

  const { data: obsStats }   = useObservatoryStats();
  const { data: alertStats } = useAlertStats();
  const { data: opsStats }   = useOperationsStats();
  const { data: brandStats } = useBrandStats();
  const { data: agentData }  = useAgents();
  const { data: feedStats }  = useFeedStats();
  // Brands hook surfaces the live "new this week" count via stats,
  // but the headline number is brandStats.total_tracked. useBrands
  // here is just to gracefully no-op on the rare initial paint where
  // brandStats is undefined.
  useBrands({ view: 'top', limit: 1 });

  const agents       = Array.isArray(agentData) ? agentData : [];
  // Canonical "online" predicate lives in @/lib/agent-status so the
  // Home tile and /v2/agents agree on the same number — audit C4
  // (2026-05-06), consolidated 2026-07-11 to prevent re-divergence.
  const agentsOnline = countAgentsOnline(agents);

  const criticalCount = alertStats?.critical ?? 0;
  const feedActive    = feedStats?.active ?? 0;
  const feedDisabled  = feedStats?.disabled ?? 0;
  const feedTotal     = feedActive + feedDisabled;

  return (
    <section className="home-stat-grid-section">
      <div className="home-stat-grid">
        <StatTile
          label="Mapped · 7d"
          value={obsStats?.threats_mapped ?? 0}
          sub={
            obsStats && obsStats.threats_total > 0
              ? `${obsStats.geo_coverage_pct ?? 0}% of ${obsStats.threats_total.toLocaleString()} ingested`
              : `${obsStats?.countries ?? 0} countries`
          }
          accent={M.RED}
          onClick={() => navigate('/threats')}
        />
        <StatTile
          label="Signals"
          value={alertStats?.total ?? 0}
          sub={`${criticalCount} critical · ${alertStats?.new_count ?? 0} new`}
          accent={M.RED}
          critical={criticalCount}
          onClick={() => navigate('/alerts')}
        />
        <StatTile
          label="Campaigns"
          value={opsStats?.campaigns_tracked ?? 0}
          sub={`${opsStats?.active_operations ?? 0} active ops`}
          accent={M.AMBER}
          onClick={() => navigate('/campaigns')}
        />
        <StatTile
          label="Brands"
          value={brandStats?.total_tracked ?? 0}
          sub={`${brandStats?.new_this_week ?? 0} new this week`}
          accent={M.AMBER}
          onClick={() => navigate('/brands')}
        />
        <StatTile
          label="Agents"
          value={agentsOnline}
          sub={`of ${agents.length || 0} online`}
          accent={M.BLUE}
          onClick={() => navigate('/agents')}
        />
        <StatTile
          label="Feeds"
          value={feedActive}
          sub={`of ${feedTotal || 0} active`}
          accent={M.GREEN}
          onClick={() => navigate('/feeds')}
        />
      </div>

      <style>{`
        .home-stat-grid-section {
          padding: 16px 24px 0;
        }
        .home-stat-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(2, 1fr);
        }
        @container home (min-width: 480px) {
          .home-stat-grid-section { padding: 18px 32px 0; }
          .home-stat-grid {
            gap: 12px;
            grid-template-columns: repeat(3, 1fr);
          }
        }
        @container home (min-width: 800px) {
          .home-stat-grid {
            grid-template-columns: repeat(6, 1fr);
          }
        }
      `}</style>
    </section>
  );
}
