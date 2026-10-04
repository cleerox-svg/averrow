// Test helpers for the settings kit.
import type { ReactNode } from 'react';
import { vi } from 'vitest';

/** matchMedia stub: `desktop` answers (min-width: 1024px); reduced-motion is off. */
export function stubViewport(desktop: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 1024px') ? desktop : query.includes('min-width: 768px') ? true : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Minimal switch: a labelled button role=switch (the real Switch lives in ui/forms). */
export function TestSwitch(p: {
  checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; labelledBy?: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={p.checked}
      aria-labelledby={p.labelledBy}
      disabled={p.disabled}
      onClick={() => p.onCheckedChange(!p.checked)}
    />
  );
}

export const noop = vi.fn();
