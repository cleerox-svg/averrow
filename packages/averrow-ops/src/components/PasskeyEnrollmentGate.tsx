// Mandatory passkey-enrollment gate (H-3, AUTH_AUDIT_2026-06).
//
// Privileged users (admin / super_admin) only receive a FULL session when
// they authenticate with a passkey. Signing in via Google or a magic link
// yields an enrollment-scoped session: the backend 403s every protected
// route with `passkey_enrollment_required`, and `/api/auth/me` returns
// `passkey_required: true`. This component renders a blocking, non-
// dismissible gate over the whole app whenever that flag is set, walking
// the user through:
//
//   1. Register a passkey on this device (skipped if they already have one
//      — e.g. they have a synced passkey but signed in with Google on a new
//      browser).
//   2. Sign in WITH that passkey, which mints a full session (method =
//      'passkey') and reloads into the app.
//
// Self-gates on `user.passkey_required`, so it can sit at the Shell root
// with no per-route logic — exactly like FirstSignInPasskeyPrompt. Unlike
// that prompt, it cannot be dismissed: enrollment is mandatory.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { isPasskeySupported, registerPasskey, signInWithPasskey } from '@/lib/passkeys';
import { AverrowMark } from '@/components/brand/AverrowMark';

export function PasskeyEnrollmentGate() {
  const { user, logout, refreshUser } = useAuth();
  const { showToast } = useToast();
  // If the user already has a passkey, skip straight to the sign-in step.
  const [registered, setRegistered] = useState((user?.passkey_count ?? 0) > 0);
  const [busy, setBusy] = useState(false);

  if (!user?.passkey_required) return null;
  if (typeof document === 'undefined') return null;

  const supported = isPasskeySupported();

  const onRegister = async () => {
    setBusy(true);
    try {
      await registerPasskey();
      showToast('Passkey created. Now sign in with it to continue.', 'success');
      setRegistered(true);
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        // User cancelled the OS prompt — leave them on the gate.
      } else {
        showToast(err instanceof Error ? err.message : "Couldn't create passkey", 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const onSignIn = async () => {
    setBusy(true);
    try {
      // Mints a full session (method='passkey'), replacing this
      // enrollment-scoped session. Host-side hydration (login audit F3):
      // this gate already lives at /v2/, so the legacy hard-nav to
      // /v2/#token=… is a SAME-PATH hash change that never reloads the
      // document — the AuthProvider (which only reads the hash on mount)
      // never consumes the token, so the button hangs on "Waiting for
      // passkey…" until a manual refresh. Instead, set the new full-session
      // token in memory and refresh the auth context in place; the gate
      // self-unmounts the moment `passkey_required` flips false. No reload.
      const ok = await signInWithPasskey({
        email: user.email,
        returnTo: '/v2/',
        onSuccess: async (accessToken) => {
          api.setTokens(accessToken, '');
          await refreshUser();
        },
      });
      if (!ok) setBusy(false); // cancelled — stay on the gate
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Passkey sign-in failed", 'error');
      setBusy(false);
    }
  };

  const primaryLabel = registered
    ? (busy ? 'Waiting for passkey…' : 'Sign in with your passkey')
    : (busy ? 'Setting up…' : 'Set up your passkey');

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="passkey-gate-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 600,
        background: 'rgba(4,9,18,0.92)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: 'linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep, var(--bg-card)) 100%)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid var(--border-strong, var(--border-base))',
          borderRadius: 16,
          padding: 28,
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Averrow brand lockup — real logo mark + wordmark, matching the
            login + email branding (not a generic security glyph). */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 16 }}>
          <AverrowMark size={56} />
          <div
            style={{
              marginTop: 10,
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 10,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}
          >
            Averrow · Threat Interceptor
          </div>
        </div>

        <h2
          id="passkey-gate-title"
          style={{
            color: 'var(--text-primary)',
            fontSize: 20,
            fontWeight: 800,
            letterSpacing: -0.3,
            textAlign: 'center',
            margin: 0,
          }}
        >
          A passkey is required
        </h2>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 13,
            lineHeight: 1.5,
            textAlign: 'center',
            margin: '8px 0 0',
          }}
        >
          Staff accounts must sign in with a phishing-resistant passkey
          (Touch ID, Face ID, Windows Hello, or a security key).
          {registered
            ? ' Confirm with your passkey to continue.'
            : ' Set one up on this device, then sign in with it to continue.'}
        </p>

        {supported ? (
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void (registered ? onSignIn() : onRegister())}
              disabled={busy}
              className="font-mono uppercase"
              style={{
                background: 'linear-gradient(135deg, var(--amber), var(--amber-dim))',
                color: 'var(--text-on-amber, #0A0F1E)',
                border: '1px solid var(--amber-border, rgba(229,168,50,0.55))',
                padding: '12px 20px',
                borderRadius: 10,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: '0.10em',
                minHeight: 44,
                cursor: busy ? 'wait' : 'pointer',
                boxShadow: '0 4px 16px rgba(229,168,50,0.30)',
              }}
            >
              {primaryLabel}
            </button>
            {registered && (user?.passkey_count ?? 0) === 0 && (
              <button
                type="button"
                onClick={() => setRegistered(false)}
                disabled={busy}
                className="font-mono uppercase"
                style={{
                  background: 'transparent',
                  color: 'var(--text-tertiary)',
                  border: '1px solid var(--border-base)',
                  padding: '10px 20px',
                  borderRadius: 10,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.10em',
                  minHeight: 40,
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                Set up a different passkey
              </button>
            )}
          </div>
        ) : (
          <p
            style={{
              color: 'var(--sev-high, #fb923c)',
              fontSize: 12.5,
              lineHeight: 1.5,
              textAlign: 'center',
              margin: '16px 0 0',
            }}
          >
            This browser doesn't support passkeys. Sign in from a device with
            Touch ID, Face ID, Windows Hello, or a hardware security key — or
            contact a platform administrator for recovery.
          </p>
        )}

        <button
          type="button"
          onClick={() => void logout()}
          disabled={busy}
          className="font-mono uppercase"
          style={{
            display: 'block',
            margin: '16px auto 0',
            background: 'transparent',
            color: 'var(--text-tertiary)',
            border: 'none',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.10em',
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          Sign out
        </button>
      </div>
    </div>,
    document.body,
  );
}
