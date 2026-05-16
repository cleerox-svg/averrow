// Notification Preferences — v3 rebuild
//
// The legacy 680-line page was confusing: 5 event toggles in an
// "Alert Types" card, then Push devices, then Quiet Hours, then
// Channel Routing — but the v2 schema (notification_preferences_v2)
// supports far more (per-channel severity floors, digest mode,
// per-brand subscriptions) that the UI never surfaced. PR-C
// rebuilds the page with 6 sectioned panels matching the
// brands/threats Intel pattern (PanelHeader + sectioned Cards),
// using the existing v2 hooks. Same backend, much more visible.
//
// Sections:
//   1. Delivery — per-channel severity floor (in-app / push / email)
//   2. Digest — mode + severity floor for digest contents
//   3. Events — user-toggleable event rows (auto-picks up PR-B's
//      DMARC / Feed at Risk / Agent Stalled toggles)
//   4. Subscriptions — per-brand watching/default/ignored level
//   5. Quiet hours — start/end/timezone + critical bypass
//   6. Push devices — enable/disable + manage registered devices

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Bell, Smartphone, Trash2, AlertTriangle,
  Eye, Inbox, Mail, Clock, Globe, Building2,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  USER_TOGGLEABLE_EVENTS,
  NOTIFICATION_CHANNELS,
} from '@averrow/shared';
import { Card, SectionLabel, Button } from '@/design-system/components';
import {
  getPushStatus, subscribePush, unsubscribePush,
  listPushDevices, removePushDevice, sendTestPush,
  type PushStatus, type PushDevice,
} from '@/lib/push';
import {
  useNotificationPreferencesV2, useUpdateNotificationPreferencesV2,
  useNotificationSubscriptions, useUpdateSubscription, useDeleteSubscription,
  type NotificationPreferencesV2, type SubscriptionLevel,
} from '@/hooks/useNotifications';
import { useAuth } from '@/lib/auth';

const PREF_KEYS = [
  ...USER_TOGGLEABLE_EVENTS.map((e) => e.key),
  ...NOTIFICATION_CHANNELS.map((c) => c.key),
] as const;
type PrefKey = (typeof PREF_KEYS)[number];
type Preferences = Record<PrefKey, boolean>;

interface PreferencesResponse extends Preferences {
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_tz: string | null;
  critical_breakthrough: boolean;
}

const PREF_DEFAULTS: Preferences = (() => {
  const out = {} as Preferences;
  for (const e of USER_TOGGLEABLE_EVENTS) out[e.key] = e.defaultEnabled;
  for (const c of NOTIFICATION_CHANNELS) out[c.key] = c.defaultEnabled;
  return out;
})();

const FULL_DEFAULTS: PreferencesResponse = {
  ...PREF_DEFAULTS,
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_tz: null,
  critical_breakthrough: true,
};

const SEVERITY_FLOOR_OPTIONS = [
  { value: 'info',     label: 'Everything (info+)' },
  { value: 'low',      label: 'Low and above' },
  { value: 'medium',   label: 'Medium and above' },
  { value: 'high',     label: 'High and critical only' },
  { value: 'critical', label: 'Critical only' },
] as const;

const SEVERITY_FLOOR_WITH_OFF = [
  ...SEVERITY_FLOOR_OPTIONS,
  { value: 'off', label: 'Off — never send' },
] as const;

const DIGEST_MODES = [
  { value: 'realtime', label: 'Realtime — every notification individually' },
  { value: 'hourly',   label: 'Hourly digest' },
  { value: 'daily',    label: 'Daily digest' },
  { value: 'weekly',   label: 'Weekly digest' },
  { value: 'off',      label: 'Off — no digests' },
] as const;

const DIGEST_FLOOR_OPTIONS = [
  { value: 'info',   label: 'Include everything (info+)' },
  { value: 'low',    label: 'Low and above' },
  { value: 'medium', label: 'Medium and above' },
  { value: 'high',   label: 'High and critical only' },
] as const;

