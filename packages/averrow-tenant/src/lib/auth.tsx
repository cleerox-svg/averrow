// /tenant auth context — wraps @averrow/shared/auth's AuthProvider
// with product-specific deltas (tenant HTTP client adapter, no
// role-based redirects since this IS the customer surface).
//
// Per SHARED_LOGIN_SPEC the auth lifecycle is canonical and lives
// in the shared package. Edit the shared component, NOT this
// wrapper.

import type { ReactNode } from 'react';
import {
  AuthProvider as SharedAuthProvider,
  useAuth,
} from '@averrow/shared/auth';
import type { AuthHttpClient, AuthProviderConfig, AuthApiResponse } from '@averrow/shared/auth';
import { apiGet, apiPost, getToken, setToken } from './api';

// Adapter: tenant's apiGet/apiPost throw on non-2xx, so wrap each
// call to produce the AuthApiResponse envelope the shared
// component expects.
async function adapt<T>(p: Promise<{ success: true; data: T; total?: number }>): Promise<AuthApiResponse<T>> {
  try {
    const res = await p;
    return { success: res.success, data: res.data };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Request failed' };
  }
}

let authErrorCallback: (() => void) | null = null;

const httpClient: AuthHttpClient = {
  getToken:    () => getToken(),
  setTokens:   (a) => setToken(a),
  clearTokens: () => setToken(null),
  onAuthError: (cb) => { authErrorCallback = cb; },
  get:         <T,>(path: string) => adapt<T>(apiGet<T>(path)),
  post:        <T,>(path: string, body?: unknown) => adapt<T>(apiPost<T>(path, body ?? {})),
};

// Tenant has no client-redirect gate — this IS the customer
// surface. Cookie-based silent refresh (H5): the access token is
// memory-only, so every reload bootstraps via the HttpOnly
// radar_refresh cookie — which the backend sets on every
// session-issuing flow, tenant logins included.
const config: AuthProviderConfig = {
  userCacheKey:   'averrow-tenant-user',
  loginPath:      '/api/auth/login?return_to=/tenant/',
  returnToPrefix: '/tenant',
  refreshMode:    'cookie-refresh',
};

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SharedAuthProvider httpClient={httpClient} config={config}>
      {children}
    </SharedAuthProvider>
  );
}

// Re-export useAuth so consumers don't have to know about the
// shared package shape.
export { useAuth };

// authErrorCallback hook — currently unused outside this file but
// gives the apiGet wrapper a way to flip user state on 401 if
// we choose to wire that in a follow-up.
export function fireAuthError(): void {
  authErrorCallback?.();
}
