/** Country display names via Intl (no data table shipped); falls back to the ISO code. */

const cache = new Map<string, string>();
let display: Intl.DisplayNames | null | undefined;

function names(): Intl.DisplayNames | null {
  if (display !== undefined) return display;
  try {
    display = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    display = null;
  }
  return display;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  const cc = code.trim().toUpperCase();
  const hit = cache.get(cc);
  if (hit) return hit;
  let name = cc;
  try {
    const n = names()?.of(cc);
    if (n && n !== cc) name = n;
  } catch { /* invalid region code */ }
  cache.set(cc, name);
  return name;
}
