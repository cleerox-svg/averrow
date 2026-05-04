// Login screen — FarmTrack-aligned composition with Averrow branding.
//
// Three auth options stacked:
//   1. Sign in with passkey (green primary, when supported)
//   2. Continue with Google  (amber primary)
//   3. Email me a sign-in link (magic-link below the divider)
//
// Brand tile: AV gradient square + "Averrow" + AI-FIRST THREAT INTELLIGENCE
// tagline. Footer pillars: DETECT · ANALYZE · CORRELATE · RESPOND.
//
// Conditional UI starts on mount so registered passkeys appear in the
// email field's autocomplete dropdown — typing pulls them up before
// the user even clicks Passkey.

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import {
  isPasskeySupported, signInWithPasskey, startConditionalUI,
} from '@/lib/passkeys';

type MagicLinkState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string; minutes: number }
  | { kind: 'error'; message: string };

const ERROR_COPY: Record<string, string> = {
  invalid_link: 'That sign-in link looks malformed.',
  link_used_or_invalid: 'That sign-in link was already used or is invalid.',
  link_expired: 'That sign-in link expired. Request a new one below.',
  account_deactivated: 'This account has been deactivated.',
  signin_failed: 'Sign-in failed. Try again.',
};

export function Login() {
  const { login } = useAuth();

  // OAuth round-trip errors land here as ?error=foo
  const url = new URL(window.location.href);
  const errorParam = url.searchParams.get('error');
  const errorMessage = errorParam
    ? ERROR_COPY[errorParam] ?? `Sign-in error: ${errorParam}`
    : null;

  const [email, setEmail] = useState('');
  const [magicLink, setMagicLink] = useState<MagicLinkState>({ kind: 'idle' });

  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const conditionalStarted = useRef(false);

  // Start conditional-UI ("passkey autofill") so the email field's
  // autocomplete dropdown shows registered passkeys for this site.
  useEffect(() => {
    setPasskeySupported(isPasskeySupported());
    if (!conditionalStarted.current && isPasskeySupported()) {
      conditionalStarted.current = true;
      startConditionalUI('/v2/');
    }
  }, []);

  const handlePasskey = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const ok = await signInWithPasskey({
        email: email.trim() || undefined,
        returnTo: '/v2/',
      });
      if (!ok) {
        // User dismissed the OS prompt — silent return.
        setPasskeyBusy(false);
      }
      // On success, signInWithPasskey navigates the page; this component unmounts.
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : 'Passkey sign-in failed.');
      setPasskeyBusy(false);
    }
  };

  const requestLink = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setMagicLink({ kind: 'error', message: 'Enter your email first.' });
      return;
    }
    setMagicLink({ kind: 'sending' });
    try {
      const res = await api.post<{ message?: string; expires_in_minutes?: number; error?: string }>(
        '/api/auth/magic-link/request',
        { email: trimmed, return_to: '/v2/' },
      );
      if (res.success === false) {
        setMagicLink({ kind: 'error', message: res.error || 'Request failed.' });
        return;
      }
      setMagicLink({
        kind: 'sent',
        email: trimmed,
        minutes: res.data?.expires_in_minutes ?? 30,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error. Please try again.';
      setMagicLink({ kind: 'error', message });
    }
  };

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
            top: 0,
            left: 0,
            right: 0,
            height: 1,
            background: 'linear-gradient(90deg, transparent, var(--amber-border, rgba(229,168,50,0.25)) 25%, var(--amber-border, rgba(229,168,50,0.25)) 75%, transparent)',
            pointerEvents: 'none',
          }}
        />

        {/* Brand tile */}
        <div className="flex flex-col items-center">
          <div
            className="flex items-center justify-center font-bold"
            style={{
              width: 56,
              height: 56,
              background: 'linear-gradient(135deg, var(--amber), var(--amber-dim))',
              color: 'var(--text-on-amber, #0A0F1E)',
              borderRadius: 14,
              fontSize: 20,
              fontFamily: 'var(--font-display, inherit)',
              boxShadow: '0 0 24px var(--amber-glow, rgba(229,168,50,0.40))',
              marginBottom: 16,
            }}
          >
            AV
          </div>
          <span
            className="font-bold tracking-tight"
            style={{
              color: 'var(--text-primary)',
              fontSize: 28,
              letterSpacing: -0.5,
            }}
          >
            Averrow
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
            AI-First Threat Intelligence
          </span>
        </div>

        {/* Passkey button (returning users) */}
        {passkeySupported && (
          <button
            type="button"
            onClick={() => void handlePasskey()}
            disabled={passkeyBusy}
            className="mt-8 inline-flex w-full items-center justify-center gap-2 font-mono uppercase"
            style={{
              background: 'linear-gradient(135deg, var(--green), rgba(60,184,120,0.7))',
              color: 'var(--text-on-amber, #0A0F1E)',
              border: '1px solid rgba(60,184,120,0.60)',
              padding: '14px 24px',
              borderRadius: 12,
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: '0.08em',
              minHeight: 48,
              boxShadow: [
                '0 4px 16px rgba(60,184,120,0.30)',
                '0 2px 4px rgba(0,0,0,0.40)',
                'inset 0 1px 0 rgba(255,255,255,0.30)',
              ].join(', '),
              cursor: passkeyBusy ? 'wait' : 'pointer',
            }}
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.4"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden
            >
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            {passkeyBusy ? 'Waiting…' : 'Sign in with passkey'}
          </button>
        )}
        {passkeyError && (
          <p className="mt-2 font-mono" style={{ color: 'var(--sev-critical)', fontSize: 11 }}>
            {passkeyError}
          </p>
        )}

        {/* Google */}
        <button
          type="button"
          onClick={login}
          className="mt-3 inline-flex w-full items-center justify-center font-mono uppercase"
          style={{
            background: 'linear-gradient(135deg, var(--amber), var(--amber-dim))',
            color: 'var(--text-on-amber, #0A0F1E)',
            border: '1px solid rgba(229,168,50,0.60)',
            padding: '14px 24px',
            borderRadius: 12,
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: '0.08em',
            minHeight: 48,
            boxShadow: [
              '0 4px 16px var(--amber-glow, rgba(229,168,50,0.40))',
              '0 2px 4px rgba(0,0,0,0.40)',
              'inset 0 1px 0 rgba(255,255,255,0.30)',
              'inset 0 -1px 0 rgba(0,0,0,0.20)',
            ].join(', '),
            cursor: 'pointer',
            width: '100%',
          }}
        >
          Sign in with Google
        </button>

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
                // `username webauthn` enables passkey autofill via conditional UI.
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
                  background: 'linear-gradient(135deg, var(--bg-elevated, var(--bg-card)), var(--bg-card-deep, var(--bg-card)))',
                  color: 'var(--text-primary)',
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
          Detect · Analyze · Correlate · Respond
        </p>
      </div>
    </section>
  );
}
