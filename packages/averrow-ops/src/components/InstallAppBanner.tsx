// Surfaces an install-as-app CTA on Home when eligible.
//
//   · Android Chrome / Edge / Samsung Internet → captured
//     beforeinstallprompt → one-tap native install sheet.
//   · iOS Safari → no programmatic install path. Show Share →
//     Add to Home Screen steps inline.
//
// Hidden when running standalone or after dismiss (per-device flag
// in localStorage so we don't nag).

import { useEffect, useState } from 'react';
import { Card, Button, SectionLabel } from '@/design-system/components';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';

const DISMISS_KEY = 'averrow.install.dismissed';

export function InstallAppBanner() {
  const prompt = useInstallPrompt();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      // SSR / private mode — fail silent
    }
  }, []);

  if (prompt.isStandalone) return null;
  if (dismissed) return null;

  const markDismissed = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };

  if (prompt.canInstall) {
    return (
      <Card className="mb-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex-1">
            <SectionLabel className="mb-1">Install</SectionLabel>
            <h3 className="font-semibold" style={{ color: 'var(--text-primary)', fontSize: 14 }}>
              Install Averrow as an app
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Faster launch from your home screen, full-screen view, and push
              notifications work more reliably.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={markDismissed}>Not now</Button>
            <Button
              variant="primary"
              onClick={async () => {
                // On accept, the `appinstalled` event flips
                // isStandalone naturally — no localStorage flag.
                await prompt.install();
              }}
            >
              Install
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  if (prompt.isIos) {
    return (
      <Card className="mb-4">
        <div className="flex flex-col gap-3">
          <div>
            <SectionLabel className="mb-1">Install · iOS</SectionLabel>
            <h3 className="font-semibold" style={{ color: 'var(--text-primary)', fontSize: 14 }}>
              Add Averrow to your Home Screen
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Required on iOS for push notifications to work. Takes about 10 seconds:
            </p>
          </div>
          <ol className="flex flex-col gap-2 pl-0 list-none" style={{ color: 'var(--text-secondary)' }}>
            <Step n={1} body="Tap the Share button at the bottom of Safari (the square with the up arrow)." />
            <Step n={2} body="Scroll down and pick Add to Home Screen." />
            <Step n={3} body="Tap Add in the top-right. Averrow will install." />
            <Step n={4} body="Open Averrow from your Home Screen and come back here to turn on alerts." />
          </ol>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={markDismissed}>Not now</Button>
          </div>
        </div>
      </Card>
    );
  }

  return null;
}

function Step({ n, body }: { n: number; body: string }) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-black"
        style={{
          background: 'var(--amber)',
          color: 'var(--text-on-amber, #0A0F1E)',
          boxShadow: '0 0 10px rgba(229,168,50,0.45)',
        }}
      >
        {n}
      </span>
      <span style={{ lineHeight: 1.5 }}>{body}</span>
    </li>
  );
}
