// Channels tab (ACCOUNT_DESIGN_SPEC §5.3): push, email, in-app, timing, and
// the super_admin "customer notifications" opt-in.

import { useState, type ReactElement } from 'react';
import {
  Button, InlineBanner, Select, SettingsGroup, SettingsRow, Switch,
} from '../../ui';
import {
  BellIcon, EyeIcon, LayersIcon, MailIcon, PhoneIcon, SendIcon, ShieldAlertIcon,
} from './icons';
import { CADENCE_OPTIONS, FLOOR_OPTIONS, FLOOR_OPTIONS_WITH_OFF } from './helpers';
import { SavedMark, type Autosave } from './useAutosave';
import type {
  GroupCadence, NotificationSettingsProps, SeverityFloor, SeverityFloorWithOff,
} from './types';

export interface SectionCommon {
  autosave: Autosave;
  /** False while offline: every write control is disabled. */
  online: boolean;
}

type Props = SectionCommon & Pick<
  NotificationSettingsProps,
  'prefs' | 'push' | 'email' | 'role' | 'devicesHref' | 'renderLink'
  | 'onUpdatePrefs' | 'onEnablePush' | 'onDisablePush' | 'onSendTestPush'
> & { isStaff: boolean; isSuperAdmin: boolean };

const PUSH_DENIED = "Notifications are blocked in this browser. Allow them in your browser's site settings, then come back.";

