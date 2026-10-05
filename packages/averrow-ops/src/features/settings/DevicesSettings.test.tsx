import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DevicesSettings, type DevicesInstallState, type DevicesPushAdapter, type PushDeviceRow,
} from '@averrow/shared/account';
import { ToastProvider } from '@averrow/shared/ui';
import { installDomStubs, stubViewport } from './settingsTestUtils';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEVICES: PushDeviceRow[] = [
  { id: 'd1', device_label: 'iPhone', user_agent: IPHONE_UA, created_at: '2026-09-28 12:00:00', last_used_at: '2026-10-04 08:00:00' },
  { id: 'd2', device_label: null, user_agent: MAC_UA, created_at: '2026-08-01 09:00:00', last_used_at: null },
];

const notInstalled: DevicesInstallState = { isStandalone: false, canInstall: false, isIos: false, install: vi.fn() };

function setup(over: { install?: Partial<DevicesInstallState>; push?: Partial<DevicesPushAdapter>; clear?: () => Promise<void>; turnOn?: () => void } = {}) {
  const push: DevicesPushAdapter = {
    supported: true,
    list: vi.fn().mockResolvedValue(DEVICES),
    remove: vi.fn().mockResolvedValue(undefined),
    sendTest: vi.fn().mockResolvedValue({ attempted: 2, delivered: 2 }),
    thisDeviceUserAgent: IPHONE_UA,
    ...over.push,
  };
  const install: DevicesInstallState = { ...notInstalled, install: vi.fn().mockResolvedValue('accepted'), ...over.install };
  render(
    <ToastProvider>
      <DevicesSettings
        install={install}
        push={push}
        version={{ label: 'v4.0.0', sha: 'abc1234' }}
        onClearCache={over.clear}
        onTurnOnPush={over.turnOn}
      />
    </ToastProvider>,
  );
  return { push, install, user: userEvent.setup() };
}

beforeEach(() => {
  installDomStubs();
  stubViewport(true);
});

describe('DevicesSettings — push devices', () => {
  it('lists devices with a parsed name, This device badge and dates', async () => {
    setup();
    const rows = await screen.findAllByRole('button', { name: /^Remove / });
    expect(rows).toHaveLength(2);
    expect(screen.getByText('iPhone — Safari')).toBeInTheDocument();
    expect(screen.getByText('Chrome on macOS')).toBeInTheDocument();
    // Exactly one device matches this browser's UA -> exactly one badge.
    expect(screen.getAllByText('This device')).toHaveLength(1);
    expect(screen.getByText(/No push sent yet/)).toBeInTheDocument();
  });

  it('does not guess "This device" when two registered devices share a user agent', async () => {
    setup({ push: { list: vi.fn().mockResolvedValue([DEVICES[0]!, { ...DEVICES[0]!, id: 'd3' }]) } });
    await screen.findAllByRole('button', { name: /^Remove / });
    expect(screen.queryByText('This device')).toBeNull();
  });

  it('removes a device only after confirming', async () => {
    const { push, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Chrome on macOS' }));

    const dialog = await screen.findByRole('dialog', { name: 'Stop sending notifications to this device?' });
    expect(push.remove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove device' }));

    await waitFor(() => expect(push.remove).toHaveBeenCalledWith('d2'));
    expect(await screen.findByText('Device removed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Chrome on macOS' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Remove iPhone — Safari' })).toBeInTheDocument();
  });

  it('cancelling the confirm leaves the device in place', async () => {
    const { push, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Remove iPhone — Safari' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/This is the device you're using now/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(push.remove).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove iPhone — Safari' })).toBeInTheDocument();
  });

  it('keeps the dialog open with an error when removal fails', async () => {
    const { user } = setup({ push: { remove: vi.fn().mockRejectedValue(new Error("Couldn't remove it. Try again.")) } });
    await user.click(await screen.findByRole('button', { name: 'Remove Chrome on macOS' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove device' }));
    expect(await within(dialog).findByText("Couldn't remove it. Try again.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Chrome on macOS', hidden: true })).toBeInTheDocument();
  });

  it('sends a test and reports the outcome', async () => {
    const { push, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Send test' }));
    expect(push.sendTest).toHaveBeenCalled();
    expect(await screen.findByText('Sent. It should arrive in a few seconds.')).toBeInTheDocument();
  });

  it('says so when nothing was delivered', async () => {
    const { user } = setup({ push: { sendTest: vi.fn().mockResolvedValue({ attempted: 2, delivered: 0 }) } });
    await user.click(await screen.findByRole('button', { name: 'Send test' }));
    expect(await screen.findByText(/Couldn't deliver the test/)).toBeInTheDocument();
  });

  it('shows an empty state with a Turn on push action', async () => {
    const turnOn = vi.fn();
    const { user } = setup({ push: { list: vi.fn().mockResolvedValue([]) }, turnOn });
    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Turn on push' }));
    expect(turnOn).toHaveBeenCalled();
  });

  it('shows an error state and retries', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(DEVICES);
    const { user } = setup({ push: { list } });
    expect(await screen.findByText("Couldn't load your devices")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: 'Remove iPhone — Safari' })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('explains unsupported browsers and the iOS install requirement', async () => {
    setup({ push: { supported: false } });
    expect(await screen.findByText(/can't receive push notifications/)).toBeInTheDocument();
  });

  it('asks iOS users to install first', async () => {
    setup({ push: { needsInstall: true } });
    expect(await screen.findByText('Install the app first')).toBeInTheDocument();
  });
});

describe('DevicesSettings — install card', () => {
  it('collapses to an Installed row when running as the app', async () => {
    setup({ install: { isStandalone: true } });
    expect(await screen.findByText('Averrow is installed')).toBeInTheDocument();
    expect(screen.queryByText('Install Averrow')).toBeNull();
  });

  it('offers the native prompt when the browser can install', async () => {
    const { install, user } = setup({ install: { canInstall: true } });
    await user.click(screen.getByRole('button', { name: 'Install app' }));
    expect(install.install).toHaveBeenCalled();
    expect(await screen.findByText('Averrow is installing.')).toBeInTheDocument();
  });

  it('opens the numbered Add to Home Screen steps on iOS', async () => {
    const { user } = setup({ install: { isIos: true } });
    await user.click(screen.getByRole('button', { name: 'Add to Home Screen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Averrow to your Home Screen' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(4);
  });

  it('falls back to manual steps when no prompt is available', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'How to install' }));
    expect(await screen.findByRole('dialog', { name: 'Install Averrow' })).toBeInTheDocument();
  });
});

describe('DevicesSettings — about', () => {
  it('shows the version and clears the cache only after confirming', async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const { user } = setup({ clear });
    expect(await screen.findByText('v4.0.0 · abc1234')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Clear local cache/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Clear local cache?' });
    expect(clear).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Clear cache' }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });

  it('omits the clear-cache row when the host does not provide it', async () => {
    setup();
    await screen.findByText('v4.0.0 · abc1234');
    expect(screen.queryByText('Clear local cache')).toBeNull();
  });
});
