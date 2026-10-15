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
// jsdom has no PointerEvent, so a pointer's type is stamped on a plain event; React reads `pointerType` and derives
// pointerenter / pointerleave from pointerover / pointerout (entering from, and leaving to, outside the tree).
function pointer(el: Element, type: 'pointerover' | 'pointerout', pointerType: string) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  Object.defineProperty(e, 'relatedTarget', { value: null });
  act(() => { el.dispatchEvent(e); });
}
const pointerIn = (el: Element, pointerType: string) => pointer(el, 'pointerover', pointerType);
const pointerOut = (el: Element, pointerType: string) => pointer(el, 'pointerout', pointerType);

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

  it('the "All N" pill counts events (records in its title) and opens the rail; no handler, no pill', () => {
    const r = result([ev('a'), ev('b')], {}, { critical: 12, fast: 3 });
    const { rerender } = render(bar({ result: r }));
    fireEvent.click(screen.getByRole('button', { name: 'Open all 2 events' }));
    expect(onOpenAll).toHaveBeenCalledTimes(1);
    // The pill counts the events the rail lists; its title adds the underlying record total.
    const pill = screen.getByText('All 2 events ›');
    expect(pill.closest('button')).toHaveAttribute('title', '2 events · 15 records');
    rerender(bar({ result: r, onOpenAll: undefined }));
    expect(screen.queryByText(/^All /)).toBeNull();
  });

  it('on the phone band the pill stays short', () => {
    render(bar({ result: result([ev('a'), ev('b')], {}, { critical: 12, fast: 3 }), phone: true }));
    expect(screen.getByText('All 2 ›')).toBeInTheDocument();
  });

  it('the live dot is decoration: hidden from assistive tech', () => {
    const { container } = render(bar({ result: result([ev('a')]) }));
    const dot = container.querySelector('.ev-live-dot')!;
    expect(dot.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('sets the leading entity name bold', () => {
    render(bar({ result: result([ev('a', { title: 'Acme Bank targeted by 12 new phishing pages', entity: { type: 'brand', id: 'b', name: 'Acme Bank' } })]) }));
    expect(screen.getByText('Acme Bank').tagName).toBe('STRONG');
    expect(title()).toBe('Acme Bank targeted by 12 new phishing pages');
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
    // The server window is [top of the hour - 1h, now], i.e. one to two hours: never "the last hour".
    expect(EMPTY_COPY).toBe('No new threat events in the past hour or so');
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
    expect(note).toHaveAccessibleName(/PARTIAL — lookalikes, actors could not be loaded/);
    expect(title()).toBe('Headline a');
    expect(screen.getByRole('button', { name: 'Next event' })).toBeInTheDocument();
  });

  it('no events AND failed kinds never reads as a quiet feed (some kinds failed, or every kind did)', () => {
    const { rerender } = render(bar({ result: result([], { failed_kinds: ['critical'] }) }));
    expect(screen.getByTestId('events-failed')).toHaveTextContent('Event feed partly unavailable (critical could not be loaded)');
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalled();
    rerender(bar({ result: result([], { failed_kinds: ['critical', 'operation', 'fast', 'lookalike', 'takedown', 'actor', 'spike'] }) }));
    expect(screen.getByTestId('events-failed')).toHaveTextContent('Event feed unavailable');
    expect(screen.getByTestId('events-failed')).not.toHaveTextContent('partly');
    expect(screen.queryByTestId('events-empty')).toBeNull();
  });

  it('the PARTIAL tag is focusable and shows the kinds on screen when activated', () => {
    render(bar({ result: result([ev('a'), ev('b')], { failed_kinds: ['lookalike', 'actor'] }) }));
    const note = screen.getByTestId('events-partial');
    expect(note.tagName).toBe('BUTTON');
    note.focus();
    expect(note).toHaveFocus();
    expect(note).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(note);
    expect(note).toHaveAttribute('aria-expanded', 'true');
    expect(note).toHaveTextContent('· lookalikes, actors');
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

  it('a mouse over the bar holds it, shows a "Held" cue and dims the track; the hold restarts when the mouse leaves', () => {
    const { container } = render(bar({ result: result([ev('a'), ev('b')]) }));
    const root = container.querySelector('section')!;
    tick(4_000);
    expect(screen.queryByTestId('headline-held')).toBeNull();
    pointerIn(root, 'mouse');
    expect(screen.getByTestId('headline-held')).toHaveTextContent('Held');
    expect(screen.getByTestId('headline-held-track')).toBeInTheDocument();
    tick(60_000); expect(title()).toBe('Headline a');
    expect(screen.queryByTestId('headline-progress')).toBeNull();
    pointerOut(root, 'mouse');
    expect(screen.queryByTestId('headline-held')).toBeNull();
    expect(screen.queryByTestId('headline-held-track')).toBeNull();
    tick(5_900); expect(title()).toBe('Headline a'); // a fresh 6s, not the 2s that were left
    tick(200); expect(title()).toBe('Headline b');
  });

  it('a tap (touch / pen pointer) never holds the bar: rotation carries on after it', () => {
    const { container } = render(bar({ result: result([ev('a'), ev('b'), ev('c')]) }));
    const root = container.querySelector('section')!;
    pointerIn(root, 'touch');
    pointerIn(root, 'pen');
    expect(screen.queryByTestId('headline-held')).toBeNull();
    tick(6_100); expect(title()).toBe('Headline b');
  });

  it('clicking prev / next does not freeze the bar: the button keeps focus but that is not keyboard focus', () => {
    render(bar({ result: result([ev('a'), ev('b'), ev('c')]) }));
    const prev = screen.getByRole('button', { name: 'Previous event' });
    // A mouse click focuses the button without :focus-visible.
    const matches = Element.prototype.matches;
    const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
      return sel === ':focus-visible' ? false : matches.call(this, sel);
    });
    try {
      act(() => prev.focus());
      fireEvent.click(prev);
      expect(title()).toBe('Headline c');
      expect(screen.queryByTestId('headline-held')).toBeNull();
      tick(6_100); expect(title()).toBe('Headline a'); // rotation resumed past the manual step
    } finally {
      spy.mockRestore();
    }
  });

  it('keyboard focus (:focus-visible) inside the bar holds it with a "Held" cue; leaving releases it', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    const next = screen.getByRole('button', { name: 'Next event' });
    const matches = Element.prototype.matches;
    const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
      return sel === ':focus-visible' ? true : matches.call(this, sel);
    });
    try {
      act(() => next.focus());
      expect(screen.getByTestId('headline-held')).toBeInTheDocument();
      tick(60_000); expect(title()).toBe('Headline a');
      fireEvent.blur(next, { relatedTarget: document.body });
      expect(screen.queryByTestId('headline-held')).toBeNull();
      tick(6_100); expect(title()).toBe('Headline b');
    } finally {
      spy.mockRestore();
    }
  });

  it('pausing by hand shows no "Held" cue (the pause button already says so)', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause rotation' }));
    expect(screen.queryByTestId('headline-held')).toBeNull();
  });

  it('previous and next step by hand, with wrap-around', () => {
    render(bar({ result: result([ev('a'), ev('b'), ev('c')]) }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous event' }));
    expect(title()).toBe('Headline c');
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    expect(title()).toBe('Headline a');
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    expect(title()).toBe('Headline b');
    // The index reads as one phrase to a screen reader; the visible "2 / 3" is hidden from it.
    expect(screen.getByText('Event 2 of 3')).toHaveClass('sr-only');
    expect(screen.getByText('2 / 3')).toHaveAttribute('aria-hidden', 'true');
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
  it('announces critical events (once) in their own polite region, not ordinary rotation', () => {
    render(bar({ result: result([ev('a'), crit('x'), ev('b')]) }));
    const region = screen.getByTestId('headline-announce');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    // The queue opens on the critical event.
    expect(announce()).toBe('Critical threat: Headline x');
    // Ordinary headlines rotate by without a word.
    tick(12_100);
    expect(title()).toBe('Headline a');
    expect(announce()).toBe('Critical threat: Headline x');
    tick(6_000); expect(title()).toBe('Headline b');
    expect(announce()).toBe('Critical threat: Headline x');
    // Round the loop to the critical event again: heard already, so the region is left alone.
    tick(6_000); expect(title()).toBe('Headline x');
    expect(announce()).toBe('Critical threat: Headline x');
    // The visible headline is not itself a live region.
    expect(screen.getByRole('button', { name: /Headline x/ }).closest('[aria-live]')).toBeNull();
  });

  it('a feed with no critical event is silent while it rotates', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    expect(announce()).toBe('');
    tick(6_100); expect(title()).toBe('Headline b');
    expect(announce()).toBe('');
  });

  it('stepping by hand announces the event you stepped to, even one already heard', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    expect(announce()).toBe('Fast weaponization: Headline b');
    fireEvent.click(screen.getByRole('button', { name: 'Previous event' }));
    expect(announce()).toBe('Fast weaponization: Headline a');
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    expect(announce()).toBe('Fast weaponization: Headline b');
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
    expect(within(screen.getByLabelText('Live threat events')).getByText(/Event \d of 3/)).toBeInTheDocument();
  });

  it('motion on: the headline slides in', () => {
    render(bar({ result: result([ev('a'), ev('b')]) }));
    expect(screen.getByRole('button', { name: /Headline a/ }).className).toMatch(/ev-hl-enter/);
  });
});
