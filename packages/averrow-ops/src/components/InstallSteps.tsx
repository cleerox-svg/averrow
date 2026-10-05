// Numbered "Share → Add to Home Screen" steps shown to iOS Safari users, who
// have no programmatic install path. Shared by InstallAppBanner (Overview)
// and the install card in Settings → Devices & App. Styling lives in install-app.css (tokens only).

import './install-app.css';

export const IOS_INSTALL_STEPS: readonly string[] = [
  'Tap the Share button at the bottom of Safari (the square with the up arrow).',
  'Scroll down and pick Add to Home Screen.',
  'Tap Add in the top-right. Averrow will install.',
  'Open Averrow from your Home Screen and come back here to turn on alerts.',
];

export function InstallSteps({ id, steps = IOS_INSTALL_STEPS }: { id?: string; steps?: readonly string[] }) {
  return (
    <ol id={id} className="install-steps flex flex-col gap-2 pl-0 list-none" style={{ color: 'var(--text-secondary)' }}>
      {steps.map((body, i) => (
        <li key={i} className="flex items-start gap-2 text-[13px]">
          <span aria-hidden className="install-step-n">{i + 1}</span>
          <span style={{ lineHeight: 1.5 }}>{body}</span>
        </li>
      ))}
    </ol>
  );
}
