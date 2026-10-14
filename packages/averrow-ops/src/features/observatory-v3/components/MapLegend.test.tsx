import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MapLegend } from './MapLegend';

describe('MapLegend', () => {
  it('lists the four severities when colouring by severity', () => {
    render(<MapLegend mode="global" colorBy="severity" />);
    const legend = screen.getByRole('group', { name: 'Map legend' });
    for (const s of ['critical', 'high', 'medium', 'low']) expect(legend).toHaveTextContent(s);
  });

  it('lists threat types when colouring by type', () => {
    render(<MapLegend mode="global" colorBy="type" />);
    expect(screen.getByText('credential harvesting')).toBeInTheDocument();
    expect(screen.getByText('malware distribution')).toBeInTheDocument();
  });

  it('shows a density scale in heatmap mode', () => {
    render(<MapLegend mode="heatmap" colorBy="severity" />);
    expect(screen.getByRole('group', { name: 'Heatmap legend' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /low to high threat density/i })).toBeInTheDocument();
  });

  it('collapses and expands, exposing aria-expanded', async () => {
    render(<MapLegend mode="global" colorBy="severity" defaultCollapsed />);
    const toggle = screen.getByRole('button', { name: /Colour: severity/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('critical')).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('critical')).toBeInTheDocument();
  });
});
