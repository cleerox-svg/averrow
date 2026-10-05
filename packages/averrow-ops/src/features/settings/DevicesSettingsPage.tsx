// /settings/devices — averrow-ops wrapper around the shared DevicesSettings.
// Injects the PWA install store (lib/pwa via useInstallPrompt), the web-push
// device API (lib/push), the app version and a cache-clear action.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DevicesSettings, type DevicesPushAdapter } from '@averrow/shared/account';
import { IOS_INSTALL_STEPS } from '@/components/InstallSteps';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import {
  getPushStatus, isPushSupported, listPushDevices, removePushDevice, sendTestPush, type PushStatus,
} from '@/lib/push';
import { APP_VERSION, BUILD_SHA } from '@/lib/version';

/** Delete this app's Cache Storage entries (shell + runtime caches), then reload. Sign-in lives in the cookie/memory, so the session survives. */
export async function clearLocalCache(): Promise<void> {
  if (typeof caches !== 'undefined') {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('averrow-')).map((k) => caches.delete(k)));
  }
  window.location.reload();
}

export function DevicesSettingsPage() {
  const navigate = useNavigate();
  const install = useInstallPrompt();
  const [status, setStatus] = useState<PushStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPushStatus().then((s) => { if (!cancelled) setStatus(s); }, () => undefined);
    return () => { cancelled = true; };
  }, []);

  const push = useMemo<DevicesPushAdapter>(() => ({
    supported: isPushSupported(),
    needsInstall: status?.needsInstall ?? false,
    list: listPushDevices,
    remove: removePushDevice,
    sendTest: sendTestPush,
    thisDeviceUserAgent: status?.subscribed && typeof navigator !== 'undefined' ? navigator.userAgent : null,
  }), [status]);

  return (
    <DevicesSettings
      install={install}
      push={push}
      version={{ label: `v${APP_VERSION}`, sha: BUILD_SHA }}
      onClearCache={clearLocalCache}
      onTurnOnPush={() => navigate('/settings/notifications')}
      iosSteps={IOS_INSTALL_STEPS}
    />
  );
}
