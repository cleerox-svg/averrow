import type { ReactNode } from 'react';

// Unified Login types. Both averrow-ops and (future) FarmTrack
// render the same LoginPage from @averrow/shared/login. Per-product
// deltas flow through props (brand letters, tagline, return_to,
// footer pillars). The structural FarmTrack ↔ Averrow parity rule
// in docs/SHARED_LOGIN_SPEC.md §1 is now enforced at the
// component level: only the deltas in LoginBranding can vary.

// ─── HTTP client adapter ─────────────────────────────────────
//
// LoginPage needs to POST to /api/auth/magic-link/request and
// nothing else. The host app passes its own client; LoginPage is
// HTTP-agnostic.

export interface LoginApiResponse<T> {
  success: boolean;
  data?:   T;
  error?:  string;
}

export interface LoginApiClient {
  post<T>(path: string, body: unknown): Promise<LoginApiResponse<T>>;
}

// ─── Passkey adapter ─────────────────────────────────────────
//
// Wraps each app's lib/passkeys.ts (which wraps
// @simplewebauthn/browser). Hoisting the passkey lib itself into
// shared is a separate refactor; for now LoginPage just calls
// these callbacks.

export interface PasskeyLoginAdapter {
  isSupported:        () => boolean;
  /** Run conditional UI ceremony in the email autofill. Silent. */
  startConditionalUI: (returnTo?: string) => Promise<void>;
  /** Returns true on success (host app navigates the page),
   *  false if the user dismissed the OS prompt. Throws on actual
   *  failures. */
  signIn:             (opts: { email?: string; returnTo?: string }) => Promise<boolean>;
}

// ─── Last-sign-in-method hint adapter ────────────────────────
//
// Stored per-device. Drives the adaptive primary CTA. Each app
// may want a different localStorage key (already 'averrow-…'
// for Averrow) — hoist the namespace into the host so the spec
// stays product-clean.

export type SignInMethod = 'passkey' | 'google' | 'magic-link';

export interface LastSignInMethodAdapter {
  read:  () => SignInMethod | null;
  write: (method: SignInMethod) => void;
}

// ─── Per-product branding ────────────────────────────────────
//
// The four per-product deltas allowed by SHARED_LOGIN_SPEC §1.
// Anything else changes the structural identity of the Login page
// across products and must be added to the spec first.

export interface LoginBranding {
  /** Two-character brand-tile abbreviation. e.g. "AV", "FT".
   *  Used as the brand-tile glyph ONLY when `brandMark` is not supplied. */
  brandLetters:   string;
  /** Optional product logo mark rendered in the brand tile instead of the
   *  `brandLetters` monogram. Each product passes its OWN mark (Averrow's
   *  red-triangle logo, FarmTrack's mark, …) so the shared component stays
   *  parity-identical — the monogram remains the fallback. Should be a
   *  self-contained ~56×56 tile. See SHARED_LOGIN_SPEC.md §1. */
  brandMark?:     ReactNode;
  /** Display name shown below the tile. e.g. "Averrow". */
  productName:    string;
  /** Tagline below product name. Mono uppercase, amber.
   *  e.g. "AI-FIRST THREAT INTELLIGENCE". */
  tagline:        string;
  /** Footer pillar string. e.g. "Detect · Analyze · Correlate · Respond". */
  footerPillars:  string;
}

// ─── LoginPage props ─────────────────────────────────────────

export interface LoginPageProps {
  branding:               LoginBranding;
  apiClient:              LoginApiClient;
  passkeyAdapter:         PasskeyLoginAdapter;
  lastSignInMethod:       LastSignInMethodAdapter;
  /** Where the OAuth + magic-link callback should land after
   *  success. Per-product: `/v2/` for Averrow, `/` for FarmTrack. */
  returnTo:               string;
  /** Path to the host app's OAuth login starter. Default
   *  `/api/auth/login?return_to=<returnTo>`. */
  oauthLoginPath?:        string;
  /** Magic-link request path. Default `/api/auth/magic-link/request`. */
  magicLinkRequestPath?:  string;
  /** Optional callback errors map keyed by `?error=foo` query.
   *  e.g. { invalid_link: "That link is malformed." }. Defaults
   *  shown in components if not provided. */
  errorCopy?:             Record<string, string>;
  /** Replaces the Google button's default `window.location.href =
   *  oauthLoginPath` navigation (e.g. a native Capacitor shell that can't
   *  use web OAuth redirects). While the promise is pending the button is
   *  disabled, `aria-busy`, and reads "Signing in…". If it rejects, the
   *  message shows in the page error area (see `googleErrorCopy`).
   *  Omitted → unchanged redirect behaviour. */
  onGoogleSignIn?:        () => Promise<void>;
  /** Maps an error thrown by `onGoogleSignIn` to display text. Default: the
   *  thrown `Error.message`, or "Google sign-in failed. Try again." when
   *  there is none. Always rendered as plain text, never HTML. */
  googleErrorCopy?:       (error: unknown) => string;
  /** Slot rendered inside the card, under the footer pillars (e.g.
   *  Privacy / Delete account links required by app stores). */
  footerLinks?:           ReactNode;
  /** Replaces the whole body of the magic-link "sent" confirmation (the
   *  "Check your inbox… sent a sign-in link to X…" text; the "Use a
   *  different email" control stays). Use for invite-only products that
   *  must not confirm an address exists. */
  magicLinkSentCopy?:     (email: string) => ReactNode;
}
