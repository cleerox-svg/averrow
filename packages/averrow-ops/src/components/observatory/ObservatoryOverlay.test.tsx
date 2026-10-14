import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ObservatoryOverlay } from './ObservatoryOverlay';

describe('ObservatoryOverlay', () => {
  it('"clear" copy has no contradictory "historical" counts', () => {
    render(<ObservatoryOverlay kind="clear" timeWindow="7D" totalThreats={0} />);
    expect(screen.getByText('Threat Landscape Clear')).toBeInTheDocument();
    expect(screen.getByText('No threats recorded in the 7D window')).toBeInTheDocument();
    expect(screen.queryByText(/historical/i)).not.toBeInTheDocument();
  });

  it('mentions the source filter in the copy', () => {
    render(<ObservatoryOverlay kind="clear" timeWindow="24H" totalThreats={0} sourceLabel="Spam Trap" />);
    expect(screen.getByText('No threats recorded from Spam Trap in the 24H window')).toBeInTheDocument();
  });

  it('"ungeolocated" does not claim the landscape is clear', () => {
    render(<ObservatoryOverlay kind="ungeolocated" timeWindow="30D" totalThreats={1200} />);
    expect(screen.queryByText('Threat Landscape Clear')).not.toBeInTheDocument();
    expect(screen.getByText('No Geolocated Threats')).toBeInTheDocument();
    expect(screen.getByText(/1,200 threats in the 30D window have no map position yet/)).toBeInTheDocument();
  });

  it('uses no hard-coded white/amber utility colours (light-theme safe)', () => {
    const { container } = render(<ObservatoryOverlay kind="clear" timeWindow="7D" totalThreats={0} />);
    expect(container.innerHTML).not.toMatch(/text-white|border-white|amber-[0-9]/);
  });
});
