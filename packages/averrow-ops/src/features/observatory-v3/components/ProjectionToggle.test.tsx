import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectionToggle, HEAT_FLAT_ONLY, toggleLabel } from './ProjectionToggle';

describe('ProjectionToggle: ONE button for Flat | Globe', () => {
  it('flat: "Globe view", not pressed; pressing it asks for the globe and says so', async () => {
    const onToggle = vi.fn();
    render(<ProjectionToggle projection="flat" onToggle={onToggle} />);
    const btn = screen.getByRole('button', { name: 'Globe view' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith('globe');
    expect(screen.getByRole('status')).toHaveTextContent('Projection: globe');
  });

  it('globe: the SAME label, pressed; pressing it asks for flat', async () => {
    const onToggle = vi.fn();
    render(<ProjectionToggle projection="globe" onToggle={onToggle} />);
    const btn = screen.getByRole('button', { name: 'Globe view' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith('flat');
    expect(screen.getByRole('status')).toHaveTextContent('Projection: flat map');
  });

  it('is a single button (not a Flat / Globe pair)', () => {
    render(<ProjectionToggle projection="flat" onToggle={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  describe('the density Heat view has no globe variant', () => {
    it('is disabled, says why IN TEXT (visible on touch, no hover needed), and does nothing', async () => {
      const onToggle = vi.fn();
      render(<ProjectionToggle projection="flat" flatOnly onToggle={onToggle} />);
      const btn = screen.getByRole('button');
      expect(btn).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByText(HEAT_FLAT_ONLY)).toBeVisible();
      expect(btn).toHaveAccessibleDescription(HEAT_FLAT_ONLY);
      await userEvent.click(btn);
      expect(onToggle).not.toHaveBeenCalled();
    });

    it('keeps the REQUESTED globe pressed (the preference survives) while disabled, and announces the flip', () => {
      const { rerender } = render(<ProjectionToggle projection="globe" onToggle={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent('');
      rerender(<ProjectionToggle projection="globe" flatOnly onToggle={vi.fn()} />);
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('status')).toHaveTextContent(`${HEAT_FLAT_ONLY}: showing the flat map`);
      rerender(<ProjectionToggle projection="globe" onToggle={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent('Globe view restored');
    });

    it('a flat request in Heat announces nothing (nothing was taken away)', () => {
      const { rerender } = render(<ProjectionToggle projection="flat" onToggle={vi.fn()} />);
      rerender(<ProjectionToggle projection="flat" flatOnly onToggle={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent('');
      rerender(<ProjectionToggle projection="flat" onToggle={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent('');
    });

    it('the label names the reason too (screen readers hear it without the description)', () => {
      expect(toggleLabel('flat', true)).toMatch(/heat view is flat-only/);
      expect(toggleLabel('globe', false)).toBe('Globe view');
      expect(toggleLabel('flat', false)).toBe('Globe view'); // fixed: aria-pressed carries the state
    });
  });

  it('is a 29px MapLibre-sized control on a pointer device and a 44px target on touch', () => {
    const { rerender } = render(<ProjectionToggle projection="flat" onToggle={vi.fn()} />);
    // Desktop: 29px tall, at least 29px wide (it carries the "Flat | Globe" text); touch: a plain 44px icon.
    expect(screen.getByRole('button').style.minWidth).toBe('29px');
    expect(screen.getByRole('button').style.height).toBe('29px');
    rerender(<ProjectionToggle projection="flat" onToggle={vi.fn()} touch />);
    expect(screen.getByRole('button').style.width).toBe('44px');
    expect(screen.getByRole('button').style.height).toBe('44px');
    expect(within(document.body).getByRole('button')).toBeInTheDocument();
  });
});
