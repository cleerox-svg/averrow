// Unified LoginPage — single source of truth for averrow-ops's
// /v2/login and (future) FarmTrack's /login. Both products
// render this same component with brand deltas via the
// `branding` prop.
//
// Adaptive primary CTA:
//   - First-time visitor:  Google primary, magic-link below.
//                          NO standalone passkey button — conditional
//                          UI runs silently in the email autofill.
//   - Returning passkey:   Passkey primary, "Other ways" disclosure.
//   - Returning Google:    Google primary, "Other ways" disclosure.
//   - Returning magic:     Email field + Send link primary,
//                          "Other ways" exposes Google + passkey.
//   - Sign-in error:       Full menu shown (every supported method).
//
// Hint is recorded BEFORE the OAuth round-trip via
// lastSignInMethod.write(...) so a same-device callback always
// finds the right method.

import { useEffect, useId, useRef, useState } from 'react';
import { Banner, Button, Field, FieldError, Input } from '../ui';
import type { LoginPageProps, SignInMethod } from './types';
import { applyThemePreference, readStoredTheme } from '../theme/useTheme';
import { APPEARANCE_PICKER_ENABLED } from '../theme/appearanceDefaults';
import { AUTH_ERROR_COPY } from '../auth-error-codes';

type MagicLinkState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string; minutes: number }
  | { kind: 'error'; message: string };

// Sign-in failure codes the worker redirects here with (?error=<code>) and
// their copy live in ../auth-error-codes so the worker and this page share
// one list.
const DEFAULT_ERROR_COPY: Record<string, string> = AUTH_ERROR_COPY;

// Only well-formed codes are echoed back; anything else is attacker-supplied
// text (content spoofing via ?error=<sentence>) and gets generic copy.
const SAFE_ERROR_CODE = /^[a-z0-9_]{1,40}$/;

