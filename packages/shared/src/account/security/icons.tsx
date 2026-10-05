// Glyphs for the Security page (18px, stroke 1.75, currentColor).
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base: P = {
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
};

export const ShieldCheckIcon = (p: P) => <svg {...base} {...p}><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg>;
export const ShieldAlertIcon = (p: P) => <svg {...base} {...p}><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /><path d="M12 8.5v4M12 15.5h.01" /></svg>;
export const KeyIcon = (p: P) => <svg {...base} {...p}><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.2-8.2M16 7l3 3M14 9l2 2" /></svg>;
export const LaptopIcon = (p: P) => <svg {...base} {...p}><rect x="4.5" y="5" width="15" height="10.5" rx="1.5" /><path d="M2.5 19h19" /></svg>;
export const PhoneIcon = (p: P) => <svg {...base} {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>;
export const MoreIcon = (p: P) => <svg {...base} {...p}><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></svg>;
export const TrashIcon = (p: P) => <svg {...base} {...p}><path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" /></svg>;
export const PlusIcon = (p: P) => <svg {...base} width={16} height={16} {...p}><path d="M12 5v14M5 12h14" /></svg>;
