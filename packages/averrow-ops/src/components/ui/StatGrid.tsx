// Averrow Design System — StatGrid v1.0
// Responsive grid wrapper for stat cards.
// Replaces all inline grid/flex stat card containers.

import React from 'react';

export interface StatGridProps {
  children:   React.ReactNode;
  cols?:      2 | 3 | 4;      // max columns at full width
  className?: string;
  style?:     React.CSSProperties;
}

export function StatGrid({
  children,
  cols      = 4,
  className = '',
  style     = {},
}: StatGridProps) {
  // Responsive: always 2 cols on mobile, scales to cols on desktop
  const templateCols = {
    2: 'repeat(2, 1fr)',
    3: 'repeat(auto-fit, minmax(180px, 1fr))',
    4: 'repeat(auto-fit, minmax(160px, 1fr))',
  }[cols];

  return (
    <div
      className={className}
      style={{
        display:             'grid',
        gridTemplateColumns: templateCols,
        gap:                 12,
        marginBottom:        16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
