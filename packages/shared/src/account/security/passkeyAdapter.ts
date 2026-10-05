// Strict passkey adapter for the Security page.
//
// `createPasskeyClient().listPasskeys()` resolves `[]` when the request comes
// back `{ success: false }`, and `removePasskey()` ignores a failed delete —
// both would make a failure look like "No passkeys yet" / a silent success.
// This adapter keeps the host's WebAuthn `register` + `isSupported` but does
// list/remove itself and THROWS on any failure.

import type { PasskeyDevice, SecurityApiClient, SecurityPasskeyAdapter } from './types';

export interface StrictPasskeyAdapterOptions {
  api: SecurityApiClient;
  isSupported: () => boolean;
  register: (deviceLabel?: string) => Promise<void>;
  listPath?: string;
  /** `:id` is substituted. */
  removePath?: string;
}

export function createStrictPasskeyAdapter(o: StrictPasskeyAdapterOptions): SecurityPasskeyAdapter {
  const listPath = o.listPath ?? '/api/passkeys';
  const removePath = o.removePath ?? '/api/passkeys/:id';
  return {
    isSupported: o.isSupported,
    register: o.register,
    async list() {
      const res = await o.api.get<PasskeyDevice[]>(listPath);
      if (!res.success || !Array.isArray(res.data)) throw new Error(res.error || 'Could not load passkeys');
      return res.data;
    },
    async remove(id) {
      const res = await o.api.delete(removePath.replace(':id', encodeURIComponent(id)));
      if (!res.success) throw new Error(res.error || "Couldn't remove the passkey. Try again.");
    },
  };
}
