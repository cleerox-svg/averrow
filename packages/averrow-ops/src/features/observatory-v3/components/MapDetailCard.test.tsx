import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MapDetailCard } from './MapDetailCard';
import type { ArcData } from '@/hooks/useObservatory';

const arc: ArcData = {
  sourcePosition: [10, 20], targetPosition: [-100, 40], threat_type: 'credential_harvesting', severity: 'critical',
  source_region: 'Eastern Europe', target_brand: 'b', brand_name: 'PayPal', volume: 7, target_precision: 'country',
};

describe('MapDetailCard', () => {
  it('is clamped inside the container (not the window) and clear of the right inset', () => {
    render(<MapDetailCard selection={{ kind: 'arc', arc }} anchor={{ x: 790, y: 590 }} bounds={{ width: 800, height: 600, rightInset: 320 }} onClose={vi.fn()} />);
    const card = screen.getByRole('dialog');
    expect(parseFloat(card.style.left) + 300).toBeLessThanOrEqual(800 - 320);
    expect(parseFloat(card.style.left)).toBeGreaterThanOrEqual(8);
  });

  it('shows arc details incl. the approximate-target note and theme-aware severity text', () => {
    render(<MapDetailCard selection={{ kind: 'arc', arc }} anchor={{ x: 10, y: 10 }} bounds={{ width: 800, height: 600 }} onClose={vi.fn()} />);
    expect(screen.getByText('credential harvesting')).toBeInTheDocument();
    expect(screen.getByText('Target: PayPal')).toBeInTheDocument();
    expect(screen.getByText(/approximate/i)).toBeInTheDocument();
    expect(screen.getByText('critical').style.color).toBe('var(--sev-critical-text)');
  });

  it('closes on Escape and has an accessible close button', () => {
    const onClose = vi.fn();
    render(<MapDetailCard selection={{ kind: 'arc', arc }} anchor={{ x: 0, y: 0 }} bounds={{ width: 800, height: 600 }} onClose={onClose} />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    screen.getByRole('button', { name: 'Close details' }).click();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
