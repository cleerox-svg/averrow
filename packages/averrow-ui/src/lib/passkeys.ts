/**
 * Passkey (WebAuthn) browser-side helpers.
 *
 * Thin wrapper over `@simplewebauthn/browser`. Backend lives in
 * packages/trust-radar/src/handlers/passkeys.ts and produces the same
 * session shape as OAuth + magic-link, so once a sign-in completes the
 * AuthProvider hydrates without any changes elsewhere.
 *
 * Two flows:
 *
 *   registerPasskey()
 *     Auth required. POST register/begin → browser WebAuthn ceremony →
 *     POST register/finish. On success the backend has the user's new
 *     credential and they can use it on the next sign-in.
 *
 *   signInWithPasskey({ email? })
 *     Public. POST auth/begin (with optional email so allowCredentials
 *     can be populated — improves the OS picker UX) → browser WebAuthn
 *     ceremony → POST auth/finish, which 302s with a token in the URL
 *     hash exactly like the OAuth callback. The `useAuth` hook will pick
 *     up the token on the next page load.
 *
 *   startConditionalUI()
 *     Same as signInWithPasskey but in "conditional mediation" mode —
 *     the OS credential picker appears in the email field's autofill
 *     dropdown without the user clicking anything. Caller should ensure
 *     the email <input> has `autocomplete="username webauthn"`.
 */

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
} from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types';
import { api } from './api';

export interface PasskeyDevice {
  id: string;
  device_label: string | null;
  user_agent: string | null;
  backed_up: number;
  /** Authenticator transport hints. ["internal"] = Touch ID / Face ID
   *  / Windows Hello / Android fingerprint → drives the BIOMETRIC
   *  badge on the Profile page. */
  transports: string[];
  created_at: string;
  last_used_at: string | null;
}

export function isPasskeySupported(): boolean {
  return browserSupportsWebAuthn();
}

export async function isAutofillSupported(): Promise<boolean> {
  try {
    return await browserSupportsWebAuthnAutofill();
  } catch {
    return false;
  }
}

// ─── Registration (auth required) ───────────────────────────────────────

export async function registerPasskey(deviceLabel?: string): Promise<void> {
  if (!isPasskeySupported()) throw new Error('This browser does not support passkeys.');

  const begin = await api.post<PublicKeyCredentialCreationOptionsJSON>(
    '/api/passkeys/register/begin',
    {},
  );
  if (!begin.success || !begin.data) {
    throw new Error(begin.error || 'Failed to start passkey registration.');
  }

  // The browser surface drives the OS credential creation UX (Touch ID,
  // Face ID, Windows Hello, USB/NFC security key, etc.).
  const attResp = await startRegistration({ optionsJSON: begin.data });

  const finish = await api.post<{ success: boolean }>('/api/passkeys/register/finish', {
    response: attResp,
    device_label: deviceLabel,
  });
  if (!finish.success) {
    throw new Error(finish.error || 'Failed to verify the passkey.');
  }
}

// ─── Authentication (public — produces a session) ───────────────────────

interface BeginResponse extends PublicKeyCredentialRequestOptionsJSON {
  challenge_key: string;
}

export interface SignInOptions {
  email?: string;
  /** When set, runs the WebAuthn ceremony in 'conditional' mediation mode
   *  so the OS credential picker appears in the email field's autofill
   *  rather than as a modal. */
  conditional?: boolean;
  returnTo?: string;
}

/** Returns true on success (caller should hard-navigate to pick the session
 *  up via the AuthProvider). Returns false if the user dismissed the OS
 *  prompt. Throws on actual failures. */
export async function signInWithPasskey(opts: SignInOptions = {}): Promise<boolean> {
  if (!isPasskeySupported()) throw new Error('This browser does not support passkeys.');

  const begin = await api.post<BeginResponse>('/api/passkeys/auth/begin', {
    email: opts.email,
  });
  if (!begin.success || !begin.data) {
    throw new Error(begin.error || 'Failed to start passkey sign-in.');
  }

  const { challenge_key, ...optionsJSON } = begin.data;

  let assertResp;
  try {
    assertResp = await startAuthentication({
      optionsJSON,
      useBrowserAutofill: opts.conditional ?? false,
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      return false;
    }
    throw err;
  }

  // Backend returns JSON for passkey auth/finish (mode='json' on issueSession).
  // The refresh cookie comes via Set-Cookie header automatically. We then do
  // a hard navigation to the return_to with the access token in the URL hash,
  // so the AuthProvider hydrates the session on next page load — same shape
  // as the OAuth + magic-link callback redirect.
  const finish = await api.post<{ access_token: string; expires_in: number; return_to: string }>(
    '/api/passkeys/auth/finish',
    {
      response: assertResp,
      challenge_key,
      return_to: opts.returnTo ?? '/v2/',
    },
  );
  if (!finish.success || !finish.data) {
    throw new Error(finish.error || 'Passkey verification failed.');
  }

  const { access_token, expires_in, return_to } = finish.data;
  window.location.assign(`${return_to}#token=${access_token}&expires_in=${expires_in}`);
  return true;
}

/** Runs the conditional-UI auth ceremony in the background. Should be called
 *  on Login page mount when `isAutofillSupported()` returns true and an
 *  email <input> with autocomplete="username webauthn" is in the DOM. */
export async function startConditionalUI(returnTo?: string): Promise<void> {
  if (!isPasskeySupported()) return;
  if (!(await isAutofillSupported())) return;
  try {
    await signInWithPasskey({ conditional: true, returnTo });
  } catch {
    // Conditional UI failures are silent — the user can still click the
    // explicit passkey button or use a different sign-in method.
  }
}

// ─── Device management (auth required) ──────────────────────────────────

export async function listPasskeys(): Promise<PasskeyDevice[]> {
  const res = await api.get<PasskeyDevice[]>('/api/passkeys');
  return res.data ?? [];
}

export async function removePasskey(id: string): Promise<void> {
  await api.delete(`/api/passkeys/${id}`);
}

