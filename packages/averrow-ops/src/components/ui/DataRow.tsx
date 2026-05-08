// Averrow Design System — DataRow v1.0
// Shared clickable row for all tables and lists platform-wide.
// Built-in: hover amber left border, severity-aware hover, unread state.
// Replaces all inline div/tr row implementations.

import React from 'react';
import type { Severity } from './Badge';

export interface DataRowProps {
  children:   React.ReactNode;
  severity?:  Severity;
  unread?:    boolean;     // brighter left border + bold styling signal
  onClick?:   () => void;
  className?: string;
  style?:     React.CSSProperties;
  // Pass-through for table usage
  as?: 'div' | 'tr';
}

const SEV_COLORS: Record<Severity, string> = {
  critical: 'var(--sev-critical)',
  high:     'var(--sev-high)',
  medium:   'var(--sev-medium)',
  low:      'var(--sev-low)',
  info:     'var(--sev-info)',
};

const SEV_BG: Record<Severity, string> = {
  critical: 'var(--sev-critical-bg)',
  high:     'var(--sev-high-bg)',
  medium:   'var(--sev-medium-bg)',
  low:      'var(--sev-low-bg)',
  info:     'var(--sev-info-bg)',
};

export function DataRow({
  children,
  severity,
  unread    = false,
  onClick,
  className = '',
  style     = {},
  as        = 'div',
}: DataRowProps) {
  const dotColor = severity ? SEV_COLORS[severity] : 'var(--amber)';
  const bgColor  = severity ? SEV_BG[severity] : 'var(--amber-glow)';

  const baseStyle: React.CSSProperties = {
    borderLeft:  `2px solid ${unread ? dotColor : 'transparent'}`,
    background:  unread ? `linear-gradient(90deg, ${bgColor} 0%, transparent 30%)` : 'transparent',
    cursor:      onClick ? 'pointer' : 'default',
    transition:  'var(--transition-fast)',
    position:    'relative',
    ...style,
  };

  const hoverClass = severity
    ? `data-row data-row--${severity}`
    : 'data-row';

  const props = {
    onClick,
    className: `${hoverClass} ${className}`.trim(),
    style:     baseStyle,
  };

  if (as === 'tr') {
    return <tr {...props}>{children}</tr>;
  }

  return <div {...props}>{children}</div>;
}

// ── SeverityDot — small glowing dot for row indicators ─────────────────────
export interface SeverityDotProps {
  severity:  Severity;
  size?:     number;
  pulse?:    boolean;
}

export function SeverityDot({ severity, size = 8, pulse = false }: SeverityDotProps) {
  const color = SEV_COLORS[severity];
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {pulse && (
        <div style={{
          position:     'absolute',
          inset:        0,
          borderRadius: '50%',
          background:   color,
          opacity:      0.65,
          animation:    'live-ping 1.6s ease-in-out infinite',
        }} />
      )}
      <div style={{
        position:     'relative',
        width:        size,
        height:       size,
        borderRadius: '50%',
        background:   color,
        boxShadow:    `0 0 ${size}px ${color}80`,
      }} />
    </div>
  );
}
