// Averrow Design System — SeverityPill
//
// Small uppercase severity pill — distinct from the Badge component
// (which has its own size scale + status mode + pulse) and from
// SeverityChip (which is just a Badge wrapper). SeverityPill matches
// the original mobile aesthetic: tight letter-spacing, glow shadow,
// always-uppercase label.
//
// Originally lived in components/mobile/MobileUIKit.tsx as SevChip;
// promoted to the shared design system as part of the unified-Home
// rebuild.

import { SEV } from '@/design-system/tokens';

export interface SeverityPillProps {
  /** "critical" | "high" | "medium" | "low" | "info". Falls back to "low" for unknown values. */
  severity: string;
}

export function SeverityPill({ severity }: SeverityPillProps) {
  const s = SEV[severity] ?? SEV.low;
  return (
    <span
      style={{
        fontSize: 9, fontFamily: 'monospace', fontWeight: 800,
        textTransform: 'uppercase', letterSpacing: '0.12em',
        padding: '3px 8px', borderRadius: 99,
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.text,
        boxShadow: `inset 0 1px 0 ${s.dot}30, 0 2px 8px ${s.dot}20`,
      }}
    >
      {severity}
    </span>
  );
}
