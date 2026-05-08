// Profile page — FarmTrack-aligned composition.
//
// Sections in order:
//   1. Identity        (avatar + name + email + role)
//   2. Account         (display_name editable; falls back to Google name)
//   3. Preferences     (theme + timezone)
//   4. Install card    (PWA install affordance, hidden when standalone)
//   5. Passkeys card   (per-device list + biometric badge + add)
//   6. Notifications   (links to /v2/notifications/preferences)
//   7. Security        (active sessions + revoke)
//   8. Sign out

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Shield, Clock, Monitor, Bell } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/time';
import { Card, Button, SectionLabel } from '@/design-system/components';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useTheme } from '@/design-system/hooks';
import { parseInitials, SELF_AVATAR_COLOR } from '@/lib/avatar';
import { InstallAppCard } from '@/components/InstallAppCard';
import { PasskeysCard } from '@/components/PasskeysCard';

interface SessionData {
  total: number;
  sessions: Array<{
    id: string;
    ip_address: string;
    user_agent: string;
    issued_at: string;
  }>;
}

const TIMEZONE_OPTIONS = [
  { value: 'America/Toronto', label: 'America/Toronto (EST/EDT)' },
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Chicago', label: 'America/Chicago' },
  { value: 'America/Denver', label: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'America/Halifax', label: 'America/Halifax' },
  { value: 'America/Vancouver', label: 'America/Vancouver' },
  { value: 'UTC', label: 'UTC' },
];

function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return 'UTC'; }
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  analyst: 'Analyst',
  client: 'Client',
};

