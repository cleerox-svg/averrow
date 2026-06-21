// Unified passkey client. Wraps @simplewebauthn/browser using a
// product-agnostic HTTP adapter. Backend lives in
// packages/trust-radar/src/handlers/passkeys.ts and produces the
// same session shape as OAuth + magic-link, so once a sign-in
// completes the AuthProvider hydrates without any changes
// elsewhere.

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
import type {
  PasskeyClient, PasskeyClientOptions, PasskeyDevice, PasskeyHttpClient,
  SignInOptions,
} from './types';

const DEFAULT_PATHS = {
  registerBegin:  '/api/passkeys/register/begin',
  registerFinish: '/api/passkeys/register/finish',
  authBegin:      '/api/passkeys/auth/begin',
  authFinish:     '/api/passkeys/auth/finish',
  list:           '/api/passkeys',
  remove:         '/api/passkeys/:id',
} as const;

interface BeginResponse extends PublicKeyCredentialRequestOptionsJSON {
  challenge_key: string;
}

export function createPasskeyClient(
  http:    PasskeyHttpClient,
  options: PasskeyClientOptions,
): PasskeyClient {
  const paths = { ...DEFAULT_PATHS, ...(options.paths ?? {}) };

  function isSupported(): boolean {
    return browserSupportsWebAuthn();
  }

  async function isAutofillSupported(): Promise<boolean> {
    try { return await browserSupportsWebAuthnAutofill(); }
    catch { return false; }
  }

  // ─── Registration (auth required) ─────────────────────────

  async function registerPasskey(deviceLabel?: string): Promise<void> {
    if (!isSupported()) throw new Error('This browser does not support passkeys.');

    const begin = await http.post<PublicKeyCredentialCreationOptionsJSON>(paths.registerBegin, {});
    if (!begin.success || !begin.data) {
      throw new Error(begin.error || 'Failed to start passkey registration.');
    }

    // Browser surface drives the OS credential creation UX.
    const attResp = await startRegistration({ optionsJSON: begin.data });

    const finish = await http.post<{ success: boolean }>(paths.registerFinish, {
      response:     attResp,
      device_label: deviceLabel,
    });
    if (!finish.success) {
      throw new Error(finish.error || 'Failed to verify the passkey.');
    }
  }

  // ─── Authentication (public — produces a session) ─────────

  /** Returns true on success (caller's app navigates the page).
   *  Returns false if the user dismissed the OS prompt. Throws on
   *  actual failures. */
  async function signInWithPasskey(opts: SignInOptions = {}): Promise<boolean> {
    if (!isSupported()) throw new Error('This browser does not support passkeys.');

    const begin = await http.post<BeginResponse>(paths.authBegin, { email: opts.email });
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

    // Backend returns JSON for passkey auth/finish (mode='json').
    // The refresh cookie comes via Set-Cookie automatically. We
    // hard-navigate to the return_to with the access token in the
    // URL hash so the AuthProvider hydrates the session on next
    // page load — same shape as OAuth + magic-link callback.
    const finish = await http.post<{ access_token: string; expires_in: number; return_to: string }>(
      paths.authFinish,
      {
        response:      assertResp,
        challenge_key,
        return_to:     opts.returnTo ?? options.defaultReturnTo,
      },
    );
    if (!finish.success || !finish.data) {
      throw new Error(finish.error || 'Passkey verification failed.');
    }

    const { access_token, expires_in, return_to } = finish.data;

    // Host-side hydration (login audit F3): when the caller provides
    // onSuccess, hand it the token and let the host set it in memory +
    // refresh + SPA-navigate. This avoids the legacy hard-nav below, which
    // could be a same-path hash change (no reload) and leave the login
    // spinner hanging until a manual refresh.
    if (opts.onSuccess) {
      await opts.onSuccess(access_token, expires_in, return_to);
      return true;
    }

    if (typeof window !== 'undefined') {
      window.location.assign(`${return_to}#token=${access_token}&expires_in=${expires_in}`);
    }
    return true;
  }

  /** Runs conditional-UI auth in the background. Should be called
   *  on Login page mount when `isAutofillSupported()` returns true
   *  and an email <input> with autocomplete="username webauthn"
   *  is in the DOM. */
  async function startConditionalUI(returnTo?: string, onSuccess?: SignInOptions['onSuccess']): Promise<void> {
    if (!isSupported()) return;
    if (!(await isAutofillSupported())) return;
    try {
      await signInWithPasskey({ conditional: true, returnTo: returnTo ?? options.defaultReturnTo, onSuccess });
    } catch {
      // Conditional UI failures are silent — the user can still
      // click the explicit passkey button or use another method.
    }
  }

  // ─── Device management (auth required) ────────────────────

  async function listPasskeys(): Promise<PasskeyDevice[]> {
    const res = await http.get<PasskeyDevice[]>(paths.list);
    return res.data ?? [];
  }

  async function removePasskey(id: string): Promise<void> {
    await http.delete(paths.remove.replace(':id', encodeURIComponent(id)));
  }

  return {
    isSupported,
    isAutofillSupported,
    startConditionalUI,
    signInWithPasskey,
    registerPasskey,
    listPasskeys,
    removePasskey,
  };
}
