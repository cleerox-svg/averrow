// Averrow Design System — BreakdownCard
//
// Titled card with a big headline metric on one side and a breakdown (severity
// counts, sector chips, …) on the other. This is the old `DetailStatCard`
// rebuilt on the shared `Card`; it is NOT a KPI tile (use the shared
// `StatTile` for a single label/value stat).
//
// Layout lives in the `.detail-stat-*` rules in @averrow/shared/theme
// (tokens.css): side-by-side by default, stacked below 220px container width
// so the metric doesn't crowd the rows in a 2-col mobile grid (Audit Rsp5).

import type { CSSProperties, ReactNode } from 'react';
import { Card, cn } from '@averrow/shared/ui';

export interface BreakdownCardProps {
  title: ReactNode;
  /** The headline number / glyph shown opposite the breakdown. */
  metric: ReactNode;
  metricLabel: ReactNode;
  /** The breakdown rows. */
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function BreakdownCard({
  title, metric, metricLabel, children, className, style,
}: BreakdownCardProps) {
  return (
    <Card
      data-testid="breakdown-card"
      className={cn('detail-stat-card px-4 py-3.5', className)}
      style={{ containerType: 'inline-size', ...style }}
    >
      <div className="mb-2.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--text-tertiary)]">
        {title}
      </div>

      <div className="detail-stat-row">
        <div className="detail-stat-children">{children}</div>

        <div className="detail-stat-divider" />

        <div className="detail-stat-metric">
          <div className="detail-stat-metric-value">{metric}</div>
          <div className="detail-stat-metric-label">{metricLabel}</div>
        </div>
      </div>
    </Card>
  );
}
