// MetricsTile — shared glass-card shell used by every Metrics tab
// (D1 Budget, AI Spend, Geo Coverage, Feed Failures) so they
// inherit the same finish as the Pipelines tab.
//
// The visual grammar:
//   - 3px colored top border for at-a-glance verdict scanning
//   - Glass background (rgba + backdrop-blur)
//   - Inset top-highlight + outer shadow
//   - Subtle hover scale (1.005, restrained vs Pipelines's 1.01
//     because tiles aren't tappable here — just visual rhythm)
//
// Children render the body — value + sub + progress bar etc. The
// shell is purely structural so each tab can keep its own data
// shape.

import type { ReactNode } from 'react';

export type MetricsTone =
  | 'success'   // green / draining / healthy
  | 'warning'   // amber / watch / degraded
  | 'failed'    // red / critical / impaired
  | 'inactive'  // gray / steady / paused
  | 'info'      // blue accent
  | 'default';  // muted, neutral

const TONE_BORDER: Record<MetricsTone, string> = {
  success:  'var(--sev-info)',
  warning:  'var(--sev-medium)',
  failed:   'var(--sev-critical)',
  inactive: 'var(--border-base)',
  info:     'var(--blue)',
  default:  'var(--border-base)',
};

const TONE_BORDER_FAINT: Record<MetricsTone, string> = {
  success:  'var(--sev-info-border)',
  warning:  'var(--sev-medium-border)',
  failed:   'var(--sev-critical-border)',
  inactive: 'var(--border-base)',
  info:     'var(--blue-border)',
  default:  'var(--border-base)',
};

export function MetricsTile({
  label,
  tone = 'default',
  badge,
  children,
}: {
  label: string;
  tone?: MetricsTone;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-lg overflow-hidden transition-transform hover:scale-[1.005]"
      style={{
        background: 'rgba(22,30,48,0.50)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${TONE_BORDER_FAINT[tone]}`,
        borderTop: `3px solid ${TONE_BORDER[tone]}`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 4px 24px rgba(0,0,0,0.40)',
      }}
    >
      <div className="p-3">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span
            className="font-mono text-[9px] uppercase tracking-[0.18em] truncate"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {label}
          </span>
          {badge ?? null}
        </div>
        {children}
      </div>
    </div>
  );
}
