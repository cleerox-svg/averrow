import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sparkline } from '@averrow/shared/ui';
import { stubMatchMedia } from './helpers';

describe('shared Sparkline', () => {
  it('is decorative (aria-hidden, no role) by default', () => {
    stubMatchMedia(true);
    const { container } = render(<Sparkline data={[1, 2, 3]} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('with label is role=img with an aria-label and not aria-hidden', () => {
    render(<Sparkline data={[1, 2, 3]} label="Threats, last 7 days" />);
    const img = screen.getByRole('img', { name: 'Threats, last 7 days' });
    expect(img).not.toHaveAttribute('aria-hidden');
  });

  it('draws a line path for 2+ points', () => {
    const { container } = render(<Sparkline data={[1, 5]} />);
    const paths = Array.from(container.querySelectorAll('path')).map((p) => p.getAttribute('d') ?? '');
    expect(paths.some((d) => d.startsWith('M '))).toBe(true);
    expect(container.querySelector('circle')).not.toBeNull();
  });

  it.each([[[]], [[7]]])('renders a placeholder (not nothing) for %j, keeping its size', (data) => {
    const { container } = render(<Sparkline data={data} width={90} height={30} />);
    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('width', '90');
    expect(svg).toHaveAttribute('height', '30');
    expect(container.querySelector('line')).not.toBeNull();
    expect(container.querySelector('path')).toBeNull();
  });

  it('placeholder still honours label', () => {
    render(<Sparkline data={[]} label="No trend yet" />);
    expect(screen.getByRole('img', { name: 'No trend yet' })).toBeInTheDocument();
  });

  it('renders a placeholder when fewer than 2 points are finite', () => {
    const { container } = render(<Sparkline data={[NaN, 3]} />);
    expect(container.querySelector('line')).not.toBeNull();
  });

  it('does not emit NaN coordinates for a flat series or a non-finite point', () => {
    const { container, rerender } = render(<Sparkline data={[4, 4, 4]} />);
    const dAttrs = () => Array.from(container.querySelectorAll('path')).map((p) => p.getAttribute('d')).join(' ');
    expect(dAttrs()).not.toMatch(/NaN|Infinity/);
    rerender(<Sparkline data={[1, NaN, 3]} />);
    expect(dAttrs()).not.toMatch(/NaN|Infinity/);
  });

  it('uses unique gradient ids per instance', () => {
    const { container } = render(<><Sparkline data={[1, 2]} /><Sparkline data={[1, 2]} /></>);
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
  });

  describe('baseline', () => {
    const ys = (container: HTMLElement) => {
      const d = Array.from(container.querySelectorAll('path')).map((p) => p.getAttribute('d') ?? '').find((x) => x.startsWith('M '))!;
      return Array.from(d.matchAll(/[ML] ([\d.]+) ([\d.]+)/g)).map((m) => parseFloat(m[2]!));
    };

    it('auto (default) spans min..max: the lowest point sits on the bottom edge', () => {
      const { container } = render(<Sparkline data={[10, 20]} height={28} />);
      const [lo, hi] = ys(container);
      expect(lo).toBe(24); // height - PAD
      expect(hi).toBe(4); // PAD
    });

    it('zero anchors the range at 0: half the peak draws at half height', () => {
      const { container } = render(<Sparkline data={[10, 20]} height={28} baseline="zero" />);
      const [lo, hi] = ys(container);
      expect(hi).toBe(4);
      expect(lo).toBe(14); // 4 + (24-4)/2
    });

    it('zero still draws a flat all-zero series without NaN', () => {
      const { container } = render(<Sparkline data={[0, 0, 0]} baseline="zero" />);
      expect(ys(container).every(Number.isFinite)).toBe(true);
    });
  });

  it('keeps the end dot and stroke inside the viewBox (clipped, inset by PAD)', () => {
    const { container } = render(<Sparkline data={[1, 9, 3]} width={80} height={28} />);
    expect(container.querySelector('svg')!.style.overflow).toBe('hidden');
    const c = container.querySelector('circle')!;
    const cx = parseFloat(c.getAttribute('cx')!);
    const cy = parseFloat(c.getAttribute('cy')!);
    expect(cx + 2.5).toBeLessThanOrEqual(80);
    expect(cy - 2.5).toBeGreaterThanOrEqual(0);
    expect(cy + 2.5).toBeLessThanOrEqual(28);
  });
});
