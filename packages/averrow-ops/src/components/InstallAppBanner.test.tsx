import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InstallAppBanner } from './InstallAppBanner';

const mocks = vi.hoisted(() => ({ useInstallPrompt: vi.fn() }));
vi.mock('@/hooks/useInstallPrompt', () => ({ useInstallPrompt: mocks.useInstallPrompt }));

const state = (o: Partial<{ isStandalone: boolean; canInstall: boolean; isIos: boolean }>) => ({
  isStandalone: false, canInstall: false, isIos: false, install: vi.fn(), ...o,
});

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe('InstallAppBanner', () => {
  it('renders nothing (no gutter wrapper) when hidden', () => {
    mocks.useInstallPrompt.mockReturnValue(state({ isStandalone: true }));
    const { container } = render(<InstallAppBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels its section by the heading and sits in the gutter wrapper', () => {
    mocks.useInstallPrompt.mockReturnValue(state({ canInstall: true }));
    const { container } = render(<InstallAppBanner />);
    expect(container.querySelector('.install-gutter > section')).toBe(
      screen.getByRole('region', { name: /install averrow as an app/i }),
    );
  });

  it('iOS: "Show me how" toggles the steps disclosure', () => {
    mocks.useInstallPrompt.mockReturnValue(state({ isIos: true }));
    const { container } = render(<InstallAppBanner />);
    expect(container.querySelector('.install-steps-wrap')).toHaveAttribute('data-open', 'false');
    const btn = screen.getByRole('button', { name: /show me how/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(container.querySelector('.install-steps-wrap')).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('button', { name: /hide steps/i })).toHaveAttribute('aria-expanded', 'true');
  });
});
