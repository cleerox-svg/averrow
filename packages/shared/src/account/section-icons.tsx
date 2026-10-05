// Glyphs for the account area (Profile, Devices & App and the section list).
// Inline SVG, stroke inherits currentColor, decorative (aria-hidden). The
// kit's own icons are internal to ui/settings, so the account pages carry
// their own small set rather than pulling in an icon library.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base: IconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
};

export const UserIcon = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="8" r="4" /><path d="M4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5" /></svg>
);
export const ShieldCheckIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg>
);
export const BellIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /></svg>
);
export const SmartphoneIcon = (p: IconProps) => (
  <svg {...base} {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>
);
export const MonitorIcon = (p: IconProps) => (
  <svg {...base} {...p}><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M9 20h6M12 16.5V20" /></svg>
);
export const MoonIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></svg>
);
export const SunIcon = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></svg>
);
export const GlobeIcon = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></svg>
);
export const CalendarIcon = (p: IconProps) => (
  <svg {...base} {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
);
export const IdBadgeIcon = (p: IconProps) => (
  <svg {...base} {...p}><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="11" r="2" /><path d="M6 16c.5-1.5 1.7-2 3-2s2.5.5 3 2M15 10h3M15 13h3" /></svg>
);
export const KeyIcon = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16 7l2.5 2.5" /></svg>
);
export const DownloadIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15" /></svg>
);
export const ShareIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 15V3.5M8 7l4-4 4 4M6 11H5.5A1.5 1.5 0 0 0 4 12.5v6A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H18" /></svg>
);
export const SendIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z" /></svg>
);
export const TrashIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 7h16M10 3.5h4M6.5 7l.8 12a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.8-12M10 11v6M14 11v6" /></svg>
);
export const InfoCircleIcon = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const LogOutIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M9 4.5H6.5A2 2 0 0 0 4.5 6.5v11a2 2 0 0 0 2 2H9M15 8l4 4-4 4M19 12H9.5" /></svg>
);
export const RefreshIcon = (p: IconProps) => (
  <svg {...base} {...p}><path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4M20 4v5h-5M4 20v-5h5" /></svg>
);
