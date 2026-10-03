// Shared helpers for the @averrow/shared/ui kit tests.

/** Stub window.matchMedia. `reduced` controls prefers-reduced-motion. */
export function stubMatchMedia(reduced: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
