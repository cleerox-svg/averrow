import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeCycleButton } from './ThemeCycleButton';

const mocks = vi.hoisted(() => ({ useTheme: vi.fn() }));
vi.mock('@/design-system/hooks', () => ({ useTheme: mocks.useTheme }));

describe('ThemeCycleButton', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls cycle() from useTheme on click', () => {
    const cycle = vi.fn();
    mocks.useTheme.mockReturnValue({ theme: 'auto', cycle });
    render(<ThemeCycleButton />);
    fireEvent.click(screen.getByRole('button'));
    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['auto', /theme: auto.*click for dark/i],
    ['dark', /theme: dark.*click for light/i],
    ['light', /theme: light.*click for auto/i],
  ])('labels the %s state with the next step', (theme, label) => {
    mocks.useTheme.mockReturnValue({ theme, cycle: vi.fn() });
    render(<ThemeCycleButton />);
    const btn = screen.getByRole('button', { name: label });
    expect(btn).toHaveAttribute('title', btn.getAttribute('aria-label'));
  });
});
