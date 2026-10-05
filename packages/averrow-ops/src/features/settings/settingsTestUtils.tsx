// Shared helpers for the Settings page tests (jsdom gaps + viewport stub).

export function installDomStubs(): void {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
}

/** `desktop` answers every (min-width) query; phones answer (max-width) (the overlay sheet switch). */
export function stubViewport(desktop: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width') ? desktop : query.includes('max-width') ? !desktop : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
