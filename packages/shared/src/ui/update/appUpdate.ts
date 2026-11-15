// "Is there a newer Averrow than the one on screen?" (shared by ops + tenant;
// mirrors FarmTrack's src/app/lib/appUpdate.ts.)
//
// An open tab keeps running the bundle it loaded until someone reloads. The
// app's index.html names the build's hashed entry script
// (/v2/assets/index-<hash>.js); a new deploy ships an index.html naming a
// different one. So: fetch the app's own shell and see whether it still names
// the script this page is running. No version file, no build plugin.
//
// The probe carries ?__update_check so the ops service worker passes it
// straight to the network (packages/averrow-ops/public/sw.js); answered from
// its runtime cache it would only ever see the build it already has.

export const UPDATE_CHECK_PARAM = '__update_check';

/** The built entry script this page runs (its pathname), or null (dev server, tests). */
export function currentBuildScript(doc: Document = document): string | null {
  const el = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  if (!el) return null;
  try {
    return new URL(el.getAttribute('src') ?? '', 'https://x').pathname;
  } catch {
    return null;
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * True only when the server answered with a page that does not name
 * `current`. Any failure (offline, error status, unexpected body) is "no":
 * a false "update available" would nag; a missed one is caught next time.
 *
 * `shellUrl` is the app's own shell URL: `/v2/` (ops) or `/tenant/` (tenant).
 */
export async function isNewBuildAvailable(
  current: string | null,
  shellUrl: string,
  fetchFn: FetchFn = (i, init) => fetch(i, init),
  now: () => number = Date.now,
): Promise<boolean> {
  if (!current) return false;
  try {
    const res = await fetchFn(`${shellUrl}?${UPDATE_CHECK_PARAM}=${now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'text/html' },
    });
    if (!res.ok) return false;
    const html = await res.text();
    // Only judge a real app page (it names some built entry script).
    if (!/\/assets\/[^"']+\.js/.test(html)) return false;
    return !html.includes(current);
  } catch {
    return false;
  }
}
