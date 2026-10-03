// PWA: OverviewV4 mounts <InstallAppBanner/> (PR #1739 moved it here from the
// deleted HomeUnified). The real banner is used; only the install-prompt hook
// is stubbed, because the banner renders nothing in jsdom unless the browser
// would offer install (canInstall) or is iOS.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { OverviewV4 } from './OverviewV4';

const mocks = vi.hoisted(() => ({ useInstallPrompt: vi.fn() }));

vi.mock('@/hooks/useInstallPrompt', () => ({ useInstallPrompt: mocks.useInstallPrompt }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue({ success: true, data: [] }) } }));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn(() => ({ user: { name: 'Ada Lovelace' } })) }));
vi.mock('react-countup', () => ({
  default: ({ end }: { end: number }) => <span>{end}</span>,
}));
vi.mock('@/features/home/sections/StatusRow', () => ({ StatusRow: () => null }));
vi.mock('@/features/home/sections/StatGrid', () => ({ StatGrid: () => null }));
vi.mock('@/features/home/sections/ThreatPulse', () => ({ ThreatPulse: () => null }));
vi.mock('@/features/home/sections/DailyBriefing', () => ({ DailyBriefing: () => null }));
vi.mock('@/features/home/sections/LatestIntel', () => ({ LatestIntel: () => null }));
vi.mock('@/features/home/sections/IntelHotlist', () => ({ IntelHotlist: () => null }));
vi.mock('@/features/home/sections/LiveActivity', () => ({ LiveActivity: () => null }));
vi.mock('@/features/home/sections/BrandMovers', () => ({ BrandMovers: () => null }));
vi.mock('@/features/home/sections/ModuleHub', () => ({ ModuleHub: () => null }));
vi.mock('@/features/home/sections/ProviderMovers', () => ({ ProviderMovers: () => null }));

const BANNER_TEXT = /Install Averrow as an app/i;

function promptState(overrides: Record<string, unknown> = {}) {
  mocks.useInstallPrompt.mockReturnValue({
    isStandalone: false,
    canInstall: true,
    isIos: false,
    install: vi.fn(),
    ...overrides,
  });
}

describe('OverviewV4 — InstallAppBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows the banner when not standalone and not dismissed', async () => {
    promptState();
    renderWithProviders(<OverviewV4 />);
    expect(await screen.findByText(BANNER_TEXT)).toBeInTheDocument();
  });

  it('hides the banner when averrow.install.dismissed is "1"', async () => {
    localStorage.setItem('averrow.install.dismissed', '1');
    promptState();
    renderWithProviders(<OverviewV4 />);
    // hero proves the page rendered; banner must be absent after the effect runs
    expect(await screen.findByText('COMMAND CENTER')).toBeInTheDocument();
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument();
  });

  it('hides the banner when running standalone', async () => {
    promptState({ isStandalone: true });
    renderWithProviders(<OverviewV4 />);
    expect(await screen.findByText('COMMAND CENTER')).toBeInTheDocument();
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument();
  });
});
