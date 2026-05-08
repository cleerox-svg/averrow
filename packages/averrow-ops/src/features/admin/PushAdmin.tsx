// Super-admin Web Push bootstrap page.
//
// Walks the operator through the manual VAPID lifecycle:
//
//   1. Generate keypair    — server returns the private key ONCE,
//                            stores the public half in platform_config.
//   2. wrangler secret put — happens offline; UI surfaces clear instructions.
//   3. Flip enabled flag   — toggle in the status panel.
//   4. Send test push      — verifies end-to-end delivery to caller's
//                            already-subscribed devices.
//
// The private key reveal is one-time on purpose — the server never
// stores it, so the operator has to copy it into their secret manager
// + wrangler before navigating away. We confirm explicitly before
// closing the modal.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Card, Button, Badge, PageHeader, SectionLabel } from '@/design-system/components';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { relativeTime } from '@/lib/time';
import {
  usePushConfig,
  useGenerateVapidKeys,
  useUpdatePushConfig,
  useTestPush,
  type GenerateVapidResponse,
} from '@/hooks/usePushAdmin';

export function PushAdmin() {
  const { isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const { data: config, isLoading } = usePushConfig();

  // Gate: super_admin only. Bounce to the dashboard if a less-privileged
  // user somehow reaches the URL.
  if (!isSuperAdmin) {
    navigate('/admin', { replace: true });
    return null;
  }

  if (isLoading || !config) {
    return (
      <div className="space-y-6">
        <PageHeader title="Push Notifications" subtitle="Platform VAPID configuration" />
        <Card>
          <div className="font-mono text-xs text-white/40">Loading…</div>
        </Card>
      </div>
    );
  }

  const ready = config.push_enabled
    && config.vapid_public_key.length > 0
    && config.vapid_private_key_configured;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Push Notifications"
        subtitle="Platform-wide VAPID keypair + master switch. Only super_admins can change this."
      />

      <StatusPanel config={config} ready={ready} />

      <BootstrapPanel config={config} />

      <TogglePanel config={config} />

      {ready && <TestPanel />}
    </div>
  );
}

// ─── Status panel ─────────────────────────────────────────────────

function StatusPanel({
  config,
  ready,
}: {
  config: NonNullable<ReturnType<typeof usePushConfig>['data']>;
  ready: boolean;
}) {
  return (
    <Card>
      <SectionLabel className="mb-3">Current state</SectionLabel>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <Row label="Master switch">
          <Badge variant={config.push_enabled ? 'success' : 'critical'}>
            {config.push_enabled ? 'enabled' : 'disabled'}
          </Badge>
        </Row>
        <Row label="VAPID public key">
          <Badge variant={config.vapid_public_key ? 'success' : 'critical'}>
            {config.vapid_public_key ? 'configured' : 'missing'}
          </Badge>
        </Row>
        <Row label="VAPID private key (Worker secret)">
          <Badge variant={config.vapid_private_key_configured ? 'success' : 'critical'}>
            {config.vapid_private_key_configured ? 'configured' : 'missing'}
          </Badge>
        </Row>
        <Row label="Subject">
          <span className="font-mono text-xs" style={{ color: 'var(--text-primary)' }}>
            {config.vapid_subject || '—'}
          </span>
        </Row>
        <Row label="Last updated">
          <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
            {config.last_updated ? relativeTime(config.last_updated) : '—'}
          </span>
        </Row>
        <Row label="Delivery status">
          <Badge variant={ready ? 'success' : 'high'}>
            {ready ? 'ready to deliver' : 'not ready'}
          </Badge>
        </Row>
      </div>

      {config.vapid_public_key && (
        <div className="mt-4 pt-4 border-t border-white/[0.06]">
          <div className="font-mono text-[10px] uppercase tracking-wider text-white/40 mb-1">
            VAPID public key
          </div>
          <code className="block break-all font-mono text-[11px] p-2 rounded" style={{
            background: 'var(--bg-page)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border-base)',
          }}>
            {config.vapid_public_key}
          </code>
        </div>
      )}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 min-h-7">
      <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </span>
      <span className="text-right">{children}</span>
    </div>
  );
}

// ─── Bootstrap (generate keypair) ─────────────────────────────────

