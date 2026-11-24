/**
 * `history.replaceState` that keeps the existing `window.history.state`.
 * react-router stores its entry index (`idx`) and `key` there; replacing the
 * state with `{}` erases `idx`, and every later push then stores `idx: NaN`.
 * Use this for any URL tidy-up (token strip, canonical URL) outside the router.
 */
export function replaceUrlKeepingState(url: string): void {
  const state = window.history.state as Record<string, unknown> | null;
  window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}) }, '', url);
}

/** The router's history index, or null when absent / not a non-negative integer. */
export function readHistoryIdx(): number | null {
  try {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : null;
  } catch {
    return null;
  }
}
