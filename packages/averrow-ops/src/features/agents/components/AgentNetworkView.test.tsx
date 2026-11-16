// Network view: shared hover between the canvas and the tape, the
// reduced-motion path (no frames, no particles), the frame loop pausing when
// the tab is hidden, and the empty / error timeline states.

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { AgentNetworkView } from './AgentNetworkView';
import {
  AGENTS_FIXTURE, FEEDS_FIXTURE, TIMELINE_FIXTURE,
} from '../network/fixtures';
import { computeLayout, placeAgents } from '../network/model';
import { buildTapeLanes, tapeGeometry } from '../network/tape';
import { indexTimeline } from '../network/activity';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

// ── canvas stub: a 2D context that records arcs ───────────────────────
const arcs: number[][] = [];
const texts: string[] = [];
const dashes: number[][] = [];
function stubContext(): CanvasRenderingContext2D {
  const base: Record<string, unknown> = {
    measureText: (t: string) => ({ width: t.length * 6 }),
    arc: (...a: number[]) => { arcs.push(a); },
    fillText: (s: string) => { texts.push(s); },
    setLineDash: (a: number[]) => { dashes.push(a); },
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
    set: (t, k, v) => { t[k as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}
/** Particle cores are the only arcs drawn with radius 2.2. */
const particleArcs = () => arcs.filter((a) => a[2] === 2.2).length;

let frames: Array<() => void> = [];
let reduced = false;

function installMatchMedia() {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('reduce'),
    media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function mockApi(timeline: 'ok' | 'error' | 'empty' = 'ok') {
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/feeds/overview')) return { success: true, data: FEEDS_FIXTURE };
    if (path.startsWith('/api/agents/timeline')) {
      if (timeline === 'error') return { success: false, error: 'boom' };
      if (timeline === 'empty') {
        return { success: true, data: { ...TIMELINE_FIXTURE, runs: [], pulls: [], events: [] } };
      }
      return { success: true, data: TIMELINE_FIXTURE };
    }
    return { success: true, data: [] };
  });
}

function pointer(el: Element, x: number, y: number, type = 'pointermove') {
  fireEvent(el, new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

beforeEach(() => {
  arcs.length = 0;
  texts.length = 0;
  dashes.length = 0;
  frames = [];
  reduced = false;
  installMatchMedia();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => stubContext());
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(() => cb(performance.now()));
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  mockApi('ok');
});
afterEach(() => { vi.restoreAllMocks(); });

const renderView = (onSelect = vi.fn(), selected: string | null = null) =>
  renderWithProviders(<AgentNetworkView agents={AGENTS_FIXTURE} selectedAgent={selected} onSelect={onSelect} />);

const flow = () => screen.getByTestId('flow-canvas');
const flowCanvas = () => flow().querySelector('canvas') as HTMLCanvasElement;
const tapeCanvas = async () => (await screen.findByTestId('run-tape')).querySelector('canvas') as HTMLCanvasElement;
const runFrame = () => act(() => { frames.shift()?.(); });

describe('AgentNetworkView', () => {
  it('draws the structure immediately and the tape once the timeline arrives', async () => {
    renderView();
    expect(flowCanvas()).toBeInTheDocument();
    expect(await tapeCanvas()).toBeInTheDocument();
  });

  it('lists every canvas agent and its state in text for screen readers', async () => {
    renderView();
    await tapeCanvas();
    const list = screen.getByRole('list', { name: 'Agents and their current state', hidden: true });
    expect(list).toHaveTextContent('Sentinel: idle');
    await waitFor(() => expect(list).toHaveTextContent('Cartographer: running'));
    expect(list).toHaveTextContent('Attributor: last run failed');
  });

  it('collapses retired agents behind a chip and lists on-demand agents in a rail', async () => {
    const onSelect = vi.fn();
    renderView(onSelect);
    await tapeCanvas();
    expect(screen.queryByText('Brand Report')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retired \(10\)/ }));
    const retiredChip = await screen.findAllByRole('button');
    expect(retiredChip.length).toBeGreaterThan(10);
    fireEvent.click(screen.getByRole('button', { name: 'Pathfinder' }));
    expect(onSelect).toHaveBeenCalledWith('pathfinder');
  });

  it('click on a canvas node selects that agent', async () => {
    const onSelect = vi.fn();
    renderView(onSelect);
    await tapeCanvas();
    const layout = computeLayout({
      width: 1000, placement: placeAgents(AGENTS_FIXTURE), feeds: FEEDS_FIXTURE, labelOf: (id) => id,
    });
    const n = layout.nodes.observer!;
    pointer(flowCanvas(), n.x, n.y, 'click');
    expect(onSelect).toHaveBeenCalledWith('observer');
  });

  describe('shared hover', () => {
    it('lights the tape lane when a canvas node is hovered', async () => {
      renderView();
      const tape = await tapeCanvas();
      const layout = computeLayout({
        width: 1000, placement: placeAgents(AGENTS_FIXTURE), feeds: FEEDS_FIXTURE, labelOf: (id) => id,
      });
      const n = layout.nodes.nexus!;
      pointer(flowCanvas(), n.x, n.y);
      expect(screen.getByTestId('agent-network')).toHaveAttribute('data-hover', 'nexus');
      expect(flow()).toHaveAttribute('data-hover', 'nexus');
      expect(tape.parentElement).toHaveAttribute('data-hover', 'nexus');
      fireEvent(flowCanvas(), new MouseEvent('pointerout', { bubbles: true }));
      expect(screen.getByTestId('agent-network')).toHaveAttribute('data-hover', '');
    });

    it('lights the canvas node when a tape bar is hovered', async () => {
      renderView();
      const tape = await tapeCanvas();
      const placement = placeAgents(AGENTS_FIXTURE);
      const index = indexTimeline(TIMELINE_FIXTURE, FEEDS_FIXTURE);
      const { lanes } = buildTapeLanes(placement, index, (id) => id);
      const li = lanes.findIndex((l) => l.id === 'sparrow');
      const g = tapeGeometry(1000, lanes.length, Date.parse(TIMELINE_FIXTURE.generated_at));
      pointer(tape, g.gx + 5, g.top + li * g.lh + g.lh / 2);
      expect(flow()).toHaveAttribute('data-hover', 'sparrow');
      expect(tape.parentElement).toHaveAttribute('data-hover', 'sparrow');
    });

    it('maps a feed dot to its group lane on the tape', async () => {
      renderView();
      const tape = await tapeCanvas();
      const layout = computeLayout({
        width: 1000, placement: placeAgents(AGENTS_FIXTURE), feeds: FEEDS_FIXTURE, labelOf: (id) => id,
      });
      const dot = layout.dots.find((d) => d.name === 'reddit')!;
      pointer(flowCanvas(), dot.x, dot.y);
      expect(tape.parentElement).toHaveAttribute('data-hover', 'feeds:social');
    });
  });

  describe('motion', () => {
    it('animates and draws particles while an upstream run is live', async () => {
      renderView();
      await tapeCanvas();
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      arcs.length = 0;
      runFrame();
      expect(particleArcs()).toBeGreaterThan(0);
    });

    it('under reduced motion requests no frames and draws no particles', async () => {
      reduced = true;
      installMatchMedia();
      renderView();
      await tapeCanvas();
      // Let the timeline-driven redraw settle, then check nothing animates.
      await waitFor(() => expect(arcs.length).toBeGreaterThan(0));
      expect(frames).toHaveLength(0);
      expect(window.requestAnimationFrame).not.toHaveBeenCalled();
      expect(particleArcs()).toBe(0);
    });

    it('cancels its frames and requests no more while the tab is hidden', async () => {
      const raf = window.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>;
      const caf = window.cancelAnimationFrame as unknown as ReturnType<typeof vi.fn>;
      renderView();
      await tapeCanvas();
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(caf).toHaveBeenCalled();
        const requested = raf.mock.calls.length;
        // The queued frame was cancelled (a browser would never run it); nothing new is requested.
        await new Promise((r) => setTimeout(r, 20));
        expect(raf.mock.calls.length).toBe(requested);
      } finally {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      }
    });

    it('observes both canvases for visibility, including the tape that mounts after the data', async () => {
      const observed: Element[] = [];
      vi.stubGlobal('IntersectionObserver', class {
        observe(el: Element) { observed.push(el); }
        disconnect() {}
        unobserve() {}
      });
      try {
        renderView();
        const tape = await tapeCanvas();
        await waitFor(() => expect(observed).toContain(tape));
        expect(observed).toContain(flowCanvas());
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('Pause switches both canvases to the static path and Play resumes', async () => {
      renderView();
      await tapeCanvas();
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      const raf = window.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>;
      fireEvent.click(screen.getByRole('button', { name: 'Turn animation off' }));
      const play = screen.getByRole('button', { name: 'Turn animation on' });
      const requested = raf.mock.calls.length;
      arcs.length = 0;
      await new Promise((r) => setTimeout(r, 20));
      expect(raf.mock.calls.length).toBe(requested);
      expect(particleArcs()).toBe(0);
      fireEvent.click(play);
      await waitFor(() => expect(raf.mock.calls.length).toBeGreaterThan(requested));
    });

    it('disables Pause (aria-disabled, stays focusable) under the OS reduced-motion setting', async () => {
      reduced = true;
      installMatchMedia();
      renderView();
      await tapeCanvas();
      const btn = screen.getByRole('button', { name: 'Turn animation on' });
      expect(btn).toHaveAttribute('aria-disabled', 'true');
      expect(btn).not.toBeDisabled();
    });
  });

  describe('keyboard and assistive tech', () => {
    it('focusing a node button highlights it on both canvases; blur clears it', async () => {
      renderView();
      await tapeCanvas();
      const btn = screen.getByRole('button', { name: /^Observer: / });
      act(() => btn.focus());
      expect(screen.getByTestId('agent-network')).toHaveAttribute('data-hover', 'observer');
      expect(btn).toHaveAttribute('aria-pressed', 'false');
      act(() => btn.blur());
      expect(screen.getByTestId('agent-network')).toHaveAttribute('data-hover', '');
    });

    it('marks the selected agent as pressed', async () => {
      renderView(vi.fn(), 'nexus');
      await tapeCanvas();
      expect(screen.getByRole('button', { name: /^NEXUS: / })).toHaveAttribute('aria-pressed', 'true');
    });

    it('gives the run tape a text equivalent with runs and a select button per agent lane', async () => {
      const onSelect = vi.fn();
      renderView(onSelect);
      await tapeCanvas();
      const list = screen.getByRole('list', { name: 'Runs in the last hour, by lane', hidden: true });
      expect(list).toHaveTextContent('Cartographer');
      expect(list).toHaveTextContent(/running, started \d\d:\d\d UTC/);
      expect(list).toHaveTextContent(/failed, started/);
      const btn = within(list).getByRole('button', { name: 'Sparrow' });
      fireEvent.click(btn);
      expect(onSelect).toHaveBeenCalledWith('sparrow');
    });

    it('makes both scroll containers focusable named regions', async () => {
      renderView();
      await tapeCanvas();
      const map = screen.getByRole('region', { name: /data-flow map/i });
      expect(map).toHaveAttribute('tabindex', '0');
      const tape = screen.getByRole('region', { name: /Run tape/ });
      expect(tape).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('heading', { name: /Run tape/ })).toBeInTheDocument();
    });

    it('lists the legend as a list including the partial-run entry', async () => {
      renderView();
      await tapeCanvas();
      const legend = screen.getByRole('list', { name: 'Legend' });
      expect(within(legend).getAllByRole('listitem').length).toBeGreaterThanOrEqual(6);
      expect(legend).toHaveTextContent('Partial run');
    });

    it('zoom buttons use aria-disabled so a focused button keeps focus', async () => {
      renderView();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: /Zoom out/ }));
      fireEvent.click(screen.getByRole('button', { name: /Zoom out/ }));
      const out = screen.getByRole('button', { name: /Zoom out \(60%\)/ });
      act(() => out.focus());
      fireEvent.click(out);
      expect(out).toHaveAttribute('aria-disabled', 'true');
      expect(out).not.toBeDisabled();
      expect(document.activeElement).toBe(out);
    });
  });

  describe('full screen', () => {
    it('is a modal dialog: focus on the exit button, body scroll locked, Escape closes', async () => {
      renderView();
      await tapeCanvas();
      const toggle = screen.getByRole('button', { name: 'Full screen' });
      fireEvent.click(toggle);
      const dialog = await screen.findByRole('dialog', { name: /full screen/i });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(document.body.style.overflow).toBe('hidden');
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Exit full screen' })));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(document.body.style.overflow).toBe('');
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Full screen' }));
    });
  });

  describe('full screen portal, focus trap and selection', () => {
    const renderInCard = (onSelect = vi.fn()) => renderWithProviders(
      <div data-testid="card" style={{ overflow: 'hidden', backdropFilter: 'blur(4px)' }}>
        <AgentNetworkView agents={AGENTS_FIXTURE} selectedAgent={null} onSelect={onSelect} />
      </div>,
    );

    it('renders the overlay in <body>, outside a clipping Card ancestor', async () => {
      renderInCard();
      await tapeCanvas();
      expect(within(screen.getByTestId('card')).queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      const dialog = await screen.findByRole('dialog', { name: /full screen/i });
      expect(dialog.parentElement).toBe(document.body);
      expect(screen.getByTestId('card').contains(dialog)).toBe(false);
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('traps Tab inside the dialog in both directions', async () => {
      renderInCard();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      const dialog = await screen.findByRole('dialog', { name: /full screen/i });
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])'));
      const first = items[0]!;
      const last = items[items.length - 1]!;
      act(() => last.focus());
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(document.activeElement).toBe(first);
      act(() => first.focus());
      fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
    });

    it('selecting an agent in full screen leaves full screen first, then selects', async () => {
      const onSelect = vi.fn();
      renderInCard(onSelect);
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      await screen.findByRole('dialog', { name: /full screen/i });
      fireEvent.click(screen.getByRole('button', { name: 'Pathfinder' }));
      expect(onSelect).toHaveBeenCalledWith('pathfinder');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(document.body.style.overflow).toBe('');
    });
  });

  describe('live chip', () => {
    it('shows Live with the data-as-of tooltip', async () => {
      renderView();
      await tapeCanvas();
      const chip = screen.getByTestId('live-chip');
      expect(chip).toHaveAttribute('data-state', 'live');
      expect(chip).toHaveTextContent(/Live · data .+ old/);
      expect(chip.getAttribute('title')).toMatch(/^Data as of 06:12:30 UTC · checked \d\d:\d\d:\d\d UTC$/);
    });

    it('says animation off for the control, not Paused', async () => {
      renderView();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: 'Turn animation off' }));
      expect(screen.getByTestId('live-chip')).toHaveAttribute('data-state', 'animation-off');
      expect(screen.getByTestId('live-chip')).toHaveTextContent(/Live · animation off · data/);
      expect(screen.getByTestId('live-chip-status')).toHaveTextContent('Live, animation off');
    });

    it('says animation off (system setting) under the OS reduced-motion setting', async () => {
      reduced = true;
      installMatchMedia();
      renderView();
      await tapeCanvas();
      expect(screen.getByTestId('live-chip')).toHaveAttribute('data-state', 'animation-off-system');
      expect(screen.getByTestId('live-chip')).toHaveTextContent(/animation off \(system setting\)/);
    });

    it('says Offline, with the detail message, when there is no payload', async () => {
      mockApi('error');
      renderView();
      await screen.findByText(/Live timeline unavailable/);
      expect(screen.getByTestId('live-chip')).toHaveAttribute('data-state', 'offline');
      expect(screen.getByTestId('live-chip')).toHaveTextContent('Offline');
    });
  });

  describe('replay', () => {
    const NOW_MS = Date.parse(TIMELINE_FIXTURE.generated_at);
    const axisX = (ms: number) => tapeGeometry(640, 20, NOW_MS).x(ms);
    const chip = () => screen.getByTestId('live-chip');
    const slider = () => screen.getByRole('slider', { name: 'Replay position' });
    const scrubTo = async (ms: number) => {
      await tapeCanvas();
      const slider = screen.getByRole('slider', { name: 'Replay position' });
      pointer(slider, axisX(ms), 10, 'pointerdown');
      pointer(slider, axisX(ms), 10, 'pointerup');
    };

    it('enters from the Replay button at the start of the window, with transport controls', async () => {
      renderView();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: /Replay last hour/ }));
      expect(chip()).toHaveAttribute('data-state', 'replay');
      expect(chip()).toHaveTextContent('Replay · 05:12 UTC');
      const controls = screen.getByTestId('replay-controls');
      for (const s of ['1×', '10×', '60×']) expect(within(controls).getByRole('button', { name: `${s.replace('×', '')} times speed` })).toBeInTheDocument();
      expect(within(controls).getByRole('button', { name: 'Back to live' })).toBeInTheDocument();
      expect(within(controls).getByRole('button', { name: 'Pause replay' })).toBeInTheDocument();
      expect(within(controls).getByRole('button', { name: '10 times speed' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('scrubbing the tape axis enters replay at that time, paused', async () => {
      renderView();
      await scrubTo(NOW_MS - 30 * 60_000);
      expect(chip()).toHaveTextContent('Replay · 05:42 UTC');
      expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();
    });

    it('steps with the arrow keys (Shift = 10 s) and clamps at the end of the data', async () => {
      renderView();
      await scrubTo(NOW_MS - 30 * 60_000); // 05:42:30
      fireEvent.keyDown(slider(), { key: 'ArrowRight' });
      expect(chip()).toHaveTextContent('Replay · 05:43 UTC');
      fireEvent.keyDown(slider(), { key: 'ArrowLeft', shiftKey: true }); // 05:43:20
      fireEvent.keyDown(slider(), { key: 'ArrowLeft' }); // 05:42:20
      expect(chip()).toHaveTextContent('Replay · 05:42 UTC');
      for (let i = 0; i < 40; i++) fireEvent.keyDown(slider(), { key: 'ArrowRight' });
      expect(screen.getByTestId('replay-controls')).toHaveTextContent('End of data');
      expect(chip()).toHaveTextContent('Replay · 06:12 UTC');
      expect(screen.getByTestId('replay-controls')).toHaveTextContent('End of data');
    });

    it('Space toggles replay play and pause', async () => {
      renderView();
      await scrubTo(NOW_MS - 30 * 60_000);
      fireEvent.keyDown(slider(), { key: ' ' });
      expect(screen.getByRole('button', { name: 'Pause replay' })).toBeInTheDocument();
      fireEvent.keyDown(slider(), { key: ' ' });
      expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();
    });

    it('speed only scales how far the clock moves per frame', async () => {
      let perf = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => perf);
      renderView();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: /Replay last hour/ })); // playing at 10x from 05:12:30
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      perf = 1200; // 200 ms of wall time
      const runFrames = () => act(() => { frames.splice(0).forEach((f) => f()); });
      runFrames(); // the clock tick, then
      runFrames(); // the redraw that reads it
      expect(texts).toContain('05:12:32'); // +2 s = 200 ms x 10
      fireEvent.click(screen.getByRole('button', { name: '60 times speed' }));
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      perf = 1400; // another 200 ms at 60x = +12 s
      texts.length = 0;
      runFrames();
      runFrames();
      expect(texts.some((s) => /^05:12:[45]\d$/.test(s))).toBe(true);
    });

    it('a background refetch does not move the playhead; Back to live picks it up', async () => {
      renderView();
      await scrubTo(NOW_MS - 30 * 60_000);
      expect(chip()).toHaveTextContent('Replay · 05:42 UTC');
      const later = new Date(NOW_MS + 5 * 60_000).toISOString();
      get.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/feeds/overview')) return { success: true, data: FEEDS_FIXTURE };
        if (path.startsWith('/api/agents/timeline')) return { success: true, data: { ...TIMELINE_FIXTURE, generated_at: later, window_end: later } };
        return { success: true, data: [] };
      });
      act(() => { window.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => expect(screen.getByTestId('live-chip-badge')).toHaveTextContent('New data'));
      expect(chip()).toHaveTextContent('Replay · 05:42 UTC');
      expect(screen.getByTestId('live-chip-status')).toHaveTextContent('new data available');
      fireEvent.click(screen.getByRole('button', { name: 'Back to live' }));
      expect(chip()).toHaveAttribute('data-state', 'live');
      expect(chip().getAttribute('title')).toContain('Data as of 06:17:30 UTC');
    });

    it('Play is disabled under reduced motion, but scrubbing and stepping still work', async () => {
      reduced = true;
      installMatchMedia();
      renderView();
      await scrubTo(NOW_MS - 30 * 60_000);
      const play = screen.getByRole('button', { name: 'Play replay' });
      expect(play).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(play);
      expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();
      fireEvent.keyDown(slider(), { key: 'ArrowRight' });
      expect(chip()).toHaveTextContent('Replay · 05:43 UTC');
      expect(frames).toHaveLength(0);
    });

    it('draws the map at the playhead: tooltips say "at HH:MM UTC"', async () => {
      renderView();
      await scrubTo(NOW_MS - 30 * 60_000);
      const layout = computeLayout({
        width: 1000, placement: placeAgents(AGENTS_FIXTURE), feeds: FEEDS_FIXTURE, labelOf: (id) => id,
      });
      const n = layout.nodes.observer!;
      texts.length = 0;
      pointer(flowCanvas(), n.x, n.y);
      await waitFor(() => {
        act(() => { frames.splice(0).forEach((f) => f()); });
        expect(texts.some((s) => /·\s+at 05:42 UTC$/.test(s))).toBe(true);
      });
    });

    it('fullscreen keeps every replay control', async () => {
      renderView();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      const dialog = await screen.findByRole('dialog', { name: /full screen/i });
      fireEvent.click(within(dialog).getByRole('button', { name: /Replay last hour/ }));
      expect(within(dialog).getByTestId('replay-controls')).toBeInTheDocument();
      expect(within(dialog).getByTestId('live-chip')).toHaveAttribute('data-state', 'replay');
    });
  });

  describe('replay focus, slider and keys', () => {
    const NOW_MS = Date.parse(TIMELINE_FIXTURE.generated_at);
    const axisX = (ms: number) => tapeGeometry(640, 20, NOW_MS).x(ms);
    const slider = () => screen.getByRole('slider', { name: 'Replay position' });
    const chip = () => screen.getByTestId('live-chip');
    const runFrames = () => act(() => { frames.splice(0).forEach((f) => f()); });
    const mid = NOW_MS - 30 * 60_000; // 05:42:30

    it('moves focus to Play/Pause on entering replay and back to Replay on Back to live', async () => {
      renderView();
      await tapeCanvas();
      const start = screen.getByRole('button', { name: /Replay last hour/ });
      act(() => start.focus());
      fireEvent.click(start);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /(Pause|Play) replay/ })));
      fireEvent.click(screen.getByRole('button', { name: 'Back to live' }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Replay last hour/ })));
    });

    it('focuses the slider when a scrub or a slider key enters replay', async () => {
      renderView();
      await tapeCanvas();
      pointer(slider(), axisX(mid), 10, 'pointerdown');
      pointer(slider(), axisX(mid), 10, 'pointerup');
      await waitFor(() => expect(document.activeElement).toBe(slider()));
    });

    it('keeps the fullscreen focus trap and Escape working across enter and exit', async () => {
      renderView();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      const dialog = await screen.findByRole('dialog', { name: /full screen/i });
      fireEvent.click(within(dialog).getByRole('button', { name: /Replay last hour/ }));
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      expect(document.activeElement).not.toBe(document.body);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Back to live' }));
      await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: /Replay last hour/ })));
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('exposes a slider with value text and moves with the keys', async () => {
      renderView();
      await tapeCanvas();
      const s = slider();
      expect(s).toHaveAttribute('aria-orientation', 'horizontal');
      pointer(s, axisX(mid), 10, 'pointerdown');
      pointer(s, axisX(mid), 10, 'pointerup');
      expect(s).toHaveAttribute('aria-valuetext', '05:42:30 UTC');
      expect(Number(s.getAttribute('aria-valuemin'))).toBeLessThan(Number(s.getAttribute('aria-valuenow')));
      expect(Number(s.getAttribute('aria-valuemax'))).toBeGreaterThan(Number(s.getAttribute('aria-valuenow')));
      fireEvent.keyDown(s, { key: 'ArrowRight' });
      expect(s).toHaveAttribute('aria-valuetext', '05:43:30 UTC');
      fireEvent.keyDown(s, { key: 'ArrowLeft', shiftKey: true });
      expect(s).toHaveAttribute('aria-valuetext', '05:43:20 UTC');
      fireEvent.keyDown(s, { key: 'End' });
      expect(s).toHaveAttribute('aria-valuetext', '06:12:30 UTC');
      fireEvent.keyDown(s, { key: 'Home' });
      expect(s.getAttribute('aria-valuetext')).toMatch(/^05:12:/);
    });

    it('a first slider key from live enters replay near the newest data', async () => {
      renderView();
      await tapeCanvas();
      fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
      expect(chip()).toHaveAttribute('data-state', 'replay');
      expect(chip()).toHaveTextContent('Replay · 06:11 UTC');
    });

    it('leaves modified keys and the scroll regions alone', async () => {
      renderView();
      await tapeCanvas();
      pointer(slider(), axisX(mid), 10, 'pointerdown');
      pointer(slider(), axisX(mid), 10, 'pointerup');
      const text = slider().getAttribute('aria-valuetext');
      for (const mod of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        // fireEvent returns false when the event was default-prevented
        expect(fireEvent.keyDown(slider(), { key: 'ArrowRight', ...mod })).toBe(true);
      }
      expect(slider()).toHaveAttribute('aria-valuetext', text!);
      const map = screen.getByRole('region', { name: /data-flow map/i });
      const tape = screen.getByRole('region', { name: /Run tape/ });
      for (const el of [map, tape, screen.getByTestId('agent-network')]) {
        expect(fireEvent.keyDown(el, { key: 'ArrowRight' })).toBe(true); // not prevented: scrolling still works
        expect(fireEvent.keyDown(el, { key: ' ' })).toBe(true);
      }
      expect(slider()).toHaveAttribute('aria-valuetext', text!);
    });

    it('steps from the transport with the arrow keys', async () => {
      renderView();
      await tapeCanvas();
      pointer(slider(), axisX(mid), 10, 'pointerdown');
      pointer(slider(), axisX(mid), 10, 'pointerup');
      fireEvent.keyDown(screen.getByRole('button', { name: /(Pause|Play) replay/ }), { key: 'ArrowRight' });
      expect(slider()).toHaveAttribute('aria-valuetext', '05:43:30 UTC');
    });

    it('stops scrubbing on pointercancel, lost capture, and a move with no button down', async () => {
      renderView();
      await tapeCanvas();
      const s = slider();
      const move = (ms: number, buttons: number) => fireEvent(s, new MouseEvent('pointermove', { clientX: axisX(ms), clientY: 10, buttons, bubbles: true }));
      pointer(s, axisX(mid), 10, 'pointerdown');
      expect(s).toHaveAttribute('aria-valuetext', '05:42:30 UTC');
      move(mid + 60_000, 1);
      expect(s).toHaveAttribute('aria-valuetext', '05:43:30 UTC'); // dragging follows the pointer
      pointer(s, axisX(mid), 10, 'pointercancel');
      move(mid + 5 * 60_000, 1);
      expect(s).toHaveAttribute('aria-valuetext', '05:43:30 UTC'); // cancelled: no longer scrubbing
      // a move with buttons === 0 while "scrubbing" ends it too
      pointer(s, axisX(mid), 10, 'pointerdown');
      expect(s).toHaveAttribute('aria-valuetext', '05:42:30 UTC');
      move(mid + 2 * 60_000, 0);
      expect(s).toHaveAttribute('aria-valuetext', '05:42:30 UTC');
      move(mid + 3 * 60_000, 1);
      expect(s).toHaveAttribute('aria-valuetext', '05:42:30 UTC');
      pointer(s, axisX(mid), 10, 'pointerdown');
      fireEvent(s, new MouseEvent('lostpointercapture', { bubbles: true }));
      move(mid + 7 * 60_000, 1);
      expect(s).toHaveAttribute('aria-valuetext', '05:42:30 UTC');
    });

    it('only the primary button starts a scrub', async () => {
      renderView();
      await tapeCanvas();
      fireEvent(slider(), new MouseEvent('pointerdown', { clientX: axisX(mid), clientY: 10, button: 2, bubbles: true }));
      expect(chip()).toHaveAttribute('data-state', 'live');
    });

    it('keeps the canvas free for scrolling: the scrub strip is the only pointer-capturing element', async () => {
      renderView();
      const tape = await tapeCanvas();
      expect(tape.style.touchAction).toBe('pan-x pan-y');
      expect(slider().style.touchAction).toBe('none');
      expect(slider().style.cursor).toBe('ew-resize');
    });

    it('splits a run that spans the playhead and omits runs that start after it from the text list', async () => {
      renderView();
      await tapeCanvas();
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      runFrames();
      expect(dashes.some((d) => d[0] === 3 && d[1] === 2)).toBe(false); // live: no ghost bars
      // analyst ran 95 s starting 5.4 min before the snapshot; cartographer starts 3.3 min before it
      const t = NOW_MS - 5 * 60_000;
      pointer(slider(), axisX(t), 10, 'pointerdown');
      pointer(slider(), axisX(t), 10, 'pointerup');
      dashes.length = 0;
      runFrames();
      runFrames();
      expect(dashes.some((d) => d[0] === 3 && d[1] === 2)).toBe(true); // the part after the playhead is a ghost
      const list = screen.getByRole('list', { name: 'Runs in the last hour, by lane', hidden: true });
      const analyst = within(list).getByText('Analyst').closest('li')!;
      expect(analyst).toHaveTextContent(/running, started 06:07 UTC/);
      // cartographer has not started yet at the playhead: no entry at all
      expect(within(list).queryByText('Cartographer')).not.toBeInTheDocument();
    });

    it('lists an orphaned open run as status unknown in live and in replay, never running', async () => {
      const orphan = {
        ...TIMELINE_FIXTURE.runs.find((r) => r.agent_id === 'enricher')!, id: 'orphan',
        started_at: new Date(NOW_MS - 100 * 60_000).toISOString(), completed_at: null, open: true, status: 'running' as const,
      };
      get.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/feeds/overview')) return { success: true, data: FEEDS_FIXTURE };
        if (path.startsWith('/api/agents/timeline')) {
          return { success: true, data: { ...TIMELINE_FIXTURE, runs: [orphan, ...TIMELINE_FIXTURE.runs.filter((r) => r.agent_id !== 'enricher')] } };
        }
        return { success: true, data: [] };
      });
      renderView();
      await tapeCanvas();
      const enricherRuns = () => within(
        screen.getByRole('list', { name: 'Runs in the last hour, by lane', hidden: true }),
      ).getByText('Enricher').closest('li')!;
      expect(enricherRuns()).toHaveTextContent('status unknown');
      expect(enricherRuns()).not.toHaveTextContent(/running/);
      pointer(slider(), axisX(NOW_MS - 20 * 60_000), 10, 'pointerdown');
      pointer(slider(), axisX(NOW_MS - 20 * 60_000), 10, 'pointerup');
      expect(enricherRuns()).toHaveTextContent('status unknown');
      expect(enricherRuns()).not.toHaveTextContent(/running/);
    });

    it('draws the hover ghost on the time scale', async () => {
      renderView();
      await tapeCanvas();
      await waitFor(() => expect(frames.length).toBeGreaterThan(0));
      texts.length = 0;
      pointer(slider(), axisX(mid), 10, 'pointermove');
      expect(texts).toContain('05:42:30');
    });

    it('says why Play is off and keeps stepping available', async () => {
      reduced = true;
      installMatchMedia();
      renderView();
      await tapeCanvas();
      fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
      expect(screen.getByTestId('replay-controls')).toHaveTextContent('Animation is off. Drag or step with ← →.');
    });
  });

  describe('full screen dialog focus', () => {
    it('keeps focus in the dialog when a non-focusable area is clicked, so Escape still closes', async () => {
      const user = userEvent.setup();
      renderView();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      const dialog = await screen.findByRole('dialog', { name: /full screen/i });
      expect(dialog).toHaveAttribute('tabindex', '-1');
      await user.click(within(dialog).getByRole('list', { name: 'Legend' }));
      expect(document.activeElement).toBe(dialog);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('Shift+Tab from the dialog itself wraps to the last control', async () => {
      renderView();
      await tapeCanvas();
      fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
      const dialog = await screen.findByRole('dialog', { name: /full screen/i });
      act(() => dialog.focus());
      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])'));
      expect(document.activeElement).toBe(items[items.length - 1]);
    });
  });

  describe('touch', () => {
    it('first tap previews a node, second tap selects it', async () => {
      const onSelect = vi.fn();
      renderView(onSelect);
      await tapeCanvas();
      const layout = computeLayout({
        width: 1000, placement: placeAgents(AGENTS_FIXTURE), feeds: FEEDS_FIXTURE, labelOf: (id) => id,
      });
      const n = layout.nodes.observer!;
      const canvas = flowCanvas();
      const tap = () => {
        fireEvent(canvas, Object.assign(new MouseEvent('pointerdown', { bubbles: true }), { pointerType: 'touch' }));
        pointer(canvas, n.x, n.y, 'click');
      };
      tap();
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByTestId('agent-network')).toHaveAttribute('data-hover', 'observer');
      tap();
      expect(onSelect).toHaveBeenCalledWith('observer');
    });
  });

  describe('tape labels', () => {
    it('truncates a long lane name but always shows its tag', async () => {
      renderView();
      await tapeCanvas();
      await waitFor(() => expect(frames.length).toBeGreaterThan(1));
      act(() => { frames.splice(0).forEach((f) => f()); });
      expect(texts.some((s) => s.endsWith('· on demand'))).toBe(true);
      const lane = texts.find((s) => s.endsWith('· on demand'))!;
      expect(lane).toContain('…');
      expect(lane.startsWith('Campaign')).toBe(true);
    });
  });

  describe('timeline states', () => {
    it('draws the map and says the timeline is unavailable on error, without particles', async () => {
      mockApi('error');
      renderView();
      expect(await screen.findByText(/Live timeline unavailable/)).toBeInTheDocument();
      expect(flowCanvas()).toBeInTheDocument();
      expect(screen.getByTestId('run-tape-empty')).toHaveTextContent('Run timeline unavailable');
      expect(frames).toHaveLength(0);
      expect(particleArcs()).toBe(0);
    });

    it('announces the error once, reserves tape height, and Retry refetches', async () => {
      mockApi('error');
      renderView();
      await screen.findByText(/Live timeline unavailable/);
      // One announcement of the failure detail (the chip's own status is just "Offline").
      expect(screen.getAllByRole('status').filter((n) => /Live timeline unavailable/.test(n.textContent ?? ''))).toHaveLength(1);
      expect(screen.getByTestId('run-tape-empty')).toHaveStyle({ minHeight: '180px' });
      const calls = () => get.mock.calls.filter(([p]) => String(p).startsWith('/api/agents/timeline')).length;
      const before = calls();
      mockApi('ok');
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(calls()).toBeGreaterThan(before));
      expect(await screen.findByTestId('run-tape')).toBeInTheDocument();
    });

    it('says so when the feed list fails', async () => {
      get.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/feeds/overview')) throw new Error('feeds down');
        if (path.startsWith('/api/agents/timeline')) return { success: true, data: TIMELINE_FIXTURE };
        return { success: true, data: [] };
      });
      renderView();
      expect(await screen.findByText(/Feed list unavailable/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry feeds' })).toBeInTheDocument();
    });

    it('shows a quiet note when nothing ran in the last hour', async () => {
      mockApi('empty');
      renderView();
      expect(await screen.findByText(/No agent runs or feed pulls in the last hour/)).toBeInTheDocument();
    });
  });
});
