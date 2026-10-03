import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BreakdownCard } from './BreakdownCard';

describe('BreakdownCard', () => {
  it('renders title, metric, metric label and the breakdown children', () => {
    render(
      <BreakdownCard title="Active Threats" metric={<span>42</span>} metricLabel="TOTAL">
        <div>critical 3</div>
        <div>high 9</div>
      </BreakdownCard>,
    );
    expect(screen.getByText('Active Threats')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('TOTAL')).toBeInTheDocument();
    expect(screen.getByText('critical 3')).toBeInTheDocument();
    expect(screen.getByText('high 9')).toBeInTheDocument();
  });

  it('keeps the container-query layout hooks (row, children, divider, metric)', () => {
    const { container } = render(
      <BreakdownCard title="T" metric="1" metricLabel="L">
        <span>row</span>
      </BreakdownCard>,
    );
    const root = screen.getByTestId('breakdown-card');
    // inline-size container is what the < 220px stacking rule keys off.
    expect(root).toHaveStyle({ containerType: 'inline-size' });
    expect(root).toHaveClass('detail-stat-card');
    expect(container.querySelector('.detail-stat-row')).not.toBeNull();
    expect(container.querySelector('.detail-stat-children')).toHaveTextContent('row');
    expect(container.querySelector('.detail-stat-divider')).not.toBeNull();
    expect(container.querySelector('.detail-stat-metric-value')).toHaveTextContent('1');
    expect(container.querySelector('.detail-stat-metric-label')).toHaveTextContent('L');
  });

  it('is built on the shared Card (token border + gradient surface)', () => {
    render(
      <BreakdownCard title="T" metric="1" metricLabel="L">
        x
      </BreakdownCard>,
    );
    const cls = screen.getByTestId('breakdown-card').className;
    expect(cls).toContain('border-[var(--border-base)]');
    expect(cls).toContain('var(--bg-card)');
  });

  it('merges className and style from the caller without losing containerType', () => {
    render(
      <BreakdownCard title="T" metric="1" metricLabel="L" className="col-span-2" style={{ minHeight: 120 }}>
        x
      </BreakdownCard>,
    );
    const root = screen.getByTestId('breakdown-card');
    expect(root).toHaveClass('col-span-2');
    expect(root).toHaveStyle({ minHeight: '120px', containerType: 'inline-size' });
  });

  it('accepts ReactNode titles (e.g. icon + text)', () => {
    render(
      <BreakdownCard title={<span data-testid="rich-title">Exposure</span>} metric="7" metricLabel="L">
        x
      </BreakdownCard>,
    );
    expect(screen.getByTestId('rich-title')).toBeInTheDocument();
  });
});
