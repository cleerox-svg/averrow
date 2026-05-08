// Phase 5 of the unified Home rebuild — Module Hub grid.
//
// Deep-link cards for the platform's primary surfaces. Each card
// shows an icon, the module name, a one-line description, and a live
// mini-stat where one is cheap to fetch (most stats reuse hooks
// already populated by the Stat grid + Brand Movers above, so no
// extra network cost).
//
// Container query layout:
//   < 480 px  → 1 column
//   480–800   → 2 columns
//   800–1100  → 3 columns
//   ≥ 1100    → 4 columns
//
// Each card is a single button with hover affordance — clicking
// anywhere on the card navigates to the surface.

import { useNavigate } from 'react-router-dom';
import {
  Globe, Shield, Crosshair, Activity, Server, Cpu, Rss, Siren,
  type LucideIcon,
} from 'lucide-react';
import { useObservatoryStats } from '@/hooks/useObservatory';
import { useBrandStats } from '@/hooks/useBrands';
import { useOperationsStats } from '@/hooks/useOperations';
import { useFeedStats } from '@/hooks/useFeeds';
import { useAgents } from '@/hooks/useAgents';
import { useThreatActorStats } from '@/hooks/useThreatActors';
import { useIncidents } from '@/features/admin-incidents/useIncidents';
import { useAuth } from '@/lib/auth';
import { useObservatoryVersion } from '@/design-system/hooks';

interface ModuleCardProps {
  icon:        LucideIcon;
  label:       string;
  description: string;
  /** Live mini-stat shown beneath the description. Pass an empty string to hide. */
  stat:        string;
  accent:      string;
  onClick:     () => void;
}

function ModuleCard({ icon: Icon, label, description, stat, accent, onClick }: ModuleCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="home-module-card"
      style={{ '--module-accent': accent } as React.CSSProperties}
    >
      <div className="home-module-card-head">
        <span className="home-module-card-icon" aria-hidden>
          <Icon size={18} />
        </span>
        <span className="home-module-card-name">{label}</span>
      </div>
      <div className="home-module-card-desc">{description}</div>
      {stat && <div className="home-module-card-stat">{stat}</div>}
      <div className="home-module-card-cta">Enter →</div>
    </button>
  );
}

