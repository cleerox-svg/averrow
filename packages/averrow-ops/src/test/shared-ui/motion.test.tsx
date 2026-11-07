// Motion kit (P3-4): every move is a no-op without data-accent, reduced motion
// swaps travel for an opacity fade, and arrivals never flash on first render.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor, fireEvent } from '@testing-library/react';
import { useRef, useState } from 'react';
import {
  NavIndicator, Tabs, isMotionOn, play, prefersReducedMotion, useArrivalFlash, usePageSlide,
} from '@averrow/shared/ui';
import { __resetTokenReaderForTests } from '../../../../shared/src/theme/tokenReader';

const root = document.documentElement;
let animate: ReturnType<typeof vi.fn>;

function setAccent(on: boolean) {
  if (on) root.setAttribute('data-accent', 'indigo');
  else root.removeAttribute('data-accent');
}

beforeEach(() => {
  __resetTokenReaderForTests();
  setAccent(false);
  root.removeAttribute('data-motion');
  animate = vi.fn(() => ({ cancel: vi.fn() }));
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
});

afterEach(() => {
  // Unmount first: clearing the accent with components mounted would update them outside act().
  cleanup();
  __resetTokenReaderForTests();
  setAccent(false);
  root.removeAttribute('data-motion');
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  vi.restoreAllMocks();
});

/** Every keyframe set passed to el.animate, as plain objects. */
const frames = () => animate.mock.calls.map((c) => c[0] as Array<Record<string, string | number>>);

describe('core gates', () => {
  it('is off without data-accent and play() does nothing', () => {
    expect(isMotionOn()).toBe(false);
    expect(play(document.body, [{ opacity: 0 }, { opacity: 1 }], 120)).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it('is on with data-accent', () => {
    setAccent(true);
    expect(isMotionOn()).toBe(true);
    play(document.body, [{ opacity: 0 }, { opacity: 1 }], 120);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('honours the /kit reduced-motion simulation', () => {
    expect(prefersReducedMotion()).toBe(false);
    root.setAttribute('data-motion', 'reduce');
    expect(prefersReducedMotion()).toBe(true);
  });

  it('is a silent no-op where WAAPI is missing', () => {
    setAccent(true);
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    expect(play(document.body, [{ opacity: 0 }, { opacity: 1 }], 120)).toBeNull();
  });
});

describe('NavIndicator', () => {
  function Nav({ active }: { active: number }) {
    return (
      <nav data-testid="nav">
        <NavIndicator activeKey={active} />
        {[0, 1, 2].map((i) => (
          <a key={i} href="#x" aria-current={i === active ? 'page' : undefined}>item {i}</a>
        ))}
      </nav>
    );
  }

  it('renders nothing and leaves the nav untouched without an accent', () => {
    const { container } = render(<Nav active={0} />);
    expect(container.querySelector('.motion-glide')).toBeNull();
    expect(screen.getByTestId('nav')).not.toHaveAttribute('data-glide');
  });

  it('mounts under an accent and unmounts when the accent is cleared', async () => {
    setAccent(true);
    const { container } = render(<Nav active={0} />);
    expect(container.querySelector('.motion-glide--y')).not.toBeNull();
    expect(screen.getByTestId('nav')).toHaveAttribute('data-glide');
    act(() => setAccent(false));
    await waitFor(() => expect(container.querySelector('.motion-glide')).toBeNull());
    expect(screen.getByTestId('nav')).not.toHaveAttribute('data-glide');
  });
});

describe('Tabs underline morph', () => {
  const TABS = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' }];

  function Harness({ variant = 'underline' as const }: { variant?: 'underline' | 'pills' }) {
    const [tab, setTab] = useState('a');
    return <Tabs variant={variant} tabs={TABS} activeTab={tab} onChange={setTab} aria-label="t" />;
  }

  beforeEach(() => {
    // Lay the tabs out 100px apart so a tab change is a real move.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const i = TABS.findIndex((t) => t.label === this.textContent);
      const left = i < 0 ? 0 : i * 100;
      const width = i < 0 ? 300 : 80;
      return { left, top: 0, width, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    });
  });

  it('no accent: no gliding underline, each tab keeps its own border', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('.motion-glide')).toBeNull();
    expect(screen.getByRole('tablist')).not.toHaveAttribute('data-glide');
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Beta' }).style.borderBottomColor).toBe('var(--primary)');
  });

  it('accent: the underline sits on the active tab and glides on change', () => {
    setAccent(true);
    const { container } = render(<Harness />);
    const line = container.querySelector<HTMLElement>('.motion-glide--x')!;
    expect(line).not.toBeNull();
    expect(screen.getByRole('tablist')).toHaveAttribute('data-glide');
    expect(line.style.left).toBe('0px');
    animate.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'Gamma' }));
    expect(line.style.left).toBe('200px');
    expect(frames()).toContainEqual([{ left: '0px', width: '80px' }, { left: '200px', width: '80px' }]);
  });

  it('accent + reduced motion: opacity only, no travel', () => {
    setAccent(true);
    root.setAttribute('data-motion', 'reduce');
    render(<Harness />);
    animate.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    expect(frames()).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
  });

  it('only the underline variant morphs', () => {
    setAccent(true);
    const { container } = render(<Harness variant="pills" />);
    expect(container.querySelector('.motion-glide')).toBeNull();
  });
});

