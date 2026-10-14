// @averrow/shared/ui — StatTile
//
// KPI tile ("Instrument glass"): gradient-hairline surface, sans label, big
// count-up number, optional delta chip, sparkline, sub-line, critical pill and
// footer. Styles live in theme/tokens.css (`.ds-stat*`). API from averrow-ops
// `components/ui/StatTile`.
//
// States
//   value === null            loading: "—" + aria-busy (never a misleading 0)
//   value === null + error    "Couldn't load", not busy; root aria-label
//                             `<label>: couldn't load` / `<label>: loading`
//   value === 0               neutral accent (resolveStatAccent), calm not alarming
//   onClick                   renders a real <button>
//   asChild                   renders the single child element (e.g. a router
//                             <Link>) as the tile root; no router import here.
//   live                      animated conic hairline; only when value > 0.
//                             At most ONE live tile per page.

import type { CSSProperties, HTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { cn } from './cn';
import { useCountUp } from './lib/useCountUp';
import { resolveStatAccent, statNumeric, STAT_NEUTRAL } from './lib/stat-accent';
import { COMPACT_FROM, formatCompact, formatFull } from './lib/compact-number';

export type StatTone = 'amber' | 'red' | 'blue' | 'green' | 'neutral';

const TONE_COLOR: Record<StatTone, string> = {
  amber: 'var(--amber)',
  red: 'var(--red)',
  blue: 'var(--blue)',
  green: 'var(--green)',
  neutral: STAT_NEUTRAL,
};

export interface StatTileProps
  extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'onClick'> {
  label: string;
  /** `null` = still loading. Pass a real value (including a genuine 0) once settled. */
  value: number | string | null;
  sub?: string;
  /** Accent from the brand palette. Ignored when `accent` is given. Default `neutral`. */
  tone?: StatTone;
  /** Raw CSS colour accent (overrides `tone`). Zero values still go neutral. */
  accent?: string;
  /** When > 0, shows a red count pill in the corner. */
  critical?: number;
  /** The owning query failed. With `value === null` shows "Couldn't load". */
  error?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
  /** Render the single child element as the root (Radix Slot), e.g. `<Link>`. */
  asChild?: boolean;
  /** Required when `asChild`: the element to render as the tile root. */
  children?: ReactNode;
  /** Non-interactive content under the sub-line (it may sit inside a button). */
  footer?: ReactNode;
  /** Change chip beside the label. `label` is the accessible text and must say what it compares to. */
  delta?: StatDelta;
  /** Series for an inline sparkline under the number (needs >= 2 points). */
  trend?: number[];
  /** Animated hairline for the one tile that needs action. Ignored unless value > 0. */
  live?: boolean;
  /**
   * Show a numeric value >= 10,000 in compact form ("76.7K") so it never clips in a narrow tile. The full value
   * stays available: `title` on hover and a screen-reader-only copy. Text values and smaller numbers are unchanged.
   */
  compact?: boolean;
}

export interface StatDelta {
  value: string;
  tone?: 'good' | 'bad' | 'neutral';
  /** e.g. "412 more than yesterday" (aria-label). */
  label?: string;
}

/** Characters the settled value is shown with (never fewer than 3: a one-digit tile keeps the full size). */
function fitChars(value: number | string, compacted: boolean): number {
  const text = typeof value === 'number' ? (compacted ? formatCompact(value) : formatFull(value)) : value;
  return Math.max(3, text.length);
}

const TREND_W = 100;
const TREND_H = 26;
const TREND_PAD = 3;

function Trend({ points }: { points: number[] }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const flat = max === min;
  const xs = points.map((_, i) => (i / (points.length - 1)) * TREND_W);
  const ys = points.map((p) =>
    flat ? TREND_H / 2 : TREND_PAD + (1 - (p - min) / (max - min)) * (TREND_H - TREND_PAD * 2),
  );
  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${ys[i]!.toFixed(2)}`).join(' ');
  const area = `${line} L${TREND_W},${TREND_H} L0,${TREND_H} Z`;
  return (
    <span aria-hidden className="ds-stat-trend-wrap relative block" data-testid="stat-trend" data-points={points.length}>
      <svg className="ds-stat-trend" viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none">
        {flat ? (
          <line className="ds-stat-trend-flat" x1="0" x2={TREND_W} y1={TREND_H / 2} y2={TREND_H / 2} />
        ) : (
          <>
            <path className="ds-stat-trend-area" d={area} />
            <path className="ds-stat-trend-line" d={line} />
          </>
        )}
      </svg>
      {!flat && (
        <span
          className="ds-stat-trend-dot absolute"
          style={{ left: '100%', top: `${(ys[ys.length - 1]! / TREND_H) * 100}%` }}
        />
      )}
    </span>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
  accent: accentProp,
  critical,
  error = false,
  onClick,
  asChild = false,
  children,
  footer,
  delta,
  trend,
  live = false,
  compact = false,
  className,
  ...rest
}: StatTileProps) {
  const isNull = value == null;
  const failed = isNull && error;
  const loading = isNull && !error;
  const accent = resolveStatAccent(value, accentProp ?? TONE_COLOR[tone]);
  // Hooks run unconditionally regardless of loading state.
  const counted = useCountUp(typeof value === 'number' ? value : 0);
  const isCompact = compact && typeof value === 'number' && Math.abs(value) >= COMPACT_FROM;
  const display = isNull
    ? '—'
    : typeof value === 'number' ? (isCompact ? formatCompact(counted) : formatFull(counted)) : value;
  const critCount = critical ?? 0;
  const clickable = !!onClick || asChild;

  const isLive = live && !isNull && statNumeric(value) > 0;
  const showTrend = !!trend && trend.length >= 2;
  const deltaChip = delta && !isNull ? (
    <span
      role="img"
      aria-label={delta.label ?? delta.value}
      data-tone={delta.tone ?? 'neutral'}
      className={cn('ds-stat-delta', critCount > 0 && 'ds-stat-delta--inline')}
    >
      {delta.value}
    </span>
  ) : null;

  const inner = (
    <>
      {critCount > 0 && (
        <span aria-label={`${critCount} critical`} className="ds-stat-crit">
          {critCount}
        </span>
      )}
      <span className="ds-stat-head">
        <span className="ds-stat-label">
          {label}
          {critCount > 0 ? deltaChip : null}
        </span>
        {critCount > 0 ? null : deltaChip}
      </span>
      {compact && !isNull ? (
        // The value scales to the tile (container query, sized by its final length so it does not jump while counting
        // up): a 6-character count in a 140px tile shrinks instead of clipping.
        <span className="ds-stat-fit">
          <span
            className="ds-stat-value ds-stat-value--fit"
            title={isCompact ? formatFull(value) : undefined}
            style={{ '--ds-stat-chars': fitChars(value, isCompact) } as CSSProperties}
          >
            <span aria-hidden={isCompact || undefined}>{display}</span>
            {isCompact ? <span className="sr-only">{formatFull(value)}</span> : null}
          </span>
        </span>
      ) : (
        <span className={cn('ds-stat-value', (loading || failed) && 'ds-stat-value--muted')}>{display}</span>
      )}
      {showTrend && !loading && !failed ? <Trend points={trend} /> : null}
      {failed ? (
        <span className="ds-stat-sub">Couldn't load</span>
      ) : sub ? (
        <span className="ds-stat-sub">{sub}</span>
      ) : null}
      {footer ? <span className="ds-stat-foot">{footer}</span> : null}
      {clickable && (
        <span aria-hidden className="ds-stat-hint">
          View →
        </span>
      )}
    </>
  );

  const cls = cn('ds-stat', clickable && 'ds-stat--interactive', isLive && 'ds-stat--live', critCount > 0 && 'ds-stat--crit', isNull && 'ds-stat--idle', className);
  const styleProp = { ...(rest.style ?? {}), '--st-accent': accent } as CSSProperties;
  // The accessible name carries the state so it is announced on the tile
  // itself (no nested live region). Healthy tiles keep their content name.
  const stateName = failed ? `${label}: couldn't load` : loading ? `${label}: loading` : undefined;
  const aria = {
    ...(loading ? { 'aria-busy': true as const } : {}),
    ...(stateName ? { 'aria-label': stateName } : {}),
  };

  if (asChild) {
    return (
      <Slot className={cls} {...aria} onClick={onClick} {...rest} style={styleProp}>
        <Slottable>{children}</Slottable>
        {inner}
      </Slot>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} {...aria} onClick={onClick} {...(rest as HTMLAttributes<HTMLButtonElement>)} style={styleProp}>
        {inner}
      </button>
    );
  }
  // aria-label on a plain div is ignored without a role, so the state name
  // needs role="group" to be exposed.
  return (
    <div className={cls} {...aria} {...(stateName ? { role: 'group' } : {})} {...rest} style={styleProp}>
      {inner}
    </div>
  );
}
