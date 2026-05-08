// Averrow UI Standard — LiveIndicator v1.0
// Pulsing live status dot. Used on Observatory, Agents, feeds.
// Accepts standard sizes 'sm'|'md' plus legacy 'xs' for back-compat.
// See AVERROW_UI_STANDARD.md for full spec.

export interface LiveIndicatorProps {
  label?:  string;
  active?: boolean;
  color?:  string;
  size?:   'xs' | 'sm' | 'md';
}

export function LiveIndicator({
  label  = 'LIVE',
  active = true,
  color  = '#22c55e',
  size   = 'sm',
}: LiveIndicatorProps) {
  const dotSize  = size === 'md' ? 10 : size === 'xs' ? 6 : 8;
  const fontSize = size === 'md' ? 9  : size === 'xs' ? 8 : 8;

  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ position:'relative', width:dotSize, height:dotSize, flexShrink:0 }}>
        {active && (
          <div style={{
            position:  'absolute',
            inset:     0,
            borderRadius: '50%',
            background: color,
            opacity:   0.65,
            animation: 'live-ping 1.6s ease-in-out infinite',
          }} />
        )}
        <div style={{
          position:     'relative',
          width:        dotSize,
          height:       dotSize,
          borderRadius: '50%',
          background:   active ? color : 'rgba(255,255,255,0.20)',
          boxShadow:    active ? `0 0 ${dotSize}px ${color}90` : 'none',
        }} />
      </div>
      {label && (
        <span style={{
          fontSize,
          fontFamily:    'monospace',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color:         active ? 'rgba(255,255,255,0.50)' : 'rgba(255,255,255,0.25)',
        }}>
          {label}
        </span>
      )}
    </div>
  );
}
