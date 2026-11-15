// @averrow/shared/passkeys — unified WebAuthn client for Averrow
// products. Each app instantiates createPasskeyClient(http, opts)
// once and exports the resulting object so existing call sites
// (registerPasskey(), listPasskeys(), etc.) keep working.
//
// Usage:
//   const passkeys = createPasskeyClient(httpAdapter, {
//     defaultReturnTo: '/ops/',
//   });
//   passkeys.registerPasskey('MacBook Pro 14');

export { createPasskeyClient } from './passkeys';
export type {
  PasskeyClient, PasskeyClientOptions, PasskeyDevice, PasskeyHttpClient,
  PasskeyApiResponse, SignInOptions,
} from './types';
