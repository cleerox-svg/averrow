// Critical-Intelligence + Platform-status row.
//
// Two stacked elements:
//   1. Red "Critical Intelligence" banner (only renders when a
//      critical event exists). Sources rotate through
//      provider surges, temporal bursts, mass-impersonation IPs,
//      new campaigns, then open-critical-alerts as fallback. Each
//      event drills to a specific page (campaign / cluster /
//      provider / alert filter) instead of the bare /alerts dump.
//      Replaced the bare alertStats.critical count after the
//      2026-05-16 platform audit found the 242 banner vs 3
//      bottom-nav-badge inconsistency.
//   2. PlatformStatusFlyout ("ALL SYSTEMS OPERATIONAL" bar with
//      the availability flyout — owns platform health domain).

import { useNavigate } from 'react-router-dom';
import { useCriticalBanner } from '@/hooks/useCriticalBanner';
import type { CriticalEvent, CriticalEventKind } from '@/hooks/useCriticalBanner';
import { PlatformStatusFlyout } from '@/components/PlatformStatusFlyout';

const KIND_LABEL: Record<CriticalEventKind, string> = {
  provider_surge:        'PROVIDER SURGE',
  burst:                 'BURST DETECTED',
  mass_impersonation_ip: 'MASS IMPERSONATION',
  new_campaign:          'NEW CAMPAIGN',
  open_critical_alerts:  'OPEN CRITICAL',
};

function PrimaryEvent({ event, extraCount, onClick }: {
  event: CriticalEvent;
  extraCount: number;
  onClick: () => void;
}) {
  const label = KIND_LABEL[event.kind] ?? 'CRITICAL';
  return (
    <button
      type="button"
      onClick={onClick}
      className="home-critical-banner"
      aria-label={`${label}: ${event.title}`}
    >
      <span className="home-critical-dot" aria-hidden />
      <div className="home-critical-body">
        <div className="home-critical-meta">
          <span className="home-critical-label">{label}</span>
          {extraCount > 0 && (
            <span className="home-critical-more">+{extraCount} more</span>
          )}
        </div>
        <div className="home-critical-title">{event.title}</div>
        <div className="home-critical-subtitle">{event.subtitle}</div>
      </div>
      <span className="home-critical-cta">View →</span>
    </button>
  );
}

export function StatusRow() {
  const navigate = useNavigate();
  const { data } = useCriticalBanner();

  const events = data?.events ?? [];
  const primary = events[0];
  const extraCount = Math.max(0, events.length - 1);

  return (
    <section className="home-status-row">
      {primary && (
        <PrimaryEvent
          event={primary}
          extraCount={extraCount}
          onClick={() => navigate(primary.link)}
        />
      )}

      <PlatformStatusFlyout />

      <style>{`
        .home-status-row {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 14px 24px 0;
        }
        .home-critical-banner {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          width: 100%;
          padding: 12px 18px;
          border-radius: 12px;
          background: linear-gradient(150deg, rgba(40,12,12,0.95), rgba(15,8,8,0.98));
          border: 1px solid var(--sev-critical-border, rgba(239,68,68,0.30));
          color: inherit;
          cursor: pointer;
          text-align: left;
          font: inherit;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 24px rgba(239,68,68,0.15);
          transition: border-color 0.15s ease;
        }
        .home-critical-banner:hover {
          border-color: var(--sev-critical, #f87171);
        }
        .home-critical-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--sev-critical, #f87171);
          box-shadow: 0 0 12px var(--sev-critical, #f87171);
          animation: home-critical-pulse 1.6s ease-in-out infinite;
          flex-shrink: 0;
          margin-top: 5px;
        }
        .home-critical-body {
          flex: 1;
          min-width: 0;
        }
        .home-critical-meta {
          display: flex;
          align-items: center;
          gap: 10px;
          font-family: var(--font-mono);
          font-size: 9px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          margin-bottom: 4px;
        }
        .home-critical-label {
          color: var(--sev-critical, #f87171);
          font-weight: 700;
        }
        .home-critical-more {
          color: var(--text-tertiary);
        }
        .home-critical-title {
          font-size: 14px;
          color: var(--text-primary);
          font-weight: 600;
          line-height: 1.3;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .home-critical-subtitle {
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.4;
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .home-critical-cta {
          font-family: var(--font-mono);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: var(--sev-critical, #f87171);
          flex-shrink: 0;
          margin-top: 5px;
        }
        @keyframes home-critical-pulse {
          0%, 100% { opacity: 1;   transform: scale(1);   }
          50%      { opacity: 0.6; transform: scale(1.15); }
        }
        @media (prefers-reduced-motion: reduce) {
          .home-critical-dot { animation: none; }
        }

        @container home (min-width: 480px) {
          .home-status-row { padding: 14px 32px 0; }
        }
      `}</style>
    </section>
  );
}
