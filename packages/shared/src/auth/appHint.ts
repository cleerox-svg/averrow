// "Which app is this browser signed in to" hint — drives the public home page's
// signed-in redirect (packages/averrow-marketing/src/scripts/home-redirect.js).
//
// The session cookie is path-scoped to /api/auth, so the server can't tell at
// `/` whether someone is signed in. Instead the apps leave a NON-SENSITIVE,
// same-origin hint in localStorage when a session is established and remove it
// whenever it is lost. The hint is only ever a convenience: it grants nothing,
// and the app's own auth check is the real gate. A stale hint costs one bounce
// into the app, which clears it (see AuthProvider.setUser and the apps'
// logged-out guards, which clear BEFORE navigating to `/?home=1`).
//
// The key and values are duplicated in the marketing script (it can't import
// this module); packages/shared/src/auth/appHint.test.ts pins both together.

export const APP_HINT_KEY = 'averrow.app';
export type AppHint = 'ops' | 'tenant';

/** Home-page URL that never auto-redirects into the app ("Averrow home" links). */
export const HOME_NO_REDIRECT_URL = '/?home=1';

export function setAppHint(app: AppHint): void {
  try { localStorage.setItem(APP_HINT_KEY, app); } catch { /* storage blocked */ }
}

export function clearAppHint(): void {
  try { localStorage.removeItem(APP_HINT_KEY); } catch { /* storage blocked */ }
}

export function readAppHint(): AppHint | null {
  try {
    const v = localStorage.getItem(APP_HINT_KEY);
    return v === 'ops' || v === 'tenant' ? v : null;
  } catch {
    return null;
  }
}
