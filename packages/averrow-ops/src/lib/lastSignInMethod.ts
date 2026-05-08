// Last-sign-in-method hint — per-device localStorage record of how
// the user most recently signed in. Drives the Login page's primary
// CTA so returning users land on the right method instead of the
// generic three-button menu.
//
// Stored per device (not per user). Multi-account device shows the
// last-used method; the "Other ways to sign in" disclosure on the
// Login page covers the multi-method case.
//
// Cleared on logout. Survives browser data wipes; if cleared, the
// Login page falls back to the first-time view.
//
// Recorded BEFORE the OAuth/magic-link round-trip (i.e. at the
// moment the user clicks the button, not after the callback comes
// back) so a same-device callback always finds the right method
// even though the server can't distinguish between Google + magic-
// link without changes.

const KEY = 'averrow.lastSignInMethod';

export type SignInMethod = 'passkey' | 'google' | 'magic-link';

const VALID: ReadonlyArray<SignInMethod> = ['passkey', 'google', 'magic-link'];

export function getLastSignInMethod(): SignInMethod | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return VALID.includes(raw as SignInMethod) ? (raw as SignInMethod) : null;
  } catch {
    return null;
  }
}

export function setLastSignInMethod(method: SignInMethod): void {
  try { localStorage.setItem(KEY, method); } catch { /* SSR / private mode */ }
}

export function clearLastSignInMethod(): void {
  try { localStorage.removeItem(KEY); } catch { /* SSR / private mode */ }
}
