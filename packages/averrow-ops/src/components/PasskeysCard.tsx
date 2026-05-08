// Profile-page Passkeys section. List + per-device revoke + add-on-this-device.
//
// `BIOMETRIC` badge appears when transports includes "internal" — the
// credential is bound to a platform authenticator (Touch ID / Face ID
// / Windows Hello / Android fingerprint). Hardware security keys
// (USB / NFC) don't get the badge since they're not biometric in the
// per-device sense.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Button, Badge, SectionLabel } from '@/design-system/components';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { relativeTime } from '@/lib/time';
import {
  isPasskeySupported, registerPasskey, listPasskeys, removePasskey,
  type PasskeyDevice,
} from '@/lib/passkeys';

export function PasskeysCard() {
  const supported = isPasskeySupported();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [adding, setAdding] = useState(false);
  const [showLabel, setShowLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');

  const { data: passkeys } = useQuery({
    queryKey: ['passkeys'],
    queryFn: listPasskeys,
    enabled: supported,
  });

  const handleAdd = async () => {
    setAdding(true);
    try {
      await registerPasskey(labelDraft.trim() || undefined);
      showToast('Passkey added.', 'success');
      setLabelDraft('');
      setShowLabel(false);
      queryClient.invalidateQueries({ queryKey: ['passkeys'] });
    } catch (err) {
      // User cancelled OS prompt — silent.
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        return;
      }
      // InvalidStateError = a credential matching this account is
      // already in the platform/sync authenticator. Most often
      // means a passkey synced via Google Password Manager or
      // iCloud Keychain from another device — nothing to fix.
      if (err instanceof DOMException && err.name === 'InvalidStateError') {
        showToast("A passkey for this account already exists on this device (likely synced from another device).", 'info');
        return;
      }
      showToast(err instanceof Error ? err.message : "Couldn't add passkey", 'error');
    } finally {
      setAdding(false);
    }
  };

  const handleRevoke = async (pk: PasskeyDevice) => {
    if (!window.confirm(
      `Revoke passkey "${pk.device_label ?? 'Device'}"? You'll need to add a new one to sign in with this device again.`,
    )) return;
    try {
      await removePasskey(pk.id);
      showToast('Passkey revoked.', 'success');
      queryClient.invalidateQueries({ queryKey: ['passkeys'] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Revoke failed', 'error');
    }
  };

  return (
    <Card className="mb-4">
      <SectionLabel className="mb-2">Passkeys</SectionLabel>
      <p className="font-mono text-[11px] leading-relaxed mb-3" style={{ color: 'var(--text-secondary)' }}>
        One-tap sign-in via Touch ID, Face ID, Windows Hello, or a
        hardware security key. No password ever required.
      </p>
      <p className="font-mono text-[10px] leading-relaxed mb-3" style={{ color: 'var(--text-tertiary)' }}>
        Passkeys may be synced across your devices via Google Password
        Manager or iCloud Keychain. If a passkey is synced, you don't
        need to add a new one on each device — the same one works
        everywhere you're signed into the sync provider.
      </p>

      {!supported ? (
        <p className="font-mono text-[11px]" style={{ color: 'var(--amber)' }}>
          This browser doesn't support passkeys. Try Chrome, Safari, or Edge on a modern device.
        </p>
      ) : (
        <>
          {passkeys === undefined ? (
            <p className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
          ) : passkeys.length === 0 ? (
            <p className="mb-3 font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              No passkeys yet.
            </p>
          ) : (
            <ul className="mb-3 flex flex-col gap-2">
              {passkeys.map((pk) => (
                <li
                  key={pk.id}
                  className="flex items-center justify-between gap-2 rounded-md p-2"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-base)',
                  }}
                >
                  <div className="min-w-0">
                    <div className="font-semibold truncate" style={{ color: 'var(--text-primary)', fontSize: 13 }}>
                      {pk.device_label ?? 'Device'}
                    </div>
                    <div className="font-mono text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                      Added {relativeTime(pk.created_at)}
                      {pk.last_used_at
                        ? ` · last used ${relativeTime(pk.last_used_at)}`
                        : ' · never used'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {pk.transports.includes('internal') && (
                      <Badge variant="success" className="text-[9px] py-0 px-1.5">
                        Biometric
                      </Badge>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void handleRevoke(pk)}>
                      Revoke
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {showLabel ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                placeholder="My iPhone (optional)"
                disabled={adding}
                className="flex-1"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleAdd()}
                disabled={adding}
              >
                {adding ? 'Adding…' : 'Add passkey'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setShowLabel(false); setLabelDraft(''); }}
                disabled={adding}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowLabel(true)}
              disabled={adding}
            >
              {(passkeys?.length ?? 0) === 0 ? 'Add a passkey on this device' : 'Add another passkey'}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
