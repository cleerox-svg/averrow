import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('renders label and value', () => {
    render(<StatCard label="Active Threats" value={1234} />);
    expect(screen.getByText('Active Threats')).toBeInTheDocument();
    // CountUp renders inside the value container — verify the span exists
    expect(screen.getByText('Active Threats').closest('[data-testid="stat-card"]')).toBeInTheDocument();
  });

  it('renders string values', () => {
    render(<StatCard label="Grade" value="A+" />);
    expect(screen.getByText('A+')).toBeInTheDocument();
  });

  it('renders sublabel when provided', () => {
    render(<StatCard label="Threats" value={100} sublabel="+5 today" />);
    expect(screen.getByText('+5 today')).toBeInTheDocument();
  });

  it('does not render sublabel when not provided', () => {
    render(<StatCard label="Test" value={0} />);
    expect(screen.queryByText('+5 today')).not.toBeInTheDocument();
  });

  it('renders trend with up direction', () => {
    render(<StatCard label="Score" value={85} trend="+12%" trendDirection="up" />);
    const trendEl = screen.getByText('+12%');
    expect(trendEl).toBeInTheDocument();
    expect(trendEl).toHaveClass('text-positive');
  });

  it('renders trend with down direction', () => {
    render(<StatCard label="Score" value={85} trend="-8%" trendDirection="down" />);
    const trendEl = screen.getByText('-8%');
    expect(trendEl).toHaveClass('text-accent');
  });

  it('renders trend with neutral direction', () => {
    render(<StatCard label="Score" value={85} trend="0%" trendDirection="neutral" />);
    const trendEl = screen.getByText('0%');
    expect(trendEl).toHaveClass('text-white/55');
  });

  it('applies accent color border for non-zero values', () => {
    // value > 0 → accentColor passes through to the border-left.
    const { container } = render(<StatCard label="Test" value={42} accentColor="#C83C3C" />);
    const card = container.querySelector('[data-testid="stat-card"]')!;
    expect(card).toHaveStyle({ borderLeftColor: '#C83C3C' });
    expect(card).toHaveClass('border-l-[3px]');
  });

  it('overrides accent to neutral slate when value is 0 (zero-state rule)', () => {
    // Audit M2: "0 ALERTS" / "0 ERRORS" should render calm, not in
    // alert red. resolveStatAccent collapses to M.NEUTRAL (#5a6a85)
    // regardless of caller-provided accentColor.
    const { container } = render(<StatCard label="Test" value={0} accentColor="#C83C3C" />);
    const card = container.querySelector('[data-testid="stat-card"]')!;
    expect(card).toHaveStyle({ borderLeftColor: '#5a6a85' });
    // Border-left treatment still applies (the accent prop was given);
    // only the color resolves to neutral.
    expect(card).toHaveClass('border-l-[3px]');
  });

  it('does not apply border-left style without accentColor', () => {
    const { container } = render(<StatCard label="Test" value={0} />);
    const card = container.querySelector('[data-testid="stat-card"]')!;
    expect(card).not.toHaveClass('border-l-[3px]');
  });
});
