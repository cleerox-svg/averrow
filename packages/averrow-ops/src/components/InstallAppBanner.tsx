// Surfaces an install-as-app CTA on the Overview when eligible.
//
//   · Android Chrome / Edge / Samsung Internet → captured
//     beforeinstallprompt → one-tap native install sheet.
//   · iOS Safari → no programmatic install path. Show Share →
//     Add to Home Screen steps inline (collapsed behind "Show me how" on
//     phones).
//
// Hidden when running standalone or after dismiss (per-device flag
// in localStorage so we don't nag). Renders nothing — including no gutter
// wrapper — when hidden.

import { useState, type ReactNode } from 'react';
import { Card, Button, SectionLabel } from '@/design-system/components';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { InstallSteps } from './InstallSteps';
import './install-app.css';

const DISMISS_KEY = 'averrow.install.dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false; // SSR / private mode — fail silent
  }
}

function Gutter({ children }: { children: ReactNode }) {
  return <div className="install-gutter">{children}</div>;
}

export function InstallAppBanner() {
  const prompt = useInstallPrompt();
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [stepsOpen, setStepsOpen] = useState(false);

  if (prompt.isStandalone) return null;
  if (dismissed) return null;

  const markDismissed = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };

  if (prompt.canInstall) {
    return (
      <Gutter>
        <section aria-labelledby="install-banner-title">
          <Card>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex-1">
                <SectionLabel className="mb-1">Install</SectionLabel>
                <h3 id="install-banner-title" className="font-semibold" style={{ color: 'var(--text-primary)', fontSize: 14 }}>
                  Install Averrow as an app
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Faster launch from your home screen, full-screen view, and push
                  notifications work more reliably.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" className="install-btn" onClick={markDismissed}>Not now</Button>
                <Button
                  variant="primary"
                  className="install-btn"
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
        </section>
      </Gutter>
    );
  }

  if (prompt.isIos) {
    return (
      <Gutter>
        <section aria-labelledby="install-banner-title">
          <Card>
            <div className="flex flex-col gap-3">
              <div>
                <SectionLabel className="mb-1">Install · iOS</SectionLabel>
                <h3 id="install-banner-title" className="font-semibold" style={{ color: 'var(--text-primary)', fontSize: 14 }}>
                  Add Averrow to your Home Screen
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Required on iOS for push notifications to work. Takes about 10 seconds.
                </p>
              </div>
              <div className="install-steps-wrap flex flex-col gap-3" data-open={stepsOpen}>
                <InstallSteps id="install-banner-steps" />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="secondary"
                  className="install-btn install-how-btn"
                  aria-expanded={stepsOpen}
                  aria-controls="install-banner-steps"
                  onClick={() => setStepsOpen(v => !v)}
                >
                  {stepsOpen ? 'Hide steps' : 'Show me how'}
                </Button>
                <Button variant="ghost" className="install-btn" onClick={markDismissed}>Not now</Button>
              </div>
            </div>
          </Card>
        </section>
      </Gutter>
    );
  }

  return null;
}
