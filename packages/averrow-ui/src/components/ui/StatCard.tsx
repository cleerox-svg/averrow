// Averrow Design System — StatCard v2.0
// Unified stat card. Replaces both ui/StatCard and brands/StatCard.
// Supports both existing APIs — no callsite changes required.

import React from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { GlowNumber } from './GlowNumber';
import { cn } from '@/lib/cn';
import { resolveStatAccent } from '@/design-system/tokens';

function accentFromColor(color?: string): string {
  if (!color) return '#E5A832';
  return color;
}

// ── API A — Simple label/value stat (was ui/StatCard) ─────────────────────
interface SimpleStatCardProps {
  label:           string;
  value:           string | number;
  sublabel?:       string;
  trend?:          string;
  trendDirection?: 'up' | 'down' | 'neutral';
  accentColor?:    string;
  className?:      string;
  onClick?:        () => void;
}

function SimpleStatCard({
  label, value, sublabel, trend, trendDirection, accentColor, className, onClick,
}: SimpleStatCardProps) {
  // Zero-state rule: when value is numerically 0, render with the
  // neutral slate accent regardless of the caller's accentColor.
  // See `resolveStatAccent` for the semantics. Audit M2 (2026-05-06).
  const accent = resolveStatAccent(value, accentFromColor(accentColor));

  const containerStyle: CSSProperties = {
    padding: '16px 20px',
    position: 'relative',
    userSelect: 'none',
    cursor: onClick ? 'pointer' : undefined,
    background: 'rgba(22,30,48,0.50)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(229,168,50,0.15)',
    boxShadow: '0 0 20px rgba(229,168,50,0.05), inset 0 1px 0 rgba(255,255,255,0.04)',
    ...(accentColor && {
      borderLeftWidth: '3px',
      borderLeftStyle: 'solid',
      borderLeftColor: accent,
    }),
  };

  return (
    <div
      data-testid="stat-card"
      className={cn(
        'rounded-xl transition-all',
        accentColor && 'border-l-[3px]',
        className,
      )}
      style={containerStyle}
      onClick={onClick}
    >
      <div style={{
        position: 'absolute', right: -20, bottom: -20,
        width: 100, height: 100, borderRadius: '50%',
        background: `radial-gradient(circle, ${accent}25 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', top: 12, left: 16,
        width: 4, height: 4, borderRadius: '50%',
        background: accent,
        boxShadow: `0 0 8px ${accent}`,
      }} />

      <div style={{ marginTop: 8, position: 'relative' }}>
        <div style={{
          fontSize: 9, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.20em', color: 'rgba(255,255,255,0.40)',
          textTransform: 'uppercase', marginBottom: 6,
        }}>
          {label}
        </div>

        {typeof value === 'number' ? (
          <GlowNumber value={value} color={accent} size="lg" animate />
        ) : (
          <span style={{
            fontSize: 28, fontWeight: 900, fontFamily: 'var(--font-mono)',
            color: accent, letterSpacing: -1, lineHeight: 1,
            textShadow: `0 0 20px ${accent}60, 0 0 40px ${accent}30`,
          }}>
            {value}
          </span>
        )}

        {sublabel && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 4 }}>
            {sublabel}
          </div>
        )}
        {trend && (
          <div
            className={cn(
              'font-mono text-[10px] mt-1',
              trendDirection === 'up'
                ? 'text-positive'
                : trendDirection === 'down'
                ? 'text-accent'
                : 'text-white/55',
            )}
          >
            {trend}
          </div>
        )}
      </div>
    </div>
  );
}

// ── API B — Detail layout (was brands/StatCard) ────────────────────────────
interface DetailStatCardProps {
  title:       ReactNode;
  children:    ReactNode;
  metric:      ReactNode;
  metricLabel: ReactNode;
  className?:  string;
  onClick?:    () => void;
}

function DetailStatCard({
  title, children, metric, metricLabel, className, onClick,
}: DetailStatCardProps) {
  // Container-query: when the card is narrow (e.g. 2-col mobile grid), stack
  // the metric block above the children so the big number doesn't crowd the
  // severity-count rows. Audit Rsp5 (2026-05-06).
  return (
    <div
      data-testid="stat-card"
      className={cn('detail-stat-card rounded-xl transition-all', className)}
      onClick={onClick}
      style={{
        padding: '14px 16px',
        cursor: onClick ? 'pointer' : undefined,
        background: 'rgba(22,30,48,0.50)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(229,168,50,0.15)',
        boxShadow: '0 0 20px rgba(229,168,50,0.05), inset 0 1px 0 rgba(255,255,255,0.04)',
        containerType: 'inline-size',
      }}
    >
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.20em', color: 'rgba(255,255,255,0.40)',
        textTransform: 'uppercase', marginBottom: 10,
      }}>
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
    </div>
  );
}

// ── Unified export ─────────────────────────────────────────────────────────
type StatCardProps =
  | (SimpleStatCardProps & { title?: undefined; metric?: undefined; metricLabel?: undefined })
  | DetailStatCardProps;

export function StatCard(props: StatCardProps) {
  if ('title' in props && props.title !== undefined) {
    return <DetailStatCard {...(props as DetailStatCardProps)} />;
  }
  return <SimpleStatCard {...(props as SimpleStatCardProps)} />;
}

export { SimpleStatCard, DetailStatCard };
export type { SimpleStatCardProps, DetailStatCardProps, StatCardProps };