export function ModuleHub() {
  const navigate = useNavigate();
  const { isSuperAdmin } = useAuth();
  const { path: observatoryPath } = useObservatoryVersion();

  const { data: obsStats }    = useObservatoryStats();
  const { data: brandStats }  = useBrandStats();
  const { data: opsStats }    = useOperationsStats();
  const { data: feedStats }   = useFeedStats();
  const { data: agentData }   = useAgents();
  const { data: actorStats }  = useThreatActorStats();
  // Incidents are super_admin-only; the hook respects `enabled`.
  const { data: incidentList } = useIncidents({ enabled: isSuperAdmin });

  const agents       = Array.isArray(agentData) ? agentData : [];
  const agentsOnline = agents.filter(
    a => a.status === 'healthy' || a.status === 'running' || a.status === 'active',
  ).length;
  const incidents    = Array.isArray(incidentList) ? incidentList : [];
  const openIncidents = incidents.filter(i => i.status !== 'resolved').length;

  return (
    <section className="home-module-hub">
      <div className="home-module-hub-label">Modules</div>
      <div className="home-module-grid">
        <ModuleCard
          icon={Globe}
          label="Observatory"
          description="Global threat map · live"
          stat={obsStats ? `${obsStats.threats_mapped.toLocaleString()} threats · ${obsStats.countries} countries` : ''}
          accent="var(--blue)"
          onClick={() => navigate(observatoryPath)}
        />
        <ModuleCard
          icon={Shield}
          label="Brands Hub"
          description="Monitored brands & exposure"
          stat={brandStats ? `${brandStats.total_tracked.toLocaleString()} brands monitored` : ''}
          accent="var(--amber)"
          onClick={() => navigate('/brands')}
        />
        <ModuleCard
          icon={Crosshair}
          label="Threat Actors"
          description="Identities & attributions"
          stat={actorStats ? `${actorStats.active.toLocaleString()} active actors` : ''}
          accent="var(--red)"
          onClick={() => navigate('/threat-actors')}
        />
        <ModuleCard
          icon={Activity}
          label="Campaigns"
          description="Coordinated threat operations"
          stat={opsStats ? `${(opsStats.active_operations ?? 0).toLocaleString()} active ops` : ''}
          accent="var(--amber)"
          onClick={() => navigate('/campaigns')}
        />
        <ModuleCard
          icon={Server}
          label="Providers"
          description="Hosting · DNS · ASN"
          stat=""
          accent="var(--blue)"
          onClick={() => navigate('/providers')}
        />
        <ModuleCard
          icon={Cpu}
          label="Agents"
          description="AI mesh & cron health"
          stat={agents.length > 0 ? `${agentsOnline} of ${agents.length} running` : ''}
          accent="var(--blue)"
          onClick={() => navigate('/agents')}
        />
        <ModuleCard
          icon={Rss}
          label="Feeds"
          description="Threat ingestion sources"
          stat={feedStats ? `${feedStats.active} active` : ''}
          accent="var(--green)"
          onClick={() => navigate('/feeds')}
        />
        {isSuperAdmin && (
          <ModuleCard
            icon={Siren}
            label="Incidents"
            description="Operations response queue"
            stat={incidents.length > 0 ? `${openIncidents} open` : ''}
            accent="var(--red)"
            onClick={() => navigate('/admin/incidents')}
          />
        )}
      </div>

      <style>{`
        .home-module-hub {
          padding: 22px 24px 0;
        }
        .home-module-hub-label {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.20em;
          text-transform: uppercase;
          color: var(--text-tertiary);
          margin-bottom: 12px;
        }
        .home-module-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: 1fr;
        }
        .home-module-card {
          position: relative;
          padding: 16px;
          border-radius: 12px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 6px;
          transition: border-color 0.15s ease, transform 0.10s ease, box-shadow 0.15s ease;
        }
        .home-module-card:hover {
          border-color: var(--module-accent);
          transform: translateY(-1px);
          box-shadow: 0 8px 24px rgba(0,0,0,0.45), 0 0 18px color-mix(in srgb, var(--module-accent) 22%, transparent);
        }
        .home-module-card:hover .home-module-card-cta {
          color: var(--module-accent);
        }
        .home-module-card-head {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .home-module-card-icon {
          width: 32px;
          height: 32px;
          border-radius: 9px;
          background: color-mix(in srgb, var(--module-accent) 18%, transparent);
          border: 1px solid color-mix(in srgb, var(--module-accent) 35%, transparent);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--module-accent);
          flex-shrink: 0;
        }
        .home-module-card-name {
          font-size: 14px;
          font-weight: 700;
          color: var(--text-primary);
          letter-spacing: -0.1px;
        }
        .home-module-card-desc {
          font-size: 11px;
          color: var(--text-secondary);
          line-height: 1.4;
        }
        .home-module-card-stat {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-muted);
          letter-spacing: 0.04em;
          margin-top: 2px;
        }
        .home-module-card-cta {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--text-tertiary);
          margin-top: 6px;
          transition: color 0.15s ease;
        }
        @media (prefers-reduced-motion: reduce) {
          .home-module-card { transition: border-color 0.15s ease; }
          .home-module-card:hover { transform: none; }
        }

        @container home (min-width: 480px) {
          .home-module-hub { padding: 24px 32px 0; }
          .home-module-grid {
            gap: 12px;
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @container home (min-width: 800px) {
          .home-module-grid { grid-template-columns: repeat(3, 1fr); }
        }
        @container home (min-width: 1100px) {
          .home-module-grid { grid-template-columns: repeat(4, 1fr); }
        }
      `}</style>
    </section>
  );
}