export function ChannelsSection({
  prefs, push, email, devicesHref, renderLink, isStaff, isSuperAdmin, autosave, online,
  onUpdatePrefs, onEnablePush, onDisablePush, onSendTestPush,
}: Props): ReactElement {
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const denied = push.permission === 'denied';
  const unsupported = !push.supported;
  const blocked = denied || unsupported;
  const pushBusy = !!push.busy || autosave.saving('push-toggle');

  const togglePush = (next: boolean) => {
    setTestResult(null);
    void autosave.run(
      'push-toggle',
      next ? onEnablePush : onDisablePush,
      (err) => (err instanceof Error && err.message ? err.message : `Couldn't ${next ? 'turn on' : 'turn off'} push. Try again.`),
    );
  };

  const sendTest = async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      const r = await onSendTestPush();
      setTestResult(r.delivered > 0
        ? { ok: true, text: 'Sent. It should arrive in a few seconds.' }
        : { ok: false, text: "The test didn't reach a device. Check that push is on for this device." });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error && err.message ? err.message : "Couldn't send the test. Try again." });
    } finally {
      setTestBusy(false);
    }
  };

  const floorRow = (opts: {
    key: string; icon: ReactElement; title: string; description: string;
    value: SeverityFloorWithOff; withOff: boolean;
    field: 'push_severity_floor' | 'email_severity_floor' | 'inapp_severity_floor';
  }) => (
    <SettingsRow
      key={opts.key}
      icon={opts.icon}
      tone="blue"
      title={opts.title}
      description={opts.description}
      stackTrailing
      loading={autosave.saving(opts.key)}
      error={autosave.error(opts.key)}
      trailing={({ labelId, disabled }) => (
        <>
          <SavedMark show={autosave.entry(opts.key)?.status === 'saved'} />
          <Select
            variant="inline"
            aria-labelledby={labelId}
            value={opts.value}
            disabled={disabled || !online}
            onChange={(e) => {
              const value = e.target.value as SeverityFloorWithOff;
              void autosave.run(opts.key, () => onUpdatePrefs({ [opts.field]: value } as Partial<typeof prefs>));
            }}
          >
            {(opts.withOff ? FLOOR_OPTIONS_WITH_OFF : FLOOR_OPTIONS).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </>
      )}
    />
  );

  const cadenceRow = (opts: {
    key: string; title: string; description: string; value: GroupCadence;
    field: 'cadence_platform' | 'cadence_intel'; icon: ReactElement;
  }) => (
    <SettingsRow
      key={opts.key}
      icon={opts.icon}
      tone="blue"
      title={opts.title}
      description={opts.description}
      stackTrailing
      loading={autosave.saving(opts.key)}
      error={autosave.error(opts.key)}
      trailing={({ labelId, disabled }) => (
        <>
          <SavedMark show={autosave.entry(opts.key)?.status === 'saved'} />
          <Select
            variant="inline"
            aria-labelledby={labelId}
            value={opts.value}
            disabled={disabled || !online}
            onChange={(e) => {
              const value = e.target.value as GroupCadence;
              void autosave.run(opts.key, () => onUpdatePrefs({ [opts.field]: value } as Partial<typeof prefs>));
            }}
          >
            {CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </>
      )}
    />
  );

  const pushDescription = push.subscribed
    ? 'On for this device.'
    : 'Get alerts on this device, even when Averrow is closed.';
  const pushReason = unsupported
    ? (push.needsInstall
        ? 'Add Averrow to your Home Screen to turn on push.'
        : "This browser can't receive push notifications.")
    : denied ? 'Allow notifications in your browser to turn this on.' : undefined;

  return (
    <div className="space-y-6">
      {denied && (
        <InlineBanner tone="warn" title="Push is blocked in this browser">
          {PUSH_DENIED}
        </InlineBanner>
      )}
      {unsupported && (
        <InlineBanner tone="info" title="Push isn't available here">
          {push.needsInstall
            ? 'On iPhone and iPad, add Averrow to your Home Screen first (Share, then Add to Home Screen), then open it from there.'
            : "This browser can't receive push notifications. Email and the in-app bell still work."}
        </InlineBanner>
      )}

      <SettingsGroup title="Push" footer="Push alerts go to the browser or app you turn this on in.">
        <SettingsRow
          variant="toggle"
          icon={<PhoneIcon />}
          tone="blue"
          title="Push notifications"
          description={pushDescription}
          disabled={blocked && !push.subscribed}
          disabledReason={pushReason}
          loading={pushBusy}
          error={autosave.error('push-toggle')}
          trailing={({ labelId, descriptionId, disabled }) => (
            <>
              <SavedMark show={autosave.entry('push-toggle')?.status === 'saved'} />
              <Switch
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                checked={push.subscribed}
                disabled={disabled || !online}
                onCheckedChange={togglePush}
              />
            </>
          )}
        />
        {floorRow({
          key: 'push-floor', icon: <ShieldAlertIcon />, title: 'Only notify me about…',
          description: 'Push alerts below this level are skipped.',
          value: prefs.push_severity_floor, withOff: true, field: 'push_severity_floor',
        })}
        <SettingsRow
          icon={<SendIcon />}
          tone="blue"
          title="Send a test notification"
          description={testResult?.ok ? <span role="status">{testResult.text}</span> : 'Check that alerts reach this device.'}
          disabled={!push.subscribed}
          disabledReason="Turn on push to send a test."
          error={testResult && !testResult.ok ? testResult.text : undefined}
          trailing={
            <Button variant="secondary" size="sm" disabled={!push.subscribed || testBusy || !online} onClick={() => void sendTest()}>
              {testBusy ? 'Sending…' : 'Send test'}
            </Button>
          }
        />
        {devicesHref && (
          <SettingsRow
            variant="link"
            href={devicesHref}
            renderLink={renderLink}
            icon={<PhoneIcon />}
            tone="violet"
            title="Devices that get push"
            description="See and remove the devices registered for push."
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Email">
        {floorRow({
          key: 'email-floor', icon: <MailIcon />, title: 'Only notify me about…',
          description: 'Email alerts below this level are skipped.',
          value: prefs.email_severity_floor, withOff: true, field: 'email_severity_floor',
        })}
        <SettingsRow
          icon={<MailIcon />}
          tone="neutral"
          title="Email address"
          description="Alerts go to the address on your account."
          trailing={<span className="max-w-[220px] truncate text-[14px] text-[var(--text-secondary)]" title={email ?? undefined}>{email ?? 'Not set'}</span>}
        />
      </SettingsGroup>

      <SettingsGroup title="In app">
        {floorRow({
          key: 'inapp-floor', icon: <BellIcon />, title: 'Show in the bell',
          description: 'Alerts at or above this level appear in your notifications.',
          value: prefs.inapp_severity_floor as SeverityFloor, withOff: false, field: 'inapp_severity_floor',
        })}
      </SettingsGroup>

      <SettingsGroup
        title="Timing"
        footer="Choose a summary to get a roundup instead of a message for every alert."
      >
        {isStaff && cadenceRow({
          key: 'cadence-platform', icon: <ShieldAlertIcon />, title: 'Platform alerts',
          description: 'When feeds, agents or the platform need attention.',
          value: prefs.cadence_platform, field: 'cadence_platform',
        })}
        {cadenceRow({
          key: 'cadence-intel', icon: <LayersIcon />, title: 'Intelligence',
          description: 'New campaigns, threat actors and news we find.',
          value: prefs.cadence_intel, field: 'cadence_intel',
        })}
      </SettingsGroup>

      {isSuperAdmin && (
        <SettingsGroup title="Staff view">
          <SettingsRow
            variant="toggle"
            icon={<EyeIcon />}
            tone="amber"
            title="Show customer notifications"
            description="Also get a copy of what customers are sent, across every organization. Useful for support, but noisy."
            loading={autosave.saving('show-customer')}
            error={autosave.error('show-customer')}
            trailing={({ labelId, descriptionId, disabled }) => (
              <>
                <SavedMark show={autosave.entry('show-customer')?.status === 'saved'} />
                <Switch
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  checked={prefs.show_tenant_notifications === 1}
                  disabled={disabled || !online}
                  onCheckedChange={(next) => {
                    void autosave.run('show-customer', () => onUpdatePrefs({ show_tenant_notifications: next ? 1 : 0 }));
                  }}
                />
              </>
            )}
          />
        </SettingsGroup>
      )}
    </div>
  );
}

