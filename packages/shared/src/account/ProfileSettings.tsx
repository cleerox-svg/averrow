// Profile page (ACCOUNT_DESIGN_SPEC §5.1) — Personal info, Appearance, Account.
//
// Host-agnostic: no router, no api module. The host passes the user, an api
// client (only `patch`), the theme state + setter, and callbacks. Mount it
// inside a <ToastProvider> (it reports saves/failures through useToast).
//
// Persistence contract (unchanged from the old ProfilePage sections):
//   PATCH /api/profile { display_name }      — "" / blank clears (falls back to the Google name)
//   PATCH /api/profile { timezone }          — the single source of truth, also read by quiet hours
//   PATCH /api/profile { theme_preference }  — 'dark' | 'light'; null = follow the device (Auto)
//
// Save semantics (spec principle 3): the display name is a form with an explicit
// Save / Discard; theme and time zone save on change and revert if the save fails.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { roleLabel } from '../roles';
import type { Theme } from '../theme';
import type { ProfileApiClient } from '../profile/types';
import { Badge } from '../ui/Badge';
import { roleBadgeProps } from '../ui/settings/roleBadge';
import { Button } from '../ui/Button';
import { Field, Input, SegmentedControl, type SegmentedOption } from '../ui/forms';
import { PageState } from '../ui/PageState';
import { TimezoneSelect, detectTimeZone, useToast } from '../ui/overlays';
import {
  AccountHero, CopyField, SettingsGroup, SettingsRow, describeAccountScope, useMediaQuery,
} from '../ui/settings';
import {
  CalendarIcon, GlobeIcon, IdBadgeIcon, KeyIcon, MonitorIcon, MoonIcon, ShieldCheckIcon, SunIcon,
} from './section-icons';
import { SignOutRow } from './SignOutRow';
import { formatFullDate } from './time-format';

export interface ProfileSettingsUser {
  id: string;
  email: string;
  /** Backend-computed: display_name ?? name. */
  name: string;
  role: string;
  display_name?: string | null;
  timezone?: string | null;
  passkey_count?: number;
  /** ISO / SQLite timestamp from /api/auth/me. */
  created_at?: string | null;
  organization?: { name: string; role: string } | null;
}

export interface ProfileSettingsProps {
  user: ProfileSettingsUser | null | undefined;
  /** Layout-shaped skeleton while the user is still loading. */
  loading?: boolean;
  /** Load failure: renders an error card with retry. */
  error?: boolean;
  onRetry?: () => void;
  apiClient: Pick<ProfileApiClient, 'patch'>;
  /** Current theme preference + setter (the host's useTheme()). */
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  /** Refresh the session user after a successful save. */
  onUserUpdated: () => void | Promise<unknown>;
  onSignOut: () => void;
  /** Reports unsaved display-name edits (so the host can guard navigation). */
  onDirtyChange?: (dirty: boolean) => void;
  /** `auto` follows the 1024px breakpoint (hero + rail footer live on desktop, Sign out row on mobile). */
  layout?: 'auto' | 'desktop' | 'mobile';
}

const NAME_MAX = 60;
const SAVE_FAILED = "Couldn't save. Check your connection and try again.";

