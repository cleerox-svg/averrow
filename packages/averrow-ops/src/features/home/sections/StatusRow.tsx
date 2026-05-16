// Phase 2 of the unified Home rebuild — Status row.
//
// Two stacked elements:
//   1. Critical alerts banner (red, only renders when criticalCount > 0)
//   2. PlatformStatusFlyout (clickable "ALL SYSTEMS OPERATIONAL" bar
//      with the availability flyout — already responsive, reused as-is)
//
// The banner click navigates to /alerts. The flyout has its own
// click-to-expand behavior. Both are full-width inside the section.

import { useNavigate } from 'react-router-dom';
import { useAlertStats } from '@/hooks/useAlerts';
import { PlatformStatusFlyout } from '@/components/PlatformStatusFlyout';

export function StatusRow() {
  const navigate = useNavigate();
  const { data: alertStats } = useAlertStats();
  const criticalCount = alertStats?.critical ?? 0;

  return (
    <section className="home-status-row">
      {criticalCount > 0 && (
        <button
          type="button"
          onClick={() => navigate('/alerts')}
          className="home-critical-banner"
          aria-label={`${criticalCount} critical signals require attention`}
        >
          <span className="home-critical-dot" aria-hidden />
          <span className="home-critical-text">
            <strong>{criticalCount.toLocaleString()}</strong>{' '}
            critical signal{criticalCount === 1 ? '' : 's'} require attention
          </span>
          <span className="home-critical-cta">View →</span>
        </button>
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
          align-items: center;
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
        }
        .home-critical-text {
          flex: 1;
          font-size: 13px;
          color: var(--text-primary);
        }
        .home-critical-text strong {
          color: var(--sev-critical, #f87171);
          font-weight: 800;
        }
        .home-critical-cta {
          font-family: var(--font-mono);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: var(--sev-critical, #f87171);
          flex-shrink: 0;
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
