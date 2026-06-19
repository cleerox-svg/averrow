// Milestone celebration banner.
//
// Sits at the very top of HomeUnified, above the Critical Alerts banner
// and the Status row. Renders the most recently fired platform_milestones
// row (e.g. "400,000 threats ingested") in a celebratory, hard-to-miss
// gradient card. Dismissable per-device via localStorage — when the next
// threshold is crossed (500K after 400K, etc.) the banner reappears
// automatically because the dismissal is keyed by milestone VALUE.
//
// Visual goals
// - Operator can't miss it on a normal scroll
// - Reads as celebration, not alert
// - Ties to the platform's amber/green palette
// - Animated number with count-up
// - Tasteful — no confetti emoji explosion

import { Sparkles, Trophy, X } from 'lucide-react';
import { useCountUp } from '@/design-system/hooks/useCountUp';
import { useMilestoneLatest, useMilestoneDismissed } from '@/hooks/useMilestone';

function shortLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return null as unknown as string;
  // 2+ weeks: hide the timestamp; the milestone is just the latest mark, not "fresh news"
}

function metricLabel(metric: string): string {
  switch (metric) {
    case 'total_ingested':   return 'total ingested';
    case 'threats_ingested': return 'threats ingested'; // legacy — kept for back-compat
    default:                 return metric.replace(/_/g, ' ');
  }
}

export function MilestoneBanner() {
  const { data: milestone } = useMilestoneLatest();
  const { dismissed, dismiss } = useMilestoneDismissed(milestone?.value ?? null);
  const counted = useCountUp(milestone?.value ?? 0, 1600);

  if (!milestone || dismissed) return null;

  const since = relativeTime(milestone.fired_at);
  // Million-and-up crossings get a distinct, more celebratory treatment so
  // operators can tell a landmark (1M, 5M, 10M…) apart from a routine K-step.
  const isMillion = milestone.value >= 1_000_000;

  return (
    <section
      className={`home-milestone-banner${isMillion ? ' home-milestone-banner--million' : ''}`}
      role="status"
      aria-label={isMillion ? 'Major platform milestone' : 'Platform milestone'}
    >
      <div className="home-milestone-stripe" aria-hidden />
      <div className="home-milestone-icon" aria-hidden>
        {isMillion ? <Trophy size={18} /> : <Sparkles size={18} />}
      </div>
      <div className="home-milestone-content">
        <div className="home-milestone-eyebrow">
          {isMillion ? 'MILLION MILESTONE' : 'MILESTONE'}{since ? ` · ${since}` : ''}
        </div>
        <div className="home-milestone-headline">
          <span className="home-milestone-number">
            {counted.toLocaleString()}
          </span>
          <span className="home-milestone-metric">{metricLabel(milestone.metric)}</span>
        </div>
        <div className="home-milestone-sublabel">
          {shortLabel(milestone.value)} crossed — {isMillion ? 'a landmark for the agent mesh' : 'thanks to the agent mesh'}
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss milestone"
        className="home-milestone-dismiss"
      >
        <X size={14} />
      </button>

      <style>{`
        .home-milestone-banner {
          position: relative;
          display: flex;
          align-items: center;
          gap: 14px;
          margin: 14px 24px 0;
          padding: 14px 16px 14px 18px;
          border-radius: 14px;
          background: linear-gradient(
            135deg,
            rgba(229, 168, 50, 0.10) 0%,
            rgba(60, 184, 120, 0.10) 100%
          );
          border: 1px solid rgba(229, 168, 50, 0.30);
          box-shadow:
            0 8px 32px rgba(0, 0, 0, 0.45),
            0 0 24px rgba(229, 168, 50, 0.12),
            inset 0 1px 0 rgba(229, 168, 50, 0.20);
          overflow: hidden;
        }
        .home-milestone-stripe {
          position: absolute;
          inset: 0 0 0 0;
          width: 4px;
          background: linear-gradient(180deg, var(--amber), var(--green));
          pointer-events: none;
        }
        .home-milestone-icon {
          flex-shrink: 0;
          width: 36px;
          height: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 10px;
          color: var(--amber);
          background: rgba(229, 168, 50, 0.12);
          border: 1px solid rgba(229, 168, 50, 0.30);
          box-shadow: 0 0 16px rgba(229, 168, 50, 0.25);
        }
        .home-milestone-content {
          flex: 1;
          min-width: 0;
        }
        .home-milestone-eyebrow {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.22em;
          color: var(--amber);
          text-transform: uppercase;
          margin-bottom: 4px;
        }
        .home-milestone-headline {
          display: flex;
          align-items: baseline;
          gap: 8px;
          flex-wrap: wrap;
        }
        .home-milestone-number {
          font-family: var(--font-display);
          font-size: 26px;
          font-weight: 900;
          letter-spacing: -0.5px;
          background: linear-gradient(135deg, var(--amber), var(--green));
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          text-shadow: 0 0 24px rgba(229, 168, 50, 0.30);
        }
        .home-milestone-metric {
          font-size: 13px;
          color: var(--text-secondary);
          font-weight: 500;
        }
        .home-milestone-sublabel {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-muted);
          margin-top: 2px;
        }
        .home-milestone-dismiss {
          flex-shrink: 0;
          padding: 6px;
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.10);
          border-radius: 8px;
          color: var(--text-tertiary);
          cursor: pointer;
          transition: color 0.15s ease, border-color 0.15s ease;
        }
        .home-milestone-dismiss:hover {
          color: var(--text-primary);
          border-color: rgba(255, 255, 255, 0.25);
        }

        @container home (min-width: 480px) {
          .home-milestone-banner {
            margin: 16px 32px 0;
            padding: 16px 20px 16px 22px;
          }
          .home-milestone-number { font-size: 30px; }
          .home-milestone-banner--million .home-milestone-number { font-size: 38px; }
        }

        /* Million-and-up: brighter, larger, and gently pulsing so a
           landmark crossing reads as an event, not a routine K-step. */
        .home-milestone-banner--million {
          background: linear-gradient(
            135deg,
            rgba(229, 168, 50, 0.18) 0%,
            rgba(60, 184, 120, 0.18) 100%
          );
          border-color: rgba(229, 168, 50, 0.55);
          box-shadow:
            0 8px 40px rgba(0, 0, 0, 0.50),
            0 0 40px rgba(229, 168, 50, 0.28),
            inset 0 1px 0 rgba(229, 168, 50, 0.35);
        }
        .home-milestone-banner--million .home-milestone-eyebrow {
          letter-spacing: 0.26em;
        }
        .home-milestone-banner--million .home-milestone-number {
          font-size: 32px;
        }
        .home-milestone-banner--million .home-milestone-icon {
          background: rgba(229, 168, 50, 0.20);
          box-shadow: 0 0 24px rgba(229, 168, 50, 0.45);
          animation: milestone-million-pulse 2.4s ease-in-out infinite;
        }
        @keyframes milestone-million-pulse {
          0%, 100% { box-shadow: 0 0 18px rgba(229, 168, 50, 0.35); }
          50%      { box-shadow: 0 0 34px rgba(229, 168, 50, 0.60); }
        }
        @media (prefers-reduced-motion: reduce) {
          .home-milestone-banner--million .home-milestone-icon { animation: none; }
        }
      `}</style>
    </section>
  );
}
