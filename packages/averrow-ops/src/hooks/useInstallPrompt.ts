// PWA install-prompt capture — Android Chrome / Edge / Samsung Internet
// fire `beforeinstallprompt` when the site is eligible to be installed
// as a PWA. The event has a `.prompt()` method we can call later in
// response to a user gesture. We capture the event on mount and expose
// it so a button can trigger the native install sheet without the
// user having to dig through browser menus.
//
// On iOS Safari this event never fires (Apple deliberately doesn't
// support programmatic install). Caller renders the manual
// "Share → Add to Home Screen" steps when isIos = true.

import { useEffect, useState } from 'react';
import { isStandalone, isIOS } from '@/lib/pwa';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: readonly string[];
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

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
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState<boolean>(() => isStandalone());
  const [ios] = useState<boolean>(() => isIOS());

  useEffect(() => {
    const onBeforePrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setEvent(null);
      setStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforePrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforePrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!event) return 'unavailable';
    try {
      await event.prompt();
      const choice = await event.userChoice;
      // Spec says the event can only be used once.
      setEvent(null);
      return choice.outcome;
    } catch {
      return 'unavailable';
    }
  };

  return {
    isStandalone: standalone,
    canInstall: !!event && !standalone,
    isIos: ios,
    install,
  };
}
