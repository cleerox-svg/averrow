import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlRail, type ControlRailProps } from './ControlRail';
import { lensPreset } from '../lib/lenses';

const props = (over: Partial<ControlRailProps> = {}): ControlRailProps => ({
  lens: 'threats', layers: lensPreset('threats'), view: 'points', measure: 'index', colorBy: 'severity', reducedMotion: false,
  onLayers: vi.fn(), onView: vi.fn(), onMeasure: vi.fn(), onColorBy: vi.fn(), projection: 'flat', onProjection: vi.fn(), ...over,
});

describe('ControlRail: Flat map | Globe', () => {
  it('has a Projection group with the current choice pressed', () => {
    render(<ControlRail {...props()} />);
    const g = screen.getByRole('group', { name: 'Projection' });
    expect(within(g).getByRole('button', { name: 'Flat map' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(g).getByRole('button', { name: 'Globe' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the globe as pressed when it is the projection', () => {
    render(<ControlRail {...props({ projection: 'globe' })} />);
    const g = screen.getByRole('group', { name: 'Projection' });
    expect(within(g).getByRole('button', { name: 'Globe' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(g).getByRole('button', { name: 'Flat map' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('choosing one reports it and announces it', async () => {
    const onProjection = vi.fn();
    render(<ControlRail {...props({ onProjection })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Globe' }));
    expect(onProjection).toHaveBeenCalledWith('globe');
    expect(screen.getByRole('status')).toHaveTextContent('Projection: globe');
  });

  it('the globe is disabled where it cannot draw (heat view), with the reason in its hint, and does nothing', async () => {
    const onProjection = vi.fn();
    render(<ControlRail {...props({ view: 'heat', onProjection, globeAvailable: false })} />);
    const globe = screen.getByRole('button', { name: 'Globe' });
    expect(globe).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('The density heat view is flat-only')).toBeInTheDocument();
    await userEvent.click(globe);
    expect(onProjection).not.toHaveBeenCalled();
    // the flat map is still choosable
    expect(screen.getByRole('button', { name: 'Flat map' })).not.toHaveAttribute('aria-disabled');
  });

  it('is on every lens, and in the labelled phone panel too', () => {
    for (const lens of ['operations', 'movement', 'hosting', 'baseline', 'campaigns', 'actors'] as const) {
      const { unmount } = render(<ControlRail {...props({ lens, layers: lensPreset(lens) })} />);
      expect(screen.getByRole('group', { name: 'Projection' })).toBeInTheDocument();
      unmount();
    }
    render(<ControlRail {...props({ layout: 'panel' })} />);
    expect(screen.getByText('Projection')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Globe' })).toHaveTextContent('Globe');
  });
});
