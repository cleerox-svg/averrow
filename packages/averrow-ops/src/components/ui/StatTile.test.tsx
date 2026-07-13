import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatTile } from './StatTile';

// useCountUp animates via requestAnimationFrame over ~1.1s — real tests
// asserting the rendered number would otherwise see the animation's
// initial frame (0) rather than the settled value. Mock it to the
// identity function so numeric-value assertions below are synchronous
// and deterministic. Existing tests above never assert on the digits
// themselves, so this doesn't change their behavior.
vi.mock('@/design-system/hooks/useCountUp', () => ({
  useCountUp: (target: number) => target,
}));

describe('StatTile', () => {
  it('renders label and value', () => {
    render(<StatTile label="Active Threats" value={42} accent="#C83C3C" />);
    expect(screen.getByText('Active Threats')).toBeInTheDocument();
  });

  it('calls onClick on mouse click', async () => {
    const onClick = vi.fn();
    render(<StatTile label="Threats" value={1} accent="#C83C3C" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is keyboard-focusable and marked as a button when onClick is provided', () => {
    const onClick = vi.fn();
    render(<StatTile label="Threats" value={1} accent="#C83C3C" onClick={onClick} />);
    const tile = screen.getByRole('button');
    expect(tile).toHaveAttribute('tabIndex', '0');
  });

  it('calls onClick on Enter keydown', () => {
    const onClick = vi.fn();
    render(<StatTile label="Threats" value={1} accent="#C83C3C" onClick={onClick} />);
    const tile = screen.getByRole('button');
    fireEvent.keyDown(tile, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('calls onClick on Space keydown and prevents the default (page scroll)', () => {
    const onClick = vi.fn();
    render(<StatTile label="Threats" value={1} accent="#C83C3C" onClick={onClick} />);
    const tile = screen.getByRole('button');
    const event = fireEvent.keyDown(tile, { key: ' ' });
    // testing-library's fireEvent returns `false` when the event's
    // default was prevented (mirrors dispatchEvent's return value).
    expect(event).toBe(false);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not call onClick for a non-activating key', () => {
    const onClick = vi.fn();
    render(<StatTile label="Threats" value={1} accent="#C83C3C" onClick={onClick} />);
    const tile = screen.getByRole('button');
    fireEvent.keyDown(tile, { key: 'Escape' });
    fireEvent.keyDown(tile, { key: 'a' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('has no button role or tabIndex when onClick is not provided', () => {
    render(<StatTile label="Threats" value={1} accent="#C83C3C" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Walk up to the outer tile element (label div -> marginTop wrapper -> tile).
    const tile = screen.getByText('Threats').parentElement!.parentElement!;
    expect(tile).not.toHaveAttribute('tabindex');
    expect(tile).not.toHaveAttribute('role');
  });

  it('does not throw on keydown when onClick is not provided', () => {
    render(<StatTile label="Threats" value={1} accent="#C83C3C" />);
    const tile = screen.getByText('Threats').parentElement!.parentElement!;
    expect(() => fireEvent.keyDown(tile, { key: 'Enter' })).not.toThrow();
  });
});

// ─── value semantics: null (loading) vs genuine 0 vs a real number ───
//
// Regression coverage for the loading-state fix: `value` now accepts
// `number | string | null`. `null` means "query still in flight" and
// must render the neutral '—' placeholder — never a bare '0', which
// would misrepresent an in-flight fetch as a real zero count. A
// genuine settled `0` must still render '0', not fall through to the
// loading affordance (the crux of the bug this locks down).
describe('StatTile — value semantics (null vs 0 vs a number)', () => {
  it('value={null} renders the "—" loading placeholder, not "0"', () => {
    render(<StatTile label="Agents" value={null} accent="#38BDF8" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('value={0} renders a genuine "0", not the loading placeholder', () => {
    render(<StatTile label="Agents" value={0} accent="#38BDF8" />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('value={42} renders the number (locale-formatted), not the loading placeholder', () => {
    render(<StatTile label="Agents" value={42} accent="#38BDF8" />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('a string value (e.g. a pre-formatted metric) passes through untouched', () => {
    render(<StatTile label="Spend" value="$1.5K" accent="#38BDF8" />);
    expect(screen.getByText('$1.5K')).toBeInTheDocument();
  });

  it('value={null} does not render the accent glow styling (muted tertiary color instead)', () => {
    render(<StatTile label="Agents" value={null} accent="#38BDF8" />);
    const numberEl = screen.getByText('—');
    expect(numberEl).toHaveStyle({ color: 'var(--text-tertiary)', textShadow: 'none' });
  });
});