export function LoginPage(props: LoginPageProps) {
  const {
    branding, apiClient, passkeyAdapter, lastSignInMethod,
    returnTo,
    oauthLoginPath = `/api/auth/login?return_to=${encodeURIComponent(returnTo)}`,
    magicLinkRequestPath = '/api/auth/magic-link/request',
    errorCopy: errorCopyOverride,
    onGoogleSignIn, googleErrorCopy, footerLinks, magicLinkSentCopy,
  } = props;

  const errorCopy = { ...DEFAULT_ERROR_COPY, ...(errorCopyOverride ?? {}) };

  // OAuth round-trip errors land here as ?error=foo
  const url = typeof window !== 'undefined' ? new URL(window.location.href) : null;
  const errorParam = url?.searchParams.get('error') ?? null;
  // Own-property + string check: `?error=__proto__` / `?error=constructor`
  // must not resolve to Object.prototype members.
  const knownCopy = errorParam !== null
    && Object.prototype.hasOwnProperty.call(errorCopy, errorParam)
    && typeof errorCopy[errorParam] === 'string'
    ? errorCopy[errorParam]
    : null;
  const errorMessage = errorParam
    ? knownCopy ?? (SAFE_ERROR_CODE.test(errorParam)
        ? `Sign-in error: ${errorParam}`
        : 'Sign-in failed. Try again.')
    : null;

  const [email, setEmail] = useState('');
  const [magicLink, setMagicLink] = useState<MagicLinkState>({ kind: 'idle' });

  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const conditionalStarted = useRef(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const googleInFlight = useRef(false);
  const emailErrorId = useId();

  // The page-level error sits above the sign-in buttons.
  // When a NEW Google error appears after mount, move focus to it so it is
  // scrolled into view on phones. A ?error= from the URL is not focused
  // (role="alert" announces it) so existing host behaviour is unchanged.
  const errorRef = useRef<HTMLDivElement>(null);
  const pageError = googleError ?? errorMessage;
  useEffect(() => {
    if (googleError) errorRef.current?.focus();
  }, [googleError]);
  const hasError = errorParam !== null || googleError !== null;

  // Read the device's last-used method to pick the primary CTA.
  // Returns null on first-ever visit; we fall back to "show all"
  // with Google as the visual primary.
  const [lastMethod] = useState<SignInMethod | null>(() => lastSignInMethod.read());

  // Click "Other ways to sign in" to expose every method when the
  // primary doesn't match what they want today.
  const [showAll, setShowAll] = useState(false);

  // Focus management: a control that unmounts on click would otherwise drop
  // focus to <body>. The flags are set by the click handlers, consumed by the
  // effects below once the new controls are in the DOM.
  const menuRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const focusAfterReveal = useRef(false);
  const focusEmailAfterReset = useRef(false);

  // Brand-lock to dark (login audit F2). The login is a brand surface, so
  // it always renders in the dark brand theme regardless of the OS / stored
  // preference (which only governs the look INSIDE the app). Without this,
  // a light-OS device gets a white, off-brand login card. On unmount the app
  // must honour the user's theme once signed in:
  //   - flag on (account-synced theme): re-resolve from the STORED preference.
  //     A passkey sign-in hydrates the account's theme (refreshUser) while
  //     this page is still mounted; restoring the old attribute would undo it
  //     and leave data-theme out of sync with averrow-theme / useTheme.
  //   - flag off: restore the prior value exactly, as before (nothing can
  //     change the stored preference while the login is shown).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'dark');
    return () => {
      if (APPEARANCE_PICKER_ENABLED) {
        applyThemePreference(readStoredTheme());
        return;
      }
      if (prev === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', prev);
    };
  }, []);

  useEffect(() => {
    if (!showAll || !focusAfterReveal.current) return;
    focusAfterReveal.current = false;
    const next = menuRef.current?.querySelector<HTMLElement>('[data-variant="secondary"]') ?? emailRef.current;
    next?.focus();
  }, [showAll]);

  useEffect(() => {
    if (magicLink.kind !== 'idle' || !focusEmailAfterReset.current) return;
    focusEmailAfterReset.current = false;
    emailRef.current?.focus();
  }, [magicLink.kind]);

  // Conditional UI — registered passkeys appear in the email field's
  // autofill dropdown. Spec-required and silent until interaction.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPasskeySupported(passkeyAdapter.isSupported());
    if (!conditionalStarted.current && passkeyAdapter.isSupported()) {
      conditionalStarted.current = true;
      passkeyAdapter.startConditionalUI(returnTo).catch(() => { /* silent */ });
    }
  }, [passkeyAdapter, returnTo]);

  const handlePasskey = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    setGoogleError(null);
    lastSignInMethod.write('passkey');
    try {
      const ok = await passkeyAdapter.signIn({
        email:    email.trim() || undefined,
        returnTo,
      });
      if (!ok) setPasskeyBusy(false);
      // On success, signIn navigates the page; this component unmounts.
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : 'Passkey sign-in failed.');
      setPasskeyBusy(false);
    }
  };

  const handleGoogle = async () => {
    lastSignInMethod.write('google');
    if (onGoogleSignIn) {
      if (googleInFlight.current) return;
      googleInFlight.current = true;
      setGoogleBusy(true);
      setGoogleError(null);
      try {
        await onGoogleSignIn();
        // Success: the host navigates (like passkey), so stay busy. A host
        // handler that resolves without navigating leaves the button busy.
      } catch (err) {
        // Rendered as a React text child (escaped) — never as HTML.
        let message: string | null = null;
        if (googleErrorCopy) {
          try { message = googleErrorCopy(err); } catch { message = null; }
        } else if (err instanceof Error && err.message) {
          message = err.message;
        }
        setGoogleError(message || 'Google sign-in failed. Try again.');
        googleInFlight.current = false;
        setGoogleBusy(false);
      }
      return;
    }
    if (typeof window !== 'undefined') {
      window.location.href = oauthLoginPath;
    }
  };

  const requestLink = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setMagicLink({ kind: 'error', message: 'Enter your email first.' });
      return;
    }
    setGoogleError(null);
    setMagicLink({ kind: 'sending' });
    lastSignInMethod.write('magic-link');
    try {
      const res = await apiClient.post<{ message?: string; expires_in_minutes?: number; error?: string }>(
        magicLinkRequestPath,
        { email: trimmed, return_to: returnTo },
      );
      if (res.success === false) {
        setMagicLink({ kind: 'error', message: res.error || 'Request failed.' });
        return;
      }
      setMagicLink({
        kind:    'sent',
        email:   trimmed,
        minutes: res.data?.expires_in_minutes ?? 30,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error. Please try again.';
      setMagicLink({ kind: 'error', message });
    }
  };

  // ─── Button block builders ─────────────────────────────────

  const passkeyButton = (variant: 'primary' | 'secondary') => (
    <Button
      key="passkey"
      type="button"
      size="lg"
      variant={variant}
      className="w-full"
      onClick={() => void handlePasskey()}
      disabled={passkeyBusy}
      aria-busy={passkeyBusy || undefined}
      data-variant={variant}
      data-testid="login-passkey"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      {passkeyBusy ? 'Waiting…' : 'Sign in with passkey'}
    </Button>
  );

  const googleButton = (variant: 'primary' | 'secondary') => (
    <Button
      key="google"
      type="button"
      size="lg"
      variant={variant}
      className="w-full"
      onClick={() => void handleGoogle()}
      disabled={googleBusy || undefined}
      aria-busy={googleBusy || undefined}
      data-variant={variant}
      data-testid="login-google"
    >
      {googleBusy ? 'Signing in…' : 'Sign in with Google'}
    </Button>
  );

  // ─── Render ───────────────────────────────────────────────

  // Visibility matrix:
  //   First-time (no hint):     Google primary; passkey HIDDEN
  //   Returning passkey:        passkey primary; Google + magic-link via "Other ways"
  //   Returning Google:         Google primary; passkey + magic-link via "Other ways"
  //   Returning magic-link:     no top buttons; magic-link block primary; others via "Other ways"
  //   Sign-in error / showAll:  full menu (all supported methods)
  // Exactly one primary CTA per state: "Send link" takes the primary slot
  // only when no button above it did.
  const showOptions = showAll || !lastMethod || hasError;
  const showPasskey = passkeySupported && (lastMethod === 'passkey' || showAll || hasError);
  const showGoogle  = !lastMethod || lastMethod === 'google' || showAll || hasError;

  const buttons: React.ReactNode[] = [];
  let topPrimary = false;

  if (lastMethod === 'passkey' && showPasskey) {
    buttons.push(passkeyButton('primary'));
    topPrimary = true;
    if (showGoogle) buttons.push(googleButton('secondary'));
  } else if (lastMethod === 'google' && showGoogle) {
    buttons.push(googleButton('primary'));
    topPrimary = true;
    if (showPasskey) buttons.push(passkeyButton('secondary'));
  } else if (lastMethod === 'magic-link' && showOptions) {
    if (showGoogle)  buttons.push(googleButton('secondary'));
    if (showPasskey) buttons.push(passkeyButton('secondary'));
  } else {
    if (showGoogle) {
      buttons.push(googleButton('primary'));
      topPrimary = true;
    }
    if (showPasskey && (showAll || hasError)) {
      buttons.push(passkeyButton('secondary'));
    }
  }

  const sendVariant = topPrimary ? 'secondary' : 'primary';
  const sending = magicLink.kind === 'sending';

  return (
    <main
      data-testid="login-page"
      className="flex min-h-dvh items-center justify-center bg-[var(--bg-page)] px-4 py-12 sm:px-6 sm:py-24"
    >
      <div className="w-full max-w-md rounded-[var(--card-radius,16px)] border border-[var(--border-base)] bg-[var(--bg-card)] px-6 py-8 text-center sm:px-8 sm:py-10">
        {/* Brand — product logo mark when supplied, else letter monogram */}
        <div className="flex flex-col items-center">
          {branding.brandMark ? (
            <div className="mb-4">{branding.brandMark}</div>
          ) : (
            <div
              aria-hidden
              className="mb-4 flex h-14 w-14 items-center justify-center rounded-[14px] bg-[var(--primary)] text-[20px] font-bold text-[var(--primary-ink)]"
            >
              {branding.brandLetters}
            </div>
          )}
          <h1 className="m-0 text-type-display text-[var(--text-primary)]">
            {branding.productName}
          </h1>
          <p className="m-0 mt-2 text-type-label text-[var(--text-secondary)]">
            {branding.tagline}
          </p>
        </div>

        {/* Welcome line for returning users */}
        {lastMethod && !errorParam && googleError === null && !showAll && (
          <p className="m-0 mt-6 text-type-small text-[var(--text-secondary)]">
            {welcomeCopy(lastMethod)}
          </p>
        )}

        {/* Page-level error, above the CTAs. Google errors take focus. */}
        {pageError && (
          <div
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            data-testid="login-error"
            className="mt-6 text-left outline-none"
          >
            <Banner tone="critical" density="compact" title={pageError} />
          </div>
        )}

        {/* Primary + (optional) secondary buttons */}
        {buttons.length > 0 && (
          <div ref={menuRef} className="mt-6 flex flex-col gap-2.5">
            {buttons}
          </div>
        )}

        {passkeyError && (
          <FieldError data-testid="login-passkey-error" className="mt-3 text-left">
            {passkeyError}
          </FieldError>
        )}

        {/* "Other ways to sign in" disclosure */}
        {lastMethod && !showAll && !errorParam && googleError === null && (
          <Button
            type="button"
            variant="ghost"
            size="md"
            className="mt-3 w-full"
            onClick={() => { focusAfterReveal.current = true; setShowAll(true); }}
          >
            Other ways to sign in
          </Button>
        )}

        {/* Divider */}
        {buttons.length > 0 && (
          <div className="mt-6 flex items-center gap-3 text-type-label text-[var(--text-tertiary)]">
            <span className="h-px flex-1 bg-[var(--border-base)]" />
            <span>or</span>
            <span className="h-px flex-1 bg-[var(--border-base)]" />
          </div>
        )}

        {/* Magic link */}
        <div className={`${buttons.length > 0 ? 'mt-6' : 'mt-8'} text-left`}>
          {magicLink.kind === 'sent' ? (
            <div role="status" data-testid="login-magic-link-sent">
              <Banner
                tone="success"
                density="compact"
                title={magicLinkSentCopy ? magicLinkSentCopy(magicLink.email) : 'Check your inbox.'}
                actions={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => { focusEmailAfterReset.current = true; setMagicLink({ kind: 'idle' }); }}
                  >
                    Use a different email
                  </Button>
                )}
              >
                {magicLinkSentCopy ? null : (
                  <>
                    We sent a sign-in link to <strong>{magicLink.email}</strong>. The link
                    expires in {magicLink.minutes} minutes and can only be used once.
                  </>
                )}
              </Banner>
            </div>
          ) : (
            <>
              <Field label="Email me a sign-in link">
                <Input
                  ref={emailRef}
                  id="login-email"
                  type="email"
                  inputMode="email"
                  autoComplete="username webauthn"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={sending}
                  data-testid="login-email"
                  invalid={magicLink.kind === 'error'}
                  aria-describedby={magicLink.kind === 'error' ? emailErrorId : undefined}
                />
                {magicLink.kind === 'error' && (
                  <FieldError id={emailErrorId} data-testid="login-magic-link-error" className="mt-1.5">
                    {magicLink.message}
                  </FieldError>
                )}
              </Field>
              <Button
                type="button"
                size="lg"
                variant={sendVariant}
                className="mt-3 w-full"
                onClick={() => void requestLink()}
                disabled={sending}
                aria-busy={sending || undefined}
                data-variant={sendVariant}
                data-testid="login-magic-link-submit"
              >
                {sending ? 'Sending…' : 'Send link'}
              </Button>
              <p className="m-0 mt-3 text-type-small text-[var(--text-help)]">
                Works with any email — Microsoft 365, Outlook, Yahoo, custom
                domain. No password needed.
              </p>
            </>
          )}
        </div>

        {/* Footer pillars */}
        <p className="m-0 mt-8 text-type-label text-[var(--text-muted)] [text-wrap:balance]">
          {branding.footerPillars}
        </p>

        {footerLinks != null && (
          <div className="mt-4" data-testid="login-footer-links">
            {footerLinks}
          </div>
        )}
      </div>
    </main>
  );
}

function welcomeCopy(method: SignInMethod): string {
  if (method === 'passkey') return 'Welcome back. Use your passkey to sign in.';
  if (method === 'google')  return 'Welcome back. Use Google to sign in.';
  return 'Welcome back. Use your email to sign in.';
}