export function Profile() {
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const { showToast } = useToast();
  const { isDark, setTheme } = useTheme();

  const [displayName, setDisplayName] = useState(user?.display_name ?? user?.name ?? '');
  const [timezone, setTimezone] = useState<string>(user?.timezone ?? browserTimezone());
  const [savingField, setSavingField] = useState<string | null>(null);

  // Sync local state when /me refreshes (e.g. after a save).
  useEffect(() => {
    if (user?.display_name != null) setDisplayName(user.display_name);
    if (user?.timezone) setTimezone(user.timezone);
  }, [user?.display_name, user?.timezone]);

  const initials = parseInitials(user?.display_name ?? user?.name, user?.email);
  const roleName = ROLE_LABEL[user?.role ?? ''] ?? 'Client';

  const { data: sessionData } = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      const res = await api.get<SessionData>('/api/admin/sessions');
      return res.data;
    },
  });

  const forceLogout = useMutation({
    mutationFn: async () => {
      if (!user?.id) return;
      await api.post(`/api/admin/users/${user.id}/force-logout`);
    },
    onSuccess: () => showToast('Other sessions revoked.', 'success'),
    onError: (err) => showToast(err instanceof Error ? err.message : 'Revoke failed', 'error'),
  });

  const patchProfile = async (body: Record<string, unknown>, field: string) => {
    setSavingField(field);
    try {
      const res = await api.patch<{ profile: unknown }>('/api/profile', body);
      if (res.success) {
        showToast('Saved.', 'success');
        await refreshUser();
      } else {
        showToast(res.error ?? 'Save failed', 'error');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSavingField(null);
    }
  };

  const saveDisplayName = () => patchProfile(
    { display_name: displayName.trim() || null },
    'display_name',
  );

  const onChangeTheme = (next: 'dark' | 'light') => {
    setTheme(next);
    void patchProfile({ theme_preference: next }, 'theme_preference');
  };

  const onChangeTimezone = (next: string) => {
    setTimezone(next);
    void patchProfile({ timezone: next }, 'timezone');
  };

  return (
    <div className="max-w-2xl mx-auto page-enter">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg touch-target"
          style={{
            background: 'transparent',
            border: '1px solid var(--border-base)',
            color: 'var(--text-secondary)',
            transition: 'var(--transition-fast)',
          }}
          aria-label="Back"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-mono text-[10px] uppercase tracking-[0.15em]" style={{ color: 'var(--text-muted)', fontWeight: 700 }}>
          Profile & Settings
        </h1>
      </div>

      {/* 1. Identity */}
      <Card className="mb-4">
        <SectionLabel className="mb-3">Identity</SectionLabel>
        <div className="flex items-center gap-4">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold flex-shrink-0"
            style={{
              background: SELF_AVATAR_COLOR,
              color: 'var(--text-on-amber, #0A0F1E)',
              border: '2px solid rgba(255,255,255,0.20)',
            }}
            aria-label={`Avatar: ${initials}`}
          >
            {initials}
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {user?.display_name ?? user?.name ?? 'User'}
            </h2>
            <p className="text-[12px] truncate" style={{ color: 'var(--text-secondary)' }}>
              {user?.email}
            </p>
            <p className="text-[10px] font-mono uppercase tracking-[0.14em] mt-0.5" style={{ color: 'var(--amber)' }}>
              {roleName}
            </p>
          </div>
        </div>
      </Card>

      {/* 2. Account */}
      <Card className="mb-4">
        <SectionLabel className="mb-3">
          <span className="inline-flex items-center gap-1.5">
            <Monitor size={12} style={{ color: 'var(--amber)' }} />
            Account
          </span>
        </SectionLabel>

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              Display Name
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={user?.name ?? 'Your name'}
                className="text-[13px] flex-1"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void saveDisplayName()}
                disabled={savingField === 'display_name'}
              >
                {savingField === 'display_name' ? 'Saving…' : 'Save'}
              </Button>
            </div>
            <p className="mt-1 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              Shown instead of your Google name. Leave blank to use Google.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              Email
            </label>
            <div
              className="rounded-lg px-3 py-2 text-[13px]"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-base)',
                color: 'var(--text-tertiary)',
                cursor: 'not-allowed',
              }}
            >
              {user?.email}
            </div>
          </div>
        </div>
      </Card>

      {/* 3. Preferences */}
      <Card className="mb-4">
        <SectionLabel className="mb-3">
          <span className="inline-flex items-center gap-1.5">
            <Clock size={12} style={{ color: 'var(--amber)' }} />
            Preferences
          </span>
        </SectionLabel>

        <div className="space-y-4">
          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Theme
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onChangeTheme('dark')}
                className="flex h-10 flex-1 items-center justify-center rounded-md font-mono text-[11px] uppercase tracking-[0.14em] touch-target"
                style={{
                  background: isDark ? 'var(--amber-glow, rgba(229,168,50,0.20))' : 'var(--bg-input)',
                  color: isDark ? 'var(--amber)' : 'var(--text-tertiary)',
                  border: `1px solid ${isDark ? 'var(--amber-border, rgba(229,168,50,0.25))' : 'var(--border-base)'}`,
                }}
              >
                Dark
              </button>
              <button
                type="button"
                onClick={() => onChangeTheme('light')}
                className="flex h-10 flex-1 items-center justify-center rounded-md font-mono text-[11px] uppercase tracking-[0.14em] touch-target"
                style={{
                  background: !isDark ? 'var(--amber-glow, rgba(229,168,50,0.20))' : 'var(--bg-input)',
                  color: !isDark ? 'var(--amber)' : 'var(--text-tertiary)',
                  border: `1px solid ${!isDark ? 'var(--amber-border, rgba(229,168,50,0.25))' : 'var(--border-base)'}`,
                }}
              >
                Light
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => onChangeTimezone(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-[13px]"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-base)',
                color: 'var(--text-primary)',
              }}
            >
              {!TIMEZONE_OPTIONS.find((o) => o.value === timezone) && (
                <option value={timezone}>{timezone} (custom)</option>
              )}
              {TIMEZONE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p className="mt-1 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              Used for Quiet Hours and morning-briefing scheduling.
            </p>
          </div>
        </div>
      </Card>

      {/* 4. Install card (hidden when standalone) */}
      <InstallAppCard />

      {/* 5. Passkeys */}
      <PasskeysCard />

      {/* 6. Notifications row */}
      <Card
        className="mb-4 cursor-pointer"
        onClick={() => navigate('/notifications/preferences')}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--text-primary)', fontSize: 14 }}>
              <Bell size={14} style={{ color: 'var(--amber)' }} />
              Notifications
            </h3>
            <p className="mt-0.5 font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              Manage events, channels, quiet hours, and your subscribed devices.
            </p>
          </div>
          <span aria-hidden style={{ color: 'var(--amber)', fontSize: 18 }}>→</span>
        </div>
      </Card>

      {/* 7. Security */}
      <Card className="mb-4">
        <SectionLabel className="mb-3">
          <span className="inline-flex items-center gap-1.5">
            <Shield size={12} style={{ color: 'var(--amber)' }} />
            Security
          </span>
        </SectionLabel>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px]" style={{ color: 'var(--text-primary)' }}>Active Sessions</p>
              <p className="text-[11px] mt-0.5 font-mono" style={{ color: 'var(--text-tertiary)' }}>
                {sessionData?.total ?? 0} sessions
              </p>
            </div>
            <button
              onClick={() => forceLogout.mutate()}
              disabled={forceLogout.isPending}
              className="px-3 py-1.5 rounded-lg text-[10px] font-mono uppercase tracking-wider touch-target"
              style={{
                background: 'transparent',
                border: '1px solid var(--sev-critical-border)',
                color: 'var(--sev-critical)',
                transition: 'var(--transition-fast)',
              }}
            >
              {forceLogout.isPending ? 'Revoking…' : 'Revoke other sessions'}
            </button>
          </div>

          {sessionData?.sessions && sessionData.sessions.length > 0 && (
            <div className="mt-3 space-y-2">
              {sessionData.sessions.slice(0, 5).map((s) => (
                <div key={s.id} className="flex items-center justify-between py-1.5 border-t border-white/5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{s.ip_address ?? 'Unknown IP'}</p>
                  </div>
                  <span className="text-[10px] font-mono flex-shrink-0 ml-2" style={{ color: 'var(--text-tertiary)' }}>
                    {relativeTime(s.issued_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