// NX5: per-group cadence — distinct from digest_mode. Intel + platform
// each get their own batching cadence so an operator who only wants a
// daily intel digest can still get realtime feed_health pings.
const GROUP_CADENCE_OPTIONS = [
  { value: 'realtime',      label: 'Realtime — every notification individually' },
  { value: 'daily_digest',  label: 'Daily digest' },
  { value: 'weekly_digest', label: 'Weekly digest' },
] as const;

const SUBSCRIPTION_LEVELS: Array<{ value: SubscriptionLevel; label: string; description: string }> = [
  { value: 'watching', label: 'Watching', description: 'Receive every notification for this brand' },
  { value: 'default',  label: 'Default',  description: 'Severity floors apply' },
  { value: 'ignored',  label: 'Ignored',  description: 'No notifications for this brand' },
];

export function NotificationPreferences() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  // ── N1 prefs (event-row toggles + channel booleans + quiet hours) ──
  const { data: prefs } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: async () => {
      const res = await api.get<PreferencesResponse>('/api/notifications/preferences');
      return res.data ?? FULL_DEFAULTS;
    },
  });

  const [localPrefs, setLocalPrefs] = useState<PreferencesResponse | null>(null);
  const currentPrefs = localPrefs ?? prefs;

  const updatePrefs = useMutation({
    mutationFn: async (updated: Partial<PreferencesResponse>) =>
      api.patch('/api/notifications/preferences', updated),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notification-preferences'] }),
  });

  const handleToggle = (key: keyof Preferences) => {
    if (!currentPrefs) return;
    const updated = { ...currentPrefs, [key]: !currentPrefs[key] };
    setLocalPrefs(updated);
    updatePrefs.mutate({ [key]: updated[key] } as Partial<PreferencesResponse>);
  };
  const handleQuietField = <K extends 'quiet_hours_start' | 'quiet_hours_end' | 'quiet_hours_tz' | 'critical_breakthrough'>(
    key: K, value: PreferencesResponse[K],
  ) => {
    if (!currentPrefs) return;
    const updated = { ...currentPrefs, [key]: value };
    setLocalPrefs(updated);
    updatePrefs.mutate({ [key]: value } as Partial<PreferencesResponse>);
  };

  // ── v2 prefs (per-channel severity floors + digest mode) ──
  const { data: v2 } = useNotificationPreferencesV2();
  const updateV2 = useUpdateNotificationPreferencesV2();
  function patchV2(p: Partial<NotificationPreferencesV2>) { updateV2.mutate(p); }

  // ── Per-brand subscriptions ──
  const { data: subscriptions = [] } = useNotificationSubscriptions();
  const updateSub = useUpdateSubscription();
  const deleteSub = useDeleteSubscription();

  // ── Push subscription state ──
  const { data: pushStatus, refetch: refetchPushStatus } = useQuery({
    queryKey: ['push-status'], queryFn: getPushStatus,
  });
  const { data: pushDevices } = useQuery({
    queryKey: ['push-devices'], queryFn: listPushDevices,
    enabled: pushStatus?.subscribed === true,
  });
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function handleEnablePush() {
    setPushBusy(true); setPushError(null);
    try {
      await subscribePush();
      await refetchPushStatus();
      queryClient.invalidateQueries({ queryKey: ['push-devices'] });
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Failed to enable push.');
    } finally { setPushBusy(false); }
  }

  // NX-push-uxr: test push exposed to all users (was admin-only on /admin/push).
  // Bypasses every gate so the user can verify end-to-end delivery on the
  // device they're holding without waiting for a real notification.
  async function handleTestPush() {
    setTestBusy(true); setTestResult(null);
    try {
      const r = await sendTestPush();
      setTestResult(`Sent · ${r.delivered}/${r.attempted} device(s) confirmed`);
    } catch (err) {
      setTestResult(err instanceof Error ? `Test failed: ${err.message}` : 'Test push failed.');
    } finally { setTestBusy(false); }
  }
  async function handleDisablePush() {
    setPushBusy(true); setPushError(null);
    try {
      await unsubscribePush();
      await refetchPushStatus();
      queryClient.invalidateQueries({ queryKey: ['push-devices'] });
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Failed to disable push.');
    } finally { setPushBusy(false); }
  }
  async function handleRemoveDevice(id: string) {
    try {
      await removePushDevice(id);
      queryClient.invalidateQueries({ queryKey: ['push-devices'] });
      await refetchPushStatus();
    } catch { /* swallow */ }
  }

  return (
    <div className="animate-fade-in space-y-5 max-w-4xl pb-12">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider hover:text-[var(--amber)] transition-colors"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <ArrowLeft size={12} /> Back
        </button>
        <h1 className="text-2xl font-bold flex-1" style={{ color: 'var(--text-primary)' }}>Notification preferences</h1>
      </div>

      {/* 0. ENABLE-PUSH BANNER ──────────────────────────────────────────
          NX-push-uxr: surfaces the main on/off + test push as the first
          thing on the page. The 7-panel preferences below were
          previously hiding push-enable behind 5 scroll-screens.
          Status badge, single CTA, and a Test button right next to it
          so the user gets immediate feedback the channel works end-to-end. */}
      <Card hover={false}>
        {pushError && (
          <div className="mb-3 p-2 rounded text-[11px] font-mono"
            style={{ background: 'var(--sev-critical-bg)', color: 'var(--sev-critical)', border: '1px solid var(--sev-critical-border)' }}>
            {pushError}
          </div>
        )}
        <div className="flex items-start gap-3 flex-wrap">
          <div
            className="flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center"
            style={{
              background: pushStatus?.subscribed ? 'var(--green-glow)' : 'var(--amber-glow)',
              color: pushStatus?.subscribed ? 'var(--green)' : 'var(--amber)',
            }}
          >
            <Smartphone size={18} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {pushStatus?.subscribed ? 'Push enabled on this device' : 'Push notifications'}
            </div>
            <div className="text-[11px] mt-0.5 font-mono" style={{ color: 'var(--text-tertiary)' }}>
              {pushStatus?.subscribed
                ? `${pushDevices?.length ?? 1} device(s) registered · severity floor "${v2?.push_severity_floor ?? 'low'}" — adjust in Delivery below`
                : pushStatus?.permission === 'denied'
                  ? 'Browser permission denied. Allow Averrow in your browser settings, then click Enable.'
                  : pushStatus?.permission === 'unsupported'
                    ? 'Web push not supported on this browser. iOS requires Add to Home Screen first.'
                    : 'One-click enable: requests permission, subscribes this browser, and seeds sensible defaults.'}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {pushStatus?.subscribed ? (
              <>
                <Button variant="secondary" size="sm" onClick={handleTestPush} disabled={testBusy}>
                  {testBusy ? 'Sending…' : 'Send test'}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDisablePush} disabled={pushBusy}>
                  {pushBusy ? 'Disabling…' : 'Disable on this device'}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleEnablePush}
                disabled={pushBusy || pushStatus?.permission === 'unsupported'}
              >
                {pushBusy ? 'Enabling…' : 'Enable push'}
              </Button>
            )}
          </div>
        </div>
        {testResult && (
          <div
            className="mt-3 p-2 rounded text-[11px] font-mono"
            style={{
              background: testResult.startsWith('Sent')
                ? 'var(--green-glow)'
                : 'var(--sev-critical-bg)',
              color: testResult.startsWith('Sent') ? 'var(--green)' : 'var(--sev-critical)',
              border: `1px solid ${testResult.startsWith('Sent') ? 'var(--green-border)' : 'var(--sev-critical-border)'}`,
            }}
          >
            {testResult}
          </div>
        )}
      </Card>

      {/* 1. DELIVERY CHANNELS ─────────────────────────────────────────── */}
      <PanelHeader title="Delivery" subtitle="What severity counts as worth your attention, per channel" icon={<Inbox size={14} />} />
      <Card hover={false}>
        <div className="space-y-3">
          <ChannelRow
            icon={<Bell size={14} />}
            title="In-app inbox"
            description="The bell icon and /notifications page"
            value={v2?.inapp_severity_floor ?? 'info'}
            options={SEVERITY_FLOOR_OPTIONS}
            onChange={(v) => patchV2({ inapp_severity_floor: v as NotificationPreferencesV2['inapp_severity_floor'] })}
          />
          <ChannelRow
            icon={<Smartphone size={14} />}
            title="Push notifications"
            description="OS-level push to registered devices"
            value={v2?.push_severity_floor ?? 'high'}
            options={SEVERITY_FLOOR_WITH_OFF}
            onChange={(v) => patchV2({ push_severity_floor: v as NotificationPreferencesV2['push_severity_floor'] })}
          />
          <ChannelRow
            icon={<Mail size={14} />}
            title="Email"
            description="Per-event email (sent via Resend, when configured)"
            value={v2?.email_severity_floor ?? 'high'}
            options={SEVERITY_FLOOR_WITH_OFF}
            onChange={(v) => patchV2({ email_severity_floor: v as NotificationPreferencesV2['email_severity_floor'] })}
          />
        </div>
      </Card>

      {/* 2a. NX5 PER-GROUP CADENCE ────────────────────────────────────── */}
      <PanelHeader
        title="Notification grouping"
        subtitle="Distinct cadence per audience group — refines the legacy Digest setting"
        icon={<Clock size={14} />}
      />
      <Card hover={false}>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Platform alerts
                </div>
                <div className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  Always on — these only fire when the platform needs you (feed health, agent stalls, D1 budget).
                </div>
              </div>
            </div>
            <Select
              value={v2?.cadence_platform ?? 'realtime'}
              options={GROUP_CADENCE_OPTIONS}
              onChange={(v) => patchV2({ cadence_platform: v as NotificationPreferencesV2['cadence_platform'] })}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Intelligence digest
                </div>
                <div className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  Toggleable per type below. New campaigns, threat actors, abuse mailbox, news watcher.
                </div>
              </div>
            </div>
            <Select
              value={v2?.cadence_intel ?? 'realtime'}
              options={GROUP_CADENCE_OPTIONS}
              onChange={(v) => patchV2({ cadence_intel: v as NotificationPreferencesV2['cadence_intel'] })}
            />
          </div>
        </div>
      </Card>

      {/* 2b. DIGEST (legacy single cadence — affects tenant brand events) */}
      <PanelHeader title="Tenant brand-event digest" subtitle="Cadence for brand-targeted events (DMARC drift, lookalikes, social impersonation)" icon={<Clock size={14} />} />
      <Card hover={false}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Frequency">
            <Select
              value={v2?.digest_mode ?? 'daily'}
              options={DIGEST_MODES}
              onChange={(v) => patchV2({ digest_mode: v as NotificationPreferencesV2['digest_mode'] })}
            />
          </Field>
          <Field label="Include severities">
            <Select
              value={v2?.digest_severity_floor ?? 'medium'}
              options={DIGEST_FLOOR_OPTIONS}
              onChange={(v) => patchV2({ digest_severity_floor: v as NotificationPreferencesV2['digest_severity_floor'] })}
            />
          </Field>
        </div>
      </Card>

      {/* 3. EVENT TOGGLES ─────────────────────────────────────────────── */}
      <PanelHeader title="Events" subtitle="Per-event firing controls — works alongside delivery floors" icon={<AlertTriangle size={14} />} />
      <Card hover={false}>
        <div className="space-y-2.5">
          {USER_TOGGLEABLE_EVENTS.map((event) => (
            <div key={event.key} className="flex items-start justify-between gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {event.label}
                </div>
                <div className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  {event.description}
                </div>
              </div>
              <ToggleSwitch
                on={!!currentPrefs?.[event.key as PrefKey]}
                onClick={() => handleToggle(event.key as keyof Preferences)}
              />
            </div>
          ))}
        </div>
      </Card>

      {/* 4. PER-BRAND SUBSCRIPTIONS ──────────────────────────────────────
          Hidden for super_admins — they cover all brands platform-wide via
          show_tenant_notifications + the admin alerts surface, so a
          per-brand watch toggle is noise (the typical super_admin has
          hundreds of "Default" rows nobody manages). Tenant users still
          see this panel because individual brand watches matter for them. */}
      {!isSuperAdmin && (
        <>
          <PanelHeader title="Subscriptions" subtitle="Override delivery floors for specific brands you watch" icon={<Building2 size={14} />} />
          <Card hover={false}>
            {subscriptions.length === 0 ? (
              <div className="text-xs py-3 text-center" style={{ color: 'var(--text-tertiary)' }}>
                No brand subscriptions yet. Add a brand to your monitored list and it auto-appears here.
              </div>
            ) : (
              <div className="space-y-1.5">
                {subscriptions.map((s) => (
                  <div key={s.brand_id}
                    className="flex items-center justify-between gap-3 py-1.5 px-2 rounded"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-base)' }}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                        {s.brand_name ?? s.brand_id}
                      </div>
                    </div>
                    <select
                      value={s.level}
                      onChange={(e) => updateSub.mutate({ brandId: s.brand_id, level: e.target.value as SubscriptionLevel })}
                      className="text-[11px] font-mono px-2 py-1 rounded"
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-base)', color: 'var(--text-primary)' }}
                    >
                      {SUBSCRIPTION_LEVELS.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => deleteSub.mutate(s.brand_id)}
                      className="p-1 rounded hover:bg-white/[0.05] transition-colors"
                      aria-label="Remove subscription"
                      title="Remove subscription"
                    >
                      <Trash2 size={14} style={{ color: 'var(--text-tertiary)' }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
              Watching = always notify · Default = use severity floors · Ignored = never notify
            </div>
          </Card>
        </>
      )}

      {/* 5. QUIET HOURS ──────────────────────────────────────────────── */}
      <PanelHeader title="Quiet hours" subtitle="Suppress push during these hours; in-app bell still updates" icon={<Globe size={14} />} />
      <Card hover={false}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Start">
            <input
              type="time"
              value={currentPrefs?.quiet_hours_start ?? ''}
              onChange={(e) => handleQuietField('quiet_hours_start', e.target.value || null)}
              className="w-full text-sm px-2 py-1.5 rounded"
              style={inputStyle}
            />
          </Field>
          <Field label="End">
            <input
              type="time"
              value={currentPrefs?.quiet_hours_end ?? ''}
              onChange={(e) => handleQuietField('quiet_hours_end', e.target.value || null)}
              className="w-full text-sm px-2 py-1.5 rounded"
              style={inputStyle}
            />
          </Field>
          <Field label="Timezone">
            <input
              type="text"
              placeholder="UTC"
              value={currentPrefs?.quiet_hours_tz ?? ''}
              onChange={(e) => handleQuietField('quiet_hours_tz', e.target.value || null)}
              className="w-full text-sm px-2 py-1.5 rounded"
              style={inputStyle}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 mt-3 cursor-pointer">
          <input
            type="checkbox"
            checked={!!currentPrefs?.critical_breakthrough}
            onChange={(e) => handleQuietField('critical_breakthrough', e.target.checked)}
            className="cursor-pointer"
          />
          <span className="text-[11px] font-mono" style={{ color: 'var(--text-secondary)' }}>
            Allow critical-severity notifications to break through quiet hours
          </span>
        </label>
      </Card>

      {/* 6. PUSH DEVICES — device-management list. The main on/off +
            test live in the EnablePushBanner at the top of the page. */}
      <PanelHeader title="Registered devices" subtitle="Browsers and phones currently subscribed for push" icon={<Smartphone size={14} />} />
      <Card hover={false}>
        {pushDevices && pushDevices.length > 0 ? (
          <div className="space-y-1.5">
            {pushDevices.map((d) => (
              <DeviceRow key={d.id} device={d} onRemove={() => handleRemoveDevice(d.id)} />
            ))}
          </div>
        ) : (
          <p className="text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
            No devices registered yet. Enable push at the top of this page on the device you want to receive notifications on.
          </p>
        )}
      </Card>

      {/* 7. SUPER_ADMIN OPT-IN ───────────────────────────────────────── */}
      {isSuperAdmin && (
        <>
          <PanelHeader title="Super admin" subtitle="See tenant-scoped notifications across the platform" icon={<Eye size={14} />} />
          <Card hover={false}>
            <label className="flex items-start justify-between gap-3 cursor-pointer">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Show tenant notifications
                </div>
                <div className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  When on, you'll receive copies of customer-tenant notifications across all orgs.
                  Useful for support; noisy by default.
                </div>
              </div>
              <ToggleSwitch
                on={(v2?.show_tenant_notifications ?? 0) === 1}
                onClick={() => patchV2({ show_tenant_notifications: v2?.show_tenant_notifications === 1 ? 0 : 1 })}
              />
            </label>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border-base)',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
};

function PanelHeader({ title, subtitle, icon }: { title: string; subtitle: string; icon?: React.ReactNode }) {
  return (
    <div className="pt-2">
      <div className="flex items-baseline gap-2.5">
        {icon && <span style={{ color: 'var(--amber)' }}>{icon}</span>}
        <h2 className="text-sm font-mono font-bold uppercase tracking-[0.18em]" style={{ color: 'var(--text-secondary)' }}>
          {title}
        </h2>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{subtitle}</span>
      </div>
      <div className="mt-1 h-px bg-gradient-to-r from-white/[0.10] via-white/[0.04] to-transparent" />
    </div>
  );
}

function ChannelRow({ icon, title, description, value, options, onChange }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="flex items-start gap-2.5 min-w-0 flex-1">
        <span className="mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
          <div className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{description}</div>
        </div>
      </div>
      <Select value={value} options={options} onChange={onChange} compact />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-mono uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Select({ value, options, onChange, compact = false }: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
  compact?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${compact ? 'text-[11px]' : 'text-sm'} font-mono px-2 py-1.5 rounded flex-shrink-0`}
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border-base)',
        color: 'var(--text-primary)',
        minWidth: compact ? 200 : '100%',
      }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function ToggleSwitch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative flex-shrink-0 transition-colors"
      style={{
        width: 36, height: 20, borderRadius: 10,
        background: on ? 'var(--amber)' : 'rgba(255,255,255,0.10)',
      }}
      role="switch"
      aria-checked={on}
    >
      <span
        className="absolute top-0.5 transition-transform"
        style={{
          left: on ? 18 : 2,
          width: 16, height: 16, borderRadius: '50%',
          background: '#0A0F1C',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }}
      />
    </button>
  );
}

function DeviceRow({ device, onRemove }: { device: PushDevice; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1.5 rounded"
      style={{ background: 'var(--bg-input)', border: '1px solid var(--border-base)' }}>
      <div className="min-w-0 flex-1">
        <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {device.device_label || device.user_agent || 'Unknown device'}
        </div>
        <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          {device.created_at && `Registered ${formatDeviceDate(device.created_at)}`}
          {device.last_used_at && ` · Last seen ${formatDeviceDate(device.last_used_at)}`}
        </div>
      </div>
      <button
        onClick={onRemove}
        className="p-1 rounded hover:bg-white/[0.05] transition-colors"
        aria-label="Remove device"
      >
        <Trash2 size={14} style={{ color: 'var(--text-tertiary)' }} />
      </button>
    </div>
  );
}

function formatDeviceDate(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    const d = new Date(value);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return value;
  }
}