const THEME_OPTIONS: SegmentedOption[] = [
  { value: 'auto', label: 'Auto', icon: <MonitorIcon /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
  { value: 'light', label: 'Light', icon: <SunIcon /> },
];

function isTheme(v: string): v is Theme {
  return v === 'auto' || v === 'dark' || v === 'light';
}

function ButtonSpinner() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" className="animate-spin">
      <circle cx="12" cy="12" r="9" opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

export function ProfileSettings({
  user, loading = false, error = false, onRetry, apiClient, theme, onThemeChange, onUserUpdated,
  onSignOut, onDirtyChange, layout = 'auto',
}: ProfileSettingsProps) {
  const toast = useToast();
  const mqDesktop = useMediaQuery('(min-width: 1024px)', true);
  const isDesktop = layout === 'auto' ? mqDesktop : layout === 'desktop';
  // <480px the Theme row stacks under its text, so the control fills the row.
  const narrow = useMediaQuery('(max-width: 479px)', false);
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);

  // ── display name ──
  const baseline = (user?.display_name ?? user?.name ?? '').trim();
  const [saved, setSaved] = useState(baseline);
  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  // The session user changed (refresh after save, or another tab): adopt it,
  // but never clobber edits in progress.
  useEffect(() => {
    setDraft((d) => (d.trim() === savedRef.current ? baseline : d));
    setSaved(baseline);
  }, [baseline]);

  const dirty = draft.trim() !== saved;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const saveName = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!dirty || saving) return;
    const trimmed = draft.trim();
    setSaving(true);
    try {
      const res = await apiClient.patch('/api/profile', { display_name: trimmed.length === 0 ? null : trimmed });
      if (!res.success) throw new Error(res.error ?? 'save failed');
      setSaved(trimmed);
      setDraft(trimmed);
      toast.success('Profile saved.');
      await onUserUpdated();
    } catch {
      toast.error(SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => setDraft(saved);

  // ── theme ──
  // The theme the user chose most recently. An earlier PATCH that fails after a
  // later choice must not revert that later choice.
  const chosenThemeRef = useRef<string | null>(null);
  const changeTheme = async (value: string) => {
    if (!isTheme(value) || value === theme) return;
    const previous = theme;
    chosenThemeRef.current = value;
    onThemeChange(value); // instant: the UI never waits on the network
    try {
      const res = await apiClient.patch('/api/profile', { theme_preference: value === 'auto' ? null : value });
      if (!res.success) throw new Error(res.error ?? 'save failed');
      await onUserUpdated();
    } catch {
      // Only revert if the user hasn't since picked something else.
      if (chosenThemeRef.current === value) {
        chosenThemeRef.current = null;
        onThemeChange(previous);
      }
      toast.error("Couldn't save your theme. Check your connection and try again.");
    }
  };

  // ── time zone ──
  const serverTz = user?.timezone ?? null;
  const [timezone, setTimezone] = useState<string>(serverTz ?? detectTimeZone() ?? 'UTC');
  const [tzSaving, setTzSaving] = useState(false);
  useEffect(() => { if (serverTz) setTimezone(serverTz); }, [serverTz]);

  const changeTimezone = async (next: string) => {
    // Compare with the SERVER value: with no saved zone the select shows the
    // detected one, and choosing that same zone must still persist it.
    if (next === serverTz) return;
    const previous = timezone;
    setTimezone(next);
    setTzSaving(true);
    try {
      const res = await apiClient.patch('/api/profile', { timezone: next });
      if (!res.success) throw new Error(res.error ?? 'save failed');
      toast.success('Time zone saved.');
      await onUserUpdated();
    } catch {
      setTimezone(previous);
      toast.error("Couldn't save your time zone. Check your connection and try again.");
    } finally {
      setTzSaving(false);
    }
  };

  const focusName = useCallback(() => {
    nameRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    nameRef.current?.focus();
  }, []);

  const scope = useMemo(
    () => describeAccountScope({ role: user?.role, orgName: user?.organization?.name, orgRole: user?.organization?.role }),
    [user?.role, user?.organization?.name, user?.organization?.role],
  );

  // ── states ──
  if (error) {
    return <PageState kind="error" layout="card" title="Couldn't load your profile" description="Check your connection and try again." onRetry={onRetry} />;
  }
  if (loading || !user) {
    return (
      <div aria-busy="true">
        {isDesktop && <div className="mb-7"><AccountHero loading /></div>}
        <PageState kind="loading" layout="card" />
      </div>
    );
  }

  const isStaff = user.role !== 'client';
  const memberSince = formatFullDate(user.created_at);

  return (
    <div>
      {isDesktop && (
        <div className="mb-7">
          <AccountHero
            name={user.display_name ?? user.name}
            email={user.email}
            role={user.role}
            passkey={typeof user.passkey_count === 'number' ? user.passkey_count > 0 : null}
            scope={scope}
            actions={(
              <>
                <Button type="button" variant="secondary" onClick={focusName}>Edit profile</Button>
                <Button type="button" variant="ghost" onClick={onSignOut}>Sign out</Button>
              </>
            )}
          />
        </div>
      )}

      <SettingsGroup title="Personal info">
        <form onSubmit={(e) => { void saveName(e); }} className="flex flex-col gap-4 p-4 min-[768px]:p-5" noValidate>
          <Field label="Display name" id={nameId} help="Shown across Averrow. Leave blank to use your Google name.">
            <Input
              ref={nameRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={NAME_MAX}
              autoComplete="name"
              placeholder="Your name"
              disabled={saving}
            />
          </Field>
          <Field label="Email" help="Managed by your Google account.">
            <Input value={user.email} readOnly />
          </Field>
          <div className="flex flex-col-reverse gap-2 min-[640px]:flex-row min-[640px]:justify-end">
            {dirty && (
              <Button type="button" variant="ghost" size="lg" className="min-[640px]:h-10 min-[640px]:min-h-10 min-[640px]:px-4 min-[640px]:text-[13px]" onClick={discard} disabled={saving}>
                Discard
              </Button>
            )}
            <Button
              type="submit"
              size="lg"
              className="min-w-[148px] min-[640px]:h-10 min-[640px]:min-h-10 min-[640px]:px-4 min-[640px]:text-[13px]"
              disabled={!dirty || saving}
              aria-busy={saving || undefined}
            >
              {saving ? <ButtonSpinner /> : null}
              Save changes
            </Button>
          </div>
        </form>
      </SettingsGroup>

      <SettingsGroup title="Appearance">
        <SettingsRow
          icon={<MonitorIcon />}
          tone="amber"
          title="Theme"
          description="Match your device, or always use dark or light."
          stackTrailing
          trailing={(
            <SegmentedControl
              aria-label="Theme"
              options={THEME_OPTIONS}
              value={theme}
              fullWidth={narrow}
              onValueChange={(v) => { void changeTheme(v); }}
            />
          )}
        />
        <SettingsRow
          icon={<GlobeIcon />}
          tone="amber"
          title="Time zone"
          description="Used for quiet hours and the times you see in alerts."
          stackTrailing
          loading={tzSaving}
          trailing={(
            <TimezoneSelect
              aria-label="Time zone"
              value={timezone}
              onChange={(tz) => { void changeTimezone(tz); }}
              disabled={tzSaving}
            />
          )}
        />
      </SettingsGroup>

      <SettingsGroup title="Account">
        <SettingsRow
          icon={<IdBadgeIcon />}
          title="Role"
          // Desktop already shows the role badge in the hero: plain text here, one badge per page.
          trailing={isDesktop
            ? <span className="text-[14px] text-[var(--text-secondary)]">{roleLabel(user.role)}</span>
            : <Badge {...roleBadgeProps(user.role).tone} label={roleLabel(user.role)} size="md" font="sans" />}
        />
        {scope && (
          <SettingsRow icon={<ShieldCheckIcon />} title="Access" description={scope} />
        )}
        {memberSince && (
          <SettingsRow
            icon={<CalendarIcon />}
            title="Member since"
            trailing={<span className="text-[14px] text-[var(--text-secondary)] [font-variant-numeric:tabular-nums]">{memberSince}</span>}
          />
        )}
        {isStaff && (
          <SettingsRow
            icon={<KeyIcon />}
            title="User ID"
            description="Share this with support if they ask for it."
            stackTrailing
            trailing={<CopyField value={user.id} label="user ID" onCopied={() => toast.success('User ID copied.')} />}
          />
        )}
      </SettingsGroup>

      {!isDesktop && <SignOutRow onSignOut={onSignOut} />}
    </div>
  );
}
