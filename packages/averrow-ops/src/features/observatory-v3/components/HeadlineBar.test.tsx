import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { HeadlineBar, EMPTY_COPY, type HeadlineBarProps } from './HeadlineBar';
import type { EventsResult, ObservatoryEvent } from '../lib/events';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ev = (id: string, over: Partial<ObservatoryEvent> = {}): ObservatoryEvent => ({
  id, kind: 'fast', severity: 'high', title: `Headline ${id}`, entity: { type: 'domain', id, name: id },
  place: { country_code: 'US', country_name: 'United States', lat: 38, lng: -97 }, count: 1, occurred_at: ago(2), source: 'sentinel',
  target: { lens: 'threats', select: 'country:US' }, ...over,
});
const crit = (id: string) => ev(id, { kind: 'critical', severity: 'critical' });
const result = (events: ObservatoryEvent[], meta: Partial<EventsResult['meta']> = {}, counts: EventsResult['counts'] = {}): EventsResult => ({
  events, counts, meta: { generated_at: null, period: '1h', omitted_kinds: [], capped_kinds: [], failed_kinds: [], ...meta },
});

const onOpenEvent = vi.fn();
const onOpenAll = vi.fn();
const onRetry = vi.fn();
function bar(props: Partial<HeadlineBarProps> & { result: HeadlineBarProps['result'] }) {
  const base: HeadlineBarProps = { result: undefined, loading: false, error: false, onRetry, onOpenEvent, onOpenAll, reducedMotion: false };
  return <HeadlineBar {...base} {...props} />;
}
const title = () => screen.getByTestId('headline-title').textContent;
const announce = () => screen.getByTestId('headline-announce').textContent;
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  onOpenEvent.mockReset(); onOpenAll.mockReset(); onRetry.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('rendering', () => {
  it('shows one event: kind chip, title and relative age', () => {
    render(bar({ result: result([ev('a', { kind: 'fast', occurred_at: ago(3) })]) }));
    expect(title()).toBe('Headline a');
    expect(screen.getByText('FAST')).toBeInTheDocument();
    expect(screen.getByText('3m')).toBeInTheDocument();
    // A single event has nothing to rotate or step through.
    expect(screen.queryByRole('button', { name: 'Next event' })).toBeNull();
    expect(screen.queryByTestId('headline-progress')).toBeNull();
  });

  it('the "All N" pill shows the record total and opens the rail; no handler, no pill', () => {
    const r = result([ev('a'), ev('b')], {}, { critical: 12, fast: 3 });
    const { rerender } = render(bar({ result: r }));
    fireEvent.click(screen.getByRole('button', { name: 'Open all 15 events' }));
    expect(onOpenAll).toHaveBeenCalledTimes(1);
    expect(screen.getByText('All 15 ›')).toBeInTheDocument();
    rerender(bar({ result: r, onOpenAll: undefined }));
    expect(screen.queryByText(/^All /)).toBeNull();
  });

  it('clicking the headline hands the event to the page', () => {
    const e = ev('a');
    render(bar({ result: result([e]) }));
    fireEvent.click(screen.getByRole('button', { name: /Headline a/ }));
    expect(onOpenEvent).toHaveBeenCalledWith(e);
  });

  it('empty feed says so, with the live dot, and offers no controls', () => {
    const { container } = render(bar({ result: result([]) }));
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(EMPTY_COPY).toBe('No new threat events in the last hour');
    expect(container.querySelector('.ev-live-dot')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Pause|Next|Previous/ })).toBeNull();
    expect(screen.queryByText(/^All /)).toBeNull();
  });

  it('loading and failed states do not read as an empty feed', () => {
    const { rerender } = render(bar({ result: undefined, loading: true }));
    expect(screen.getByText('Loading events…')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    rerender(bar({ result: undefined, error: true }));
    expect(screen.getByText('Event feed unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('a partial feed keeps the bar working and says which kinds are missing', () => {
    render(bar({ result: result([ev('a'), ev('b')], { failed_kinds: ['lookalike', 'actor'] }) }));
    const note = screen.getByTestId('events-partial');
    expect(note).toHaveAttribute('title', expect.stringContaining('lookalikes, actors'));
    expect(title()).toBe('Headline a');
    expect(screen.getByRole('button', { name: 'Next event' })).toBeInTheDocument();
  });

  it('shows no second LIVE word (the shell owns the badge)', () => {
    render(bar({ result: result([ev('a')]) }));
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});

describe('rotation', () => {
  it('advances every 6 seconds and wraps', () => {
    render(bar({ result: result([ev('a'), ev('b'), ev('c')]) }));
    expect(title()).toBe('Headline a');
    tick(5_900); expect(title()).toBe('Headline a');
    tick(200); expect(title()).toBe('Headline b');
    tick(6_000); expect(title()).toBe('Headline c');
    tick(6_000); expect(title()).toBe('Headline a');
  });

  it('shows a thin progress bar sized to the hold', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    expect(screen.getByTestId('headline-progress')).toHaveStyle({ animationDuration: '6000ms' });
  });

  it('critical events go first and hold for 12 seconds', () => {
    render(bar({ result: result([ev('a'), crit('x'), ev('b')]) }));
    expect(title()).toBe('Headline x');
    expect(screen.getByTestId('headline-progress')).toHaveStyle({ animationDuration: '12000ms' });
    tick(11_900); expect(title()).toBe('Headline x');
    tick(200); expect(title()).toBe('Headline a');
    expect(screen.getByTestId('headline-progress')).toHaveStyle({ animationDuration: '6000ms' });
  });

  it('a critical event that arrives later jumps the queue at once; the first batch does not', () => {
    const { rerender } = render(bar({ result: result([crit('x'), ev('a'), ev('b')]) }));
    tick(12_000); expect(title()).toBe('Headline a');
    rerender(bar({ result: result([crit('new'), crit('x'), ev('a'), ev('b')]) }));
    expect(title()).toBe('Headline new');
    expect(screen.getByTestId('headline-progress')).toHaveStyle({ animationDuration: '12000ms' });
    // A non-critical arrival does not interrupt.
    rerender(bar({ result: result([crit('new'), crit('x'), ev('fresh'), ev('a'), ev('b')]) }));
    expect(title()).toBe('Headline new');
  });

  it('a critical arrival does not steal the bar from someone holding it', () => {
    const { rerender } = render(bar({ result: result([ev('a'), ev('b')]) }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause rotation' }));
    rerender(bar({ result: result([crit('new'), ev('a'), ev('b')]) }));
    expect(title()).toBe('Headline a');
  });

  it('keeps the current event when the queue refreshes under it, and moves on if it drops out', () => {
    const { rerender } = render(bar({ result: result([ev('a'), ev('b'), ev('c')]) }));
    tick(6_000);
    expect(title()).toBe('Headline b');
    rerender(bar({ result: result([ev('z'), ev('a'), ev('b'), ev('c')]) }));
    expect(title()).toBe('Headline b');
    rerender(bar({ result: result([ev('z'), ev('a'), ev('c')]) }));
    expect(title()).toBe('Headline z');
  });
});

describe('pause and manual stepping', () => {
  it('pause stops the rotation until resumed', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    const pause = screen.getByRole('button', { name: 'Pause rotation' });
    expect(pause).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pause);
    expect(screen.getByRole('button', { name: 'Resume rotation' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('headline-progress')).toBeNull();
    tick(60_000); expect(title()).toBe('Headline a');
    fireEvent.click(screen.getByRole('button', { name: 'Resume rotation' }));
    tick(6_100); expect(title()).toBe('Headline b');
  });

  it('hover holds the bar and the hold restarts when the pointer leaves', () => {
    const { container } = render(bar({ result: result([ev('a'), ev('b')]) }));
    const root = container.querySelector('section')!;
    tick(4_000);
    fireEvent.mouseEnter(root);
    tick(60_000); expect(title()).toBe('Headline a');
    expect(screen.queryByTestId('headline-progress')).toBeNull();
    fireEvent.mouseLeave(root);
    tick(5_900); expect(title()).toBe('Headline a'); // a fresh 6s, not the 2s that were left
    tick(200); expect(title()).toBe('Headline b');
  });

  it('keyboard focus inside the bar holds it; leaving releases it', () => {
    const { container } = render(bar({ result: result([ev('a'), ev('b')]) }));
    const next = screen.getByRole('button', { name: 'Next event' });
    fireEvent.focus(next);
    tick(60_000); expect(title()).toBe('Headline a');
    fireEvent.blur(next, { relatedTarget: document.body });
    expect(container.querySelector('section')).not.toBeNull();
    tick(6_100); expect(title()).toBe('Headline b');
  });

  it('previous and next step by hand, with wrap-around', () => {
    render(bar({ result: result([ev('a'), ev('b'), ev('c')]) }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous event' }));
    expect(title()).toBe('Headline c');
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    expect(title()).toBe('Headline a');
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    expect(title()).toBe('Headline b');
    expect(screen.getByLabelText('Event 2 of 3')).toBeInTheDocument();
  });

  it('does not rotate in a hidden tab', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    tick(60_000); expect(title()).toBe('Headline a');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    tick(6_100); expect(title()).toBe('Headline b');
  });
});

describe('screen readers', () => {
  it('announces each event once, politely, in its own region (not the ticking visible text)', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    const region = screen.getByTestId('headline-announce');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(announce()).toBe('Fast weaponization: Headline a');
    tick(6_100);
    expect(announce()).toBe('Fast weaponization: Headline b');
    // Round the loop to 'a' again: it was already announced, so the region is left alone.
    tick(6_000);
    expect(title()).toBe('Headline a');
    expect(announce()).toBe('Fast weaponization: Headline b');
    // The visible headline is not itself a live region.
    expect(screen.getByRole('button', { name: /Headline a/ }).closest('[aria-live]')).toBeNull();
  });

  it('stepping by hand to an event already heard announces it again', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    tick(6_100);
    fireEvent.click(screen.getByRole('button', { name: 'Previous event' }));
    expect(title()).toBe('Headline a');
    expect(announce()).toBe('Fast weaponization: Headline a');
  });

  it('names the kind in words for a critical threat', () => {
    render(bar({ result: result([crit('x')]) }));
    expect(announce()).toBe('Critical threat: Headline x');
  });
});

describe('reduced motion', () => {
  it('never advances or jumps by itself; stepping is manual; no slide, no progress bar, no pause button', () => {
    const { rerender } = render(bar({ result: result([ev('a'), ev('b')]), reducedMotion: true }));
    expect(screen.getByRole('button', { name: /Headline a/ }).className).not.toMatch(/ev-hl-enter/);
    expect(screen.queryByTestId('headline-progress')).toBeNull();
    expect(screen.queryByRole('button', { name: /Pause rotation|Resume rotation/ })).toBeNull();
    tick(120_000); expect(title()).toBe('Headline a');
    rerender(bar({ result: result([crit('new'), ev('a'), ev('b')]), reducedMotion: true }));
    expect(title()).toBe('Headline a'); // silent: no jump
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    expect(title()).toBe('Headline b');
    expect(within(screen.getByLabelText('Live threat events')).getByLabelText(/Event \d of 3/)).toBeInTheDocument();
  });

  it('motion on: the headline slides in', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    expect(screen.getByRole('button', { name: /Headline a/ }).className).toMatch(/ev-hl-enter/);
  });
});
