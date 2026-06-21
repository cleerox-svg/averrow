// /v2/login — averrow-ops login route.
//
// Per SHARED_LOGIN_SPEC §1 the Login UI is canonical and shared
// across averrow-ops and (future) FarmTrack via @averrow/shared/login.
// Both products render the same LoginPage; per-product branding
// deltas (brand letters, tagline, footer pillars, return_to) flow
// in through the `branding` prop.
//
// Edit the shared component, NOT this wrapper.

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoginPage, makeLastSignInMethodAdapter } from '@averrow/shared/login';
import type { LoginApiClient, PasskeyLoginAdapter } from '@averrow/shared/login';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  isPasskeySupported, signInWithPasskey, startConditionalUI,
} from '@/lib/passkeys';

const apiClient: LoginApiClient = {
  post: (path, body) => api.post(path, body),
};

const lastSignInMethod = makeLastSignInMethodAdapter('averrow.lastSignInMethod');

export function Login() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  // Host-side passkey hydration (login audit F3). The passkey XHR flow
  // returns the access token in JS, so on success we set it in memory (H5),
  // refresh the auth context, then SPA-navigate — no hard reload, no URL
  // hash, no risk of a hanging spinner from a no-op hard-nav.
  const passkeyAdapter: PasskeyLoginAdapter = useMemo(() => {
    const onSuccess = async (accessToken: string, _expiresIn: number, returnTo: string) => {
      api.setTokens(accessToken, '');
      await refreshUser();
      // returnTo is the full path ('/v2/'); strip the router basename so
      // navigate() doesn't double it ('/v2/v2/').
      const target = returnTo.replace(/^\/v2(?=\/|$)/, '') || '/';
      navigate(target, { replace: true });
    };
    return {
      isSupported:        isPasskeySupported,
      startConditionalUI: (returnTo) => startConditionalUI(returnTo, onSuccess),
      signIn:             (opts) => signInWithPasskey({ email: opts.email, returnTo: opts.returnTo, onSuccess }),
    };
  }, [navigate, refreshUser]);

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
