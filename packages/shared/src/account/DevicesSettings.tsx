// Devices & App page (ACCOUNT_DESIGN_SPEC §5.4) — install the app, manage the
// devices that receive push, and app/version info.
//
// Host-agnostic: the host injects the install state, the push-device adapter and
// the version; this file imports no router, api module or PWA lib. Mount it
// inside a <ToastProvider>.
//
// Not included (no backing setting exists yet): the "Sign in on this device"
// biometric auto-prompt toggle and the service-worker "Check for updates" row.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { PageState } from '../ui/PageState';
import { ConfirmDialog, Dialog, useToast } from '../ui/overlays';
import {
  CopyField, IconTile, InlineBanner, SettingsGroup, SettingsRow, useMediaQuery,
} from '../ui/settings';
import {
  DownloadIcon, InfoCircleIcon, MonitorIcon, RefreshIcon, SendIcon, ShareIcon, SmartphoneIcon,
} from './section-icons';
import { formatRelativeTime, formatShortDate } from './time-format';
import { parseUserAgent } from './security/userAgent';

// ── contracts ───────────────────────────────────────────────

export interface PushDeviceRow {
  id: string;
  device_label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface DevicesInstallState {
  /** Running as an installed app. */
  isStandalone: boolean;
  /** The browser offered a native install prompt. */
  canInstall: boolean;
  isIos: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export interface DevicesPushAdapter {
  /** This browser can receive web push. */
  supported: boolean;
  /** iOS: push only works once the app is installed to the Home Screen. */
  needsInstall?: boolean;
  list: () => Promise<PushDeviceRow[]>;
  remove: (id: string) => Promise<void>;
  /** Sends to ALL of the user's registered devices (the API cannot target one). */
  sendTest: () => Promise<{ attempted: number; delivered: number }>;
  /**
   * User-agent of THIS browser, supplied only when it holds a push subscription.
   * Used to badge "This device": the badge appears only when exactly one
   * registered device matches, so it is never a guess between look-alikes.
   */
  thisDeviceUserAgent?: string | null;
}

export interface DevicesSettingsProps {
  install: DevicesInstallState;
  push: DevicesPushAdapter;
  /** e.g. `{ label: 'v4.0.0', sha: 'a1b2c3d' }`. */
  version: { label: string; sha?: string };
  /** Clear this device's cached app files. The host reloads afterwards. Omit to hide the row. */
  onClearCache?: () => Promise<void>;
  /** Empty-state action: go to notification settings to turn push on. */
  onTurnOnPush?: () => void;
  /** Steps for the iOS "Add to Home Screen" sheet. */
  iosSteps?: readonly string[];
}

const DEFAULT_IOS_STEPS: readonly string[] = [
  'Tap the Share button at the bottom of Safari (the square with the up arrow).',
  'Scroll down and pick Add to Home Screen.',
  'Tap Add in the top-right. Averrow will install.',
  'Open Averrow from your Home Screen and come back here to turn on alerts.',
];

const MANUAL_STEPS: ReadonlyArray<{ where: string; how: ReactNode }> = [
  { where: 'Chrome or Edge on a computer', how: 'Click the install icon in the address bar, or open the menu and choose Install Averrow.' },
  { where: 'Chrome on Android', how: 'Open the menu and choose Install app or Add to Home screen.' },
  { where: 'Firefox on Android', how: 'Open the menu and choose Install.' },
  { where: 'Safari on iPhone or iPad', how: 'Tap Share, then Add to Home Screen.' },
];

// ── helpers ─────────────────────────────────────────────────

function deviceName(d: PushDeviceRow): string {
  const ua = parseUserAgent(d.user_agent);
  const given = d.device_label?.trim();
  if (!given) return ua.label === 'Unknown device' ? 'Unnamed device' : ua.label;
  return ua.browser && ua.browser !== given ? `${given} — ${ua.browser}` : given;
}

function deviceDescription(d: PushDeviceRow): string {
  const registered = formatShortDate(d.created_at);
  const last = d.last_used_at ? `Last push ${formatRelativeTime(d.last_used_at)}` : 'No push sent yet';
  return [registered ? `Registered ${registered}` : null, last].filter(Boolean).join(' · ');
}

function StepList({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {steps.map((s, i) => (
        <li key={s} className="flex items-start gap-3 text-[15px] leading-[1.5] text-[var(--text-secondary)] min-[768px]:text-[14px]">
          <span
            aria-hidden="true"
            className="mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-[var(--violet-text)]"
            style={{
              background: 'color-mix(in srgb, var(--violet) var(--tile-tint-pct, 16%), transparent)',
              border: '1px solid color-mix(in srgb, var(--violet) 30%, transparent)',
            }}
          >
            {i + 1}
          </span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

const touchBtn = 'max-[1023px]:h-11 max-[1023px]:min-h-11 max-[1023px]:px-4 max-[1023px]:text-[14px]';

// ── page ────────────────────────────────────────────────────

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; devices: PushDeviceRow[] };

export function DevicesSettings({ install, push, version, onClearCache, onTurnOnPush, iosSteps = DEFAULT_IOS_STEPS }: DevicesSettingsProps) {
  const toast = useToast();
  const wide = useMediaQuery('(min-width: 640px)', true);

  // ── install ──
  const [installSheet, setInstallSheet] = useState<'ios' | 'manual' | null>(null);

  const startInstall = async () => {
    if (install.canInstall) {
      const outcome = await install.install();
      if (outcome === 'unavailable') setInstallSheet('manual');
      else if (outcome === 'accepted') toast.success('Averrow is installing.');
      return;
    }
    setInstallSheet(install.isIos ? 'ios' : 'manual');
  };

  const installLabel = install.canInstall ? 'Install app' : install.isIos ? 'Add to Home Screen' : 'How to install';

  // ── push devices ──
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const pushRef = useRef(push);
  pushRef.current = push;

  const load = useCallback(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    pushRef.current.list().then(
      (devices) => { if (!cancelled) setList({ status: 'ready', devices }); },
      () => { if (!cancelled) setList({ status: 'error' }); },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);

  const devices = list.status === 'ready' ? list.devices : [];

  const thisDeviceId = useMemo(() => {
    const ua = push.thisDeviceUserAgent;
    if (!ua) return null;
    const matches = devices.filter((d) => d.user_agent === ua);
    return matches.length === 1 ? matches[0]!.id : null;
  }, [devices, push.thisDeviceUserAgent]);

  const [removing, setRemoving] = useState<PushDeviceRow | null>(null);
  const [testing, setTesting] = useState(false);

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await push.sendTest();
      if (r.attempted === 0) toast.error('No devices are registered for push yet.');
      else if (r.delivered === 0) toast.error("Couldn't deliver the test. Check that notifications are allowed on your device.");
      else toast.success('Sent. It should arrive in a few seconds.');
    } catch {
      toast.error("Couldn't send the test. Check your connection and try again.");
    } finally {
      setTesting(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    await push.remove(removing.id);
    setList((s) => (s.status === 'ready' ? { status: 'ready', devices: s.devices.filter((d) => d.id !== removing.id) } : s));
    toast.success('Device removed.');
  };

  // ── about ──
  const [clearOpen, setClearOpen] = useState(false);
  const versionText = version.sha ? `${version.label} · ${version.sha}` : version.label;

  return (
    <div>
      {/* 1. Install */}
      {install.isStandalone ? (
        <SettingsGroup aria-label="App">
          <SettingsRow
            icon={<SmartphoneIcon />}
            tone="violet"
            title="Averrow is installed"
            description="You're using the app."
            trailing={<Badge status="active" label="Installed" size="md" font="sans" />}
          />
        </SettingsGroup>
      ) : (
        <section aria-labelledby="devices-install-title" className="mb-6 min-[1024px]:mb-7">
          <Card variant="active" accent="var(--violet)" padding={wide ? 'lg' : 20} className="ds-card-vivid">
            <div className="flex flex-col gap-4 min-[640px]:flex-row min-[640px]:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-4">
                <IconTile tone="violet" size={48}><SmartphoneIcon /></IconTile>
                <div className="min-w-0">
                  <h2 id="devices-install-title" className="m-0 text-[18px] font-bold leading-[1.3] text-[var(--text-primary)]">Install Averrow</h2>
                  <p className="m-0 mt-1 text-[14px] leading-[1.5] text-[var(--text-secondary)]">
                    Faster launch, full-screen, and reliable notifications.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant={install.canInstall || install.isIos ? 'primary' : 'secondary'}
                size="lg"
                className="min-[640px]:shrink-0"
                onClick={() => { void startInstall(); }}
              >
                {install.canInstall ? <DownloadIcon width={18} height={18} /> : install.isIos ? <ShareIcon width={18} height={18} /> : null}
                {installLabel}
              </Button>
            </div>
          </Card>
        </section>
      )}

      {/* 2. Push devices */}
      {!push.supported && (
        <InlineBanner className="mb-4" tone="info">
          This browser can&apos;t receive push notifications. Use the installed app or a supported browser on your phone.
        </InlineBanner>
      )}
      {push.supported && push.needsInstall && (
        <InlineBanner className="mb-4" tone="info" title="Install the app first">
          On iPhone and iPad, notifications work once Averrow is on your Home Screen.
        </InlineBanner>
      )}

      <SettingsGroup
        title="Push devices"
        headerAction={devices.length > 0 ? (
          <Button type="button" variant="secondary" size="sm" className="ds-hbtn" onClick={() => { void sendTest(); }} disabled={testing} aria-busy={testing || undefined}>
            <SendIcon width={14} height={14} />
            {testing ? 'Sending…' : 'Send test'}
          </Button>
        ) : undefined}
        footer="Notifications go to every device listed here."
      >
        {list.status === 'loading' && (
          <PageState kind="loading" layout="card" title="Loading your devices…" className="rounded-none border-0 bg-transparent" />
        )}
        {list.status === 'error' && (
          <PageState
            kind="error" layout="page" compact
            title="Couldn't load your devices"
            description="Check your connection and try again."
            onRetry={() => { load(); }}
          />
        )}
        {list.status === 'ready' && devices.length === 0 && (
          <PageState
            kind="empty" layout="page" compact
            title="No devices yet"
            description="Turn on push to get alerts on this device."
            action={onTurnOnPush ? { label: 'Turn on push', onClick: onTurnOnPush } : undefined}
          />
        )}
        {devices.map((d) => {
          const ua = parseUserAgent(d.user_agent);
          const name = deviceName(d);
          return (
            <SettingsRow
              key={d.id}
              dense
              icon={ua.device === 'phone' || ua.device === 'tablet' ? <SmartphoneIcon /> : <MonitorIcon />}
              tone="violet"
              title={(
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{name}</span>
                  {d.id === thisDeviceId && <Badge status="active" label="This device" size="md" font="sans" />}
                </span>
              )}
              description={deviceDescription(d)}
              trailing={(
                <Button type="button" variant="ghost" size="sm" className={touchBtn} aria-label={`Remove ${name}`} onClick={() => setRemoving(d)}>
                  Remove
                </Button>
              )}
            />
          );
        })}
      </SettingsGroup>

      {/* 3. About */}
      <SettingsGroup title="About">
        <SettingsRow
          icon={<InfoCircleIcon />}
          title="App version"
          description="Include this if you contact support."
          stackTrailing
          trailing={<CopyField value={versionText} label="version" onCopied={() => toast.success('Version copied.')} />}
        />
        {onClearCache && (
          <SettingsRow
            variant="button"
            icon={<RefreshIcon />}
            title="Clear local cache"
            description="Fixes stale or broken pages. You stay signed in."
            onClick={() => setClearOpen(true)}
          />
        )}
      </SettingsGroup>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        title="Stop sending notifications to this device?"
        description={removing ? `${deviceName(removing)} will stop receiving Averrow notifications.` : undefined}
        consequence={removing && removing.id === thisDeviceId
          ? "This is the device you're using now. You can turn push back on from Notifications."
          : 'You can turn push back on from that device at any time.'}
        confirmLabel="Remove device"
        onConfirm={confirmRemove}
      />

      {onClearCache && (
        <ConfirmDialog
          open={clearOpen}
          onOpenChange={setClearOpen}
          tone="primary"
          title="Clear local cache?"
          description="Removes app files saved on this device so the latest version loads."
          consequence="You'll stay signed in. Averrow will reload."
          confirmLabel="Clear cache"
          onConfirm={onClearCache}
        />
      )}

      <Dialog
        open={installSheet === 'ios'}
        onOpenChange={(o) => { if (!o) setInstallSheet(null); }}
        title="Add Averrow to your Home Screen"
        description="Safari doesn't offer a one-tap install, so it takes a few steps."
        icon={<ShareIcon />}
        footer={<Button type="button" variant="secondary" size="lg" onClick={() => setInstallSheet(null)}>Got it</Button>}
      >
        <StepList steps={iosSteps} />
      </Dialog>

      <Dialog
        open={installSheet === 'manual'}
        onOpenChange={(o) => { if (!o) setInstallSheet(null); }}
        title="Install Averrow"
        description="Your browser didn't offer an install prompt this time. Install it from the browser instead."
        icon={<DownloadIcon />}
        footer={<Button type="button" variant="secondary" size="lg" onClick={() => setInstallSheet(null)}>Got it</Button>}
      >
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {MANUAL_STEPS.map((s) => (
            <li key={s.where} className="text-[15px] leading-[1.5] text-[var(--text-secondary)] min-[768px]:text-[14px]">
              <strong className="font-semibold text-[var(--text-primary)]">{s.where}.</strong> {s.how}
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
