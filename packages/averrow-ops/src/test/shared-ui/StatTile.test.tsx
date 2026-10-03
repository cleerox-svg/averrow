import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatTile } from '@averrow/shared/ui';
import { stubMatchMedia } from './helpers';

// jsdom serialises '#5a6a85' as rgb(90, 106, 133).
const NEUTRAL_RGB = 'rgb(90, 106, 133)';
const orb = (c: HTMLElement) => c.querySelector('span[aria-hidden]') as HTMLElement;

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
    expect(orb(container).style.background).toBe(NEUTRAL_RGB);
  });

  it('keeps the caller accent for a non-zero value', () => {
    const { container } = render(<StatTile label="Alerts" value={3} accent="#ff0000" />);
    expect(orb(container).style.background).toBe('rgb(255, 0, 0)');
  });

  it('treats a string "0" as zero for accent purposes', () => {
    const { container } = render(<StatTile label="Rate" value="0%" accent="#ff0000" />);
    expect(orb(container).style.background).toBe(NEUTRAL_RGB);
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

  it('dims the glow while loading or failed so it does not read as a live alert', () => {
    const { container, rerender } = render(<StatTile label="A" value={null} accent="var(--red)" />);
    expect(orb(container)).toHaveClass('opacity-20');
    rerender(<StatTile label="A" value={null} error accent="var(--red)" />);
    expect(orb(container)).toHaveClass('opacity-20');
    rerender(<StatTile label="A" value={4} accent="var(--red)" />);
    expect(orb(container)).toHaveClass('opacity-[0.55]');
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
    expect((container.firstChild as HTMLElement).className).toMatch(/\bpb-6\b/);
    rerender(<StatTile label="A" value={1} />);
    expect((container.firstChild as HTMLElement).className).not.toMatch(/\bpb-6\b/);
  });

  it('uses tokens, not hardcoded colours, for shadow and hover glow', () => {
    const { container } = render(<StatTile label="A" value={1} onClick={() => {}} />);
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain('var(--card-shadow)');
    expect(cls).not.toMatch(/rgba\(0,0,0|rgba\(229,168,50/);
  });
});
