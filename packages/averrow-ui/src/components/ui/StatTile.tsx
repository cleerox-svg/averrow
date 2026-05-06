// Averrow Design System — StatTile
//
// Animated, accent-tinted stat card. Shows a count-up number with a
// label, optional sub-line, and an optional critical-count pill in
// the corner. Self-contained (no DeepCard dependency) so it can be
// composed alongside any card chrome.
//
// Originally lived in components/mobile/MobileUIKit.tsx; promoted to
// the shared design system as part of the unified Home work.

import { useCountUp } from '@/design-system/hooks/useCountUp';
import { resolveStatAccent } from '@/design-system/tokens';

export interface StatTileProps {
  label:     string;
  value:     number | string;
  sub?:      string;
  /**
   * Hex color used for the number text, accent dot, and radial halo.
   *
   * Note: when `value` is numerically 0, this is overridden to the
   * neutral slate (`M.NEUTRAL`) regardless. Kills the red-on-zero
   * anti-pattern: "0 ALERTS" renders calm, not alarming.
   * See `resolveStatAccent`. Audit M2 (2026-05-06).
   */
  accent:    string;
  /** When > 0, renders a red count badge in the top-right corner. */
  critical?: number;
  onClick?:  () => void;
}

export function StatTile({
  label,
  value,
  sub,
  accent: rawAccent,
  critical,
  onClick,
}: StatTileProps) {
  const accent = resolveStatAccent(value, rawAccent);
  const counted = useCountUp(typeof value === 'number' ? value : 0);
  const display = typeof value === 'number' ? counted.toLocaleString() : value;
  const isCrit  = (critical ?? 0) > 0;

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={{
        position: 'relative',
        padding: '16px 14px',
        borderRadius: 16,
        background: `linear-gradient(150deg, rgba(22,30,48,0.90), ${accent}18 70%, rgba(12,18,32,0.98))`,
        border: `1px solid ${accent}30`,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        userSelect: 'none',
        boxShadow: [
          '0 8px 32px rgba(0,0,0,0.6)',
          `0 0 20px ${accent}18`,
          `inset 0 1px 0 ${accent}30`,
          'inset 0 -1px 0 rgba(0,0,0,0.3)',
        ].join(','),
      }}
    >
      {/* Top rim highlight */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: 1,
          pointerEvents: 'none',
          zIndex: 2,
          background: `linear-gradient(90deg, transparent, ${accent}40 30%, ${accent}40 70%, transparent)`,
        }}
      />
      {/* Bottom shadow line */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          bottom: 0, left: 0, right: 0,
          height: 1,
          background: 'rgba(0,0,0,0.5)',
          pointerEvents: 'none',
          zIndex: 2,
        }}
      />
      {/* Accent halo (bottom-right radial glow) */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          right: -20, bottom: -20,
          width: 100, height: 100,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${accent}35, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />
      {/* Accent dot (top-left) */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 12, left: 14,
          width: 4, height: 4,
          borderRadius: '50%',
          background: accent,
          boxShadow: `0 0 8px ${accent}`,
        }}
      />
      {/* Critical count pill (top-right) */}
      {isCrit && (
        <div style={{
          position: 'absolute',
          top: 10, right: 10,
          background: 'linear-gradient(135deg, #C83C3C, #8B1A1A)',
          borderRadius: 99,
          padding: '2px 8px',
          fontSize: 9, fontWeight: 800,
          color: '#fff',
          fontFamily: 'monospace',
          boxShadow: '0 2px 8px rgba(239,68,68,0.5), inset 0 1px 0 rgba(255,255,255,0.2)',
          border: '1px solid rgba(239,68,68,0.5)',
        }}>
          {critical}
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <div style={{
          fontSize: 30, fontWeight: 900, lineHeight: 1,
          fontFamily: 'monospace', letterSpacing: -1,
          color: accent,
          textShadow: `0 0 20px ${accent}60, 0 0 40px ${accent}30`,
        }}>
          {display}
        </div>
        <div style={{
          fontSize: 9, fontFamily: 'monospace',
          letterSpacing: '0.20em',
          color: 'rgba(255,255,255,0.50)',
          marginTop: 7,
          textTransform: 'uppercase',
        }}>
          {label}
        </div>
        {sub && (
          <div style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.30)',
            marginTop: 3,
          }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}
