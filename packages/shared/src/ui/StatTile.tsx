// @averrow/shared/ui — StatTile
//
// KPI tile: label, big count-up number, optional sub-line, optional critical
// pill and footer. API from averrow-ops `components/ui/StatTile`; look and
// error state from the v4 console `KpiTile` (glow orb, mono label).
//
// States
//   value === null            loading: "—" + aria-busy (never a misleading 0)
//   value === null + error    "Couldn't load", not busy (glow dimmed); root aria-label
//                             `<label>: couldn't load` / `<label>: loading`
//   value === 0               neutral accent (resolveStatAccent), calm not alarming
//   onClick                   renders a real <button>
//   asChild                   renders the single child element (e.g. a router
//                             <Link>) as the tile root; no router import here.

import type { HTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { cn } from './cn';
import { useCountUp } from './lib/useCountUp';
import { resolveStatAccent, STAT_NEUTRAL } from './lib/stat-accent';

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
}

const ROOT =
  'group relative block w-full overflow-hidden text-left font-[inherit] text-[var(--text-primary)] no-underline ' +
  'rounded-[18px] px-5 pt-[18px] pb-4 border border-[var(--border-base)] ' +
  '[background:linear-gradient(160deg,var(--bg-card),var(--bg-card-deep))] shadow-[var(--card-shadow)] ' +
  'max-sm:rounded-xl max-sm:px-3.5 max-sm:py-2.5';

const INTERACTIVE =
  'cursor-pointer pb-6 transition-[transform,border-color,box-shadow] duration-150 ' +
  'hover:-translate-y-0.5 hover:border-[var(--amber-border)] hover:shadow-[var(--card-shadow),0_0_22px_color-mix(in_srgb,var(--amber)_14%,transparent)] ' +
  'motion-reduce:transition-none motion-reduce:hover:translate-y-0 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--amber)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-page)]';

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
  className,
  ...rest
}: StatTileProps) {
  const isNull = value == null;
  const failed = isNull && error;
  const loading = isNull && !error;
  const accent = resolveStatAccent(value, accentProp ?? TONE_COLOR[tone]);
  // Hooks run unconditionally regardless of loading state.
  const counted = useCountUp(typeof value === 'number' ? value : 0);
  const display = isNull
    ? '—'
    : typeof value === 'number' ? counted.toLocaleString('en-US') : value;
  const critCount = critical ?? 0;
  const clickable = !!onClick || asChild;

  const inner = (
    <>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -right-[34px] -top-[34px] h-[130px] w-[130px] rounded-full blur-[36px] max-sm:h-[70px] max-sm:w-[70px] max-sm:blur-[24px]',
          // A loading or failed tile must not glow like a live red/amber alert.
          loading || failed ? 'opacity-20' : 'opacity-[0.55]',
        )}
        style={{ background: accent }}
      />
      {critCount > 0 && (
        <span
          aria-label={`${critCount} critical`}
          className="absolute right-2.5 top-2.5 rounded-full px-2 py-0.5 font-mono text-[9px] font-extrabold text-white"
          style={{
            background: 'linear-gradient(135deg, var(--red), var(--red-dim))',
            border: '1px solid var(--sev-critical-border)',
          }}
        >
          {critCount}
        </span>
      )}
      <span className="relative block font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)] max-sm:text-[9.5px]">
        {label}
      </span>
      <span
        className={cn(
          'relative mt-2.5 block text-[42px] font-extrabold leading-[1.05] tracking-[-1.5px] tabular-nums max-sm:mt-0.5 max-sm:text-[26px] max-sm:tracking-[-1px]',
          loading || failed ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
        )}
        style={loading || failed ? undefined : { textShadow: `0 0 28px color-mix(in srgb, ${accent} 48%, transparent)` }}
      >
        {display}
      </span>
      {failed ? (
        <span className="relative mt-2 block font-mono text-[11px] text-[var(--text-secondary)]">
          Couldn't load
        </span>
      ) : sub ? (
        <span className="relative mt-2 block font-mono text-[11px] leading-snug text-[var(--text-secondary)] max-sm:mt-1 max-sm:text-[10px]">{sub}</span>
      ) : null}
      {footer ? <span className="relative mt-3 block">{footer}</span> : null}
      {clickable && (
        <span
          aria-hidden
          className="absolute bottom-[13px] right-4 font-mono text-[10.5px] tracking-[0.04em] text-[var(--text-tertiary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 max-sm:hidden motion-reduce:transition-none"
        >
          View →
        </span>
      )}
    </>
  );

  const cls = cn(ROOT, clickable && INTERACTIVE, className);
  // The accessible name carries the state so it is announced on the tile
  // itself (no nested live region). Healthy tiles keep their content name.
  const stateName = failed ? `${label}: couldn't load` : loading ? `${label}: loading` : undefined;
  const aria = {
    ...(loading ? { 'aria-busy': true as const } : {}),
    ...(stateName ? { 'aria-label': stateName } : {}),
  };

  if (asChild) {
    return (
      <Slot className={cls} {...aria} onClick={onClick} {...rest}>
        <Slottable>{children}</Slottable>
        {inner}
      </Slot>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} {...aria} onClick={onClick} {...(rest as HTMLAttributes<HTMLButtonElement>)}>
        {inner}
      </button>
    );
  }
  // aria-label on a plain div is ignored without a role, so the state name
  // needs role="group" to be exposed.
  return (
    <div className={cls} {...aria} {...(stateName ? { role: 'group' } : {})} {...rest}>
      {inner}
    </div>
  );
}
