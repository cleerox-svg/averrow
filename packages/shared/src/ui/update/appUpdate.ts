// "Is there a newer Averrow than the one on screen?" (shared by ops + tenant;
// mirrors FarmTrack's src/app/lib/appUpdate.ts, extended to the whole asset set.)
//
// An open tab keeps running the bundle it loaded until someone reloads. The
// app's index.html names the build's hashed assets (/ops/assets/index-<hash>.js,
// its CSS and preloaded chunks); a new deploy whose app code or styles changed
// ships an index.html naming different ones. So: fetch the app's own shell and
// see whether it names an /assets/*.js|css file this page does not have. The
// per-deploy sha is deliberately NOT part of any asset (it is an index.html
// <meta>, see packages/shared/scripts/build-meta.ts), so backend-only deploys
// change nothing here and raise no banner.
//
// The probe carries ?__update_check so the ops service worker passes it
// straight to the network (packages/averrow-ops/public/sw.js); answered from
// its runtime cache it would only ever see the build it already has.

export const UPDATE_CHECK_PARAM = '__update_check';

const ASSET_REF = /(?:https?:\/\/[^/"'\s<>]+)?(\/(?:[^"'\s<>()/]+\/)*assets\/[^"'\s<>()]+?\.(?:js|css))(?=["'\s<>)?#]|$)/g;

/** Every /assets/*.js|css path named by an HTML string. */
export function assetsInHtml(html: string): Set<string> {
  return new Set([...html.matchAll(ASSET_REF)].map((m) => m[1] as string));
}

function pathOf(ref: string | null): string | null {
  if (!ref) return null;
  try {
    const p = new URL(ref, 'https://x').pathname;
    return /^\/(?:[^/]+\/)*assets\/.+\.(?:js|css)$/.test(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The /assets/*.js|css files this document references (entry script,
 * stylesheets, modulepreloads, and any chunk the preload helper added since).
 * Empty on the dev server / in tests.
 */
export function currentAssets(doc: Document = document): Set<string> {
  const out = new Set<string>();
  doc.querySelectorAll('script[src], link[href]').forEach((el) => {
    const p = pathOf(el.getAttribute('src') ?? el.getAttribute('href'));
    if (p) out.add(p);
  });
  return out;
}

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
 * True only when the server answered with an app page that names at least one
 * /assets/*.js|css file missing from `current`. Pages already preloaded extra
 * chunks, so `current` is a superset of the shell's own set and only a NEW
 * name counts. Any failure (offline, error status, unexpected body) is "no":
 * a false "update available" would nag; a missed one is caught next time.
 *
 * `shellUrl` is the app's own shell URL: `/ops/` (ops) or `/tenant/` (tenant).
 */
export async function isNewBuildAvailable(
  current: ReadonlySet<string> | readonly string[] | string | null,
  shellUrl: string,
  fetchFn: FetchFn = (i, init) => fetch(i, init),
  now: () => number = Date.now,
): Promise<boolean> {
  const have = typeof current === 'string' ? new Set([current]) : current ? new Set(current) : null;
  if (!have || have.size === 0) return false;
  try {
    const res = await fetchFn(`${shellUrl}?${UPDATE_CHECK_PARAM}=${now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'text/html' },
    });
    if (!res.ok) return false;
    const served = assetsInHtml(await res.text());
    // Only judge a real app page (it names some built script).
    if (![...served].some((a) => a.endsWith('.js'))) return false;
    return [...served].some((a) => !have.has(a));
  } catch {
    return false;
  }
}
