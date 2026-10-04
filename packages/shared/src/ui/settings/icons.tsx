// Internal glyphs for the settings kit (no icon-library dependency).
// Decorative: always aria-hidden. Stroke inherits currentColor.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base: IconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
};

export const ChevronRightIcon = (p: IconProps) => <svg {...base} {...p}><path d="m9 6 6 6-6 6" /></svg>;
export const ChevronLeftIcon = (p: IconProps) => <svg {...base} {...p}><path d="m15 6-6 6 6 6" /></svg>;
export const CopyIcon = (p: IconProps) => <svg {...base} {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
export const CheckIcon = (p: IconProps) => <svg {...base} {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
export const InfoIcon = (p: IconProps) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
export const WarnIcon = (p: IconProps) => <svg {...base} {...p}><path d="M12 3.5 2.8 19.5h18.4z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>;
export const AlertIcon = (p: IconProps) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16h.01" /></svg>;
export const ShieldIcon = (p: IconProps) => <svg {...base} {...p}><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /></svg>;
export const XIcon = (p: IconProps) => <svg {...base} {...p}><path d="m6 6 12 12M18 6 6 18" /></svg>;

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg {...base} width={size} height={size} className="animate-spin" data-testid="ds-spinner">
      <circle cx="12" cy="12" r="9" opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
