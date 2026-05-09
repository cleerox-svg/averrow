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
  /** Two-character brand-tile abbreviation. e.g. "AV", "FT". */
  brandLetters:   string;
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
}
