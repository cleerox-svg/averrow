// PWA: the ops Profile page renders <InstallAppCard/> after the shared
// ProfilePage (PR #1739). ProfilePage is stubbed (heavy, owned by
// @averrow/shared); InstallAppCard is real, with only its hook stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { Profile } from './Profile';

const mocks = vi.hoisted(() => ({ useInstallPrompt: vi.fn(), useAuth: vi.fn() }));

vi.mock('@averrow/shared/profile', () => ({
  ProfilePage: () => <div data-testid="shared-profile-page">SHARED PROFILE</div>,
}));
vi.mock('@/hooks/useInstallPrompt', () => ({ useInstallPrompt: mocks.useInstallPrompt }));
vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/passkeys', () => ({
  isPasskeySupported: () => false,
  registerPasskey: vi.fn(),
  listPasskeys: vi.fn(),
  removePasskey: vi.fn(),
}));

const CARD_TEXT = /Install Averrow as an app/i;

describe('Profile — InstallAppCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({
      user: { id: 'u1', email: 'a@averrow.com', name: 'Ada', role: 'admin', passkey_count: 1, organization: null },
      refreshUser: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('renders the install card after the shared ProfilePage', () => {
    mocks.useInstallPrompt.mockReturnValue({ isStandalone: false, canInstall: true, isIos: false, install: vi.fn() });
    renderWithProviders(<Profile />);

    const page = screen.getByTestId('shared-profile-page');
    const card = screen.getByText(CARD_TEXT);
    expect(card).toBeInTheDocument();
    // DOM order: ProfilePage first, card after
    expect(page.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the install card when already installed (standalone)', () => {
    mocks.useInstallPrompt.mockReturnValue({ isStandalone: true, canInstall: false, isIos: false, install: vi.fn() });
    renderWithProviders(<Profile />);
    expect(screen.getByTestId('shared-profile-page')).toBeInTheDocument();
    expect(screen.queryByText(CARD_TEXT)).not.toBeInTheDocument();
  });
});
