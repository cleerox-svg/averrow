import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrefersReducedMotion, usePageVisible } from './use-motion';

function stubMatchMedia(initial: boolean) {
  let listener: ((e: MediaQueryListEvent) => void) | null = null;
  const mql = {
    matches: initial,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { listener = cb; },
    removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  window.matchMedia = globalThis.matchMedia;
  return (matches: boolean) => { mql.matches = matches; listener?.({ matches } as MediaQueryListEvent); };
}

afterEach(() => vi.unstubAllGlobals());

describe('usePrefersReducedMotion', () => {
  it('reads the initial preference', () => {
    stubMatchMedia(true);
    expect(renderHook(() => usePrefersReducedMotion()).result.current).toBe(true);
  });
  it('reacts when the OS preference changes at runtime', () => {
    const flip = stubMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => flip(true));
    expect(result.current).toBe(true);
  });
});

describe('usePageVisible', () => {
  it('follows document visibility', () => {
    const { result } = renderHook(() => usePageVisible());
    expect(result.current).toBe(true);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe(false);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe(true);
  });
});