function BootstrapPanel({
  config,
}: {
  config: NonNullable<ReturnType<typeof usePushConfig>['data']>;
}) {
  const { showToast } = useToast();
  const generate = useGenerateVapidKeys();
  const [subject, setSubject] = useState(config.vapid_subject || 'mailto:ops@averrow.com');
  const [reveal, setReveal] = useState<GenerateVapidResponse | null>(null);
  const [confirm, setConfirm] = useState(false);

  function handleGenerate() {
    const ok = window.confirm(
      'Generating a new keypair will rotate the VAPID public key. Existing browser ' +
      'subscriptions will be invalidated and users will need to re-subscribe.\n\n' +
      'Continue?',
    );
    if (!ok) return;
    generate.mutate(subject || undefined, {
      onSuccess: (res) => {
        if (res) setReveal(res);
      },
      onError: (e) => showToast(`Generate failed: ${(e as Error).message}`, 'error'),
    });
  }

  return (
    <Card>
      <SectionLabel className="mb-2">Bootstrap / rotate keypair</SectionLabel>
      <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
        Generates a fresh ECDSA P-256 keypair on the server. The public half is
        persisted to <code className="font-mono">platform_config.vapid_public_key</code>;
        the private half is returned <strong>once</strong> and must be saved to a
        password manager + Worker secret immediately.
      </p>

      <div className="space-y-3">
        <div>
          <label className="font-mono text-[10px] uppercase tracking-wider block mb-1" style={{ color: 'var(--text-tertiary)' }}>
            Subject (mailto: or https://)
          </label>
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="mailto:ops@averrow.com"
          />
        </div>
        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={generate.isPending}
        >
          {generate.isPending ? 'Generating…' : config.vapid_public_key ? 'Rotate keypair' : 'Generate keypair'}
        </Button>
      </div>

      {reveal && (
        <PrivateKeyRevealSheet
          reveal={reveal}
          confirm={confirm}
          setConfirm={setConfirm}
          onClose={() => { setReveal(null); setConfirm(false); }}
        >
          <div className="space-y-4">
            <div className="p-3 rounded text-xs" style={{
              background: 'rgba(200,60,60,0.08)',
              border: '1px solid var(--sev-critical-border)',
              color: 'var(--sev-critical)',
            }}>
              <strong>One-time reveal.</strong> The server does NOT store the private
              key. If you close this dialog without saving it, you'll have to
              regenerate the keypair (which invalidates all existing subscriptions).
            </div>

            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>
                Private key
              </div>
              <code className="block break-all font-mono text-[11px] p-3 rounded" style={{
                background: 'var(--bg-page)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-base)',
              }}>
                {reveal.private_key}
              </code>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={() => {
                  navigator.clipboard.writeText(reveal.private_key)
                    .then(() => showToast('Private key copied to clipboard', 'success'))
                    .catch(() => showToast('Copy failed — select and copy manually', 'error'));
                }}
              >
                Copy private key
              </Button>
            </div>

            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
                Next steps
              </div>
              <ol className="text-xs space-y-1.5 pl-4 list-decimal" style={{ color: 'var(--text-secondary)' }}>
                <li>Save the private key to a password manager.</li>
                <li>
                  Run from <code className="font-mono">packages/trust-radar</code>:{' '}
                  <code className="font-mono px-1 rounded" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
                    wrangler secret put VAPID_PRIVATE_KEY
                  </code>
                </li>
                <li>Paste the key when prompted.</li>
                <li>Come back here and flip the master switch on (next panel).</li>
                <li>Send a test push to verify end-to-end delivery.</li>
              </ol>
            </div>

            <label className="flex items-start gap-2 cursor-pointer text-xs" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
                className="mt-0.5"
              />
              <span>I have saved the private key and run <code className="font-mono">wrangler secret put VAPID_PRIVATE_KEY</code>.</span>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="primary"
                disabled={!confirm}
                onClick={() => {
                  setReveal(null);
                  setConfirm(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        </PrivateKeyRevealSheet>
      )}
    </Card>
  );
}

// ─── Private key reveal sheet ─────────────────────────────────────
//
// Inline sheet (no Modal in the design system yet). Click outside or
// the close button confirms intent before discarding the key, since
// the server doesn't keep it — closing without saving = lost forever.

function PrivateKeyRevealSheet({
  reveal: _reveal,
  confirm,
  setConfirm: _setConfirm,
  onClose,
  children,
}: {
  reveal: GenerateVapidResponse;
  confirm: boolean;
  setConfirm: (v: boolean) => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  function attemptClose() {
    if (!confirm) {
      const ok = window.confirm(
        'You have not confirmed that the private key is saved. Closing this dialog ' +
        'will permanently lose access to the private key.\n\nClose anyway?',
      );
      if (!ok) return;
    }
    onClose();
  }

  // Portal to document.body — Card uses backdrop-filter + overflow:hidden,
  // which creates a stacking context that traps `position: fixed` to the
  // Card's bounds and clips the sheet. Mounting on body escapes that.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
      onClick={attemptClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-xl rounded-t-2xl sm:rounded-xl p-6 max-h-[90vh] overflow-y-auto"
        style={{
          background: 'var(--bg-card, #161E30)',
          border: '1px solid var(--border-base, rgba(255,255,255,0.08))',
          boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-vapid-reveal-title"
      >
        <div className="flex items-center justify-between mb-4">
          <div
            id="push-vapid-reveal-title"
            className="font-mono text-xs font-bold uppercase tracking-wider"
            style={{ color: 'var(--amber)' }}
          >
            VAPID private key — save now
          </div>
          <button
            onClick={attemptClose}
            className="text-2xl leading-none px-2"
            style={{ color: 'var(--text-tertiary)' }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ─── Master switch toggle ─────────────────────────────────────────

function TogglePanel({
  config,
}: {
  config: NonNullable<ReturnType<typeof usePushConfig>['data']>;
}) {
  const { showToast } = useToast();
  const update = useUpdatePushConfig();

  const canEnable = config.vapid_public_key.length > 0 && config.vapid_private_key_configured;

  function handleToggle() {
    const next = !config.push_enabled;
    if (next && !canEnable) {
      showToast('Cannot enable: VAPID public key or private key secret not configured', 'error');
      return;
    }
    update.mutate(
      { enabled: next },
      {
        onSuccess: () => showToast(`Push notifications ${next ? 'enabled' : 'disabled'}`, 'success'),
        onError: (e) => showToast(`Update failed: ${(e as Error).message}`, 'error'),
      },
    );
  }

  return (
    <Card>
      <SectionLabel className="mb-2">Master switch</SectionLabel>
      <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
        When disabled, the platform refuses to dispatch any push (including
        agent alerts and admin tests). Subscribe attempts in the UI return the
        "Push Notifications are currently disabled by the platform admin" error.
      </p>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Badge variant={config.push_enabled ? 'success' : 'critical'}>
            {config.push_enabled ? 'enabled' : 'disabled'}
          </Badge>
          {!canEnable && !config.push_enabled && (
            <span className="text-[11px]" style={{ color: 'var(--sev-high)' }}>
              Bootstrap keypair + secret first
            </span>
          )}
        </div>
        <Button
          variant={config.push_enabled ? 'secondary' : 'primary'}
          onClick={handleToggle}
          disabled={update.isPending || (!config.push_enabled && !canEnable)}
        >
          {update.isPending
            ? 'Updating…'
            : config.push_enabled
              ? 'Disable push'
              : 'Enable push'}
        </Button>
      </div>
    </Card>
  );
}

// ─── Test push ────────────────────────────────────────────────────

function TestPanel() {
  const { showToast } = useToast();
  const test = useTestPush();

  function handleTest() {
    test.mutate(undefined, {
      onSuccess: (res) => {
        if (!res) {
          showToast('Test sent — no response body', 'info');
          return;
        }
        const attempted = res.sent + res.failed + res.expired;
        if (attempted === 0) {
          showToast('No subscribed devices found for your account — subscribe in the UI first.', 'info');
        } else {
          showToast(
            `Test push: ${res.sent}/${attempted} devices delivered`,
            res.sent === attempted ? 'success' : 'error',
          );
        }
      },
      onError: (e) => showToast(`Test failed: ${(e as Error).message}`, 'error'),
    });
  }

  // Only show the result line after a real send (test.data is set on success).
  const result = test.data;
  const attempted = result ? result.sent + result.failed + result.expired : 0;

  return (
    <Card>
      <SectionLabel className="mb-2">Send test push</SectionLabel>
      <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
        Sends a notification to <strong>your</strong> subscribed devices, bypassing
        per-event prefs and quiet hours. Use this after rotating keys or flipping
        the master switch to confirm the encryption + JWT signing path still
        works end-to-end.
      </p>
      <Button variant="secondary" onClick={handleTest} disabled={test.isPending}>
        {test.isPending ? 'Sending…' : 'Send test push'}
      </Button>

      {/* Aggregate counters — dispatchPush() returns aggregate only, no
          per-device breakdown. If a single device fails, "failed" goes
          up; we surface it but don't try to invent which device. */}
      {result && attempted > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
            Attempted: <strong style={{ color: 'var(--text-primary)' }}>{attempted}</strong>
          </span>
          <Badge variant="success">Delivered {result.sent}</Badge>
          {result.failed > 0 && <Badge variant="critical">Failed {result.failed}</Badge>}
          {result.expired > 0 && <Badge variant="medium">Expired {result.expired}</Badge>}
        </div>
      )}
    </Card>
  );
}
