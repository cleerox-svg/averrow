// Averrow Design System — Avatar v1.0
// Standard avatar component for brands, users, orgs, threat actors.
// Solid gradient fill + rim lighting. Supports favicon URL with severity dot.

import { useState } from 'react';

export type AvatarSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AvatarProps {
  name:        string;
  color?:      string;
  dimColor?:   string;
  size?:       number;
  radius?:     number;
  fontSize?:   number;
  faviconUrl?: string;
  severity?:   AvatarSeverity | string;
  style?:      React.CSSProperties;
}

const SEV_DOTS: Record<string, string> = {
  critical: '#f87171',
  high:     '#fb923c',
  medium:   '#fbbf24',
  low:      '#60a5fa',
  info:     '#4ade80',
};

export function Avatar({
  name,
  color = '#C83C3C',
  dimColor,
  size = 40,
  radius = 12,
  fontSize,
  faviconUrl,
  severity,
  style = {},
}: AvatarProps) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const dim = dimColor ?? `${color}88`;
  const fs  = fontSize ?? Math.round(size * 0.375);
  const dot = severity ? SEV_DOTS[severity] : null;
  const dotSize = Math.round(size * 0.28);

  if (faviconUrl && !faviconFailed) {
    return (
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0, ...style }}>
        <div style={{
          position: 'absolute', inset: 0, borderRadius: radius,
          background: 'linear-gradient(145deg, rgba(25,35,55,0.95), rgba(10,15,28,0.98))',
          border: `1.5px solid ${dot ? dot + '40' : 'rgba(255,255,255,0.09)'}`,
          boxShadow: [
            '0 4px 14px rgba(0,0,0,0.70)',
            'inset 0 1px 0 rgba(255,255,255,0.10)',
            dot ? `0 0 0 3px ${dot}15` : '',
          ].filter(Boolean).join(', '),
          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        }}>
          <img
            src={faviconUrl}
            width={Math.round(size * 0.55)}
            height={Math.round(size * 0.55)}
            alt={name}
            onError={() => setFaviconFailed(true)}
            style={{ objectFit: 'contain', display: 'block' }}
          />
        </div>
        {dot && (
          <div style={{
            position: 'absolute', bottom: -2, right: -2,
            width: dotSize, height: dotSize, borderRadius: '50%',
            background: dot, border: '2px solid #060A14',
            boxShadow: `0 0 6px ${dot}80`,
          }} />
        )}
      </div>
    );
  }

  return (
    <div style={{
      position: 'relative',
      width: size, height: size, borderRadius: radius, flexShrink: 0,
      background: `linear-gradient(145deg, ${color}, ${dim})`,
      border: `1px solid ${color}70`,
      boxShadow: [
        `0 ${Math.round(size * 0.10)}px ${Math.round(size * 0.35)}px rgba(0,0,0,0.70)`,
        'inset 0 1px 0 rgba(255,255,255,0.28)',
        'inset 0 -1px 0 rgba(0,0,0,0.45)',
        `0 0 ${Math.round(size * 0.45)}px ${color}35`,
      ].join(', '),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: fs, fontWeight: 900, color: '#fff',
      textShadow: '0 1px 3px rgba(0,0,0,0.65)', userSelect: 'none',
      ...style,
    }}>
      {(name[0] ?? '?').toUpperCase()}
      {dot && (
        <div style={{
          position: 'absolute', bottom: -2, right: -2,
          width: dotSize, height: dotSize, borderRadius: '50%',
          background: dot, border: '2px solid #060A14',
          boxShadow: `0 0 6px ${dot}80`,
        }} />
      )}
    </div>
  );
}
