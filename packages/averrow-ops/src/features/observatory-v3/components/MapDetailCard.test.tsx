import React from 'react';
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

describe('MapDetailCard focus + Escape scoping', () => {
  const mount = (onClose = vi.fn()) => {
    const outer = document.createElement('button');
    outer.textContent = 'opener';
    document.body.appendChild(outer);
    outer.focus();
    const view = render(
      <div data-testid="map-root">
        <MapDetailCard selection={{ kind: 'arc', arc }} anchor={{ x: 0, y: 0 }} bounds={{ width: 800, height: 600 }} onClose={onClose} />
      </div>,
    );
    return { outer, onClose, ...view };
  };

  it('moves focus into the card on open and restores it to the opener on close', () => {
    const { outer, unmount } = mount();
    expect(screen.getByRole('dialog')).toHaveFocus();
    unmount();
    expect(outer).toHaveFocus();
    outer.remove();
  });

  it('restores focus to the opener under StrictMode double-invoked effects too', () => {
    const outer = document.createElement('button');
    document.body.appendChild(outer);
    outer.focus();
    const { unmount } = render(
      <React.StrictMode>
        <div><MapDetailCard selection={{ kind: 'arc', arc }} anchor={{ x: 0, y: 0 }} bounds={{ width: 800, height: 600 }} onClose={vi.fn()} /></div>
      </React.StrictMode>,
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
    unmount();
    expect(outer).toHaveFocus();
    outer.remove();
  });

  it('ignores an Escape that was already handled', () => {
    const { onClose, outer } = mount();
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    e.preventDefault();
    document.body.dispatchEvent(e);
    expect(onClose).not.toHaveBeenCalled();
    outer.remove();
  });

  it('ignores an Escape aimed at another dialog / menu', () => {
    const { onClose, outer } = mount();
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    other.appendChild(input);
    document.body.appendChild(other);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    other.remove();
    outer.remove();
  });

  it('ignores an Escape from an unrelated control outside the map, but handles one from the card', () => {
    const { onClose, outer } = mount();
    outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Close details' }).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    outer.remove();
  });
});
