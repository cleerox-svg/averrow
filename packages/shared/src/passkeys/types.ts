// Unified passkey (WebAuthn) helpers. Both averrow-ops and
// averrow-tenant render the same per-device list, registration
// flow, and sign-in flow against the same backend
// (packages/trust-radar/src/handlers/passkeys.ts). This module
// owns the @simplewebauthn/browser integration; products pass
// their HTTP client + a default returnTo via the factory.

export interface PasskeyDevice {
  id:           string;
  device_label: string | null;
  user_agent:   string | null;
  backed_up:    number;
  /** Authenticator transport hints. ["internal"] = Touch ID /
   *  Face ID / Windows Hello / Android fingerprint → drives the
   *  BIOMETRIC badge on the Profile page. */
  transports:   string[];
  created_at:   string;
  last_used_at: string | null;
}

export interface SignInOptions {
  email?:       string;
  /** When set, runs the WebAuthn ceremony in 'conditional'
   *  mediation mode so the OS credential picker appears in the
   *  email field's autofill dropdown rather than as a modal. */
  conditional?: boolean;
  returnTo?:    string;
  /** Host-side hydration (preferred — login audit F3). When provided,
   *  signIn does NOT hard-navigate (`window.location.assign`); it invokes
   *  this with the issued access token so the host can set it in memory
   *  (H5), refresh the auth context, and SPA-navigate. This avoids the
   *  fragile hard-nav that could leave the login spinner hanging. When
   *  omitted, the legacy hash hard-nav is used (back-compat). */
  onSuccess?:   (accessToken: string, expiresIn: number, returnTo: string) => void | Promise<void>;
}

// ─── HTTP client adapter ─────────────────────────────────────

export interface PasskeyApiResponse<T> {
  success: boolean;
  data?:   T;
  error?:  string;
}

export interface PasskeyHttpClient {
  get<T>(path: string):                    Promise<PasskeyApiResponse<T>>;
  post<T>(path: string, body?: unknown):   Promise<PasskeyApiResponse<T>>;
  delete<T>(path: string):                 Promise<PasskeyApiResponse<T>>;
}

// ─── Factory options ─────────────────────────────────────────

export interface PasskeyClientOptions {
  /** Default returnTo for sign-in. e.g. '/v2/' or '/tenant/'. */
  defaultReturnTo: string;
  /** Override paths if a product carries a different backend. */
  paths?: Partial<{
    registerBegin:  string;
    registerFinish: string;
    authBegin:      string;
    authFinish:     string;
    list:           string;
    /** Pattern for removing a single credential, with `:id`
     *  substituted at call time. Default: `/api/passkeys/:id`. */
    remove:         string;
  }>;
}

// ─── Client surface (returned by createPasskeyClient) ────────

export interface PasskeyClient {
  isSupported():                                           boolean;
  isAutofillSupported():                                   Promise<boolean>;
  startConditionalUI(returnTo?: string, onSuccess?: SignInOptions['onSuccess']): Promise<void>;
  signInWithPasskey(opts?: SignInOptions):                 Promise<boolean>;
  registerPasskey(deviceLabel?: string):                   Promise<void>;
  listPasskeys():                                          Promise<PasskeyDevice[]>;
  removePasskey(id: string):                               Promise<void>;
}
