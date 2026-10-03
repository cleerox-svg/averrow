// @averrow/shared/ui — PageState
//
// One component for the five non-data states a view can be in: loading,
// empty, clear (the good empty), error and locked. `kind` is required and has
// no default on purpose: a failed query must never render as "nothing found".
//
// Merges averrow-ops `EmptyState` + `PageLoader` skeletons and the tenant
// NotificationsInbox empty/loading/error trio.
//
//   const kind = pageStateKind({ isLoading, isError, isEmpty: !rows.length });
//   if (kind) return <PageState kind={kind} onRetry={refetch} />;
//
// Roles: error => role="alert" (inline error => role="status": it is the
// stale-data banner shown above data that is still on screen); loading => role="status" + aria-busy + an
// sr-only "Loading…"; empty/clear/locked => role="status".

import { isValidElement, type ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './cn';

export type PageStateKind = 'loading' | 'empty' | 'clear' | 'error' | 'locked';
export type PageStateLayout = 'page' | 'card' | 'table' | 'inline';

export interface PageStateActionSpec {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

/** A ready-made node (e.g. a router Link styled as a Button) or a simple spec. */
export type PageStateAction = PageStateActionSpec | ReactNode;

export interface PageStateProps {
  /** Required, no default. */
  kind: PageStateKind;
  title?: string;
  description?: string;
  /** Overrides the default icon for the kind. Pass `null` to hide it. */
  icon?: ReactNode;
  action?: PageStateAction;
  secondaryAction?: PageStateAction;
  /** Error only: renders a "Try again" button. */
  onRetry?: () => void;
  /** Default `page`. */
  layout?: PageStateLayout;
  compact?: boolean;
  /** Inline error only: force role="alert" when there is no data on screen
   *  (an inline error is otherwise the polite stale-data banner). */
  assertive?: boolean;
  className?: string;
}

/**
 * Pure helper: which state (if any) replaces the data view. Order matters:
 * error beats loading beats empty, so a failure is never reported as empty.
 * Returns null when the data should render. Never returns `clear`/`locked`
 * (those are caller decisions).
 */
export function pageStateKind(s: {
  isLoading?: boolean;
  isError?: boolean;
  isEmpty?: boolean;
}): 'error' | 'loading' | 'empty' | null {
  if (s.isError) return 'error';
  if (s.isLoading) return 'loading';
  if (s.isEmpty) return 'empty';
  return null;
}

const DEFAULTS: Record<Exclude<PageStateKind, 'loading'>, { title: string; description: string }> = {
  empty: { title: 'Nothing here yet', description: 'There is nothing to show right now.' },
  clear: { title: 'All clear', description: 'Nothing needs your attention.' },
  error: {
    title: "Couldn't load this data",
    description: 'The data could not be loaded. Try again in a moment.',
  },
  locked: { title: 'Not available', description: "You don't have access to this, or it needs to be set up first." },
};

const TONE: Record<Exclude<PageStateKind, 'loading'>, { color: string; bg: string; border: string }> = {
  empty:  { color: 'var(--text-tertiary)', bg: 'var(--border-base)', border: 'var(--border-base)' },
  clear:  { color: 'var(--sev-info-text)', bg: 'var(--sev-info-bg)', border: 'var(--sev-info-border)' },
  error:  { color: 'var(--sev-critical-text)', bg: 'var(--sev-critical-bg)', border: 'var(--sev-critical-border)' },
  locked: { color: 'var(--text-tertiary)', bg: 'var(--border-base)', border: 'var(--border-base)' },
};

const svgProps = {
  width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
} as const;

const ICONS: Record<Exclude<PageStateKind, 'loading'>, ReactNode> = {
  empty: (
    <svg {...svgProps}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
  ),
  clear: (
    <svg {...svgProps}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></svg>
  ),
  error: (
    <svg {...svgProps}><path d="m10.29 3.86-8.18 14.14A2 2 0 0 0 3.82 21h16.36a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
  ),
  locked: (
    <svg {...svgProps}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
  ),
};

function isSpec(a: PageStateAction): a is PageStateActionSpec {
  return typeof a === 'object' && a !== null && !isValidElement(a) && 'label' in a && 'onClick' in a;
}

function renderAction(a: PageStateAction, fallback: 'primary' | 'secondary'): ReactNode {
  if (a == null || a === false) return null;
  if (isSpec(a)) {
    return (
      <Button size="sm" variant={a.variant ?? fallback} onClick={a.onClick}>
        {a.label}
      </Button>
    );
  }
  return a;
}

function Bar({ className }: { className: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-[var(--border-base)]', className)} />;
}

function Skeleton({ layout }: { layout: PageStateLayout }) {
  if (layout === 'table') {
    return (
      <div className="flex w-full flex-col gap-2 px-1 py-2" aria-hidden="true">
        <Bar className="h-10" />
        {Array.from({ length: 5 }, (_, i) => <Bar key={i} className="h-12" />)}
      </div>
    );
  }
  if (layout === 'card') {
    return (
      <div className="flex w-full flex-col gap-2.5" aria-hidden="true">
        <Bar className="h-4 w-1/3" />
        <Bar className="h-3 w-full" />
        <Bar className="h-3 w-4/5" />
      </div>
    );
  }
  // page
  return (
    <div className="flex w-full flex-col gap-4" aria-hidden="true">
      <Bar className="h-8 w-48" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => <Bar key={i} className="h-24 rounded-xl" />)}
      </div>
      <Bar className="h-64 rounded-xl" />
    </div>
  );
}

export function PageState({
  kind,
  title,
  description,
  icon,
  action,
  secondaryAction,
  onRetry,
  layout = 'page',
  compact = false,
  assertive = false,
  className,
}: PageStateProps) {
  if (kind === 'loading') {
    const text = title ?? 'Loading…';
    if (layout === 'inline') {
      return (
        <div role="status" aria-busy="true" className={cn('flex items-center gap-2 py-2 font-mono text-xs text-[var(--text-secondary)]', className)}>
          <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--amber)]" />
          {text}
        </div>
      );
    }
    return (
      <div
        role="status"
        aria-busy="true"
        className={cn(
          'w-full',
          layout === 'card' && 'rounded-xl border border-[var(--border-base)] bg-[var(--bg-card)] p-5',
          className,
        )}
      >
        <span className="sr-only">{text}</span>
        <Skeleton layout={layout} />
      </div>
    );
  }

  const tone = TONE[kind];
  const defaults = DEFAULTS[kind];
  const heading = title ?? defaults.title;
  const body = description ?? defaults.description;
  const glyph = icon === undefined ? ICONS[kind] : icon;
  // An inline error is the stale-data banner (a refetch failed while data is
  // still on screen), so it is polite; a blocking error with no data is assertive.
  const role = kind === 'error' && (layout !== 'inline' || assertive) ? 'alert' : 'status';

  const primary = action != null ? renderAction(action, 'primary') : null;
  const secondary = secondaryAction != null ? renderAction(secondaryAction, 'secondary') : null;
  // The accessible name carries the title so several error cards on one page
  // expose distinct "Try again" buttons (the visible label stays "Try again").
  const retry = kind === 'error' && onRetry
    ? <Button size="sm" variant={primary ? 'secondary' : 'primary'} onClick={onRetry} aria-label={`Try again: ${heading}`}>Try again</Button>
    : null;
  const hasActions = !!(primary || secondary || retry);

  if (layout === 'inline') {
    return (
      <div role={role} className={cn('flex flex-wrap items-center gap-2 py-2 text-xs', className)}>
        {glyph != null && <span aria-hidden className="flex h-4 w-4 items-center justify-center [&>svg]:h-4 [&>svg]:w-4" style={{ color: tone.color }}>{glyph}</span>}
        <span className="font-semibold text-[var(--text-primary)]">{heading}</span>
        {description !== undefined && <span className="text-[var(--text-secondary)]">{body}</span>}
        {retry}{primary}{secondary}
      </div>
    );
  }

  return (
    <div
      role={role}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        layout === 'page' && (compact ? 'px-4 py-8' : 'px-6 py-16'),
        layout === 'table' && (compact ? 'px-4 py-6' : 'px-6 py-10'),
        layout === 'card' && cn('rounded-xl border bg-[var(--bg-card)]', compact ? 'px-4 py-6' : 'px-6 py-10'),
        className,
      )}
      style={layout === 'card' ? { borderColor: tone.border } : undefined}
    >
      {glyph != null && (
        <div
          aria-hidden
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl"
          style={{ background: tone.bg, color: tone.color, border: `1px solid ${tone.border}` }}
        >
          {glyph}
        </div>
      )}
      <h3 className="mb-1 text-sm font-semibold text-[var(--text-primary)]">{heading}</h3>
      <p className="max-w-sm text-xs leading-relaxed text-[var(--text-secondary)]">{body}</p>
      {hasActions && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {retry}{primary}{secondary}
        </div>
      )}
    </div>
  );
}
