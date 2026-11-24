import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MonthlyQuotaLine } from './Integrations';

describe('MonthlyQuotaLine', () => {
  it('shows usage against the free cap', () => {
    render(<MonthlyQuotaLine quota={{ used: 12, cap: 100 }} />);
    expect(screen.getByText('12 / 100')).toBeInTheDocument();
    expect(screen.queryByText(/cap reached/)).toBeNull();
  });

  it('turns amber from 80% of the cap', () => {
    const { container } = render(<MonthlyQuotaLine quota={{ used: 80, cap: 100 }} />);
    expect((container.firstChild as HTMLElement).style.color).toBe('var(--sev-medium-text)');
  });

  it('says it is using abuse email once the cap is reached', () => {
    const { container } = render(<MonthlyQuotaLine quota={{ used: 100, cap: 100 }} />);
    expect(screen.getByText(/cap reached, using abuse email until the 1st/)).toBeInTheDocument();
    expect((container.firstChild as HTMLElement).style.color).toBe('var(--sev-critical-text)');
  });

  it('shows a dash when the count could not be read', () => {
    render(<MonthlyQuotaLine quota={{ used: null, cap: 100 }} />);
    expect(screen.getByText('— / 100')).toBeInTheDocument();
  });
});
