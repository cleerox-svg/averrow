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
import type { LoginMessages, LoginPageProps, SignInMethod } from './types';
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

// Only codes with known copy are mapped; any other ?error= value is
// attacker-controllable (content spoofing) and gets generic copy.

// Closed set of sign-in failure messages. Server- or exception-supplied text
// is never rendered (content spoofing, raw technical errors); failures map to
// one of these by HTTP status / DOMException name. Hosts may override any key
// through the `messages` prop.
const DEFAULT_LOGIN_MESSAGES: Required<LoginMessages> = {
  emailRequired:       'Enter your email first.',
  emailInvalid:        'Enter a valid email address.',
  rateLimited:         'Too many requests. Try again in a few minutes.',
  magicLinkFailed:     "We couldn't send the link. Try again.",
  passkeyCancelled:    'Passkey sign-in was cancelled. Try again or use another method.',
  passkeyInvalidState: 'This passkey cannot be used here. Try another method.',
  passkeySecurity:     'Passkey sign-in is not available on this page. Use another method.',
  passkeyFailed:       'Passkey sign-in failed. Try again or use another method.',
  googleFailed:        'Google sign-in failed. Try again or use another method.',
};

/** Pull a numeric HTTP status off an API envelope or a thrown ApiError. */
function httpStatusOf(v: unknown): number | null {
  if (typeof v === 'object' && v !== null && 'status' in v) {
    const st = (v as { status?: unknown }).status;
    if (typeof st === 'number' && Number.isFinite(st)) return st;
  }
  return null;
}

function magicLinkFailureKey(status: number | null): keyof LoginMessages {
  if (status === 400 || status === 422) return 'emailInvalid';
  if (status === 429) return 'rateLimited';
  return 'magicLinkFailed';
}

/** Map a WebAuthn failure by DOMException name, looking through a wrapper's `cause`. */
function passkeyFailureKey(err: unknown): keyof LoginMessages {
  const names: string[] = [];
  if (typeof err === 'object' && err !== null) {
    const n = (err as { name?: unknown }).name;
    if (typeof n === 'string') names.push(n);
    const c = (err as { cause?: unknown }).cause;
    if (typeof c === 'object' && c !== null) {
      const cn = (c as { name?: unknown }).name;
      if (typeof cn === 'string') names.push(cn);
    }
  }
  if (names.includes('NotAllowedError') || names.includes('AbortError')) return 'passkeyCancelled';
  if (names.includes('InvalidStateError')) return 'passkeyInvalidState';
  if (names.includes('SecurityError')) return 'passkeySecurity';
  return 'passkeyFailed';
}

function safeIsSupported(adapter: { isSupported: () => boolean }): boolean {
  try { return adapter.isSupported() === true; } catch { return false; }
}

