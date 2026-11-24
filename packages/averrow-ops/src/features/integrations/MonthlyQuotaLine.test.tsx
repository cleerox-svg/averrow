import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MonthlyQuotaLine } from './integrationShared';

const now = new Date('2026-11-24T06:00:00Z');

describe('MonthlyQuotaLine', () => {
  it('shows usage against the free cap', () => {
    render(<MonthlyQuotaLine quota={{ used: 12, cap: 100 }} now={now} />);
    expect(screen.getByText('12 / 100')).toBeInTheDocument();
    expect(screen.getByText(/free submissions/)).toBeInTheDocument();
    expect(screen.queryByText(/cap reached|left/)).toBeNull();
  });

  it('from 80% says how many are left and colours the count amber', () => {
    render(<MonthlyQuotaLine quota={{ used: 85, cap: 100 }} now={now} />);
    expect(screen.getByText(/15 left/)).toBeInTheDocument();
    expect(screen.getByText('85 / 100').style.color).toBe('var(--sev-medium-text)');
  });

  it('at the cap says takedowns wait until the next UTC month', () => {
    render(<MonthlyQuotaLine quota={{ used: 100, cap: 100 }} now={now} />);
    expect(screen.getByText(/cap reached, takedowns wait until 1 Dec \(UTC\)/)).toBeInTheDocument();
    expect(screen.getByText('100 / 100').style.color).toBe('var(--sev-critical-text)');
    expect(screen.queryByText(/abuse email/)).toBeNull();
  });

  it('explains an unreadable count', () => {
    render(<MonthlyQuotaLine quota={{ used: null, cap: 100 }} now={now} />);
    expect(screen.getByText('— / 100')).toBeInTheDocument();
    expect(screen.getByText(/count unavailable/)).toBeInTheDocument();
  });

  it('a cap of 0 reads as paused, and a cap above 100 is not called free', () => {
    const { unmount } = render(<MonthlyQuotaLine quota={{ used: 0, cap: 0 }} now={now} />);
    expect(screen.getByText('paused')).toBeInTheDocument();
    expect(screen.queryByText(/cap reached/)).toBeNull();
    unmount();
    render(<MonthlyQuotaLine quota={{ used: 5, cap: 500 }} now={now} />);
    expect(screen.queryByText(/free/)).toBeNull();
  });
});
