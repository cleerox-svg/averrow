// /v2/login — averrow-ops login route.
//
// Per SHARED_LOGIN_SPEC §1 the Login UI is canonical and shared
// across averrow-ops and (future) FarmTrack via @averrow/shared/login.
// Both products render the same LoginPage; per-product branding
// deltas (brand letters, tagline, footer pillars, return_to) flow
// in through the `branding` prop.
//
// Edit the shared component, NOT this wrapper.

import { LoginPage, makeLastSignInMethodAdapter } from '@averrow/shared/login';
import type { LoginApiClient, PasskeyLoginAdapter } from '@averrow/shared/login';
import { api } from '@/lib/api';
import {
  isPasskeySupported, signInWithPasskey, startConditionalUI,
} from '@/lib/passkeys';

const apiClient: LoginApiClient = {
  post: (path, body) => api.post(path, body),
};

const passkeyAdapter: PasskeyLoginAdapter = {
  isSupported:        isPasskeySupported,
  startConditionalUI: (returnTo) => startConditionalUI(returnTo),
  signIn:             (opts) => signInWithPasskey({ email: opts.email, returnTo: opts.returnTo }),
};

const lastSignInMethod = makeLastSignInMethodAdapter('averrow.lastSignInMethod');

export function Login() {
  return (
    <LoginPage
      branding={{
        brandLetters:  'AV',
        productName:   'Averrow',
        tagline:       'AI-First Threat Intelligence',
        footerPillars: 'Detect · Analyze · Correlate · Respond',
      }}
      apiClient={apiClient}
      passkeyAdapter={passkeyAdapter}
      lastSignInMethod={lastSignInMethod}
      returnTo="/v2/"
    />
  );
}
