// Unified auth context. Both averrow-ops and averrow-tenant render
// the same AuthProvider; product-specific lifecycle deltas
// (role==='client' redirect, organization-only routing) flow
// through the AuthProviderConfig.

export interface SharedAuthUserOrganization {
  id:    number;
  name:  string;
  slug:  string;
  plan:  string;
  /** The user's role *inside* this org (owner/admin/analyst/viewer/etc). */
  role:  string;
}

export interface SharedAuthUser {
  id:    string;
  email: string;
  /** Backend-computed: display_name ?? name. */
  name:  string;
  /** Global role: super_admin | admin | analyst | client. */
  role:  string;
  display_name?:    string | null;
  timezone?:        string | null;
  theme_preference?: 'dark' | 'light' | null;
  passkey_count?:   number;
  avatar_url?:      string;
  organization?:    SharedAuthUserOrganization | null;
}

// ─── HTTP client adapter ─────────────────────────────────────
//
// Each product has its own HTTP client shape (ops uses an api
// class with refresh/interceptors; tenant uses top-level
// functions). The adapter lets AuthProvider talk to both
// without caring which.

export interface AuthApiResponse<T> {
  success: boolean;
  data?:   T;
  error?:  string;
}

export interface AuthHttpClient {
  /** Read the current bearer token (used to gate cache hydration). */
  getToken():       string | null;
  /** Store a new access token — IN MEMORY ONLY (H5,
   *  SECURITY_AUDIT_2026-06-10). Implementations must never write
   *  tokens to localStorage/sessionStorage. The `refresh` parameter
   *  is legacy-shaped and always passed as '' — the refresh token
   *  lives exclusively in the HttpOnly `radar_refresh` cookie. */
  setTokens(access: string, refresh: string): void;
  /** Clear all tokens locally. Called on logout + 401s. */
  clearTokens():    void;
  /** Register a callback to fire when the underlying client
   *  detects a 401. AuthProvider uses it to clear in-memory user
   *  state when the API client tears down credentials. */
  onAuthError(cb: () => void): void;
  /** GET — returns the standard envelope. */
  get<T>(path: string): Promise<AuthApiResponse<T>>;
  /** POST — body optional so logout/`{}` works without a body
   *  type assertion. */
  post<T>(path: string, body?: unknown): Promise<AuthApiResponse<T>>;
}

// ─── Per-product lifecycle hooks ─────────────────────────────

/** What to do after `/api/auth/me` returns a valid user. Most
 *  products `continue`. averrow-ops returns `redirect` when the
 *  user is a customer (role==='client') so they bounce to /tenant/. */
export type ValidatedUserDecision =
  | { kind: 'continue' }
  | { kind: 'redirect'; to: string };

export interface AuthProviderConfig {
  /** localStorage key for the cached user record. Per-product so
   *  ops + tenant don't fight over the same slot when both apps
   *  share a domain. e.g. 'averrow-user' / 'averrow-tenant-user'. */
  userCacheKey:     string;
  /** Path to start the OAuth login redirect. REQUIRED — no
   *  default. Each product MUST set its own return_to so a future
   *  product (FarmTrack, etc.) doesn't silently inherit /v2/. */
  loginPath:        string;
  /** Path to POST to revoke the session on logout.
   *  Default `/api/auth/logout`. */
  logoutPath?:      string;
  /** Path to POST to silently refresh the access token via
   *  HTTP-only cookie. Default `/api/auth/refresh`. */
  refreshPath?:     string;
  /** Path to GET the current user's session.
   *  Default `/api/auth/me`. */
  mePath?:          string;
  /** Where to navigate after logout. Default `/`. */
  logoutRedirectTo?: string;
  /** When AuthProvider reads tokens from the URL hash, the host
   *  may include a return_to. We only restore it if it begins
   *  with this prefix (defends against malicious return_to). */
  returnToPrefix?:  string;
  /** Per-product hook called after /api/auth/me succeeds.
   *  - 'continue' lets the user into this app (default).
   *  - 'redirect' hard-navigates to `to` (e.g. role='client'
   *    bouncing from /v2 to /tenant). */
  onValidatedUser?: (user: SharedAuthUser) => ValidatedUserDecision;
  /** Called during logout so the host can clear product-specific
   *  side state (e.g. lastSignInMethod, theme overrides). */
  onLogoutCleanup?: () => void;
  /** Silent-refresh mode. 'cookie-refresh' (default, and what both
   *  averrow-ops and averrow-tenant use since H5) attempts the
   *  HttpOnly-cookie refresh on boot when no access token is in
   *  memory. 'token-only' skips it — only for hosts that genuinely
   *  never receive the radar_refresh cookie. */
  refreshMode?:     'cookie-refresh' | 'token-only';
}

// ─── AuthState (the value useAuth() returns) ─────────────────

export interface SharedAuthState {
  user:             SharedAuthUser | null;
  loading:          boolean;
  isAuthenticated:  boolean;
  /** Convenience derived selectors. Hosts can compute their own
   *  product-specific selectors (isBrandAdmin, hasModuleX, …)
   *  from `user` if these aren't enough. */
  isSuperAdmin:     boolean;
  /** True when user has an organization membership. */
  hasOrg:           boolean;
  login:            () => void;
  logout:           () => Promise<void>;
  /** Re-fetch /api/auth/me and refresh local state. */
  refreshUser:      () => Promise<void>;
}
