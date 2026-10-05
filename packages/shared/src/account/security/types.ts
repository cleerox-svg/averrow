// Adapter-style contracts for <SecuritySettings>. Structurally compatible with
// the existing `ProfileApiClient` / `PasskeyAdapter` (profile/types.ts) so ops
// and tenant can pass the objects they already build; declared here so the
// account kit has no dependency on the legacy profile folder.

import type { PasskeyDevice } from '../../passkeys/types';

export type { PasskeyDevice };

export interface SecurityApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SecurityApiClient {
  get<T>(path: string): Promise<SecurityApiResponse<T>>;
  post<T>(path: string, body?: unknown): Promise<SecurityApiResponse<T>>;
  delete<T>(path: string): Promise<SecurityApiResponse<T>>;
}

export interface SecurityPasskeyAdapter {
  isSupported: () => boolean;
  list: () => Promise<PasskeyDevice[]>;
  register: (deviceLabel?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export interface SecurityEndpoints {
  /** GET: the caller's own active sessions. */
  sessions: string;
  /** DELETE target for one session; `null` hides the per-session "Sign out". */
  session: ((id: string) => string) | null;
  /** POST: end every session except this device's; `null` hides "Sign out other devices". */
  revokeOthers: string | null;
  /** POST: end every session including this one. */
  logoutEverywhere: string;
}

export const DEFAULT_SECURITY_ENDPOINTS: SecurityEndpoints = {
  sessions: '/api/auth/sessions',
  session: (id) => `/api/auth/sessions/${encodeURIComponent(id)}`,
  revokeOthers: '/api/auth/sessions/revoke-others',
  logoutEverywhere: '/api/auth/logout-all',
};

export interface SecuritySettingsProps {
  api: SecurityApiClient;
  passkeys: SecurityPasskeyAdapter;
  /** Called after "Sign out everywhere" succeeds: clear auth state and leave. */
  onSignedOut: () => void | Promise<void>;
  /** After a passkey is added/removed (refresh the user's `passkey_count`). */
  onPasskeysChanged?: () => void;
  /** The user's role needs a passkey (ops admins): the last-passkey warning says so. */
  requiresPasskey?: boolean;
  /** Fallback for the "Signed in with …" chip when the session list can't say. */
  signInProvider?: string;
  endpoints?: Partial<SecurityEndpoints>;
  className?: string;
}

/** A normalised session row (the API may omit any optional field). */
export interface SecuritySession {
  id: string;
  userAgent: string | null;
  ipMasked: string | null;
  lastActiveAt: string | null;
  signedInAt: string | null;
  authMethod: string | null;
  isCurrent: boolean;
}
