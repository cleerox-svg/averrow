import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useCallback } from 'react';
import { useHref, useNavigate, useNavigationType } from 'react-router-dom';

/**
 * Index of this entry in the SPA's own history stack, read from
 * react-router's BrowserRouter state (`window.history.state.idx`, written by
 * createBrowserHistory: 0 on the first entry of the document, +1 per push,
 * unchanged by replace). Returns 0 on a cold start (deep link, push
 * notification open, full reload) and -1 when the router does not use
 * window.history (MemoryRouter in tests), so callers can fall back.
 */
function readWindowIdx(): number {
  try {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    return typeof idx === 'number' ? idx : -1;
  } catch {
    return -1;
  }
}

export function appHistoryIndex(): number {
  return Math.max(0, readWindowIdx());
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
  const winIdx = readWindowIdx();
  const canGoBack = winIdx >= 0 ? winIdx > 0 : navType === 'PUSH';
  const go = useCallback(() => {
    // Re-read at click time: the stack may have moved since render.
    const idx = readWindowIdx();
    const can = idx >= 0 ? idx > 0 : canGoBack;
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
}

/** Real `<a href={fallback}>`; a plain click is routed through useBack. */
export function BackLink({ fallback, children, className, style, 'aria-label': ariaLabel }: BackLinkProps) {
  const { go } = useBack(fallback);
  const href = useHref(fallback);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };
  return (
    <a href={href} onClick={onClick} className={className} style={style} aria-label={ariaLabel}>
      {children}
    </a>
  );
}
