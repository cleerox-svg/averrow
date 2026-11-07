// Averrow brand identity for the tenant sidebar.
//
// Uses the "TENANT" subtitle so customers see they're in the
// customer surface (the back-office uses the shared AverrowMark).
// Keeps the parent brand recognizable across products.
//
// Facelift P3-5: renders BOTH this legacy logo (unchanged) and the R3 lockup
// (@averrow/shared/ui AverrowLockup, no tagline). The toggle classes show the
// legacy one until an accent is set on <html> (the P3-6 flip). They are
// siblings (a fragment), so the legacy element keeps its exact box.

import { AverrowLockup, LOGO_LEGACY_CLASS, LOGO_R3_CLASS } from '@averrow/shared/ui';

const R3_HEIGHT = { small: 22, default: 26, large: 34 } as const;

export function AverrowLogo({ size = 'default' }: { size?: 'small' | 'default' | 'large' }) {
  const dim = size === 'small' ? 24 : size === 'large' ? 40 : 28;

  return (
    <>
      <div className={`${LOGO_LEGACY_CLASS} flex items-center gap-2.5`}>
        <svg width={dim} height={dim} viewBox="0 0 32 32" fill="none" className="flex-shrink-0">
          <defs>
            <linearGradient id="tenant-logo-gradient" x1="16" y1="5" x2="16" y2="26" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#6B1010" />
              <stop offset="100%" stopColor="#C83C3C" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="6" fill="#0C1220" />
          <rect x="0.5" y="0.5" width="31" height="31" rx="5.5" fill="none" stroke="rgba(200,60,60,0.25)" strokeWidth="1" />
          <path d="M16 5L26 26H18L16 21L14 26H6Z" fill="url(#tenant-logo-gradient)" />
          <path d="M14.5 22H17.5L16 18Z" fill="#0C1220" />
        </svg>
        <div>
          <div className="font-bold tracking-[0.15em] text-sm" style={{ color: 'var(--text-primary)' }}>AVERROW</div>
          <div className="font-mono text-[11px] tracking-[0.12em]" style={{ color: 'var(--primary-text)' }}>TENANT</div>
        </div>
      </div>
      <AverrowLockup height={R3_HEIGHT[size]} className={LOGO_R3_CLASS} />
    </>
  );
}
