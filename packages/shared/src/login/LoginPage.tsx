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

import { useEffect, useRef, useState } from 'react';
import type { LoginPageProps, SignInMethod } from './types';

type MagicLinkState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string; minutes: number }
  | { kind: 'error'; message: string };

const DEFAULT_ERROR_COPY: Record<string, string> = {
  invalid_link:         'That sign-in link looks malformed.',
  link_used_or_invalid: 'That sign-in link was already used or is invalid.',
  link_expired:         'That sign-in link expired. Request a new one below.',
  account_deactivated:  'This account has been deactivated.',
  signin_failed:        'Sign-in failed. Try again.',
};

export function LoginPage(props: LoginPageProps) {
  const {
    branding, apiClient, passkeyAdapter, lastSignInMethod,
    returnTo,
    oauthLoginPath = `/api/auth/login?return_to=${encodeURIComponent(returnTo)}`,
    magicLinkRequestPath = '/api/auth/magic-link/request',
    errorCopy: errorCopyOverride,
  } = props;

  const errorCopy = { ...DEFAULT_ERROR_COPY, ...(errorCopyOverride ?? {}) };

  // OAuth round-trip errors land here as ?error=foo
  const url = typeof window !== 'undefined' ? new URL(window.location.href) : null;
  const errorParam = url?.searchParams.get('error') ?? null;
  const errorMessage = errorParam
    ? errorCopy[errorParam] ?? `Sign-in error: ${errorParam}`
    : null;

  const [email, setEmail] = useState('');
  const [magicLink, setMagicLink] = useState<MagicLinkState>({ kind: 'idle' });

  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const conditionalStarted = useRef(false);

  // Read the device's last-used method to pick the primary CTA.
  // Returns null on first-ever visit; we fall back to "show all"
  // with Google as the visual primary.
  const [lastMethod] = useState<SignInMethod | null>(() => lastSignInMethod.read());

  // Click "Other ways to sign in" to expose every method when the
  // primary doesn't match what they want today.
  const [showAll, setShowAll] = useState(false);

  // Brand-lock to dark (login audit F2). The login is a brand surface, so
  // it always renders in the dark brand theme regardless of the OS / stored
  // preference (which only governs the look INSIDE the app). Without this,
  // a light-OS device gets a white, off-brand login card. Restore the prior
  // value on unmount so the app honours the user's theme once signed in.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'dark');
    return () => {
      if (prev === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', prev);
    };
  }, []);

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

  const handleGoogle = () => {
    lastSignInMethod.write('google');
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
    <button
      key="passkey"
      type="button"
      onClick={() => void handlePasskey()}
      disabled={passkeyBusy}
      className="inline-flex w-full items-center justify-center gap-2 font-mono uppercase"
      style={{
        background: variant === 'primary'
          ? 'linear-gradient(135deg, var(--green), rgba(60,184,120,0.7))'
          : 'transparent',
        color:      variant === 'primary' ? 'var(--text-on-amber, #0A0F1E)' : 'var(--text-primary)',
        border:     '1px solid rgba(60,184,120,0.60)',
        padding:    '14px 24px',
        borderRadius: 12,
        fontSize:   12,
        fontWeight: 800,
        letterSpacing: '0.08em',
        minHeight:  48,
        boxShadow: variant === 'primary'
          ? [
              '0 4px 16px rgba(60,184,120,0.30)',
              '0 2px 4px rgba(0,0,0,0.40)',
              'inset 0 1px 0 rgba(255,255,255,0.30)',
            ].join(', ')
          : 'none',
        cursor: passkeyBusy ? 'wait' : 'pointer',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      {passkeyBusy ? 'Waiting…' : 'Sign in with passkey'}
    </button>
  );

  const googleButton = (variant: 'primary' | 'secondary') => (
    <button
      key="google"
      type="button"
      onClick={handleGoogle}
      className="inline-flex w-full items-center justify-center font-mono uppercase"
      style={{
        background: variant === 'primary'
          ? 'linear-gradient(135deg, var(--amber), var(--amber-dim))'
          : 'transparent',
        color:      variant === 'primary' ? 'var(--text-on-amber, #0A0F1E)' : 'var(--text-primary)',
        border:     '1px solid rgba(229,168,50,0.60)',
        padding:    '14px 24px',
        borderRadius: 12,
        fontSize:   12,
        fontWeight: 800,
        letterSpacing: '0.08em',
        minHeight:  48,
        boxShadow: variant === 'primary'
          ? [
              '0 4px 16px var(--amber-glow, rgba(229,168,50,0.40))',
              '0 2px 4px rgba(0,0,0,0.40)',
              'inset 0 1px 0 rgba(255,255,255,0.30)',
              'inset 0 -1px 0 rgba(0,0,0,0.20)',
            ].join(', ')
          : 'none',
        cursor: 'pointer',
        width:  '100%',
      }}
    >
      Sign in with Google
    </button>
  );

  // ─── Render ───────────────────────────────────────────────

  // Visibility matrix:
  //   First-time (no hint):     Google primary; passkey HIDDEN
  //   Returning passkey:        passkey primary; Google + magic-link via "Other ways"
  //   Returning Google:         Google primary; passkey + magic-link via "Other ways"
  //   Returning magic-link:     no top buttons; magic-link block primary; others via "Other ways"
  //   Sign-in error / showAll:  full menu (all supported methods)
  const showOptions = showAll || !lastMethod || (errorParam !== null);
  const showPasskey = passkeySupported && (lastMethod === 'passkey' || showAll || errorParam !== null);
  const showGoogle  = !lastMethod || lastMethod === 'google' || showAll || errorParam !== null;

  const buttons: React.ReactNode[] = [];

  if (lastMethod === 'passkey' && showPasskey) {
    buttons.push(passkeyButton('primary'));
    if (showGoogle) buttons.push(googleButton('secondary'));
  } else if (lastMethod === 'google' && showGoogle) {
    buttons.push(googleButton('primary'));
    if (showPasskey) buttons.push(passkeyButton('secondary'));
  } else if (lastMethod === 'magic-link' && showOptions) {
    if (showGoogle)  buttons.push(googleButton('secondary'));
    if (showPasskey) buttons.push(passkeyButton('secondary'));
  } else {
    if (showGoogle)  buttons.push(googleButton('primary'));
    if (showPasskey && (showAll || errorParam !== null)) {
      buttons.push(passkeyButton('secondary'));
    }
  }

  return (
    <section
      className="flex min-h-screen items-center justify-center px-4 py-12 sm:px-6 sm:py-24"
      style={{ background: 'var(--bg-page)' }}
    >
      <div
        className="w-full max-w-md text-center"
        style={{
          padding: '40px 32px',
          background: 'linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep, var(--bg-card)) 100%)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid var(--border-base)',
          borderRadius: 'var(--card-radius, 16px)',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: [
            '0 8px 32px rgba(0,0,0,0.60)',
            'inset 0 1px 0 var(--border-strong, rgba(255,255,255,0.14))',
            'inset 0 -1px 0 rgba(0,0,0,0.40)',
          ].join(', '),
        }}
      >
        {/* amber rim along the top */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0,
            height: 1,
            background: 'linear-gradient(90deg, transparent, var(--amber-border, rgba(229,168,50,0.25)) 25%, var(--amber-border, rgba(229,168,50,0.25)) 75%, transparent)',
            pointerEvents: 'none',
          }}
        />

        {/* Brand tile — product logo mark when supplied, else letter monogram */}
        <div className="flex flex-col items-center">
          {branding.brandMark ? (
            <div style={{ marginBottom: 16 }}>{branding.brandMark}</div>
          ) : (
            <div
              className="flex items-center justify-center font-bold"
              style={{
                width: 56, height: 56,
                background: 'linear-gradient(135deg, var(--amber), var(--amber-dim))',
                color: 'var(--text-on-amber, #0A0F1E)',
                borderRadius: 14,
                fontSize: 20,
                fontFamily: 'var(--font-display, inherit)',
                boxShadow: '0 0 24px var(--amber-glow, rgba(229,168,50,0.40))',
                marginBottom: 16,
              }}
            >
              {branding.brandLetters}
            </div>
          )}
          <span
            className="font-bold tracking-tight"
            style={{
              color: 'var(--text-primary)',
              fontSize: 28,
              letterSpacing: -0.5,
            }}
          >
            {branding.productName}
          </span>
          <span
            className="mt-2 font-mono uppercase"
            style={{
              color: 'var(--amber)',
              fontSize: 9,
              letterSpacing: '0.24em',
              fontWeight: 700,
            }}
          >
            {branding.tagline}
          </span>
        </div>

        {/* "Welcome back" pill for returning users */}
        {lastMethod && !errorParam && !showAll && (
          <p
            className="mt-6 font-mono uppercase"
            style={{
              color: 'var(--text-tertiary)',
              fontSize: 9,
              letterSpacing: '0.18em',
              fontWeight: 600,
            }}
          >
            Welcome back · sign in with {labelFor(lastMethod)}
          </p>
        )}

        {/* Primary + (optional) secondary buttons */}
        <div className="mt-6 space-y-2.5">
          {buttons}
        </div>

        {passkeyError && (
          <p className="mt-2 font-mono" style={{ color: 'var(--sev-critical)', fontSize: 11 }}>
            {passkeyError}
          </p>
        )}

        {/* "Other ways to sign in" disclosure */}
        {lastMethod && !showAll && !errorParam && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-4 font-mono uppercase"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-tertiary)',
              fontSize: 10,
              letterSpacing: '0.18em',
              fontWeight: 600,
              padding: 0,
              cursor: 'pointer',
            }}
          >
            Other ways to sign in →
          </button>
        )}

        {/* Divider */}
        <div className="mt-6 flex items-center gap-3" style={{ color: 'var(--text-tertiary)' }}>
          <span style={{ flex: 1, height: 1, background: 'var(--border-base)' }} />
          <span className="font-mono uppercase" style={{ fontSize: 9, letterSpacing: '0.18em' }}>or</span>
          <span style={{ flex: 1, height: 1, background: 'var(--border-base)' }} />
        </div>

        {/* Magic link */}
        <div className="mt-6 text-left">
          <label
            htmlFor="login-email"
            className="block font-mono uppercase"
            style={{
              color: 'var(--text-tertiary)',
              fontSize: 9,
              letterSpacing: '0.18em',
              marginBottom: 6,
            }}
          >
            Email me a sign-in link
          </label>
          {magicLink.kind === 'sent' ? (
            <div
              role="status"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--green)',
                borderRadius: 10,
                padding: '12px 14px',
                color: 'var(--text-primary)',
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              <strong style={{ color: 'var(--green)' }}>Check your inbox.</strong>
              {' '}We sent a sign-in link to{' '}
              <span className="font-mono">{magicLink.email}</span>. The link
              expires in {magicLink.minutes} minutes and can only be used once.
              <button
                type="button"
                onClick={() => setMagicLink({ kind: 'idle' })}
                className="mt-2 block font-mono uppercase"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--amber)',
                  fontSize: 10,
                  letterSpacing: '0.14em',
                  fontWeight: 700,
                  padding: 0,
                  cursor: 'pointer',
                }}
              >
                Use a different email →
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="login-email"
                type="email"
                inputMode="email"
                autoComplete="username webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={magicLink.kind === 'sending'}
                style={{
                  flex: 1,
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-base)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  fontSize: 14,
                  minHeight: 44,
                }}
              />
              <button
                type="button"
                onClick={() => void requestLink()}
                disabled={magicLink.kind === 'sending'}
                className="font-mono uppercase"
                style={{
                  background: lastMethod === 'magic-link'
                    ? 'linear-gradient(135deg, var(--amber), var(--amber-dim))'
                    : 'linear-gradient(135deg, var(--bg-elevated, var(--bg-card)), var(--bg-card-deep, var(--bg-card)))',
                  color: lastMethod === 'magic-link'
                    ? 'var(--text-on-amber, #0A0F1E)'
                    : 'var(--text-primary)',
                  border: '1px solid var(--border-strong, var(--border-base))',
                  borderRadius: 10,
                  padding: '12px 16px',
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: '0.10em',
                  minHeight: 44,
                  cursor: magicLink.kind === 'sending' ? 'wait' : 'pointer',
                }}
              >
                {magicLink.kind === 'sending' ? 'Sending…' : 'Send link'}
              </button>
            </div>
          )}
          {magicLink.kind === 'error' && (
            <p className="mt-2 font-mono" style={{ color: 'var(--sev-critical)', fontSize: 11 }}>
              {magicLink.message}
            </p>
          )}
          {magicLink.kind !== 'sent' && (
            <p className="mt-2 font-mono" style={{ color: 'var(--text-tertiary)', fontSize: 11, lineHeight: 1.5 }}>
              Works with any email — Microsoft 365, Outlook, Yahoo, custom
              domain. No password needed.
            </p>
          )}
        </div>

        {errorMessage && (
          <p className="mt-6 font-mono" style={{ color: 'var(--sev-critical)', fontSize: 12 }}>
            {errorMessage}
          </p>
        )}

        {/* Footer pillars */}
        <p
          className="mt-8 font-mono uppercase"
          style={{
            color: 'var(--text-muted)',
            fontSize: 10,
            letterSpacing: '0.22em',
            fontWeight: 700,
          }}
        >
          {branding.footerPillars}
        </p>
      </div>
    </section>
  );
}

function labelFor(method: SignInMethod): string {
  if (method === 'passkey') return 'passkey';
  if (method === 'google')  return 'Google';
  return 'a sign-in link';
}
