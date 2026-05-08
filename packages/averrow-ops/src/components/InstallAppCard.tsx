// Always-visible install entry point for the Profile page.
//
// Three platform paths:
//   · Android Chrome / Edge / Samsung Internet — captured
//     `beforeinstallprompt` → one-tap native install sheet.
//   · iOS Safari — no programmatic install path. Show the four
//     manual Share → Add to Home Screen steps.
//   · Browser-without-prompt fallback — collapsed "show manual
//     steps" affordance.
//
// Hidden once the app is running standalone (`isStandalone()`).

import { useState } from 'react';
import { Card, Button, SectionLabel } from '@/design-system/components';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';

export function InstallAppCard() {
  const prompt = useInstallPrompt();
  const [showManual, setShowManual] = useState(false);

  if (prompt.isStandalone) return null;

  return (
    <Card className="mb-4">
      <div className="flex flex-col gap-3">
        <div>
          <SectionLabel className="mb-1">Install</SectionLabel>
          <h3 className="font-semibold" style={{ color: 'var(--text-primary)', fontSize: 14 }}>
            Install Averrow as an app
          </h3>
          <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Launches from your home screen, stays full-screen, and makes
            push notifications more reliable (required on iOS).
          </p>
        </div>

        {prompt.canInstall && (
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => { void prompt.install(); }}>
              Install Averrow
            </Button>
          </div>
        )}

        {!prompt.canInstall && prompt.isIos && (
          <ol className="flex flex-col gap-2 pl-0 list-none" style={{ color: 'var(--text-secondary)' }}>
            <Step n={1} body="Tap the Share button at the bottom of Safari (the square with the up arrow)." />
            <Step n={2} body="Scroll down and pick Add to Home Screen." />
            <Step n={3} body="Tap Add in the top-right. Averrow will install." />
            <Step n={4} body="Open Averrow from your Home Screen and come back here to turn on alerts." />
          </ol>
        )}

        {!prompt.canInstall && !prompt.isIos && (
          <>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setShowManual(v => !v)}>
                {showManual ? 'Hide manual steps' : 'Show manual steps'}
              </Button>
            </div>
            {showManual && (
              <div
                className="rounded-lg p-3"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-base)' }}
              >
                <p className="font-mono text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  Your browser didn't surface an install prompt this session. Install manually:
                </p>
                <ul className="mt-2 flex flex-col gap-1 pl-5 list-disc text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  <li><strong>Chrome / Edge (desktop):</strong> click the install icon in the address bar (looks like a tiny monitor with a down-arrow), or open the 3-dot menu → <em>Install Averrow…</em></li>
                  <li><strong>Chrome (Android):</strong> 3-dot menu → <em>Install app</em> or <em>Add to Home screen</em>.</li>
                  <li><strong>Firefox (Android):</strong> 3-dot menu → <em>Install</em>.</li>
                  <li><strong>Safari / Chrome (iOS + iPadOS):</strong> Share → <em>Add to Home Screen</em>.</li>
                </ul>
                <p className="mt-2 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  Tip: if you just uninstalled, close every Averrow tab and reopen from a fresh tab — Chrome throttles its built-in prompt after an uninstall.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
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
