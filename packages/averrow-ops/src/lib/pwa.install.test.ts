// Install-prompt store: the beforeinstallprompt event is captured at startup
// (before any consumer mounts) and shared by every consumer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  captureInstallPrompt,
  getInstallPromptEvent,
  __resetInstallPromptStoreForTests,
} from '@/lib/pwa';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';

function fireBeforeInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  e.prompt = vi.fn().mockResolvedValue(undefined);
  e.userChoice = Promise.resolve({ outcome });
  window.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  __resetInstallPromptStoreForTests();
  captureInstallPrompt(); // idempotent; listeners persist across tests
});

describe('install prompt store', () => {
  it('captures the event before any consumer mounts and preventDefaults it', () => {
    const e = fireBeforeInstall();
    expect(e.defaultPrevented).toBe(true);
    expect(getInstallPromptEvent()).toBe(e);

    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(true);
  });

  it('shares one event across two consumers', async () => {
    const a = renderHook(() => useInstallPrompt());
    const b = renderHook(() => useInstallPrompt());
    expect(a.result.current.canInstall).toBe(false);
    expect(b.result.current.canInstall).toBe(false);

    act(() => { fireBeforeInstall(); });
    expect(a.result.current.canInstall).toBe(true);
    expect(b.result.current.canInstall).toBe(true);

    // Using the single-use event in one consumer clears it for both.
    let outcome: string | undefined;
    await act(async () => { outcome = await a.result.current.install(); });
    expect(outcome).toBe('accepted');
    expect(a.result.current.canInstall).toBe(false);
    expect(b.result.current.canInstall).toBe(false);
    expect(await b.result.current.install()).toBe('unavailable');
  });

  it('clears on appinstalled and reports standalone to later consumers', () => {
    act(() => { fireBeforeInstall(); });
    act(() => { window.dispatchEvent(new Event('appinstalled')); });
    expect(getInstallPromptEvent()).toBeNull();
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(false);
    expect(result.current.isStandalone).toBe(true);
  });

  it('registers listeners once (idempotent capture)', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    captureInstallPrompt();
    captureInstallPrompt();
    expect(spy).not.toHaveBeenCalledWith('beforeinstallprompt', expect.anything());
    spy.mockRestore();
  });
});
