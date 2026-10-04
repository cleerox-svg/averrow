// jsdom gaps that Radix Popper/Dialog rely on, plus a matchMedia stub that can
// report a compact (phone) viewport.

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

/** `compact: true` makes the max-width (phone) query match. */
export function stubViewport(compact: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: compact && query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
