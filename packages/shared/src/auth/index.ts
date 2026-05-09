// @averrow/shared/auth — unified auth context for Averrow products.
//
// Each app wraps its tree in <AuthProvider httpClient={...}
// config={...}> and reads via useAuth(). Per-product behaviors
// (role-based redirect, lastSignInMethod cleanup) flow through
// AuthProviderConfig hooks.

export { AuthProvider, useAuth } from './AuthProvider';
export type {
  SharedAuthUser, SharedAuthState, SharedAuthUserOrganization,
  AuthHttpClient, AuthApiResponse, AuthProviderConfig,
  ValidatedUserDecision,
} from './types';
