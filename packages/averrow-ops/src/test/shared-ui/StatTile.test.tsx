import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatTile } from '@averrow/shared/ui';
import { stubMatchMedia } from './helpers';

// Custom properties are stored verbatim.
const NEUTRAL = '#5a6a85';
const accentOf = (c: HTMLElement) => (c.firstChild as HTMLElement).style.getPropertyValue('--st-accent');

describe('shared StatTile', () => {
  beforeEach(() => stubMatchMedia(true));

  it('shows an em dash and aria-busy while value is null', () => {
    const { container } = render(<StatTile label="Open alerts" value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText("Couldn't load")).not.toBeInTheDocument();
  });

  it("shows \"Couldn't load\", names the tile for AT, and drops aria-busy on null + error", () => {
    const { container } = render(<StatTile label="Open alerts" value={null} error />);
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('aria-label', "Open alerts: couldn't load");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.firstChild).not.toHaveAttribute('aria-busy');
    // Never a misleading 0.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('ignores error once a real value has loaded', () => {
    render(<StatTile label="Open alerts" value={5} error />);
    expect(screen.queryByText("Couldn't load")).not.toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders a genuine 0 as 0 (not loading) with the neutral accent', () => {
    const { container } = render(<StatTile label="Alerts" value={0} accent="#ff0000" />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(container.firstChild).not.toHaveAttribute('aria-busy');
    expect(accentOf(container)).toBe(NEUTRAL);
  });

  it('keeps the caller accent for a non-zero value', () => {
    const { container } = render(<StatTile label="Alerts" value={3} accent="#ff0000" />);
    expect(accentOf(container)).toBe('#ff0000');
  });

  it('treats a string "0" as zero for accent purposes', () => {
    const { container } = render(<StatTile label="Rate" value="0%" accent="#ff0000" />);
    expect(accentOf(container)).toBe(NEUTRAL);
  });

  it('shows the final value immediately under reduced motion, with grouping', () => {
    render(<StatTile label="Threats" value={12345} />);
    expect(screen.getByText('12,345')).toBeInTheDocument();
  });

  it('does not show the final value synchronously when motion is allowed', () => {
    stubMatchMedia(false);
    render(<StatTile label="Threats" value={12345} />);
    expect(screen.queryByText('12,345')).not.toBeInTheDocument();
  });

  it('renders string values verbatim', () => {
    render(<StatTile label="Grade" value="A+" />);
    expect(screen.getByText('A+')).toBeInTheDocument();
  });

  it('renders sub, critical pill and footer', () => {
    render(<StatTile label="Alerts" value={4} sub="awaiting triage" critical={2} footer={<em>foot</em>} />);
    expect(screen.getByText('awaiting triage')).toBeInTheDocument();
    expect(screen.getByLabelText('2 critical')).toBeInTheDocument();
    expect(screen.getByText('foot')).toBeInTheDocument();
  });

  it('hides the critical pill at 0 / undefined', () => {
    render(<StatTile label="Alerts" value={4} critical={0} />);
    expect(screen.queryByLabelText(/critical/)).not.toBeInTheDocument();
  });

  it('is not interactive without onClick', () => {
    render(<StatTile label="Alerts" value={4} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a <button> with onClick and is keyboard-activatable', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<StatTile label="Alerts" value={4} onClick={onClick} />);
    const btn = screen.getByRole('button');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    await user.tab();
    expect(btn).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('asChild renders the provided anchor as the root', () => {
    const { container } = render(
      <StatTile label="Alerts" value={4} asChild>
        <a href="/alerts" />
      </StatTile>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/alerts');
    expect(container.firstChild).toBe(link);
    expect(link).toHaveTextContent('Alerts');
    expect(link).toHaveTextContent('4');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('asChild forwards onClick to the anchor', async () => {
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <StatTile label="Alerts" value={4} asChild onClick={onClick}>
        <a href="/alerts" />
      </StatTile>,
    );
    await userEvent.setup().click(screen.getByRole('link'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('exposes the failed state in the accessible name of a clickable tile', () => {
    render(<StatTile label="Open alerts" value={null} error onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /couldn't load/i })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('exposes the loading state in the accessible name (clickable and static)', () => {
    const { rerender, container } = render(<StatTile label="Open alerts" value={null} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open alerts: loading' })).toBeInTheDocument();
    rerender(<StatTile label="Open alerts" value={null} />);
    expect(container.firstChild).toHaveAttribute('aria-label', 'Open alerts: loading');
  });

  it('a static tile with a state aria-label is a role=group so the name is exposed', () => {
    const { rerender } = render(<StatTile label="Open alerts" value={null} error />);
    expect(screen.getByRole('group', { name: "Open alerts: couldn't load" })).toBeInTheDocument();
    rerender(<StatTile label="Open alerts" value={null} />);
    expect(screen.getByRole('group', { name: 'Open alerts: loading' })).toBeInTheDocument();
    // Healthy static tiles have no aria-label and no group role.
    rerender(<StatTile label="Open alerts" value={4} />);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('has no glow orb and no number text-shadow', () => {
    const { container } = render(<StatTile label="A" value={4} accent="var(--red)" />);
    expect(container.querySelector('.blur-\\[36px\\]')).toBeNull();
    // Only aria-hidden children allowed are the trend/hint; none here.
    expect(container.querySelector('[aria-hidden]')).toBeNull();
    expect((screen.getByText('4') as HTMLElement).style.textShadow).toBe('');
  });

  it('label is plain sans text, not uppercase/mono/tracked', () => {
    render(<StatTile label="Open alerts" value={4} />);
    const cls = screen.getByText('Open alerts').className;
    expect(cls).toBe('ds-stat-label');
    expect(cls).not.toMatch(/uppercase|font-mono|tracking/);
  });

  it('renders a delta chip with an accessible label and tone', () => {
    render(<StatTile label="Queue" value={9} delta={{ value: '+412', tone: 'bad', label: '412 more than yesterday' }} />);
    const chip = screen.getByLabelText('412 more than yesterday');
    expect(chip).toHaveTextContent('+412');
    expect(chip).toHaveAttribute('data-tone', 'bad');
    expect(chip).not.toHaveClass('ds-stat-delta--inline');
  });

  it('delta falls back to its value as the name and defaults to neutral', () => {
    render(<StatTile label="Queue" value={9} delta={{ value: '0' }} />);
    expect(screen.getByLabelText('0')).toHaveAttribute('data-tone', 'neutral');
  });

  it('does not render the delta chip while loading or failed', () => {
    const { rerender } = render(<StatTile label="Q" value={null} delta={{ value: '+1', label: 'one more' }} />);
    expect(screen.queryByLabelText('one more')).not.toBeInTheDocument();
    rerender(<StatTile label="Q" value={null} error delta={{ value: '+1', label: 'one more' }} />);
    expect(screen.queryByLabelText('one more')).not.toBeInTheDocument();
  });

  it('marks critical and idle (loading/error) tiles with modifier classes', () => {
    const { container, rerender } = render(<StatTile label="Q" value={3} critical={2} />);
    expect(container.firstChild).toHaveClass('ds-stat--crit');
    expect(container.firstChild).not.toHaveClass('ds-stat--idle');
    rerender(<StatTile label="Q" value={null} />);
    expect(container.firstChild).toHaveClass('ds-stat--idle');
  });

  it('delta goes inline after the label when the critical pill is present', () => {
    render(<StatTile label="Queue" value={9} critical={2} delta={{ value: '+1', label: 'one more' }} />);
    const chip = screen.getByLabelText('one more');
    expect(chip).toHaveClass('ds-stat-delta--inline');
    expect(screen.getByText('Queue')).toContainElement(chip);
  });

  it('renders a trend sparkline with one path point per value, hidden from AT', () => {
    render(<StatTile label="Q" value={9} trend={[1, 3, 2, 5]} />);
    const trend = screen.getByTestId('stat-trend');
    expect(trend).toHaveAttribute('aria-hidden', 'true');
    const d = trend.querySelector('.ds-stat-trend-line')!.getAttribute('d')!;
    expect(d.match(/[ML]/g)).toHaveLength(4);
    expect(trend.querySelector('.ds-stat-trend-dot')).not.toBeNull();
    expect(trend.querySelector('.ds-stat-trend-dot')!.className).not.toMatch(/h-\[|w-\[/); // sized in CSS
  });

  it('renders a dashed baseline for a flat or all-zero series', () => {
    const { rerender } = render(<StatTile label="Q" value={9} trend={[0, 0, 0]} />);
    expect(screen.getByTestId('stat-trend').querySelector('.ds-stat-trend-flat')).not.toBeNull();
    expect(screen.getByTestId('stat-trend').querySelector('.ds-stat-trend-line')).toBeNull();
    rerender(<StatTile label="Q" value={9} trend={[4, 4, 4]} />);
    expect(screen.getByTestId('stat-trend').querySelector('.ds-stat-trend-flat')).not.toBeNull();
  });

  it('renders no sparkline for fewer than 2 points, empty, or while loading', () => {
    const { rerender } = render(<StatTile label="Q" value={9} trend={[3]} />);
    expect(screen.queryByTestId('stat-trend')).not.toBeInTheDocument();
    rerender(<StatTile label="Q" value={9} trend={[]} />);
    expect(screen.queryByTestId('stat-trend')).not.toBeInTheDocument();
    rerender(<StatTile label="Q" value={null} trend={[1, 2, 3]} />);
    expect(screen.queryByTestId('stat-trend')).not.toBeInTheDocument();
  });

  it('live adds the live class only for a settled value > 0', () => {
    const { container, rerender } = render(<StatTile label="A" value={3} live />);
    expect(container.firstChild).toHaveClass('ds-stat--live');
    rerender(<StatTile label="A" value={0} live />);
    expect(container.firstChild).not.toHaveClass('ds-stat--live');
    rerender(<StatTile label="A" value={null} live />);
    expect(container.firstChild).not.toHaveClass('ds-stat--live');
    rerender(<StatTile label="A" value={null} error live />);
    expect(container.firstChild).not.toHaveClass('ds-stat--live');
    rerender(<StatTile label="A" value="12%" live />);
    expect(container.firstChild).toHaveClass('ds-stat--live');
    rerender(<StatTile label="A" value={3} />);
    expect(container.firstChild).not.toHaveClass('ds-stat--live');
  });

  it('keeps the sub-line visible on small screens (it can carry data)', () => {
    render(<StatTile label="A" value={4} sub="3 critical · 1 new" />);
    expect(screen.getByText('3 critical · 1 new').className).not.toContain('max-sm:hidden');
  });

  it('keeps the content-derived name once loaded (no state aria-label)', () => {
    render(<StatTile label="Open alerts" value={4} onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn).not.toHaveAttribute('aria-label');
    expect(btn).toHaveAccessibleName(/Open alerts/);
  });

  it('reserves bottom space for the "View" hint only when clickable', () => {
    const { container, rerender } = render(<StatTile label="A" value={1} sub="a long wrapped sub line" onClick={() => {}} />);
    expect((container.firstChild as HTMLElement).className).toContain('ds-stat--interactive');
    rerender(<StatTile label="A" value={1} />);
    expect((container.firstChild as HTMLElement).className).not.toContain('ds-stat--interactive');
  });
});
