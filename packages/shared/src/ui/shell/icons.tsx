// Default glyphs for the shell modules (the kit has no icon-library
// dependency). Same geometry as lucide so apps that pass their own lucide
// icons look identical. Decorative: aria-hidden, stroke = currentColor.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base: IconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
};

export const ShellSearchIcon = (p: IconProps) => <svg {...base} {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>;
export const ShellBellIcon = (p: IconProps) => <svg {...base} {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>;
export const ShellClockIcon = (p: IconProps) => <svg {...base} {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>;
export const ShellCheckIcon = (p: IconProps) => <svg {...base} {...p}><path d="M20 6 9 17l-5-5" /></svg>;
export const ShellMoreIcon = (p: IconProps) => <svg {...base} {...p}><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>;
export const ShellCloseIcon = (p: IconProps) => <svg {...base} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const ShellSettingsIcon = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const ShellShieldCheckIcon = (p: IconProps) => <svg {...base} {...p}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></svg>;
export const ShellShieldAlertIcon = (p: IconProps) => <svg {...base} {...p}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="M12 8v4M12 16h.01" /></svg>;
export const ShellMonitorIcon = (p: IconProps) => <svg {...base} {...p}><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
export const ShellMoonIcon = (p: IconProps) => <svg {...base} {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>;
export const ShellSunIcon = (p: IconProps) => <svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2m-7.07-15.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>;
export const ShellLogOutIcon = (p: IconProps) => <svg {...base} {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>;
export const ShellUserPlusIcon = (p: IconProps) => <svg {...base} {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>;
