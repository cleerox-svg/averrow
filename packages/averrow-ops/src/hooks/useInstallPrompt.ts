// PWA install-prompt hook — Android Chrome / Edge / Samsung Internet fire
// `beforeinstallprompt` when the site is eligible to be installed. The event
// is captured once at app startup into the store in `@/lib/pwa`
// (captureInstallPrompt, called from main.tsx) so it is not lost when the
// consuming route is lazy-loaded, and is shared by every consumer (Overview
// banner, Profile card). This hook just subscribes to that store.
//
// On iOS Safari this event never fires (Apple deliberately doesn't
// support programmatic install). Caller renders the manual
// "Share → Add to Home Screen" steps when isIos = true.

import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  captureInstallPrompt,
  clearInstallPromptEvent,
  getAppInstalled,
  getInstallPromptEvent,
  isIOS,
  isStandalone,
  subscribeInstallPrompt,
} from '@/lib/pwa';

export interface InstallPromptState {
  /** True when the page is running as an installed PWA. */
  isStandalone: boolean;
  /** True when the browser fired beforeinstallprompt (Android Chrome/Edge). */
  canInstall: boolean;
  /** Best-effort iOS detection — iPad pretends desktop on newer versions. */
  isIos: boolean;
  /** Trigger the native install sheet. Returns the user's choice. */
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallPrompt(): InstallPromptState {
  // Idempotent safety net: normally main.tsx already started the capture.
  captureInstallPrompt();
  const event = useSyncExternalStore(subscribeInstallPrompt, getInstallPromptEvent, getInstallPromptEvent);
  const installed = useSyncExternalStore(subscribeInstallPrompt, getAppInstalled, getAppInstalled);
  const [standaloneAtLoad] = useState<boolean>(() => isStandalone());
  const [ios] = useState<boolean>(() => isIOS());
  const standalone = standaloneAtLoad || installed;

  const install = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const current = getInstallPromptEvent();
    if (!current) return 'unavailable';
    try {
      // Spec: the event can only be used once — clear it as soon as prompt()
      // is invoked so no consumer offers a dead button afterwards.
      const shown = current.prompt();
      clearInstallPromptEvent();
      await shown;
      const choice = await current.userChoice;
      return choice.outcome;
    } catch {
      clearInstallPromptEvent();
      return 'unavailable';
    }
  }, []);

  return {
    isStandalone: standalone,
    canInstall: !!event && !standalone,
    isIos: ios,
    install,
  };
}
