// ProfilePage sections — each one is self-contained, opt-in via
// the `features` prop on ProfilePage. Order is enforced inside
// ProfilePage.tsx per SHARED_LOGIN_SPEC §2.
//
// All sections read/write through the ProfileApiClient passed at
// the page boundary so they're HTTP-agnostic. WebAuthn calls go
// through PasskeyAdapter.

import { useEffect, useState } from 'react';
import {
  ProfileCard, ProfileSectionLabel, ProfileFieldLabel, ProfileFieldHelper,
  ProfileInput, ProfileButton, ProfilePill, parseInitials,
} from './primitives';
import type {
  ProfileUser, ProfileApiClient, PasskeyAdapter,
  PasskeyDevice, SessionSummary,
} from './types';

// ─── 1. Identity ─────────────────────────────────────────────

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin:       'Admin',
  analyst:     'Analyst',
  client:      'Client',
};

export function IdentitySection({ user }: { user: ProfileUser }) {
  const initials = parseInitials(user.display_name ?? user.name, user.email);
  const role = ROLE_LABEL[user.role] ?? user.role;

  return (
    <ProfileCard>
      <ProfileSectionLabel>Identity</ProfileSectionLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <div
          aria-label={`Avatar: ${initials}`}
          style={{
            width: 64, height: 64, borderRadius: '50%',
            background:    'var(--amber, #E5A832)',
            color:         'var(--text-on-amber, #0A0F1E)',
            display:       'flex',
            alignItems:    'center',
            justifyContent: 'center',
            fontSize:      22,
            fontWeight:    800,
            border:        '1px solid var(--border-strong)',
            flexShrink:    0,
          }}
        >
          {initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 style={{
            fontSize:   18,
            fontWeight: 700,
            color:      'var(--text-primary)',
            margin:     0,
            overflow:   'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {user.display_name ?? user.name ?? 'User'}
          </h2>
          <p style={{
            fontSize: 12,
            color:    'var(--text-secondary)',
            margin:   '2px 0 0',
            fontFamily: 'var(--font-mono)',
          }}>{user.email}</p>
          <div style={{ marginTop: 8 }}>
            <ProfilePill tone="amber">{role}</ProfilePill>
            {user.organization && (
              <span style={{ marginLeft: 8 }}>
                <ProfilePill tone="neutral">
                  {user.organization.name} · {user.organization.plan}
                </ProfilePill>
              </span>
            )}
          </div>
        </div>
      </div>
    </ProfileCard>
  );
}

// ─── 2. Account ──────────────────────────────────────────────

interface AccountProps {
  user:          ProfileUser;
  apiClient:     ProfileApiClient;
  onUserUpdated: () => void;
  onToast:       (msg: string, kind: 'success' | 'error') => void;
}

export function AccountSection({ user, apiClient, onUserUpdated, onToast }: AccountProps) {
  const [displayName, setDisplayName] = useState(user.display_name ?? user.name ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user.display_name != null) setDisplayName(user.display_name);
  }, [user.display_name]);

  const save = async () => {
    setSaving(true);
    try {
      const trimmed = displayName.trim();
      const res = await apiClient.patch('/api/profile', {
        display_name: trimmed.length === 0 ? null : trimmed,
      });
      if (res.success) {
        onToast('Display name saved.', 'success');
        onUserUpdated();
      } else {
        onToast(res.error ?? 'Save failed.', 'error');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProfileCard>
      <ProfileSectionLabel>Account</ProfileSectionLabel>
      <div style={{ display: 'grid', gap: 16 }}>
        <div>
          <ProfileFieldLabel htmlFor="profile-display-name">Display name</ProfileFieldLabel>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <ProfileInput
                id="profile-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={user.name ?? 'Your name'}
                disabled={saving}
                maxLength={120}
              />
            </div>
            <ProfileButton onClick={() => void save()} disabled={saving} variant="secondary">
              {saving ? 'Saving…' : 'Save'}
            </ProfileButton>
          </div>
          <ProfileFieldHelper>
            Shown across the app instead of your Google name. Leave blank to use Google.
          </ProfileFieldHelper>
        </div>

        <div>
          <ProfileFieldLabel htmlFor="profile-email">Email</ProfileFieldLabel>
          <ProfileInput
            id="profile-email"
            value={user.email}
            onChange={() => { /* noop */ }}
            readOnly
          />
          <ProfileFieldHelper>
            Managed by your sign-in provider. Email changes go through the OAuth account.
          </ProfileFieldHelper>
        </div>
      </div>
    </ProfileCard>
  );
}

// ─── 3. Preferences (theme + timezone) ──────────────────────

const TIMEZONE_OPTIONS = [
  { value: 'America/Toronto',     label: 'America/Toronto (EST/EDT)' },
  { value: 'America/New_York',    label: 'America/New_York' },
  { value: 'America/Chicago',     label: 'America/Chicago' },
  { value: 'America/Denver',      label: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'America/Halifax',     label: 'America/Halifax' },
  { value: 'America/Vancouver',   label: 'America/Vancouver' },
  { value: 'Europe/London',       label: 'Europe/London' },
  { value: 'Europe/Paris',        label: 'Europe/Paris' },
  { value: 'UTC',                 label: 'UTC' },
];

function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'UTC'; }
}

interface PreferencesProps {
  user:          ProfileUser;
  apiClient:     ProfileApiClient;
  onUserUpdated: () => void;
  onToast:       (msg: string, kind: 'success' | 'error') => void;
}

export function PreferencesSection({ user, apiClient, onUserUpdated, onToast }: PreferencesProps) {
  // Auto / Dark / Light tri-state. 'auto' follows OS via
  // prefers-color-scheme (handled by @averrow/shared/theme's
  // bootstrap + listener). The DOM data-theme attribute always
  // resolves to dark|light so CSS only ever sees the two
  // concrete states.
  const [theme, setTheme] = useState<'auto' | 'dark' | 'light'>(() => {
    try {
      const stored = localStorage.getItem('averrow-theme');
      if (stored === 'auto' || stored === 'dark' || stored === 'light') return stored;
    } catch {}
    return user.theme_preference ?? 'auto';
  });
  const [timezone, setTimezone] = useState<string>(user.timezone ?? browserTimezone());

  useEffect(() => {
    if (user.timezone) setTimezone(user.timezone);
  }, [user.timezone]);

  const resolveSystemTheme = (): 'dark' | 'light' => {
    if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  };

  const persistTheme = async (next: 'auto' | 'dark' | 'light') => {
    const resolved = next === 'auto' ? resolveSystemTheme() : next;
    document.documentElement.setAttribute('data-theme', resolved);
    try { localStorage.setItem('averrow-theme', next); } catch {}
    setTheme(next);
    // Persist 'auto' to the backend by writing null (the backend
    // treats null as "follow OS / app default"). dark/light stamp
    // the explicit preference.
    const body = next === 'auto' ? { theme_preference: null } : { theme_preference: next };
    try {
      const res = await apiClient.patch('/api/profile', body);
      if (res.success) onUserUpdated();
      else onToast(res.error ?? 'Theme save failed.', 'error');
    } catch {
      // Swallow — theme is already applied locally; server retry on next change.
    }
  };

  const persistTimezone = async (next: string) => {
    setTimezone(next);
    try {
      const res = await apiClient.patch('/api/profile', { timezone: next });
      if (res.success) {
        onToast('Timezone saved.', 'success');
        onUserUpdated();
      } else {
        onToast(res.error ?? 'Timezone save failed.', 'error');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Timezone save failed.', 'error');
    }
  };

  return (
    <ProfileCard>
      <ProfileSectionLabel>Preferences</ProfileSectionLabel>
      <div style={{ display: 'grid', gap: 16 }}>
        <div>
          <ProfileFieldLabel>Theme</ProfileFieldLabel>
          <div style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-base)' }}>
            {(['auto', 'dark', 'light'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => void persistTheme(value)}
                style={{
                  padding:    '8px 18px',
                  fontSize:   11,
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  fontWeight: 700,
                  background: theme === value ? 'var(--amber, #E5A832)' : 'transparent',
                  color:      theme === value ? 'var(--text-on-amber, #0A0F1E)' : 'var(--text-tertiary)',
                  border:     'none',
                  cursor:     'pointer',
                  transition: 'background 120ms ease',
                }}
              >
                {value}
              </button>
            ))}
          </div>
          <ProfileFieldHelper>
            <strong>Auto</strong> follows your OS appearance. Pick Dark or Light to override.
          </ProfileFieldHelper>
        </div>

        <div>
          <ProfileFieldLabel htmlFor="profile-timezone">Timezone</ProfileFieldLabel>
          <select
            id="profile-timezone"
            value={timezone}
            onChange={(e) => void persistTimezone(e.target.value)}
            style={{
              width:        '100%',
              maxWidth:     360,
              background:   'var(--bg-input)',
              color:        'var(--text-primary)',
              border:       '1px solid var(--border-base)',
              borderRadius: 8,
              padding:      '10px 12px',
              fontSize:     13,
              cursor:       'pointer',
            }}
          >
            {!TIMEZONE_OPTIONS.find((o) => o.value === timezone) && (
              <option value={timezone}>{timezone} (custom)</option>
            )}
            {TIMEZONE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ProfileFieldHelper>
            Used for Quiet Hours, briefing schedules, and when timestamps are displayed.
          </ProfileFieldHelper>
        </div>
      </div>
    </ProfileCard>
  );
}

// ─── 4. Passkeys ─────────────────────────────────────────────
//
// Per-device list with biometric badge + add-on-this-device.

interface PasskeysProps {
  passkeyAdapter: PasskeyAdapter;
  onUserUpdated:  () => void;
  onToast:        (msg: string, kind: 'success' | 'error') => void;
}

export function PasskeysSection({ passkeyAdapter, onUserUpdated, onToast }: PasskeysProps) {
  const supported = passkeyAdapter.isSupported();
  const [keys, setKeys] = useState<PasskeyDevice[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [showLabel, setShowLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');

  useEffect(() => {
    if (!supported) return;
    void passkeyAdapter.list().then(setKeys).catch(() => setKeys([]));
  }, [supported, passkeyAdapter]);

  const refresh = () => {
    if (!supported) return;
    void passkeyAdapter.list().then(setKeys).catch(() => setKeys([]));
  };

  const handleAdd = async () => {
    setAdding(true);
    try {
      await passkeyAdapter.register(labelDraft.trim() || undefined);
      onToast('Passkey added.', 'success');
      setLabelDraft('');
      setShowLabel(false);
      refresh();
      onUserUpdated();
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        // User cancelled OS prompt — silent.
      } else {
        onToast(err instanceof Error ? err.message : 'Could not add passkey.', 'error');
      }
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await passkeyAdapter.remove(id);
      onToast('Passkey removed.', 'success');
      refresh();
      onUserUpdated();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not remove passkey.', 'error');
    }
  };

  return (
    <ProfileCard>
      <ProfileSectionLabel>Passkeys</ProfileSectionLabel>

      {!supported ? (
        <ProfileFieldHelper>
          This browser doesn't support WebAuthn / passkeys. Use Google or magic link to sign in.
        </ProfileFieldHelper>
      ) : (
        <>
          {keys && keys.length === 0 ? (
            <ProfileFieldHelper>
              No passkeys registered yet. Add one to sign in faster on this device.
            </ProfileFieldHelper>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {(keys ?? []).map((k) => {
                const biometric = k.transports.includes('internal');
                return (
                  <div
                    key={k.id}
                    style={{
                      display:        'flex',
                      alignItems:     'center',
                      justifyContent: 'space-between',
                      gap:            12,
                      padding:        '10px 12px',
                      background:     'var(--bg-input)',
                      border:         '1px solid var(--border-base)',
                      borderRadius:   8,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 13,
                        color:    'var(--text-primary)',
                        fontWeight: 600,
                        overflow:   'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {k.device_label ?? 'Unnamed passkey'}
                      </div>
                      <div style={{
                        fontSize: 10,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-tertiary)',
                        marginTop: 2,
                      }}>
                        {k.last_used_at
                          ? `Last used ${new Date(k.last_used_at).toLocaleDateString()}`
                          : 'Never used'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {biometric && <ProfilePill tone="green">Biometric</ProfilePill>}
                      <ProfileButton variant="danger" size="sm" onClick={() => void handleRemove(k.id)}>
                        Remove
                      </ProfileButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            {showLabel ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 240px' }}>
                  <ProfileInput
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    placeholder="e.g. MacBook Pro 14"
                    disabled={adding}
                    maxLength={60}
                  />
                </div>
                <ProfileButton variant="primary" onClick={() => void handleAdd()} disabled={adding}>
                  {adding ? 'Adding…' : 'Add passkey'}
                </ProfileButton>
                <ProfileButton variant="ghost" onClick={() => setShowLabel(false)} disabled={adding}>
                  Cancel
                </ProfileButton>
              </div>
            ) : (
              <ProfileButton variant="secondary" size="sm" onClick={() => setShowLabel(true)}>
                Add passkey for this device
              </ProfileButton>
            )}
          </div>
        </>
      )}
    </ProfileCard>
  );
}

// ─── 5. Notifications (link row) ─────────────────────────────

interface NotificationsProps {
  onNavigate: (path: string) => void;
  href:       string;
}

export function NotificationsSection({ onNavigate, href }: NotificationsProps) {
  return (
    <ProfileCard onClick={() => onNavigate(href)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: 0,
          }}>
            Notifications
          </h3>
          <p style={{
            margin:    '4px 0 0',
            fontSize:  12,
            fontFamily: 'var(--font-mono)',
            color:     'var(--text-secondary)',
          }}>
            Manage events, channels, quiet hours, and your subscribed devices.
          </p>
        </div>
        <span aria-hidden style={{ color: 'var(--amber, #E5A832)', fontSize: 18 }}>→</span>
      </div>
    </ProfileCard>
  );
}

// ─── 6. Billing (tenant-only link row) ──────────────────────

interface BillingProps {
  onNavigate: (path: string) => void;
  href:       string;
  user:       ProfileUser;
}

export function BillingSection({ onNavigate, href, user }: BillingProps) {
  return (
    <ProfileCard onClick={() => onNavigate(href)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
            Billing
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
            Plan, monthly total, active modules, trial / billing status.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {user.organization?.plan && <ProfilePill tone="amber">{user.organization.plan}</ProfilePill>}
          <span aria-hidden style={{ color: 'var(--amber, #E5A832)', fontSize: 18 }}>→</span>
        </div>
      </div>
    </ProfileCard>
  );
}

// ─── 7. Security (sessions + revoke) ─────────────────────────

interface SecurityProps {
  apiClient:    ProfileApiClient;
  onToast:      (msg: string, kind: 'success' | 'error') => void;
  /** Endpoint returning the current user's active sessions. */
  sessionsEndpoint?: string;
  /** Endpoint to revoke OTHER sessions (POST). */
  revokeEndpoint?:   string;
}

export function SecuritySection({
  apiClient, onToast,
  // Consumers MUST provide both endpoints. Sensible defaults shown
  // for /v2 (admin scope). For /tenant, the host app supplies
  // tenant-scoped equivalents (/api/auth/sessions when that
  // endpoint lands).
  sessionsEndpoint = '/api/admin/sessions',
  revokeEndpoint   = '/api/admin/sessions/revoke',
}: SecurityProps) {
  const [data, setData] = useState<SessionSummary | null>(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiClient.get<SessionSummary>(sessionsEndpoint).then((r) => {
      if (cancelled) return;
      if (r.success && r.data) setData(r.data);
    }).catch(() => { /* host shows toast via API client adapter on auth errors */ });
    return () => { cancelled = true; };
  }, [apiClient, sessionsEndpoint]);

  const revoke = async () => {
    setRevoking(true);
    try {
      const res = await apiClient.post(revokeEndpoint);
      if (res.success) {
        onToast('Other sessions revoked.', 'success');
        const r = await apiClient.get<SessionSummary>(sessionsEndpoint);
        if (r.success && r.data) setData(r.data);
      } else {
        onToast(res.error ?? 'Could not revoke sessions.', 'error');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not revoke sessions.', 'error');
    } finally {
      setRevoking(false);
    }
  };

  return (
    <ProfileCard>
      <ProfileSectionLabel>Security</ProfileSectionLabel>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: 0 }}>Active sessions</p>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '2px 0 0', fontFamily: 'var(--font-mono)' }}>
            {data?.total ?? 0} active session{data?.total === 1 ? '' : 's'}
          </p>
        </div>
        <ProfileButton variant="danger" size="sm" onClick={() => void revoke()} disabled={revoking}>
          {revoking ? 'Revoking…' : 'Revoke other sessions'}
        </ProfileButton>
      </div>

      {data?.sessions && data.sessions.length > 0 && (
        <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
          {data.sessions.slice(0, 5).map((s) => (
            <div
              key={s.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                paddingTop: 8,
                borderTop: '1px solid var(--border-base)',
              }}
            >
              <p style={{
                margin: 0,
                fontSize: 11,
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {s.ip_address ?? 'Unknown IP'}
              </p>
              <span style={{
                fontSize: 10,
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
                flexShrink: 0,
              }}>
                {new Date(s.issued_at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </ProfileCard>
  );
}

// ─── 8. Sign out (compound row) ──────────────────────────────

export function SignOutSection({ onLogout }: { onLogout: () => void }) {
  return (
    <ProfileCard>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
            Sign out
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
            Ends this session. Other devices stay signed in unless you revoke them above.
          </p>
        </div>
        <ProfileButton variant="danger" onClick={onLogout}>
          Sign out
        </ProfileButton>
      </div>
    </ProfileCard>
  );
}
