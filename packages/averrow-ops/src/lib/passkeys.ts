// /ops passkey lib — thin wrapper over @averrow/shared/passkeys.
//
// Per SHARED_LOGIN_SPEC the WebAuthn flows are canonical and live
// in the shared package. This file just instantiates the client
// with the ops HTTP adapter + return_to and re-exports the
// surface so existing call sites keep working.

import { createPasskeyClient } from '@averrow/shared/passkeys';
import type { PasskeyHttpClient } from '@averrow/shared/passkeys';
import { api } from './api';
import { OPS_SHELL_URL } from './basePath';

const httpClient: PasskeyHttpClient = {
  get:    (path) => api.get(path),
  post:   (path, body) => api.post(path, body),
  delete: (path) => api.delete(path),
};

const client = createPasskeyClient(httpClient, { defaultReturnTo: OPS_SHELL_URL });

// Re-export the existing surface so call sites don't change.
export const isPasskeySupported   = client.isSupported;
export const isAutofillSupported  = client.isAutofillSupported;
export const startConditionalUI   = client.startConditionalUI;
export const signInWithPasskey    = client.signInWithPasskey;
export const registerPasskey      = client.registerPasskey;
export const listPasskeys         = client.listPasskeys;
export const removePasskey        = client.removePasskey;

export type { PasskeyDevice, SignInOptions } from '@averrow/shared/passkeys';
