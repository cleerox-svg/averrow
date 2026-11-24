import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useCallback } from 'react';
import { cn } from '../ui/cn';
import { readHistoryIdx } from './historyState';
import { useHref, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';

export function appHistoryIndex(): number {
  return readHistoryIdx() ?? 0;
}

/**
 * Back that returns to the previous in-app screen, or to `fallback` (a parent
 * page) when there is none.
 *
 * NOT based on `location.key === 'default'`: a redirect on arrival
 * (`<Navigate replace>`) changes the key although nothing was pushed.
 * Without window.history state (MemoryRouter) it approximates from the
 * navigation type: PUSH means an in-app entry exists behind us; POP/REPLACE
 * (initial or replaced entry) does not.
 */
export function useBack(fallback: string): { go: () => void; canGoBack: boolean } {
  const navigate = useNavigate();
  const navType = useNavigationType();
  const winIdx = readHistoryIdx();
  const canGoBack = winIdx !== null ? winIdx > 0 : navType === 'PUSH';
  const go = useCallback(() => {
    // Re-read at click time: the stack may have moved since render.
    const idx = readHistoryIdx();
    const can = idx !== null ? idx > 0 : canGoBack;
    if (can) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback, canGoBack]);
  return { go, canGoBack };
}

export interface BackLinkProps {
  fallback: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  /** Leading arrow, aria-hidden so it never joins the accessible name. Default true. */
  arrow?: boolean;
}

const BACK_CLASS =
  'inline-flex items-center gap-1.5 rounded font-mono text-[12px] tracking-[0.06em] text-[var(--text-secondary)] hover:text-[var(--primary-text)] no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-page)]';

/** Real `<a href={fallback}>`; a plain click is routed through useBack. Same look as PageHeader's back. */
export function BackLink({ fallback, children, className, style, 'aria-label': ariaLabel, arrow = true }: BackLinkProps) {
  const { go } = useBack(fallback);
  const href = useHref(fallback);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };
  return (
    <a href={href} onClick={onClick} className={cn(BACK_CLASS, className)} style={style} aria-label={ariaLabel}>
      {arrow && <span aria-hidden="true">←</span>}
      {children}
    </a>
  );
}

/**
 * Returns a function that removes search param `name` (a drawer / detail
 * opened via `?name=`). If this entry was pushed it goes Back (so the opening
 * entry is popped, not stacked); on a cold start it replaces.
 */
export function useCloseParam(name: string): () => void {
  const navigate = useNavigate();
  const navType = useNavigationType();
  const [params] = useSearchParams();
  return useCallback(() => {
    const idx = readHistoryIdx();
    const pushed = idx !== null ? idx > 0 : navType === 'PUSH';
    if (pushed) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete(name);
    const qs = next.toString();
    navigate({ search: qs ? `?${qs}` : '' }, { replace: true });
  }, [navigate, navType, params, name]);
}