describe('usePageSlide', () => {
  function Page({ k, order }: { k: string; order: number }) {
    const ref = useRef<HTMLDivElement>(null);
    usePageSlide(ref, k, order);
    return <div ref={ref}>{k}</div>;
  }

  it('does nothing without an accent', () => {
    const { rerender } = render(<Page k="/a" order={0} />);
    rerender(<Page k="/b" order={1} />);
    expect(animate).not.toHaveBeenCalled();
  });

  it('skips the first render, then slides 24px in the nav direction', () => {
    setAccent(true);
    const { rerender } = render(<Page k="/a" order={1} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Page k="/b" order={2} />);
    expect(frames()[0]![0]).toEqual({ opacity: 0, transform: 'translateX(24px)' });
    rerender(<Page k="/c" order={0} />);
    expect(frames()[1]![0]).toEqual({ opacity: 0, transform: 'translateX(-24px)' });
    expect(animate.mock.calls[1]![1]).toMatchObject({ duration: 200 });
  });

  it('reduced motion: fades without travel', () => {
    setAccent(true);
    root.setAttribute('data-motion', 'reduce');
    const { rerender } = render(<Page k="/a" order={0} />);
    rerender(<Page k="/b" order={1} />);
    expect(frames()).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
  });
});

describe('useArrivalFlash', () => {
  it('never flags on first render; flags new ids after', () => {
    setAccent(true);
    const { result, rerender } = renderHook(({ ids }) => useArrivalFlash(ids), { initialProps: { ids: ['a', 'b'] } });
    expect(result.current.size).toBe(0);
    rerender({ ids: ['c', 'a', 'b'] });
    expect([...result.current]).toEqual(['c']);
  });

  it('a reset key change (a new filter) is not an arrival', () => {
    setAccent(true);
    const { result, rerender } = renderHook(({ ids, k }) => useArrivalFlash(ids, k), { initialProps: { ids: ['a'], k: 'f1' } });
    rerender({ ids: ['x', 'y'], k: 'f2' });
    expect(result.current.size).toBe(0);
  });

  it('flags nothing without an accent', () => {
    const { result, rerender } = renderHook(({ ids }) => useArrivalFlash(ids), { initialProps: { ids: ['a'] } });
    rerender({ ids: ['b', 'a'] });
    expect(result.current.size).toBe(0);
  });

  it('clears the flag after the hold time', () => {
    vi.useFakeTimers();
    try {
      setAccent(true);
      const { result, rerender } = renderHook(({ ids }) => useArrivalFlash(ids, null, 500), { initialProps: { ids: ['a'] } });
      rerender({ ids: ['b', 'a'] });
      expect(result.current.has('b')).toBe(true);
      act(() => { vi.advanceTimersByTime(600); });
      expect(result.current.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
