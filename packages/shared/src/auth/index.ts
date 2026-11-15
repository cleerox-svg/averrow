// @averrow/shared/auth — unified auth context for Averrow products.
//
// Each app wraps its tree in <AuthProvider httpClient={...}
// config={...}> and reads via useAuth(). Per-product behaviors
// (role-based redirect, lastSignInMethod cleanup) flow through
// AuthProviderConfig hooks.

export { AuthProvider, useAuth, isSafeReturnTo, isValidCachedUser } from './AuthProvider';
export { APP_HINT_KEY, HOME_NO_REDIRECT_URL, setAppHint, clearAppHint, readAppHint } from './appHint';
export type { AppHint } from './appHint';
export type {
  SharedAuthUser, SharedAuthState, SharedAuthUserOrganization,
  AuthHttpClient, AuthApiResponse, AuthProviderConfig,
  ValidatedUserDecision,
} from './types';