export function LoginPage(props: LoginPageProps) {
  const {
    branding, apiClient, passkeyAdapter, lastSignInMethod,
    returnTo,
    oauthLoginPath = `/api/auth/login?return_to=${encodeURIComponent(returnTo)}`,
    magicLinkRequestPath = '/api/auth/magic-link/request',
    errorCopy: errorCopyOverride, messages: messagesOverride,
    onGoogleSignIn, googleErrorCopy, footerLinks, magicLinkSentCopy, magicLinkSentTitle,
  } = props;

  const errorCopy = { ...DEFAULT_ERROR_COPY, ...(errorCopyOverride ?? {}) };
  // Non-empty string overrides only; anything else keeps the fixed default.
  const msg = { ...DEFAULT_LOGIN_MESSAGES };
  for (const k of Object.keys(DEFAULT_LOGIN_MESSAGES) as (keyof LoginMessages)[]) {
    const o = messagesOverride?.[k];
    if (typeof o === 'string' && o) msg[k] = o;
  }

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
    ? knownCopy ?? 'Sign-in failed. Try again.'
    : null;

  const [email, setEmail] = useState('');
  const [magicLink, setMagicLink] = useState<MagicLinkState>({ kind: 'idle' });

  // Lazy init so returning-passkey users get the right primary/secondary
  // split on first paint (no post-paint flip of "Send link").
  const [passkeySupported, setPasskeySupported] = useState(
    () => typeof window !== 'undefined' && safeIsSupported(passkeyAdapter),
  );
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
  // Test ids of the controls visible before "Other ways" expands, so focus can
  // go to the first control that is NEW (primary or secondary).
  const visibleBeforeReveal = useRef<string[]>([]);
  const sentRef = useRef<HTMLDivElement>(null);

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
    const before = visibleBeforeReveal.current;
    const fresh = [...(menuRef.current?.querySelectorAll<HTMLElement>('button[data-testid]') ?? [])]
      .find((b) => !before.includes(b.dataset.testid ?? ''));
    (fresh ?? emailRef.current)?.focus();
  }, [showAll]);

  // The focused "Send link" button unmounts when the request succeeds; move
  // focus to the next logical action instead of dropping it to <body>.
  const isSent = magicLink.kind === 'sent';
  useEffect(() => {
    if (isSent) sentRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [isSent]);

  useEffect(() => {
    if (magicLink.kind !== 'idle' || !focusEmailAfterReset.current) return;
    focusEmailAfterReset.current = false;
    emailRef.current?.focus();
  }, [magicLink.kind]);

  // Conditional UI — registered passkeys appear in the email field's
  // autofill dropdown. Spec-required and silent until interaction.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const supported = safeIsSupported(passkeyAdapter);
    setPasskeySupported(supported);
    if (!conditionalStarted.current && supported) {
      conditionalStarted.current = true;
      try {
        passkeyAdapter.startConditionalUI(returnTo).catch(() => { /* silent */ });
      } catch { /* silent */ }
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
      setPasskeyError(msg[passkeyFailureKey(err)]);
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
        }
        setGoogleError(message || msg.googleFailed);
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
      setMagicLink({ kind: 'error', message: msg.emailRequired });
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
        setMagicLink({ kind: 'error', message: msg[magicLinkFailureKey(httpStatusOf(res))] });
        return;
      }
      setMagicLink({
        kind:    'sent',
        email:   trimmed,
        minutes: res.data?.expires_in_minutes ?? 30,
      });
    } catch (err) {
      setMagicLink({ kind: 'error', message: msg[magicLinkFailureKey(httpStatusOf(err))] });
    }
  };

  // ─── Button block builders ─────────────────────────────────

  // Secondary buttons take the stronger border so they read as buttons next
  // to the input above them (local to this page; the shared Button is unchanged).
  const secondaryCls = (variant: 'primary' | 'secondary') =>
    variant === 'secondary' ? 'w-full border-[var(--border-strong)]' : 'w-full';

  const passkeyButton = (variant: 'primary' | 'secondary') => (
    <Button
      key="passkey"
      type="button"
      size="lg"
      variant={variant}
      className={secondaryCls(variant)}
      onClick={() => void handlePasskey()}
      disabled={passkeyBusy}
      aria-busy={passkeyBusy || undefined}
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
      className={secondaryCls(variant)}
      onClick={() => void handleGoogle()}
      disabled={googleBusy || undefined}
      aria-busy={googleBusy || undefined}
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
  // Short title; custom body copy goes in the Banner children (block-safe).
  const sentTitle = isSent
    ? (magicLinkSentTitle?.(magicLink.email)
        ?? (magicLinkSentCopy ? 'Sign-in link requested' : 'Check your inbox.'))
    : null;

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
              className="mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-[var(--primary)] text-[18px] font-bold text-[var(--primary-ink)]"
            >
              {branding.brandLetters}
            </div>
          )}
          <h1 className="m-0 text-type-h1 text-[var(--text-primary)]">
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
            onClick={() => {
              visibleBeforeReveal.current = [...(menuRef.current?.querySelectorAll<HTMLElement>('button[data-testid]') ?? [])]
                .map((b) => b.dataset.testid ?? '');
              focusAfterReveal.current = true;
              setShowAll(true);
            }}
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
            <div ref={sentRef} role="status" data-testid="login-magic-link-sent">
              <Banner tone="success" density="compact" title={sentTitle}>
                {magicLinkSentCopy ? magicLinkSentCopy(magicLink.email) : (
                  <>
                    We sent a sign-in link to <strong>{magicLink.email}</strong>. The link
                    expires in {magicLink.minutes} minutes and can only be used once.
                  </>
                )}
              </Banner>
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="mt-3 w-full"
                onClick={() => { focusEmailAfterReset.current = true; setMagicLink({ kind: 'idle' }); }}
              >
                Use a different email
              </Button>
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
                className={`mt-3 ${secondaryCls(sendVariant)}`}
                onClick={() => void requestLink()}
                disabled={sending}
                aria-busy={sending || undefined}
                data-testid="login-magic-link-submit"
              >
                {sending ? 'Sending…' : 'Send link'}
              </Button>
              <p className="m-0 mt-3 text-type-small text-[var(--text-tertiary)]">
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
