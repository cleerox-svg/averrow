// Row glyphs for the notification settings. Plain inline SVGs (stroke 1.75,
// currentColor) — IconTile sizes and tints them. Decorative only.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;
const base: IconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
};

export const BellIcon = (p: IconProps) => <svg {...base} {...p}><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>;
export const PhoneIcon = (p: IconProps) => <svg {...base} {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>;
export const MailIcon = (p: IconProps) => <svg {...base} {...p}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7.5 8 6 8-6" /></svg>;
export const InboxIcon = (p: IconProps) => <svg {...base} {...p}><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5.5 5h13L21 13v5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18v-5Z" /></svg>;
export const SendIcon = (p: IconProps) => <svg {...base} {...p}><path d="M21 3 10.5 13.5" /><path d="M21 3 14.5 21l-4-7.5L3 9.5Z" /></svg>;
export const ClockIcon = (p: IconProps) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
export const MoonIcon = (p: IconProps) => <svg {...base} {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>;
export const EyeIcon = (p: IconProps) => <svg {...base} {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></svg>;
export const BuildingIcon = (p: IconProps) => <svg {...base} {...p}><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M10 21v-4h4v4" /></svg>;
export const LayersIcon = (p: IconProps) => <svg {...base} {...p}><path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 13 9 5 9-5" /></svg>;
export const ShieldAlertIcon = (p: IconProps) => <svg {...base} {...p}><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z" /><path d="M12 8.5v4M12 16h.01" /></svg>;
export const CheckSmallIcon = (p: IconProps) => <svg {...base} strokeWidth={2.25} {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
export const TrashIcon = (p: IconProps) => <svg {...base} {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;

// Event-row glyphs (Events tab): one per notification event so rows scan by shape.
export const TrendUpIcon = (p: IconProps) => <svg {...base} {...p}><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>;
export const FileCheckIcon = (p: IconProps) => <svg {...base} {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /><path d="m9 14.5 2 2 4-4.5" /></svg>;
export const NewspaperIcon = (p: IconProps) => <svg {...base} {...p}><path d="M5 4h11a1 1 0 0 1 1 1v14H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Z" /><path d="M17 9h3v8a2 2 0 0 1-2 2h-1" /><path d="M8 8h6M8 12h6M8 15.5h4" /></svg>;
export const RssIcon = (p: IconProps) => <svg {...base} {...p}><path d="M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8" /><circle cx="6" cy="18" r="1.2" /></svg>;
export const AlertTriangleIcon = (p: IconProps) => <svg {...base} {...p}><path d="M12 4 2.8 19.5h18.4Z" /><path d="M12 10v4.5M12 17.2h.01" /></svg>;
export const PauseCircleIcon = (p: IconProps) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></svg>;
export const FlagIcon = (p: IconProps) => <svg {...base} {...p}><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>;
