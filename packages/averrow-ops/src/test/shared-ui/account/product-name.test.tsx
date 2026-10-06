import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import {
  ProductNameProvider, SecuritySettings, DevicesSettings,
  type DevicesSettingsProps,
} from '@averrow/shared/account';
import { ToastProvider } from '@averrow/shared/ui';

const securityProps = {
  api: {
    get: vi.fn().mockResolvedValue({ success: true, data: { sessions: [] } }),
    post: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
  },
  passkeys: {
    isSupported: () => false,
    list: vi.fn().mockResolvedValue([]),
    register: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  onSignedOut: vi.fn(),
};

const devicesProps: DevicesSettingsProps = {
  install: { isStandalone: false, canInstall: false, isIos: true, install: vi.fn().mockResolvedValue('unavailable') },
  push: {
    supported: true,
    needsInstall: true,
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    sendTest: vi.fn().mockResolvedValue({ attempted: 0, delivered: 0 }),
  },
  version: { label: 'v1.0.0' },
};

const wrap = (name: string | null, ui: ReactNode) => (
  <ToastProvider>{name === null ? ui : <ProductNameProvider name={name}>{ui}</ProductNameProvider>}</ToastProvider>
);

describe('product name', () => {
  it('SecuritySettings defaults to Averrow', async () => {
    const { container } = render(wrap(null, <SecuritySettings {...securityProps} />));
    await waitFor(() => expect(container.textContent).toContain('Averrow never stores your Google password'));
    expect(container.textContent).toContain('Open Averrow in a browser');
  });

  it('SecuritySettings shows FarmTrack and no Averrow under a provider', async () => {
    const { container } = render(wrap('FarmTrack', <SecuritySettings {...securityProps} />));
    await waitFor(() => expect(container.textContent).toContain('FarmTrack never stores your Google password'));
    expect(container.textContent).toContain('Open FarmTrack in a browser');
    expect(container.textContent).not.toContain('Averrow');
  });

  it('DevicesSettings defaults to Averrow, including the install sheet', async () => {
    const { container } = render(wrap(null, <DevicesSettings {...devicesProps} />));
    expect(screen.getByRole('heading', { name: 'Install Averrow' })).toBeInTheDocument();
    expect(container.textContent).toContain('once Averrow is on your Home Screen');
    await userEvent.click(screen.getByRole('button', { name: /Add to Home Screen/ }));
    expect(await screen.findByText('Add Averrow to your Home Screen')).toBeInTheDocument();
    expect(document.body.textContent).toContain('Open Averrow from your Home Screen');
  });

  it('DevicesSettings shows FarmTrack and no Averrow, including the install sheet', async () => {
    const { container } = render(wrap('FarmTrack', <DevicesSettings {...devicesProps} />));
    expect(screen.getByRole('heading', { name: 'Install FarmTrack' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Add to Home Screen/ }));
    expect(await screen.findByText('Add FarmTrack to your Home Screen')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Averrow');
    expect(document.body.textContent).not.toContain('Averrow');
  });
});
