// Last-sign-in-method helper — per-device localStorage record of
// how the user most recently signed in. Drives the Login page's
// adaptive primary CTA.
//
// The localStorage key is product-namespaced via the factory so
// Averrow's hint doesn't conflict with FarmTrack's on shared
// devices. Use makeLastSignInMethod('averrow') in the host app.

import type { SignInMethod, LastSignInMethodAdapter } from './types';

const VALID: ReadonlyArray<SignInMethod> = ['passkey', 'google', 'magic-link'];

export function makeLastSignInMethodAdapter(
  /** localStorage key. e.g. "averrow.lastSignInMethod". */
  key: string,
): LastSignInMethodAdapter {
  return {
    read() {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return VALID.includes(raw as SignInMethod) ? (raw as SignInMethod) : null;
      } catch {
        return null;
      }
    },
    write(method) {
      try { localStorage.setItem(key, method); } catch { /* SSR / private mode */ }
    },
  };
}

export function clearLastSignInMethod(key: string): void {
  try { localStorage.removeItem(key); } catch { /* SSR / private mode */ }
}
