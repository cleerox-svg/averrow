// /v2 auth context — wraps @averrow/shared/auth's AuthProvider with
// product-specific deltas (HTTP client adapter, role==='client'
// redirect to /tenant/, lastSignInMethod cleanup on logout, the
// `isBrandAdmin` derived selector).
//
// Per SHARED_LOGIN_SPEC the auth lifecycle is canonical and lives
// in the shared package. Edit the shared component, NOT this
// wrapper.

import type { ReactNode } from 'react';
import {
  AuthProvider as SharedAuthProvider,
  useAuth as useSharedAuth,
} from '@averrow/shared/auth';
import type {
  AuthHttpClient, AuthProviderConfig, SharedAuthState, ValidatedUserDecision,
} from '@averrow/shared/auth';
import { clearLastSignInMethod as clearLastSignInMethodInStorage } from '@averrow/shared/login';
import { api } from './api';

const LAST_SIGNIN_METHOD_KEY = 'averrow.lastSignInMethod';

const httpClient: AuthHttpClient = {
  getToken:    () => api.getToken(),
  setTokens:   (a, r) => api.setTokens(a, r),
  clearTokens: () => api.clearTokens(),
  onAuthError: (cb) => api.onAuthError(cb),
  get:         <T,>(path: string) => api.get<T>(path),
  post:        <T,>(path: string, body?: unknown) => api.post<T>(path, body),
};

// Phase D D2c rebadge gate — averrow-ops is staff-only. A
// role='client' user (any customer) belongs at /tenant/, not
// here. Hard-redirects so we don't even briefly render the staff
// shell with their identity. Worker-side login redirect is the
// matching backstop in packages/averrow-worker/src/handlers/auth.ts.
const config: AuthProviderConfig = {
  userCacheKey:     'averrow-user',
  loginPath:        '/api/auth/login?return_to=/v2/',
  returnToPrefix:   '/v2',
  refreshMode:      'cookie-refresh',
  onValidatedUser:  (user): ValidatedUserDecision => {
    if (user.role === 'client') return { kind: 'redirect', to: '/tenant/' };
    return { kind: 'continue' };
  },
  onLogoutCleanup:  () => clearLastSignInMethodInStorage(LAST_SIGNIN_METHOD_KEY),
};

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SharedAuthProvider httpClient={httpClient} config={config}>
      {children}
    </SharedAuthProvider>
  );
}

// /v2 derived selector — kept for callers that branch on brand-admin
// (i.e. an org admin who is NOT super_admin). Computed from the
// shared state.
export function useAuth(): SharedAuthState & { isBrandAdmin: boolean } {
  const state = useSharedAuth();
  const isBrandAdmin = !!state.user
    && state.user.role !== 'super_admin'
    && !!state.user.organization;
  return { ...state, isBrandAdmin };
}
