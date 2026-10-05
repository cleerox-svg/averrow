// Tiny user-agent → "Chrome on macOS" parser for the Security page. Not a full
// UA database: it recognises the browsers/OSes people actually sign in from
// and degrades to "Unknown device" rather than guessing.

export type DeviceClass = 'desktop' | 'phone' | 'tablet' | 'unknown';

export interface ParsedUserAgent {
  browser: string | null;
  os: string | null;
  device: DeviceClass;
  /** "Chrome on macOS", "Safari", "macOS", or "Unknown device". */
  label: string;
}

// Order matters: Chromium forks and iOS wrappers also say "Chrome"/"Safari".
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bBrave\b/, 'Brave'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  const s = (ua ?? '').trim();
  if (!s) return { browser: null, os: null, device: 'unknown', label: 'Unknown device' };

  const browser = BROWSERS.find(([re]) => re.test(s))?.[1] ?? null;

  let os: string | null = null;
  let device: DeviceClass = 'unknown';
  if (/\biPad\b/.test(s)) { os = 'iPadOS'; device = 'tablet'; }
  else if (/\b(iPhone|iPod)\b/.test(s)) { os = 'iOS'; device = 'phone'; }
  else if (/\bAndroid\b/.test(s)) { os = 'Android'; device = /\bMobile\b/.test(s) ? 'phone' : 'tablet'; }
  else if (/\bCrOS\b/.test(s)) { os = 'ChromeOS'; device = 'desktop'; }
  else if (/\bWindows\b/.test(s)) { os = 'Windows'; device = 'desktop'; }
  else if (/\bMac OS X\b|\bMacintosh\b/.test(s)) { os = 'macOS'; device = 'desktop'; }
  else if (/\bLinux\b|\bX11\b/.test(s)) { os = 'Linux'; device = 'desktop'; }

  const label = browser && os ? `${browser} on ${os}` : browser ?? os ?? 'Unknown device';
  return { browser, os, device, label };
}
