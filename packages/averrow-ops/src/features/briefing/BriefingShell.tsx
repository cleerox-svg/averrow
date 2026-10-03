// The shared briefing shell (see Briefing.tsx for the public entry point).
//
// It owns what both bodies share: the card, header (eyebrow, title, freshness),
// an action slot, and the loading / error / empty states via PageState. A body
// decides which state applies and hands the shell its content. Kept in its own
// module so the bodies can import it without a cycle through Briefing.tsx.

import type { ReactNode } from 'react';
import { Badge, Card, PageState } from '@/design-system/components';
import type { BadgeStatus } from '@/design-system/components';
import { parseUtc } from '@/lib/time';

export type BriefingSource = 'intelligence' | 'ops';

export type BriefingStatus = 'loading' | 'error' | 'empty' | 'ready';

export interface BriefingShellProps {
  /** Which body this shell hosts. Exposed as `data-briefing-source`. */
  source: BriefingSource;
  title: string;
  /** Small badges above the title (agent, overall status). */
  eyebrow?: ReactNode;
  /** ISO / D1 timestamp the content was generated; drives the freshness badge. */
  generatedAt?: string | null;
  /** Extra mono text beside the freshness (trigger, etc.). */
  meta?: ReactNode;
  /** Action slot, top right (Run Briefing Now). Rendered in every state it is given in. */
  actions?: ReactNode;
  /** Live-region content under the header (generate result). */
  notice?: ReactNode;
  status: BriefingStatus;
  onRetry?: () => void;
  errorTitle?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  loadingTitle?: string;
  children?: ReactNode;
}

export interface Freshness {
  label: 'FRESH' | 'TODAY' | 'STALE';
  status: BadgeStatus;
}

/** < 1h FRESH, < 24h TODAY, otherwise STALE. Null for a missing/invalid date. */
export function briefingFreshness(generatedAt: string | null | undefined, now: number = Date.now()): Freshness | null {
  if (!generatedAt) return null;
  const t = parseUtc(generatedAt).getTime();
  if (Number.isNaN(t)) return null;
  const age = now - t;
  const hour = 60 * 60 * 1000;
  if (age < hour) return { label: 'FRESH', status: 'active' };
  if (age < 24 * hour) return { label: 'TODAY', status: 'running' };
  return { label: 'STALE', status: 'warning' };
}

export function BriefingShell({
  source, title, eyebrow, generatedAt, meta, actions, notice, status, onRetry,
  errorTitle = "Couldn't load the briefing",
  emptyTitle = 'No briefing generated yet',
  emptyDescription,
  loadingTitle = 'Loading briefing…',
  children,
}: BriefingShellProps) {
  const freshness = status === 'ready' ? briefingFreshness(generatedAt) : null;

  return (
    <Card data-briefing-source={source} padding="lg" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow && <div className="mb-1.5 flex flex-wrap items-center gap-2">{eyebrow}</div>}
          <h2 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)', margin: 0 }}>
            {title}
          </h2>
          {status === 'ready' && (generatedAt || meta) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
              {generatedAt && (
                <span>
                  Generated {parseUtc(generatedAt).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              )}
              {meta}
              {freshness && <Badge status={freshness.status} label={freshness.label} size="xs" />}
            </div>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>

      {notice}

      {status === 'loading' && <PageState kind="loading" layout="inline" compact title={loadingTitle} />}
      {status === 'error' && (
        <PageState kind="error" layout="inline" assertive compact title={errorTitle} onRetry={onRetry} />
      )}
      {status === 'empty' && (
        <PageState kind="empty" layout="inline" compact title={emptyTitle} description={emptyDescription} />
      )}
      {status === 'ready' && children}
    </Card>
  );
}
